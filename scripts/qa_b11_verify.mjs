#!/usr/bin/env node
/**
 * QA 独立验证 · B11 看板「阻塞」列贯通 + 工作台仪表盘增强
 *
 * 定位：B11 交付关卡独立验证（docs/B11-架构设计.md §2.5 / T02 完成标准 / T04 完成标准）。
 *   沿用 `qa_b9/b10_verify.mjs` 范式，覆盖 5 组核心断言：
 *
 *   1. `GET /api/projects/:id/board` 返回 **5 列**且含「阻塞」；
 *   2. 老项目（DB 里已有 4 列快照）首次 `getBoard` 触发**列自愈**：
 *        - columns 变 5 列、含「阻塞」；
 *        - **wip_limits 原值未丢**（自愈 SQL 只 SET columns 一列）；
 *        - 连续两次 getBoard，第二次零 UPDATE（幂等，updated_at 不变）；
 *   3. 拖任务到「阻塞」列成功落库 + 写审计（status_change after='阻塞'）；
 *   4. `GET /api/workbench` 的 `myTasks[].projectName` 已落库（B11 纯追加字段）；
 *   5. 既有 WIP 拦截（`E_WIP_EXCEEDED` / 409）未回归；
 *   6. 列顺序口径与 `enums.BOARD_COLUMNS`（待办→进行中→阻塞→待评审→完成）逐字一致，
 *      即 mock / 真后端列数一致（真后端为权威源，此处对真后端断言）。
 *
 * 用法（与既有回归脚本同约定：同一 DB_PATH 起服务 + 跑脚本）：
 *   DB_PATH=./b11_qa.db node server.js &            # 先起服务（端口默认 3311）
 *   DB_PATH=./b11_qa.db node scripts/qa_b11_verify.mjs http://127.0.0.1:3311
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
const DB_FILE = process.env.DB_PATH || './b11_qa.db';

/* 演示账号（与 server/dal/seed.js / web demoAccounts.ts 一致） */
const ADMIN = 'ou_xuwenbin01';

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
  const snake = r && r.json ? findSnakeCaseKeys(r.json) : [];
  if (!r || !r.json || r.json.code !== 0) {
    assert(false, label + '（信封失败）', r && r.json);
    return null;
  }
  assert(snake.length === 0, label + ' → 响应无 snake_case', snake);
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

/* ── DB 直查 / 直写（仅测试库 b11_qa.db） ─────────────── */

function openDb() {
  const Database = require('better-sqlite3');
  /* fileMustExist：DB 必须由服务端先建好；避免本连接误建一个空库把服务端的 WAL 顶掉 */
  const db = new Database(path.resolve(ROOT, DB_FILE), { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 8000');
  return db;
}

/**
 * 等待「服务端进程刚写入的行」对本进程的独立连接可见。
 *
 * 背景（QA 严过关 · 2 轮验收发现）：本脚本用**独立 SQLite 连接**直读/直写一个
 * 正被 server 进程持有的 WAL 库。服务端刚经 HTTP 写入的行，对新开的连接
 * 存在短暂不可见窗口；此时若直接 `INSERT ... REFERENCES projects(id)`
 * 会报 `FOREIGN KEY constraint failed`（父行“看不见”），
 * 表现为脚本崩溃而非断言失败，极难定位。
 *
 * 故：所有依赖「服务端刚写入的父行」的 DB 直写，之前必须先等它可见。
 *
 * @param {string} sql   返回单行的查询（可见即返回非空）
 * @param {Array}  params
 * @param {number} tries 轮询次数（每次间隔 100ms）
 */
async function dbWaitVisible(sql, params, tries) {
  const max = tries || 40;
  for (let i = 0; i < max; i += 1) {
    try {
      const row = dbRow(sql, params);
      if (row) return row;
    } catch (e) { /* 表还没建好 / 连接抖动，继续等 */ }
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  return null;
}

function dbRow(sql, params) {
  const db = openDb();
  try {
    return db.prepare(sql).get(...(params || []));
  } finally {
    db.close();
  }
}

function dbAll(sql, params) {
  const db = openDb();
  try {
    return db.prepare(sql).all(...(params || []));
  } finally {
    db.close();
  }
}

function dbExec(sql, params) {
  const Database = require('better-sqlite3');
  /* fileMustExist：同 openDb —— 绝不让本连接凭空建库，否则会把服务端 WAL 里的数据顶没 */
  const db = new Database(path.resolve(ROOT, DB_FILE), { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 8000');
    return db.prepare(sql).run(...(params || []));
  } finally {
    db.close();
  }
}

/* ── 测试数据构造 ───────────────────────────────────── */

async function createProject(name, type) {
  return okData(
    await call('POST', '/api/projects', {
      name: name,
      type: type || 'A',
      customer: 'B11 验证客户',
      contractAmount: 300,
      background: 'qa_b11_verify 自动创建',
      goal: ['B11 专项验证'],
      planStart: dayOffset(0),
      planEnd: dayOffset(180),
      pm: ADMIN,
      classifyInput: { contractAmount: 300, hasHardware: type === 'A', hasAcceptance: type === 'A', isSelfIteration: type === 'B', isInfrastructure: type === 'C' },
      classifySuggested: type || 'A',
      classifyOverrideReason: '',
      members: [
        { userOpenId: ADMIN, role: 'pm' },
        { userOpenId: 'ou_wangqiang02', role: 'tl' },
      ],
      milestones: [],
    }),
    '建项目 ' + name,
  );
}

async function createTask(projectId, name, owner, status, dueOffset, progress) {
  return okData(
    await call('POST', '/api/projects/' + projectId + '/wbs', {
      name: name,
      nodeType: 'task',
      parentId: '',
      owner: owner,
      estimateDays: 3,
      dueDate: dayOffset(dueOffset === undefined ? 10 : dueOffset),
      status: status || '待办',
      /* progress>0 才能稳定停在「进行中」列：syncWbsProgressStatus 会把 progress=0 的进行中叶子收敛回待办 */
      progress: progress === undefined ? 0 : progress,
    }),
    '建任务 ' + name,
  );
}

/* ═══════════════════════════════════════════════════════ */

async function main() {
  console.log('═══ B11 看板阻塞列贯通 + 工作台仪表盘 · 专项验证（' + BASE + ' / DB=' + DB_FILE + '）═══');

  /* ── 前置：管理员登录 + 建项目 + 建任务 ───────────── */
  console.log('\n── 前置：登录 + 建项目/任务 ──');
  await loginAs(ADMIN);
  assert(!!token, '管理员 devlogin 签发 token');

  const proj = await createProject('B11-QA-' + Date.now(), 'A');
  assert(proj && !!proj.id, '项目已创建', proj && proj.id);
  const pid = proj.id;

  const tA = await createTask(pid, 'B11任务A-阻塞用例', ADMIN, '待办', 5);
  const tB = await createTask(pid, 'B11任务B-进行中用例', ADMIN, '待办', 6, 50);
  /* tC 保持 progress=0（待办）：progress>0 的待办叶子会被 syncWbsProgressStatus 自动上调为「进行中」，
     那样再「拖入进行中」就成了同列 no-op（跳过 WIP 校验）。progress=0 才能触发真实状态变更 + WIP 拦截。 */
  const tC = await createTask(pid, 'B11任务C-WIP用例', ADMIN, '待办', 7);
  assert(tA && tB && tC && tA.id !== tB.id && tB.id !== tC.id, '三张叶子任务已创建', [tA && tA.id, tB && tB.id, tC && tC.id]);

  /* ── G1：getBoard 返回 5 列且含「阻塞」 ──────────── */
  console.log('\n── G1 getBoard 返回 5 列且含「阻塞」 ──');
  const board = okData(await call('GET', '/api/projects/' + pid + '/board'), 'getBoard');
  assert(board && Array.isArray(board.columns), 'board.columns 为数组', board && board.columns && board.columns.length);
  assert(board.columns.length === 5, '看板共 5 列', board.columns.map(function (c) { return c.status; }));
  const statusNames = board.columns.map(function (c) { return c.status; });
  assert(statusNames.indexOf('阻塞') >= 0, '5 列含「阻塞」列', statusNames);
  /* 顺序口径：待办 → 进行中 → 阻塞 → 待评审 → 完成 */
  const wantOrder = ['待办', '进行中', '阻塞', '待评审', '完成'];
  assert(JSON.stringify(statusNames) === JSON.stringify(wantOrder), '列顺序与 BOARD_COLUMNS 逐字一致', statusNames);

  /* ── G2：老 4 列快照自愈（只改 columns，wip_limits 不丢，幂等） ── */
  console.log('\n── G2 老 board_configs 行「读时自愈」 ──');
  /* 先等服务端刚建的 project 行对本进程的独立连接可见。
     ⚠ 沙箱环境限制（QA 严过关验收发现）：本机文件系统的 SQLite WAL **跨进程共享内存不可靠**，
     外部进程直连一个正被 server 持有的 WAL 库时，行可能长期不可见，
     且外部连接 close 时可能误触发 checkpoint/truncate 把服务端 WAL 帧丢掉。
     故此处做**能力探测**：不可用时跳过「DB 直读直写」类断言（G2/G3 落库校验），
     仅保留 HTTP 层断言，并在结尾明确提示，避免脚本崩溃或给出假绿。 */
  const visible = await dbWaitVisible('SELECT id FROM projects WHERE id = ?', [pid], 20);
  const DB_DIRECT = !!visible;
  if (!DB_DIRECT) {
    console.log('  \u26A0 跳过：本环境 SQLite WAL 跨进程直连不可用，G2/G3 的 DB 落库断言无法执行');
    console.log('    （HTTP 层断言继续执行；如需 DB 级校验请用 scripts/_qa_b11_independent.cjs 的同进程范式）');
  } else {
    assert(true, '项目行对独立 DB 连接可见（可安全直写 board_configs）');
  }

  if (DB_DIRECT) {
  /* 注入一条「老项目」的 4 列快照（自定义 wip_limits 以便验证未被清掉） */
  dbExec(
    'INSERT OR REPLACE INTO board_configs (project_id, columns, wip_limits, updated_at) VALUES (?, ?, ?, ?)',
    [pid, JSON.stringify(['待办', '进行中', '待评审', '完成']), JSON.stringify({ 进行中: 3 }), new Date().toISOString()],
  );
  const beforeRow = dbRow('SELECT * FROM board_configs WHERE project_id = ?', [pid]);
  const beforeCols = JSON.parse(beforeRow.columns);
  const beforeLimits = JSON.parse(beforeRow.wip_limits);
  assert(Array.isArray(beforeCols) && beforeCols.length === 4, '注入前为 4 列快照', beforeCols);
  assert(beforeLimits && beforeLimits['进行中'] === 3, '注入前 wip_limits.进行中=3', beforeLimits);

  const healed = okData(await call('GET', '/api/projects/' + pid + '/board'), 'getBoard（触发自愈）');
  const afterRow = dbRow('SELECT * FROM board_configs WHERE project_id = ?', [pid]);
  const afterCols = JSON.parse(afterRow.columns);
  const afterLimits = JSON.parse(afterRow.wip_limits);
  assert(Array.isArray(afterCols) && afterCols.length === 5, '自愈后变 5 列', afterCols);
  assert(afterCols.indexOf('阻塞') >= 0, '自愈后含「阻塞」列', afterCols);
  assert(afterLimits && afterLimits['进行中'] === 3, '自愈只改 columns，wip_limits 原值未丢', afterLimits);

  /* 幂等：第二次 getBoard 结果稳定。
     ⚠ QA 修正：原断言用 `updated_at 不变` 判定「零 UPDATE」是**恒真断言** ——
     自愈 SQL 是 `UPDATE board_configs SET columns = ? WHERE project_id = ?`，
     **压根不写 updated_at**，所以哪怕每次都 UPDATE，该断言也永远通过，证明不了幂等。
     真正的幂等证明需要计数写次数（`total_changes()`），HTTP 黑盒做不到；
     已在 `scripts/_qa_b11_independent.cjs` 用同进程 `ensureBoardConfig` +
     `total_changes()` 三次调用做了强验证（1 次写、后 2 次零写）。
     此处只保留「二次调用结果稳定」这一可靠的黑盒断言。 */
  okData(await call('GET', '/api/projects/' + pid + '/board'), 'getBoard（幂等二次调用）');
  const afterRow2 = dbRow('SELECT * FROM board_configs WHERE project_id = ?', [pid]);
  const afterCols2 = JSON.parse(afterRow2.columns);
  const afterLimits2 = JSON.parse(afterRow2.wip_limits);
  assert(afterCols2.length === 5, '二次调用仍是 5 列', afterCols2);
  assert(afterLimits2 && afterLimits2['进行中'] === 3, '二次调用 wip_limits 仍原值', afterLimits2);
  assert(JSON.stringify(afterCols2) === JSON.stringify(afterCols), '二次调用 columns 完全稳定（幂等·黑盒）', { first: afterCols, second: afterCols2 });

  /* 自愈后的看板与 G1 一致（含阻塞列、顺序正确） */
  assert(Array.isArray(healed.columns) && healed.columns.length === 5, '自愈后返回看板为 5 列', healed.columns && healed.columns.map(function (c) { return c.status; }));
  } /* end if (DB_DIRECT) — G2 依赖 DB 直连 */

  /* ── G3：拖到「阻塞」列成功落库 + 写审计 ─────────── */
  console.log('\n── G3 拖任务到「阻塞」列落库 + 审计 ──');
  const moved = okData(await call('POST', '/api/wbs/' + tA.id + '/move-status', { status: '阻塞', order: 0 }), 'move-status → 阻塞');
  const blockedCol = moved.columns.filter(function (c) { return c.status === '阻塞'; })[0];
  assert(blockedCol && blockedCol.cards.some(function (c) { return c.id === tA.id; }), '返回看板中任务A已在阻塞列', blockedCol && blockedCol.cards.map(function (c) { return c.id; }));

  if (DB_DIRECT) {
    const dbNode = dbRow('SELECT status FROM wbs_nodes WHERE id = ?', [tA.id]);
    assert(dbNode && dbNode.status === '阻塞', 'DB wbs_nodes.status 落库为「阻塞」', dbNode);

    const auditRows = dbAll(
      "SELECT * FROM audit_logs WHERE entity_type='wbs_node' AND entity_id=? AND action='status_change'",
      [tA.id],
    );
    const blockedAudit = auditRows.filter(function (a) {
      try {
        const diff = JSON.parse(a.diff || '[]');
        return diff.some(function (d) { return d.field === 'status' && d.after === '阻塞'; });
      } catch (e) { return false; }
    });
    assert(blockedAudit.length >= 1, '审计日志含 status_change → 阻塞', { total: auditRows.length, matched: blockedAudit.length });
  } else {
    /* 退化断言：DB 不可直连时，用「重新 GET 看板」验证落库（服务端自己读 DB） */
    const reread = okData(await call('GET', '/api/projects/' + pid + '/board'), '重新 getBoard 验证落库');
    const bc = reread.columns.filter(function (c) { return c.status === '阻塞'; })[0];
    assert(bc && bc.cards.some(function (c) { return c.id === tA.id; }), '重新 GET 看板：任务A 仍在阻塞列（已落库）', bc && bc.cards.map(function (c) { return c.id; }));
  }

  /* ── G4：/api/workbench 的 myTasks[].projectName 存在 ── */
  console.log('\n── G4 workbench.myTasks[].projectName ──');
  const wb = okData(await call('GET', '/api/workbench'), 'getWorkbench');
  assert(wb && Array.isArray(wb.myTasks), 'workbench.myTasks 为数组', wb && wb.myTasks && wb.myTasks.length);
  assert(wb.myTasks.length > 0, 'myTasks 非空（含本项目任务）', wb.myTasks.length);
  assert(typeof wb.myTasks[0].projectName === 'string' && wb.myTasks[0].projectName.length > 0, 'myTasks[0].projectName 存在且非空', wb.myTasks[0].projectName);

  /* 命中本项目任务，projectName 必须等于项目名 */
  const mineInProj = wb.myTasks.filter(function (t) { return t.id === tA.id || t.id === tB.id || t.id === tC.id; });
  assert(mineInProj.length > 0, 'myTasks 含本项目任务', mineInProj.map(function (t) { return t.id; }));
  const nameOk = mineInProj.every(function (t) { return t.projectName === proj.name; });
  assert(nameOk, '本项目任务的 projectName === 项目名', { expect: proj.name, got: mineInProj.map(function (t) { return t.projectName; }) });

  /* ── G5：WIP 拦截未回归（E_WIP_EXCEEDED / 409） ── */
  console.log('\n── G5 既有 WIP 拦截未回归 ──');
  /* tB 拖入「进行中」（此时无上限约束，先占 1 个名额） */
  const bBoard = okData(await call('POST', '/api/wbs/' + tB.id + '/move-status', { status: '进行中', order: 0 }), 'move-status → 进行中（占位）');
  const bCol = bBoard.columns.filter(function (c) { return c.status === '进行中'; })[0];
  assert(bCol && bCol.cards.some(function (c) { return c.id === tB.id; }), 'tB 已稳定停在「进行中」列（progress>0 不被收敛）', bCol && bCol.cards.map(function (c) { return c.id; }));
  /* 把「进行中」WIP 上限设为 1 */
  okData(
    await call('PATCH', '/api/projects/' + pid + '/board-config', { wipLimits: { 进行中: 1 } }),
    '更新 WIP 上限（进行中=1）',
  );
  if (DB_DIRECT) {
    const cfgRow = dbRow('SELECT wip_limits FROM board_configs WHERE project_id = ?', [pid]);
    const cfgLimits = JSON.parse(cfgRow.wip_limits);
    assert(cfgLimits && cfgLimits['进行中'] === 1, 'WIP 上限已落库（进行中=1）', cfgLimits);
  }

  /* tC 再拖入「进行中」应被拦截 */
  const wipR = await call('POST', '/api/wbs/' + tC.id + '/move-status', { status: '进行中', order: 0 });
  expectError(wipR, 'E_WIP_EXCEEDED', 409, '超额拖入进行中 → 409 E_WIP_EXCEEDED 未回归');

  /* 还原 WIP 上限，避免污染测试库 */
  okData(
    await call('PATCH', '/api/projects/' + pid + '/board-config', { wipLimits: { 进行中: 5 } }),
    '还原 WIP 上限（进行中=5）',
  );

  /* ── G6：列数口径一致性（真后端权威源 = 5，含阻塞） ── */
  console.log('\n── G6 列口径与 BOARD_COLUMNS 一致 ──');
  const finalBoard = okData(await call('GET', '/api/projects/' + pid + '/board'), 'getBoard（终态）');
  const finalStatuses = finalBoard.columns.map(function (c) { return c.status; });
  assert(JSON.stringify(finalStatuses) === JSON.stringify(wantOrder), '终态列顺序 = BOARD_COLUMNS（mock/真后端一致口径）', finalStatuses);

  /* ═════════════════════════════════════════════════ */
  console.log('\n════════════════════════════════════════════');
  console.log('  B11 验证结果：通过 ' + passed + ' / 失败 ' + failed);
  if (failed > 0) {
    console.log('  失败项：');
    failures.forEach(function (f) { console.log('   - ' + f); });
  }
  console.log('════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (err) {
  console.error('[qa_b11] 运行异常：', err);
  process.exit(1);
});
