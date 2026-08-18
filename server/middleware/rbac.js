/**
 * RBAC 断言（**函数**形态，不是 Express 中间件）
 *
 * 为什么不是中间件：绝大多数写接口的 `projectId` 要**先查实体**才知道
 * （例：`PATCH /wbs/:id` 只有 nodeId），中间件阶段拿不到，只能在 service 里断言。
 *
 * 统一调用顺序（铁律，违反即回退）：
 *   `requireAuth`（路由层中间件）
 *     → 查实体拿 projectId
 *     → `assertWritable(db, projectId)`   已结项 / 已终止 → E_PROJECT_ARCHIVED
 *     → `assertCan(db, req, action, projectId)`  → E_FORBIDDEN
 *     → 业务校验
 *
 * 例外（D11）：`updateBoardConfig` 跳过 `assertWritable`（与 Mock 引擎一致）。
 */
const { AppError, ErrorCode } = require('../lib/errors');
const { PROJECT_ARCHIVED_STATUSES } = require('../config/enums');
const { canDo } = require('../config/permissions');

/**
 * 取用户在指定项目中的项目角色集合。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {string} openId
 * @returns {string[]}
 */
function projectRolesOf(db, projectId, openId) {
  if (!projectId || !openId) return [];
  return db
    .prepare('SELECT project_role FROM project_members WHERE project_id = ? AND user_open_id = ?')
    .all(projectId, openId)
    .map(function (r) {
      return String(r.project_role || '');
    })
    .filter(Boolean);
}

/**
 * 取项目行；不存在抛 `E_NOT_FOUND`。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {object} projects 行
 */
function loadProject(db, projectId) {
  const row = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId);
  if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, '项目不存在');
  return row;
}

/**
 * 只读归档态拦截：项目为「已结项 / 已终止」时拒绝一切写操作。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {object} projects 行（供调用方复用，避免二次查询）
 * @throws {AppError} E_NOT_FOUND / E_PROJECT_ARCHIVED
 */
function assertWritable(db, projectId) {
  const p = loadProject(db, projectId);
  if (PROJECT_ARCHIVED_STATUSES.indexOf(p.status) >= 0) {
    throw new AppError(ErrorCode.E_PROJECT_ARCHIVED);
  }
  return p;
}

/**
 * 权限断言。
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req 已过 `requireAuth`，`req.user` 是 users 行
 * @param {string} action 权限动作（action key 或引擎别名，如 `wbs.edit`）
 * @param {string} [projectId] 目标项目；不传则只按全局角色判定
 * @returns {object} `req.user`（users 行，snake_case）
 * @throws {AppError} E_UNAUTHORIZED / E_FORBIDDEN
 */
function assertCan(db, req, action, projectId) {
  const me = req && req.user;
  if (!me) throw new AppError(ErrorCode.E_UNAUTHORIZED);
  const roles = projectId ? projectRolesOf(db, projectId, me.open_id) : [];
  if (!canDo(me.global_role, action, roles)) {
    throw new AppError(ErrorCode.E_FORBIDDEN);
  }
  return me;
}

/**
 * 校验引用的里程碑存在且属于同一项目。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {?string} refId 里程碑 id；空值直接放行
 * @throws {AppError} E_VALIDATION
 */
function assertSameProjectMilestone(db, projectId, refId) {
  if (!refId) return;
  const ms = db.prepare('SELECT id, project_id FROM milestones WHERE id = ?').get(refId);
  if (!ms || ms.project_id !== projectId) {
    throw new AppError(ErrorCode.E_VALIDATION, '关联里程碑不存在或不属于当前项目', { refId: refId });
  }
}

module.exports = {
  projectRolesOf,
  loadProject,
  assertWritable,
  assertCan,
  assertSameProjectMilestone,
};
