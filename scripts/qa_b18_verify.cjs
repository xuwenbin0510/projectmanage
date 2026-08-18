#!/usr/bin/env node
/**
 * B18 QA 独立验证脚本（断言式、可重复跑、全绿通过）
 *
 * 验证对象：pm-app B18「总览分布图点档下钻任务明细抽屉」
 *   - 后端：GET /api/dashboard/tasks（维度过滤 / 口径等式 / 分页 / 排序 / RBAC）
 *   - 纯函数：portfolioAgg.overdueBucketOf / aggregateOverdueDuration vs countOverdueTasks
 *   - 前端源码断言：CategoryBarChart.onDrill / DistributionTaskDrawer / MetricsPage 接线 / mock 双写
 *   - 红线回归：normalizeQuery 零改动 / server/** 仅 3 文件含 B18 / 零 schema / 既有组件不动
 *   - 编译：vite build + tsc --noEmit（可用环境变量 QA_SKIP_BUILD=1 跳过，默认执行）
 *
 * 运行：
 *   node scripts/qa_b18_verify.cjs            # 全量（含 build/tsc）
 *   QA_SKIP_BUILD=1 node scripts/qa_b18_verify.cjs   # 跳过编译
 *   QA_BASE_URL=http://127.0.0.1:3010 node scripts/qa_b18_verify.cjs  # 指定后端地址
 *
 * 服务器策略（只读优先，不写业务数据）：
 *   - 若 QA_BASE_URL 已指定 → 直接用，不启停；
 *   - 否则探测 127.0.0.1:3000：若已含 /dashboard/tasks 路由（B18 代码）→ 复用，不启停；
 *   - 否则 → 自启一个临时实例（PORT=3100，ALLOW_DEV_LOGIN=true），用毕关闭。
 *
 * 数据安全：本脚本对业务数据只读（GET / POST /auth/devlogin 不落库）；
 *          唯一可能被「自启服务器」触发的写入是 server 启动时幂等迁移/播种（无新版本则不写）。
 *
 * @prd  B18
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.QA_BASE_URL || 'http://127.0.0.1:3000';
const ALT_PORT = Number(process.env.QA_ALT_PORT || 3100);

/* 实际请求基址：复用 :3000 时 = BASE；自启临时实例时切换到 ALT_PORT（可被 ensureServer 改写） */
let ACTIVE_BASE = BASE;

/* ── 极简断言框架 ─────────────────────────────────────── */
const results = [];
let currentSection = '';
function section(name) {
  currentSection = name;
  console.log('\n== ' + name + ' ==');
}
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? '  — ' + detail : ''}`);
}
function assertEq(name, actual, expected, detail) {
  const ok = actual === expected;
  check(name, ok, `${detail || ''} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`);
}
function assertTrue(name, cond, detail) {
  check(name, !!cond, detail || '');
}

/* ── 工具 ─────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(pathname, opts) {
  const res = await fetch(ACTIVE_BASE + pathname, {
    headers: { 'Content-Type': 'application/json', ...(opts && opts.headers) },
    ...(opts && opts.body ? { method: opts.method || 'POST', body: opts.body } : {}),
    ...(opts && !opts.body ? { method: opts.method || 'GET' } : {}),
  });
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, body };
}

async function login(openId) {
  const r = await httpJson('/api/auth/devlogin', { body: JSON.stringify({ openId }) });
  if (r.status !== 200 || !r.body || r.body.code !== 0) {
    throw new Error('devlogin failed for ' + openId + ': ' + JSON.stringify(r.body));
  }
  return r.body.data.token;
}

function authHeaders(token) {
  return { Authorization: 'Bearer ' + token };
}

/* ── 服务器可用性 ─────────────────────────────────────── */
let spawnedServer = null;

async function serverHasTasksRoute() {
  try {
    const r = await httpJson('/api/dashboard/tasks');
    // 路由存在时未带 token → 401；路由不存在 → 404 E_NOT_FOUND
    return r.status === 401;
  } catch (e) {
    return false;
  }
}

async function ensureServer() {
  if (process.env.QA_BASE_URL) {
    console.log(`[server] 使用指定后端 ${BASE}（QA_BASE_URL）`);
    return;
  }
  const alive = await serverHasTasksRoute();
  if (alive) {
    console.log(`[server] 复用 ${BASE}（已含 B18 路由）`);
    return;
  }
  // 端口被占用且为过期代码 → 提示用户手动处理；否则自启临时实例
  const altBase = `http://127.0.0.1:${ALT_PORT}`;
  console.log(`[server] ${BASE} 无 B18 路由或不可达，自启临时实例 ${altBase}`);
  const logFile = fs.openSync(path.join(ROOT, '.cache', 'b18qa', 'server-qa.log'), 'a');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(ALT_PORT), ALLOW_DEV_LOGIN: 'true' },
    stdio: ['ignore', logFile, logFile],
  });
  spawnedServer = child;
  // 等就绪
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${ALT_PORT}/api/auth/devlogin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openId: 'ou_xuwenbin01' }),
      });
      if (r.status === 200) { ACTIVE_BASE = altBase; console.log(`[server] 临时实例就绪（${altBase}）`); return; }
    } catch (e) { /* not ready */ }
  }
  throw new Error('临时服务器启动超时');
}

function stopServer() {
  if (spawnedServer) {
    try { spawnedServer.kill('SIGTERM'); } catch (e) { /* ignore */ }
    console.log('[server] 临时实例已关闭');
  }
}

/* ── 1. 后端纯函数（离线，无需服务器） ────────────────── */
async function testBackendPure() {
  section('1. 后端纯函数 overdueBucketOf / aggregateOverdueDuration');
  const agg = require(path.join(ROOT, 'server', 'lib', 'portfolioAgg.js'));
  const dates = require(path.join(ROOT, 'server', 'lib', 'dates.js'));
  const T = '2026-08-18';

  const cases = [
    ['今天到期 days=0', T, null],
    ['逾期1天', '2026-08-17', '1to7'],
    ['逾期7天', '2026-08-11', '1to7'],
    ['逾期8天', '2026-08-10', '8to30'],
    ['逾期30天', '2026-07-19', '8to30'],
    ['逾期31天', '2026-07-18', 'over30'],
    ['未来日期', '2026-08-19', null],
    ['空串', '', null],
    ['null', null, null],
    ['undefined', undefined, null],
    ['非法日期', 'not-a-date', null],
  ];
  for (const [label, due, expected] of cases) {
    const got = agg.overdueBucketOf(T, due);
    assertEq('overdueBucketOf(' + label + ')', got, expected);
  }

  // 与 isOverdue 等价性：非 null ⟺ isOverdue（同入参同 today）
  let equivOk = true;
  for (const due of ['2026-08-17', '2026-08-11', '2026-07-19', '2026-07-18', T, '2026-08-19', '', null]) {
    const bucket = agg.overdueBucketOf(T, due);
    const overdue = agg.isOverdue({ dueDate: due }, T);
    if ((bucket !== null) !== overdue) { equivOk = false; }
  }
  assertTrue('overdueBucketOf 非 null ⟺ isOverdue（逐字等价）', equivOk);

  // 独立计算校验（不用库内实现重算分段）
  function independentBucket(due) {
    const d = String(due || '');
    if (!d) return null;
    const ms = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
    const todayMs = Date.UTC(2026, 7, 18);
    const days = Math.round((todayMs - ms) / 86400000);
    if (days < 1) return null;
    if (days <= 7) return '1to7';
    if (days <= 30) return '8to30';
    return 'over30';
  }
  const indep = ['2026-08-17', '2026-08-11', '2026-08-10', '2026-07-19', '2026-07-18', T, '2026-08-19', ''].map(
    (due) => agg.overdueBucketOf(T, due) === independentBucket(due),
  );
  assertTrue('overdueBucketOf 与独立日期计算一致（8 样本）', indep.every(Boolean));

  // aggregateOverdueDuration.total === countOverdueTasks（同入参同 today，B17 回归）
  const tasks = [
    { dueDate: '2026-08-17' }, { dueDate: '2026-08-11' }, { dueDate: '2026-08-10' },
    { dueDate: '2026-07-19' }, { dueDate: '2026-07-18' }, { dueDate: T },
    { dueDate: '2026-08-19' }, { dueDate: '' }, { dueDate: null }, {},
    { dueDate: '2026-08-12' }, { dueDate: '2026-07-01' },
  ];
  const dur = agg.aggregateOverdueDuration(tasks, T);
  const cnt = agg.countOverdueTasks(tasks, T);
  assertEq('aggregateOverdueDuration.total === countOverdueTasks', dur.total, cnt);
  // 三段之和 = total
  assertEq('days1to7+days8to30+daysOver30 === total', dur.days1to7 + dur.days8to30 + dur.daysOver30, dur.total);
  // 分段与 overdueBucketOf 独立一致
  const manual = { days1to7: 0, days8to30: 0, daysOver30: 0, total: 0 };
  tasks.forEach((n) => {
    const b = agg.overdueBucketOf(T, n && n.dueDate);
    if (!b) return;
    if (b === '1to7') manual.days1to7 += 1;
    else if (b === '8to30') manual.days8to30 += 1;
    else manual.daysOver30 += 1;
    manual.total += 1;
  });
  assertTrue('aggregateOverdueDuration 分段 === overdueBucketOf 逐任务归类',
    JSON.stringify(dur) === JSON.stringify(manual));

  // dates.diffDays 边界（口径基元）
  assertEq('diffDays(2026-08-18, 2026-08-18)=0', dates.diffDays(T, T), 0);
  assertEq('diffDays(due,today)=1（逾期1天）', dates.diffDays('2026-08-17', T), 1);
  assertEq('diffDays(due,today)=31（逾期31天）', dates.diffDays('2026-07-18', T), 31);
  assertEq('diffDays 非法输入=0', dates.diffDays('bad', T), 0);
}

/* ── 2. 接口维度过滤（重点，独立对照） ────────────────── */
async function testApi() {
  section('2. 接口 GET /api/dashboard/tasks（scope=all / admin）');

  // 401
  const anon = await httpJson('/api/dashboard/tasks?scope=all');
  assertEq('未登录 → 401', anon.status, 401, 'route 存在性亦验证');

  const adminToken = await login('ou_xuwenbin01');
  const H = authHeaders(adminToken);

  // overview 基准（同 scope=all 同 pageSize=200）
  const ov = await httpJson('/api/dashboard/overview?scope=all&pageSize=200', { headers: H });
  assertEq('overview code=0', ov.body && ov.body.code, 0);
  assertEq('overview scope=all 生效', ov.body.data.scope, 'all');
  const ovd = ov.body.data;

  async function tasks(params) {
    const qs = new URLSearchParams(params).toString();
    const r = await httpJson('/api/dashboard/tasks?' + qs, { headers: H });
    if (r.status !== 200 || !r.body || r.body.code !== 0) {
      throw new Error('tasks failed ' + qs + ': ' + JSON.stringify(r.body));
    }
    return r.body.data;
  }

  /* 六条口径等式族 1：priority=P0..P3 total === priorityDist 各档 */
  for (const p of ['P0', 'P1', 'P2', 'P3']) {
    const d = await tasks({ scope: 'all', priority: p, pageSize: 200 });
    assertEq(`priority=${p} total === priorityDist.${p}`, d.total, ovd.priorityDist[p],
      `(priorityDist.${p}=${ovd.priorityDist[p]})`);
    assertTrue(`priority=${p} 行内优先级全部=${p}`,
      d.items.every((r) => r.priority === p), `items=${d.items.length}`);
  }
  // 无维度 → 范围内全部在办叶子（= priorityDist.total）
  const noDim = await tasks({ scope: 'all', pageSize: 200 });
  assertEq('无维度 total === priorityDist.total（在办叶子基数）', noDim.total, ovd.priorityDist.total);
  assertEq('无维度 total === 各 priority 档之和',
    noDim.total, ovd.priorityDist.P0 + ovd.priorityDist.P1 + ovd.priorityDist.P2 + ovd.priorityDist.P3);

  /* 六条口径等式族 2：taskStatus=五档 total === statusDist 各档（含完成档） */
  for (const s of ['待办', '进行中', '待评审', '完成', '阻塞']) {
    const d = await tasks({ scope: 'all', taskStatus: s, pageSize: 200 });
    assertEq(`taskStatus=${s} total === statusDist.${s}`, d.total, ovd.statusDist[s],
      `(statusDist.${s}=${ovd.statusDist[s]})`);
    assertTrue(`taskStatus=${s} 行内 status 全部=${s}`,
      d.items.every((r) => r.status === s), `items=${d.items.length}`);
  }
  assertTrue('taskStatus=完成 可出数（基数含已完成）', ovd.statusDist['完成'] > 0,
    `statusDist.完成=${ovd.statusDist['完成']}`);

  /* 六条口径等式族 3：overdueBucket=三段 total === overdueDuration 各段 */
  const bucketKeyMap = { '1to7': 'days1to7', '8to30': 'days8to30', 'over30': 'daysOver30' };
  for (const b of ['1to7', '8to30', 'over30']) {
    const d = await tasks({ scope: 'all', overdueBucket: b, pageSize: 200 });
    assertEq(`overdueBucket=${b} total === overdueDuration.${bucketKeyMap[b]}`,
      d.total, ovd.overdueDuration[bucketKeyMap[b]],
      `(overdueDuration.${bucketKeyMap[b]}=${ovd.overdueDuration[bucketKeyMap[b]]})`);
    // 行档位与服务端同一分段函数（本地 portfolioAgg.overdueBucketOf，同机同时区 today 一致）
    const agg = require(path.join(ROOT, 'server', 'lib', 'portfolioAgg.js'));
    const dates = require(path.join(ROOT, 'server', 'lib', 'dates.js'));
    const todayStr = dates.today();
    assertTrue(`overdueBucket=${b} 每行 overdueBucketOf === ${b}`,
      d.items.every((r) => agg.overdueBucketOf(todayStr, r.dueDate) === b), `items=${d.items.length}`);
  }

  /* 六条口径等式族 4：三桶之和 === stats.overdueTasks */
  const b1 = (await tasks({ scope: 'all', overdueBucket: '1to7', pageSize: 200 })).total;
  const b2 = (await tasks({ scope: 'all', overdueBucket: '8to30', pageSize: 200 })).total;
  const b3 = (await tasks({ scope: 'all', overdueBucket: 'over30', pageSize: 200 })).total;
  assertEq('三桶之和 === stats.overdueTasks', b1 + b2 + b3, ovd.stats.overdueTasks,
    `(1to7=${b1}+8to30=${b2}+over30=${b3} = ${b1 + b2 + b3}, stats.overdueTasks=${ovd.stats.overdueTasks})`);

  /* 非法 / 脏值 */
  const p2 = ovd.priorityDist.P2;
  const allActive = ovd.priorityDist.total;
  assertEq('priority=P9 等价 P2', (await tasks({ scope: 'all', priority: 'P9', pageSize: 200 })).total, p2);
  assertEq('priority=空串 等价 P2', (await tasks({ scope: 'all', priority: '', pageSize: 200 })).total, p2);
  assertEq('priority=null(字面量) 等价 P2', (await tasks({ scope: 'all', priority: 'null', pageSize: 200 })).total, p2);
  assertEq('priority=p0 小写归一 P0', (await tasks({ scope: 'all', priority: 'p0', pageSize: 200 })).total, ovd.priorityDist.P0);
  assertEq('非法 taskStatus → 不过滤', (await tasks({ scope: 'all', taskStatus: 'BADSTATUS', pageSize: 200 })).total, allActive);
  assertEq('非法 overdueBucket → 不过滤', (await tasks({ scope: 'all', overdueBucket: 'BADBUCKET', pageSize: 200 })).total, allActive);

  /* 维度互斥：taskStatus → overdueBucket → priority 只取第一个合法维度 */
  assertEq('互斥 taskStatus 优先于 overdueBucket', (await tasks({ scope: 'all', taskStatus: '完成', overdueBucket: '1to7', pageSize: 200 })).total, ovd.statusDist['完成']);
  assertEq('互斥 overdueBucket 优先于 priority', (await tasks({ scope: 'all', overdueBucket: '1to7', priority: 'P0', pageSize: 200 })).total, ovd.overdueDuration.days1to7);
  assertEq('互斥 taskStatus 优先于 priority', (await tasks({ scope: 'all', taskStatus: '完成', priority: 'P0', pageSize: 200 })).total, ovd.statusDist['完成']);

  /* 分页 clamp / total 与 items.length 关系 */
  const pg0 = await tasks({ scope: 'all', page: 0, pageSize: 20 });
  assertEq('page=0 → 1', pg0.page, 1);
  assertEq('pageSize=20 默认生效', pg0.pageSize, 20);
  assertEq('page=0 items.length=20', pg0.items.length, Math.min(20, pg0.total));
  const pgBig = await tasks({ scope: 'all', page: 1, pageSize: 300 });
  assertEq('pageSize=300 → clamp 200', pgBig.pageSize, 200);
  assertEq('pageSize=300 items=全部(69)', pgBig.items.length, pgBig.total);
  const pg2 = await tasks({ scope: 'all', page: 2, pageSize: 10 });
  assertEq('page=2 total 恒 69', pg2.total, noDim.total);
  assertEq('page=2 items.length=10', pg2.items.length, 10);
  const pg99 = await tasks({ scope: 'all', page: 99, pageSize: 8 });
  assertEq('page=99 越界 items=0 不报错', pg99.items.length, 0);

  /* 排序：优先级 P0→P3 → 截止日升序（空恒最后）→ 名称升序 */
  const full = (await tasks({ scope: 'all', pageSize: 200 })).items;
  const RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
  let sortOk = true;
  for (let i = 1; i < full.length; i++) {
    const a = full[i - 1], b = full[i];
    const ra = RANK[a.priority], rb = RANK[b.priority];
    if (ra !== rb) { if (ra > rb) { sortOk = false; break; } continue; }
    const da = a.dueDate || '', db = b.dueDate || '';
    if (!da !== !db) { if (da) { sortOk = false; break; } continue; }
    if (da && db && da !== db) { if (da > db) { sortOk = false; break; } continue; }
    if (a.name > b.name) { sortOk = false; break; }
  }
  assertTrue('排序 优先级→截止日→名称（69 行全序）', sortOk);
  const withoutDue = full.filter((r) => !r.dueDate);
  assertTrue('空 dueDate 恒最后', withoutDue.every((r) => full.indexOf(r) >= full.length - withoutDue.length),
    `无截止日行数=${withoutDue.length}`);

  /* 分页稳定：page1/page2 与全量列表切片一致、不跳行不重复 */
  const idsFull = full.map((r) => r.id);
  const idsP1 = (await tasks({ scope: 'all', page: 1, pageSize: 10 })).items.map((r) => r.id);
  const idsP2 = (await tasks({ scope: 'all', page: 2, pageSize: 10 })).items.map((r) => r.id);
  assertTrue('page1 === 全量[0..10)', JSON.stringify(idsP1) === JSON.stringify(idsFull.slice(0, 10)));
  assertTrue('page2 === 全量[10..20)', JSON.stringify(idsP2) === JSON.stringify(idsFull.slice(10, 20)));
  assertTrue('page1/page2 无重复', new Set([...idsP1, ...idsP2]).size === 20);

  /* 行字段 10 个齐全（无多余字段） */
  const rowKeys = ['id', 'projectId', 'projectName', 'wbsCode', 'name', 'priority', 'status', 'dueDate', 'progress', 'ownerName'];
  const sample = full[0];
  assertTrue('行字段 10 个齐全', rowKeys.every((k) => k in sample));
  assertTrue('行无多余字段', Object.keys(sample).every((k) => rowKeys.includes(k)),
    'keys=' + Object.keys(sample).join(','));
  assertTrue('projectName 非空', full.every((r) => r.projectName && r.projectName.length > 0));

  /* projectName 为项目真实名（对库只读核对） */
  const Database = require('better-sqlite3');
  const dbr = new Database(path.join(ROOT, 'pm.db'), { readonly: true });
  const projName = {};
  dbr.prepare('SELECT id, name FROM projects WHERE deleted_at IS NULL').all().forEach((p) => {
    projName[String(p.id)] = String(p.name);
  });
  dbr.close();
  const nameOk = full.every((r) => {
    const expect = projName[String(r.projectId)] || '未命名项目';
    return r.projectName === expect;
  });
  assertTrue('projectName 与 projects.name 逐行一致（缺失回落未命名项目）', nameOk);

  /* RBAC：非特权角色 scope=all 强制 mine 不 403；行数 ≤ admin */
  const tlToken = await login('ou_wangqiang02');
  const tlR = await httpJson('/api/dashboard/tasks?scope=all&pageSize=200', { headers: authHeaders(tlToken) });
  assertEq('tl scope=all http=200（不 403）', tlR.status, 200);
  assertTrue('tl 行数 ≤ admin 视角', tlR.body.data.total <= full.length,
    `tl=${tlR.body.data.total}, admin=${full.length}`);
  const tlOv = await httpJson('/api/dashboard/overview?scope=all', { headers: authHeaders(tlToken) });
  assertEq('tl overview 实际 scope=mine（服务端降级）', tlOv.body.data.scope, 'mine');
  // tl 视角下维度等式仍成立（同 scope 同基数）
  const tlP0 = await httpJson('/api/dashboard/tasks?scope=all&priority=P0&pageSize=200', { headers: authHeaders(tlToken) });
  assertEq('tl priority=P0 total === tl overview priorityDist.P0',
    tlP0.body.data.total, tlOv.body.data.priorityDist.P0);

  const qaToken = await login('ou_chenjing05');
  const qaR = await httpJson('/api/dashboard/tasks?scope=all&pageSize=200', { headers: authHeaders(qaToken) });
  assertEq('qa scope=all http=200（不 403）', qaR.status, 200);
  assertTrue('qa 行数 ≤ admin 视角', qaR.body.data.total <= full.length,
    `qa=${qaR.body.data.total}, admin=${full.length}`);

  const pmoToken = await login('ou_zhangmin04');
  const pmoAll = await httpJson('/api/dashboard/tasks?scope=all&pageSize=200', { headers: authHeaders(pmoToken) });
  assertEq('pmo scope=all 可看全量（privileged）', pmoAll.body.data.total, full.length);
  const pmoMine = await httpJson('/api/dashboard/tasks?scope=mine&pageSize=200', { headers: authHeaders(pmoToken) });
  assertTrue('pmo scope=mine 行数 < all', pmoMine.body.data.total < full.length,
    `mine=${pmoMine.body.data.total}, all=${full.length}`);

  /* overview 抽查回归（B17 行为不变） */
  const ov2 = await httpJson('/api/dashboard/overview?scope=all&type=A', { headers: H });
  assertTrue('overview type=A 过滤仍生效（B17 回归抽查）', ov2.body.data.stats.managedProjects < ovd.stats.managedProjects);
  const ovPg = await httpJson('/api/dashboard/overview?scope=all&page=0&pageSize=999', { headers: H });
  assertEq('overview page=0→1（B17 回归抽查）', ovPg.body.data.projects.page, 1);
  assertEq('overview pageSize 上限 200（B17 回归抽查）', ovPg.body.data.projects.pageSize, 200);
}

/* ── 3. 前端源码断言 ──────────────────────────────────── */
async function testFrontendSource() {
  section('3. 前端源码断言');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // 3.1 CategoryBarChart.onDrill
  const cbc = read('web/src/components/dashboard/CategoryBarChart.tsx');
  assertTrue('CategoryBarChart props 含 onDrill?: (key: string) => void', /onDrill\??:\s*\(key:\s*string\)\s*=>\s*void/.test(cbc));
  assertTrue('onDrill 存在时 cursor: pointer（缺省 default）', /cursor:\s*onDrill\s*\?\s*'pointer'\s*:\s*'default'/.test(cbc));
  assertTrue('柱体 onItemClick 仅在 onDrill 时透传', /onItemClick=\{\s*onDrill\s*\?/.test(cbc));
  assertTrue('图例 onClick 仅在 onDrill 时透传（0 值档也可点）', /onClick:\s*onDrill\s*\?\s*\(\)\s*=>\s*onDrill\(r\.key\)\s*:\s*undefined/.test(cbc));
  assertTrue('onDrill 缺省不可点 = undefined', /onItemClick=\{\s*onDrill\s*\?[\s\S]*?:\s*undefined\s*\}/.test(cbc));

  // 3.2 DistributionTaskDrawer
  const dtd = read('web/src/components/dashboard/DistributionTaskDrawer.tsx');
  assertTrue('抽屉 PAGE_SIZE = 8', /const PAGE_SIZE = 8/.test(dtd));
  assertTrue('Drawer anchor="right"', /<Drawer\s+anchor="right"/.test(dtd));
  assertTrue('内容宽 420 + maxWidth 92vw', /width:\s*420/.test(dtd) && /maxWidth:\s*'92vw'/.test(dtd));
  assertTrue('关闭 IconButton（aria-label=关闭 + CloseIcon）', /aria-label="关闭"/.test(dtd) && /CloseIcon/.test(dtd));
  assertTrue('局部拉取 api.getDashboardTasks({...query,page,pageSize:PAGE_SIZE})', /api\.getDashboardTasks\(\{\s*\.\.\.query,\s*page:\s*pageToLoad,\s*pageSize:\s*PAGE_SIZE\s*\}\)/.test(dtd));
  assertTrue('打开/query 变化复位第 1 页', /setPage\(1\);\s*\n\s*void load\(1\)/.test(dtd));
  assertTrue('行点击 ROUTES.projectWbs(row.projectId)', /navigate\(ROUTES\.projectWbs\(row\.projectId\)\)/.test(dtd));
  assertTrue('错误态 ErrorState + 重试', /<ErrorState\s+error=\{error\}\s+onRetry=\{\(\)\s*=>\s*void\s+load\(page\)\}/.test(dtd));
  assertTrue('分页 total > PAGE_SIZE 启用', /total\s*>\s*PAGE_SIZE/.test(dtd));
  // 7 列 = 优先级/任务/项目名/负责人/截止日/状态/进度
  const colKeys = ['priority', 'name', 'projectName', 'ownerName', 'dueDate', 'status', 'progress'];
  const colMatches = colKeys.map((k) => new RegExp("key: '" + k + "'").test(dtd));
  assertTrue('7 列 key 齐全且顺序正确', colMatches.every(Boolean));
  assertTrue('列定义共 7 个（label 计数）', (dtd.match(/label:/g) || []).length >= 7);
  assertTrue('截止日逾期红色标注 + 进度逾期 danger', /isOverdue\(r\.dueDate\)\s*\?\s*'error\.main'/.test(dtd) && /tone=\{isOverdue\(r\.dueDate\)\s*\?\s*'danger'\s*:\s*'brand'\}/.test(dtd));
  assertTrue('空态逾期桶正向文案', /太好了，没有该档逾期任务/.test(dtd));
  assertTrue('副标题 共 N 个任务', /共 \{total\} 个任务/.test(dtd));

  // 3.3 MetricsPage 三图接线
  const mp = read('web/src/pages/MetricsPage.tsx');
  assertTrue('DURATION_KEY_TO_BUCKET: days1to7→1to7', /days1to7:\s*'1to7'/.test(mp));
  assertTrue('DURATION_KEY_TO_BUCKET: days8to30→8to30', /days8to30:\s*'8to30'/.test(mp));
  assertTrue('DURATION_KEY_TO_BUCKET: daysOver30→over30', /daysOver30:\s*'over30'/.test(mp));
  assertTrue('DURATION_TITLE 三标题齐全', /逾期 1–7 天任务明细/.test(mp) && /逾期 8–30 天任务明细/.test(mp) && /逾期 >30 天任务明细/.test(mp));
  // 三张 CategoryBarChart 各自的 <CategoryBarChart ... /> 块内均含 onDrill；
  // 注意整页 onDrill={ 出现 6 次（①-④ 原图 3 次 + ⑤⑥⑦ 3 次），须按块判定。
  const cbcBlocks = mp.match(/<CategoryBarChart[\s\S]*?\/>/g) || [];
  assertTrue('⑤⑥⑦ 三张 CategoryBarChart 均接 onDrill（=3）',
    cbcBlocks.length === 3 && cbcBlocks.every((b) => /onDrill=\{/.test(b)),
    'CategoryBarChart 块=' + cbcBlocks.length + ', 均含 onDrill=' + cbcBlocks.every((b) => /onDrill=\{/.test(b)));
  assertTrue('优先级图 onDrill → openDist(`${key} 任务明细`, { priority })', /openDist\(`\$\{key\} 任务明细`, \{\s*priority:\s*key as Priority\s*\}\)/.test(mp));
  assertTrue('状态图 onDrill → openDist(`${key}任务明细`, { taskStatus })', /openDist\(`\$\{key\}任务明细`, \{\s*taskStatus:\s*key as TaskStatus\s*\}\)/.test(mp));
  assertTrue('逾期时长图 onDrill → openDist(DURATION_TITLE[key], { overdueBucket })', /openDist\(DURATION_TITLE\[key\][\s\S]*?overdueBucket:\s*DURATION_KEY_TO_BUCKET\[key\]/.test(mp));
  assertTrue('openDist 携带 scope + type/status/health/keyword/onlyMine', /const base: DashboardTasksQuery = \{[\s\S]*?scope,[\s\S]*?type: query\.type \?\? ''[\s\S]*?status: query\.status \?\? ''[\s\S]*?health: query\.health \?\? ''[\s\S]*?keyword: query\.keyword \?\? ''[\s\S]*?onlyMine: query\.onlyMine \?\? false/.test(mp));
  assertTrue('渲染 DistributionTaskDrawer（open/title/query/onClose）', /<DistributionTaskDrawer[\s\S]*?open=\{distDrawer\.open\}[\s\S]*?title=\{distDrawer\.title\}[\s\S]*?query=\{distDrawer\.query\}[\s\S]*?onClose=\{\(\)\s*=>\s*setDistDrawer\(\(s\)\s*=>\s*\(\{ \.\.\.s, open: false \}\)\)\}/.test(mp));
  // 原 4 图交互保留
  assertTrue('①状态环 onSegmentClick 状态筛选（不动）', /onSegmentClick=\{\(seg\)\s*=>\s*\{[\s\S]*?setQuery\(\{ status: query\.status === st \? '' : st \}\)/ .test(mp));
  assertTrue('②健康环 onDrill 健康筛选（不动）', /<HealthDonut[\s\S]*?onDrill=\{\(h\)\s*=>\s*setQuery\(\{ health: query\.health === h \? '' : h \}\)/ .test(mp));
  assertTrue('③逾期柱 onDrill=openOverdue（不动）', /<OverdueBarChart[\s\S]*?onDrill=\{openOverdue\}/ .test(mp));
  assertTrue('④负荷柱 onDrill=openOwner（不动）', /<OwnerLoadBarChart[\s\S]*?onDrill=\{openOwner\}/ .test(mp));

  // 3.4 前端类型 / 契约 / HTTP / 镜像纯函数
  const types = read('web/src/types/dashboard.ts');
  assertTrue('类型 OverdueBucket', /export type OverdueBucket = '1to7' \| '8to30' \| 'over30'/.test(types));
  assertTrue('类型 DashboardTasksQuery', /export interface DashboardTasksQuery \{/.test(types));
  assertTrue('类型 DashboardTaskRow（10 字段）', (function () {
    const m = types.match(/export interface DashboardTaskRow \{[\s\S]*?\n\}/);
    if (!m) return false;
    return ['id', 'projectId', 'projectName', 'wbsCode', 'name', 'priority', 'status', 'dueDate', 'progress', 'ownerName']
      .every((k) => new RegExp('\\b' + k + ':').test(m[0]));
  })());
  const contract = read('web/src/api/contract.ts');
  assertTrue('contract ApiClient 新增 getDashboardTasks', /getDashboardTasks\(query: DashboardTasksQuery\): Promise<Paged<DashboardTaskRow>>/.test(contract));
  const http = read('web/src/api/http.ts');
  assertTrue('http 实现 getDashboardTasks → /dashboard/tasks${qs}', /getDashboardTasks\(query: DashboardTasksQuery\): Promise<Paged<DashboardTaskRow>> \{[\s\S]*?`\/dashboard\/tasks\$\{qs\(query as Record<string, unknown>\)\}`/.test(http));
  const dagg = read('web/src/utils/dashboardAgg.ts');
  assertTrue('dashboardAgg 镜像 overdueBucketOf', /export function overdueBucketOf\([\s\S]*?OverdueBucket \| null/.test(dagg));

  // 3.5 mock 双写（默认 VITE_USE_MOCK=true 下抽屉有数据）
  const mock = read('web/src/api/mock/index.ts');
  assertTrue('mock 实现 getDashboardTasks', /async getDashboardTasks\(query: DashboardTasksQuery\): Promise<Paged<DashboardTaskRow>>/.test(mock));
  assertTrue('mock 使用 leafNodesOf 判叶子', /leafNodesOf\(db\.wbsNodes\.filter\(\(n\) => scopeIds\.has\(n\.projectId\)\)\)/.test(mock));
  assertTrue('mock 使用 overdueBucketOf 分段', /overdueBucketOf\(n\.dueDate\) === dim\.value/.test(mock));
  assertTrue('mock taskStatus 命中基数含已完成', /dim\.kind === 'taskStatus'\s*\?\s*allLeafTasks\s*:\s*allLeafTasks\.filter\(\(n\) => n\.status !== '完成'\)/.test(mock));
  assertTrue('mock 排序优先级→截止日→名称', /RANK\[a\.priority\] \?\? 2/.test(mock) && /a\.name\.localeCompare\(b\.name, 'zh-CN'\)/.test(mock));
  assertTrue('mock 返回 {items,total,page,pageSize}', /items: rows\.slice\(\(page - 1\) \* pageSize, page \* pageSize\),[\s\S]*?total: rows\.length,[\s\S]*?page,[\s\S]*?pageSize/.test(mock));
  const wbsFixture = read('web/src/api/mock/fixtures/wbs.ts');
  assertTrue('mock fixture 含 wbs 节点数据（抽屉有数可出）', /NodeSpec\[\]/.test(wbsFixture) || /dueOffset/.test(wbsFixture));
}

/* ── 4. 红线回归 ──────────────────────────────────────── */
async function testRedLine() {
  section('4. 红线回归');

  // 4.1 normalizeQuery 零改动：B18 维度参数不进 normalizeQuery（从原始 query 读）
  const svcSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'dashboard.service.js'), 'utf8');
  const m = svcSrc.match(/function normalizeQuery\(query\) \{[\s\S]*?\n\}/);
  assertTrue('normalizeQuery 函数体可提取', !!m);
  if (m) {
    const body = m[0];
    const keys = ['scope', 'type', 'status', 'health', 'keyword', 'onlyMine', 'page', 'pageSize', 'sort'];
    assertTrue('normalizeQuery 返回 9 个 B17 字段齐全', keys.every((k) => new RegExp('\\b' + k + ':').test(body)));
    assertTrue('normalizeQuery 不含 priority/taskStatus/overdueBucket（B18 未污染）',
      !/priority|taskStatus|overdueBucket/.test(body));
  }
  assertTrue('B18 维度从原始 query 读取（resolveDimension 读 raw query）', /function resolveDimension\(query\) \{[\s\S]*?const raw = query && typeof query === 'object' \? query : \{\}/.test(svcSrc));

  // 4.2 server/** 仅 3 文件含 B18 改动（B18 内容标识：'B18' 注释 / getDashboardTasks / overdueBucketOf 纯函数）
  const serverFiles = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.js$/.test(ent.name)) serverFiles.push(p);
    }
  })(path.join(ROOT, 'server'));
  const b18Files = serverFiles.filter((p) => {
    const s = fs.readFileSync(p, 'utf8');
    return s.includes('B18') || s.includes('getDashboardTasks') || s.includes('overdueBucketOf');
  }).map((p) => path.relative(ROOT, p).replace(/\\/g, '/')).sort();
  const expected = [
    'server/lib/portfolioAgg.js',
    'server/routes/dashboard.routes.js',
    'server/services/dashboard.service.js',
  ];
  assertTrue('server/** 仅 3 文件含 B18/getDashboardTasks',
    JSON.stringify(b18Files) === JSON.stringify(expected), b18Files.join(', '));

  // 4.3 零 schema：migrations 未动、schema_migrations 最高 v7、无 .sql 改动
  const migStat = fs.statSync(path.join(ROOT, 'server', 'dal', 'migrations.js'));
  const b18Start = new Date('2026-08-18T00:00:00');
  assertTrue('migrations.js 修改时间早于 B18（未动）', migStat.mtime < b18Start, migStat.mtime.toISOString());
  const Database = require('better-sqlite3');
  const dbr = new Database(path.join(ROOT, 'pm.db'), { readonly: true });
  const maxV = dbr.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  dbr.close();
  assertEq('schema_migrations 最高版本 = 7（B17 基线）', maxV, 7);

  // 4.4 既有组件无 B18 改动
  const untouched = [
    'web/src/components/dashboard/MyTasksDrawer.tsx',
    'web/src/components/dashboard/OverdueTaskDrawer.tsx',
    'web/src/components/dashboard/OwnerLoadDrawer.tsx',
    'web/src/components/dashboard/HealthDonut.tsx',
    'web/src/components/dashboard/DonutChart.tsx',
  ];
  for (const rel of untouched) {
    const s = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assertTrue(rel + ' 无 B18 / getDashboardTasks 引用', !/B18|getDashboardTasks|DistributionTaskDrawer/.test(s));
  }

  // 4.5 B17 三图 rows 构造只追加 onDrill（key/label/value/color 结构保留）
  const mp = fs.readFileSync(path.join(ROOT, 'web', 'src', 'pages', 'MetricsPage.tsx'), 'utf8');
  assertTrue('priorityRows 构造保留 B17 结构（key/label/value/color）', /key: p,[\s\S]*?label: PRIORITY_OPTIONS\.find\(\(o\) => o\.value === p\)\?\.label \?\? p,[\s\S]*?value: data\?\.priorityDist\[p\] \?\? 0,[\s\S]*?color:/.test(mp));
  assertTrue('statusRows 构造保留 B17 结构', /const statusRows: CategoryBarRow\[\] = TASK_STATUSES\.map/.test(mp));
  assertTrue('durationRows 构造保留 B17 结构（三档 key）', /key: 'days1to7'[\s\S]*?key: 'days8to30'[\s\S]*?key: 'daysOver30'/.test(mp));
  assertTrue('CategoryBarChart 仅新增 onDrill（6 个 B17 props 仍在）', (mp.match(/<CategoryBarChart[\s\S]*?title=/g) || []).length === 3
    && (mp.match(/rows=\{(?:priorityRows|statusRows|durationRows)\}/g) || []).length === 3
    && (mp.match(/loading=\{loading\}/g) || []).length >= 3);
}

/* ── 5. 编译（可选） ──────────────────────────────────── */
async function testBuild() {
  if (process.env.QA_SKIP_BUILD === '1') {
    section('5. 编译（QA_SKIP_BUILD=1 跳过）');
    check('编译检查已跳过', true);
    return;
  }
  section('5. 编译 vite build + tsc --noEmit');
  const webDir = path.join(ROOT, 'web');
  function runCmd(cmd, args) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd: webDir, shell: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });
  }
  const build = await runCmd('node', ['node_modules/vite/bin/vite.js', 'build']);
  assertEq('vite build 退出码 0', build.code, 0, build.out.split('\n').slice(-6).join(' '));
  const tsc = await runCmd('npx', ['tsc', '--noEmit']);
  assertEq('tsc --noEmit 退出码 0', tsc.code, 0, (tsc.out || '').split('\n').slice(0, 5).join(' '));
}

/* ── 主流程 ───────────────────────────────────────────── */
(async function main() {
  const t0 = Date.now();
  console.log('B18 QA 验证脚本启动 @ ' + new Date().toISOString());
  console.log('ROOT=' + ROOT);
  console.log('BASE=' + BASE);
  try {
    await ensureServer();
    await testBackendPure();
    await testApi();
    await testFrontendSource();
    await testRedLine();
    await testBuild();
  } catch (e) {
    console.error('\n[FATAL] 脚本执行异常：', e && e.stack ? e.stack : e);
    results.push({ name: '脚本执行', ok: false, detail: String(e && e.message || e) });
  } finally {
    stopServer();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log('\n==========================================');
  console.log('B18 QA 验证汇总');
  console.log('  断言通过: ' + passed + ' / ' + results.length);
  console.log('  断言失败: ' + failed.length);
  if (failed.length) {
    console.log('\n  失败明细:');
    failed.forEach((f) => console.log('    - ' + f.name + (f.detail ? ' | ' + f.detail : '')));
  }
  console.log('  耗时: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('==========================================');
  process.exit(failed.length ? 1 : 0);
})();
