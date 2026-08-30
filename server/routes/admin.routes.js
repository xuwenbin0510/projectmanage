/**
 * 管理后台路由
 *
 *  GET   /api/admin/users            → User[]              （**批次 1 必须真实**：建项向导选成员用）
 *  PATCH /api/admin/users/:openId    → User                （改全局角色）
 *  GET   /api/admin/templates        → LifecycleTemplate[]
 *  POST  /api/admin/reset-demo       → 403 E_FORBIDDEN     （见 stubs.routes.js）
 *
 * 注册顺序：`/admin/users` `/admin/templates` 均为静态段，`:openId` 挂在 users 之下不冲突。
 */

const express = require('express');

const db = require('../../db');
const { ok, asyncHandler, AppError, ErrorCode } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { toApiUser } = require('../lib/mappers');
const { nowIso } = require('../lib/dates');
const { genId } = require('../lib/ids');
const { hashPassword } = require('../lib/password');
const { DEFAULT_PASSWORD } = require('../dal/seed');
const roleCatalog = require('../services/roleCatalog');
const { refreshRoleCatalog } = roleCatalog;
const projectService = require('../services/project.service');
const feishuContacts = require('../lib/feishu_contacts');
const feishuImport = require('../services/feishuImport.service');
const mappers = require('../lib/mappers');

const router = express.Router();

/**
 * 取用户额外全局职位映射（E1.5）：open_id → role_key[]。
 * @param {string[]} [openIds] 限定范围；省略则全量
 * @returns {Object<string, string[]>}
 */
function loadExtraRoles(openIds) {
  const map = {};
  let rows;
  if (Array.isArray(openIds) && openIds.length) {
    const ph = openIds.map(function () { return '?'; }).join(',');
    rows = db.prepare('SELECT user_open_id, role_key FROM user_roles WHERE user_open_id IN (' + ph + ')').all(openIds);
  } else {
    rows = db.prepare('SELECT user_open_id, role_key FROM user_roles').all();
  }
  rows.forEach(function (r) {
    const k = String(r.user_open_id);
    if (!map[k]) map[k] = [];
    map[k].push(String(r.role_key));
  });
  return map;
}

/**
 * 按路径参数定位用户。
 *
 * 身份键铁律：本系统以 `users.id` 为唯一身份键。纯数字一律按 users.id 解析（正规入口）；
 * 非数字才回落 open_id（兼容旧调用，飞书 open_id 恒以 `ou_` 开头，不会与数字混淆）。
 * open_id 是跨系统标识、会随重新导入变化，新代码不应再把它当作用户资源标识。
 *
 * @param {string|undefined} raw 路径参数值
 * @returns {object|undefined} users 行
 */
function findUserByIdOrOpenId(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) {
    const byId = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(s));
    if (byId) return byId;
  }
  return db.prepare('SELECT * FROM users WHERE open_id = ?').get(s);
}

/**
 * 用户列表。
 *
 * ⚠ 不限管理员：建项向导需要用它来挑成员，普通 PM 也必须能读。
 * 返回全字段 `User`（含 globalRole / globalRoles / dept），前端依赖之。
 */
router.get(
  '/admin/users',
  requireAuth,
  asyncHandler(async function listUsers(req, res) {
    /* 可选 ?status=active|disabled|pending：成员选择器只取启用用户，避免把无效账号加进项目；
       管理后台不传该参数，仍返回全部以便管理停用/待激活账号。 */
    const statusFilter = req.query.status;
    const VALID = ['active', 'disabled', 'pending'];
    let rows;
    if (VALID.indexOf(statusFilter) >= 0) {
      rows = db.prepare('SELECT * FROM users WHERE status = ? ORDER BY id ASC').all(statusFilter);
    } else {
      rows = db.prepare('SELECT * FROM users ORDER BY id ASC').all();
    }
    const extra = loadExtraRoles(rows.map(function (r) { return r.open_id; }));
    res.json(ok(rows.map(function (r) { return toApiUser(r, extra[r.open_id] || []); })));
  }),
);

/** 生命周期模板列表 */
router.get(
  '/admin/templates',
  requireAuth,
  asyncHandler(async function listTemplates(req, res) {
    res.json(ok(projectService.listTemplates(db)));
  }),
);

/**
 * 修改用户（仅 admin）。支持 { globalRole?, status?, dept?, name?, employeeId?, email? }，
 * 只传需要更新的字段（向后兼容：仅传 globalRole 时行为与旧版一致）。
 *
 * 守卫：
 *  - `E_SELF_ROLE`  不能改自己的角色 / 不能停用自己（防误操作把自己降权）
 *  - `E_LAST_ADMIN` 系统至少保留一名 admin
 *  - `E_VALIDATION` 角色 / 状态白名单校验
 */
router.patch(
  '/admin/users/:id',
  requireAuth,
  requirePermission('admin:user:role'),
  asyncHandler(async function updateUser(req, res) {
    /* 路径参数优先按系统身份键 users.id 解析；非数字回落 open_id 兼容旧调用 */
    const idOrOpenId = String(req.params.id || '');
    const body = req.body || {};
    const target = findUserByIdOrOpenId(idOrOpenId);
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '用户不存在', { id: idOrOpenId });
    const openId = String(target.open_id || '');

    const sets = [];
    const args = [];
    const now = nowIso();
    // E1.5：多全局职位写回缓存（UPDATE 后统一替换 user_roles）
    let pendingExtraRoles = null;
    let hasExtraRoles = false;

    if (body.globalRoles !== undefined) {
      // E1.5：多全局职位数组。首项作主职位（users.global_role），其余写入 user_roles。
      const validRoleKeys = new Set(
        db.prepare("SELECT role_key FROM roles WHERE enabled = 1").all().map(function (x) { return x.role_key; }),
      );
      const list = Array.isArray(body.globalRoles)
        ? body.globalRoles.map(String).filter(function (r) { return validRoleKeys.has(r); })
        : [];
      if (!list.length) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'globalRoles', message: '至少需要一个全局职位' }],
        });
      }
      const primary = list[0];
      const extra = list.slice(1);
      if (target.id === req.user.id) {
        throw new AppError(ErrorCode.E_SELF_ROLE, undefined, { openId: openId });
      }
      if ((target.global_role === 'admin' || db.prepare("SELECT 1 FROM user_roles WHERE role_user_id = ? AND role_key = 'admin'").get(target.id)) && primary !== 'admin') {
        const cnt = db.prepare("SELECT COUNT(*) AS n FROM users WHERE (global_role = 'admin' OR id IN (SELECT role_user_id FROM user_roles WHERE role_key = 'admin')) AND id <> ?").get(target.id);
        if (!cnt || Number(cnt.n) < 1) {
          throw new AppError(ErrorCode.E_LAST_ADMIN, undefined, { openId: openId });
        }
      }
      sets.push('global_role = ?');
      args.push(primary);
      // 落库额外职位（事务内统一替换）
      pendingExtraRoles = extra;
      hasExtraRoles = true;
    } else if (body.globalRole !== undefined) {
      const role = String(body.globalRole);
      if (!roleCatalog.isEnabledRole(role)) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'globalRole', message: '角色不合法' }],
        });
      }
      if (target.id === req.user.id) {
        throw new AppError(ErrorCode.E_SELF_ROLE, undefined, { openId: openId });
      }
      if ((target.global_role === 'admin' || db.prepare("SELECT 1 FROM user_roles WHERE role_user_id = ? AND role_key = 'admin'").get(target.id)) && role !== 'admin') {
        const cnt = db.prepare("SELECT COUNT(*) AS n FROM users WHERE (global_role = 'admin' OR id IN (SELECT role_user_id FROM user_roles WHERE role_key = 'admin')) AND id <> ?").get(target.id);
        if (!cnt || Number(cnt.n) < 1) {
          throw new AppError(ErrorCode.E_LAST_ADMIN, undefined, { openId: openId });
        }
      }
      sets.push('global_role = ?');
      args.push(role);
    }

    if (body.status !== undefined) {
      const status = String(body.status);
      // 白名单扩展为三态：active / disabled / pending（待授权）
      if (status !== 'active' && status !== 'disabled' && status !== 'pending') {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'status', message: '状态不合法（应为 active / disabled / pending）' }],
        });
      }
      // 防锁死①：不能把自己设为非 active（pending / disabled），否则管理员会把自己踢出系统
      if (target.id === req.user.id && status !== 'active') {
        throw new AppError(ErrorCode.E_SELF_ROLE, undefined, { openId: openId });
      }
      // 防锁死②：不能把唯一的 admin 设为非 active（pending / disabled），否则系统无人可管理
      const isTargetAdmin =
        target.global_role === 'admin' ||
        db.prepare("SELECT 1 FROM user_roles WHERE role_user_id = ? AND role_key = 'admin'").get(target.id);
      if (isTargetAdmin && status !== 'active') {
        const cnt = db
          .prepare(
            "SELECT COUNT(*) AS n FROM users WHERE (global_role = 'admin' OR id IN (SELECT role_user_id FROM user_roles WHERE role_key = 'admin')) AND id <> ?",
          )
          .get(target.id);
        if (!cnt || Number(cnt.n) < 1) {
          throw new AppError(ErrorCode.E_LAST_ADMIN, undefined, { openId: openId });
        }
      }
      sets.push('status = ?');
      args.push(status);
    }

    if (body.dept !== undefined) {
      sets.push('dept = ?');
      args.push(String(body.dept).slice(0, 60));
    }
    if (body.name !== undefined && String(body.name).trim()) {
      sets.push('name = ?');
      args.push(String(body.name).trim().slice(0, 40));
    }
    if (body.employeeId !== undefined) {
      sets.push('employee_id = ?');
      args.push(String(body.employeeId).slice(0, 40));
    }
    if (body.email !== undefined) {
      sets.push('email = ?');
      args.push(String(body.email).trim().slice(0, 80));
    }

    // open_id / union_id 手动维护（用于重复号认回失败后的手工归并）：
    // union_id 仅 users 表持有，直接 SET；open_id 被多张业务表引用，需级联改引用表，否则产生孤儿数据。
    let newOpenId = null;
    if (body.openId !== undefined) {
      const next = String(body.openId).trim();
      if (next && next !== openId) {
        const clash = db.prepare('SELECT 1 FROM users WHERE open_id = ?').get(next);
        if (clash) throw new AppError(ErrorCode.E_CONFLICT, '新的 open_id 已存在于其他账号', { openId: next });
        if (target.id === req.user.id) {
          throw new AppError(ErrorCode.E_SELF_ROLE, undefined, { openId: openId });
        }
        newOpenId = next;
        sets.push('open_id = ?');
        args.push(next);
      }
    }
    if (body.unionId !== undefined) {
      const next = String(body.unionId).trim() || null;
      sets.push('union_id = ?');
      args.push(next);
    }

    if (!sets.length) {
      throw new AppError(ErrorCode.E_VALIDATION, '没有可更新的字段', {});
    }
    sets.push('updated_at = ?');
    args.push(now);
    args.push(openId);
    db.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE open_id = ?').run(args);

    // open_id 变更：级联更新所有业务引用表里的旧 open_id，避免孤儿数据
    if (newOpenId) {
      const tx = db.transaction(function () {
        USER_REFERENCE_CHECKS.forEach(function (ref) {
          db.prepare('UPDATE ' + ref.table + ' SET ' + ref.col + ' = ? WHERE ' + ref.col + ' = ?').run(newOpenId, openId);
        });
        db.prepare('UPDATE user_roles SET user_open_id = ? WHERE role_user_id = ?').run(newOpenId, target.id);
        // 已用新 open_id 做 WHERE 的后续逻辑，统一切换到 newOpenId
      });
      tx();
    }

    // E1.5：多全局职位写回（先删后插，按主职位之外的集合重建）
    if (hasExtraRoles) {
      const effectiveOpenId = newOpenId || openId;
      const tx = db.transaction(function () {
        db.prepare('DELETE FROM user_roles WHERE role_user_id = ?').run(target.id);
        const ins = db.prepare(
          'INSERT OR IGNORE INTO user_roles (id, user_open_id, role_key, assigned_by, assigned_at, role_user_id, assigned_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        );
        (pendingExtraRoles || []).forEach(function (role) {
          // 设计修正：边界把 open_id 解析为系统稳定身份键 users.id 落库
          ins.run(genId('UR'), effectiveOpenId, role, String(req.user.open_id || ''), now,
            mappers.resolveUserId(db, effectiveOpenId), mappers.resolveUserId(db, req.user.open_id || ''));
        });
      });
      tx();
    }

    const effectiveOpenId = newOpenId || openId;
    const extra = loadExtraRoles([effectiveOpenId])[effectiveOpenId] || [];
    res.json(ok(toApiUser(db.prepare('SELECT * FROM users WHERE open_id = ?').get(effectiveOpenId), extra), '已更新'));
  }),
);

/**
 * 物理删除用户（仅 admin）。
 *
 * 删除前检查业务引用：project_members / tasks(author) / reports(author) /
 * approvals(approver,initiator) / wbs_nodes(assignee,initiator) / audit_logs(actor) /
 * reviews/review_steps/review_approvals / user_roles。
 * 任意表引用该 open_id 则拒绝删除并返回引用详情，避免产生孤儿数据。
 * 无引用才物理删 users + user_roles 行。
 *
 * 不能删除自己。
 */
const USER_REFERENCE_CHECKS = [
  { table: 'project_members', col: 'user_open_id', label: '项目成员' },
  { table: 'approvals', col: 'approver_open_id', label: '审批（审批人）' },
  { table: 'audit_logs', col: 'actor_open_id', label: '审计日志' },
  { table: 'reviews', col: 'initiator_open_id', label: '评审（发起人）' },
  { table: 'review_steps', col: 'assignee_open_id', label: '评审步骤（处理人）' },
  { table: 'review_approvals', col: 'actor_open_id', label: '评审审批（操作人）' },
  { table: 'user_roles', col: 'user_open_id', label: '用户职位' },
  { table: 'work_reports', col: 'author_open_id', label: '周报' },
];

function checkUserReferences(openId) {
  const refs = [];
  USER_REFERENCE_CHECKS.forEach(function (c) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM ' + c.table + ' WHERE ' + c.col + ' = ?').get(openId);
    if (n && Number(n.n) > 0) refs.push({ table: c.table, col: c.col, label: c.label, count: Number(n.n) });
  });
  return refs;
}

router.delete(
  '/admin/users/:id',
  requireAuth,
  requirePermission('admin:user:role'),
  asyncHandler(async function deleteUser(req, res) {
    /* 先按系统身份键定位，再比对「是不是删自己」——用 users.id 比用 open_id 严谨 */
    const idOrOpenId = String(req.params.id || '');
    const target = findUserByIdOrOpenId(idOrOpenId);
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '用户不存在', { id: idOrOpenId });
    const openId = String(target.open_id || '');
    if (Number(target.id) === Number(req.user && req.user.id)) {
      throw new AppError(ErrorCode.E_FORBIDDEN, '不能删除自己', { id: target.id });
    }

    const refs = checkUserReferences(openId);
    if (refs.length) {
      throw new AppError(ErrorCode.E_CONFLICT, '该用户存在关联业务数据，无法物理删除', {
        references: refs,
      });
    }

    const tx = db.transaction(function () {
      db.prepare('DELETE FROM user_roles WHERE role_user_id = ?').run(target.id);
      db.prepare('DELETE FROM users WHERE open_id = ?').run(openId);
    });
    tx();
    res.json(ok(null, '已删除用户 ' + (target.name || openId)));
  }),
);

/**
 * 新增用户（仅 admin）。
 *
 * 必填：openId（唯一）、name；可选：dept / employeeId / email / globalRole（默认 member）。
 * 新建用户状态恒为 active。
 */
router.post(
  '/admin/users',
  requireAuth,
  requirePermission('admin:user:role'),
  asyncHandler(async function createUser(req, res) {
    const body = req.body || {};
    const openIdRaw = String(body.openId || '').trim();
    const name = String(body.name || '').trim();
    if (!name) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'name', message: '姓名必填' }],
      });
    }
    // open_id 改为可选：纯密码登录用户（不走飞书免登）无需填飞书 open_id。
    // 未提供时生成占位 open_id 满足 users.open_id UNIQUE NOT NULL 约束；
    // 该值后续若用户改用飞书登录会被 upsertFeishuUser 按邮箱/姓名认回并覆盖，不会建重号。
    const openId = openIdRaw || ('local_' + genId('U'));
    const email = String(body.email || '').trim().toLowerCase();
    // E1.5：优先用 globalRoles 数组（首项主职位），否则回落单值 globalRole（默认 member）
    let primary = 'member';
    let extra = [];
    if (Array.isArray(body.globalRoles) && body.globalRoles.length) {
      const validRoleKeys = new Set(
        db.prepare("SELECT role_key FROM roles WHERE enabled = 1").all().map(function (x) { return x.role_key; }),
      );
      const valid = body.globalRoles.map(String).filter(function (r) { return validRoleKeys.has(r); });
      if (!valid.length) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'globalRoles', message: '全局角色不合法' }],
        });
      }
      primary = valid[0];
      extra = valid.slice(1);
    } else {
      const single = String(body.globalRole || 'member');
      if (!roleCatalog.isEnabledRole(single)) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'globalRole', message: '角色不合法' }],
        });
      }
      primary = single;
    }
    // open_id 仅当用户显式提供时才查重（占位值由 genId 保证唯一，无需查）
    if (openIdRaw) {
      const exists = db.prepare('SELECT 1 FROM users WHERE open_id = ?').get(openId);
      if (exists) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'openId', message: '该 openId 已存在' }],
        });
      }
    }
    // 邮箱作为密码登录标识，若填写需保证唯一（否则登录可能命中错误账号）
    if (email) {
      const emailDup = db.prepare('SELECT 1 FROM users WHERE LOWER(email) = ?').get(email);
      if (emailDup) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'email', message: '该邮箱已存在' }],
        });
      }
    }
    // 初始状态：默认 active；可显式指定 pending（预建待授权账号）。仅开放 active / pending 两态。
    const statusIn = String(body.status || 'active');
    if (statusIn !== 'active' && statusIn !== 'pending') {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'status', message: '初始状态不合法（应为 active / pending）' }],
      });
    }

    const now = nowIso();
    const info = db
      .prepare(
        'INSERT INTO users (open_id, employee_id, name, email, dept, global_role, status, created_at, updated_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        openId,
        String(body.employeeId || '').slice(0, 40),
        name.slice(0, 40),
        email.slice(0, 80),
        String(body.dept || '').slice(0, 60),
        primary,
        statusIn,
        now,
        now,
      );

    // E1.5：写入额外全局职位
    if (extra.length) {
      const ins = db.prepare(
        'INSERT OR IGNORE INTO user_roles (id, user_open_id, role_key, assigned_by, assigned_at, role_user_id, assigned_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      extra.forEach(function (r) {
        // 设计修正：边界把 open_id 解析为系统稳定身份键 users.id 落库
        ins.run(genId('UR'), openId, r, String(req.user.open_id || ''), now,
          mappers.resolveUserId(db, openId), mappers.resolveUserId(db, req.user.open_id || ''));
      });
    }

    const extraRoles = loadExtraRoles([openId])[openId] || [];
    const newUser = toApiUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid), extraRoles);
    // 创建即写入默认密码，避免新用户无密码、需再走一次「重置密码」才能登录；
    // 同时置 must_change_pwd=1，强制其首次登录时修改。
    const hashed = await hashPassword(DEFAULT_PASSWORD);
    db.prepare('UPDATE users SET password_hash = ?, must_change_pwd = 1, updated_at = ? WHERE open_id = ?').run(
      hashed,
      now,
      openId,
    );
    res.json(ok(
      { ...newUser, defaultPassword: DEFAULT_PASSWORD },
      '用户已创建，默认密码：' + DEFAULT_PASSWORD + '（首次登录需修改）',
    ));
  }),
);

/**
 * 管理员重置用户密码（仅 admin）。
 * 将目标用户 password_hash 重置为默认密码（尊重 DEFAULT_USER_PASSWORD 环境变量），
 * 并置 must_change_pwd=1 强制其下次登录改密。
 * 守卫：
 *  - `E_NOT_FOUND`  目标用户不存在
 *  - `E_SELF_ROLE`  不能重置自己的密码（防误操作；自己改密走 /auth/change-password）
 * 返回默认密码明文，便于管理员口述/发消息告知用户。
 */
router.post(
  '/admin/users/:id/reset-password',
  requireAuth,
  requirePermission('admin:user:role'),
  asyncHandler(async function resetUserPassword(req, res) {
    const idOrOpenId = String(req.params.id || '');
    const target = findUserByIdOrOpenId(idOrOpenId);
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '用户不存在', { id: idOrOpenId });
    const openId = String(target.open_id || '');
    if (Number(target.id) === Number(req.user && req.user.id)) {
      throw new AppError(ErrorCode.E_SELF_ROLE, undefined, { id: target.id });
    }

    const hashed = await hashPassword(DEFAULT_PASSWORD);
    const now = nowIso();
    db.prepare('UPDATE users SET password_hash = ?, must_change_pwd = 1, updated_at = ? WHERE open_id = ?').run(
      hashed,
      now,
      openId,
    );
    res.json(ok({ defaultPassword: DEFAULT_PASSWORD, openId: openId }, '已重置密码，请通知用户使用默认密码登录并在首次登录时修改'));
  }),
);

/* ── 审批流程模板管理（阶段二：审批流程可配置） ─────────────── */

const REVIEW_SCOPES = ['project', 'business'];
const REVIEW_MODES = ['serial', 'parallel_veto', 'single'];
/** 审批链合法角色：全局角色 ∪ 项目角色 ∪ 客户代表（formal 历史模板用到，虚拟角色不在 roles 表） */
const ALLOWED_CHAIN_ROLES = new Set([
  ...roleCatalog.allRoleKeys().filter(roleCatalog.isEnabledRole),
  'customer_rep',
]);

/**
 * review_templates 行 → API 对象（chain JSON → 数组、active 0/1 → boolean）。
 * @param {object} row
 * @returns {object}
 */
function toApiReviewTemplate(row) {
  return {
    key: row.key,
    scope: row.scope,
    label: row.label,
    mode: row.mode,
    chain: JSON.parse(row.chain || '[]'),
    description: row.description,
    active: Number(row.active) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 审批模板列表（仅 admin） */
router.get(
  '/admin/review-templates',
  requireAuth,
  requirePermission('admin:template'),
  asyncHandler(async function listReviewTemplates(req, res) {
    const rows = db
      .prepare('SELECT * FROM review_templates ORDER BY scope DESC, key ASC')
      .all();
    res.json(ok(rows.map(toApiReviewTemplate)));
  }),
);

/**
 * 新增审批模板（仅 admin）。
 * 必填：key（唯一）、scope、label、mode、chain（非空且角色合法）；可选 description。
 */
router.post(
  '/admin/review-templates',
  requireAuth,
  requirePermission('admin:template'),
  asyncHandler(async function createReviewTemplate(req, res) {
    const body = req.body || {};
    const key = String(body.key || '').trim();
    const scope = String(body.scope || '');
    const label = String(body.label || '').trim();
    const mode = String(body.mode || 'serial');
    const chain = Array.isArray(body.chain) ? body.chain.map(String) : [];

    if (!key) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'key', message: '模板 key 必填' }],
      });
    }
    if (REVIEW_SCOPES.indexOf(scope) < 0) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'scope', message: '范围必须为 project / business' }],
      });
    }
    if (!label) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'label', message: '模板名称必填' }],
      });
    }
    if (REVIEW_MODES.indexOf(mode) < 0) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'mode', message: '模式必须为 serial / parallel_veto / single' }],
      });
    }
    if (!chain.length) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'chain', message: '审批链至少一个角色' }],
      });
    }
    const bad = chain.filter(function (r) { return !ALLOWED_CHAIN_ROLES.has(r); });
    if (bad.length) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'chain', message: '审批链含非法角色：' + bad.join(', ') }],
      });
    }
    if (db.prepare('SELECT 1 FROM review_templates WHERE key = ?').get(key)) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'key', message: '模板 key 已存在' }],
      });
    }

    const now = nowIso();
    db.prepare(
      'INSERT INTO review_templates (key, scope, label, mode, chain, description, active, created_at, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(key, scope, label, mode, JSON.stringify(chain), String(body.description || '').slice(0, 200), now, now);

    res.json(ok(toApiReviewTemplate(db.prepare('SELECT * FROM review_templates WHERE key = ?').get(key)), '审批模板已创建'));
  }),
);

/**
 * 更新审批模板（仅 admin）。支持 { label?, scope?, mode?, chain?, description? } 部分更新。
 */
router.put(
  '/admin/review-templates/:key',
  requireAuth,
  requirePermission('admin:template'),
  asyncHandler(async function updateReviewTemplate(req, res) {
    const key = String(req.params.key || '');
    const body = req.body || {};
    const target = db.prepare('SELECT * FROM review_templates WHERE key = ?').get(key);
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '审批模板不存在', { key: key });

    const sets = [];
    const args = [];

    if (body.label !== undefined) {
      const label = String(body.label).trim();
      if (!label) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'label', message: '模板名称必填' }],
        });
      }
      sets.push('label = ?');
      args.push(label.slice(0, 40));
    }
    if (body.scope !== undefined) {
      const scope = String(body.scope);
      if (REVIEW_SCOPES.indexOf(scope) < 0) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'scope', message: '范围必须为 project / business' }],
        });
      }
      sets.push('scope = ?');
      args.push(scope);
    }
    if (body.mode !== undefined) {
      const mode = String(body.mode);
      if (REVIEW_MODES.indexOf(mode) < 0) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'mode', message: '模式必须为 serial / parallel_veto / single' }],
        });
      }
      sets.push('mode = ?');
      args.push(mode);
    }
    if (body.chain !== undefined) {
      const chain = Array.isArray(body.chain) ? body.chain.map(String) : [];
      if (!chain.length) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'chain', message: '审批链至少一个角色' }],
        });
      }
      const bad = chain.filter(function (r) { return !ALLOWED_CHAIN_ROLES.has(r); });
      if (bad.length) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'chain', message: '审批链含非法角色：' + bad.join(', ') }],
        });
      }
      sets.push('chain = ?');
      args.push(JSON.stringify(chain));
    }
    if (body.description !== undefined) {
      sets.push('description = ?');
      args.push(String(body.description).slice(0, 200));
    }

    if (!sets.length) {
      throw new AppError(ErrorCode.E_VALIDATION, '没有可更新的字段', {});
    }
    sets.push('updated_at = ?');
    args.push(nowIso());
    args.push(key);
    db.prepare('UPDATE review_templates SET ' + sets.join(', ') + ' WHERE key = ?').run(args);

    res.json(ok(toApiReviewTemplate(db.prepare('SELECT * FROM review_templates WHERE key = ?').get(key)), '已更新'));
  }),
);

/** 启用/停用审批模板（仅 admin）。body: { active: boolean } */
router.patch(
  '/admin/review-templates/:key/active',
  requireAuth,
  requirePermission('admin:template'),
  asyncHandler(async function toggleReviewTemplateActive(req, res) {
    const key = String(req.params.key || '');
    const body = req.body || {};
    const target = db.prepare('SELECT * FROM review_templates WHERE key = ?').get(key);
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '审批模板不存在', { key: key });

    const active = body.active === true || body.active === 1 || body.active === '1' ? 1 : 0;
    db.prepare('UPDATE review_templates SET active = ?, updated_at = ? WHERE key = ?').run(active, nowIso(), key);

    res.json(ok(toApiReviewTemplate(db.prepare('SELECT * FROM review_templates WHERE key = ?').get(key)), active ? '已启用' : '已停用'));
  }),
);

/**
 * 删除审批模板（仅 admin）。
 * 存在「审批中」的评审引用该模板时拒绝（提示先停用，避免历史流程失去模板定义）。
 */
router.delete(
  '/admin/review-templates/:key',
  requireAuth,
  requirePermission('admin:template'),
  asyncHandler(async function deleteReviewTemplate(req, res) {
    const key = String(req.params.key || '');
    const target = db.prepare('SELECT * FROM review_templates WHERE key = ?').get(key);
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '审批模板不存在', { key: key });

    const activeRef = db
      .prepare("SELECT COUNT(*) AS n FROM reviews WHERE template_key = ? AND status = '审批中'")
      .get(key);
    if (activeRef && Number(activeRef.n) > 0) {
      throw new AppError(ErrorCode.E_VALIDATION, '该模板存在进行中的审批，无法删除，请先停用', {
        key: key,
        activeReviews: Number(activeRef.n),
      });
    }
    db.prepare('DELETE FROM review_templates WHERE key = ?').run(key);

    res.json(ok({ key: key }, '已删除'));
  }),
);

/* ── 生命周期模板管理（阶段三：内置模板 CRUD + 节点编辑） ────── */

const PROJECT_TYPES = ['A', 'B', 'C', 'D'];

/**
 * 校验并规范化模板 definition（整包替换语义）。
 * - milestones：code 唯一必填 / name 必填 / offsetDays 非负数字 / required 布尔；
 *   gate（一碑最多一门）code+name 必填、items 至少一项且 content 必填。
 * - docs：name 必填；milestoneCode 非空时必须在 milestones.code 中存在。
 * - wbsRules：透传原对象（前端编辑时带回，避免丢 WBS 规则）。
 * @param {*} def
 * @returns {{milestones:object[],docs:object[],wbsRules?:object}}
 */
function validateTemplateDefinition(def) {
  const d = def && typeof def === 'object' ? def : {};
  const milestones = Array.isArray(d.milestones) ? d.milestones : [];
  const docs = Array.isArray(d.docs) ? d.docs : [];
  const codes = new Set();

  milestones.forEach(function (m, i) {
    const code = String((m && m.code) || '').trim();
    if (!code) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: `definition.milestones[${i}].code`, message: '里程碑编码必填' }],
      });
    }
    if (codes.has(code)) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: `definition.milestones[${i}].code`, message: '里程碑编码重复：' + code }],
      });
    }
    codes.add(code);
    if (!String((m.name || '')).trim()) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: `definition.milestones[${i}].name`, message: '里程碑名称必填' }],
      });
    }
    const offsetDays = Number(m.offsetDays);
    if (!Number.isFinite(offsetDays) || offsetDays < 0) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: `definition.milestones[${i}].offsetDays`, message: '天数偏移需为非负数字' }],
      });
    }
    if (m.gate) {
      const g = m.gate;
      if (!String((g.code || '')).trim() || !String((g.name || '')).trim()) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: `definition.milestones[${i}].gate`, message: '质量门编码与名称必填' }],
        });
      }
      if (!Array.isArray(g.items) || !g.items.length) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: `definition.milestones[${i}].gate.items`, message: '质量门检查项至少一项' }],
        });
      }
      g.items.forEach(function (it, j) {
        if (!String((it && it.content) || '').trim()) {
          throw new AppError(ErrorCode.E_VALIDATION, undefined, {
            fields: [{ field: `definition.milestones[${i}].gate.items[${j}].content`, message: '检查项内容必填' }],
          });
        }
      });
    }
  });

  docs.forEach(function (doc, i) {
    if (!String((doc && doc.name) || '').trim()) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: `definition.docs[${i}].name`, message: '交付物名称必填' }],
      });
    }
    const mc = String((doc && doc.milestoneCode) || '').trim();
    if (mc && !codes.has(mc)) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: `definition.docs[${i}].milestoneCode`, message: '关联里程碑不存在：' + mc }],
      });
    }
  });

  return {
    milestones: milestones.map(function (m) {
      return {
        code: String(m.code).trim(),
        name: String(m.name).trim(),
        offsetDays: Number(m.offsetDays),
        required: m.required !== false,
        gate: m.gate ? {
          code: String(m.gate.code).trim(),
          name: String(m.gate.name).trim(),          ownerRole: String((m.gate.ownerRole || 'tl')).trim(),
          items: m.gate.items.map(function (it) {
            return { content: String(it.content).trim(), ownerRole: String((it.ownerRole || m.gate.ownerRole || 'tl')).trim() };
          }),
        } : undefined,
      };
    }),
    docs: docs.map(function (doc) {
      return { name: String(doc.name).trim(), milestoneCode: String((doc.milestoneCode || '')).trim() };
    }),
    wbsRules: d.wbsRules && typeof d.wbsRules === 'object' ? d.wbsRules : undefined,
    team: Array.isArray(d.team) && d.team.length ? d.team.map(function (r, i) {
      const role = String((r && r.role) || '').trim();
      if (!roleCatalog.isProjectRole(role)) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: `definition.team[${i}].role`, message: '团队约束角色不合法：' + role }],
        });
      }
      const min = Number(r.min);
      const maxRaw = Number(r.max);
      if (!Number.isFinite(min) || min < 0) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: `definition.team[${i}].min`, message: '团队约束「至少」需为非负数字' }],
        });
      }
      if (!Number.isFinite(maxRaw) || (maxRaw !== -1 && maxRaw < min)) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: `definition.team[${i}].max`, message: '团队约束「至多」需为 -1（不限）或不小于「至少」' }],
        });
      }
      return { role: role, min: min, max: maxRaw };
    }) : undefined,
  };
}

/**
 * 新增生命周期模板（仅 admin）。
 * 必填：projectType（A/B/C）、name；definition 可选（默认空骨架）。
 * 新建模板 is_active=1（作为该类型的当前生效模板）。
 */
router.post(
  '/admin/templates',
  requireAuth,
  requirePermission('admin:template'),
  asyncHandler(async function createTemplate(req, res) {
    const body = req.body || {};
    const projectType = String(body.projectType || '');
    const name = String(body.name || '').trim();
    if (PROJECT_TYPES.indexOf(projectType) < 0) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'projectType', message: '适用分类必须为 A / B / C / D' }],
      });
    }
    if (!name) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'name', message: '模板名称必填' }],
      });
    }
    const definition = body.definition !== undefined
      ? validateTemplateDefinition(body.definition)
      : { milestones: [], docs: [], wbsRules: undefined };

    const now = nowIso();
    const id = genId('TMP');
    db.prepare(
      'INSERT INTO lifecycle_templates (id, project_type, version, name, definition, is_active, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, 1, ?)',
    ).run(id, projectType, 1, name.slice(0, 60), JSON.stringify(definition), now);

    res.json(ok(projectService.getTemplateById(db, id), '模板已创建'));
  }),
);

/**
 * 更新生命周期模板（仅 admin）。支持 { name?, definition?, isActive? }。
 * definition 为**整包替换**语义：前端编辑器构造完整 definition（含 wbsRules）提交。
 */
router.put(
  '/admin/templates/:id',
  requireAuth,
  requirePermission('admin:template'),
  asyncHandler(async function updateTemplate(req, res) {
    const id = String(req.params.id || '');
    const body = req.body || {};
    const target = db.prepare('SELECT * FROM lifecycle_templates WHERE id = ?').get(id);
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '模板不存在', { id: id });

    const sets = [];
    const args = [];
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'name', message: '模板名称必填' }],
        });
      }
      sets.push('name = ?');
      args.push(name.slice(0, 60));
    }
    if (body.definition !== undefined) {
      sets.push('definition = ?');
      args.push(JSON.stringify(validateTemplateDefinition(body.definition)));
    }
    if (body.isActive !== undefined) {
      sets.push('is_active = ?');
      args.push(body.isActive ? 1 : 0);
    }
    if (!sets.length) {
      throw new AppError(ErrorCode.E_VALIDATION, '没有可更新的字段', {});
    }
    args.push(id);
    db.prepare('UPDATE lifecycle_templates SET ' + sets.join(', ') + ' WHERE id = ?').run(args);

    res.json(ok(projectService.getTemplateById(db, id), '已更新'));
  }),
);

/** 启用/停用生命周期模板（仅 admin）。body: { active: boolean } */
router.patch(
  '/admin/templates/:id/active',
  requireAuth,
  requirePermission('admin:template'),
  asyncHandler(async function toggleTemplateActive(req, res) {
    const id = String(req.params.id || '');
    const body = req.body || {};
    const target = db.prepare('SELECT * FROM lifecycle_templates WHERE id = ?').get(id);
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '模板不存在', { id: id });

    const active = body.active === true || body.active === 1 || body.active === '1' ? 1 : 0;
    db.prepare('UPDATE lifecycle_templates SET is_active = ? WHERE id = ?').run(active, id);

    res.json(ok(projectService.getTemplateById(db, id), active ? '已启用' : '已停用'));
  }),
);

/**
 * 删除生命周期模板（仅 admin）。
 * 存在引用该模板且未删除的项目（projects.template_id 且 deleted_at IS NULL）时拒绝。
 */
router.delete(
  '/admin/templates/:id',
  requireAuth,
  requirePermission('admin:template'),
  asyncHandler(async function deleteTemplate(req, res) {
    const id = String(req.params.id || '');
    const target = db.prepare('SELECT * FROM lifecycle_templates WHERE id = ?').get(id);
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '模板不存在', { id: id });

    const ref = db
      .prepare('SELECT COUNT(*) AS n FROM projects WHERE template_id = ? AND deleted_at IS NULL')
      .get(id);
    if (ref && Number(ref.n) > 0) {
      throw new AppError(ErrorCode.E_VALIDATION, '该模板已被项目引用，无法删除，可先停用', {
        id: id,
        refProjects: Number(ref.n),
      });
    }
    db.prepare('DELETE FROM lifecycle_templates WHERE id = ?').run(id);

    res.json(ok({ id: id }, '已删除'));
  }),
);

/**
 * 复制生命周期模板（仅 admin）。
 * 新 id、名称加「（副本）」、version +1、**is_active=0**（副本默认停用，避免同类型两个启用模板争抢生效）。
 */
router.post(
  '/admin/templates/:id/duplicate',
  requireAuth,
  requirePermission('admin:template'),
  asyncHandler(async function duplicateTemplate(req, res) {
    const id = String(req.params.id || '');
    const target = db.prepare('SELECT * FROM lifecycle_templates WHERE id = ?').get(id);
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '模板不存在', { id: id });

    const now = nowIso();
    const newId = genId('TMP');
    db.prepare(
      'INSERT INTO lifecycle_templates (id, project_type, version, name, definition, is_active, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, 0, ?)',
    ).run(
      newId,
      target.project_type,
      Number(target.version) + 1,
      String(target.name).slice(0, 50) + '（副本）',
      target.definition,
      now,
    );

    res.json(ok(projectService.getTemplateById(db, newId), '已复制（副本默认停用）'));
  }),
);

/* ── 职位目录管理（E1.5：职位可增删改 + 标注全局/项目级视野） ── */

/**
 * roles 行 → API 对象。
 * @param {object} row
 * @returns {object}
 */
function toApiRole(row) {
  return {
    roleKey: row.role_key,
    name: row.name,
    scope: row.scope, // global | project
    enabled: Number(row.enabled) === 1,
    description: row.description,
    orderNo: Number(row.order_no) || 0,
  };
}

/** 职位列表（仅 admin；按 order_no 升序） */
router.get(
  '/admin/roles',
  requireAuth,
  requirePermission('admin:user:role'),
  asyncHandler(async function listRoles(req, res) {
    const rows = db.prepare('SELECT * FROM roles ORDER BY order_no ASC, role_key ASC').all();
    res.json(ok(rows.map(toApiRole)));
  }),
);

/** 新增职位（仅 admin）。必填：roleKey（唯一）、name、scope（global/project）。 */
router.post(
  '/admin/roles',
  requireAuth,
  requirePermission('admin:user:role'),
  asyncHandler(async function createRole(req, res) {
    const body = req.body || {};
    const roleKey = String(body.roleKey || '').trim();
    const name = String(body.name || '').trim();
    const scope = String(body.scope || 'global');
    if (!roleKey) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, { fields: [{ field: 'roleKey', message: '职位标识必填' }] });
    }
    if (!/^[a-z0-9_]+$/.test(roleKey)) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'roleKey', message: '职位标识仅限小写字母/数字/下划线' }],
      });
    }
    if (!name) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, { fields: [{ field: 'name', message: '职位名称必填' }] });
    }
    if (scope !== 'global' && scope !== 'project') {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, { fields: [{ field: 'scope', message: '视野必须为 global / project' }] });
    }
    if (db.prepare('SELECT 1 FROM roles WHERE role_key = ?').get(roleKey)) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, { fields: [{ field: 'roleKey', message: '职位标识已存在' }] });
    }
    const now = nowIso();
    /* 方案 A：新建职位序号自动取「当前最大序号 + 1」，始终追加到列表末尾，避免手动填且可能重复 */
    const maxRow = db.prepare('SELECT MAX(order_no) AS m FROM roles').get();
    const nextOrder = (maxRow && Number(maxRow.m) > 0 ? Number(maxRow.m) : 0) + 1;
    db.prepare(
      'INSERT INTO roles (role_key, name, scope, enabled, description, order_no) VALUES (?, ?, ?, 1, ?, ?)',
    ).run(roleKey, name, scope, String(body.description || '').slice(0, 200), nextOrder);
    refreshRoleCatalog(db); // 刷新运行时角色视野缓存
    res.json(ok(toApiRole(db.prepare('SELECT * FROM roles WHERE role_key = ?').get(roleKey)), '职位已创建'));
  }),
);

/** 更新职位（仅 admin）。支持 { name?, scope?, enabled?, description?, orderNo? } 部分更新。 */
router.put(
  '/admin/roles/:roleKey',
  requireAuth,
  requirePermission('admin:user:role'),
  asyncHandler(async function updateRole(req, res) {
    const roleKey = String(req.params.roleKey || '');
    const body = req.body || {};
    const target = db.prepare('SELECT * FROM roles WHERE role_key = ?').get(roleKey);
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '职位不存在', { roleKey: roleKey });

    const sets = [];
    const args = [];
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new AppError(ErrorCode.E_VALIDATION, undefined, { fields: [{ field: 'name', message: '职位名称必填' }] });
      sets.push('name = ?');
      args.push(name.slice(0, 40));
    }
    if (body.scope !== undefined) {
      const scope = String(body.scope);
      if (scope !== 'global' && scope !== 'project') {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, { fields: [{ field: 'scope', message: '视野必须为 global / project' }] });
      }
      sets.push('scope = ?');
      args.push(scope);
    }
    if (body.enabled !== undefined) {
      sets.push('enabled = ?');
      args.push(body.enabled ? 1 : 0);
    }
    if (body.description !== undefined) {
      sets.push('description = ?');
      args.push(String(body.description).slice(0, 200));
    }
    if (body.orderNo !== undefined) {
      sets.push('order_no = ?');
      args.push(Number(body.orderNo) || 0);
    }
    if (!sets.length) throw new AppError(ErrorCode.E_VALIDATION, '没有可更新的字段', {});
    args.push(roleKey);
    db.prepare('UPDATE roles SET ' + sets.join(', ') + ' WHERE role_key = ?').run(args);
    refreshRoleCatalog(db); // 刷新运行时角色视野缓存（scope 变更立即生效）
    res.json(ok(toApiRole(db.prepare('SELECT * FROM roles WHERE role_key = ?').get(roleKey)), '已更新'));
  }),
);

/** 删除职位（仅 admin）。存在用户引用（主职位或额外职位）时拒绝。 */
router.delete(
  '/admin/roles/:roleKey',
  requireAuth,
  requirePermission('admin:user:role'),
  asyncHandler(async function deleteRole(req, res) {
    const roleKey = String(req.params.roleKey || '');
    const target = db.prepare('SELECT * FROM roles WHERE role_key = ?').get(roleKey);
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '职位不存在', { roleKey: roleKey });

    const refPrimary = db.prepare('SELECT COUNT(*) AS n FROM users WHERE global_role = ?').get(roleKey);
    const refExtra = db.prepare('SELECT COUNT(*) AS n FROM user_roles WHERE role_key = ?').get(roleKey);
    if ((refPrimary && Number(refPrimary.n) > 0) || (refExtra && Number(refExtra.n) > 0)) {
      throw new AppError(ErrorCode.E_VALIDATION, '该职位仍被用户引用，无法删除，请先调整相关用户', { roleKey: roleKey });
    }
    db.prepare('DELETE FROM roles WHERE role_key = ?').run(roleKey);
    res.json(ok({ roleKey: roleKey }, '已删除'));
  }),
);

/* ════════════════════════════════════════════════════════════════
 * 权限矩阵可配置化（B19 · 阶段二 · T03）
 *
 * 数据底座由 v18 迁移建立：permission_rules(PK action,role_key) +
 * permission_actions(PK action)。运行时 canDo 经 permissionCatalog.rolesFor()
 * 读取本表（v18 已接线），此处仅提供后台读写 + 重置。
 *
 * 防锁死铁律（与 user_roles 同一套思路）：
 *  - 拒绝取消 admin 对任何 action 的授权（admin 是逃生舱，永远全权）；
 *  - RBAC_CONFIG_SOURCE === 'constant' 时拒绝任何写（逃生舱已旁路 DB）；
 *  - 写后 invalidate() + loadCatalog(db) 立即刷新进程内缓存（无需重启）；
 *  - 每次写都落 audit_logs（旁路，失败不回滚业务）。
 * ════════════════════════════════════════════════════════════════ */

const permissionCatalog = require('../services/permissionCatalog');
const { DEFAULT_PERMISSIONS } = require('../config/permissions');
const { writeAudit } = require('../lib/audit');

/** 逃生舱：constant 模式拒绝写 */
function assertWritableSource() {
  if (process.env.RBAC_CONFIG_SOURCE === 'constant') {
    throw new AppError(ErrorCode.E_FORBIDDEN, '当前 RBAC 配置源为常量模式（RBAC_CONFIG_SOURCE=constant），不可通过后台修改；请改用数据库配置源后重试', { source: 'constant' });
  }
}

/** 拉取当前矩阵：action → { roleKey: granted }，仅返回启用角色 + 启用 action */
function readMatrix() {
  const enabledRoles = new Set(db.prepare("SELECT role_key FROM roles WHERE enabled = 1").all().map(function (x) { return x.role_key; }));
  const enabledActions = new Set(
    db.prepare("SELECT action FROM permission_actions WHERE enabled = 1").all().map(function (x) { return x.action; }),
  );
  const rules = db.prepare('SELECT action, role_key, granted FROM permission_rules').all();
  const out = {};
  rules.forEach(function (r) {
    if (!enabledActions.has(r.action)) return;
    if (!enabledRoles.has(r.role_key)) return;
    if (!out[r.action]) out[r.action] = {};
    out[r.action][r.role_key] = !!r.granted;
  });
  return out;
}

/* GET /api/admin/permissions —— 后台矩阵编辑数据源 */
router.get(
  '/admin/permissions',
  requireAuth,
  requirePermission('admin:permission:config'),
  asyncHandler(async function getPermissionsMatrix(req, res) {
    res.json(ok({
      matrix: readMatrix(),
      roles: db.prepare('SELECT role_key AS roleKey, name, scope, enabled FROM roles WHERE enabled = 1 ORDER BY order_no ASC').all(),
      actions: permissionCatalog.allActions().filter(function (a) { return a.enabled; }),
    }));
  }),
);

/* PUT /api/admin/permissions —— 批量更新矩阵
 * body: { matrix: { [action]: { [roleKey]: boolean } } }
 * 守卫：拒绝取消 admin 任一 action 的授权。 */
router.put(
  '/admin/permissions',
  requireAuth,
  requirePermission('admin:permission:config'),
  asyncHandler(async function putPermissionsMatrix(req, res) {
    assertWritableSource();
    const body = req.body || {};
    const incoming = body.matrix;
    if (!incoming || typeof incoming !== 'object') {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, { fields: [{ field: 'matrix', message: 'matrix 必须为对象' }] });
    }

    const enabledActions = new Set(
      db.prepare('SELECT action FROM permission_actions WHERE enabled = 1').all().map(function (x) { return x.action; }),
    );
    const enabledRoles = new Set(db.prepare('SELECT role_key FROM roles WHERE enabled = 1').all().map(function (x) { return x.role_key; }));

    const tx = db.transaction(function () {
      Object.keys(incoming).forEach(function (action) {
        if (!enabledActions.has(action)) return; // 未知 / 停用 action 直接忽略
        const row = incoming[action] || {};
        Object.keys(row).forEach(function (roleKey) {
          if (!enabledRoles.has(roleKey)) return; // 未知 / 停用角色忽略
          const granted = !!row[roleKey];
          if (roleKey === 'admin' && !granted) return; // 🔴 防锁死：永不取消 admin 授权
          db.prepare(
            'INSERT INTO permission_rules (action, role_key, granted, updated_at, updated_by, updated_by_user_id) VALUES (?, ?, ?, ?, ?, ?) '
            + 'ON CONFLICT(action, role_key) DO UPDATE SET granted = excluded.granted, updated_at = excluded.updated_at, updated_by = excluded.updated_by, updated_by_user_id = excluded.updated_by_user_id',
          ).run(action, roleKey, granted ? 1 : 0, nowIso(), String((req.user && (req.user.open_id || req.user.openId)) || 'admin'), mappers.resolveUserId(db, (req.user && (req.user.open_id || req.user.openId)) || 'admin'));
        });
      });
    });
    tx();

    // 写后刷新缓存（即时生效，无需重启）
    permissionCatalog.invalidate();
    permissionCatalog.loadCatalog(db);

    // 旁路审计
    writeAudit(db, req.user, 'permission_matrix', 'permission_rules', 'update', '', '管理员更新权限矩阵', null, { after: { updatedActions: Object.keys(incoming) } });

    res.json(ok({ matrix: readMatrix() }, '权限矩阵已更新，已即时生效'));
  }),
);

/* POST /api/admin/permissions/reset —— 恢复默认（重新种入 DEFAULT_PERMISSIONS，清空自定义） */
router.post(
  '/admin/permissions/reset',
  requireAuth,
  requirePermission('admin:permission:config'),
  asyncHandler(async function resetPermissionsMatrix(req, res) {
    assertWritableSource();

    const tx = db.transaction(function () {
      db.prepare('DELETE FROM permission_rules').run();
      const enabledRoles = new Set(db.prepare('SELECT role_key FROM roles WHERE enabled = 1').all().map(function (x) { return x.role_key; }));
      Object.keys(DEFAULT_PERMISSIONS).forEach(function (action) {
        const rule = DEFAULT_PERMISSIONS[action];
        if (!rule || !Array.isArray(rule.roles)) return;
        rule.roles.forEach(function (roleKey) {
          // 仅对启用角色种入；admin 恒 true（DEFAULT_PERMISSIONS 已含）
          if (!enabledRoles.has(roleKey)) return;
          db.prepare(
            'INSERT OR IGNORE INTO permission_rules (action, role_key, granted, updated_at, updated_by, updated_by_user_id) VALUES (?, ?, 1, ?, ?, NULL)',
          ).run(action, roleKey, nowIso(), 'reset');
        });
      });
    });
    tx();

    permissionCatalog.invalidate();
    permissionCatalog.loadCatalog(db);

    writeAudit(db, req.user, 'permission_matrix', 'permission_rules', 'reset', '', '管理员重置权限矩阵为默认', null, { after: { source: 'DEFAULT_PERMISSIONS' } });

    res.json(ok({ matrix: readMatrix() }, '已恢复默认权限矩阵'));
  }),
);

/* GET /api/admin/permission-actions —— 权限动作元数据（后台只读展示 + 分组） */
router.get(
  '/admin/permission-actions',
  requireAuth,
  requirePermission('admin:permission:config'),
  asyncHandler(async function getPermissionActions(req, res) {
    res.json(ok(permissionCatalog.allActions().filter(function (a) { return a.enabled; })));
  }),
);

/* PUT /api/admin/permission-actions —— 编辑 action 元数据（label/description/group_label/order_no；不开放增删） */
router.put(
  '/admin/permission-actions',
  requireAuth,
  requirePermission('admin:permission:config'),
  asyncHandler(async function putPermissionActions(req, res) {
    assertWritableSource();
    const body = req.body || {};
    const list = Array.isArray(body.actions) ? body.actions : [];

    const tx = db.transaction(function () {
      list.forEach(function (a) {
        if (!a || !a.action) return;
        const sets = [];
        const args = [];
        if (a.label !== undefined) { sets.push('label = ?'); args.push(String(a.label)); }
        if (a.description !== undefined) { sets.push('description = ?'); args.push(String(a.description)); }
        if (a.group_label !== undefined) { sets.push('group_label = ?'); args.push(String(a.group_label)); }
        if (a.order_no !== undefined) { sets.push('order_no = ?'); args.push(Number(a.order_no)); }
        if (!sets.length) return;
        args.push(a.action);
        db.prepare('UPDATE permission_actions SET ' + sets.join(', ') + ' WHERE action = ?').run(args);
      });
    });
    tx();

    permissionCatalog.invalidate();
    permissionCatalog.loadCatalog(db);

    res.json(ok(permissionCatalog.allActions().filter(function (a) { return a.enabled; }), '权限动作元数据已更新'));
  }),
);

/* ──────────────────────────────────────────────────────
 * 飞书通讯录批量导入 / 按姓名搜索导入（feat/connect-b10）
 *
 * 仅 admin。匹配模型 = 两档三桶（铁证/疑似/新建），详见
 * docs/feishu-import-proposal.md。导入服务**不调用 createUser**，
 * 且绝不改 status/角色/密码，不触达 devlogin/RBAC/业务流/审计写入。
 * 飞书调用失败统一包成 E_FEISHU_API（多为权限点缺失或网络问题）。
 * ────────────────────────────────────────────────────── */

/**
 * 拉取飞书通讯录并三桶分类预览。
 * GET /api/admin/feishu/contacts?preview=1
 */
router.get(
  '/admin/feishu/contacts',
  requireAuth,
  requirePermission('admin:feishu:import'),
  asyncHandler(async function previewFeishuContacts(req, res) {
    let contacts;
    try {
      contacts = await feishuContacts.getFullContacts();
    } catch (e) {
      throw new AppError(ErrorCode.E_FEISHU_API, (e && e.message) || '飞书通讯录拉取失败');
    }
    const classified = feishuImport.classifyContacts(contacts);
    const buckets = { definite: [], suspected: [], fresh: [] };
    classified.forEach(function (c) {
      buckets[c.bucket].push({
        openId: c.openId,
        bucket: c.bucket,
        unionId: c.unionId || null,
        name: c.name,
        email: c.email || '',
        employeeId: c.employeeId || '',
        departmentNames: c.departmentNames || [],
        matchedLocalOpenId: c.matchedLocalOpenId || null,
        matchedBy: c.matchedBy || null,
      });
    });
    const visibilityHint =
      '已拉取 ' + contacts.length + ' 名通讯录成员。若人数明显少于预期，请检查飞书应用「通讯录可见范围」权限配置。';
    res.json(ok({ total: contacts.length, buckets: buckets, visibilityHint: visibilityHint }));
  }),
);

/**
 * 执行飞书通讯录导入。
 * POST /api/admin/feishu/import
 * body: { initialStatus?:'pending'|'active', suspectedDecisions?: { [feishuOpenId]: 'merge'|'skip' }, contacts?: FeishuContactDTO[] }
 *  - contacts 省略 → 拉全量通讯录导入；提供 → 仅导入该子集（按姓名搜索导入场景）。
 */
router.post(
  '/admin/feishu/import',
  requireAuth,
  requirePermission('admin:feishu:import'),
  asyncHandler(async function importFeishuUsers(req, res) {
    const body = req.body || {};
    const initialStatus = body.initialStatus === 'active' ? 'active' : 'pending';
    const decisions = body.suspectedDecisions && typeof body.suspectedDecisions === 'object' ? body.suspectedDecisions : {};

    let contacts;
    try {
      if (Array.isArray(body.contacts) && body.contacts.length) {
        contacts = body.contacts;
      } else {
        contacts = await feishuContacts.getFullContacts(undefined, { force: true });
      }
    } catch (e) {
      throw new AppError(ErrorCode.E_FEISHU_API, (e && e.message) || '飞书通讯录拉取失败');
    }

    const summary = feishuImport.importContacts(contacts, decisions, initialStatus);
    // 导入后清空缓存，保证下次预览拿到最新数据
    feishuContacts.clearFullContactsCache();
    res.json(
      ok(
        summary,
        '导入完成：新增 ' + summary.added + ' / 合并 ' + summary.merged + ' / 跳过 ' + summary.skipped + ' / 失败 ' + summary.failed,
      ),
    );
  }),
);

/**
 * 按姓名/关键字搜索飞书通讯录（带三桶分类）。
 * POST /api/admin/feishu/search
 * body: { query: string, pageSize?: number }
 */
router.post(
  '/admin/feishu/search',
  requireAuth,
  requirePermission('admin:feishu:import'),
  asyncHandler(async function searchFeishuUsers(req, res) {
    const body = req.body || {};
    const query = String(body.query || '').trim();
    if (!query) throw new AppError(ErrorCode.E_VALIDATION, '搜索关键字不能为空');
    // 复用已拉取的全量通讯录做本地过滤（避免依赖飞书 users/search 的独立权限点）。
    let hits;
    try {
      const all = await feishuContacts.getFullContacts();
      hits = feishuContacts.filterContacts(all, query, body.pageSize);
    } catch (e) {
      throw new AppError(ErrorCode.E_FEISHU_API, (e && e.message) || '飞书通讯录搜索失败');
    }
    const classified = feishuImport.classifyContacts(hits);
    res.json(ok({ hits: classified }, '搜索到 ' + classified.length + ' 条结果'));
  }),
);

module.exports = router;