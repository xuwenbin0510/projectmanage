/**
 * 项目成员写服务（批次 3 · T05-1）　← `web/src/api/mock/index.ts:859 / 883`
 *
 * 职责边界：
 *  - 只做**单条增量**的角色基数判定（`assertRoleUnique`）；建项时的全量判定在
 *    `project.service.assertMemberCardinality`（要求 pm/tl 恰好各 1），两者口径不同，故不复用实现
 *  - B 类项目 PO 必填（`E_PROJECT_PO_REQUIRED`）**只在建项时校验**：
 *    Mock `removeMember` 没有拦 PO，真后端保持一致，不自作主张加
 *  - 读路径（成员列表）在 `project.service.listMembers`，本文件不重复实现
 *
 * RBAC 次序（§4.5）：`requireAuth` → `assertWritable` → `assertCan` → 业务校验
 */

const { AppError, ErrorCode } = require('../lib/errors');
const dates = require('../lib/dates');
const ids = require('../lib/ids');
const mappers = require('../lib/mappers');
const enums = require('../config/enums');
const rbac = require('../middleware/rbac');
const { writeAudit } = require('../lib/audit');

/** 项目内**至多一名**的角色（与 Mock L863 一致） */
const SINGLETON_ROLES = ['pm', 'tl'];

/* ── 基础读取 ───────────────────────────────────────── */

/**
 * 按 id 读成员行（带派生 userName）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} memberId
 * @returns {object|undefined}
 */
function findMemberRow(db, memberId) {
  return db
    .prepare(
      `SELECT m.*, u.name AS user_name
         FROM project_members m
         LEFT JOIN users u ON u.id = m.member_user_id
        WHERE m.id = ?`,
    )
    .get(String(memberId || ''));
}

/**
 * 按 open_id 读用户行。
 * @param {import('better-sqlite3').Database} db
 * @param {string} openId
 * @returns {object|undefined}
 */
function findUserRow(db, openId) {
  return db.prepare('SELECT * FROM users WHERE open_id = ?').get(String(openId || ''));
}

/* ── 校验 ───────────────────────────────────────────── */

/**
 * 单条增量的「角色唯一」判定：pm / tl 项目内已存在同角色成员即拒。
 *
 * ⚠ 与建项时的 `assertMemberCardinality`（要求恰好各 1）**口径不同**：
 *   这里只判「是否已有」，不判「是否缺失」，因为增量加人不该因缺 tl 而失败。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {string} role
 * @throws {AppError} E_ROLE_CARDINALITY
 */
function assertRoleUnique(db, projectId, role) {
  if (SINGLETON_ROLES.indexOf(role) < 0) return;
  const row = db
    .prepare(
      `SELECT m.user_open_id, u.name AS user_name
         FROM project_members m
         LEFT JOIN users u ON u.id = m.member_user_id
        WHERE m.project_id = ? AND m.project_role = ?
        ORDER BY m.assigned_at ASC, m.id ASC
        LIMIT 1`,
    )
    .get(String(projectId), String(role));
  if (!row) return;
  throw new AppError(ErrorCode.E_ROLE_CARDINALITY, (role === 'pm' ? 'PM' : 'TL') + ' 已存在，一个项目内只能有一名', {
    role: role,
    existing: {
      userOpenId: mappers.toStr(row.user_open_id),
      userName: mappers.toStr(row.user_name),
    },
  });
}

/* ── 写操作 ─────────────────────────────────────────── */

/**
 * 添加项目成员。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} req Express request（`req.user` 为当前用户 users 行）
 * @param {string} projectId
 * @param {{userOpenId?: string, role?: string}} payload
 * @returns {object} ProjectMember
 * @throws {AppError} E_PROJECT_ARCHIVED / E_FORBIDDEN / E_NOT_FOUND / E_ROLE_CARDINALITY / E_VALIDATION
 */
function addMember(db, req, projectId, payload) {
  const pid = String(projectId || '');
  const body = payload || {};
  const userOpenId = String(body.userOpenId || '').trim();
  const role = String(body.role || '').trim();
  const actor = req.user || {};

  return db.transaction(function () {
    rbac.assertWritable(db, pid);
    rbac.assertCan(db, req, 'project:member:assign', pid);

    const fields = [];
    if (!userOpenId) fields.push({ field: 'userOpenId', message: '请选择成员' });
    /* 项目内角色合法集 = 职位管理里「项目视野（scope=project）」且启用的职位；
       公司级职位在用户层分配，不在此处选 */
    const roleRow = db
      .prepare("SELECT role_key FROM roles WHERE role_key = ? AND scope = 'project' AND enabled = 1")
      .get(role);
    if (!roleRow) fields.push({ field: 'role', message: '该角色不是有效的项目内职位' });
    if (fields.length) throw new AppError(ErrorCode.E_VALIDATION, '成员参数不合法', { fields: fields });

    const user = findUserRow(db, userOpenId);
    if (!user) throw new AppError(ErrorCode.E_NOT_FOUND, '用户不存在', { userOpenId: userOpenId });

    /* pm / tl 为单例角色：一个项目内只能有一名。
       改派语义 —— 若该项目已有同角色成员，先让位（删旧）再插入新成员，
       使「换项目经理」一步完成：直接给新人加 PM 即可，无需先删后加或先加后删。 */
    if (SINGLETON_ROLES.indexOf(role) >= 0) {
      db.prepare(
        `DELETE FROM project_members
          WHERE project_id = ? AND project_role = ? AND user_open_id <> ?`,
      ).run(pid, role, userOpenId);
    }

    /* 先查后插：UNIQUE(project_id,user_open_id,project_role) 冲突不能冒成 500 */
    const dup = db
      .prepare('SELECT id FROM project_members WHERE project_id = ? AND user_open_id = ? AND project_role = ?')
      .get(pid, userOpenId, role);
    if (dup) {
      throw new AppError(ErrorCode.E_VALIDATION, '该成员已有此角色', {
        fields: [{ field: 'role', message: '该成员已有此角色' }],
      });
    }

    const memberId = ids.genId('MB');
    const ts = dates.nowIso();
    const assignedBy = mappers.toStr(actor.open_id || actor.openId);
    db.prepare(
      `INSERT INTO project_members (id, project_id, user_open_id, project_role, assigned_by, assigned_at, member_user_id, assigned_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      memberId,
      pid,
      userOpenId,
      role,
      assignedBy,
      ts,
      mappers.resolveUserId(db, userOpenId),
      mappers.resolveUserId(db, assignedBy),
    );

    const userName = mappers.toStr(user.name);
    writeAudit(
      db,
      actor,
      'project',
      pid,
      'update',
      pid,
      '添加项目成员「' + userName + '」（' + role + '）',
      [{ field: 'members', label: '成员', before: '', after: userName + '（' + role + '）' }],
    );

    const nameOf = mappers.makeNameLookup(db);
    return mappers.toApiMember(findMemberRow(db, memberId), nameOf);
  })();
}

/**
 * 移除项目成员。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} req Express request
 * @param {string} projectId
 * @param {string} memberId
 * @returns {null}
 * @throws {AppError} E_PROJECT_ARCHIVED / E_FORBIDDEN / E_NOT_FOUND / E_ROLE_CARDINALITY
 */
function removeMember(db, req, projectId, memberId) {
  const pid = String(projectId || '');
  const mid = String(memberId || '');
  const actor = req.user || {};

  return db.transaction(function () {
    rbac.assertWritable(db, pid);
    rbac.assertCan(db, req, 'project:member:assign', pid);

    const row = findMemberRow(db, mid);
    if (!row || mappers.toStr(row.project_id) !== pid) {
      throw new AppError(ErrorCode.E_NOT_FOUND, '成员不存在', { memberId: mid });
    }

    const role = mappers.toStr(row.project_role);

    /* PM / TL 是流程审批与质量门的核心责任人，删后若该项目该角色无人，
       审批链解析与质量门决议会悬空 → 禁止「无替代删除」。
       换人必须先添加接任者再移除现任（前端「管理成员」应提供此顺序引导）。 */
    if (SINGLETON_ROLES.indexOf(role) >= 0) {
      const remain = db
        .prepare(
          `SELECT COUNT(*) AS c FROM project_members
            WHERE project_id = ? AND project_role = ? AND id <> ?`,
        )
        .get(pid, role, mid);
      if (!remain || remain.c <= 0) {
        throw new AppError(
          ErrorCode.E_ROLE_CARDINALITY,
          (role === 'pm' ? '项目经理' : '技术负责人') + ' 不能移除：该项目尚无接任者，移除后将导致审批流与质量门悬空。请先添加接任的' +
            (role === 'pm' ? '项目经理' : '技术负责人') +
            '，再移除现任。',
          { role: role },
        );
      }
    }

    db.prepare('DELETE FROM project_members WHERE id = ?').run(mid);

    const userName = mappers.toStr(row.user_name);
    writeAudit(
      db,
      actor,
      'project',
      pid,
      'update',
      pid,
      '移除项目成员「' + userName + '」',
      [{ field: 'members', label: '成员', before: userName + '（' + role + '）', after: '' }],
    );

    return null;
  })();
}

module.exports = {
  SINGLETON_ROLES,
  findMemberRow,
  findUserRow,
  assertRoleUnique,
  addMember,
  removeMember,
};
