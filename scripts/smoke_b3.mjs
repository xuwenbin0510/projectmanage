#!/usr/bin/env node
/**
 * Connect v1 · 批次 3 冒烟脚本（docs/connect-B3-任务分解.md §5.2 必测断言清单）
 *
 * 用法：
 *   1. 先起服务：`node server.js`
 *   2. 另开终端：`node scripts/smoke_b3.mjs [baseUrl]`
 *      默认 baseUrl = http://127.0.0.1:3000
 *
 * 覆盖域（§5.2）：
 *   ① WBS 树（13 条）  ② 看板（6 条）  ③ 里程碑（8 条）
 *   ④ 质量门（6 条）   ⑤ 成员写（4 条） ⑥ RBAC / 只读（3 条） ⑦ 联动（2 条）
 *
 * 断言口径（不是「能返回就算过」）：
 *   - 信封形态：成功恒 `code === 0`（数字），失败恒 `E_` 开头字符串 + 精确 HTTP 状态
 *   - 字段命名：一律 camelCase，**响应体里不允许出现下划线字段**
 *   - 错误码必须精确命中（E_WBS_DEPTH 而不是笼统 E_VALIDATION）
 *   - 双引擎易翻车点重点验证：SK-4 真叶子口径 / 强规则收敛 / 未勾齐+不通过例外 /
 *     重复决策幂等 / 口径 Y 加权
 *
 * 隔离策略：每个测试域**独立建项目**，避免看板 WIP 计数、里程碑统计互相污染。
 *
 * 退出码：0 = 全绿；1 = 有断言失败（CI 可直接用）
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const BASE = (process.argv[2] || process.env.SMOKE_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');

/** 管理员（RBAC 短路，用于铺数据）；来自 server/dal/seed.js */
const ADMIN_OPEN_ID = 'ou_xuwenbin01';
/** 项目 TL（建项必备角色） */
const TL_OPEN_ID = 'ou_wangqiang02';
/** globalRole = member 的普通账号（RBAC 反面用例） */
const MEMBER_OPEN_ID = 'ou_wudi09';
/** 另一个普通账号（成员增删用例） */
const MEMBER2_OPEN_ID = 'ou_zhengshuang10';

let passed = 0;
let failed = 0;
const failures = [];

/* ── 断言工具（与 smoke_connect.mjs 同源） ──────────── */

/**
 * 基础断言。
 * @param {boolean} cond
 * @param {string} label
 * @param {*} [detail]
 */
function assert(cond, label, detail) {
  if (cond) {
    passed += 1;
    console.log('  \u2713 ' + label);
  } else {
    failed += 1;
    failures.push(label + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
    console.log('  \u2717 ' + label + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  }
}

/**
 * 相等断言。
 * @param {*} actual
 * @param {*} expected
 * @param {string} label
 */
function assertEq(actual, expected, label) {
  assert(actual === expected, label, { expected: expected, actual: actual });
}

/**
 * 递归检查对象里是否混入了 snake_case 字段（§3.8）。
 * @param {*} value
 * @param {string} [pathStr]
 * @returns {string[]}
 */
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

/* ── HTTP ───────────────────────────────────────────── */

let token = '';

/**
 * 发请求并解析信封。
 * @param {string} method
 * @param {string} pathname
 * @param {*} [body]
 * @returns {Promise<{status:number, json:any}>}
 */
async function call(method, pathname, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + pathname, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = { __parseError: true, raw: text.slice(0, 200) };
  }
  return { status: res.status, json: json };
}

/**
 * 断言「成功信封」并返回 data。
 * @param {{status:number, json:any}} r
 * @param {string} label
 * @returns {*}
 */
function okData(r, label) {
  assert(
    r.json && r.json.code === 0,
    label + ' → code === 0（数字）',
    { status: r.status, code: r.json && r.json.code, message: r.json && r.json.message },
  );
  const snake = findSnakeCaseKeys(r.json && r.json.data);
  assert(snake.length === 0, label + ' → 响应无 snake_case 字段', snake.slice(0, 5));
  return r.json ? r.json.data : null;
}

/**
 * 断言「失败信封」命中指定错误码 + HTTP 状态。
 * @param {{status:number, json:any}} r
 * @param {string} code
 * @param {number} httpStatus
 * @param {string} label
 */
function expectError(r, code, httpStatus, label) {
  assertEq(r.status, httpStatus, label + ' → HTTP ' + httpStatus);
  assertEq(r.json && r.json.code, code, label + ' → code ' + code);
}

/* ── 小工具 ─────────────────────────────────────────── */

/** 今天 + n 天 → YYYY-MM-DD */
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const STAMP = Date.now();

/** 登录切换账号 */
async function loginAs(openId) {
  const r = await call('POST', '/api/auth/devlogin', { openId: openId });
  token = (r.json && r.json.data && r.json.data.token) || '';
  return r;
}

/**
 * 建项目（可显式带里程碑 + 质量门规格 · K-1：门只在向导显式提交时实例化）。
 * @param {string} tag 用于项目名
 * @param {Array<object>} milestones 里程碑规格
 * @returns {Promise<object>} Project
 */
async function createProject(tag, milestones) {
  const payload = {
    name: 'B3冒烟·' + tag + ' ' + STAMP,
    type: 'A',
    customer: '星舰客户',
    contractAmount: 500,
    background: 'smoke_b3 自动创建',
    goal: ['B3 冒烟验证'],
    planStart: dayOffset(0),
    planEnd: dayOffset(180),
    pm: ADMIN_OPEN_ID,
    classifyInput: {
      contractAmount: 500, hasHardware: true, hasAcceptance: true, isSelfIteration: false, isInfrastructure: false,
    },
    classifySuggested: 'A',
    classifyOverrideReason: '',
    members: [{ userOpenId: ADMIN_OPEN_ID, role: 'pm' }, { userOpenId: TL_OPEN_ID, role: 'tl' }],
    milestones: milestones,
  };
  const r = await call('POST', '/api/projects', payload);
  const data = okData(r, '建项目「' + tag + '」');
  return data || {};
}

/** 建 WBS 节点（返回 data，可能是错误响应） */
function newNode(projectId, body) {
  return call('POST', '/api/projects/' + projectId + '/wbs', body);
}

/** 拉全量 WBS */
async function listWbs(projectId) {
  const r = await call('GET', '/api/projects/' + projectId + '/wbs');
  return (r.json && r.json.data) || [];
}

/** 拉里程碑（含门 + 检查项 + taskStats） */
async function listMilestones(projectId) {
  const r = await call('GET', '/api/projects/' + projectId + '/milestones');
  return (r.json && r.json.data) || [];
}

/**
 * 测试准备：把项目置为「已结项」。
 *
 * ⚠ `PATCH /api/projects/:id` 在 B3 仍是 501（项目流转属 B4），无法通过 API 造归档态，
 *   故此处直连 SQLite 改状态。**这是测试夹具，不是绕过实现**。
 * @param {string} projectId
 */
function archiveProjectViaDb(projectId) {
  const Database = require('better-sqlite3');
  const dbFile = process.env.DB_PATH
    ? path.resolve(ROOT, process.env.DB_PATH)
    : path.join(ROOT, 'pm.db');
  const conn = new Database(dbFile);
  try {
    conn.prepare('UPDATE projects SET status = ? WHERE id = ?').run('已结项', String(projectId));
  } finally {
    conn.close();
  }
}

/* ═══════════════════════════════════════════════════
 * 用例
 * ═══════════════════════════════════════════════════ */

async function main() {
  console.log('[smoke:b3] target = ' + BASE + '\n');

  /* ── ⓪ 登录（admin，RBAC 短路） ───────────────── */
  console.log('⓪ 登录 · 管理员');
  const login = await loginAs(ADMIN_OPEN_ID);
  const session = okData(login, 'devlogin(admin)');
  assertEq(session && session.user && session.user.globalRole, 'admin', 'devlogin → globalRole === admin');
  assert(!!token, 'devlogin → 拿到 token');

  /* ═══════════════════════════════════════════════
   * ① WBS 树（§5.2 · 13 条）
   * ═══════════════════════════════════════════════ */
  console.log('\n① WBS 树');
  const pWbs = await createProject('WBS', [
    { code: 'M1', name: '启动', date: dayOffset(30), required: true, gate: null },
    { code: 'M2', name: '需求', date: dayOffset(60), required: true, gate: null },
  ]);
  const pWbsId = pWbs.id;
  const wbsMs = await listMilestones(pWbsId);
  const wbsM1 = wbsMs[0] || {};

  /* 1) 根层建 subtask → E_WBS_PARENT_TYPE 400 */
  expectError(
    await newNode(pWbsId, { nodeType: 'subtask', name: '根层子任务', owner: ADMIN_OPEN_ID, estimateDays: 1 }),
    'E_WBS_PARENT_TYPE', 400, '[W1] 根层建 subtask',
  );

  /* 2) 缺 owner → E_WBS_LEAF_INCOMPLETE 400 */
  const leafIncomplete = await newNode(pWbsId, { name: '缺负责人', estimateDays: 1 });
  expectError(leafIncomplete, 'E_WBS_LEAF_INCOMPLETE', 400, '[W2] 建节点缺 owner');
  assert(
    !!(leafIncomplete.json && leafIncomplete.json.data && leafIncomplete.json.data.fields),
    '[W2] E_WBS_LEAF_INCOMPLETE → data.fields 存在',
  );

  /* 3) 连挂 4 层后第 5 层 → E_WBS_DEPTH 400，data.maxDepth === 4 */
  const a1 = okData(await newNode(pWbsId, { name: 'A1 深度根', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[W3] 建 A1');
  const a2 = okData(await newNode(pWbsId, { parentId: a1.id, name: 'A2', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[W3] 建 A2');
  const a3 = okData(await newNode(pWbsId, { parentId: a2.id, name: 'A3', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[W3] 建 A3');
  const a4 = okData(await newNode(pWbsId, { parentId: a3.id, name: 'A4', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[W3] 建 A4');
  assertEq(a4 && a4.level, 4, '[W3] A4 → level === 4');
  const depthErr = await newNode(pWbsId, { parentId: a4.id, name: 'A5', owner: ADMIN_OPEN_ID, estimateDays: 1 });
  expectError(depthErr, 'E_WBS_DEPTH', 400, '[W3] 第 5 层');
  assertEq(depthErr.json && depthErr.json.data && depthErr.json.data.maxDepth, 4, '[W3] E_WBS_DEPTH → data.maxDepth === 4');

  /* 4) dueDate 晚于父任务 → E_WBS_DEADLINE_OVERFLOW 400 */
  const pd = okData(
    await newNode(pWbsId, { name: 'PD 父', owner: ADMIN_OPEN_ID, estimateDays: 1, dueDate: dayOffset(10) }),
    '[W4] 建 PD 父（due +10）',
  );
  expectError(
    await newNode(pWbsId, { parentId: pd.id, name: 'PD 子超期', owner: ADMIN_OPEN_ID, estimateDays: 1, dueDate: dayOffset(20) }),
    'E_WBS_DEADLINE_OVERFLOW', 400, '[W4] 子 dueDate 晚于父',
  );

  /* 5) dueDate 晚于所属里程碑 currentDate → E_WBS_DEADLINE_OVERFLOW 400 */
  const msOverflow = await newNode(pWbsId, {
    name: '超里程碑', owner: ADMIN_OPEN_ID, estimateDays: 1,
    milestoneId: wbsM1.id, dueDate: dayOffset(40),
  });
  expectError(msOverflow, 'E_WBS_DEADLINE_OVERFLOW', 400, '[W5] dueDate 晚于里程碑 currentDate');
  assertEq(
    msOverflow.json && msOverflow.json.data && msOverflow.json.data.milestoneDue,
    wbsM1.currentDate, '[W5] data.milestoneDue === 里程碑 currentDate',
  );

  /* 6) estimateDays 30 + 区间 5 天 → E_WBS_ESTIMATE_OVERFLOW 400，data.available === 5 */
  const estErr = await newNode(pWbsId, {
    name: '工时超限', owner: ADMIN_OPEN_ID, estimateDays: 30,
    milestoneId: '', startDate: dayOffset(0), dueDate: dayOffset(5),
  });
  expectError(estErr, 'E_WBS_ESTIMATE_OVERFLOW', 400, '[W6] 估算 30 人日 / 区间 5 天');
  assertEq(estErr.json && estErr.json.data && estErr.json.data.available, 5, '[W6] E_WBS_ESTIMATE_OVERFLOW → data.available === 5');

  /* 7) 3 层子树 B1→B2→B3（供 W8 / W13 用） */
  const b1 = okData(await newNode(pWbsId, { name: 'B1 三层根', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[W7] 建 B1');
  const b2 = okData(await newNode(pWbsId, { parentId: b1.id, name: 'B2', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[W7] 建 B2');
  const b3 = okData(await newNode(pWbsId, { parentId: b2.id, name: 'B3', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[W7] 建 B3');

  /* 8) move 到自己后代下 → E_WBS_CYCLE 400 */
  expectError(
    await call('POST', '/api/wbs/' + a1.id + '/move', { newParentId: a2.id }),
    'E_WBS_CYCLE', 400, '[W8] A1 移到后代 A2 下',
  );

  /* 9) 3 层子树移到第 3 层 → E_WBS_DEPTH（subtreeRelativeDepth 生效） */
  const subtreeDepthErr = await call('POST', '/api/wbs/' + b1.id + '/move', { newParentId: a3.id });
  expectError(subtreeDepthErr, 'E_WBS_DEPTH', 400, '[W9] 3 层子树移到第 3 层');
  assertEq(
    subtreeDepthErr.json && subtreeDepthErr.json.data && subtreeDepthErr.json.data.subtreeDepth,
    2, '[W9] data.subtreeDepth === 2（B1 子树相对高度）',
  );

  /* 10) 有子节点的节点改 nodeType → E_WBS_TYPE_LOCKED 400（DoD §5.2 口径） */
  expectError(
    await call('PATCH', '/api/wbs/' + a1.id, { nodeType: 'subtask' }),
    'E_WBS_TYPE_LOCKED', 400, '[W10] 有子节点改 nodeType',
  );

  /* 11) 排序：1.2 必须在 1.10 之前（compareWbsCode 数值分段比较） */
  const ord = okData(await newNode(pWbsId, { name: 'ORD 排序根', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[W11] 建 ORD');
  for (let i = 1; i <= 10; i += 1) {
    await newNode(pWbsId, { parentId: ord.id, name: 'ORD-' + i, owner: ADMIN_OPEN_ID, estimateDays: 1 });
  }
  const ordList = await listWbs(pWbsId);
  const idx2 = ordList.findIndex(function (n) { return n.wbsCode === ord.wbsCode + '.2'; });
  const idx10 = ordList.findIndex(function (n) { return n.wbsCode === ord.wbsCode + '.10'; });
  assert(idx2 >= 0 && idx10 >= 0, '[W11] 已构造 ' + ord.wbsCode + '.2 与 ' + ord.wbsCode + '.10', { idx2: idx2, idx10: idx10 });
  assert(idx2 < idx10, '[W11] GET /wbs 顺序：' + ord.wbsCode + '.2 在 ' + ord.wbsCode + '.10 之前', { idx2: idx2, idx10: idx10 });

  /* 12) 删 x.2 后再建 → 新节点为 x.4（不复用空洞） */
  const gap = okData(await newNode(pWbsId, { name: 'GAP 空洞根', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[W12] 建 GAP');
  const g1 = okData(await newNode(pWbsId, { parentId: gap.id, name: 'G1', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[W12] 建 G1');
  const g2 = okData(await newNode(pWbsId, { parentId: gap.id, name: 'G2', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[W12] 建 G2');
  const g3 = okData(await newNode(pWbsId, { parentId: gap.id, name: 'G3', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[W12] 建 G3');
  assertEq(g3 && g3.wbsCode, gap.wbsCode + '.3', '[W12] G3 → ' + gap.wbsCode + '.3');
  okData(await call('DELETE', '/api/wbs/' + g2.id), '[W12] 删 G2');
  const g4 = okData(await newNode(pWbsId, { parentId: gap.id, name: 'G4', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[W12] 删后再建');
  assertEq(g4 && g4.wbsCode, gap.wbsCode + '.4', '[W12] 新节点 code = ' + gap.wbsCode + '.4（不复用空洞）');
  assert(!!g1 && !!g4, '[W12] G1 / G4 均已落库');

  /* 13) 移动子树 → code 全量重排、level 同步（D13：返回整个项目节点数组） */
  const movedList = okData(await call('POST', '/api/wbs/' + b1.id + '/move', { newParentId: a1.id }), '[W13] B1 移到 A1 下');
  assert(Array.isArray(movedList), '[W13] move 返回整个项目节点数组（D13）');
  const findIn = function (list, id) { return (list || []).filter(function (n) { return n.id === id; })[0] || {}; };
  const b1m = findIn(movedList, b1.id);
  const b2m = findIn(movedList, b2.id);
  const b3m = findIn(movedList, b3.id);
  assertEq(b1m.wbsCode, a1.wbsCode + '.2', '[W13] B1 → ' + a1.wbsCode + '.2');
  assertEq(b2m.wbsCode, a1.wbsCode + '.2.1', '[W13] B2 → ' + a1.wbsCode + '.2.1');
  assertEq(b3m.wbsCode, a1.wbsCode + '.2.1.1', '[W13] B3 → ' + a1.wbsCode + '.2.1.1');
  assertEq(b1m.level, 2, '[W13] B1 level 同步为 2');
  assertEq(b2m.level, 3, '[W13] B2 level 同步为 3');
  assertEq(b3m.level, 4, '[W13] B3 level 同步为 4');

  /* 14) 删父节点 → 整棵子树消失（A1 子树共 7 节点） */
  const beforeDel = await listWbs(pWbsId);
  okData(await call('DELETE', '/api/wbs/' + a1.id), '[W14] 删 A1');
  const afterDel = await listWbs(pWbsId);
  assertEq(afterDel.length, beforeDel.length - 7, '[W14] 删父 → 整棵子树（7 节点）级联消失');
  assertEq(afterDel.filter(function (n) { return n.id === b3.id; }).length, 0, '[W14] 深层后代 B3 已被级联删除');

  /* ═══════════════════════════════════════════════
   * ② 看板（§5.2 · 6 条）
   * ═══════════════════════════════════════════════ */
  console.log('\n② 看板');
  const pBoard = await createProject('BOARD', [
    { code: 'M1', name: '启动', date: dayOffset(30), required: true, gate: null },
  ]);
  const pBoardId = pBoard.id;

  /* 1) GET /board → 4 列、config.wipLimits['进行中'] === 5 */
  const board0 = okData(await call('GET', '/api/projects/' + pBoardId + '/board'), '[B1] GET /board');
  assertEq(board0 && board0.columns && board0.columns.length, 4, '[B1] 看板 4 列');
  assertEq(
    (board0.columns || []).map(function (c) { return c.status; }).join('/'),
    '待办/进行中/待评审/完成', '[B1] 列名与顺序 = 待办/进行中/待评审/完成',
  );
  assertEq(board0 && board0.config && board0.config.wipLimits && board0.config.wipLimits['进行中'], 5, '[B1] wipLimits[进行中] === 5');

  /* 2) SK-4 卡片 = 真叶子：叶子加子后自身从看板消失、子节点出现 */
  const k1 = okData(await newNode(pBoardId, { name: 'K1', owner: ADMIN_OPEN_ID, estimateDays: 4 }), '[B2] 建 K1');
  const boardK1 = okData(await call('GET', '/api/projects/' + pBoardId + '/board'), '[B2] 建 K1 后看板');
  const cardIds = function (bv) {
    const out = [];
    (bv.columns || []).forEach(function (c) { (c.cards || []).forEach(function (t) { out.push(t.id); }); });
    return out;
  };
  assert(cardIds(boardK1).indexOf(k1.id) >= 0, '[B2] K1 是叶子 → 出现在看板');
  const k11 = okData(await newNode(pBoardId, { parentId: k1.id, name: 'K1.1', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[B2] 建 K1.1');
  const k12 = okData(await newNode(pBoardId, { parentId: k1.id, name: 'K1.2', owner: ADMIN_OPEN_ID, estimateDays: 3 }), '[B2] 建 K1.2');
  const boardK11 = okData(await call('GET', '/api/projects/' + pBoardId + '/board'), '[B2] 加子后看板');
  assert(cardIds(boardK11).indexOf(k1.id) < 0, '[B2] SK-4：K1 有子后从看板消失');
  assert(cardIds(boardK11).indexOf(k11.id) >= 0, '[B2] SK-4：子节点 K1.1 出现在看板');
  assert(cardIds(boardK11).indexOf(k12.id) >= 0, '[B2] SK-4：子节点 K1.2 出现在看板');

  /* 3) 拖到「完成」→ 卡 progress===100，父节点按 estimateDays 加权上升 */
  const afterDone = okData(
    await call('POST', '/api/wbs/' + k11.id + '/move-status', { status: '完成', order: 0 }),
    '[B3] K1.1 拖到「完成」',
  );
  const doneCol = (afterDone.columns || []).filter(function (c) { return c.status === '完成'; })[0] || {};
  const k11Card = (doneCol.cards || []).filter(function (c) { return c.id === k11.id; })[0] || {};
  assertEq(k11Card.progress, 100, '[B3] 拖到完成 → 卡 progress === 100');
  const wbsAfterDone = await listWbs(pBoardId);
  const k1After = wbsAfterDone.filter(function (n) { return n.id === k1.id; })[0] || {};
  assertEq(k1After.progress, 25, '[B3] 父节点加权进度 = (1×100 + 3×0) / 4 = 25');
  assertEq(k1After.status, '进行中', '[B3] 父节点状态按弱规则收敛为「进行中」');

  /* 4) 拖到「进行中」但 progress 已 100 → 强规则收敛回「完成」 */
  const afterConverge = okData(
    await call('POST', '/api/wbs/' + k11.id + '/move-status', { status: '进行中', order: 0 }),
    '[B4] K1.1 拖到「进行中」（progress=100）',
  );
  const colOf = function (bv, status) {
    return (bv.columns || []).filter(function (c) { return c.status === status; })[0] || { cards: [] };
  };
  assertEq(
    colOf(afterConverge, '进行中').cards.filter(function (c) { return c.id === k11.id; }).length,
    0, '[B4] 强规则：progress=100 时不会停留在「进行中」',
  );
  assertEq(
    colOf(afterConverge, '完成').cards.filter(function (c) { return c.id === k11.id; }).length,
    1, '[B4] syncNodeStatusFromProgress 把它收敛回「完成」',
  );

  /* 5) 第 6 张卡拖进「进行中」→ E_WIP_EXCEEDED 409，data.limit === 5
   *
   * ⚠ 双引擎一致性要点（强规则 vs WIP）：
   *   `syncNodeStatusFromProgress` 规则 2「progress===0 且 status∈{进行中,完成} → 待办」
   *   会在每次写操作收尾时把 **progress=0 的卡片从「进行中」踢回「待办」**。
   *   所以直接建 progress=0 的叶子再拖进「进行中」，卡片根本停不住，
   *   WIP 计数恒为 0，第 6 张永远不会被拦 —— 这不是 WIP 的 Bug，是测试姿势不对。
   *
   * 正确造数路径（利用「待评审」不被强规则覆盖的特性）：
   *   建叶子(progress 0/待办) → 拖到「待评审」暂存 → PATCH progress=50（待评审态稳定）
   *   → 再拖进「进行中」，此时 0<50<100 且 status 已是「进行中」，规则 3 不覆盖 → 稳定停留。
   *
   * 独立建项目，避免前面 B1~B4 的卡片污染 WIP 计数。
   */
  const pWip = await createProject('WIP', [
    { code: 'M1', name: '启动', date: dayOffset(30), required: true, gate: null },
  ]);
  const pWipId = pWip.id;
  const wipNodes = [];
  for (let i = 1; i <= 6; i += 1) {
    const n = okData(
      await newNode(pWipId, { name: 'WIP-' + i, owner: ADMIN_OPEN_ID, estimateDays: 1 }),
      '[B5] 建 WIP-' + i,
    );
    /* 暂存到「待评审」：待评审不被 syncNodeStatusFromProgress 覆盖（除规则 1） */
    await call('POST', '/api/wbs/' + n.id + '/move-status', { status: '待评审', order: i });
    /* 提 progress 到 50，让它之后能稳定停在「进行中」 */
    await call('PATCH', '/api/wbs/' + n.id, { progress: 50 });
    wipNodes.push(n);
  }
  const boardWip0 = okData(await call('GET', '/api/projects/' + pWipId + '/board'), '[B5] WIP 项目初始看板');
  const colOfWip = function (bv, status) {
    return (bv.columns || []).filter(function (c) { return c.status === status; })[0] || { cards: [] };
  };
  assertEq(colOfWip(boardWip0, '进行中').cards.length, 0, '[B5] 造数后「进行中」为空（干净起点）');
  assertEq(colOfWip(boardWip0, '待评审').cards.length, 6, '[B5] 6 张卡暂存在「待评审」');

  for (let i = 0; i < 5; i += 1) {
    const r = await call('POST', '/api/wbs/' + wipNodes[i].id + '/move-status', { status: '进行中', order: i });
    assertEq(r.json && r.json.code, 0, '[B5] 第 ' + (i + 1) + ' 张卡进「进行中」成功');
    const bv = (r.json && r.json.data) || {};
    assertEq(
      colOfWip(bv, '进行中').cards.length, i + 1,
      '[B5] 第 ' + (i + 1) + ' 张后「进行中」稳定停留 ' + (i + 1) + ' 张（progress=50 不被强规则踢回）',
    );
  }
  const wipErr = await call('POST', '/api/wbs/' + wipNodes[5].id + '/move-status', { status: '进行中', order: 5 });
  expectError(wipErr, 'E_WIP_EXCEEDED', 409, '[B5] 第 6 张卡进「进行中」');
  assertEq(wipErr.json && wipErr.json.data && wipErr.json.data.limit, 5, '[B5] E_WIP_EXCEEDED → data.limit === 5');
  assertEq(wipErr.json && wipErr.json.data && wipErr.json.data.current, 5, '[B5] E_WIP_EXCEEDED → data.current === 5');

  /* 6) PATCH /board-config 改 WIP → GET /board 立刻反映 */
  const cfg = okData(
    await call('PATCH', '/api/projects/' + pBoardId + '/board-config', { wipLimits: { 进行中: 9, 待评审: 3 } }),
    '[B6] PATCH /board-config',
  );
  assertEq(cfg && cfg.wipLimits && cfg.wipLimits['进行中'], 9, '[B6] 返回 BoardConfig（不是 BoardView）· wipLimits[进行中] === 9');
  assert(!cfg.columns || !Array.isArray(cfg.columns) || cfg.columns.length === 4, '[B6] BoardConfig.columns 形状正常');
  const boardAfterCfg = okData(await call('GET', '/api/projects/' + pBoardId + '/board'), '[B6] 改配置后 GET /board');
  assertEq(colOf(boardAfterCfg, '进行中').wipLimit, 9, '[B6] GET /board 立刻反映新 WIP = 9');
  assertEq(colOf(boardAfterCfg, '待评审').wipLimit, 3, '[B6] GET /board 反映「待评审」WIP = 3');

  /* ═══════════════════════════════════════════════
   * ③ 里程碑（§5.2 · 8 条）
   * ═══════════════════════════════════════════════ */
  console.log('\n③ 里程碑编辑');
  const pMs = await createProject('MS', [
    { code: 'M1', name: '启动', date: dayOffset(20), required: true, gate: null },
    {
      code: 'M2', name: '需求基线', date: dayOffset(40), required: true,
      gate: {
        code: 'QG2', name: '需求质量门', ownerRole: 'pmo',
        items: [{ content: '需求规格已评审', ownerRole: 'pmo' }, { content: '需求基线已冻结', ownerRole: 'cm' }],
      },
    },
    { code: 'M3', name: '设计评审', date: dayOffset(60), required: false, gate: null },
  ]);
  const pMsId = pMs.id;
  let msList = await listMilestones(pMsId);
  const ms1 = msList[0] || {};
  const ms2 = msList[1] || {};
  const ms3 = msList[2] || {};
  assertEq(msList.length, 3, '[M0] 建项落 3 个里程碑');

  /* 挂一个 WBS 节点在 M1（供 M8 解绑验证） */
  const msTask = okData(
    await newNode(pMsId, { name: 'M1 关联任务', owner: ADMIN_OPEN_ID, estimateDays: 1, milestoneId: ms1.id }),
    '[M0] 建 M1 关联任务',
  );

  /* 1) POST /milestones → code = M{n+1}，required === false，gate === null */
  const newMs = okData(
    await call('POST', '/api/projects/' + pMsId + '/milestones', { name: '新增碑', date: dayOffset(90) }),
    '[M1] POST /milestones',
  );
  assertEq(newMs && newMs.code, 'M4', '[M1] 新碑 code === M4');
  assertEq(newMs && newMs.required, false, '[M1] 新碑 required === false');
  assertEq(newMs && newMs.gate, null, '[M1] K-1：新碑不自动建门（gate === null）');
  assert(Array.isArray(newMs && newMs.gateItems) && newMs.gateItems.length === 0, '[M1] 新碑 gateItems 为空数组');

  /* 2) code 序列恒为 M1..Mn 且按 currentDate 升序 */
  msList = await listMilestones(pMsId);
  assertEq(
    msList.map(function (m) { return m.code; }).join(','),
    'M1,M2,M3,M4', '[M2] code 序列恒为 M1..Mn',
  );
  const ascending = msList.every(function (m, i) { return i === 0 || msList[i - 1].currentDate <= m.currentDate; });
  assert(ascending, '[M2] 按 currentDate 升序', msList.map(function (m) { return m.code + '@' + m.currentDate; }));

  /* 3) PATCH 延后 → 409 E_MS_NEED_CHANGE + data.changeDraft.{fromDate,toDate} */
  const delay = await call('PATCH', '/api/milestones/' + ms3.id, { currentDate: dayOffset(70) });
  expectError(delay, 'E_MS_NEED_CHANGE', 409, '[M3] 里程碑延后');
  const draft = (delay.json && delay.json.data && delay.json.data.changeDraft) || null;
  assert(!!draft, '[M3] data.changeDraft 存在');
  /* 实测契约：日期对嵌在 changeDraft.payload 下，不是 changeDraft 顶层 */
  const draftPayload = (draft && draft.payload) || {};
  assertEq(draftPayload.fromDate, ms3.currentDate, '[M3] changeDraft.payload.fromDate === 原 currentDate');
  assertEq(draftPayload.toDate, dayOffset(70), '[M3] changeDraft.payload.toDate === 目标日期');
  assertEq(draft && draft.targetType, 'milestone', '[M3] changeDraft.targetType === milestone');
  assertEq(draft && draft.targetId, ms3.id, '[M3] changeDraft.targetId === 里程碑 id');
  assertEq(draft && draft.projectId, pMsId, '[M3] changeDraft.projectId 正确');

  /* 4) statusOverride 枚举不含「已达成」→ E_VALIDATION 400 */
  expectError(
    await call('PATCH', '/api/milestones/' + ms3.id, { statusOverride: '已达成' }),
    'E_VALIDATION', 400, '[M4] statusOverride = 已达成',
  );

  /* 5) statusOverride = 已逾期 → status === 已逾期 */
  const overridden = okData(
    await call('PATCH', '/api/milestones/' + ms3.id, { statusOverride: '已逾期' }),
    '[M5] statusOverride = 已逾期',
  );
  assertEq(overridden && overridden.status, '已逾期', '[M5] 人工覆盖生效 → status === 已逾期');

  /* 6) 改期提前 → 200，override 失效、statusOverride 清空、code 重排幂等 */
  const advanced = okData(
    await call('PATCH', '/api/milestones/' + ms3.id, { currentDate: dayOffset(50) }),
    '[M6] 里程碑提前改期',
  );
  assertEq(advanced && advanced.currentDate, dayOffset(50), '[M6] currentDate 已更新');
  assertEq(advanced && advanced.statusOverride, null, '[M6] statusOverride 被清空');
  assert(advanced && advanced.status !== '已逾期', '[M6] override 失效 → status 回归派生值', { status: advanced && advanced.status });
  const afterAdvance = await listMilestones(pMsId);
  assertEq(
    afterAdvance.map(function (m) { return m.code; }).join(','),
    'M1,M2,M3,M4', '[M6] 改期后 code 仍为 M1..Mn（重排幂等）',
  );

  /* 7) achieved:true → doneAt 非空 / status 已达成 / done true，且不卡质量门（D12） */
  const achieved = await call('PATCH', '/api/milestones/' + ms2.id, { achieved: true });
  const achievedData = okData(achieved, '[M7] PATCH achieved=true');
  assert(!!(achievedData && achievedData.doneAt), '[M7] doneAt 非空', { doneAt: achievedData && achievedData.doneAt });
  assertEq(achievedData && achievedData.status, '已达成', '[M7] status === 已达成');
  assertEq(achievedData && achievedData.done, true, '[M7] done === true');
  assert(
    !(achieved.json && String(achieved.json.code).indexOf('E_GATE') === 0),
    '[M7] D12：门未勾齐也不报 E_GATE_NOT_PASSED',
  );
  assert(
    !!(achievedData && achievedData.gate) && achievedData.gate.status !== '已通过',
    '[M7] M2 的门确实仍未通过（证明 achieved 不受门约束）',
    { gateStatus: achievedData && achievedData.gate && achievedData.gate.status },
  );

  /* 8) DELETE /milestones/:id → WBS 节点仅解绑不删除（SK-12）+ 剩余 code 重排 */
  okData(await call('DELETE', '/api/milestones/' + ms1.id), '[M8] DELETE M1');
  const wbsAfterMsDel = await listWbs(pMsId);
  const taskAfter = wbsAfterMsDel.filter(function (n) { return n.id === msTask.id; })[0] || null;
  assert(!!taskAfter, '[M8] SK-12：关联 WBS 节点仍在（未被级联删除）');
  assertEq(taskAfter && taskAfter.milestoneId, null, '[M8] SK-12：milestoneId 被置为 null');
  const msAfterDel = await listMilestones(pMsId);
  assertEq(msAfterDel.length, 3, '[M8] 剩余 3 个里程碑');
  assertEq(
    msAfterDel.map(function (m) { return m.code; }).join(','),
    'M1,M2,M3', '[M8] 剩余 code 重排为 M1..Mn-1',
  );

  /* ═══════════════════════════════════════════════
   * ④ 质量门（§5.2 · 6 条）
   * ═══════════════════════════════════════════════ */
  console.log('\n④ 质量门');
  const mkGate = function (code, name) {
    return {
      code: code, name: name, ownerRole: 'pmo',
      items: [{ content: code + ' 检查项一', ownerRole: 'pmo' }, { content: code + ' 检查项二', ownerRole: 'qa' }],
    };
  };
  const pGate = await createProject('GATE', [
    { code: 'M1', name: '启动', date: dayOffset(20), required: true, gate: mkGate('QG1', '立项质量门') },
    { code: 'M2', name: '需求', date: dayOffset(40), required: true, gate: mkGate('QG2', '需求质量门') },
    { code: 'M3', name: '设计', date: dayOffset(60), required: true, gate: mkGate('QG3', '设计质量门') },
  ]);
  const pGateId = pGate.id;
  let gList = await listMilestones(pGateId);
  const gM1 = gList[0] || {};
  const gM2 = gList[1] || {};
  const gM3 = gList[2] || {};
  assert(!!(gM1.gate && gM1.gateItems && gM1.gateItems.length === 2), '[G0] M1 带门 + 2 条检查项');

  const pickMs = function (list, id) { return (list || []).filter(function (m) { return m.id === id; })[0] || {}; };

  /* 1) 勾选检查项 → checked === true、checkedBy 非空（返回整表 MilestoneWithGate[]） */
  const toggled = okData(
    await call('PATCH', '/api/gate-items/' + gM1.gateItems[0].id, { checked: true }),
    '[G1] PATCH /gate-items 勾选',
  );
  assert(Array.isArray(toggled), '[G1] toggleGateItem 返回 MilestoneWithGate[]（整表回灌）');
  const item0 = (pickMs(toggled, gM1.id).gateItems || []).filter(function (i) { return i.id === gM1.gateItems[0].id; })[0] || {};
  assertEq(item0.checked, true, '[G1] 该项 checked === true');
  assert(!!item0.checkedBy, '[G1] checkedBy 非空', { checkedBy: item0.checkedBy });

  /* 2) 未勾齐 + 「已通过」→ E_GATE_ITEM_INCOMPLETE + data.unchecked 非空 */
  const incomplete = await call('POST', '/api/projects/' + pGateId + '/gates/' + gM2.gate.id + '/decide', { conclusion: '已通过' });
  expectError(incomplete, 'E_GATE_ITEM_INCOMPLETE', 409, '[G2] 未勾齐提交「已通过」');
  const unchecked = (incomplete.json && incomplete.json.data && incomplete.json.data.unchecked) || null;
  assert(Array.isArray(unchecked) && unchecked.length === 2, '[G2] data.unchecked 是非空数组（2 条）', unchecked);
  assert(!!(unchecked && unchecked[0] && unchecked[0].content), '[G2] unchecked 项带 content');

  /* 3) 未勾齐 + 「不通过」→ 成功（例外分支） */
  const rejected = okData(
    await call('POST', '/api/projects/' + pGateId + '/gates/' + gM3.gate.id + '/decide', { conclusion: '不通过', comment: '冒烟' }),
    '[G3] 未勾齐提交「不通过」',
  );
  assertEq(pickMs(rejected, gM3.id).gate.status, '不通过', '[G3] 例外分支：不勾齐也能下「不通过」结论');
  assert(!pickMs(rejected, gM3.id).doneAt, '[G3] 「不通过」不触发里程碑达成');

  /* 4) 勾齐后「已通过」→ 门 status 已通过 + 里程碑自动达成 */
  await call('PATCH', '/api/gate-items/' + gM1.gateItems[1].id, { checked: true });
  const passed1 = okData(
    await call('POST', '/api/projects/' + pGateId + '/gates/' + gM1.gate.id + '/decide', { conclusion: '已通过' }),
    '[G4] 勾齐后提交「已通过」',
  );
  const gM1After = pickMs(passed1, gM1.id);
  assertEq(gM1After.gate && gM1After.gate.status, '已通过', '[G4] 门 status === 已通过');
  assert(!!gM1After.doneAt, '[G4] 里程碑 doneAt 自动写入', { doneAt: gM1After.doneAt });
  assertEq(gM1After.status, '已达成', '[G4] 里程碑 status === 已达成');
  assertEq(gM1After.done, true, '[G4] 里程碑 done === true');

  /* 5) 重复决策 → doneAt 幂等不变 */
  const firstDoneAt = gM1After.doneAt;
  const passed2 = okData(
    await call('POST', '/api/projects/' + pGateId + '/gates/' + gM1.gate.id + '/decide', { conclusion: '已通过' }),
    '[G5] 重复提交「已通过」',
  );
  assertEq(pickMs(passed2, gM1.id).doneAt, firstDoneAt, '[G5] 幂等：doneAt 不变');

  /* 6) 「有条件通过」同样触发达成（GATE_PASSED_STATUSES） */
  gList = await listMilestones(pGateId);
  const gM2Items = pickMs(gList, gM2.id).gateItems || [];
  for (let i = 0; i < gM2Items.length; i += 1) {
    await call('PATCH', '/api/gate-items/' + gM2Items[i].id, { checked: true });
  }
  const conditional = okData(
    await call('POST', '/api/projects/' + pGateId + '/gates/' + gM2.gate.id + '/decide', { conclusion: '有条件通过' }),
    '[G6] 提交「有条件通过」',
  );
  const gM2After = pickMs(conditional, gM2.id);
  assertEq(gM2After.gate && gM2After.gate.status, '有条件通过', '[G6] 门 status === 有条件通过');
  assert(!!gM2After.doneAt, '[G6] 有条件通过同样触发里程碑达成', { doneAt: gM2After.doneAt });
  assertEq(gM2After.status, '已达成', '[G6] 里程碑 status === 已达成');

  /* ═══════════════════════════════════════════════
   * ⑦ 联动（§5.2 · 2 条）—— 放在 RBAC 之前，避免归档影响
   * ═══════════════════════════════════════════════ */
  console.log('\n⑤ 联动（口径 Y / taskStats）');
  const pLink = await createProject('LINK', [
    { code: 'M1', name: '启动', date: dayOffset(20), required: true, gate: null },
    { code: 'M2', name: '需求', date: dayOffset(40), required: true, gate: null },
    { code: 'M3', name: '设计', date: dayOffset(60), required: true, gate: null },
  ]);
  const pLinkId = pLink.id;
  const linkMs = await listMilestones(pLinkId);
  const lM2 = linkMs[1] || {};
  const lM3 = linkMs[2] || {};

  /* 1) 3 个挂 M2 的叶子全部完成 → total 3 / done 3 / progress 100 */
  for (let i = 1; i <= 3; i += 1) {
    const n = okData(
      await newNode(pLinkId, { name: 'M2 任务' + i, owner: ADMIN_OPEN_ID, estimateDays: 1, milestoneId: lM2.id }),
      '[L1] 建 M2 任务' + i,
    );
    const mv = await call('POST', '/api/wbs/' + n.id + '/move-status', { status: '完成', order: i });
    assertEq(mv.json && mv.json.code, 0, '[L1] M2 任务' + i + ' 拖到完成');
  }
  const linkAfter = await listMilestones(pLinkId);
  const lM2After = (linkAfter.filter(function (m) { return m.id === lM2.id; })[0] || {}).taskStats || {};
  assertEq(lM2After.total, 3, '[L1] M2 taskStats.total === 3');
  assertEq(lM2After.done, 3, '[L1] M2 taskStats.done === 3');
  assertEq(lM2After.progress, 100, '[L1] M2 taskStats.progress === 100');

  /* 2) 口径 Y：骨架 task 拆两子 → total 含骨架自身（3），progress 只按真叶子加权 */
  const skeleton = okData(
    await newNode(pLinkId, {
      name: 'M3 骨架任务', owner: ADMIN_OPEN_ID, estimateDays: 10,
      milestoneId: lM3.id, startDate: dayOffset(0), dueDate: dayOffset(20),
    }),
    '[L2] 建 M3 骨架任务',
  );
  const leaf1 = okData(
    await newNode(pLinkId, { parentId: skeleton.id, name: '子任务甲', owner: ADMIN_OPEN_ID, estimateDays: 2 }),
    '[L2] 建 子任务甲（est 2）',
  );
  const leaf2 = okData(
    await newNode(pLinkId, { parentId: skeleton.id, name: '子任务乙', owner: ADMIN_OPEN_ID, estimateDays: 3 }),
    '[L2] 建 子任务乙（est 3）',
  );
  assert(!!leaf2, '[L2] 两个子任务均已落库');
  const mvLeaf1 = await call('POST', '/api/wbs/' + leaf1.id + '/move-status', { status: '完成', order: 0 });
  assertEq(mvLeaf1.json && mvLeaf1.json.code, 0, '[L2] 子任务甲拖到完成');

  const linkAfter2 = await listMilestones(pLinkId);
  const lM3Stats = (linkAfter2.filter(function (m) { return m.id === lM3.id; })[0] || {}).taskStats || {};
  assertEq(lM3Stats.total, 3, '[L2] 口径 Y：total === 3（骨架自身 + 2 子）');
  assertEq(lM3Stats.progress, 40, '[L2] 口径 Y：progress 只按真叶子加权 = (2×100 + 3×0) / 5 = 40');
  assertEq(lM3Stats.done, 1, '[L2] 口径 Y：done === 1（仅子任务甲 progress≥100）');
  const linkNodes = await listWbs(pLinkId);
  const skAfter = linkNodes.filter(function (n) { return n.id === skeleton.id; })[0] || {};
  assertEq(skAfter.progress, 40, '[L2] rollupProgressFlat：骨架节点自身 progress 回写为 40');

  /* ═══════════════════════════════════════════════
   * ⑤ 成员写（§5.2 · 4 条）+ ⑥ RBAC（3 条）
   * ═══════════════════════════════════════════════ */
  console.log('\n⑥ 成员写 + RBAC');
  const pMem = await createProject('MEMBER', [
    { code: 'M1', name: '启动', date: dayOffset(30), required: true, gate: null },
  ]);
  const pMemId = pMem.id;
  const memNode = okData(await newNode(pMemId, { name: 'RBAC 任务', owner: ADMIN_OPEN_ID, estimateDays: 1 }), '[R0] 建 RBAC 任务');

  const members0 = okData(await call('GET', '/api/projects/' + pMemId + '/members'), '[MB0] GET /members');
  assert(Array.isArray(members0), '[MB0] members data 直接是数组');
  const baseCount = members0.length;

  /* 1) 追加第二个 pm → E_ROLE_CARDINALITY 400 */
  expectError(
    await call('POST', '/api/projects/' + pMemId + '/members', { userOpenId: MEMBER2_OPEN_ID, role: 'pm' }),
    'E_ROLE_CARDINALITY', 400, '[MB1] 追加第二个 PM',
  );

  /* 2) 加普通成员 → 200，条数 +1，userName 非空 */
  const added = okData(
    await call('POST', '/api/projects/' + pMemId + '/members', { userOpenId: MEMBER2_OPEN_ID, role: 'member' }),
    '[MB2] 加普通成员',
  );
  assert(!!(added && added.id), '[MB2] 返回 ProjectMember.id');
  assert(!!(added && added.userName), '[MB2] userName 非空', { userName: added && added.userName });
  const members1 = okData(await call('GET', '/api/projects/' + pMemId + '/members'), '[MB2] 加后 GET /members');
  assertEq(members1.length, baseCount + 1, '[MB2] 成员条数 +1');

  /* 3) 删 tl → E_ROLE_CARDINALITY 400 */
  /* 契约：ProjectMember 的角色字段是 projectRole（不是 role），见 mappers.toApiMember */
  assert(
    members1.every(function (m) { return typeof m.projectRole === 'string' && m.projectRole; }),
    '[MB3] 成员对象角色字段为 projectRole',
  );
  const tlRow = members1.filter(function (m) { return m.projectRole === 'tl'; })[0] || {};
  assert(!!tlRow.id, '[MB3] 找到 TL 成员行', { roles: members1.map(function (m) { return m.projectRole; }) });
  expectError(
    await call('DELETE', '/api/projects/' + pMemId + '/members/' + tlRow.id),
    'E_ROLE_CARDINALITY', 400, '[MB3] 移除必备角色 TL',
  );

  /* 4) 删普通成员 → 200，条数 -1 */
  const rmOk = await call('DELETE', '/api/projects/' + pMemId + '/members/' + added.id);
  assertEq(rmOk.json && rmOk.json.code, 0, '[MB4] 移除普通成员 → code 0');
  assertEq(rmOk.json && rmOk.json.data, null, '[MB4] removeMember 返回 null');
  const members2 = okData(await call('GET', '/api/projects/' + pMemId + '/members'), '[MB4] 删后 GET /members');
  assertEq(members2.length, baseCount, '[MB4] 成员条数 -1');

  /* RBAC-1 / RBAC-2：普通 member 账号（非项目成员） */
  await loginAs(MEMBER_OPEN_ID);
  const meMember = okData(await call('GET', '/api/auth/me'), '[R1] 切换到 member 账号');
  assertEq(meMember && meMember.globalRole, 'member', '[R1] globalRole === member');

  expectError(
    await newNode(pMemId, { name: '越权建任务', owner: MEMBER_OPEN_ID, estimateDays: 1 }),
    'E_FORBIDDEN', 403, '[R1] member 建 WBS 节点',
  );

  const moveByMember = await call('POST', '/api/wbs/' + memNode.id + '/move-status', { status: '进行中', order: 0 });
  assertEq(moveByMember.json && moveByMember.json.code, 0, '[R2] member 拖看板卡片成功（task:status 全角色开放）');

  /* RBAC-3：项目归档后任意 WBS 写 → E_PROJECT_ARCHIVED 403（DoD §4.5 / §5.2 口径） */
  await loginAs(ADMIN_OPEN_ID);
  archiveProjectViaDb(pMemId);
  const archivedProject = okData(await call('GET', '/api/projects/' + pMemId), '[R3] 归档后 GET 项目');
  assertEq(archivedProject && archivedProject.status, '已结项', '[R3] 项目已置为「已结项」');

  expectError(
    await newNode(pMemId, { name: '归档后建任务', owner: ADMIN_OPEN_ID, estimateDays: 1 }),
    'E_PROJECT_ARCHIVED', 403, '[R3] 归档项目建 WBS 节点',
  );
  expectError(
    await call('PATCH', '/api/wbs/' + memNode.id, { name: '归档后改名' }),
    'E_PROJECT_ARCHIVED', 403, '[R3] 归档项目改 WBS 节点',
  );
  expectError(
    await call('POST', '/api/wbs/' + memNode.id + '/move-status', { status: '完成', order: 0 }),
    'E_PROJECT_ARCHIVED', 403, '[R3] 归档项目拖看板',
  );

  /* D11 例外：updateBoardConfig 在归档项目上**仍可写**（照抄 Mock 引擎，不是 bug） */
  const cfgArchived = await call('PATCH', '/api/projects/' + pMemId + '/board-config', { wipLimits: { 进行中: 4 } });
  assertEq(cfgArchived.json && cfgArchived.json.code, 0, '[R3·D11] 归档项目仍可改看板配置（唯一例外，与 Mock 一致）');

  /* ── 汇总 ─────────────────────────────────────── */
  console.log('\n────────────────────────────────');
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  if (failed) {
    console.log('\n失败明细：');
    failures.forEach(function (f, i) { console.log('  ' + (i + 1) + '. ' + f); });
  }
  console.log('测试项目：' + [pWbsId, pBoardId, pMsId, pGateId, pLinkId, pMemId].join(' / '));
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
  console.error('\n[smoke:b3] 脚本异常终止：', e && e.stack ? e.stack : e);
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  process.exit(1);
});
