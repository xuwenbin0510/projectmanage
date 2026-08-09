#!/usr/bin/env node
/**
 * QA 独立验证 · B8 P0 前端契约路径（ReportFormModal assemble 编辑分支）
 *
 * 定位：B8 交付关卡 Round 2 回归补充。用「真实前端契约」逐字节模拟
 * `web/src/components/report/ReportFormModal.tsx` `assemble()` 编辑分支的 payload 输出，
 * 打到真实后端 PATCH /api/projects/:pid/reports/:id，验证：
 *
 *   ① 修复后输出（仅勾选叶子携带 actualDays，取编辑后值=冲正入口；
 *      未勾选行 / 父节点行 actualDays=undefined）→ HTTP 200 且冲正生效（父 Σ 同步 ±Δ）；
 *   ② 旧行为输出（全行携带 actualDays:0，含未勾选行与父节点行）→ HTTP 400 E_VALIDATION
 *      （后端 resolveTaskRefs 防绕过，证明「编辑必 400」已修）。
 *
 * 用法（同既有回归脚本约定：同一 DB_PATH 起服务 + 跑脚本）：
 *   DB_PATH=./b8_qa.db node scripts/qa_b8_frontend_contract.mjs http://127.0.0.1:3311
 *
 * 退出码：0 = 全绿；1 = 有断言失败
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const BASE = (process.argv[2] || process.env.SMOKE_BASE || 'http://127.0.0.1:3311').replace(/\/$/, '');
const DB_FILE = process.env.DB_PATH || './b8_qa.db';

const ADMIN_OPEN_ID = 'ou_xuwenbin01';
const TL_OPEN_ID = 'ou_wangqiang02';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label, detail) {
  if (cond) {
    passed += 1;
    console.log('  \u2713 ' + label);
  } else {
    failed += 1;
    const line = label + (detail === undefined ? '' : '  → ' + JSON.stringify(detail));
    failures.push(line);
    console.log('  \u2717 ' + line);
  }
}

function findSnakeCaseKeys(value, pathStr) {
  if (value === null || typeof value !== 'object') return [];
  const out = [];
  for (const k of Object.keys(value)) {
    const p = pathStr ? pathStr + '.' + k : k;
    if (/_/.test(k)) out.push(p);
    if (value[k] && typeof value[k] === 'object') out.push(...findSnakeCaseKeys(value[k], p));
  }
  return out;
}

let token = '';

async function call(method, pathname, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = { __parseError: true, raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

async function loginAs(openId) {
  const r = await call('POST', '/api/auth/devlogin', { openId });
  token = (r.json && r.json.data && r.json.data.token) || '';
  return r;
}

function okData(r, label) {
  if (!r || !r.json || r.json.code !== 0) {
    assert(false, label + '（信封失败）', r && r.json);
    return null;
  }
  return r.json.data;
}

function expectError(r, code, status, label) {
  assert(r.status === status, label + ' → HTTP ' + status, { status: r.status });
  assert(r.json && r.json.code === code, label + ' → code ' + code, r.json && r.json.code);
  assert(!r.json || findSnakeCaseKeys(r.json).length === 0, label + ' → 无 snake_case', findSnakeCaseKeys(r.json || {}));
}

function dayOffset(n) {
  const d = new Date(Date.now() + n * 86400000);
  return d.toISOString().slice(0, 10);
}

/* ── DB 直查（只读） ─────────────────────────────────── */
function openDb() {
  const Database = require('better-sqlite3');
  const dbFile = path.resolve(ROOT, DB_FILE);
  return new Database(dbFile, { readonly: true });
}

function dbRow(sql, params) {
  const db = openDb();
  try {
    return db.prepare(sql).get(...(params || []));
  } finally {
    db.close();
  }
}

function dbRows(sql, params) {
  const db = openDb();
  try {
    return db.prepare(sql).all(...(params || []));
  } finally {
    db.close();
  }
}

/* ── 周报 payload 构造（与 qa_b8_verify 同源） ───────── */
let WEEK_SEQ = 80;
function nextWeek() {
  return '2026-W' + (WEEK_SEQ++);
}

function reportPayload(week, tasks) {
  return {
    projectId: null, // 路由注入真源
    week: week,
    doneNote: 'B8 前端契约验证',
    planItems: ['完成 B8 契约验证'],
    resourceNote: '',
    tasks: tasks,
    risks: [],
  };
}

/**
 * ★ 真实前端契约：ReportFormModal.assemble() 编辑分支（修复后）——
 *   editingReport.tasks.map：selected/progressAfter 原样回传，
 *   actualDays 仅 selected=true 且非父节点行携带（取表单编辑值）；未勾选/父行 undefined。
 */
function assembleEditTasks(originalTasks, parentIdSet, editedDaysByNodeId) {
  return originalTasks.map((t) => {
    const isSelectedLeaf = t.selected === true && !parentIdSet.has(t.nodeId);
    return {
      nodeId: t.nodeId,
      progressAfter: t.progressAfter,
      selected: t.selected,
      actualDays: isSelectedLeaf ? (editedDaysByNodeId[t.nodeId] !== undefined ? editedDaysByNodeId[t.nodeId] : (t.weekActualDays ?? 0)) : undefined,
    };
  });
}

/** 旧行为（bug）：全行携带 actualDays:0（含未勾选行与父节点行） */
function legacyAllZeroTasks(originalTasks) {
  return originalTasks.map((t) => ({
    nodeId: t.nodeId,
    progressAfter: t.progressAfter,
    selected: t.selected,
    actualDays: 0,
  }));
}

async function main() {
  console.log('═══ B8 前端契约路径 · assemble 编辑分支（' + BASE + ' / DB=' + DB_FILE + '）═══');

  await loginAs(ADMIN_OPEN_ID);
  assert(!!token, '管理员 devlogin 签发 token');

  /* ── 铺数据：项目 + 根 R + 叶子 A（勾选）/ B（未勾选） ── */
  const stamp = Date.now();
  const proj = okData(
    await call('POST', '/api/projects', {
      name: 'B8前端契约 ' + stamp,
      type: 'A',
      customer: '星舰客户',
      contractAmount: 500,
      background: 'qa_b8_frontend_contract 自动创建',
      goal: ['B8 契约验证'],
      planStart: dayOffset(0),
      planEnd: dayOffset(180),
      pm: ADMIN_OPEN_ID,
      classifyInput: { contractAmount: 500, hasHardware: true, hasAcceptance: true, isSelfIteration: false, isInfrastructure: false },
      classifySuggested: 'A',
      classifyOverrideReason: '',
      members: [{ userOpenId: ADMIN_OPEN_ID, role: 'pm' }, { userOpenId: TL_OPEN_ID, role: 'tl' }],
      milestones: [{ code: 'M1', name: '启动', date: dayOffset(30), required: true, gate: null }],
    }),
    '建契约验证项目',
  );
  const pid = proj && proj.id;
  assert(!!pid, '项目创建成功返回 id');

  const nodes0 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（骨架）');
  const root = (nodes0 || []).find((n) => n.level === 1);
  assert(!!root, '骨架根节点存在');
  const rootId = root && root.id;

  const createA = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'A-勾选叶', owner: ADMIN_OPEN_ID, estimateDays: 1,
    }),
    '根下建叶子 A（勾选）',
  );
  const leafAId = createA && createA.id;
  assert(!!leafAId, '叶子 A 创建成功');

  const createB = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'B-未勾选叶', owner: ADMIN_OPEN_ID, estimateDays: 1,
    }),
    '根下建叶子 B（未勾选）',
  );
  const leafBId = createB && createB.id;
  assert(!!leafBId, '叶子 B 创建成功');

  /* 父节点集合（叶子口径唯一入口：与前端 parentIdSet(flattenTree) 同源，
     与后端 resolveTaskRefs 的 childCount>0 判定同构 → DB 直查 parent_id 有子者） */
  const parentIdSet = new Set(
    dbRows('SELECT DISTINCT parent_id FROM wbs_nodes WHERE parent_id IS NOT NULL').map((r) => r.parent_id),
  );
  // 叶子 A/B 不是父
  assert(!parentIdSet.has(leafAId) && !parentIdSet.has(leafBId), 'A/B 判定为非父节点（叶子）');
  assert(parentIdSet.has(rootId), '根 R 判定为父节点');

  /* ── 新建提交（修复后 buildNewTaskRefs 口径：仅勾选叶子带 actualDays） ── */
  const week1 = nextWeek();
  const newTasks = [
    // 父节点行：selected=false，actualDays undefined
    { nodeId: rootId, progressAfter: 0, selected: false, actualDays: undefined },
    // 勾选叶子 A：携带 actualDays=0.5
    { nodeId: leafAId, progressAfter: 30, selected: true, actualDays: 0.5 },
    // 未勾选叶子 B：actualDays undefined
    { nodeId: leafBId, progressAfter: 0, selected: false, actualDays: undefined },
  ];
  const rep1 = okData(
    await call('POST', '/api/projects/' + pid + '/reports', Object.assign({}, reportPayload(week1, newTasks), { submit: true })),
    '新建提交（父/未勾选不带 actualDays，A 带 0.5）',
  );
  assert(!!rep1 && rep1.id, '提交成功返回报告 id');
  const rep1Id = rep1 && rep1.id;

  let nodes1 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（提交后）');
  const rootA = (nodes1 || []).find((n) => n.id === rootId);
  assert(rootA && rootA.effortHours === 0.5, '提交后 父 R Σ = 0.5（仅勾选叶 A 累计）', rootA && rootA.effortHours);

  /* ── 编辑已提交日志 · 修复后输出（冲正入口：A 0.5 → 1.5，净 +1.0） ── */
  const detail1 = okData(await call('GET', '/api/projects/' + pid + '/reports/' + week1), 'GET 报告详情（编辑回填数据源）');
  const originalTasks = detail1 && detail1.tasks;
  assert(Array.isArray(originalTasks) && originalTasks.length === 3, '报告 tasks 含 3 行（父 R / A / B 全量）', originalTasks && originalTasks.length);
  assert(originalTasks.every((t) => Number.isFinite(t.weekActualDays)), '每行均含 weekActualDays:number');

  const editTasksFixed = assembleEditTasks(originalTasks, parentIdSet, { [leafAId]: 1.5 });
  // 契约断言：修复后输出中未勾选/父行 actualDays 必须 undefined
  assert(editTasksFixed.find((t) => t.nodeId === leafAId && t.actualDays === 1.5), '修复后 A 行携带 actualDays=1.5（编辑后值=冲正入口）', editTasksFixed);
  assert(editTasksFixed.find((t) => t.nodeId === leafBId && t.actualDays === undefined), '修复后未勾选 B 行 actualDays=undefined', editTasksFixed);
  assert(editTasksFixed.find((t) => t.nodeId === rootId && t.actualDays === undefined), '修复后父 R 行 actualDays=undefined', editTasksFixed);

  const rep1b = okData(
    await call('PATCH', '/api/projects/' + pid + '/reports/' + rep1Id, reportPayload(week1, editTasksFixed)),
    'PATCH 编辑（修复后输出）→ 200',
  );
  assert(!!rep1b, '编辑成功返回报告');
  const rep1bRow = rep1b && rep1b.tasks.find((t) => t.nodeId === leafAId);
  assert(rep1bRow && rep1bRow.weekActualDays === 1.5, '编辑后落库 A.weekActualDays=1.5', rep1bRow && rep1bRow.weekActualDays);

  let nodes2 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（冲正后）');
  const rootB = (nodes2 || []).find((n) => n.id === rootId);
  assert(rootB && rootB.effortHours === 1.5, '冲正生效：父 R Σ = 1.5（0.5→1.5 净 +1.0）', rootB && rootB.effortHours);

  /* ── 旧行为（bug）：全行带 actualDays:0 → 400（证明已修） ── */
  const detail2 = okData(await call('GET', '/api/projects/' + pid + '/reports/' + week1), 'GET 报告详情（旧行为构造前）');
  const legacyTasks = legacyAllZeroTasks(detail2 && detail2.tasks);
  assert(legacyTasks.every((t) => t.actualDays === 0), '旧行为构造：全行（含父/未勾选）actualDays=0', legacyTasks);

  const rOld = await call('PATCH', '/api/projects/' + pid + '/reports/' + rep1Id, reportPayload(week1, legacyTasks));
  expectError(rOld, 'E_VALIDATION', 400, '旧行为（全行带 0）PATCH → 400 E_VALIDATION');

  /* 旧行为被拒后不得产生半更新（冲正回滚） */
  let nodes3 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（旧行为被拒后）');
  const rootC = (nodes3 || []).find((n) => n.id === rootId);
  assert(rootC && rootC.effortHours === 1.5, '被拒后 父 R Σ 仍 1.5（无半更新）', rootC && rootC.effortHours);
  const rep1cRow = dbRow('SELECT week_actual_days FROM work_report_tasks WHERE report_id = ? AND node_id = ?', [rep1Id, leafAId]);
  assert(rep1cRow && rep1cRow.week_actual_days === 1.5, '被拒后 A 行 week_actual_days 仍 1.5（报告未半更新）', rep1cRow && rep1cRow.week_actual_days);
  const aEffort = dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]);
  assert(aEffort && aEffort.effort_hours === 1.5, '被拒后 A.effort_hours 仍 1.5（事务整体回滚）', aEffort && aEffort.effort_hours);

  /* ── 反向：编辑回退为 0（冲正清零）仍可，契约不回归 ── */
  const editTasksZero = assembleEditTasks(detail2.tasks, parentIdSet, { [leafAId]: 0 });
  const rep1d = okData(
    await call('PATCH', '/api/projects/' + pid + '/reports/' + rep1Id, reportPayload(week1, editTasksZero)),
    'PATCH 编辑（A→0 冲正清零）→ 200',
  );
  assert(!!rep1d, '清零编辑成功');
  let nodes4 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（清零后）');
  const rootD = (nodes4 || []).find((n) => n.id === rootId);
  assert(rootD && rootD.effortHours === 0, '清零后 父 R Σ = 0（冲正净 -1.5）', rootD && rootD.effortHours);

  /* ── 汇总 ── */
  console.log('\n' + '═'.repeat(46));
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  if (failures.length) {
    console.log('失败明细:');
    failures.forEach(function (f) { console.log('  - ' + f); });
  }
  console.log(failed === 0 ? 'IS_PASS: YES' : 'IS_PASS: NO');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('脚本异常:', e && e.stack || e);
  process.exit(1);
});
