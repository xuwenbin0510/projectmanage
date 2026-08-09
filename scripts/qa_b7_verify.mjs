#!/usr/bin/env node
/**
 * QA 独立验证 · B7 工时设置（方案 A 强制汇总）
 *
 * 覆盖（docs/B7-增量PRD.md §4 验收要点 R1~R5 + docs/B7-任务分解.md 验收口径）：
 *   R1 数据模型：migrationV4 幂等 + effort_hours REAL 可空；父节点列恒 NULL（DB 直查）
 *   R2 叶子工时：0.5/整数/0 保存成功并回显；负数/超限/非数字 → 400 E_VALIDATION 不落库
 *   R3 父节点只读汇总：GET 值=Σ直接子节点 + effortChildCount；payload 不带 effortHours（后端拒绝父手填）
 *   R4 服务端强制：给有子节点提交 effortHours → 400 E_WBS_EFFORT_PARENT 不落库
 *   R5 实时重算：改叶子/增删/移动子任务 → 父链 Σ 实时变；写操作返回值带 effortHours/effortChildCount；
 *      失败回滚（E_WBS_LEAF_INCOMPLETE）不产生半更新
 *
 * 用法（与既有回归脚本同约定：同一 DB_PATH 起服务 + 跑脚本）：
 *   DB_PATH=./b7_qa.db node scripts/qa_b7_verify.mjs http://127.0.0.1:3311
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
const DB_FILE = process.env.DB_PATH || './b7_qa.db';

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

/* ── 主流程 ──────────────────────────────────────────── */

async function main() {
  console.log('═══ B7 工时设置 · 专项验证（' + BASE + ' / DB=' + DB_FILE + '）═══');

  await loginAs(ADMIN_OPEN_ID);
  assert(!!token, '管理员 devlogin 签发 token');

  /* ── R1 数据模型（DB 直查） ─────────────────────── */
  console.log('\n── R1 数据模型：migrationV4 幂等 + 列类型 + 父 NULL ──');
  const mig = dbRow('SELECT version, name FROM schema_migrations WHERE version = 4');
  assert(!!mig && mig.name === 'connect-v4-wbs-effort-hours', 'schema_migrations 含 v4 connect-v4-wbs-effort-hours', mig);
  const col = dbRows("PRAGMA table_info(wbs_nodes)").find((c) => c.name === 'effort_hours');
  assert(!!col, 'wbs_nodes 存在 effort_hours 列');
  assert(col && col.type === 'REAL', 'effort_hours 类型 REAL', col && col.type);
  assert(col && col.notnull === 0, 'effort_hours 可空（notnull=0）', col && col.notnull);
  assert(col && (col.dflt_value === null || col.dflt_value === undefined), 'effort_hours 默认 NULL', col && col.dflt_value);

  /* 建项目（1 里程碑 → 骨架根节点 R） */
  const stamp = Date.now();
  const proj = okData(
    await call('POST', '/api/projects', {
      name: 'B7工时验证 ' + stamp,
      type: 'A',
      customer: '星舰客户',
      contractAmount: 500,
      background: 'qa_b7_verify 自动创建',
      goal: ['B7 专项验证'],
      planStart: dayOffset(0),
      planEnd: dayOffset(180),
      pm: ADMIN_OPEN_ID,
      classifyInput: { contractAmount: 500, hasHardware: true, hasAcceptance: true, isSelfIteration: false, isInfrastructure: false },
      classifySuggested: 'A',
      classifyOverrideReason: '',
      members: [{ userOpenId: ADMIN_OPEN_ID, role: 'pm' }, { userOpenId: TL_OPEN_ID, role: 'tl' }],
      milestones: [{ code: 'M1', name: '启动', date: dayOffset(30), required: true, gate: null }],
    }),
    '建 B7 验证项目',
  );
  const pid = proj && proj.id;
  assert(!!pid, '项目创建成功返回 id');

  const nodes0 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（骨架）');
  const root = (nodes0 || []).find((n) => n.level === 1);
  assert(!!root, '骨架根节点存在');
  const rootId = root && root.id;

  const rootDb0 = dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [rootId]);
  assert(rootDb0 && rootDb0.effort_hours === null, 'R1-4 骨架根节点 effort_hours = NULL（列未在骨架 INSERT 中）', rootDb0 && rootDb0.effort_hours);
  assert(!!nodes0 && nodes0.every((n) => Number.isFinite(n.effortHours)), '骨架节点出参均带 effortHours:number');
  assert(!!nodes0 && nodes0.every((n) => Number.isFinite(n.effortChildCount)), '骨架节点出参均带 effortChildCount:number');
  assert(!!nodes0 && findSnakeCaseKeys(nodes0).length === 0, '骨架出参无 snake_case 字段', findSnakeCaseKeys(nodes0 || []));

  /* ── R2 叶子可填（边界 + 双重校验） ──────────────── */
  console.log('\n── R2 叶子工时：0.5/整数/0 + 非法值 400 E_VALIDATION ──');
  const createA = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'A-叶子', owner: ADMIN_OPEN_ID, estimateDays: 1,
    }),
    '根下建叶子 A（不携带 effortHours）',
  );
  const leafAId = createA && createA.id;
  assert(!!leafAId, '叶子 A 创建成功');
  assert(createA && createA.effortHours === 0, 'A 缺省 effortHours 按 0 落库/回显', createA && createA.effortHours);
  assert(createA && createA.effortChildCount === 0, 'A effortChildCount = 0', createA && createA.effortChildCount);

  const dbA0 = dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]);
  assert(dbA0 && dbA0.effort_hours === 0, 'A 缺省落库 effort_hours = 0（显式 0，非 NULL）', dbA0 && dbA0.effort_hours);

  let r = await call('PATCH', '/api/wbs/' + leafAId, { effortHours: 0.5 });
  const a05 = okData(r, 'PATCH A effortHours=0.5');
  assert(a05 && a05.effortHours === 0.5, 'R2 填 0.5 成功回显 0.5', a05 && a05.effortHours);
  assert(a05 && Number.isFinite(a05.effortChildCount), 'update 单节点返回带 effortChildCount（R5-6）');

  r = await call('PATCH', '/api/wbs/' + leafAId, { effortHours: 40 });
  const a40 = okData(r, 'PATCH A effortHours=40');
  assert(a40 && a40.effortHours === 40, 'R2 填整数 40 成功回显 40', a40 && a40.effortHours);

  r = await call('PATCH', '/api/wbs/' + leafAId, { effortHours: 0 });
  const a0 = okData(r, 'PATCH A effortHours=0');
  assert(a0 && a0.effortHours === 0, 'R2 填 0 成功回显 0', a0 && a0.effortHours);
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]).effort_hours === 0, 'A 落库 0');

  r = await call('PATCH', '/api/wbs/' + leafAId, { effortHours: -1 });
  expectError(r, 'E_VALIDATION', 400, 'R2 负数 -1 被拒');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]).effort_hours === 0, 'R2 -1 不落库（仍为 0）');

  r = await call('PATCH', '/api/wbs/' + leafAId, { effortHours: 1001 });
  expectError(r, 'E_VALIDATION', 400, 'R2 超上限 1001 被拒');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]).effort_hours === 0, 'R2 1001 不落库（仍为 0）');

  r = await call('PATCH', '/api/wbs/' + leafAId, { effortHours: 'abc' });
  expectError(r, 'E_VALIDATION', 400, 'R2 非数字 "abc" 被拒');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]).effort_hours === 0, 'R2 "abc" 不落库（仍为 0）');

  r = await call('PATCH', '/api/wbs/' + leafAId, { effortHours: 0.5 });
  okData(r, 'A 恢复 effortHours=0.5（后续用例基线）');

  /* R2-10：改名字不动工时，回显保留 */
  r = await call('PATCH', '/api/wbs/' + leafAId, { name: 'A-叶子（改名）' });
  const aRenamed = okData(r, 'A 仅改名');
  assert(aRenamed && aRenamed.effortHours === 0.5, 'R2-10 改名后回显 effortHours 仍 = 0.5（不丢）', aRenamed && aRenamed.effortHours);

  /* ── R3 父节点只读汇总 + R4 服务端强制 ───────────── */
  console.log('\n── R3 父只读汇总 / R4 服务端强制防绕过 ──');
  const createB = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'B-叶子', owner: ADMIN_OPEN_ID, estimateDays: 1, effortHours: 2.5,
    }),
    '根下建叶子 B（effortHours=2.5）',
  );
  const leafBId = createB && createB.id;
  assert(!!leafBId, '叶子 B 创建成功');

  /* create 带 parentId → 父列清 NULL（R4-3 / R1 父恒 NULL） */
  const rootDbAfterB = dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [rootId]);
  assert(rootDbAfterB && rootDbAfterB.effort_hours === null, 'R4-3 建子后父列 effort_hours = NULL（清 NULL 生效）', rootDbAfterB && rootDbAfterB.effort_hours);

  const nodes1 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（A+B）');
  const root1 = (nodes1 || []).find((n) => n.id === rootId);
  assert(root1 && root1.effortHours === 3, 'R3 父 effortHours = Σ直接子节点（0.5+2.5=3）', root1 && root1.effortHours);
  assert(root1 && root1.effortChildCount === 2, 'R3 effortChildCount = 2', root1 && root1.effortChildCount);
  const aNode1 = (nodes1 || []).find((n) => n.id === leafAId);
  const bNode1 = (nodes1 || []).find((n) => n.id === leafBId);
  assert(aNode1 && aNode1.effortHours === 0.5, '叶 A 出参 = 存储值 0.5', aNode1 && aNode1.effortHours);
  assert(bNode1 && bNode1.effortHours === 2.5, '叶 B 出参 = 存储值 2.5', bNode1 && bNode1.effortHours);

  /* R4：PATCH 父节点带 effortHours → E_WBS_EFFORT_PARENT 不落库 */
  r = await call('PATCH', '/api/wbs/' + rootId, { effortHours: 999 });
  assert(r.status === 400 && r.json && r.json.code === 'E_WBS_EFFORT_PARENT', 'R4-1 父节点 PATCH effortHours=999 → 400 E_WBS_EFFORT_PARENT', { status: r.status, code: r.json && r.json.code });
  assert((r.json && r.json.message) === '有子节点的节点工时由子任务自动汇总，不可手填', 'R4-1 message 逐字一致', r.json && r.json.message);
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [rootId]).effort_hours === null, 'R4-2 拒绝后父列仍 NULL（未落库）');

  /* R4-4 构造绕过：PATCH 父节点同时改名字 + effortHours → 仍拒绝且名字不变（同事务） */
  r = await call('PATCH', '/api/wbs/' + rootId, { name: 'R-改名（应被拒）', effortHours: 1 });
  expectError(r, 'E_WBS_EFFORT_PARENT', 400, 'R4-4 父节点构造 payload（改名+effortHours）被拒');
  const rootAfterReject = dbRow('SELECT name, effort_hours FROM wbs_nodes WHERE id = ?', [rootId]);
  assert(rootAfterReject && rootAfterReject.name !== 'R-改名（应被拒）', 'R4-4 拒绝后父节点 name 未变（事务回滚）', rootAfterReject && rootAfterReject.name);

  /* ── R5 实时重算（同事务）+ 出参 ─────────────────── */
  console.log('\n── R5 实时重算 / 出参 / 回滚 ──');

  /* R5-1 改叶子工时 → 父链 Σ 实时变 */
  r = await call('PATCH', '/api/wbs/' + leafAId, { effortHours: 2.5 });
  okData(r, 'PATCH A effortHours=2.5');
  const nodes2 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（A=2.5）');
  assert((nodes2 || []).find((n) => n.id === rootId).effortHours === 5, 'R5-1 父 effortHours 立即 = 2.5+2.5 = 5', (nodes2 || []).find((n) => n.id === rootId).effortHours);

  /* R5-2 新增子任务 → 父 Σ 实时 + */
  const createC = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'C-叶子', owner: ADMIN_OPEN_ID, estimateDays: 1, effortHours: 3,
    }),
    '根下建叶子 C（effortHours=3）',
  );
  const leafCId = createC && createC.id;
  const nodes3 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（+C）');
  const root3 = (nodes3 || []).find((n) => n.id === rootId);
  assert(root3 && root3.effortHours === 8, 'R5-2 新增子后父 Σ = 5+3 = 8', root3 && root3.effortHours);
  assert(root3 && root3.effortChildCount === 3, 'R5-2 effortChildCount = 3', root3 && root3.effortChildCount);

  /* R5-3 删除子任务 → 父 Σ 实时 - */
  r = await call('DELETE', '/api/wbs/' + leafCId);
  assert(r.json && r.json.code === 0, '删除 C 成功');
  const nodes4 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（-C）');
  const root4 = (nodes4 || []).find((n) => n.id === rootId);
  assert(root4 && root4.effortHours === 5, 'R5-3 删除子后父 Σ = 5（回退）', root4 && root4.effortHours);
  assert(root4 && root4.effortChildCount === 2, 'R5-3 effortChildCount = 2', root4 && root4.effortChildCount);
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [rootId]).effort_hours === null, 'R5-3 删除后父列仍 NULL（delete 清父）');

  /* R5-4 移动：E 下建 F，再把 F 从 E 移到 G */
  const createE = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'E-容器', owner: ADMIN_OPEN_ID, estimateDays: 1, effortHours: 4,
    }),
    '根下建 E（effortHours=4）',
  );
  const eId = createE && createE.id;
  const createF = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: eId, nodeType: 'subtask', name: 'F-孙', owner: ADMIN_OPEN_ID, estimateDays: 1, effortHours: 1,
    }),
    'E 下建 F（effortHours=1）',
  );
  const fId = createF && createF.id;
  assert(!!fId, 'F 创建成功');

  /* F 成为 E 的子 → E 列清 NULL；E 出参 = 1；R = 2.5+2.5+1 = 6 */
  const eDb = dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [eId]);
  assert(eDb && eDb.effort_hours === null, 'E 成为父后列 = NULL（create 清父）', eDb && eDb.effort_hours);
  const nodes5 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（+E/F）');
  const eNode5 = (nodes5 || []).find((n) => n.id === eId);
  const root5 = (nodes5 || []).find((n) => n.id === rootId);
  assert(eNode5 && eNode5.effortHours === 1, '嵌套：E = Σ F = 1（自底向上）', eNode5 && eNode5.effortHours);
  assert(eNode5 && eNode5.effortChildCount === 1, 'E effortChildCount = 1', eNode5 && eNode5.effortChildCount);
  assert(root5 && root5.effortHours === 6, '嵌套：R = 2.5+2.5+1 = 6', root5 && root5.effortHours);

  /* 再建 G 叶子（effortHours=10）→ R = 2.5+2.5+1+10 = 16 */
  const createG = okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: rootId, nodeType: 'task', name: 'G-目标', owner: ADMIN_OPEN_ID, estimateDays: 1, effortHours: 10,
    }),
    '根下建 G（effortHours=10）',
  );
  const gId = createG && createG.id;
  const nodes6 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（+G）');
  assert((nodes6 || []).find((n) => n.id === rootId).effortHours === 16, 'R = 2.5+2.5+1+10 = 16', (nodes6 || []).find((n) => n.id === rootId).effortHours);

  /* move F：E → G。E 失子变叶（列 NULL→展示 0）；G 得子 → 列 NULL、出参 1；R = 2.5+2.5+0+10+1 = 16? 不对：R 的直接子 = A,B,E,G → 2.5+2.5+0+10 = 15（F 移到 G 下，G 是 R 的直接子） */
  r = await call('POST', '/api/wbs/' + fId + '/move', { newParentId: gId, index: 0 });
  const moveNodes = okData(r, 'move F → G 返回全量数组');
  assert(Array.isArray(moveNodes) && moveNodes.length > 0, 'R5-4 move 返回整个项目节点数组');
  const eNode7 = (moveNodes || []).find((n) => n.id === eId);
  const gNode7 = (moveNodes || []).find((n) => n.id === gId);
  const root7 = (moveNodes || []).find((n) => n.id === rootId);
  assert(eNode7 && eNode7.effortHours === 0 && eNode7.effortChildCount === 0, '原父 E 失子后 Σ = 0（列 NULL → 展示 0）', eNode7);
  assert(gNode7 && gNode7.effortHours === 1 && gNode7.effortChildCount === 1, '新父 G 得子后 Σ = 1（G 存储值 10 已被清 NULL，成为父即清）', gNode7);
  /* G 成为父 → 存储值 10 清 NULL，展示 ΣF=1；故 R = A(2.5)+B(2.5)+E(0)+G(1) = 6 */
  assert(root7 && root7.effortHours === 6, 'R = A(2.5)+B(2.5)+E(0)+G(1) = 6', root7 && root7.effortHours);
  const eDb7 = dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [eId]);
  const gDb7 = dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [gId]);
  assert(eDb7 && eDb7.effort_hours === null, 'R5-4 原父 E 列 = NULL（move 清原父）', eDb7 && eDb7.effort_hours);
  assert(gDb7 && gDb7.effort_hours === null, 'R5-4 新父 G 列 = NULL（move 清新父）', gDb7 && gDb7.effort_hours);

  /* R5-5 全项目出参一致性 */
  const listAll = okData(await call('GET', '/api/projects/' + pid + '/wbs'), '最终 GET /wbs');
  const rootFinal = (listAll || []).find((n) => n.id === rootId);
  assert(rootFinal && rootFinal.effortHours === 6 && rootFinal.effortChildCount === 4, 'R5-5 GET 出参 父=Σ直接子节点 且 effortChildCount=直接子数', rootFinal);
  assert((listAll || []).every((n) => Number.isFinite(n.effortHours) && Number.isFinite(n.effortChildCount)), 'R5-5 每节点含 effortHours/effortChildCount:number');
  assert(findSnakeCaseKeys(listAll || []).length === 0, 'R5-5 出参无 snake_case 字段', findSnakeCaseKeys(listAll || []));

  /* R5-6 create/update 单节点返回与 listWbs 口径一致（move 已覆盖全量数组） */
  const dbG = dbRow('SELECT id, effort_hours FROM wbs_nodes WHERE id = ?', [gId]);
  assert(dbG && dbG.effort_hours === null, 'G 作为父节点 DB 列 NULL（最终状态）', dbG && dbG.effort_hours);

  /* 全项目「父节点列恒 NULL」直查 */
  const parents = dbRows(
    "SELECT DISTINCT parent_id FROM wbs_nodes WHERE project_id = ? AND parent_id IS NOT NULL",
    [pid],
  );
  let allParentsNull = true;
  for (const p of parents) {
    const v = dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [p.parent_id]);
    if (v && v.effort_hours !== null) { allParentsNull = false; console.log('   ! 父节点 ' + p.parent_id + ' effort_hours = ' + v.effort_hours); }
  }
  assert(allParentsNull, 'R1 全项目所有父节点 effort_hours 恒 NULL（DB 直查）');

  /* R5-7 失败回滚：叶子 A 同时改工时+清 owner → E_WBS_LEAF_INCOMPLETE，工时不落库 */
  const aBefore = dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]).effort_hours;
  r = await call('PATCH', '/api/wbs/' + leafAId, { effortHours: 7, owner: '' });
  expectError(r, 'E_WBS_LEAF_INCOMPLETE', 400, 'R5-7 叶子缺 owner 触发 E_WBS_LEAF_INCOMPLETE');
  const aAfter = dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [leafAId]).effort_hours;
  assert(aAfter === aBefore, 'R5-7 回滚后 effort_hours 未变（无半更新）', { before: aBefore, after: aAfter });

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
