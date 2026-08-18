#!/usr/bin/env node
/**
 * QA 独立补充测试 · B4 / T02 + T03 —— 边界与错误路径
 *
 * 定位：工程师的 `smoke_b4.mjs` 走的是「happy path + 3 个错误码」，本脚本补它**没覆盖**的：
 *
 *  【U】`dates.weekRange` 纯函数单测（ISO 跨年周 / 非法编码 / 一位数周号）
 *  【A】鉴权与项目守卫（未登录 / 不存在项目 / 归档项目）
 *  【V】提交强校验的各类缺段组合（缺描述 / 缺截止 / 多行 / 纯空白 / 空风险段 / 草稿不校验）
 *  【S】快照冻结（提交后改 WBS 节点进度，已提交报告的 snapshot 与 tasks 不得漂移）
 *  【L】同周多次提交取最新 + 列表排序
 *  【P】RBAC 越权矩阵（作者本人 / admin / 他人；跨项目 URL 改他人报告）
 *  【N】数值与引用归一（进度越界裁剪 / 未知 nodeId / 跨项目 nodeId 回写探针）
 *  【F】飞书 Web OAuth 降级链路（停用账号 / 未知 openId / 空哨兵 / 大小写 / token 可用性）
 *
 * 用法：
 *   DB_PATH=./qa_b4.db node scripts/qa_b4_edge.mjs [baseUrl]
 *
 * 退出码：0 = 全绿；1 = 有断言失败
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const BASE = (process.argv[2] || process.env.SMOKE_BASE || 'http://127.0.0.1:3399').replace(/\/$/, '');
const DB_FILE = process.env.DB_PATH || './qa_b4.db';

const ADMIN_OPEN_ID = 'ou_xuwenbin01';   // globalRole = admin
const TL_OPEN_ID = 'ou_wangqiang02';     // globalRole = tl
const MEMBER_OPEN_ID = 'ou_wudi09';      // globalRole = member（周报作者）
const MEMBER2_OPEN_ID = 'ou_zhengshuang10'; // globalRole = member（越权反面）

let passed = 0;
let failed = 0;
const failures = [];
/** 非致命观察项（设计如此但值得记录，不计入失败） */
const notes = [];

/**
 * 基础断言。
 * @param {boolean} cond
 * @param {string} label
 * @param {*} [detail]
 * @returns {void}
 */
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

/**
 * 相等断言。
 * @param {*} actual
 * @param {*} expected
 * @param {string} label
 * @returns {void}
 */
function assertEq(actual, expected, label) {
  assert(actual === expected, label, { expected: expected, actual: actual });
}

/**
 * 记录观察项（不影响通过率）。
 * @param {string} text
 * @returns {void}
 */
function note(text) {
  notes.push(text);
  console.log('  \u24d8 ' + text);
}

/* ── HTTP ───────────────────────────────────────────── */

let token = '';

/**
 * 发请求并解析信封。
 * @param {string} method
 * @param {string} pathname
 * @param {*} [body]
 * @param {?string} [overrideToken] 显式指定令牌（null = 不带鉴权头）
 * @returns {Promise<{status:number, json:any}>}
 */
async function call(method, pathname, body, overrideToken) {
  const headers = { 'Content-Type': 'application/json' };
  const tk = overrideToken === undefined ? token : overrideToken;
  if (tk) headers.Authorization = 'Bearer ' + tk;
  const res = await fetch(BASE + pathname, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = { __parseError: true, raw: text.slice(0, 200) }; }
  return { status: res.status, json: json };
}

/**
 * 断言失败信封命中指定错误码 + HTTP 状态。
 * @param {{status:number, json:any}} r
 * @param {string} code
 * @param {number} httpStatus
 * @param {string} label
 * @returns {void}
 */
function expectError(r, code, httpStatus, label) {
  assertEq(r.status, httpStatus, label + ' → HTTP ' + httpStatus);
  assertEq(r.json && r.json.code, code, label + ' → code ' + code);
}

/**
 * 登录切号，返回 token。
 * @param {string} openId
 * @returns {Promise<string>}
 */
async function loginAs(openId) {
  const r = await call('POST', '/api/auth/devlogin', { openId: openId }, null);
  token = (r.json && r.json.data && r.json.data.token) || '';
  return token;
}

/**
 * 今天 + n 天 → YYYY-MM-DD
 * @param {number} n
 * @returns {string}
 */
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const STAMP = Date.now();

/**
 * 建项目。
 * @param {string} tag
 * @param {number} msCount
 * @returns {Promise<object>}
 */
async function createProject(tag, msCount) {
  const milestones = [];
  for (let i = 1; i <= msCount; i += 1) {
    milestones.push({ code: 'M' + i, name: '碑' + i, target: 'T' + i, required: true, date: dayOffset(20 * i) });
  }
  const r = await call('POST', '/api/projects', {
    name: 'QA·边界·' + tag + ' ' + STAMP,
    type: 'A',
    customer: 'QA',
    contractAmount: 100,
    background: 'qa_b4_edge fixture',
    goal: ['边界验证'],
    planStart: dayOffset(0),
    planEnd: dayOffset(200),
    pm: ADMIN_OPEN_ID,
    classifyInput: {
      contractAmount: 100, hasHardware: true, hasAcceptance: true, isSelfIteration: false, isInfrastructure: false,
    },
    classifySuggested: 'A',
    classifyOverrideReason: '',
    members: [
      { userOpenId: ADMIN_OPEN_ID, role: 'pm' },
      { userOpenId: TL_OPEN_ID, role: 'tl' },
      { userOpenId: MEMBER_OPEN_ID, role: 'member' },
    ],
    milestones: milestones,
  });
  if (!r.json || r.json.code !== 0) {
    console.error('建项失败：', JSON.stringify(r.json));
    process.exit(1);
  }
  return r.json.data;
}

/**
 * 组装一份合法的提交 payload。
 * @param {string} week
 * @param {object} [over] 覆盖字段
 * @returns {object}
 */
function validPayload(week, over) {
  return Object.assign({
    submit: true,
    week: week,
    doneNote: '本周完成 X',
    planItems: ['下周做 Y'],
    resourceNote: '',
    tasks: [],
    risks: [{ description: '风险一', owner: TL_OPEN_ID, dueDate: dayOffset(10) }],
  }, over || {});
}

/** 固定周次，避开与冒烟脚本「本周」数据混淆 */
const W1 = '2031-W10';
const W2 = '2031-W11';

/* ── 直连库 ─────────────────────────────────────────── */

const Database = require('better-sqlite3');
const conn = new Database(path.resolve(ROOT, DB_FILE));
conn.pragma('journal_mode = WAL');

/* ══════════════════════════════════════════════════════
 * 【U】dates.weekRange 纯函数单测
 * ════════════════════════════════════════════════════ */

/**
 * @returns {void}
 */
function testWeekRangeUnit() {
  console.log('\n─── 【U】dates.weekRange 纯函数 ───');
  const dates = require(path.join(ROOT, 'server', 'lib', 'dates.js'));

  assert(typeof dates.weekRange === 'function', 'U1 weekRange 已导出');

  /* 2025-W07 = 2025-02-10(一) ~ 2025-02-16(日)（ISO 8601 标准值） */
  const w7 = dates.weekRange('2025-W07');
  assertEq(w7.start, '2025-02-10T00:00:00Z', 'U2 2025-W07 起始 = 2025-02-10（周一）');
  assertEq(w7.end, '2025-02-16T00:00:00Z', 'U3 2025-W07 结束 = 2025-02-16（周日）');

  /* 跨年周：2026-W01 = 2025-12-29 ~ 2026-01-04（ISO 第 1 周含 1/4） */
  const y26 = dates.weekRange('2026-W01');
  assertEq(y26.start, '2025-12-29T00:00:00Z', 'U4 跨年周 2026-W01 起始落在上一年 12-29');
  assertEq(y26.end, '2026-01-04T00:00:00Z', 'U5 跨年周 2026-W01 结束 = 2026-01-04');

  /* 2021-W01 = 2021-01-04 ~ 2021-01-10（1/4 恰为周一） */
  const y21 = dates.weekRange('2021-W01');
  assertEq(y21.start, '2021-01-04T00:00:00Z', 'U6 2021-W01 起始 = 2021-01-04（1/4 恰为周一）');

  /* 一位数周号也应被接受（正则 \d{1,2}） */
  assertEq(dates.weekRange('2025-W7').start, '2025-02-10T00:00:00Z', 'U7 一位数周号 2025-W7 等价 W07');

  /* 起止恒为 7 天间隔 */
  const s = new Date(w7.start).getTime();
  const e = new Date(w7.end).getTime();
  assertEq(e - s, 6 * 86400000, 'U8 起止间隔恒为 6 天（周一→周日）');

  /* 非法编码：返回空串，且不抛异常 */
  let threw = false;
  let bad = null;
  try { bad = dates.weekRange('not-a-week'); } catch (err) { threw = true; }
  assert(!threw, 'U9 非法周编码不抛异常');
  assertEq(bad && bad.start, '', 'U10 非法周编码 start = 空串');
  assertEq(bad && bad.end, '', 'U11 非法周编码 end = 空串');
  assertEq(dates.weekRange(null).start, '', 'U12 null 入参安全降级为空串');
  assertEq(dates.weekRange(undefined).start, '', 'U13 undefined 入参安全降级为空串');

  note('U-note 后端 weekRange 返回 `YYYY-MM-DDT00:00:00Z`，前端 web/src/utils/date.ts 返回 `YYYY-MM-DD`；'
    + '两者「日期计算」一致，仅序列化格式不同（设计文档 T02-2 明确规定后端带 T00:00:00Z），非缺陷。');
  note('U-note 非法周编码时后端返回空串、前端回退到「当前周」，容错策略不同；'
    + '因 week 由前端选择器产出，实际不会出现非法值，风险可接受。');
}

/* ══════════════════════════════════════════════════════
 * 【A】鉴权与项目守卫
 * ════════════════════════════════════════════════════ */

/**
 * @param {object} proj
 * @returns {Promise<void>}
 */
async function testAuthGuards(proj) {
  console.log('\n─── 【A】鉴权与项目守卫 ───');

  /* 未登录 */
  const anonList = await call('GET', '/api/projects/' + proj.id + '/reports', undefined, null);
  expectError(anonList, 'E_UNAUTHORIZED', 401, 'A1 未登录读周报列表');
  const anonPost = await call('POST', '/api/projects/' + proj.id + '/reports', validPayload(W1), null);
  expectError(anonPost, 'E_UNAUTHORIZED', 401, 'A2 未登录提交周报');

  await loginAs(ADMIN_OPEN_ID);

  /* 不存在的项目：写路径被 assertWritable → loadProject 拦为 404 */
  const ghostPost = await call('POST', '/api/projects/P_GHOST_NOT_EXIST/reports', validPayload(W1));
  expectError(ghostPost, 'E_NOT_FOUND', 404, 'A3 向不存在的项目提交周报');
  const ghostPatch = await call('PATCH', '/api/projects/P_GHOST_NOT_EXIST/reports/RP_X', validPayload(W1));
  expectError(ghostPatch, 'E_NOT_FOUND', 404, 'A4 在不存在的项目下编辑周报');

  /* 读路径不做项目守卫（与工作台口径一致）→ 空数组 / null，不 404 */
  const ghostList = await call('GET', '/api/projects/P_GHOST_NOT_EXIST/reports');
  assert(
    ghostList.json && ghostList.json.code === 0 && Array.isArray(ghostList.json.data) && ghostList.json.data.length === 0,
    'A5 读不存在项目的周报列表 → 空数组（读路径无项目守卫，与设计一致）',
    ghostList.json,
  );
  const ghostGet = await call('GET', '/api/projects/P_GHOST_NOT_EXIST/reports/' + W1);
  assert(ghostGet.json && ghostGet.json.code === 0 && ghostGet.json.data === null, 'A6 读不存在项目的周报详情 → null');

  /* 周报桩确实已拆：任何一个周报端点都不应再返回 501 */
  assert(
    ghostList.json.code !== 'E_NOT_IMPLEMENTED' && ghostPost.json.code !== 'E_NOT_IMPLEMENTED',
    'A7 周报端点不再命中 501 桩（stubs 已删除周报桩）',
  );

  /* 归档项目：直接改库置为「已结项」，写操作应被 E_PROJECT_ARCHIVED 拦下 */
  const archived = await createProject('ARCHIVED', 1);
  conn.prepare("UPDATE projects SET status = '已结项' WHERE id = ?").run(archived.id);
  const archPost = await call('POST', '/api/projects/' + archived.id + '/reports', validPayload(W1));
  expectError(archPost, 'E_PROJECT_ARCHIVED', 403, 'A8 归档（已结项）项目提交周报被拦');
  const archList = await call('GET', '/api/projects/' + archived.id + '/reports');
  assert(archList.json && archList.json.code === 0, 'A9 归档项目仍可读周报列表（只读不拦）');
}

/* ══════════════════════════════════════════════════════
 * 【V】提交强校验缺段组合
 * ════════════════════════════════════════════════════ */

/**
 * @param {object} proj
 * @returns {Promise<void>}
 */
async function testValidation(proj) {
  console.log('\n─── 【V】提交强校验（validateReportPayload） ───');
  await loginAs(ADMIN_OPEN_ID);
  const url = '/api/projects/' + proj.id + '/reports';

  /* V1 缺描述 */
  const noDesc = await call('POST', url, validPayload(W1, {
    risks: [{ description: '', owner: TL_OPEN_ID, dueDate: dayOffset(5) }],
  }));
  expectError(noDesc, 'E_REPORT_RISK_INCOMPLETE', 400, 'V1 风险缺描述');
  assert(
    ((noDesc.json && noDesc.json.message) || '').indexOf('第 1 条风险缺少描述') >= 0,
    'V1 文案「第 1 条风险缺少描述」与 Mock 一致', noDesc.json && noDesc.json.message,
  );

  /* V2 缺截止日期 */
  const noDue = await call('POST', url, validPayload(W1, {
    risks: [{ description: 'X', owner: TL_OPEN_ID, dueDate: '' }],
  }));
  expectError(noDue, 'E_REPORT_RISK_INCOMPLETE', 400, 'V2 风险缺截止日期');
  assert(
    ((noDue.json && noDue.json.message) || '').indexOf('第 1 条风险缺少截止日期') >= 0,
    'V2 文案「第 1 条风险缺少截止日期」', noDue.json && noDue.json.message,
  );

  /* V3 纯空白视同缺失（trim 生效） */
  const blank = await call('POST', url, validPayload(W1, {
    risks: [{ description: '   ', owner: '\t', dueDate: '  ' }],
  }));
  expectError(blank, 'E_REPORT_RISK_INCOMPLETE', 400, 'V3 纯空白风险字段视同缺失');
  assertEq(
    (blank.json && blank.json.data && blank.json.data.invalidRiskRows || []).length, 1,
    'V3 invalidRiskRows 只记 1 行（同一行多缺不重复计数）',
  );

  /* V4 多行缺失 → 行号齐全、messages 用「；」拼接 */
  const multi = await call('POST', url, validPayload(W1, {
    risks: [
      { description: '', owner: '', dueDate: '' },
      { description: 'ok', owner: TL_OPEN_ID, dueDate: dayOffset(3) },
      { description: 'ok', owner: '', dueDate: dayOffset(3) },
    ],
  }));
  expectError(multi, 'E_REPORT_RISK_INCOMPLETE', 400, 'V4 多行风险缺失');
  assertEq(
    JSON.stringify((multi.json && multi.json.data && multi.json.data.invalidRiskRows) || []),
    JSON.stringify([1, 3]),
    'V4 invalidRiskRows 精确定位第 1、3 行（第 2 行合法不误报）',
  );
  assert(
    ((multi.json && multi.json.message) || '').indexOf('；') >= 0,
    'V4 多条错误以「；」拼接', multi.json && multi.json.message,
  );

  /* V5 下周计划全空白 */
  const noPlan = await call('POST', url, validPayload(W1, { planItems: ['', '   ', '\n'] }));
  expectError(noPlan, 'E_REPORT_RISK_INCOMPLETE', 400, 'V5 下周计划全为空白');
  assert(
    ((noPlan.json && noPlan.json.message) || '').indexOf('「下周计划」至少填写 1 条') >= 0,
    'V5 文案「「下周计划」至少填写 1 条」', noPlan.json && noPlan.json.message,
  );

  /* V6 planItems 字段缺失（undefined）也应拦 */
  const noPlanKey = await call('POST', url, {
    submit: true, week: W1, doneNote: 'x', resourceNote: '', tasks: [], risks: [],
  });
  expectError(noPlanKey, 'E_REPORT_RISK_INCOMPLETE', 400, 'V6 planItems 字段缺失');

  /* V7 风险段为空数组 + 计划合法 → 按设计**放行**（校验只遍历已填风险行） */
  const emptyRisks = await call('POST', url, validPayload(W2, { risks: [] }));
  assert(
    emptyRisks.json && emptyRisks.json.code === 0,
    'V7 风险段为空数组时提交放行（设计：只校验已填风险行，不强制至少 1 条风险）',
    emptyRisks.json && emptyRisks.json.code,
  );
  note('V-note 「风险段为空」不触发 E_REPORT_RISK_INCOMPLETE，与设计文档 T02-3 及前端 mock/rules.ts#validateReport 一致；'
    + '若产品期望「必须至少填 1 条风险」，属需求变更，不是本批次缺陷。');

  /* V8 草稿完全不校验 */
  const draft = await call('POST', url, {
    submit: false, week: W1, doneNote: '', planItems: [], resourceNote: '',
    tasks: [], risks: [{ description: '', owner: '', dueDate: '' }],
  });
  assert(draft.json && draft.json.code === 0, 'V8 草稿允许残缺（submit=false 不跑强校验）', draft.json && draft.json.code);
  assertEq(draft.json && draft.json.data && draft.json.data.status, '草稿', 'V8 草稿 status = 草稿');

  /* V9 缺 week → E_VALIDATION（而非风险码） */
  const noWeek = await call('POST', url, validPayload('', {}));
  expectError(noWeek, 'E_VALIDATION', 400, 'V9 缺 week');

  /* V10 submit 非严格 true（字符串 'true'）→ 按草稿处理，不触发强校验 */
  const strSubmit = await call('POST', url, {
    submit: 'true', week: W1, doneNote: 'x', planItems: [], resourceNote: '', tasks: [], risks: [],
  });
  assertEq(
    strSubmit.json && strSubmit.json.data && strSubmit.json.data.status, '草稿',
    'V10 submit 传字符串 "true" 按草稿处理（严格 === true，防误提交）',
  );
}

/* ══════════════════════════════════════════════════════
 * 【S】快照冻结 + 【L】同周最新 + 【N】数值归一
 * ════════════════════════════════════════════════════ */

/**
 * @param {object} proj
 * @param {object} otherProj 另一个项目（跨项目探针）
 * @returns {Promise<void>}
 */
async function testSnapshotAndNumbers(proj, otherProj) {
  console.log('\n─── 【S】快照冻结 / 【L】同周最新 / 【N】数值归一 ───');
  await loginAs(ADMIN_OPEN_ID);
  const url = '/api/projects/' + proj.id + '/reports';

  const nodes = ((await call('GET', '/api/projects/' + proj.id + '/wbs')).json || {}).data || [];
  assert(nodes.length >= 2, 'S0 项目至少 2 个骨架节点可用', nodes.length);
  const nA = nodes[0];
  const nB = nodes[1];

  /* S3 叶子完整性守卫（SK-13）：骨架节点缺负责人/估算时改进度应被拒（语义是「缺负责人/估算」，而非「进度必须为 0/100」） */
  const patchIncomplete = await call('PATCH', '/api/wbs/' + nA.id, { progress: 90 });
  expectError(patchIncomplete, 'E_WBS_LEAF_INCOMPLETE', 400,
    'S3 缺负责人/估算的叶子节点改进度被拒（SK-13 守卫）');

  /* S3b 补全负责人与估算 → 叶子变为「完整」，此后进度可改 */
  const completeNode = await call('PATCH', '/api/wbs/' + nA.id, {
    owner: ADMIN_OPEN_ID, estimateDays: 5,
  });
  assert(completeNode.json && completeNode.json.code === 0, 'S3b 补全负责人/估算后叶子可编辑');

  /* 提交：nA 勾选 40%，nB 不勾选 */
  const sub = await call('POST', url, validPayload('2031-W20', {
    tasks: [
      { nodeId: nA.id, progressAfter: 40, selected: true },
      { nodeId: nB.id, progressAfter: 99, selected: false },
    ],
  }));
  const rep = sub.json && sub.json.data;
  assert(!!rep, 'S1 提交成功', sub.json && sub.json.code);
  assertEq(rep.snapshot && rep.snapshot[nA.id], 40, 'S1 快照记录勾选节点 = 40');
  assert(!(rep.snapshot && Object.prototype.hasOwnProperty.call(rep.snapshot, nB.id)), 'S1 未勾选节点不入快照');

  /* 未勾选节点不应被回写 */
  const after1 = ((await call('GET', '/api/projects/' + proj.id + '/wbs')).json || {}).data || [];
  const nBAfter = after1.filter((n) => n.id === nB.id)[0];
  assertEq(nBAfter && nBAfter.progress, 0, 'S2 未勾选节点进度未被回写（仍为 0）');

  /* S4 提交后改 WBS 节点进度（叶子已完整，可改）→ 已提交周报的快照与任务行必须冻结不漂移 */
  const patchNode = await call('PATCH', '/api/wbs/' + nA.id, { progress: 90 });
  assert(patchNode.json && patchNode.json.code === 0, 'S4 提交后改源节点进度为 90（叶子已完整）', patchNode.json && patchNode.json.code);
  const reread = await call('GET', url + '/2031-W20');
  const frozen = reread.json && reread.json.data;
  assertEq(frozen && frozen.snapshot && frozen.snapshot[nA.id], 40, 'S4 快照冻结：源节点改为 90 后报告 snapshot 仍为 40');
  const frozenTask = (frozen && frozen.tasks || []).filter((t) => t.nodeId === nA.id)[0];
  assertEq(frozenTask && frozenTask.progressAfter, 40, 'S4 任务行 progressAfter 冻结为 40');
  assertEq(frozenTask && frozenTask.progressBefore, 0, 'S4 任务行 progressBefore 记录提交前值 0');

  /* 【L】同周多次提交取最新 */
  const s2 = await call('POST', url, validPayload('2031-W20', { doneNote: '第二次提交' }));
  const s3 = await call('POST', url, validPayload('2031-W20', { doneNote: '第三次提交' }));
  assert(s2.json.code === 0 && s3.json.code === 0, 'L1 同周允许多次提交（不查重，无 E_REPORT_DUPLICATE）');
  const latest = await call('GET', url + '/2031-W20');
  assertEq(
    latest.json && latest.json.data && latest.json.data.id, s3.json.data.id,
    'L2 getReport 返回同周最新一条（D-3）',
  );
  assertEq(latest.json.data.doneNote, '第三次提交', 'L2 最新一条内容正确');

  const listAll = await call('GET', url);
  /* B5-R3：listReports 默认排序已由「week 倒序」改为「填报时间（created_at）倒序」，
     本断言随之更新为 created_at 倒序语义（ISO 字符串可字典序比较，与时间序一致） */
  const createdAtList = (listAll.json.data || []).map((r) => r.createdAt);
  const sortedCreatedDesc = createdAtList.slice().sort().reverse();
  assertEq(
    JSON.stringify(createdAtList), JSON.stringify(sortedCreatedDesc),
    'L3 列表按填报时间（createdAt）倒序（B5-R3 默认排序）',
  );
  assert((listAll.json.data || []).length >= 4, 'L4 列表含历史多次提交（含草稿）', (listAll.json.data || []).length);

  /* 不存在的周次 → null */
  const noWeek = await call('GET', url + '/1999-W01');
  assert(noWeek.json && noWeek.json.code === 0 && noWeek.json.data === null, 'L5 不存在周次返回 data: null');

  /* 【N】进度越界裁剪 */
  const nC = nodes[2] || nodes[1];
  const over = await call('POST', url, validPayload('2031-W21', {
    tasks: [{ nodeId: nC.id, progressAfter: 150, selected: true }],
  }));
  assertEq(over.json && over.json.data && over.json.data.snapshot[nC.id], 100, 'N1 progressAfter=150 裁剪为 100');
  const afterOver = ((await call('GET', '/api/projects/' + proj.id + '/wbs')).json || {}).data || [];
  assertEq(afterOver.filter((n) => n.id === nC.id)[0].progress, 100, 'N1 回写到节点的进度同样为 100');

  const under = await call('POST', url, validPayload('2031-W22', {
    tasks: [{ nodeId: nC.id, progressAfter: -20, selected: true }],
  }));
  assertEq(under.json && under.json.data && under.json.data.snapshot[nC.id], 0, 'N2 progressAfter=-20 裁剪为 0');

  const nan = await call('POST', url, validPayload('2031-W23', {
    tasks: [{ nodeId: nC.id, progressAfter: 'abc', selected: true }],
  }));
  assertEq(nan.json && nan.json.data && nan.json.data.snapshot[nC.id], 0, 'N3 非数字进度归一为 0（不产生 NaN）');

  /* 未知 nodeId：不崩，快照字段为空壳 */
  const unknown = await call('POST', url, validPayload('2031-W24', {
    tasks: [{ nodeId: 'W_NOT_EXIST', progressAfter: 50, selected: true }],
  }));
  assert(unknown.json && unknown.json.code === 0, 'N4 引用不存在的 nodeId 不导致 500', unknown.json && unknown.json.code);
  const uTask = (unknown.json.data.tasks || [])[0];
  assertEq(uTask && uTask.nodeCode, '', 'N4 未知节点 nodeCode 为空串');
  assertEq(uTask && uTask.progressBefore, 0, 'N4 未知节点 progressBefore 为 0');

  /* 【N5】跨项目 nodeId 回写探针（数据隔离性） */
  const otherNodes = ((await call('GET', '/api/projects/' + otherProj.id + '/wbs')).json || {}).data || [];
  const foreign = otherNodes[0];
  assert(!!foreign, 'N5 取到另一个项目的节点用于探针');
  const foreignBefore = foreign.progress;
  await call('POST', url, validPayload('2031-W25', {
    tasks: [{ nodeId: foreign.id, progressAfter: 77, selected: true }],
  }));
  const otherAfter = ((await call('GET', '/api/projects/' + otherProj.id + '/wbs')).json || {}).data || [];
  const foreignAfter = otherAfter.filter((n) => n.id === foreign.id)[0];
  const leaked = foreignAfter && foreignAfter.progress === 77 && foreignBefore !== 77;
  assert(
    !leaked,
    'N5 跨项目 nodeId 不应被回写进度（数据隔离）',
    { projectA: proj.id, foreignNode: foreign.id, before: foreignBefore, after: foreignAfter && foreignAfter.progress },
  );
}

/* ══════════════════════════════════════════════════════
 * 【P】RBAC 越权矩阵
 * ════════════════════════════════════════════════════ */

/**
 * @param {object} proj
 * @param {object} otherProj
 * @returns {Promise<void>}
 */
async function testPermissionMatrix(proj, otherProj) {
  console.log('\n─── 【P】RBAC 越权矩阵（D-2） ───');
  const url = '/api/projects/' + proj.id + '/reports';

  /* 作者 = 普通 member */
  await loginAs(MEMBER_OPEN_ID);
  const mine = await call('POST', url, validPayload('2031-W30', { doneNote: '成员本人写的' }));
  assert(mine.json && mine.json.code === 0, 'P1 普通 member 可提交周报（report:write 为全局角色）', mine.json && mine.json.code);
  const repId = mine.json.data.id;
  assertEq(mine.json.data.author, MEMBER_OPEN_ID, 'P1 author = 提交人 openId');
  assertEq(mine.json.data.authorName, '吴迪', 'P1 authorName 取用户姓名');

  /* 作者本人可改 */
  const selfEdit = await call('PATCH', url + '/' + repId, validPayload('2031-W30', { doneNote: '本人修订' }));
  assert(selfEdit.json && selfEdit.json.code === 0, 'P2 作者本人可编辑自己的周报');
  assertEq(selfEdit.json.data.doneNote, '本人修订', 'P2 编辑生效');

  /* 另一个普通 member 不可改 */
  await loginAs(MEMBER2_OPEN_ID);
  const otherEdit = await call('PATCH', url + '/' + repId, validPayload('2031-W30', { doneNote: '越权改写' }));
  expectError(otherEdit, 'E_FORBIDDEN', 403, 'P3 他人（非作者非 admin）编辑被拒');
  const stillOk = await call('GET', url + '/2031-W30');
  assertEq(stillOk.json.data.doneNote, '本人修订', 'P3 越权失败后内容未被篡改');

  /* admin 可改他人 */
  await loginAs(ADMIN_OPEN_ID);
  const adminEdit = await call('PATCH', url + '/' + repId, validPayload('2031-W30', { doneNote: 'admin 代改' }));
  assert(adminEdit.json && adminEdit.json.code === 0, 'P4 admin 可编辑他人周报（D-2 白名单）');
  assertEq(adminEdit.json.data.doneNote, 'admin 代改', 'P4 admin 编辑生效');

  /* tl（非作者非 admin）不可改 */
  await loginAs(TL_OPEN_ID);
  const tlEdit = await call('PATCH', url + '/' + repId, validPayload('2031-W30', { doneNote: 'tl 越权' }));
  expectError(tlEdit, 'E_FORBIDDEN', 403, 'P5 tl 亦不能编辑他人周报（D-2 只放行作者/admin）');

  /* body.projectId 伪造：路径参数是唯一真源 */
  await loginAs(ADMIN_OPEN_ID);
  const spoof = await call('POST', url, validPayload('2031-W31', { projectId: otherProj.id }));
  assertEq(spoof.json && spoof.json.data && spoof.json.data.projectId, proj.id,
    'P6 body.projectId 伪造无效，落库以 URL 路径为准（防跨项目写入）');
  const otherList = await call('GET', '/api/projects/' + otherProj.id + '/reports');
  assertEq(
    (otherList.json.data || []).filter((r) => r.week === '2031-W31').length, 0,
    'P6 伪造的目标项目下确实没有多出周报',
  );

  /* P7 跨项目 URL 改他人报告：非作者非 admin 即便换项目 URL 仍须被 RBAC 拦截（D-2）。
     说明：updateReport 按设计不按 projectId 限域（仅作者本人/admin 可改，D-2），
     故「跨项目 URL」本身不构成漏洞；真正的隔离是 author/admin 校验，此处验证其不被 URL 绕过。 */
  await loginAs(MEMBER2_OPEN_ID);
  const crossPatch = await call('PATCH', '/api/projects/' + otherProj.id + '/reports/' + repId, validPayload('2031-W30', {
    doneNote: '跨项目 URL 越权改写',
  }));
  expectError(crossPatch, 'E_FORBIDDEN', 403, 'P7 跨项目 URL 改他人报告仍被 RBAC 拦截（D-2）');
}

/* ══════════════════════════════════════════════════════
 * 【F】飞书 Web OAuth 降级链路
 * ════════════════════════════════════════════════════ */

/**
 * @returns {Promise<void>}
 */
async function testFeishuWebEdge() {
  console.log('\n─── 【F】飞书 Web OAuth 降级链路边界 ───');

  /* F1 空白 code（只有空格）→ trim 后为空 → E_VALIDATION */
  const blank = await call('POST', '/api/auth/feishu/web', { code: '   ' }, null);
  expectError(blank, 'E_VALIDATION', 400, 'F1 code 全空白');

  /* F2 未知 openId 的哨兵码 → E_NOT_FOUND */
  const ghost = await call('POST', '/api/auth/feishu/web', { code: 'dev:ou_not_exist_zzz' }, null);
  expectError(ghost, 'E_NOT_FOUND', 404, 'F2 哨兵码指向不存在用户');

  /* F3 空哨兵 'dev:'（ADMIN_OPEN_IDS 未配置 → 回退 'dev' 用户，同样不存在） */
  const emptyDev = await call('POST', '/api/auth/feishu/web', { code: 'dev:' }, null);
  expectError(emptyDev, 'E_NOT_FOUND', 404, 'F3 空哨兵码 dev: 回退后用户不存在');

  /* F4 大小写敏感：DEV: 不匹配哨兵正则 → 走缺凭证分支 403 */
  const upper = await call('POST', '/api/auth/feishu/web', { code: 'DEV:' + ADMIN_OPEN_ID }, null);
  expectError(upper, 'E_FORBIDDEN', 403, 'F4 哨兵码大小写敏感（DEV: 不放行）');

  /* F5 停用账号：哨兵码也必须被拒 */
  conn.prepare("UPDATE users SET status = 'disabled' WHERE open_id = ?").run(MEMBER2_OPEN_ID);
  const disabled = await call('POST', '/api/auth/feishu/web', { code: 'dev:' + MEMBER2_OPEN_ID }, null);
  expectError(disabled, 'E_FORBIDDEN', 403, 'F5 停用账号走哨兵码被拒');
  assert(
    ((disabled.json && disabled.json.message) || '').indexOf('停用') >= 0,
    'F5 文案点明「已停用」', disabled.json && disabled.json.message,
  );
  conn.prepare("UPDATE users SET status = 'active' WHERE open_id = ?").run(MEMBER2_OPEN_ID);

  /* F6 完整链路：哨兵码换 token → 用该 token 访问受保护接口 */
  const devLogin = await call('POST', '/api/auth/feishu/web', { code: 'dev:' + TL_OPEN_ID }, null);
  assert(devLogin.json && devLogin.json.code === 0, 'F6 哨兵码登录成功', devLogin.json && devLogin.json.code);
  const webToken = devLogin.json.data.token;
  assert(!!webToken, 'F6 返回 token');
  assertEq(devLogin.json.data.user.openId, TL_OPEN_ID, 'F6 返回用户 openId 正确');
  assertEq(devLogin.json.data.user.globalRole, 'tl', 'F6 返回用户 globalRole 正确（camelCase）');
  const meRes = await call('GET', '/api/auth/me', undefined, webToken);
  assert(meRes.json && meRes.json.code === 0, 'F6 Web OAuth 令牌可通过 requireAuth 鉴权');
  assertEq(meRes.json.data.openId, TL_OPEN_ID, 'F6 /auth/me 回读同一用户（授权→回调→登录 全链路闭环）');

  /* F7 该 token 可正常调业务接口（不是只能调 /auth/me） */
  const bizRes = await call('GET', '/api/workbench/summary', undefined, webToken);
  assert(
    bizRes.status !== 401 && bizRes.status !== 403,
    'F7 Web OAuth 令牌可调业务接口（非 401/403）', { status: bizRes.status, code: bizRes.json && bizRes.json.code },
  );

  /* F8 与 JSSDK 免登共用同一 users 行：两条链路登录同一 openId 得到同一用户身份 */
  const dl = await call('POST', '/api/auth/devlogin', { openId: TL_OPEN_ID }, null);
  assertEq(
    dl.json.data.user.openId, devLogin.json.data.user.openId,
    'F8 Web OAuth 与开发登录落到同一 users 行（upsertFeishuUser 共用）',
  );

  /* F9 真实 code 在缺 SECRET 时被拒且文案可指导运维 */
  const real = await call('POST', '/api/auth/feishu/web', { code: 'fake_real_code_abc' }, null);
  expectError(real, 'E_FORBIDDEN', 403, 'F9 非哨兵码 + 缺凭证');
  assert(
    ((real.json && real.json.message) || '').indexOf('FEISHU_APP_SECRET') >= 0,
    'F9 错误文案点名 FEISHU_APP_SECRET（运维可自助定位）', real.json && real.json.message,
  );

  note('F-note 真连（浏览器 → 飞书授权页 → 回调 /login → 自动登录）本环境无法验证：'
    + '.env 中 FEISHU_APP_ID / FEISHU_APP_SECRET 均为空，且飞书开放平台未登记重定向 URI。'
    + '已验证范围：降级哨兵码整条链路 + 缺凭证/错误码的全部分支。');
}

/* ── 主流程 ─────────────────────────────────────────── */

/**
 * @returns {Promise<void>}
 */
async function main() {
  console.log('QA·B4 边界与错误路径独立测试 · base = ' + BASE + ' · db = ' + DB_FILE);

  testWeekRangeUnit();

  await loginAs(ADMIN_OPEN_ID);
  const proj = await createProject('MAIN', 3);
  const other = await createProject('OTHER', 2);

  await testAuthGuards(proj);
  await testValidation(proj);
  await testSnapshotAndNumbers(proj, other);
  await testPermissionMatrix(proj, other);
  await testFeishuWebEdge();

  conn.close();

  console.log('\n══════════════════════════════════════');
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach(function (f) { console.log('  - ' + f); });
  }
  if (notes.length) {
    console.log('\n观察项（非失败）：');
    notes.forEach(function (n) { console.log('  - ' + n); });
  }
  console.log('IS_PASS: ' + (failed === 0 ? 'YES' : 'NO'));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('QA 边界测试异常终止：', e);
  process.exit(1);
});
