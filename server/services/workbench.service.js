/**
 * 工作台聚合服务（P0-13 · 批次 3 补齐「我的任务」部分）　← `web/src/api/mock/index.ts:2055`
 *
 * ⚠ Q-3 / SK-4：「我的任务」= 我负责的**真叶子**（无子节点），
 *   **不是** `nodeType === 'task'`。汇总节点不该出现在个人待办里。
 *
 * 待批次 4 补齐的部分（评审 / 周报）仍在 `workbench.routes.js` 里保持降级常量。
 */

const dates = require('../lib/dates');
const mappers = require('../lib/mappers');
const wbs = require('../lib/wbs');

/**
 * 我负责且未完成的真叶子任务（按 dueDate 升序，与 Mock L2069 一致）。
 *
 * 只统计我参与项目里的节点，且排除已结项 / 已终止项目（与 `listMyProjectItems` 口径一致），
 * 避免归档项目的历史任务一直挂在工作台上。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} me 当前用户 users 行
 * @returns {Array<object>} WbsNode[]
 */
function listMyTasks(db, me) {
  const openId = String((me && (me.open_id || me.openId)) || '');
  if (!openId) return [];

  const rows = db
    .prepare(
      `SELECT n.*
         FROM wbs_nodes n
         JOIN projects p ON p.id = n.project_id
        WHERE p.deleted_at IS NULL
          AND p.status NOT IN ('已结项', '已终止')
          AND n.project_id IN (SELECT project_id FROM project_members WHERE user_open_id = ?)`,
    )
    .all(openId);

  /* leafNodesOf 要在**项目全量节点**上判定，故先按项目分组再取叶子 */
  const byProject = {};
  rows.map(mappers.toApiWbsNode).forEach(function (n) {
    if (!byProject[n.projectId]) byProject[n.projectId] = [];
    byProject[n.projectId].push(n);
  });

  const mine = [];
  Object.keys(byProject).forEach(function (pid) {
    wbs.leafNodesOf(byProject[pid]).forEach(function (n) {
      if (n.owner === openId && n.status !== '完成') mine.push(n);
    });
  });

  return mine.sort(function (a, b) {
    const da = String(a.dueDate || '');
    const dbv = String(b.dueDate || '');
    if (da === dbv) return wbs.compareWbsCode(a.wbsCode, b.wbsCode);
    return da < dbv ? -1 : 1;
  });
}

/**
 * 已逾期任务数：`diffDays(today, dueDate) < 0`（与 Mock L2089 逐字一致）。
 * @param {Array<object>} tasks WbsNode[]
 * @returns {number}
 */
function countOverdue(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const t = dates.today();
  return list.filter(function (n) {
    return !!n.dueDate && dates.diffDays(t, n.dueDate) < 0;
  }).length;
}

module.exports = {
  listMyTasks,
  countOverdue,
};
