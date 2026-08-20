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
const { requireAuth, requireGlobalRole } = require('../middleware/auth');
const { toApiUser } = require('../lib/mappers');
const { nowIso } = require('../lib/dates');
const { genId } = require('../lib/ids');
const { GLOBAL_ROLES, PROJECT_ROLES } = require('../config/enums');
const projectService = require('../services/project.service');

const router = express.Router();

/**
 * 用户列表。
 *
 * ⚠ 不限管理员：建项向导需要用它来挑成员，普通 PM 也必须能读。
 * 返回全字段 `User`（含 globalRole / dept），前端 `GLOBAL_ROLE_LABEL` 依赖之。
 */
router.get(
  '/admin/users',
  requireAuth,
  asyncHandler(async function listUsers(req, res) {
    const rows = db
      .prepare('SELECT * FROM users ORDER BY id ASC')
      .all();
    res.json(ok(rows.map(toApiUser)));
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
  '/admin/users/:openId',
  requireAuth,
  requireGlobalRole('admin'),
  asyncHandler(async function updateUser(req, res) {
    const openId = String(req.params.openId || '');
    const body = req.body || {};
    const target = db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId);
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '用户不存在', { openId: openId });

    const sets = [];
    const args = [];
    const now = nowIso();

    if (body.globalRole !== undefined) {
      const role = String(body.globalRole);
      if (GLOBAL_ROLES.indexOf(role) < 0) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'globalRole', message: '全局角色不合法' }],
        });
      }
      if (openId === String(req.user.open_id)) {
        throw new AppError(ErrorCode.E_SELF_ROLE, undefined, { openId: openId });
      }
      if (target.global_role === 'admin' && role !== 'admin') {
        const cnt = db.prepare("SELECT COUNT(*) AS n FROM users WHERE global_role = 'admin'").get();
        if (!cnt || Number(cnt.n) <= 1) {
          throw new AppError(ErrorCode.E_LAST_ADMIN, undefined, { openId: openId });
        }
      }
      sets.push('global_role = ?');
      args.push(role);
    }

    if (body.status !== undefined) {
      const status = String(body.status);
      if (status !== 'active' && status !== 'disabled') {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'status', message: '状态不合法' }],
        });
      }
      if (openId === String(req.user.open_id) && status === 'disabled') {
        throw new AppError(ErrorCode.E_SELF_ROLE, undefined, { openId: openId });
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

    if (!sets.length) {
      throw new AppError(ErrorCode.E_VALIDATION, '没有可更新的字段', {});
    }
    sets.push('updated_at = ?');
    args.push(now);
    args.push(openId);
    db.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE open_id = ?').run(args);

    res.json(ok(toApiUser(db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId)), '已更新'));
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
  requireGlobalRole('admin'),
  asyncHandler(async function createUser(req, res) {
    const body = req.body || {};
    const openId = String(body.openId || '').trim();
    const name = String(body.name || '').trim();
    if (!openId) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'openId', message: 'openId 必填' }],
      });
    }
    if (!name) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'name', message: '姓名必填' }],
      });
    }
    const role = String(body.globalRole || 'member');
    if (GLOBAL_ROLES.indexOf(role) < 0) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'globalRole', message: '全局角色不合法' }],
      });
    }
    const exists = db.prepare('SELECT 1 FROM users WHERE open_id = ?').get(openId);
    if (exists) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'openId', message: '该 openId 已存在' }],
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
        String(body.email || '').trim().slice(0, 80),
        String(body.dept || '').slice(0, 60),
        role,
        'active',
        now,
        now,
      );

    res.json(ok(toApiUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)), '用户已创建'));
  }),
);

/* ── 审批流程模板管理（阶段二：审批流程可配置） ─────────────── */

const REVIEW_SCOPES = ['project', 'business'];
const REVIEW_MODES = ['serial', 'parallel_veto', 'single'];
/** 审批链合法角色：全局角色 ∪ 项目角色 ∪ 客户代表（formal/ccb 模板用到） */
const ALLOWED_CHAIN_ROLES = new Set([...GLOBAL_ROLES, ...PROJECT_ROLES, 'customer_rep']);

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
  requireGlobalRole('admin'),
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
  requireGlobalRole('admin'),
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
  requireGlobalRole('admin'),
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
  requireGlobalRole('admin'),
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
  requireGlobalRole('admin'),
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

const PROJECT_TYPES = ['A', 'B', 'C'];

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
          name: String(m.gate.name).trim(),
          ownerRole: String((m.gate.ownerRole || 'tl')).trim(),
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
  requireGlobalRole('admin'),
  asyncHandler(async function createTemplate(req, res) {
    const body = req.body || {};
    const projectType = String(body.projectType || '');
    const name = String(body.name || '').trim();
    if (PROJECT_TYPES.indexOf(projectType) < 0) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'projectType', message: '适用分类必须为 A / B / C' }],
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
  requireGlobalRole('admin'),
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
  requireGlobalRole('admin'),
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
  requireGlobalRole('admin'),
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
  requireGlobalRole('admin'),
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

module.exports = router;