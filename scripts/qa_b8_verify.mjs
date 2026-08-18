#!/usr/bin/env node
/**
 * QA 独立验证 · B8 工时登记时机与单位修正（人日口径）
 *
 * 定位：B8 交付关卡独立验证。对 B7 的 `qa_b7_verify.mjs`（75 条小时口径断言）做语义重构：
 * `effortHours` 从「创建任务时预填(h)」改为「工作日志提交时登记(人日)并累计到节点」。
 * 覆盖（docs/B8-增量PRD.md §4 验收要点 R1~R5 + docs/B8-任务分解.md 验收口径）：
 *   R1 数据模型：migrationV5 幂等 + work_report_tasks.week_actual_days REAL NOT NULL DEFAULT 0；
 *      wbs_nodes.effort_hours 仍 REAL（语义=累计实际工时·人日，零 DDL）
 *   R2 弹窗/边界：WBS 任何写携带 effortHours → 400 E_WBS_EFFORT_WRITE_DISABLED（叶与父同判）；
 *      日志通道 actualDays 负数 / 101 / 100.001 / 'abc' → 400 E_VALIDATION
 *   R3 父 Σ 口径：建叶 → 提交日志（A 0.5、B 2）→ GET /wbs 父 Σ=2.5、叶=0.5/2；
 *      草稿不累加；存草稿行 weekActualDays 落库但不累计
 *   R4 冲正：编辑已提交日志 0.5→1.5 净 +1.0、1.5→0.5 净 -1.0、0.5→0 净 -0.5，父 Σ 同步；
 *      冲正致累计<0 → 400 E_VALIDATION 且整体回滚（无半更新）；编辑草稿不冲正
 *   R5 防绕过/上限：未勾选携带 actualDays / 父节点携带 actualDays → 400 E_VALIDATION；
 *      累计上限 10000（9999.5+0.5=10000 恰好可，+1 → 400）；WBS 写操作不触碰 effort_hours
 *      新节点列 NULL、有日志叶子值不变、叶子成为父后存储值保留（展示走 Σ 子、恢复叶子时值重现）
 *
 * 用法（与既有回归脚本同约定：同一 DB_PATH 起服务 + 跑脚本）：
 *   DB_PATH=./b8_qa.db node scripts/qa_b8_verify.mjs http://127.0.0.1:3311
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

function assertEq(actual, expected, label) {
  assert(actual === expected, label, { expected, actual });
}

function findSnakeCaseKeys(value, pathStr) {
  const p = pathStr || '$';
  const bad = [];
  if (Array.isArray(value)) {
    value.forEach(function (v, i) { bad.push.apply(bad, findSnakeCaseKeys(v, p + '[' + i + ']')); });
    return bad;
  }
  if (value && typeof value === 'object') {
    Object.keys(value).forEach(function (k) {
      if (k.indexOf('_') >= 0) bad.push(p + '.' + k);
      bad.push.apply(bad, findSnakeCaseKeys(value[k], p + '.' + k));
    });
  }
  return bad;
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

/* ── DB 直写（仅用于制造「冲正致累计<0」「累计上限」前置态） ── */
function dbExec(sql, params) {
  const Database = require('better-sqlite3');
  const dbFile = path.resolve(ROOT, DB_FILE);
  const db = new Database(dbFile);
  try {
    return db.prepare(sql).run(...(params || []));
  } finally {
    db.close();
  }
}

/* ── 周报 payload 构造 ───────────────────────────────── */
let WEEK_SEQ = 30;
function nextWeek() {
  return '2026-W' + (WEEK_SEQ++);
}

function reportPayload(week, tasks) {
  return {
    projectId: null, // 路由注入真源
    week: week,
    doneNote: 'B8 专项验证',
    planItems: ['完成 B8 验证'],
    resourceNote: '',
    tasks: tasks,
    risks: [],
  };
}

/* ── 主流程 ──────────────────────────────────────────── */

async function main() {
  console.log('═══ B8 工时登记时机与单位修正 · 专项验证（' + BASE + ' / DB=' + DB_FILE + '）═══');

  await loginAs(ADMIN_OPEN_ID);
  assert(!!token, '管理员 devlogin 签发 token');

  /* ── R1 数据模型（DB 直查） ─────────────────────── */
  console.log('\n── R1 数据模型：migrationV5 幂等 + week_actual_days 列 + effort_hours 语义 ──');
  const mig5 = dbRow('SELECT version, name FROM schema_migrations WHERE version = 5');
  assert(!!mig5 && mig5.name === 'connect-v5-report-week-actual-days', 'schema_migrations 含 v5 connect-v5-report-week-actual-days', mig5);
  const wadCol = dbRows('PRAGMA table_info(work_report_tasks)').find((c) => c.name === 'week_actual_days');
  assert(!!wadCol, 'work_report_tasks 存在 week_actual_days 列');
  assert(wadCol && wadCol.type === 'REAL', 'week_actual_days 类型 REAL', wadCol && wadCol.type);
  assert(wadCol && wadCol.notnull === 1, 'week_actual_days NOT NULL（notnull=1）', wadCol && wadCol.notnull);
  assert(wadCol && String(wadCol.dflt_value) === '0', 'week_actual_days 默认 0', wadCol && wadCol.dflt_value);
  const effCol = dbRows('PRAGMA table_info(wbs_nodes)').find((c) => c.name === 'effort_hours');
  assert(!!effCol && effCol.type === 'REAL', 'wbs_nodes.effort_hours 仍 REAL（零 DDL，语义=累计实际人日）', effCol && effCol.type);

  /* 建项目（1 里程碑 → 骨架根节点 R） */
  const stamp = Date.now();
  const proj = okData(
    await call('POST', '/api/projects', {
      name: 'B8工时验证 ' + stamp,
      type: 'A',
      customer: '星舰客户',
      contractAmount: 500,
      background: 'qa_b8_verify 自动创建',
      goal: ['B8 专项验证'],
      planStart: dayOffset(0),
      planEnd: dayOffset(180),
      pm: ADMIN_OPEN_ID,
      classifyInput: { contractAmount: 500, hasHardware: true, hasAcceptance: true, isSelfIteration: false, isInfrastructure: false },
      classifySuggested: 'A',
      classifyOverrideReason: '',
      members: [{ userOpenId: ADMIN_OPEN_ID, role: 'pm' }, { userOpenId: TL_OPEN_ID, role: 'tl' }],
      milestones: [{ code: 'M1', name: '启动', date: dayOffset(30), required: true, gate: null }],
    }),
    '建 B8 验证项目',
  );
  const pid = proj && proj.id;
  assert(!!pid, '项目创建成功返回 id');

  const nodes0 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（骨架）');
  const root = (nodes0 || []).find((n) => n.level === 1);
  assert(!!root, '骨架根节点存在');
  const rootId = root && root.id;

  assert(!!nodes0 && nodes0.every((n) => Number.isFinite(n.effortHours)), '骨架节点出参均带 effortHours:number');
  assert(!!nodes0 && nodes0.every((n) => Number.isFinite(n.effortChildCount)), '骨架节点出参均带 effortChildCount:number');
  assert(!!nodes0 && findSnakeCaseKeys(nodes0).length === 0, '骨架出参无 snake_case 字段', findSnakeCaseKeys(nodes0 || []));

  /* 建叶子 A / B（不携带 effortHours；新节点该列 NULL） */
  const createA = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'A-叶子', owner: ADMIN_OPEN_ID, estimateDays: 1,
    }),
    '根下建叶子 A（不携带 effortHours）',
  );
  const leafAId = createA && createA.id;
  assert(!!leafAId, '叶子 A 创建成功');
  assert(createA && createA.effortHours === 0, 'A 缺省 effortHours 回显 0（列 NULL → 展示 0）', createA && createA.effortHours);
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]).effort_hours === null, 'A 落库 effort_hours = NULL（WBS 写路径不写该列）');

  const createB = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'B-叶子', owner: ADMIN_OPEN_ID, estimateDays: 1,
    }),
    '根下建叶子 B',
  );
  const leafBId = createB && createB.id;
  assert(!!leafBId, '叶子 B 创建成功');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafBId]).effort_hours === null, 'B 落库 effort_hours = NULL');

  /* ── R2/D4：WBS 写通道彻底关闭 ─────────────────── */
  console.log('\n── R2/D4 WBS 写通道关闭：任何 WBS 写携带 effortHours → E_WBS_EFFORT_WRITE_DISABLED ──');
  let r = await call('PATCH', '/api/wbs/' + leafAId, { effortHours: 0.5 });
  expectError(r, 'E_WBS_EFFORT_WRITE_DISABLED', 400, 'PATCH 叶子 A effortHours=0.5 → 400 E_WBS_EFFORT_WRITE_DISABLED');
  assert((r.json && r.json.message) === '工时登记已移至工作日志，WBS 不再支持填写工时', 'message 逐字一致', r.json && r.json.message);
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]).effort_hours === null, '拒绝后 A 列仍 NULL（未落库）');

  r = await call('PATCH', '/api/wbs/' + rootId, { effortHours: 999 });
  expectError(r, 'E_WBS_EFFORT_WRITE_DISABLED', 400, 'PATCH 父节点 effortHours=999 → 400 E_WBS_EFFORT_WRITE_DISABLED（叶与父同判）');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [rootId]).effort_hours === null, '拒绝后父列仍 NULL');

  r = await call('POST', '/api/projects/' + pid + '/wbs', {
    parentId: rootId, nodeType: 'task', name: 'X-构造', owner: ADMIN_OPEN_ID, estimateDays: 1, effortHours: 1,
  });
  expectError(r, 'E_WBS_EFFORT_WRITE_DISABLED', 400, 'POST 建节点携带 effortHours → 400 E_WBS_EFFORT_WRITE_DISABLED（create 同判）');

  /* 构造绕过：改名 + effortHours 被拒且 name 不变（同事务） */
  r = await call('PATCH', '/api/wbs/' + rootId, { name: 'R-改名（应被拒）', effortHours: 1 });
  expectError(r, 'E_WBS_EFFORT_WRITE_DISABLED', 400, 'PATCH 构造 payload（改名+effortHours）被拒');
  const rootAfterReject = dbRow('SELECT name, effort_hours FROM wbs_nodes WHERE id = ?', [rootId]);
  assert(rootAfterReject && rootAfterReject.name !== 'R-改名（应被拒）', '拒绝后父节点 name 未变（事务回滚）', rootAfterReject && rootAfterReject.name);

  /* ── R3：日志通道累加（submit）+ 草稿不累加 ─────── */
  console.log('\n── R3 日志提交累加 / 草稿不累加 / 父 Σ 同步 ──');
  const week1 = nextWeek();
  const p1 = reportPayload(week1, [
    { nodeId: leafAId, progressAfter: 100, selected: true, actualDays: 0.5 },
    { nodeId: leafBId, progressAfter: 100, selected: true, actualDays: 2 },
  ]);
  const rep1 = okData(
    await call('POST', '/api/projects/' + pid + '/reports', Object.assign({}, p1, { submit: true })),
    '提交周报 R1（A=0.5、B=2）',
  );
  assert(!!rep1 && rep1.id, 'R1 提交成功返回 id');
  const rowA = (rep1.tasks || []).find((t) => t.nodeId === leafAId);
  const rowB = (rep1.tasks || []).find((t) => t.nodeId === leafBId);
  assert(rowA && rowA.weekActualDays === 0.5, 'R1 出参 task.weekActualDays = 0.5', rowA && rowA.weekActualDays);
  assert(rowB && rowB.weekActualDays === 2, 'R1 出参 task.weekActualDays = 2', rowB && rowB.weekActualDays);

  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]).effort_hours === 0.5, '提交后 A.effort_hours = 0.5（DB 直查）');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafBId]).effort_hours === 2, '提交后 B.effort_hours = 2（DB 直查）');

  const nodes1 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（R1 提交后）');
  assert((nodes1 || []).find((n) => n.id === rootId).effortHours === 2.5, 'R3 父 effortHours = Σ直接子节点（0.5+2=2.5）', (nodes1 || []).find((n) => n.id === rootId).effortHours);
  assert((nodes1 || []).find((n) => n.id === rootId).effortChildCount === 2, 'R3 父 effortChildCount = 2', (nodes1 || []).find((n) => n.id === rootId).effortChildCount);

  /* 草稿：weekActualDays 落库但不累计 */
  const createC = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'C-叶子', owner: ADMIN_OPEN_ID, estimateDays: 1,
    }),
    '根下建叶子 C',
  );
  const leafCId = createC && createC.id;
  const week2 = nextWeek();
  const p2 = reportPayload(week2, [
    { nodeId: leafCId, progressAfter: 50, selected: true, actualDays: 3 },
  ]);
  const rep2 = okData(
    await call('POST', '/api/projects/' + pid + '/reports', Object.assign({}, p2, { submit: false })),
    '存草稿 R2（C=3，submit=false）',
  );
  assert(!!rep2 && rep2.status === '草稿', 'R2 草稿保存成功');
  assert((rep2.tasks || [])[0].weekActualDays === 3, '草稿行 weekActualDays 落库 = 3（不累计但落库）');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafCId]).effort_hours === null, '草稿不累加：C.effort_hours 仍 NULL');
  const nodes2 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（草稿后）');
  assert((nodes2 || []).find((n) => n.id === rootId).effortHours === 2.5, '草稿不累加：父 Σ 仍 2.5', (nodes2 || []).find((n) => n.id === rootId).effortHours);

  /* ── R2/R5：日志通道 actualDays 边界校验 ────────── */
  console.log('\n── R2/R5 actualDays 边界校验（0~100 / ≤2 位小数 / 未勾选 / 父节点）──');
  const weekBad = nextWeek();
  const badCases = [
    { tasks: [{ nodeId: leafCId, progressAfter: 50, selected: true, actualDays: -1 }], label: '负数 -1' },
    { tasks: [{ nodeId: leafCId, progressAfter: 50, selected: true, actualDays: 101 }], label: '超单次上限 101' },
    { tasks: [{ nodeId: leafCId, progressAfter: 50, selected: true, actualDays: 100.001 }], label: '3 位小数 100.001' },
    { tasks: [{ nodeId: leafCId, progressAfter: 50, selected: true, actualDays: 'abc' }], label: '非数字 "abc"' },
    { tasks: [{ nodeId: leafCId, progressAfter: 50, selected: false, actualDays: 1 }], label: '未勾选携带 actualDays' },
    { tasks: [{ nodeId: rootId, progressAfter: 50, selected: true, actualDays: 1 }], label: '父节点携带 actualDays' },
  ];
  for (const c of badCases) {
    r = await call('POST', '/api/projects/' + pid + '/reports', Object.assign({}, reportPayload(weekBad, c.tasks), { submit: true }));
    expectError(r, 'E_VALIDATION', 400, '提交 ' + c.label + ' → 400 E_VALIDATION');
  }
  /* 边界合法：100 与 0.01（≤2 位小数）可提交 */
  const createD = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'D-边界', owner: ADMIN_OPEN_ID, estimateDays: 1,
    }),
    '根下建叶子 D',
  );
  const leafDId = createD && createD.id;
  const weekOk = nextWeek();
  const repOk = okData(
    await call('POST', '/api/projects/' + pid + '/reports', Object.assign({}, reportPayload(weekOk, [
      { nodeId: leafDId, progressAfter: 100, selected: true, actualDays: 100 },
      { nodeId: leafCId, progressAfter: 50, selected: true, actualDays: 0.01 },
    ]), { submit: true })),
    '边界合法提交（D=100、C=0.01）',
  );
  assert(!!repOk, '边界合法提交成功');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafDId]).effort_hours === 100, 'D.effort_hours = 100（单次上限恰好可）');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafCId]).effort_hours === 0.01, 'C.effort_hours = 0.01（2 位小数可）');

  /* ── R4：编辑已提交日志冲正（旧扣新加，同事务） ── */
  console.log('\n── R4 编辑已提交日志冲正（0.5→1.5 净 +1.0 / 回退 / 0.5→0 净 -0.5）──');
  /* 编辑 payload 必须整体回传原始任务行（selected/progressAfter 不变） */
  const editPayload = function (aVal, bVal) {
    return reportPayload(week1, [
      { nodeId: leafAId, progressAfter: 100, selected: true, actualDays: aVal },
      { nodeId: leafBId, progressAfter: 100, selected: true, actualDays: bVal },
    ]);
  };

  r = await call('PATCH', '/api/projects/' + pid + '/reports/' + rep1.id, editPayload(1.5, 2));
  const rep1e1 = okData(r, '编辑 R1：A 0.5 → 1.5');
  assert(rep1e1 && (rep1e1.tasks.find((t) => t.nodeId === leafAId).weekActualDays) === 1.5, '编辑后 R1 行 weekActualDays = 1.5', rep1e1 && rep1e1.tasks.find((t) => t.nodeId === leafAId).weekActualDays);
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]).effort_hours === 1.5, 'R4 A 累计 = 1.5（旧扣 0.5 + 新加 1.5，净 +1.0）');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafBId]).effort_hours === 2, 'R4 B 累计不变 = 2');
  const nodes3 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（冲正后）');
  /* R 直接子 = A(1.5)+B(2)+C(0.01)+D(100) = 103.51（C/D 在边界用例已提交） */
  assert((nodes3 || []).find((n) => n.id === rootId).effortHours === 103.51, 'R4 父 Σ 同步 = A1.5+B2+C0.01+D100 = 103.51', (nodes3 || []).find((n) => n.id === rootId).effortHours);

  r = await call('PATCH', '/api/projects/' + pid + '/reports/' + rep1.id, editPayload(0.5, 2));
  okData(r, '编辑 R1：A 1.5 → 0.5（回退基线）');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]).effort_hours === 0.5, 'R4 回退：A 累计 = 0.5（净 -1.0）');

  r = await call('PATCH', '/api/projects/' + pid + '/reports/' + rep1.id, editPayload(0, 2));
  okData(r, '编辑 R1：A 0.5 → 0');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]).effort_hours === 0, 'R4 A 累计 = 0（0.5→0 净 -0.5）');
  const nodes4 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（A=0）');
  /* R 直接子 = A(0)+B(2)+C(0.01)+D(100) = 102.01 */
  assert((nodes4 || []).find((n) => n.id === rootId).effortHours === 102.01, 'R4 父 Σ 同步 = A0+B2+C0.01+D100 = 102.01', (nodes4 || []).find((n) => n.id === rootId).effortHours);

  /* 编辑草稿不冲正 */
  r = await call('PATCH', '/api/projects/' + pid + '/reports/' + rep2.id, reportPayload(week2, [
    { nodeId: leafCId, progressAfter: 50, selected: true, actualDays: 0 },
  ]));
  okData(r, '编辑草稿 R2（C 3→0）');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafCId]).effort_hours === 0.01, '编辑草稿不冲正：C 累计仍 0.01（草稿从未累计）');

  /* ── R4/R5：冲正致累计<0 → E_VALIDATION 整体回滚 ── */
  console.log('\n── R4/R5 冲正致累计<0 → E_VALIDATION 整体回滚（无半更新）──');
  const createE = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'E-回滚', owner: ADMIN_OPEN_ID, estimateDays: 1,
    }),
    '根下建叶子 E',
  );
  const leafEId = createE && createE.id;
  const week3 = nextWeek();
  const p3 = reportPayload(week3, [
    { nodeId: leafEId, progressAfter: 100, selected: true, actualDays: 2 },
  ]);
  const rep3 = okData(
    await call('POST', '/api/projects/' + pid + '/reports', Object.assign({}, p3, { submit: true })),
    '提交 R3（E=2）',
  );
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafEId]).effort_hours === 2, 'E.effort_hours = 2');

  /* 直写库制造「累计被外部扣减」前置态（模拟未来删除扣减等带外变更） */
  dbExec('UPDATE wbs_nodes SET effort_hours = 1 WHERE id = ?', [leafEId]);
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafEId]).effort_hours === 1, '前置：直写 E.effort_hours = 1');

  const reportsBefore = okData(await call('GET', '/api/projects/' + pid + '/reports'), 'listReports（冲正失败前）');
  const countBefore = (reportsBefore || []).length;
  r = await call('PATCH', '/api/projects/' + pid + '/reports/' + rep3.id, reportPayload(week3, [
    { nodeId: leafEId, progressAfter: 100, selected: true, actualDays: 0 },
  ]));
  expectError(r, 'E_VALIDATION', 400, '冲正致累计<0（1-2=-1）→ 400 E_VALIDATION');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafEId]).effort_hours === 1, '回滚后 E.effort_hours 仍 1（无半更新）');
  const rep3After = okData(await call('GET', '/api/projects/' + pid + '/reports/' + week3), 'GET /reports/:week（冲正失败后）');
  const rep3Row = rep3After && (rep3After.tasks || []).find((t) => t.nodeId === leafEId);
  assert(rep3Row && rep3Row.weekActualDays === 2, '回滚后 R3 旧行 weekActualDays 仍 2（报告未半更新）', rep3Row && rep3Row.weekActualDays);
  const reportsAfter = okData(await call('GET', '/api/projects/' + pid + '/reports'), 'listReports（冲正失败后）');
  assert((reportsAfter || []).length === countBefore, '回滚后无新增/减少报告（事务整体回滚）');

  /* ── R5：累计上限 10000（9999.5+0.5=10000 恰好可；+1 → E_VALIDATION） ── */
  console.log('\n── R5 累计上限 10000（防溢出）──');
  const createF = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'F-上限', owner: ADMIN_OPEN_ID, estimateDays: 1,
    }),
    '根下建叶子 F',
  );
  const leafFId = createF && createF.id;
  dbExec('UPDATE wbs_nodes SET effort_hours = 9999.5 WHERE id = ?', [leafFId]);
  const week4 = nextWeek();
  const rep4 = okData(
    await call('POST', '/api/projects/' + pid + '/reports', Object.assign({}, reportPayload(week4, [
      { nodeId: leafFId, progressAfter: 100, selected: true, actualDays: 0.5 },
    ]), { submit: true })),
    '提交 F=0.5（9999.5+0.5=10000）',
  );
  assert(!!rep4, 'F=0.5 提交成功');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafFId]).effort_hours === 10000, 'F.effort_hours = 10000（恰好等于上限）');

  const reportsBeforeCap = okData(await call('GET', '/api/projects/' + pid + '/reports'), 'listReports（超限前）');
  const countBeforeCap = (reportsBeforeCap || []).length;
  r = await call('POST', '/api/projects/' + pid + '/reports', Object.assign({}, reportPayload(nextWeek(), [
    { nodeId: leafFId, progressAfter: 100, selected: true, actualDays: 1 },
  ]), { submit: true }));
  expectError(r, 'E_VALIDATION', 400, '累计超限（10000+1=10001）→ 400 E_VALIDATION');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafFId]).effort_hours === 10000, '超限后 F 仍 10000（整体回滚）');
  const reportsAfterCap = okData(await call('GET', '/api/projects/' + pid + '/reports'), 'listReports（超限后）');
  assert((reportsAfterCap || []).length === countBeforeCap, '超限后无新增报告（事务整体回滚）');

  /* ── D9/D10：WBS 写操作不触碰 effort_hours ─────── */
  console.log('\n── D9/D10 WBS 写不触碰 effort_hours（新节点 NULL / 有日志叶子值不变 / 成父存储保留）──');
  /* 改名后日志累计值不丢 */
  r = await call('PATCH', '/api/wbs/' + leafAId, { name: 'A-改名' });
  okData(r, 'PATCH A 仅改名');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]).effort_hours === 0, '改名后 A.effort_hours 仍 0（日志累计值不被 WBS 写触碰）');

  /* 叶子成为父 → 存储值保留、展示走 Σ 子；恢复叶子时值重现 */
  const createH = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'H-成父', owner: ADMIN_OPEN_ID, estimateDays: 1,
    }),
    '根下建叶子 H',
  );
  const leafHId = createH && createH.id;
  const week5 = nextWeek();
  okData(
    await call('POST', '/api/projects/' + pid + '/reports', Object.assign({}, reportPayload(week5, [
      { nodeId: leafHId, progressAfter: 100, selected: true, actualDays: 3 },
    ]), { submit: true })),
    '提交 H=3（累计 3）',
  );
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafHId]).effort_hours === 3, 'H.effort_hours = 3（日志累计）');
  const createI = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: leafHId, nodeType: 'subtask', name: 'I-孙', owner: ADMIN_OPEN_ID, estimateDays: 1,
    }),
    'H 下建子 I（H 成为父）',
  );
  const leafIId = createI && createI.id;
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafHId]).effort_hours === 3, 'H 成为父后存储值保留 = 3（不再清 NULL）');
  const nodes5 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（H 成父后）');
  const hNode = (nodes5 || []).find((n) => n.id === leafHId);
  assert(hNode && hNode.effortHours === 0 && hNode.effortChildCount === 1, 'H 展示 Σ 子 = 0（存储 3 不展示，走 Σ 子）', hNode && hNode.effortHours);
  r = await call('DELETE', '/api/wbs/' + leafIId);
  assert(r.json && r.json.code === 0, '删除子 I 成功');
  const nodes6 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（删 I 后）');
  const hNode2 = (nodes6 || []).find((n) => n.id === leafHId);
  assert(hNode2 && hNode2.effortHours === 3, 'H 恢复叶子后值重现 = 3（展示回存储累计值）', hNode2 && hNode2.effortHours);
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafHId]).effort_hours === 3, 'H 恢复叶子后 DB 存储值仍 3');

  /* move 不触碰：把 B（有累计 2）移到 H 下 */
  const rootDbBeforeMove = dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [rootId]).effort_hours;
  r = await call('POST', '/api/wbs/' + leafBId + '/move', { newParentId: leafHId, index: 0 });
  const moveNodes = okData(r, 'move B → H 返回全量数组');
  assert(Array.isArray(moveNodes) && moveNodes.length > 0, 'move 返回整个项目节点数组');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafBId]).effort_hours === 2, 'move 后 B.effort_hours 仍 2（不被触碰）');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafHId]).effort_hours === 3, 'move 后 H.effort_hours 仍 3（新父不被清 NULL）');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [rootId]).effort_hours === rootDbBeforeMove, 'move 后 R.effort_hours 不变（原父不被触碰）');
  const hNode3 = (moveNodes || []).find((n) => n.id === leafHId);
  assert(hNode3 && hNode3.effortHours === 2 && hNode3.effortChildCount === 1, 'H 展示 Σ 子 = B(2) = 2（move 后实时 Σ）', hNode3 && hNode3.effortHours);

  /* 删除 B：B 有日志累计 2 → 删除后 H 恢复叶子、存储值 3 重现；R Σ 相应变化 */
  r = await call('DELETE', '/api/wbs/' + leafBId);
  assert(r.json && r.json.code === 0, '删除 B 成功');
  const nodes7 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（删 B 后）');
  const hNode4 = (nodes7 || []).find((n) => n.id === leafHId);
  assert(hNode4 && hNode4.effortHours === 3 && hNode4.effortChildCount === 0, '删 B 后 H 恢复叶子：展示回存储累计 3（值重现）', hNode4 && hNode4.effortHours);
  const rootNode7 = (nodes7 || []).find((n) => n.id === rootId);
  /* R 直接子 = A(0) + C(0.01) + D(100) + E(1) + F(10000) + H(3) = 10104.01 */
  assert(rootNode7 && rootNode7.effortHours === 10104.01, 'R 最终 Σ = A0+C0.01+D100+E1+F10000+H3 = 10104.01', rootNode7 && rootNode7.effortHours);

  /* R5-6 出参一致性：每节点 effortHours/effortChildCount 数值 + 无 snake_case */
  assert(!!nodes7 && nodes7.every((n) => Number.isFinite(n.effortHours) && Number.isFinite(n.effortChildCount)), 'R5 出参每节点含 effortHours/effortChildCount:number');
  assert(findSnakeCaseKeys(nodes7 || []).length === 0, 'R5 出参无 snake_case 字段', findSnakeCaseKeys(nodes7 || []));

  /* 新建节点列 NULL（最终复查） */
  const createJ = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'J-新建', owner: ADMIN_OPEN_ID, estimateDays: 1,
    }),
    '根下建叶子 J',
  );
  assert(createJ && createJ.id, 'J 创建成功');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [createJ.id]).effort_hours === null, 'D9 新建节点 J.effort_hours = NULL（WBS 写路径不写该列）');

  /* ── 汇总 ────────────────────────────────────────── */
  console.log('\n══════════════════════════════════════');
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  if (failed) {
    console.log('\n失败明细：');
    failures.forEach(function (f) { console.log('  - ' + f); });
    console.log('IS_PASS: NO');
    process.exit(1);
  }
  console.log('IS_PASS: YES');
  process.exit(0);
}

main().catch(function (e) {
  console.error('脚本异常：', e);
  process.exit(1);
});
