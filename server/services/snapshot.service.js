/**
 * 全量任务快照服务（D03 · 到点快照环比）
 *
 * 2026-09 架构升级：快照采集从「周报提交触发」改为「到点定时 + 启动补偿」——
 * 任务进度环比本质是**客观状态的定期采样**，采样时点应是固定 Deadline
 * （每周一 00:10 拍刚结束周），与谁交周报、交没交周报无关；周报提交时的
 * 快照保留为当周补充覆盖（upsert，周五提交比周一零点更细）。
 *
 * 约定：
 *  - 快照对象 = 项目**全部真叶子任务**（`NOT EXISTS(子节点)` 判定，与 D01/D01.5 看板口径一致）；
 *  - `UNIQUE(object_type, object_id, week)` + `ON CONFLICT DO UPDATE`：同周多通道覆盖为最新；
 *  - `source` 三通道（v27 迁移）：
 *      `report`    周报提交采集（周内、状态新鲜，最接近提交时点）；
 *      `scheduled` 周一 00:10 定时采集（刚结束周的周末真值，环比首选基准）；
 *      `backfill`  启动补偿补拍（晚于周界，状态非周末真值，前端需标注「补拍基准」）；
 *  - 调用方（report.service / snapshotScheduler）自行 try/catch 隔离：快照失败只丢环比数据，不阻塞业务。
 */

const crypto = require('crypto');

/**
 * 采集某项目当周全量真叶子任务快照（幂等 upsert）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {string} week 周码 'YYYY-Www'
 * @param {string} [reportId] 触发快照的周报 id（仅 source=report 时有值，可追溯）
 * @param {string} [source] 快照来源：'report' | 'scheduled' | 'backfill'（缺省 report，兼容旧调用方）
 * @returns {number} 本次快照的任务数（0 = 项目无真叶子任务）
 */
function captureProjectTaskSnapshot(db, projectId, week, reportId, source) {
  const rows = db
    .prepare(
      `SELECT id, progress, status FROM wbs_nodes
        WHERE project_id = ?
          AND NOT EXISTS (SELECT 1 FROM wbs_nodes c WHERE c.parent_id = wbs_nodes.id)`,
    )
    .all(projectId);

  const src = source || 'report';
  const now = new Date().toISOString();

  if (!rows.length) {
    /* 无叶子任务也要留痕：确保「该项目该周已拍过」判定成立（否则调度器每次启动都重复补拍） */
    const marker = db
      .prepare('SELECT 1 FROM progress_snapshots WHERE project_id = ? AND week = ? AND object_type = ? LIMIT 1')
      .get(projectId, week, 'task');
    if (!marker) {
      db.prepare(
        `INSERT INTO progress_snapshots
          (id, project_id, object_type, object_id, week, progress, status, captured_at, report_id, source)
        VALUES (@id, @projectId, 'task', '__empty__', @week, 0, '空', @capturedAt, NULL, @source)`,
      ).run({ id: 'SNAP_' + crypto.randomUUID().slice(0, 12), projectId: projectId, week: week, capturedAt: now, source: src });
    }
    return 0;
  }

  const upsert = db.prepare(`
    INSERT INTO progress_snapshots
      (id, project_id, object_type, object_id, week, progress, status, captured_at, report_id, source)
    VALUES
      (@id, @projectId, 'task', @objectId, @week, @progress, @status, @capturedAt, @reportId, @source)
    ON CONFLICT(object_type, object_id, week) DO UPDATE SET
      progress    = excluded.progress,
      status      = excluded.status,
      captured_at = excluded.captured_at,
      report_id   = excluded.report_id,
      source      = excluded.source
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
      source: src,
    });
  });
  return rows.length;
}

/**
 * 全项目全量快照（定时器 / 手动触发用）：对**所有项目**拍指定周快照。
 * @param {import('better-sqlite3').Database} db
 * @param {string} week 周码 'YYYY-Www'
 * @param {string} source 'scheduled' | 'backfill'（不允许 'report'——该通道必须带 reportId）
 * @returns {{projects: number, tasks: number}} 采集的项目数与任务总数
 */
function captureAllProjectsSnapshot(db, week, source) {
  const src = source || 'scheduled';
  const projects = db.prepare("SELECT id FROM projects ORDER BY id").all();
  let tasks = 0;
  projects.forEach(function (p) {
    tasks += captureProjectTaskSnapshot(db, p.id, week, null, src);
  });
  return { projects: projects.length, tasks: tasks };
}

/**
 * 启动补偿：对指定周**缺失快照的项目**逐个补拍（已拍过的不覆盖，保留原通道数据）。
 * 「缺失」判定 = 该项目该周无任何 task 快照行（含空表留痕行）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} week 周码 'YYYY-Www'
 * @returns {string[]} 本次补拍的项目 id 列表
 */
function ensureWeekSnapshots(db, week) {
  const projects = db.prepare("SELECT id FROM projects ORDER BY id").all();
  const has = db.prepare(
    'SELECT 1 FROM progress_snapshots WHERE project_id = ? AND week = ? AND object_type = ? LIMIT 1',
  );
  const backfilled = [];
  projects.forEach(function (p) {
    if (!has.get(p.id, week, 'task')) {
      captureProjectTaskSnapshot(db, p.id, week, null, 'backfill');
      backfilled.push(p.id);
    }
  });
  return backfilled;
}

module.exports = { captureProjectTaskSnapshot, captureAllProjectsSnapshot, ensureWeekSnapshots };
