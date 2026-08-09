/**
 * 审计流水写入（主理人 Q1 决策：`audit_logs` 与 B3 同批建表）
 *
 * 🔴 **铁律：审计失败绝不回滚业务。**
 *   `writeAudit` 内部 try/catch 吞掉一切异常，只打日志。
 *   审计是「旁路留痕」，不是业务前置条件 —— 一条日志写不进去，
 *   不能让用户的 WBS 节点创建失败。
 *
 * ⚠ 调用点必须在**业务写入之后**（拿得到最终值），且在同一 service 方法内。
 *
 * 签名与 `web/src/api/mock/index.ts:176` 的 `audit()` **位置参数逐字对齐**
 * （任务分解 T02-2），迁移调用点时可以逐行照抄，降低串参风险。
 */
const { genId } = require('./ids');
const { nowIso } = require('./dates');

/**
 * 写一条审计日志（永不抛异常）。
 *
 * @param {import('better-sqlite3').Database} db 数据库连接
 * @param {object} actor 操作人（users 表行 snake_case，或含 openId/name 的对象）
 * @param {string} entityType 实体类型：project / milestone / gate / wbs_node / change / review / report
 * @param {string} entityId 实体 id
 * @param {string} action 动作：create / update / delete / status_change / approve / reject / decide
 * @param {string} projectId 所属项目 id（可空字符串）
 * @param {string} summary 一句话摘要（前端审计页直接展示）
 * @param {Array<{field:string,label:string,before:string,after:string}>} [diff] 字段级差异
 * @param {{before?: object, after?: object}} [snapshot] 可选整体快照（写入 before_json / after_json）
 * @returns {?string} 审计记录 id；失败返回 null
 */
function writeAudit(db, actor, entityType, entityId, action, projectId, summary, diff, snapshot) {
  try {
    const a = actor || {};
    const snap = snapshot || {};
    const id = genId('AL');
    const openId = a.open_id !== undefined ? a.open_id : a.openId;
    const name = a.name !== undefined ? a.name : '';

    db.prepare(
      'INSERT INTO audit_logs (' +
        'id, project_id, entity_type, entity_id, action, ' +
        'actor_open_id, actor_name, summary, diff, before_json, after_json, created_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      projectId || null,
      String(entityType || ''),
      String(entityId || ''),
      String(action || 'update'),
      openId || null,
      name || null,
      summary === undefined || summary === null ? '' : String(summary),
      JSON.stringify(Array.isArray(diff) ? diff : []),
      snap.before === undefined || snap.before === null ? null : JSON.stringify(snap.before),
      snap.after === undefined || snap.after === null ? null : JSON.stringify(snap.after),
      nowIso()
    );
    return id;
  } catch (err) {
    // 🔴 绝不向上抛：审计失败不影响业务事务
    console.error('[audit] 写审计失败（已忽略，不影响业务）：', err && err.message ? err.message : err);
    return null;
  }
}

/**
 * 构造一条 diff 项（字段级变更）。空变更（before === after）返回 null，便于 filter。
 * @param {string} field 字段名（camelCase）
 * @param {string} label 中文标签
 * @param {*} before 变更前
 * @param {*} after 变更后
 * @returns {?{field:string,label:string,before:string,after:string}}
 */
function diffEntry(field, label, before, after) {
  const b = before === undefined || before === null ? '' : String(before);
  const a = after === undefined || after === null ? '' : String(after);
  if (b === a) return null;
  return { field: field, label: label, before: b, after: a };
}

module.exports = { writeAudit, diffEntry };
