#!/usr/bin/env node
/**
 * 生产库「身份收口」跨接回填脚本（一次性，幂等、可 --dry-run）。
 *
 * 背景：14 张表原把飞书 open_id 当外键，导入数据带的 open_id 与 users 表免登建号
 * 的 open_id 不同源（来自另一套飞书应用），导致责任人/操作人显示「已移除」。
 * v24 迁移已为这些表加 xxx_user_id 列并回填「open_id / 姓名能直接解析」的行；
 * 本脚本专门处理 v24 单级回填搞不定的 8 个孤儿 open_id —— 通过
 * 「孤儿 open_id -> 姓名 -> 生产 users.id」桥接，把对应行的 xxx_user_id 填平。
 *
 * 安全设计：
 *  1. 仅 UPDATE `uidCol IS NULL AND srcCol = 孤儿open_id` 的行，绝不碰已回填行；
 *  2. 运行时按姓名解析 users.id（不硬编码 id），每名必须唯一命中，否则整体中止；
 *  3. 先校验 v24 列已存在、桥可解析，--dry-run 只统计不写；
 *  4. 全程事务，任一步失败回滚。
 */
'use strict';
const path = require('path');
const Database = require('better-sqlite3');

const DRY_RUN = process.argv.includes('--dry-run');
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'pm-data', 'pm.db');

// 孤儿 open_id -> 姓名（来源：本地 owner_user_id 经 CSV 名桥填好，已对生产 8/8 唯一命中验证）
const ORPHAN_MAP = {
  'ou_880adf033549e1227aa4aa7490991b98': '秦岭',
  'ou_183a102ded748d070c7daac124f40742': '何繁',
  'ou_7f76b89590ac02b9eeb922ac287ccbda': '张磊',
  'ou_44ac9059b0c58273759aaf0d32a4ff31': '赵延锋',
  'ou_6a9bc5ac042874ccfef27567b6119cc0': '陈联军',
  'ou_1cd8caf74b710424b443fa900e79dc35': '郸子怿',
  'ou_f81b2b045d41b750fff6f0fbc8f9847d': '强惠婷',
  'ou_e69653222295b4745ec897ad487887a9': '王玮',
};

// 与 migrations.js v24 的 BACKFILL 对齐（仅 open_id 型来源列会被孤儿命中；姓名型列孤儿命中为 0）
const PAIRS = [
  ['risks', 'created_by_user_id', 'created_by'],
  ['changes', 'created_by_user_id', 'created_by'],
  ['review_steps', 'assignee_user_id', 'assignee_open_id'],
  ['review_steps', 'decided_by_user_id', 'decided_by'],
  ['review_approvals', 'actor_user_id', 'actor_open_id'],
  ['reviews', 'initiator_user_id', 'initiator_open_id'],
  ['project_members', 'member_user_id', 'user_open_id'],
  ['project_members', 'assigned_by_user_id', 'assigned_by'],
  ['user_roles', 'role_user_id', 'user_open_id'],
  ['user_roles', 'assigned_by_user_id', 'assigned_by'],
  ['notifications', 'user_id', 'user_open_id'],
  ['audit_logs', 'actor_user_id', 'actor_open_id'],
  ['work_reports', 'author_user_id', 'author_open_id'],
  ['permission_rules', 'updated_by_user_id', 'updated_by'],
  ['projects', 'created_by_user_id', 'created_by'],
  ['wbs_nodes', 'owner_user_id', 'owner'],
  ['wbs_nodes', 'created_by_user_id', 'created_by'],
  ['quality_gates', 'decided_by_user_id', 'decided_by'],
  ['project_documents', 'baselined_by_user_id', 'baselined_by'],
  ['project_documents', 'uploaded_by_user_id', 'uploaded_by'],
];

function hasColumn(db, t, col) {
  const rows = db.prepare(`PRAGMA table_info(${t})`).all();
  return rows.some((r) => r.name === col);
}

function main() {
  console.log(`[backfill] DB_PATH=${DB_PATH}  dry-run=${DRY_RUN}`);
  const db = new Database(DB_PATH, { readonly: DRY_RUN });
  db.pragma('busy_timeout = 5000');

  // ── 校验 1：v24 列必须已存在（否则说明 ECS 还没部署含 v24 的代码）──
  const missing = [];
  for (const [t, uid] of PAIRS) {
    if (!hasColumn(db, t, uid)) missing.push(`${t}.${uid}`);
  }
  if (missing.length) {
    console.error(`[backfill] 中止：以下 v24 列不存在，请先部署含 v24 的代码：\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  console.log('[backfill] 校验通过：全部 v24 user_id 列已存在');

  // ── 校验 2：桥可解析，且每名在生产 users 唯一命中 ──
  const byName = db.prepare('SELECT id FROM users WHERE name = ?');
  const resolved = {}; // open_id -> {name, userId}
  let bridgeBad = 0;
  for (const [openId, name] of Object.entries(ORPHAN_MAP)) {
    const rows = byName.all(name);
    if (rows.length !== 1) {
      bridgeBad++;
      console.error(`[backfill] 桥异常：姓名「${name}」(孤儿 ${openId}) 命中 ${rows.length} 个 users，须唯一`);
    } else {
      resolved[openId] = { name, userId: rows[0].id };
    }
  }
  if (bridgeBad) {
    console.error(`[backfill] 中止：${bridgeBad} 个孤儿姓名无法唯一解析，未做任何修改`);
    process.exit(1);
  }
  console.log('[backfill] 校验通过：8/8 孤儿姓名在生产 users 唯一命中');

  // ── 统计 / 执行 ──
  const updateStmt = db.transaction(() => {
    let total = 0;
    for (const [t, uid, src] of PAIRS) {
      for (const openId of Object.keys(resolved)) {
        const { name, userId } = resolved[openId];
        const cnt = db.prepare(
          `SELECT count(*) AS c FROM ${t} WHERE ${uid} IS NULL AND ${src} = ?`
        ).get(openId).c;
        if (cnt === 0) continue;
        if (!DRY_RUN) {
          db.prepare(
            `UPDATE ${t} SET ${uid} = (SELECT id FROM users WHERE name = ?) WHERE ${uid} IS NULL AND ${src} = ?`
          ).run(name, openId);
        }
        total += cnt;
        console.log(`  [${t}.${uid}] src=${openId} (${name}) 行数=${cnt}${DRY_RUN ? ' [dry-run 未写]' : ' -> userId=' + userId}`);
      }
    }
    return total;
  });

  const total = updateStmt();
  if (DRY_RUN) {
    console.log(`[backfill] DRY-RUN 完成：预计回填 ${total} 行，未做任何修改`);
  } else {
    console.log(`[backfill] 完成：实际回填 ${total} 行`);
  }
  db.close();
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error('[backfill] 致命错误，未提交任何修改：', e && e.stack ? e.stack : e);
  process.exit(2);
}
