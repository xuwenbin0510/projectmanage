#!/usr/bin/env node
/**
 * 一次性回填脚本：为老项目补齐 WBS 顶层骨架节点（B4 / B3 补丁 · T01-2）
 *
 * 背景：B3 上线时 `createProject` 不生成 WBS 骨架，导致老项目的里程碑在 WBS 页
 * 没有任何绑定节点。T01-1 已在建项链路补上生成逻辑，本脚本负责把**存量**项目补齐。
 *
 * 幂等保证：仅对「`wbs_nodes` 中不存在 `milestone_id = 该里程碑` 的行」补插入，
 * 因此可重复执行而不会翻倍。
 *
 * 用法（在 pm-app/ 根目录）：
 *   node scripts/backfill-wbs-skeleton.js
 *   DB_PATH=./pm.db node scripts/backfill-wbs-skeleton.js
 *
 * 注意：本脚本是运维工具，**不进路由、不进迁移**，部署后手动跑一次即可。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const cfg = require('../config');
const ids = require('../server/lib/ids');
const dates = require('../server/lib/dates');

/* ── 数据库连接（与 db.js 同路径，但不跑迁移 / 种子，避免副作用） ───────── */

/**
 * 打开数据库连接。库文件不存在时直接报错退出，避免误建空库。
 * @returns {import('better-sqlite3').Database}
 */
function openDb() {
  const dbPath = path.resolve(cfg.DB_PATH);
  if (!fs.existsSync(dbPath)) {
    console.error('[backfill] 数据库文件不存在：%s', dbPath);
    console.error('[backfill] 请先启动一次服务（node server.js）生成库，或用 DB_PATH 指定正确路径。');
    process.exit(1);
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/* ── 主流程 ─────────────────────────────────────────── */

/**
 * 对单个项目补齐骨架节点。
 * @param {import('better-sqlite3').Database} db
 * @param {{id: string, name: string, plan_start: string}} project 项目行
 * @param {object} stmts 预编译语句集合
 * @param {string} ts ISO 时间戳
 * @returns {number} 本项目实际补插入的节点数
 */
function backfillProject(db, project, stmts, ts) {
  const milestones = stmts.selMilestones.all(project.id);
  if (!milestones.length) return 0;

  /* 当前项目已有的最大 board_order，新增节点顺序接在其后，避免与既有节点撞序。
     ⚠ 空表时 MAX() 返回 NULL（Number(null) === 0 会误判），必须显式判空。 */
  const orderRow = stmts.selMaxOrder.get(project.id);
  const maxOrder = orderRow && orderRow.mx !== null && orderRow.mx !== undefined
    ? Number(orderRow.mx)
    : null;
  let nextOrder = maxOrder === null || !Number.isFinite(maxOrder) ? 0 : maxOrder + 1;

  let inserted = 0;

  milestones.forEach(function (ms, idx) {
    const boundRow = stmts.selBound.get(project.id, ms.id);
    const bound = boundRow && Number(boundRow.n) ? Number(boundRow.n) : 0;
    if (bound > 0) return; // 已有绑定节点 → 跳过（幂等）

    const dueDate = String(ms.planned_date || project.plan_start || '');
    const msCode = String(ms.code || 'M' + (idx + 1));
    const msName = String(ms.name || '');

    stmts.insWbsNode.run({
      id: ids.genId('W'),
      project_id: project.id,
      parent_id: null,
      wbs_code: String(idx + 1),
      level: 1,
      node_type: 'task',
      name: msName,
      description: '由里程碑「' + msCode + ' ' + msName + '」回填生成',
      owner: '',
      estimate_days: 0,
      actual_days: 0,
      start_date: '',
      due_date: dueDate,
      status: '待办',
      progress: 0,
      board_order: nextOrder,
      is_critical: 0,
      milestone_id: ms.id,
      created_by: '',
      created_at: ts,
      updated_at: ts,
    });

    nextOrder += 1;
    inserted += 1;
  });

  return inserted;
}

/**
 * 脚本入口。
 * @returns {void}
 */
function main() {
  const db = openDb();
  const ts = dates.nowIso();

  const stmts = {
    selProjects: db.prepare(
      'SELECT id, name, plan_start FROM projects WHERE deleted_at IS NULL ORDER BY created_at'
    ),
    selMilestones: db.prepare(
      'SELECT id, code, name, planned_date FROM milestones WHERE project_id = ? ORDER BY planned_date, code'
    ),
    selBound: db.prepare(
      'SELECT COUNT(*) AS n FROM wbs_nodes WHERE project_id = ? AND milestone_id = ?'
    ),
    selMaxOrder: db.prepare(
      'SELECT MAX(board_order) AS mx FROM wbs_nodes WHERE project_id = ?'
    ),
    insWbsNode: db.prepare(`
      INSERT INTO wbs_nodes (
        id, project_id, parent_id, wbs_code, level, node_type, name, description,
        owner, estimate_days, actual_days, start_date, due_date, status, progress,
        board_order, is_critical, milestone_id, created_by, created_at, updated_at
      ) VALUES (
        @id, @project_id, @parent_id, @wbs_code, @level, @node_type, @name, @description,
        @owner, @estimate_days, @actual_days, @start_date, @due_date, @status, @progress,
        @board_order, @is_critical, @milestone_id, @created_by, @created_at, @updated_at
      )
    `),
  };

  const projects = stmts.selProjects.all();
  console.log('[backfill] 库：%s，待检查项目 %d 个', path.resolve(cfg.DB_PATH), projects.length);

  let total = 0;
  const tx = db.transaction(function () {
    projects.forEach(function (p) {
      const n = backfillProject(db, p, stmts, ts);
      total += n;
      if (n > 0) {
        console.log('[backfill]   %s %s → 补 %d 条骨架节点', p.id, p.name, n);
      } else {
        console.log('[backfill]   %s %s → 已完整，跳过', p.id, p.name);
      }
    });
  });

  try {
    tx();
  } catch (e) {
    console.error('[backfill] 回填失败，已整体回滚：%s', e.message);
    db.close();
    process.exit(1);
  }

  console.log('[backfill] 完成，共补插入 %d 条 wbs_nodes 骨架节点。', total);
  db.close();
  process.exit(0);
}

main();
