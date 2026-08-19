/**
 * 全量任务快照服务（D03 · 周报全量快照环比）
 *
 * 目标：精确环比不能只看周报勾选任务（work_report_tasks 覆盖不全），
 * 需要「每项目每周一次**全量真叶子任务快照**」——周报提交时采集，
 * 环比 = 上周快照 vs 前周快照的进度差。
 *
 * 约定：
 *  - 快照对象 = 该项目**全部真叶子任务**（`NOT EXISTS(子节点)` 判定，与 D01/D01.5 看板口径一致）；
 *  - `UNIQUE(object_type, object_id, week)` + `ON CONFLICT DO UPDATE`：同周重提覆盖为最新；
 *  - 调用方（report.service）在事务外调用并 try/catch 隔离：快照失败只丢环比数据，不阻塞周报提交。
 */

const crypto = require('crypto');

/**
 * 采集某项目当周全量真叶子任务快照（幂等 upsert）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {string} week 周码 'YYYY-Www'（= 周报提交时所在周）
 * @param {string} [reportId] 触发快照的周报 id（可追溯）
 * @returns {number} 本次快照的任务数（0 = 项目无真叶子任务）
 */
function captureProjectTaskSnapshot(db, projectId, week, reportId) {
  const rows = db
    .prepare(
      `SELECT id, progress, status FROM wbs_nodes
        WHERE project_id = ?
          AND NOT EXISTS (SELECT 1 FROM wbs_nodes c WHERE c.parent_id = wbs_nodes.id)`,
    )
    .all(projectId);
  if (!rows.length) return 0;

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO progress_snapshots
      (id, project_id, object_type, object_id, week, progress, status, captured_at, report_id)
    VALUES
      (@id, @projectId, 'task', @objectId, @week, @progress, @status, @capturedAt, @reportId)
    ON CONFLICT(object_type, object_id, week) DO UPDATE SET
      progress    = excluded.progress,
      status      = excluded.status,
      captured_at = excluded.captured_at,
      report_id   = excluded.report_id
  `);

  rows.forEach(function (r) {
    upsert.run({
      id: 'SNAP_' + crypto.randomUUID().slice(0, 12),
      projectId: projectId,
      objectId: String(r.id),
      week: week,
      progress: Number(r.progress) || 0,
      status: String(r.status || ''),
      capturedAt: now,
      reportId: reportId || null,
    });
  });
  return rows.length;
}

module.exports = { captureProjectTaskSnapshot };
