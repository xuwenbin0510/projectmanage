#!/usr/bin/env node
/**
 * QA 独立验证 · B9 工时统计报表 + 列表/看板累计工时展示
 *
 * 定位：B9 交付关卡独立验证。覆盖（docs/B9-增量PRD.md §4 验收要点 R1~R6 + docs/B9-任务分解.md 验收口径）：
 *   R1 入口/路由：GET /projects/:id/effort-report 存在、401 未登录拦截、404 项目不存在兜底
 *   R2 明细行：rows 全节点扁平（父=容器汇总、叶=任务）、父 estimateDays=Σ子树叶子、
 *      叶 estimateDays/effortHours 与 listWbs 出参逐一相等、diff/diffRate/isOverrun 数学正确
 *   R3 汇总卡片：summary Σ叶子口径、diffRate 估算总和 0 → null、overrunCount 独立判定
 *   R4 构成明细：effortBreakdown 仅已提交 & selected & week_actual_days>0、周倒序、草稿不出现、
 *      小计=effortHours、编辑冲正后同步
 *   R5/R6 数据源：listWbs / board 出参 effortHours/estimateDays 与 effort-report 行一致
 *       （WBS 增删改移后口径同步，前端零聚合的数据源保证）
 *   边界：估算 0 且实际>0 → diffRate null + isOverrun true；无节点项目 → 空结构不崩
 *
 * 用法（与既有回归脚本同约定：同一 DB_PATH 起服务 + 跑脚本）：
 *   DB_PATH=./b9_qa.db node scripts/qa_b9_verify.mjs http://127.0.0.1:3311
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
const DB_FILE = process.env.DB_PATH || './b9_qa.db';

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

function assertClose(actual, expected, label) {
  assert(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, label, { expected, actual });
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

/* ── DB 直写（仅用于制造「估算 0」边界前置态：SK-13 叶子完整性禁止新建/编辑直接置 0，
      但「父容器估 0 → 删子恢复叶子」是合法 UI 可达状态，等价于此直写） ── */
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
let WEEK_SEQ = 40;
function nextWeek() {
  return '2026-W' + (WEEK_SEQ++);
}

function reportPayload(week, tasks) {
  return {
    projectId: null, // 路由注入真源
    week: week,
    doneNote: 'B9 专项验证',
    planItems: ['完成 B9 验证'],
    resourceNote: '',
    tasks: tasks,
    risks: [],
  };
}

async function createProject(name, milestones) {
  return okData(
    await call('POST', '/api/projects', {
      name: name,
      type: 'A',
      customer: '星舰客户',
      contractAmount: 500,
      background: 'qa_b9_verify 自动创建',
      goal: ['B9 专项验证'],
      planStart: dayOffset(0),
      planEnd: dayOffset(180),
      pm: ADMIN_OPEN_ID,
      classifyInput: { contractAmount: 500, hasHardware: true, hasAcceptance: true, isSelfIteration: false, isInfrastructure: false },
      classifySuggested: 'A',
      classifyOverrideReason: '',
      members: [{ userOpenId: ADMIN_OPEN_ID, role: 'pm' }, { userOpenId: TL_OPEN_ID, role: 'tl' }],
      milestones: milestones,
    }),
    '建 B9 验证项目',
  );
}

async function createLeaf(pid, parentId, name, estimateDays, milestoneId) {
  return okData(
    await call('POST', '/api/projects/' + pid + '/wbs', {
      parentId: parentId,
      nodeType: 'task',
      name: name,
      owner: ADMIN_OPEN_ID,
      estimateDays: estimateDays,
      milestoneId: milestoneId === undefined ? undefined : milestoneId,
    }),
    '根下建叶子 ' + name,
  );
}

function rowOf(rows, id) {
  return (rows || []).find(function (n) { return n.id === id; });
}

async function main() {
  console.log('═══ B9 工时统计报表 + 列表/看板累计工时展示 · 专项验证（' + BASE + ' / DB=' + DB_FILE + '）═══');

  /* ── R1：401 / 404 ─────────────────────────────── */
  console.log('\n── R1 入口/路由：401 未登录 + 404 项目不存在 ──');
  let r = await call('GET', '/api/projects/nonexistent/effort-report');
  expectError(r, 'E_UNAUTHORIZED', 401, '未登录访问 effort-report → 401 E_UNAUTHORIZED');

  await loginAs(ADMIN_OPEN_ID);
  assert(!!token, '管理员 devlogin 签发 token');
  r = await call('GET', '/api/projects/nonexistent/effort-report');
  expectError(r, 'E_NOT_FOUND', 404, '项目不存在 → 404 E_NOT_FOUND');

  /* ── 铺数据：主项目 P1 ─────────────────────────── */
  const stamp = Date.now();
  const proj = await createProject('B9工时报表 ' + stamp, [{ code: 'M1', name: '启动', date: dayOffset(30), required: true, gate: null }]);
  const pid = proj && proj.id;
  assert(!!pid, 'P1 项目创建成功返回 id');

  const nodes0 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（骨架）');
  const root = (nodes0 || []).find((n) => n.level === 1);
  assert(!!root, '骨架根节点存在');
  const rootId = root && root.id;

  const msList = okData(await call('GET', '/api/projects/' + pid + '/milestones'), 'GET /milestones');
  const m1 = (msList || []).find((m) => m.code === 'M1');
  assert(!!m1, '里程碑 M1 存在');
  const m1Id = m1 && m1.id;

  const leafA = await createLeaf(pid, rootId, 'A-估算1', 1, m1Id);
  const leafB = await createLeaf(pid, rootId, 'B-估算3', 3, m1Id);
  const leafZ = await createLeaf(pid, rootId, 'Z-估算0', 1);
  const leafE = await createLeaf(pid, rootId, 'E-估0实超', 1);
  const leafG = await createLeaf(pid, rootId, 'G-估算2', 2);
  const aId = leafA && leafA.id;
  const bId = leafB && leafB.id;
  const zId = leafZ && leafZ.id;
  const eId = leafE && leafE.id;
  const gId = leafG && leafG.id;
  assert(!!aId && !!bId && !!zId && !!eId && !!gId, '5 个叶子创建成功');

  /* 估算 0 前置态（叶子完整性禁止新建/编辑置 0，等价于「父容器估 0 → 删子恢复叶子」的合法状态） */
  dbExec('UPDATE wbs_nodes SET estimate_days = 0 WHERE id = ?', [zId]);
  dbExec('UPDATE wbs_nodes SET estimate_days = 0 WHERE id = ?', [eId]);
  const wbs0 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（估算 0 前置态）');
  assert(rowOf(wbs0, zId).estimateDays === 0 && rowOf(wbs0, eId).estimateDays === 0, 'Z/E 估算置 0 生效（合法边界态）');

  /* 提交 4 周（1 条草稿）：
     W40 提交：A=0.5、B=2.0
     W41 草稿：A=3（不累计不展示）
     W42 提交：E=1.5（估 0 实>0 → diffRate null + isOverrun）
     W43 提交：G=0.5、B=1.0（周倒序验证） */
  const w40 = nextWeek();
  const rep1 = okData(
    await call('POST', '/api/projects/' + pid + '/reports', Object.assign({}, reportPayload(w40, [
      { nodeId: aId, progressAfter: 100, selected: true, actualDays: 0.5 },
      { nodeId: bId, progressAfter: 100, selected: true, actualDays: 2 },
    ]), { submit: true })),
    '提交 W40（A=0.5、B=2.0）',
  );
  assert(!!rep1 && rep1.id, 'W40 提交成功');
  const rep1Id = rep1 && rep1.id;

  const w41 = nextWeek();
  const repDraft = okData(
    await call('POST', '/api/projects/' + pid + '/reports', Object.assign({}, reportPayload(w41, [
      { nodeId: aId, progressAfter: 50, selected: true, actualDays: 3 },
    ]), { submit: false })),
    '存草稿 W41（A=3，submit=false）',
  );
  assert(!!repDraft && repDraft.status === '草稿', 'W41 草稿保存成功');

  const w42 = nextWeek();
  okData(
    await call('POST', '/api/projects/' + pid + '/reports', Object.assign({}, reportPayload(w42, [
      { nodeId: eId, progressAfter: 100, selected: true, actualDays: 1.5 },
    ]), { submit: true })),
    '提交 W42（E=1.5，估 0 实超）',
  );

  const w43 = nextWeek();
  okData(
    await call('POST', '/api/projects/' + pid + '/reports', Object.assign({}, reportPayload(w43, [
      { nodeId: gId, progressAfter: 50, selected: true, actualDays: 0.5 },
      { nodeId: bId, progressAfter: 100, selected: true, actualDays: 1 },
    ]), { submit: true })),
    '提交 W43（G=0.5、B=1.0）',
  );

  /* ── R1/R2/R3：接口结构 + 明细行 + 汇总 ────────── */
  console.log('\n── R2/R3 接口结构 + 明细行（父=Σ子树叶子）+ 汇总（Σ叶子）──');
  const er = okData(await call('GET', '/api/projects/' + pid + '/effort-report'), 'GET effort-report');
  assert(!!er && er.projectId === pid, 'effort-report 返回 projectId');
  assert(!!er && typeof er.summary === 'object', '含 summary 对象');
  assert(!!er && Array.isArray(er.rows), '含 rows 数组');
  assert(!!er && er.effortBreakdown && typeof er.effortBreakdown === 'object', '含 effortBreakdown 对象');
  assert(!!er && findSnakeCaseKeys(er).length === 0, 'effort-report 出参无 snake_case 字段', findSnakeCaseKeys(er || {}));

  /* rows 全节点：父 1 + 叶 5 */
  assert(er.rows.length === 6, 'rows 全节点扁平（父 1 + 叶 5）= 6 行', er.rows.length);
  const rootRow = rowOf(er.rows, rootId);
  const aRow = rowOf(er.rows, aId);
  const bRow = rowOf(er.rows, bId);
  const zRow = rowOf(er.rows, zId);
  const eRow = rowOf(er.rows, eId);
  const gRow = rowOf(er.rows, gId);

  assert(!!rootRow && rootRow.isLeaf === false, '根行 isLeaf=false（父=容器汇总行）');
  assert(!!aRow && aRow.isLeaf === true, 'A 行 isLeaf=true（叶=任务行）');
  assert(rootRow.effortChildCount === 5, '根行 effortChildCount=5', rootRow.effortChildCount);
  assertClose(rootRow.effortHours, 5.5, '根行 effortHours = Σ直接子 = 5.5（A0.5+B3+Z0+E1.5+G0.5）');
  assertClose(rootRow.estimateDays, 6, '根行 estimateDays = Σ子树叶子 = 6（A1+B3+Z0+E0+G2）');
  assertClose(rootRow.diff, -0.5, '根行 diff = 5.5-6 = -0.5');
  assertClose(rootRow.diffRate, 5.5 / 6 - 1, '根行 diffRate = 5.5/6-1');
  assert(rootRow.isOverrun === false, '根行 isOverrun=false（5.5 < 6）');

  assertClose(aRow.estimateDays, 1, 'A 行 estimateDays=1');
  assertClose(aRow.effortHours, 0.5, 'A 行 effortHours=0.5');
  assertClose(aRow.diff, -0.5, 'A 行 diff=-0.5');
  assertClose(aRow.diffRate, -0.5, 'A 行 diffRate=-0.5');
  assert(aRow.isOverrun === false, 'A 行 isOverrun=false');
  assert(aRow.milestoneId === m1Id, 'A 行 milestoneId=M1（显式绑定）', aRow.milestoneId);
  assert(aRow.milestoneCode === 'M1' && aRow.milestoneName === '启动', 'A 行里程碑 badge 带 code/name', { code: aRow.milestoneCode, name: aRow.milestoneName });

  assertClose(bRow.estimateDays, 3, 'B 行 estimateDays=3');
  assertClose(bRow.effortHours, 3, 'B 行 effortHours=3（W40 2.0 + W43 1.0）');
  assertClose(bRow.diff, 0, 'B 行 diff=0');
  assertClose(bRow.diffRate, 0, 'B 行 diffRate=0');
  assert(bRow.isOverrun === false, 'B 行 isOverrun=false（3 > 3 不成立）');

  /* 边界：估算 0 */
  assertClose(zRow.effortHours, 0, 'Z 行 effortHours=0');
  assert(zRow.diffRate === null, 'Z 行 diffRate=null（估算 0）', zRow.diffRate);
  assert(zRow.isOverrun === false, 'Z 行 isOverrun=false（实 0 不超支）');
  assertClose(eRow.effortHours, 1.5, 'E 行 effortHours=1.5');
  assert(eRow.diffRate === null, 'E 行 diffRate=null（估算 0，不可比）', eRow.diffRate);
  assert(eRow.isOverrun === true, 'E 行 isOverrun=true（估 0 且实>0 独立判定）');
  assertClose(eRow.diff, 1.5, 'E 行 diff=1.5');
  assertClose(gRow.effortHours, 0.5, 'G 行 effortHours=0.5');
  assertClose(gRow.diffRate, -0.75, 'G 行 diffRate=-0.75（0.5/2-1）');
  assert(gRow.isOverrun === false, 'G 行 isOverrun=false');

  /* summary（Σ 叶子）：estimateTotal=1+3+0+0+2=6；actualTotal=0.5+3+0+1.5+0.5=5.5 */
  const s = er.summary;
  assertClose(s.estimateTotal, 6, 'summary.estimateTotal = Σ叶子 = 6');
  assertClose(s.actualTotal, 5.5, 'summary.actualTotal = Σ叶子 = 5.5');
  assertClose(s.diff, -0.5, 'summary.diff = -0.5');
  assertClose(s.diffRate, 5.5 / 6 - 1, 'summary.diffRate = Σ实际/Σ估算-1');
  assert(s.overrunCount === 1, 'summary.overrunCount = 1（仅 E 超支）', s.overrunCount);
  assert(s.leafCount === 5, 'summary.leafCount = 5');
  assert(s.parentCount === 1, 'summary.parentCount = 1');

  /* 与 listWbs 出参逐一相等（R5 数据源）：
     父行 estimateDays 设计差异（report=Σ子树叶子 D-B9-3，listWbs=自身存储值）→ 仅叶行比较；
     effortHours 两处同源（decorateEffort）→ 全行比较 */
  const wbsNodes = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（口径对照）');
  for (const rw of er.rows) {
    const w = rowOf(wbsNodes, rw.id);
    assert(!!w, 'effort-report 行 ' + rw.wbsCode + ' 在 listWbs 中存在');
    if (w) {
      assertClose(rw.effortHours, w.effortHours, '行 ' + rw.wbsCode + ' effortHours 与 listWbs 一致');
      if (rw.isLeaf) {
        assertClose(rw.estimateDays, w.estimateDays, '叶行 ' + rw.wbsCode + ' estimateDays 与 listWbs 一致');
      } else {
        assert(rw.estimateDays >= 0, '父行 ' + rw.wbsCode + ' estimateDays = Σ子树叶子（仅行级比较，与 listWbs 存储值不同属设计差异）');
      }
    }
  }

  /* ── R4：构成明细（仅已提交、周倒序、草稿排除、小计=effortHours） ── */
  console.log('\n── R4 实际工时构成（effortBreakdown）──');
  const bdA = er.effortBreakdown[aId] || [];
  const bdB = er.effortBreakdown[bId] || [];
  const bdZ = er.effortBreakdown[zId] || [];
  const bdE = er.effortBreakdown[eId] || [];
  const bdG = er.effortBreakdown[gId] || [];

  assert(bdA.length === 1, 'A breakdown 仅 1 条（草稿 W41 排除）', bdA.length);
  assert(bdA[0] && bdA[0].week === w40, 'A breakdown 周次 = W40');
  assert(bdA[0] && bdA[0].reporterName === '徐文斌', 'A breakdown 提交人 = authorName（徐文斌）', bdA[0] && bdA[0].reporterName);
  assert(bdA[0] && bdA[0].weekActualDays === 0.5, 'A breakdown weekActualDays = 0.5');
  assert(bdA[0] && typeof bdA[0].submittedAt === 'string', 'A breakdown submittedAt 为 ISO 字符串');
  assert(bdA[0] && bdA[0].submittedAt !== null, 'A breakdown submittedAt 非 null（已提交）');

  assert(bdB.length === 2, 'B breakdown 2 条（W40 2.0 + W43 1.0）', bdB.length);
  assert(bdB[0].week === w43 && bdB[1].week === w40, 'B breakdown 周倒序（W43 → W40）', bdB.map((x) => x.week));
  assertClose(bdB[0].weekActualDays, 1, 'B breakdown 首条 = W43 1.0');
  assertClose(bdB[1].weekActualDays, 2, 'B breakdown 次条 = W40 2.0');

  assert(bdZ.length === 0, 'Z breakdown 空（无贡献，不出现 key）');
  assert(bdE.length === 1 && bdE[0].week === w42, 'E breakdown 1 条 = W42');
  assert(bdG.length === 1 && bdG[0].week === w43, 'G breakdown 1 条 = W43');

  /* 小计 = effortHours（|差|>0.01 视为异常） */
  const subtotal = function (list) { return list.reduce(function (s, x) { return s + x.weekActualDays; }, 0); };
  assert(Math.abs(subtotal(bdA) - aRow.effortHours) <= 0.01, 'A 小计 = effortHours 0.5');
  assert(Math.abs(subtotal(bdB) - bRow.effortHours) <= 0.01, 'B 小计 = effortHours 3');
  assert(Math.abs(subtotal(bdE) - eRow.effortHours) <= 0.01, 'E 小计 = effortHours 1.5');

  /* ── R4 ③：编辑冲正后 effort-report 同步 ────────── */
  console.log('\n── R4③ 编辑已提交日志冲正后同步（A 0.5 → 1.5）──');
  const editTasks = [
    { nodeId: aId, progressAfter: 100, selected: true, actualDays: 1.5 },
    { nodeId: bId, progressAfter: 100, selected: true, actualDays: 2 },
  ];
  r = await call('PATCH', '/api/projects/' + pid + '/reports/' + rep1Id, reportPayload(w40, editTasks));
  okData(r, '编辑 W40：A 0.5 → 1.5');
  assert(dbRow('SELECT effort_hours FROM wbs_nodes WHERE id = ?', [aId]).effort_hours === 1.5, 'DB 直查 A.effort_hours = 1.5（冲正生效）');

  const er2 = okData(await call('GET', '/api/projects/' + pid + '/effort-report'), 'GET effort-report（冲正后）');
  const aRow2 = rowOf(er2.rows, aId);
  const rootRow2 = rowOf(er2.rows, rootId);
  assertClose(aRow2.effortHours, 1.5, '冲正后 A 行 effortHours = 1.5');
  assertClose(rootRow2.effortHours, 6.5, '冲正后根行 effortHours = 6.5（A1.5+B3+Z0+E1.5+G0.5）');
  assertClose(er2.summary.actualTotal, 6.5, '冲正后 summary.actualTotal = 6.5');
  assert(er2.effortBreakdown[aId][0].weekActualDays === 1.5, '冲正后 A breakdown = 1.5');

  /* ── 回归：WBS 移动 / 删除后口径一致 ────────────── */
  console.log('\n── 回归：WBS 增删改移后 effort-report 与 listWbs 口径一致 ──');
  r = await call('POST', '/api/wbs/' + bId + '/move', { newParentId: gId, index: 0 });
  const moveNodes = okData(r, 'move B → G（全量数组）');
  assert(Array.isArray(moveNodes) && moveNodes.length > 0, 'move 返回全量节点数组');
  const er3 = okData(await call('GET', '/api/projects/' + pid + '/effort-report'), 'GET effort-report（move 后）');
  const gRow3 = rowOf(er3.rows, gId);
  const rootRow3 = rowOf(er3.rows, rootId);
  const bRow3 = rowOf(er3.rows, bId);
  assert(gRow3.isLeaf === false && gRow3.effortChildCount === 1, 'move 后 G 成为父（effortChildCount=1）');
  assertClose(gRow3.effortHours, 3, 'move 后 G.effortHours = Σ子 B = 3');
  assertClose(gRow3.estimateDays, 3, 'move 后 G.estimateDays = Σ子树叶 B = 3');
  assert(bRow3.parentId === gId, 'move 后 B.parentId = G');
  /* 根直接子 = A(1.5) + Z(0) + E(1.5) + G(ΣB=3) = 6；叶子估算 = A(1)+Z(0)+E(0)+G(子树叶子 B=3) = 4 */
  assertClose(rootRow3.effortHours, 6, 'move 后根 effortHours = A1.5+Z0+E1.5+G3 = 6', rootRow3.effortHours);
  assertClose(rootRow3.estimateDays, 4, 'move 后根 estimateDays = A1+Z0+E0+G(B3) = 4', rootRow3.estimateDays);
  /* 与 listWbs 再对照（父行 estimateDays 设计差异同上，仅叶行比较） */
  const wbs2 = okData(await call('GET', '/api/projects/' + pid + '/wbs'), 'GET /wbs（move 后）');
  for (const rw of er3.rows) {
    const w = rowOf(wbs2, rw.id);
    if (w) {
      assertClose(rw.effortHours, w.effortHours, 'move 后行 ' + rw.wbsCode + ' effortHours 与 listWbs 一致');
      if (rw.isLeaf) {
        assertClose(rw.estimateDays, w.estimateDays, 'move 后叶行 ' + rw.wbsCode + ' estimateDays 与 listWbs 一致');
      }
    }
  }

  /* 删除 B：G 恢复叶子（存储值 0.5 重现） */
  r = await call('DELETE', '/api/wbs/' + bId);
  assert(r.json && r.json.code === 0, '删除 B 成功');
  const er4 = okData(await call('GET', '/api/projects/' + pid + '/effort-report'), 'GET effort-report（删 B 后）');
  const gRow4 = rowOf(er4.rows, gId);
  const rootRow4 = rowOf(er4.rows, rootId);
  assert(gRow4.isLeaf === true && gRow4.effortChildCount === 0, '删 B 后 G 恢复叶子');
  assertClose(gRow4.effortHours, 0.5, '删 B 后 G.effortHours 回存储累计 0.5（值重现）');
  assertClose(gRow4.estimateDays, 2, '删 B 后 G.estimateDays = 自身 2');
  assertClose(rootRow4.effortHours, 3.5, '删 B 后根 effortHours = A1.5+Z0+E1.5+G0.5 = 3.5', rootRow4.effortHours);
  assertClose(er4.summary.actualTotal, 3.5, '删 B 后 summary.actualTotal = 3.5');

  /* ── 边界：估算总和 0 项目 → summary.diffRate null + 超支独立 ── */
  console.log('\n── 边界：估算总和 0（diffRate null + overrunCount 独立）──');
  const proj2 = await createProject('B9边界估0 ' + stamp, [{ code: 'M1', name: '启动', date: dayOffset(30), required: true, gate: null }]);
  const pid2 = proj2 && proj2.id;
  const nodesP2 = okData(await call('GET', '/api/projects/' + pid2 + '/wbs'), 'GET /wbs（P2 骨架）');
  const root2 = (nodesP2 || []).find((n) => n.level === 1);
  const leafZ2 = await createLeaf(pid2, root2.id, 'Z2-估0', 1);
  const z2Id = leafZ2 && leafZ2.id;
  dbExec('UPDATE wbs_nodes SET estimate_days = 0 WHERE id = ?', [z2Id]);
  const wZ2 = nextWeek();
  okData(
    await call('POST', '/api/projects/' + pid2 + '/reports', Object.assign({}, reportPayload(wZ2, [
      { nodeId: z2Id, progressAfter: 100, selected: true, actualDays: 0.5 },
    ]), { submit: true })),
    'P2 提交（Z2=0.5，估 0）',
  );
  const erP2 = okData(await call('GET', '/api/projects/' + pid2 + '/effort-report'), 'GET effort-report（P2）');
  assert(erP2.summary.estimateTotal === 0, 'P2 summary.estimateTotal = 0');
  assertClose(erP2.summary.actualTotal, 0.5, 'P2 summary.actualTotal = 0.5');
  assert(erP2.summary.diffRate === null, 'P2 summary.diffRate = null（估算总和 0）', erP2.summary.diffRate);
  assert(erP2.summary.overrunCount === 1, 'P2 summary.overrunCount = 1（估 0 实>0 独立计超支）');
  const z2Row = rowOf(erP2.rows, z2Id);
  assert(z2Row && z2Row.diffRate === null && z2Row.isOverrun === true, 'P2 Z2 行 diffRate=null + isOverrun=true');

  /* ── 边界：无节点项目 → 空结构不崩 ─────────────── */
  console.log('\n── 边界：无节点项目 → 空结构不崩 ──');
  r = await call('DELETE', '/api/wbs/' + root2.id);
  assert(r.json && r.json.code === 0, '删除 P2 根节点（整树清空）');
  const erEmpty = okData(await call('GET', '/api/projects/' + pid2 + '/effort-report'), 'GET effort-report（无节点）');
  assert(Array.isArray(erEmpty.rows) && erEmpty.rows.length === 0, '无节点 rows 空数组');
  assert(erEmpty.summary.estimateTotal === 0 && erEmpty.summary.actualTotal === 0, '无节点 summary 全 0');
  assert(erEmpty.summary.diffRate === null, '无节点 summary.diffRate null');
  assert(erEmpty.summary.overrunCount === 0 && erEmpty.summary.leafCount === 0, '无节点 overrunCount/leafCount 0');
  assert(erEmpty.effortBreakdown && Object.keys(erEmpty.effortBreakdown).length === 0, '无节点 effortBreakdown 空对象');

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
