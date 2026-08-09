#!/usr/bin/env node
/**
 * QA 独立验证 · B10 审批上线 + 工作台接真数据
 *
 * 定位：B10 交付关卡独立验证。覆盖（docs/B10-增量PRD.md §4 验收要点 R1~R3 +
 * docs/B10-任务分解.md §B2 T05 用例清单 15 组）：
 *   1.  401：7 评审接口 + transition + close-check 未登录拦截
 *   2.  404：GET /reviews/:id 不存在、transition/close-check 项目不存在
 *   3.  createReview：project 按 A/B/C 取链、formal parallel_veto 全 current、
 *       technical single 1 步、submit 留痕 stepIndex=-1、assignees 覆盖、
 *       customer_rep 兜底绑定、归档项目发起 403、无 review:start 403
 *   4.  serial 推进：approve → currentStep+1 → 末步 已通过 + 项目 审批中→已批准 + 审计
 *   5.  reject：已驳回 + 其余 pending/current 置 skipped + 审计 diff
 *   6.  parallel_veto：单票不终态、全票通过、任一驳回 → skipped
 *   7.  withdraw：发起人/admin 成功、非发起人 403、已终态 409
 *   8.  RBAC/状态：非当前审批人 403 E_NOT_APPROVER、customer_rep 缺意见/凭证 400、
 *       驳回无意见 400、已终态再操作 409
 *   9.  留痕：review_approvals 行数 = 操作次数；审计 entity_type=review 事件齐全
 *   10. transition：非法流转 400、归档态 403、结项阻塞 409 + blockers、无阻塞成功 + 审计 diff
 *   11. Q3：审批中 project 评审存在 → 审批中→已批准 直转 400；无评审 legacy → 直转成功
 *   12. close-check：gate/milestone/review 阻塞项文案、无阻塞 []、与 transition 同口径
 *   13. workbench：pendingApprovals===myApprovals.length、myApprovals 字段齐全、
 *       reportReminders 每项目一行 + week/weekStart/weekEnd 格式 + filled 翻转 + 无 NaN
 *   14. weekCode 单测：2026-01-01→2026-W01、2025-01-01→2025-W01、
 *       2021-01-01→2020-W53、2022-01-01→2021-W52
 *   15. 回归基线：legacy approval-config 存活（D9）、listReviews projectId 过滤、
 *       全响应无 snake_case（devcheck/test_runner/qa_b7/b8/b9 由外层脚本另跑）
 *
 * 用法（与既有回归脚本同约定：同一 DB_PATH 起服务 + 跑脚本）：
 *   DB_PATH=./b10_qa.db node scripts/qa_b10_verify.mjs http://127.0.0.1:3311
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
const DB_FILE = process.env.DB_PATH || './b10_qa.db';

/* 演示账号（与 server/dal/seed.js / web demoAccounts.ts 一致） */
const ADMIN = 'ou_xuwenbin01';
const PM = 'ou_liming03';
const PMO = 'ou_zhangmin04';
const TL = 'ou_wangqiang02';
const QA = 'ou_chenjing05';
const PO = 'ou_sunyue07';
const MGMT = 'ou_zhoutao08';
const CM = 'ou_zhaolei06';
const MEMBER = 'ou_wudi09';
const MEMBER2 = 'ou_zhengshuang10';

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

/* ── ISO 周编码（与服务端 dates.weekCode / 前端 weekCode 同算法） ── */
function weekCodeOf(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00Z') : new Date();
  const ms = dateStr ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    : Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const day = new Date(ms);
  const dow = (day.getUTCDay() + 6) % 7;
  const thursday = new Date(ms);
  thursday.setUTCDate(day.getUTCDate() + (3 - dow));
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const week = Math.floor((thursday.getTime() - week1Monday.getTime()) / 86400000 / 7) + 1;
  return isoYear + '-W' + String(week).padStart(2, '0');
}

/* ── DB 直查 / 直写（仅测试库 b10_qa.db） ─────────────── */
function openDb() {
  const Database = require('better-sqlite3');
  return new Database(path.resolve(ROOT, DB_FILE), { readonly: true });
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
  const db = new Database(path.resolve(ROOT, DB_FILE));
  try {
    return db.prepare(sql).run(...(params || []));
  } finally {
    db.close();
  }
}

/* ── 测试数据构造 ───────────────────────────────────── */

let PROJ_SEQ = 0;

async function createProject(name, type, extra) {
  const x = extra || {};
  const members = x.members || [
    { userOpenId: ADMIN, role: 'pm' },
    { userOpenId: TL, role: 'tl' },
  ];
  const milestones = x.milestones !== undefined ? x.milestones : [];
  return okData(
    await call('POST', '/api/projects', {
      name: name,
      type: type || 'A',
      customer: 'B10 验证客户',
      contractAmount: 300,
      background: 'qa_b10_verify 自动创建',
      goal: ['B10 专项验证'],
      planStart: dayOffset(0),
      planEnd: dayOffset(180),
      pm: ADMIN,
      classifyInput: { contractAmount: 300, hasHardware: type === 'A', hasAcceptance: type === 'A', isSelfIteration: type === 'B', isInfrastructure: type === 'C' },
      classifySuggested: type || 'A',
      classifyOverrideReason: '',
      members: members,
      milestones: milestones,
    }),
    '建项目 ' + name,
  );
}

async function transition(pid, to, comment) {
  return call('POST', '/api/projects/' + pid + '/transition', { to: to, comment: comment || '' });
}

/** 把项目推到指定状态（无 project 评审时直转合法） */
async function pushProject(pid, status) {
  const order = ['草稿', '审批中', '已批准', '进行中', '挂起', '已结项', '已终止', '已驳回'];
  const p = okData(await call('GET', '/api/projects/' + pid), 'GET /projects/' + pid);
  const cur = p && p.status;
  const curIdx = order.indexOf(cur);
  const targetIdx = order.indexOf(status);
  if (curIdx < 0 || targetIdx < 0) return p;
  let i = curIdx;
  while (i < targetIdx) {
    const to = order[i + 1];
    const r = await transition(pid, to);
    if (!r.json || r.json.code !== 0) break;
    i += 1;
  }
  return okData(await call('GET', '/api/projects/' + pid), 'GET /projects/' + pid + '（推到 ' + status + '）');
}

/* ═══════════════════════════════════════════════════════ */

async function main() {
  console.log('═══ B10 审批上线 + 工作台接真数据 · 专项验证（' + BASE + ' / DB=' + DB_FILE + '）═══');

  /* ── G1：401 未登录 ─────────────────────────────── */
  console.log('\n── G1 401：7 评审接口 + transition + close-check 未登录拦截 ──');
  let r = await call('GET', '/api/reviews');
  expectError(r, 'E_UNAUTHORIZED', 401, 'GET /reviews 未登录 → 401');
  r = await call('GET', '/api/reviews/my-approvals');
  expectError(r, 'E_UNAUTHORIZED', 401, 'GET /reviews/my-approvals 未登录 → 401');
  r = await call('GET', '/api/reviews/x');
  expectError(r, 'E_UNAUTHORIZED', 401, 'GET /reviews/:id 未登录 → 401');
  r = await call('POST', '/api/reviews', {});
  expectError(r, 'E_UNAUTHORIZED', 401, 'POST /reviews 未登录 → 401');
  r = await call('POST', '/api/reviews/x/approve', {});
  expectError(r, 'E_UNAUTHORIZED', 401, 'POST /reviews/:id/approve 未登录 → 401');
  r = await call('POST', '/api/reviews/x/reject', {});
  expectError(r, 'E_UNAUTHORIZED', 401, 'POST /reviews/:id/reject 未登录 → 401');
  r = await call('POST', '/api/reviews/x/withdraw', {});
  expectError(r, 'E_UNAUTHORIZED', 401, 'POST /reviews/:id/withdraw 未登录 → 401');
  r = await call('POST', '/api/projects/x/transition', { to: '已批准' });
  expectError(r, 'E_UNAUTHORIZED', 401, 'POST /projects/:id/transition 未登录 → 401');
  r = await call('GET', '/api/projects/x/close-check');
  expectError(r, 'E_UNAUTHORIZED', 401, 'GET /projects/:id/close-check 未登录 → 401');

  /* ── G2：404 ────────────────────────────────────── */
  console.log('\n── G2 404：评审/项目不存在 ──');
  await loginAs(ADMIN);
  assert(!!token, '管理员 devlogin 签发 token');
  r = await call('GET', '/api/reviews/nonexistent');
  expectError(r, 'E_NOT_FOUND', 404, 'GET /reviews/nonexistent → 404');
  r = await transition('nonexistent', '已批准');
  expectError(r, 'E_NOT_FOUND', 404, 'transition 项目不存在 → 404');
  r = await call('GET', '/api/projects/nonexistent/close-check');
  expectError(r, 'E_NOT_FOUND', 404, 'close-check 项目不存在 → 404');

  /* ── G3：createReview 模板与绑定 ─────────────────── */
  console.log('\n── G3 createReview：模板 / 绑定 / assignees / 兜底 / 权限 ──');
  const stamp = Date.now();
  const pA = await createProject('B10-A类 ' + stamp, 'A', {
    members: [
      { userOpenId: ADMIN, role: 'pm' },
      { userOpenId: TL, role: 'tl' },
      { userOpenId: PMO, role: 'pmo' },
      { userOpenId: PO, role: 'po' },
    ],
  });
  const pAId = pA && pA.id;
  assert(!!pAId, 'A 类项目创建成功');

  /* project 类型 A 类 → 3 步 [pmo,tl,management] serial */
  const rvA = okData(
    await call('POST', '/api/reviews', { projectId: pAId, refType: 'project', refId: pAId, reviewType: 'project', title: '立项评审A' }),
    '发起 project 类型 A 类评审',
  );
  assert(!!rvA && rvA.id, '返回 Review id');
  assertEq(rvA && rvA.mode, 'serial', 'project A → mode serial');
  assertEq(rvA && rvA.templateKey, 'project:A', 'project A → templateKey project:A');
  assertEq(rvA && rvA.status, '审批中', '创建即审批中');
  assertEq(rvA && rvA.currentStep, 0, 'currentStep 0');
  assert(rvA && rvA.steps.length === 3, 'A 类审批链 3 步', rvA && rvA.steps.map((s) => s.role));
  assertEq(rvA && rvA.steps[0].role, 'pmo', 'step0 role pmo');
  assertEq(rvA && rvA.steps[0].status, 'current', 'step0 current');
  assertEq(rvA && rvA.steps[0].assigneeOpenId, PMO, 'step0 pmo 绑定项目成员 ou_zhangmin04');
  assertEq(rvA && rvA.steps[1].role, 'tl', 'step1 role tl');
  assertEq(rvA && rvA.steps[1].status, 'pending', 'step1 pending');
  assertEq(rvA && rvA.steps[1].assigneeOpenId, TL, 'step1 tl 绑定 ou_wangqiang02');
  assertEq(rvA && rvA.steps[2].role, 'management', 'step2 role management');
  assertEq(rvA && rvA.steps[2].assigneeOpenId, MGMT, 'step2 management 全局绑定 ou_zhoutao08');
  assert(rvA && rvA.steps.every((s) => s.required === true), 'required 恒 true');
  assert(rvA && rvA.projectName === 'B10-A类 ' + stamp, 'projectName 读时 join');
  assert(rvA && rvA.initiator === ADMIN && !!rvA.initiatorName, 'initiator / initiatorName');
  assert(rvA && rvA.approvals.length === 1 && rvA.approvals[0].action === 'submit', '首条审批 submit');
  assertEq(rvA && rvA.approvals[0].stepIndex, -1, 'submit stepIndex=-1');
  assertEq(rvA && rvA.approvals[0].stepRole, 'initiator', 'submit stepRole initiator');

  /* B 类 → 2 步 [pm, tl] */
  const pB = await createProject('B10-B类 ' + stamp, 'B', {
    members: [
      { userOpenId: ADMIN, role: 'pm' },
      { userOpenId: TL, role: 'tl' },
      { userOpenId: PO, role: 'po' },
    ],
  });
  const pBId = pB && pB.id;
  assert(!!pBId, 'B 类项目创建成功');
  const rvB = okData(
    await call('POST', '/api/reviews', { projectId: pBId, refType: 'project', refId: pBId, reviewType: 'project', title: '立项评审B' }),
    '发起 project 类型 B 类评审',
  );
  assert(rvB && rvB.steps.length === 2, 'B 类审批链 2 步', rvB && rvB.steps.map((s) => s.role));
  assertEq(rvB && rvB.templateKey, 'project:B', 'project B → templateKey project:B');
  assertEq(rvB && rvB.steps[0].role, 'pm', 'B step0 pm');
  assertEq(rvB && rvB.steps[1].role, 'tl', 'B step1 tl');

  /* C 类 → 3 步 */
  const pC = await createProject('B10-C类 ' + stamp, 'C', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }],
  });
  const pCId = pC && pC.id;
  assert(!!pCId, 'C 类项目创建成功');
  const rvC = okData(
    await call('POST', '/api/reviews', { projectId: pCId, refType: 'project', refId: pCId, reviewType: 'project', title: '立项评审C' }),
    '发起 project 类型 C 类评审',
  );
  assert(rvC && rvC.steps.length === 3, 'C 类审批链 3 步', rvC && rvC.steps.map((s) => s.role));
  assertEq(rvC && rvC.templateKey, 'project:C', 'project C → templateKey project:C');

  /* formal → parallel_veto 全 current + customer_rep 兜底绑定 */
  const rvFormal = okData(
    await call('POST', '/api/reviews', { projectId: pAId, refType: 'project', refId: pAId, reviewType: 'formal', title: '正式评审A' }),
    '发起 formal 评审',
  );
  assertEq(rvFormal && rvFormal.mode, 'parallel_veto', 'formal → parallel_veto');
  assertEq(rvFormal && rvFormal.templateKey, 'formal', 'formal → templateKey formal');
  assert(rvFormal && rvFormal.steps.every((s) => s.status === 'current'), 'parallel_veto 全部 current');
  assert(rvFormal && rvFormal.steps.length === 4, 'formal 链 4 步');
  const custStep = rvFormal && rvFormal.steps.find((s) => s.role === 'customer_rep');
  assert(!!custStep, '含 customer_rep 步骤');
  assert(!!custStep && custStep.assigneeOpenId === PMO, 'customer_rep 兜底绑定（fallback 首位 pmo）', custStep && custStep.assigneeOpenId);
  assert(!!custStep && !!custStep.assigneeName, 'customer_rep 有 assigneeName');

  /* technical → single 1 步 */
  const rvTech = okData(
    await call('POST', '/api/reviews', { projectId: pAId, refType: 'project', refId: pAId, reviewType: 'technical', title: '技术评审A' }),
    '发起 technical 评审',
  );
  assertEq(rvTech && rvTech.mode, 'single', 'technical → single');
  assert(rvTech && rvTech.steps.length === 1, 'technical 链 1 步');
  assertEq(rvTech && rvTech.steps[0].role, 'tl', 'technical step role tl');
  assertEq(rvTech && rvTech.steps[0].assigneeOpenId, TL, 'technical tl 绑定 ou_wangqiang02');

  /* assignees 覆盖 */
  const rvAssign = okData(
    await call('POST', '/api/reviews', {
      projectId: pBId, refType: 'project', refId: pBId, reviewType: 'project', title: 'assignees 覆盖',
      assignees: [MEMBER, MEMBER2],
    }),
    '发起带 assignees 覆盖的 B 类评审',
  );
  assertEq(rvAssign && rvAssign.steps[0].assigneeOpenId, MEMBER, 'assignees[0] 覆盖 step0');
  assertEq(rvAssign && rvAssign.steps[1].assigneeOpenId, MEMBER2, 'assignees[1] 覆盖 step1');

  /* 归档项目发起 → 403（独立新项目推到已终止，避免被 Q3 拦截 审批中→已批准） */
  const pArc = await createProject('B10-archived ' + stamp, 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
  });
  const pArcId = pArc && pArc.id;
  await pushProject(pArcId, '已批准');
  await transition(pArcId, '已终止');
  r = await call('POST', '/api/reviews', { projectId: pArcId, refType: 'project', refId: pArcId, reviewType: 'project', title: '归档发起' });
  expectError(r, 'E_PROJECT_ARCHIVED', 403, '归档项目（已终止）发起评审 → 403 E_PROJECT_ARCHIVED');

  /* 无 review:start → 403 */
  await loginAs(MEMBER);
  r = await call('POST', '/api/reviews', { projectId: pAId, refType: 'project', refId: pAId, reviewType: 'project', title: '无权限发起' });
  expectError(r, 'E_FORBIDDEN', 403, 'member 无 review:start 发起 → 403');

  /* ── G4：serial 推进 + 终态联动 ──────────────────── */
  console.log('\n── G4 serial 推进 → 终审通过 → 项目 审批中→已批准 ──');
  await loginAs(ADMIN);
  /* 把 PB 推到 审批中（此时 PB 上已有 rvB / rvAssign 两个审批中 project 评审 → Q3 会拦 审批中→已批准！
     为让后续 transition 测试可控，这里改用新项目 */
  const pS = await createProject('B10-serial ' + stamp, 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
  });
  const pSId = pS && pS.id;
  await pushProject(pSId, '审批中');
  const rvS = okData(
    await call('POST', '/api/reviews', { projectId: pSId, refType: 'project', refId: pSId, reviewType: 'project', title: 'serial推进' }),
    '发起 serial 推进评审（B 类 2 步）',
  );
  const rvSId = rvS && rvS.id;
  assert(!!rvSId, 'serial 评审创建成功');

  /* step0 pm = admin 通过 → currentStep 1 */
  let rvS2 = okData(await call('POST', '/api/reviews/' + rvSId + '/approve', { comment: 'pm 通过' }), 'step0 approve');
  assertEq(rvS2 && rvS2.currentStep, 1, 'approve 后 currentStep=1');
  assertEq(rvS2 && rvS2.status, '审批中', '非末步仍审批中');
  assertEq(rvS2 && rvS2.steps[0].status, 'approved', 'step0 approved');
  assertEq(rvS2 && rvS2.steps[1].status, 'current', 'step1 current');
  assert(!!rvS2 && rvS2.steps[0].decidedBy === ADMIN && !!rvS2.steps[0].decidedByName, 'step0 decidedBy/decidedByName 留痕');
  assert(!!rvS2 && !!rvS2.steps[0].decidedAt, 'step0 decidedAt');

  /* step1 tl = ou_wangqiang02 通过 → 已通过 + 项目联动 */
  await loginAs(TL);
  rvS2 = okData(await call('POST', '/api/reviews/' + rvSId + '/approve', { comment: 'tl 终审' }), 'step1 approve（末步）');
  assertEq(rvS2 && rvS2.status, '已通过', '末步通过 → 已通过');
  assert(!!rvS2 && !!rvS2.closedAt, 'closedAt 写入');
  assertEq(rvS2 && rvS2.currentStep, 2, '终态 currentStep=steps.length');

  const pSAfter = okData(await call('GET', '/api/projects/' + pSId), 'GET /projects/' + pSId + '（终态联动后）');
  assertEq(pSAfter && pSAfter.status, '已批准', '项目 审批中→已批准 联动');
  const projAudit = dbAll(
    "SELECT * FROM audit_logs WHERE entity_type='project' AND entity_id=? AND action='status_change' ORDER BY created_at DESC",
    [pSId],
  );
  assert(projAudit.length >= 1, '项目 status_change 审计存在');
  const projDiff = projAudit[0] && JSON.parse(projAudit[0].diff || '[]');
  assert(
    !!projDiff && projDiff.some((d) => d.field === 'status' && d.before === '审批中' && d.after === '已批准'),
    '项目审计 diff status 审批中→已批准',
    projDiff,
  );

  /* ── G5：reject → 已驳回 + skipped ──────────────── */
  console.log('\n── G5 reject：整单已驳回 + 其余步骤 skipped + 审计 diff ──');
  await loginAs(ADMIN);
  const pR = await createProject('B10-reject ' + stamp, 'A', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PMO, role: 'pmo' }],
  });
  const pRId = pR && pR.id;
  await pushProject(pRId, '审批中');
  const rvR = okData(
    await call('POST', '/api/reviews', { projectId: pRId, refType: 'project', refId: pRId, reviewType: 'project', title: '驳回评审' }),
    '发起驳回评审（A 类 3 步）',
  );
  const rvRId = rvR && rvR.id;
  await loginAs(PMO);
  const rvR2 = okData(await call('POST', '/api/reviews/' + rvRId + '/reject', { comment: '方案不成立' }), 'step0 驳回');
  assertEq(rvR2 && rvR2.status, '已驳回', '驳回 → 已驳回');
  assert(!!rvR2 && !!rvR2.closedAt, '驳回 closedAt');
  assert(rvR2 && rvR2.steps.every((s) => s.status === 'rejected' || s.status === 'skipped'), '其余步骤 skipped（step0 rejected）', rvR2 && rvR2.steps.map((s) => s.status));
  const rejectAudit = dbAll(
    "SELECT * FROM audit_logs WHERE entity_type='review' AND entity_id=? AND action='reject'",
    [rvRId],
  );
  assert(rejectAudit.length === 1, '驳回审计存在');
  const rDiff = rejectAudit[0] && JSON.parse(rejectAudit[0].diff || '[]');
  assert(!!rDiff && rDiff.some((d) => d.field === 'status' && d.before === '审批中' && d.after === '已驳回'), '驳回审计 diff 审批中→已驳回', rDiff);

  /* ── G6：parallel_veto ───────────────────────────── */
  console.log('\n── G6 parallel_veto：单票不终态 / 全票通过 / 任一驳回 skipped ──');
  await loginAs(ADMIN);
  const pV = await createProject('B10-parallel ' + stamp, 'A', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PMO, role: 'pmo' }],
  });
  const pVId = pV && pV.id;
  const rvV = okData(
    await call('POST', '/api/reviews', { projectId: pVId, refType: 'project', refId: pVId, reviewType: 'formal', title: '并行通过' }),
    '发起 formal 并行评审',
  );
  const rvVId = rvV && rvV.id;
  const vSteps = rvV && rvV.steps;
  /* 投票人：pmo(ou_zhangmin04), tl(ou_wangqiang02), management(ou_zhoutao08), customer_rep(ou_zhangmin04) */
  await loginAs(PMO);
  let rvV2 = okData(await call('POST', '/api/reviews/' + rvVId + '/approve', { comment: 'pmo 票' }), 'parallel 第 1 票（pmo）');
  assertEq(rvV2 && rvV2.status, '审批中', '单票通过不终态');
  await loginAs(TL);
  rvV2 = okData(await call('POST', '/api/reviews/' + rvVId + '/approve', { comment: 'tl 票' }), 'parallel 第 2 票（tl）');
  assertEq(rvV2 && rvV2.status, '审批中', '两票仍审批中');
  await loginAs(MGMT);
  rvV2 = okData(await call('POST', '/api/reviews/' + rvVId + '/approve', { comment: 'management 票' }), 'parallel 第 3 票（management）');
  assertEq(rvV2 && rvVId && rvV2.status, '审批中', '三票仍审批中');
  /* customer_rep = ou_zhangmin04（同 pmo 人，但角色不同、票独立）：带意见通过 */
  await loginAs(PMO);
  rvV2 = okData(await call('POST', '/api/reviews/' + rvVId + '/approve', { comment: '客户代表意见' }), 'parallel 第 4 票（customer_rep）');
  assertEq(rvV2 && rvV2.status, '已通过', '全票通过 → 已通过');
  assert(rvV2 && rvV2.steps.every((s) => s.status === 'approved'), '全部步骤 approved');

  /* 任一驳回 → 已驳回 + skipped */
  const rvVRej = okData(
    await call('POST', '/api/reviews', { projectId: pVId, refType: 'project', refId: pVId, reviewType: 'formal', title: '并行驳回' }),
    '发起 formal 并行驳回评审',
  );
  const rvVRejId = rvVRej && rvVRej.id;
  await loginAs(TL);
  const rvVRej2 = okData(await call('POST', '/api/reviews/' + rvVRejId + '/reject', { comment: '并行否决' }), '并行任一人驳回');
  assertEq(rvVRej2 && rvVRej2.status, '已驳回', '任一驳回 → 已驳回');
  assert(
    rvVRej2 && rvVRej2.steps.filter((s) => s.status === 'skipped').length === 3 && rvVRej2.steps.filter((s) => s.status === 'rejected').length === 1,
    '其余 3 步 skipped、驳回步 rejected',
    rvVRej2 && rvVRej2.steps.map((s) => s.status),
  );

  /* ── G7：withdraw ────────────────────────────────── */
  console.log('\n── G7 withdraw：发起人 / admin 成功、非发起人 403、已终态 409 ──');
  await loginAs(ADMIN);
  const pW = await createProject('B10-withdraw ' + stamp, 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
  });
  const pWId = pW && pW.id;
  const rvW = okData(
    await call('POST', '/api/reviews', { projectId: pWId, refType: 'project', refId: pWId, reviewType: 'project', title: '撤回评审' }),
    '发起撤回评审（B 类）',
  );
  const rvWId = rvW && rvW.id;
  const rvW2 = okData(await call('POST', '/api/reviews/' + rvWId + '/withdraw', { comment: '误发起撤回' }), '发起人撤回');
  assertEq(rvW2 && rvW2.status, '已撤回', '发起人撤回 → 已撤回');
  assert(!!rvW2 && !!rvW2.closedAt, '撤回 closedAt');
  const withdrawApproval = rvW2 && rvW2.approvals.find((a) => a.action === 'withdraw');
  assert(!!withdrawApproval, '撤回留痕 action=withdraw');
  assertEq(withdrawApproval && withdrawApproval.actorOpenId, ADMIN, 'withdraw actor = 发起人');

  /* 非发起人（且非 admin）撤回 → 403 */
  const rvW3 = okData(
    await call('POST', '/api/reviews', { projectId: pWId, refType: 'project', refId: pWId, reviewType: 'project', title: '他人撤回' }),
    '发起第二个撤回评审',
  );
  const rvW3Id = rvW3 && rvW3.id;
  await loginAs(TL); /* tl 有 review:decide 但非发起人、非 admin */
  r = await call('POST', '/api/reviews/' + rvW3Id + '/withdraw', { comment: 'tl 想撤回' });
  expectError(r, 'E_FORBIDDEN', 403, '非发起人撤回 → 403 E_FORBIDDEN');
  assert((r.json && r.json.message || '').indexOf('仅发起人') >= 0, '撤回 403 文案含「仅发起人」', r.json && r.json.message);

  /* admin 可撤回他人评审 */
  await loginAs(ADMIN);
  const rvW4 = okData(await call('POST', '/api/reviews/' + rvW3Id + '/withdraw', { comment: 'admin 代撤' }), 'admin 撤回他人评审');
  assertEq(rvW4 && rvW4.status, '已撤回', 'admin 撤回成功');

  /* 已终态撤回 → 409 */
  r = await call('POST', '/api/reviews/' + rvWId + '/withdraw', { comment: '再撤' });
  expectError(r, 'E_REVIEW_CLOSED', 409, '已撤回评审再撤回 → 409 E_REVIEW_CLOSED');

  /* ── G8：RBAC / 状态机校验 ───────────────────────── */
  console.log('\n── G8 RBAC/状态：E_NOT_APPROVER / E_PROXY_EVIDENCE_REQUIRED / 驳回必填 / 终态 409 ──');
  await loginAs(ADMIN);
  const pX = await createProject('B10-rbac ' + stamp, 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
  });
  const pXId = pX && pX.id;
  const rvX = okData(
    await call('POST', '/api/reviews', { projectId: pXId, refType: 'project', refId: pXId, reviewType: 'project', title: 'RBAC校验' }),
    '发起 RBAC 校验评审（B 类 [pm,tl]）',
  );
  const rvXId = rvX && rvX.id;
  /* step0 = pm(admin)；tl 尝试批 → 403 */
  await loginAs(TL);
  r = await call('POST', '/api/reviews/' + rvXId + '/approve', { comment: 'tl 越权' });
  expectError(r, 'E_NOT_APPROVER', 403, '非当前审批人 approve → 403 E_NOT_APPROVER');
  r = await call('POST', '/api/reviews/' + rvXId + '/reject', { comment: 'tl 越权驳' });
  expectError(r, 'E_NOT_APPROVER', 403, '非当前审批人 reject → 403 E_NOT_APPROVER');

  /* customer_rep 缺意见且缺凭证 → 400（用 assignees 把 customer_rep 绑给独立用户，
     避免与 pmo 同人时 canDecide 先命中 pmo 步骤） */
  const rvCust = okData(
    await call('POST', '/api/reviews', {
      projectId: pAId, refType: 'project', refId: pAId, reviewType: 'formal', title: '客户代表校验',
      assignees: [PMO, TL, MGMT, MEMBER2],
    }),
    '发起 customer_rep 校验评审（formal，customer_rep=ou_zhengshuang10）',
  );
  const rvCustId = rvCust && rvCust.id;
  const custStepCust = rvCust && rvCust.steps.find((s) => s.role === 'customer_rep');
  assertEq(custStepCust && custStepCust.assigneeOpenId, MEMBER2, 'customer_rep 经 assignees 绑定 ou_zhengshuang10');
  await loginAs(MEMBER2); /* 普通成员，仅作为 customer_rep 步骤的 assignee 可决策 */
  r = await call('POST', '/api/reviews/' + rvCustId + '/approve', { comment: '' });
  expectError(r, 'E_PROXY_EVIDENCE_REQUIRED', 400, 'customer_rep 缺意见缺凭证 approve → 400');
  r = await call('POST', '/api/reviews/' + rvCustId + '/reject', { comment: '' });
  expectError(r, 'E_PROXY_EVIDENCE_REQUIRED', 400, 'customer_rep 缺意见缺凭证 reject → 400');
  /* 带凭证通过 */
  const rvCust2 = okData(await call('POST', '/api/reviews/' + rvCustId + '/approve', { comment: '', evidenceUrl: 'https://feishu.cn/x' }), 'customer_rep 带凭证 approve');
  assertEq(rvCust2 && rvCust2.status, '审批中', 'customer_rep 带凭证可决策');
  /* 带意见通过（同一 customer_rep 步已 approved，其余步仍 current → parallel 未终态） */
  await loginAs(PMO);
  const rvCust3 = okData(await call('POST', '/api/reviews/' + rvCustId + '/approve', { comment: 'pmo 意见' }), 'pmo approve');
  assertEq(rvCust3 && rvCust3.status, '审批中', 'parallel 未终态');

  /* 驳回无意见 → 400 */
  await loginAs(ADMIN);
  const rvNoComment = okData(
    await call('POST', '/api/reviews', { projectId: pXId, refType: 'project', refId: pXId, reviewType: 'project', title: '驳回必填意见' }),
    '发起驳回必填评审',
  );
  const rvNoCommentId = rvNoComment && rvNoComment.id;
  await loginAs(ADMIN);
  r = await call('POST', '/api/reviews/' + rvNoCommentId + '/reject', { comment: '  ' });
  expectError(r, 'E_VALIDATION', 400, '驳回空意见 → 400 E_VALIDATION');
  assert((r.json && r.json.message || '').indexOf('驳回必须填写意见') >= 0, '驳回 400 文案含「驳回必须填写意见」', r.json && r.json.message);

  /* 已终态再操作 → 409 */
  r = await call('POST', '/api/reviews/' + rvRId + '/approve', { comment: '终态后补批' });
  expectError(r, 'E_REVIEW_CLOSED', 409, '已驳回评审再 approve → 409 E_REVIEW_CLOSED');

  /* ── G9：留痕 ───────────────────────────────────── */
  console.log('\n── G9 留痕：review_approvals 行数 = 操作次数；审计事件齐全 ──');
  /* rvSId：submit + approve + approve = 3 */
  const sApprovals = dbAll('SELECT * FROM review_approvals WHERE review_id = ? ORDER BY created_at ASC, id ASC', [rvSId]);
  assertEq(sApprovals.length, 3, 'serial 评审留痕 3 行（submit+2 approve）', sApprovals.map((a) => a.action));
  assertEq(sApprovals[0].action, 'submit', '首行为 submit');
  assertEq(sApprovals[1].action, 'approve', '次行为 approve');
  /* rvRId：submit + reject = 2 */
  const rApprovals = dbAll('SELECT * FROM review_approvals WHERE review_id = ? ORDER BY created_at ASC, id ASC', [rvRId]);
  assertEq(rApprovals.length, 2, '驳回评审留痕 2 行（submit+reject）', rApprovals.map((a) => a.action));
  /* 审批记录字段齐全 */
  const oneAppr = rApprovals[1];
  assert(
    !!oneAppr && oneAppr.step_role === 'pmo' && oneAppr.actor_open_id === PMO && oneAppr.comment === '方案不成立' && !!oneAppr.created_at,
    '审批记录字段齐全（stepRole/actor/comment/createdAt）',
    oneAppr,
  );
  /* 审计事件齐全：create/approve/reject/update(withdraw) */
  const reviewAudits = dbAll("SELECT action, COUNT(*) AS c FROM audit_logs WHERE entity_type='review' GROUP BY action");
  const auditMap = {};
  reviewAudits.forEach(function (a) { auditMap[a.action] = Number(a.c); });
  assert((auditMap.create || 0) >= 10, '审计 review/create 事件存在', auditMap);
  assert((auditMap.approve || 0) >= 6, '审计 review/approve 事件存在', auditMap);
  assert((auditMap.reject || 0) >= 2, '审计 review/reject 事件存在', auditMap);
  assert((auditMap.update || 0) >= 2, '审计 review/update（撤回）事件存在', auditMap);

  /* ── G10：transition ─────────────────────────────── */
  console.log('\n── G10 transition：非法流转 400 / 归档 403 / 结项阻塞 409 / 无阻塞成功 ──');
  await loginAs(ADMIN);
  const pT = await createProject('B10-transition ' + stamp, 'A', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PMO, role: 'pmo' }],
    milestones: [
      { code: 'M1', name: '启动', date: dayOffset(30), required: true, gate: null },
    ],
  });
  const pTId = pT && pT.id;
  /* 非法流转：草稿 → 进行中 */
  r = await transition(pTId, '进行中');
  expectError(r, 'E_VALIDATION', 400, '草稿→进行中 非法流转 → 400');
  assert((r.json && r.json.message || '').indexOf('不允许从') >= 0, '非法流转文案含「不允许从」', r.json && r.json.message);

  /* 归档态：已终止 → 任何 transition 403 */
  await pushProject(pTId, '已批准');
  await transition(pTId, '已终止');
  r = await transition(pTId, '草稿');
  expectError(r, 'E_PROJECT_ARCHIVED', 403, '已终止项目 transition → 403 E_PROJECT_ARCHIVED');

  /* 进行中 → 已结项 有阻塞（未过门 / 未达成碑）→ 409 + blockers */
  const pT2 = await createProject('B10-close-block ' + stamp, 'A', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PMO, role: 'pmo' }],
    milestones: [
      { code: 'M1', name: '启动门', date: dayOffset(30), required: true, gate: { code: 'G1', name: '需求冻结', ownerRole: 'pmo', items: [{ content: '需求清单冻结', ownerRole: 'pmo' }] } },
      { code: 'M2', name: '交付', date: dayOffset(90), required: true, gate: null },
    ],
  });
  const pT2Id = pT2 && pT2.id;
  await pushProject(pT2Id, '进行中');
  r = await transition(pT2Id, '已结项');
  expectError(r, 'E_CLOSE_BLOCKED', 409, '进行中→已结项 有阻塞 → 409 E_CLOSE_BLOCKED');
  const blockers = r.json && r.json.data && r.json.data.blockers;
  assert(Array.isArray(blockers), 'data.blockers 为数组');
  assert(blockers && blockers.some((b) => b.kind === 'gate' && (b.message || '').indexOf('尚未通过') >= 0), '含 gate 阻塞（未过门）', blockers);
  assert(blockers && blockers.some((b) => b.kind === 'milestone' && (b.message || '').indexOf('尚未达成') >= 0), '含 milestone 阻塞（未达成碑）', blockers);
  assert(blockers && blockers.every((b) => b.kind && typeof b.message === 'string'), 'blockers 为 CloseBlocker[]');

  /* 无阻塞 → 结项成功 + 审计 diff */
  const pT3 = await createProject('B10-close-ok ' + stamp, 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
    milestones: [
      { code: 'M1', name: '里程碑一', date: dayOffset(30), required: true, gate: null },
    ],
  });
  const pT3Id = pT3 && pT3.id;
  await pushProject(pT3Id, '进行中');
  /* 直接置 done_at → 无 milestone 阻塞；无门（gate:null）→ 无 gate 阻塞 */
  dbExec('UPDATE milestones SET done_at = ? WHERE project_id = ?', [dayOffset(0), pT3Id]);
  const ccBefore = okData(await call('GET', '/api/projects/' + pT3Id + '/close-check'), 'close-check（无阻塞）');
  assert(Array.isArray(ccBefore) && ccBefore.length === 0, 'close-check 无阻塞返回 []', ccBefore);
  const proj3 = okData(await transition(pT3Id, '已结项'), '进行中→已结项（无阻塞）');
  assertEq(proj3 && proj3.status, '已结项', '结项成功');
  assert(!!proj3 && !!proj3.actualEnd, 'actualEnd 写入');
  const tAudit = dbAll(
    "SELECT * FROM audit_logs WHERE entity_type='project' AND entity_id=? AND action='status_change' ORDER BY created_at DESC",
    [pT3Id],
  );
  const tDiff = tAudit[0] && JSON.parse(tAudit[0].diff || '[]');
  assert(!!tDiff && tDiff.some((d) => d.field === 'status' && d.before === '进行中' && d.after === '已结项'), '结项审计 diff 进行中→已结项', tDiff);

  /* ── G11：Q3 双通道特判 ──────────────────────────── */
  console.log('\n── G11 Q3：审批中 project 评审存在 → 直转 400；无评审 legacy → 直转成功 ──');
  await loginAs(ADMIN);
  const pQ = await createProject('B10-q3 ' + stamp, 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
  });
  const pQId = pQ && pQ.id;
  await pushProject(pQId, '审批中');
  okData(
    await call('POST', '/api/reviews', { projectId: pQId, refType: 'project', refId: pQId, reviewType: 'project', title: 'Q3评审' }),
    '在审批中项目上发起 project 评审',
  );
  r = await transition(pQId, '已批准');
  expectError(r, 'E_VALIDATION', 400, '存在审批中立项评审 → 审批中→已批准 直转 400');
  assert((r.json && r.json.message || '').indexOf('存在审批中的立项评审') >= 0, 'Q3 文案含「存在审批中的立项评审」', r.json && r.json.message);
  r = await transition(pQId, '已驳回');
  expectError(r, 'E_VALIDATION', 400, '存在审批中立项评审 → 审批中→已驳回 直转 400');

  /* legacy：无 project 评审 → 直转成功 */
  const pQ2 = await createProject('B10-q3-legacy ' + stamp, 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
  });
  const pQ2Id = pQ2 && pQ2.id;
  await pushProject(pQ2Id, '审批中');
  const q2 = okData(await transition(pQ2Id, '已批准'), '无评审 legacy 直转 审批中→已批准');
  assertEq(q2 && q2.status, '已批准', 'legacy 直转成功');

  /* ── G12：close-check ───────────────────────────── */
  console.log('\n── G12 close-check：gate/milestone/review 阻塞文案 + 与 transition 同口径 ──');
  await loginAs(ADMIN);
  /* review 阻塞：进行中项目 + 审批中评审 */
  const pRev = await createProject('B10-close-review ' + stamp, 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
    milestones: [{ code: 'M1', name: '里程碑一', date: dayOffset(30), required: true, gate: null }],
  });
  const pRevId = pRev && pRev.id;
  await pushProject(pRevId, '进行中');
  dbExec('UPDATE milestones SET done_at = ? WHERE project_id = ?', [dayOffset(0), pRevId]);
  const rvReview = okData(
    await call('POST', '/api/reviews', { projectId: pRevId, refType: 'project', refId: pRevId, reviewType: 'project', title: '结项拦评审' }),
    '进行中项目发起审批中评审',
  );
  const ccRev = okData(await call('GET', '/api/projects/' + pRevId + '/close-check'), 'close-check（含 review 阻塞）');
  assert(
    ccRev && ccRev.some((b) => b.kind === 'review' && (b.message || '').indexOf('仍在审批中') >= 0),
    'close-check 含 review 阻塞文案',
    ccRev,
  );
  /* 同一项目 transition → 409 且 blockers 与 close-check 一致（同口径） */
  r = await transition(pRevId, '已结项');
  expectError(r, 'E_CLOSE_BLOCKED', 409, '同项目 transition → 409');
  const ccBlockers = r.json && r.json.data && r.json.data.blockers;
  assert(
    Array.isArray(ccBlockers) && ccBlockers.length === ccRev.length &&
      ccBlockers.every((b, i) => b.kind === ccRev[i].kind && b.message === ccRev[i].message),
    'transition blockers 与 close-check 逐项一致',
    { ccBlockers, ccRev },
  );

  /* gate 阻塞文案（pT2 项目，进行中 + 未过门） */
  const ccGate = okData(await call('GET', '/api/projects/' + pT2Id + '/close-check'), 'close-check（gate+milestone 阻塞）');
  assert(ccGate && ccGate.some((b) => b.kind === 'gate' && (b.message || '').indexOf('质量门') >= 0), 'gate 阻塞含「质量门」', ccGate);
  assert(ccGate && ccGate.some((b) => b.kind === 'milestone' && (b.message || '').indexOf('里程碑') >= 0), 'milestone 阻塞含「里程碑」', ccGate);

  /* ── G13：workbench ─────────────────────────────── */
  console.log('\n── G13 workbench：pendingApprovals / myApprovals / reportReminders / filled ──');
  /* 造一个「我参与且进行中」项目给 admin */
  const pWb = await createProject('B10-workbench ' + stamp, 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
    milestones: [{ code: 'M1', name: '里程碑一', date: dayOffset(30), required: true, gate: null }],
  });
  const pWbId = pWb && pWb.id;
  await pushProject(pWbId, '进行中');
  dbExec('UPDATE milestones SET done_at = ? WHERE project_id = ?', [dayOffset(0), pWbId]);

  await loginAs(ADMIN);
  let wb = okData(await call('GET', '/api/workbench'), 'GET /workbench（admin）');
  assert(wb && typeof wb.stats === 'object', '含 stats');
  assert(
    wb && ['pendingApprovals', 'overdueTasks', 'missingReports'].every((k) => typeof wb.stats[k] === 'number' && !Number.isNaN(wb.stats[k])),
    'stats 三数字无 NaN',
    wb && wb.stats,
  );
  assert(wb && Array.isArray(wb.myApprovals) && Array.isArray(wb.reportReminders) && Array.isArray(wb.myProjects) && Array.isArray(wb.myTasks), '四数组齐全');
  assertEq(wb && wb.stats.pendingApprovals, wb && wb.myApprovals.length, 'pendingApprovals === myApprovals.length');
  /* admin 可决策所有审批中评审（D4 兜底）→ 数量应 > 0 */
  assert(wb && wb.myApprovals.length > 0, 'admin 待我审批 > 0（D4 兜底）', wb && wb.stats.pendingApprovals);
  /* myApprovals 字段齐全可渲染 ReviewStepper */
  const first = wb && wb.myApprovals[0];
  assert(
    !!first && typeof first.title === 'string' && typeof first.projectName === 'string' &&
      typeof first.initiatorName === 'string' && typeof first.status === 'string' && Array.isArray(first.steps),
    'myApprovals 字段齐全（title/projectName/initiatorName/status/steps）',
    first && { title: first.title, projectName: first.projectName, initiatorName: first.initiatorName, status: first.status, steps: first.steps && first.steps.length },
  );
  assert(first && first.steps.every((s) => 'role' in s && 'assigneeName' in s && 'status' in s && 'decidedAt' in s && 'comment' in s), 'steps 字段齐全可渲染');

  /* reportReminders：含 pWb 项目（我参与且进行中）、每项目一行、格式正确、filled=false */
  const wbRow = wb && wb.reportReminders.find((x) => x.projectId === pWbId);
  assert(!!wbRow, 'reportReminders 含进行中项目', wb && wb.reportReminders.map((x) => x.projectId));
  assert(!!wbRow && /^\d{4}-W\d{2}$/.test(wbRow.week), 'week 格式 YYYY-Www', wbRow && wbRow.week);
  assert(!!wbRow && /^\d{4}-\d{2}-\d{2}$/.test(wbRow.weekStart) && /^\d{4}-\d{2}-\d{2}$/.test(wbRow.weekEnd), 'weekStart/weekEnd 为 YYYY-MM-DD', wbRow && { s: wbRow.weekStart, e: wbRow.weekEnd });
  assertEq(!!wbRow && wbRow.filled, false, '本周未提交 → filled=false');
  assertEq(wb && wb.stats.missingReports, wb && wb.reportReminders.filter((x) => !x.filled).length, 'missingReports === 未填行数');
  const idSet = new Set(wb && wb.reportReminders.map((x) => x.projectId));
  assertEq(idSet.size, wb && wb.reportReminders.length, 'reportReminders 每项目一行（projectId 去重）');

  /* 提交本周周报 → filled 翻转 + missingReports 减一 */
  const curWeek = weekCodeOf();
  const beforeMissing = wb && wb.stats.missingReports;
  const repSubmit = okData(
    await call('POST', '/api/projects/' + pWbId + '/reports', {
      projectId: pWbId, week: curWeek, doneNote: 'B10 周报验证', planItems: ['完成 B10 验证'],
      resourceNote: '', tasks: [], risks: [],
      submit: true,
    }),
    '提交本周周报',
  );
  assert(!!repSubmit && repSubmit.status === '已提交', '周报提交成功 status=已提交');
  const wb2 = okData(await call('GET', '/api/workbench'), 'GET /workbench（提交周报后）');
  const wbRow2 = wb2 && wb2.reportReminders.find((x) => x.projectId === pWbId);
  assertEq(!!wbRow2 && wbRow2.filled, true, '提交后 filled=true');
  assertEq(wb2 && wb2.stats.missingReports, beforeMissing - 1, '提交后 missingReports 减一', { beforeMissing, after: wb2 && wb2.stats.missingReports });

  /* 草稿不计入 filled */
  dbExec("UPDATE work_reports SET status='草稿' WHERE project_id = ? AND week = ?", [pWbId, curWeek]);
  const wb3 = okData(await call('GET', '/api/workbench'), 'GET /workbench（草稿不计）');
  const wbRow3 = wb3 && wb3.reportReminders.find((x) => x.projectId === pWbId);
  assertEq(!!wbRow3 && wbRow3.filled, false, '草稿不计 filled（filled=false）');

  /* ── G14：weekCode 单测 ──────────────────────────── */
  console.log('\n── G14 weekCode 单测（跨年边界）──');
  const datesLib = require(path.join(ROOT, 'server/lib/dates.js'));
  assertEq(datesLib.weekCode('2026-01-01'), '2026-W01', '2026-01-01 → 2026-W01');
  assertEq(datesLib.weekCode('2025-01-01'), '2025-W01', '2025-01-01 → 2025-W01');
  assertEq(datesLib.weekCode('2021-01-01'), '2020-W53', '2021-01-01 → 2020-W53');
  assertEq(datesLib.weekCode('2022-01-01'), '2021-W52', '2022-01-01 → 2021-W52');
  assertEq(datesLib.weekCode('2026-08-10'), weekCodeOf('2026-08-10'), '2026-08-10 与脚本算法一致');

  /* ── G15：回归基线（D9 legacy 存活 + 契约） ──────── */
  console.log('\n── G15 回归基线：legacy 存活 / listReviews 过滤 / 信封契约 ──');
  await loginAs(ADMIN);
  /* legacy approval-config 仍可用（D9：老审批流保留；legacy 端点为裸对象非信封） */
  r = await call('GET', '/api/approval-config');
  assert(r.status === 200 && r.json && r.json.templates && r.json.templates.A, 'legacy GET /api/approval-config 存活（D9）', r.status);
  /* listReviews 全部倒序 + projectId 过滤 */
  const allReviews = okData(await call('GET', '/api/reviews'), 'GET /reviews');
  assert(Array.isArray(allReviews) && allReviews.length >= 10, '评审列表非空');
  let sortedOk = true;
  for (let i = 1; i < allReviews.length; i += 1) {
    if (allReviews[i - 1].createdAt < allReviews[i].createdAt) { sortedOk = false; break; }
  }
  assert(sortedOk, 'listReviews createdAt 倒序');
  const filtered = okData(await call('GET', '/api/reviews?projectId=' + pAId), 'GET /reviews?projectId=');
  assert(filtered.every((x) => x.projectId === pAId), 'projectId 过滤生效');
  /* getReview 完整对象 */
  const one = okData(await call('GET', '/api/reviews/' + rvSId), 'GET /reviews/:id');
  assert(!!one && Array.isArray(one.steps) && Array.isArray(one.approvals), '详情含 steps/approvals');
  assert(one && one.steps.every((s) => s.reviewId === rvSId) && one.approvals.every((a) => a.reviewId === rvSId), 'steps/approvals reviewId 一致');

  /* ── 汇总 ───────────────────────────────────────── */
  console.log('\n═══ B10 专项验证完成：PASS ' + passed + ' / FAIL ' + failed + ' ═══');
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach(function (f) { console.log('  - ' + f); });
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('qa_b10_verify 运行异常：', e);
  process.exit(1);
});
