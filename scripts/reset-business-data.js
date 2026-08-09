#!/usr/bin/env node
/**
 * B5 · R5 运维脚本：安全清空全部业务测试数据（保留演示账号与系统模板）
 *
 * 背景：pm.db 内堆积了 100 个测试项目 / 246 里程碑 / 457 WBS 节点 / 1139 审计日志等
 * 演示回归数据。本脚本一键回到干净可演示基线：**全部业务表清空**，保留
 * `users`（11 个演示账号）、`lifecycle_templates`（3 条系统模板）、`schema_migrations`。
 *
 * 安全策略（与 PRD §3.5 / 架构 D-B5-3 一致）：
 *   1. 停写：建议在无业务写入窗口执行（或先停服务）。
 *   2. 备份：`wal_checkpoint(TRUNCATE)` 落盘 WAL → `db.backup()` 生成冷备
 *      `pm.db.bak-YYYYMMDD`（回滚窗口 = 备份文件本身）。
 *   3. 清空：单事务内 `PRAGMA foreign_keys=OFF` → 按依赖顺序逐表 DELETE →
 *      事务末 `PRAGMA foreign_key_check` 必须为空 → 恢复 `foreign_keys=ON`。
 *   4. 断言：`users=11` / `lifecycle_templates=3` / `schema_migrations≥3` /
 *      所有业务表 `COUNT(*)=0` / `foreign_key_check` 空 / 备份文件存在。
 *   5. 收尾：可选 VACUUM（失败仅告警，不影响结果）；打印各表清理行数与保留集计数。
 *
 * 幂等：重复执行安全（业务表已为 0 时 DELETE 无副作用；备份文件同日覆盖）。
 *
 * 用法（在 pm-app/ 根目录）：
 *   node scripts/reset-business-data.js
 *   DB_PATH=./pm.db node scripts/reset-business-data.js
 *
 * 退出码：0 = 全绿；非 0 = 有断言失败（打印明细）。
 *
 * 注意：本脚本是运维工具，**不进路由、不进迁移**；请勿在正在运行的后端
 * （node server.js）使用的库上执行，先停服务或对副本库验证。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const cfg = require('../config');
const { tableExists } = require('../server/dal/migrations');

/* ── 表清单 ─────────────────────────────────────────── */

/**
 * 业务表清空顺序（子→父，与 PRD §3.5 一致）。
 * 含旧 schema 曾定义、当前库可能不存在的表（reviews / review_steps / changes /
 * risks / documents / project_stages）——脚本对每张表做 `sqlite_master` 存在性守卫。
 */
const BUSINESS_TABLES = [
  'approvals',
  'review_steps', // 若存在（旧 schema）
  'reviews',      // 若存在（旧 schema）
  'audit_logs',
  'work_report_tasks',
  'work_report_risks',
  'work_reports',
  'report_tasks',
  'reports',
  'tasks',
  'board_configs',
  'gate_checklist_items',
  'quality_gates',
  'changes',      // 若存在（引用 reviews / milestones）
  'project_members',
  'risks',        // 若存在（旧 schema）
  'documents',    // 若存在（旧 schema）
  'wbs_nodes',
  'milestones',
  'project_stages', // 若存在（旧 schema）
  'projects',
];

/** 保留集（不清，脚本只断言计数） */
const KEEP_TABLES = ['users', 'lifecycle_templates', 'schema_migrations'];

/* ── 小工具 ─────────────────────────────────────────── */

/**
 * 打开数据库连接（与 db.js 同路径，但不跑迁移 / 种子，避免副作用）。
 * 库文件不存在时直接报错退出，避免误建空库。
 * @returns {import('better-sqlite3').Database}
 */
function openDb() {
  const dbPath = path.resolve(cfg.DB_PATH);
  if (!fs.existsSync(dbPath)) {
    console.error('[reset] 数据库文件不存在：%s', dbPath);
    console.error('[reset] 请先启动一次服务（node server.js）生成库，或用 DB_PATH 指定正确路径。');
    process.exit(1);
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * 格式化日期为 YYYYMMDD（备份文件名用）。
 * @param {Date} d
 * @returns {string}
 */
function yyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return '' + y + m + day;
}

/**
 * 取表行数；表不存在返回 null。
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @returns {?number}
 */
function countOf(db, table) {
  if (!tableExists(db, table)) return null;
  const row = db.prepare('SELECT COUNT(*) AS c FROM ' + table).get();
  return row ? Number(row.c) : 0;
}

/* ── 主流程 ─────────────────────────────────────────── */

/**
 * 脚本入口。
 * @returns {Promise<void>}
 */
async function main() {
  const db = openDb();
  const dbPath = path.resolve(cfg.DB_PATH);

  /* ---------- 1. 备份 ---------- */
  // WAL 落盘后再做在线备份，保证备份文件包含已提交的全部数据
  db.pragma('wal_checkpoint(TRUNCATE)');

  const backupName = path.basename(dbPath) + '.bak-' + yyyymmdd(new Date());
  const backupPath = path.join(path.dirname(dbPath), backupName);
  console.log('[reset] 库：%s', dbPath);
  console.log('[reset] ① 备份 → %s', backupPath);

  await db.backup(backupPath);

  if (!fs.existsSync(backupPath)) {
    console.error('[reset] 备份文件未生成：%s', backupPath);
    db.close();
    process.exit(1);
  }
  const backupSize = fs.statSync(backupPath).size;
  console.log('[reset]    备份完成（%d 字节）', backupSize);

  /* ---------- 2. 清理前计数（打印用） ---------- */
  const before = {};
  BUSINESS_TABLES.forEach(function (t) {
    before[t] = countOf(db, t);
  });

  /* ---------- 3. 单事务清空（方案 A：FK OFF → DELETE → FK check 空 → FK ON） ---------- */
  db.pragma('foreign_keys = OFF');
  console.log('[reset] ② 单事务清空业务表（foreign_keys=OFF）');

  const tx = db.transaction(function () {
    BUSINESS_TABLES.forEach(function (t) {
      if (tableExists(db, t)) {
        const info = db.prepare('DELETE FROM ' + t).run();
        console.log('  DELETE ' + t + ': ' + info.changes + ' 行');
      } else {
        console.log('  SKIP  ' + t + ': 表不存在');
      }
    });
  });

  tx();

  const violations = db.pragma('foreign_key_check');
  const fkViolations = Array.isArray(violations) ? violations : [];
  db.pragma('foreign_keys = ON');

  if (fkViolations.length > 0) {
    console.error('[reset] ❌ foreign_key_check 非空：%d 条', fkViolations.length);
    console.error(JSON.stringify(fkViolations.slice(0, 20), null, 2));
    db.close();
    process.exit(1);
  }
  console.log('[reset]    foreign_key_check 为空 ✓');

  /* ---------- 4. 断言（失败退出码非 0） ---------- */
  console.log('[reset] ③ 自动断言');
  const failures = [];

  const usersCount = countOf(db, 'users');
  const tplCount = countOf(db, 'lifecycle_templates');
  const migCount = countOf(db, 'schema_migrations');

  if (usersCount !== 11) failures.push('users 应为 11，实际 ' + usersCount);
  if (tplCount !== 3) failures.push('lifecycle_templates 应为 3，实际 ' + tplCount);
  if (migCount === null || migCount < 3) failures.push('schema_migrations 应 ≥3，实际 ' + migCount);

  BUSINESS_TABLES.forEach(function (t) {
    const n = countOf(db, t);
    if (n !== null && n !== 0) failures.push(t + ' 应为 0，实际 ' + n);
  });

  if (failures.length > 0) {
    console.error('[reset] ❌ 断言失败：');
    failures.forEach(function (f) { console.error('  - ' + f); });
    console.error('[reset] 回滚：还原备份 %s 即可。', backupPath);
    db.close();
    process.exit(1);
  }
  console.log('[reset]    保留集：users=%d / lifecycle_templates=%d / schema_migrations=%d ✓',
    usersCount, tplCount, migCount);
  console.log('[reset]    全部业务表 COUNT(*)=0 ✓');
  console.log('[reset]    备份文件存在 ✓（%s）', backupPath);

  /* ---------- 5. 可选 VACUUM（失败仅告警，不阻断） ---------- */
  try {
    db.exec('VACUUM');
    console.log('[reset] ④ VACUUM 完成');
  } catch (e) {
    console.warn('[reset] ④ VACUUM 跳过（%s）——如需收缩文件，请在无其他连接时手动执行', e.message);
  }

  /* ---------- 6. 汇总 ---------- */
  const totalCleaned = BUSINESS_TABLES.reduce(function (acc, t) {
    const n = before[t];
    return acc + (n === null ? 0 : n);
  }, 0);
  console.log('[reset] 完成：共清理 %d 行业务数据；保留演示账号与系统模板。', totalCleaned);
  console.log('[reset] 回滚：还原 %s 并重新 checkpoint 即可。', backupPath);

  db.close();
  process.exit(0);
}

main().catch(function (e) {
  console.error('[reset] 执行异常：%s', e && e.stack ? e.stack : String(e));
  process.exit(1);
});
