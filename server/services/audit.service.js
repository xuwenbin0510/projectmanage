/**
 * 审计日志查询服务（D08.3 · 替换 stubs 空桩）
 *
 * 对齐 `web/src/types/audit.ts` AuditLog + `web/src/api/contract.ts` AuditQuery：
 *  - 分页：page / pageSize（≤100），按 created_at DESC 排序
 *  - 筛选：projectId / entityType / action / actor（open_id 或姓名）/ from / to
 *  - 响应：`{ items, total, page, pageSize, totalPages }`
 *
 * 约定：service 零 Express 依赖；diff 列 JSON 解析为 AuditDiffEntry[]；
 * projectName 联查 projects（项目已软删则留空）。
 */

const mappers = require('../lib/mappers');

/**
 * audit_logs 行 → AuditLog（API 形态）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} row
 * @returns {object}
 */
function toApiLog(db, row) {
  let diff = [];
  try {
    diff = row.diff ? JSON.parse(row.diff) : [];
  } catch (e) {
    diff = [];
  }
  let before = null;
  let after = null;
  try {
    before = row.before_json ? JSON.parse(row.before_json) : null;
  } catch (e) {
    before = null;
  }
  try {
    after = row.after_json ? JSON.parse(row.after_json) : null;
  } catch (e) {
    after = null;
  }
  let projectName = '';
  if (row.project_id) {
    const p = db.prepare('SELECT name FROM projects WHERE id = ?').get(String(row.project_id));
    projectName = p ? mappers.toStr(p.name) : '';
  }
  return {
    id: mappers.toStr(row.id),
    projectId: mappers.toStr(row.project_id),
    projectName: projectName,
    entityType: mappers.toStr(row.entity_type),
    entityId: mappers.toStr(row.entity_id),
    action: mappers.toStr(row.action),
    actorOpenId: mappers.toStr(row.actor_open_id),
    actorName: mappers.toStr(row.actor_name),
    before: before,
    after: after,
    diff: diff,
    summary: mappers.toStr(row.summary),
    createdAt: mappers.toStr(row.created_at),
  };
}

/**
 * 审计分页查询（对齐 mock listAudit 的筛选语义）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} query AuditQuery
 * @returns {{items: object[], total: number, page: number, pageSize: number, totalPages: number}}
 */
function listAudit(db, query) {
  const q = query || {};
  const where = [];
  const params = {};

  if (q.projectId) {
    where.push('project_id = @projectId');
    params.projectId = String(q.projectId);
  }
  if (q.entityType) {
    where.push('entity_type = @entityType');
    params.entityType = String(q.entityType);
  }
  if (q.action) {
    where.push('action = @action');
    params.action = String(q.action);
  }
  if (q.actor) {
    where.push('(actor_open_id = @actor OR actor_name = @actor)');
    params.actor = String(q.actor);
  }
  if (q.from) {
    where.push('created_at >= @from');
    params.from = String(q.from);
  }
  if (q.to) {
    where.push('created_at <= @to');
    params.to = String(q.to) + 'T23:59:59.999Z';
  }

  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 30));

  const total = db.prepare('SELECT COUNT(*) AS c FROM audit_logs ' + w).get(params).c;
  const rows = db
    .prepare('SELECT * FROM audit_logs ' + w + ' ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset')
    .all(Object.assign({}, params, { limit: pageSize, offset: (page - 1) * pageSize }));

  return {
    items: rows.map(function (r) { return toApiLog(db, r); }),
    total: Number(total),
    page: page,
    pageSize: pageSize,
    totalPages: Math.ceil(Number(total) / pageSize),
  };
}

module.exports = {
  listAudit,
};
