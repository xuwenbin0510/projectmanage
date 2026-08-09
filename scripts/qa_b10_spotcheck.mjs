#!/usr/bin/env node
/**
 * QA 独立抽查 · B10 边界补充（T05 之外，工程师未覆盖 / 覆盖薄的边界）
 *
 * 覆盖：
 *  S1  审批链边界：未知 reviewType → 400；未知 project.type → _default 兜底
 *  S2  parallel 部分票已决时其余步骤仍 current（未决态正确）
 *  S3  withdraw 后 steps 状态保持不变（不置 skipped）
 *  S4  customer_rep 经 assignees 覆盖（其余步仍走角色绑定）
 *  S5  transition 全合法边扫一遍（草稿→审批中→已批准→进行中→挂起→进行中→已结项 /
 *      已驳回→草稿 / 已批准→已终止 / 进行中→已终止）
 *  S6  归档态（已结项）所有出边拒绝 403
 *  S7  结项阻塞组合：gate + milestone + review 同时阻塞 → close-check 返回 3 类
 *  S8  Q3 边界：审批中项目存在 **非 project 类型** 评审 → 直转 已批准 成功
 *  S9  工作台：无我参与项目 → 四数组空、stats 0、不崩
 *  S10 工作台：周报编辑（PATCH）后 filled 仍 true（提交态保持）
 *  S11 weekCode 边界：周一起始 / 周末同周 / 跨年 12-29→W01 / weekRange 周一起周日止
 *  S12 非 admin my-approvals 口径：TL 仅在轮到当前步时出现在待我审批
 *  S13 创建评审缺 projectId 的健壮性（期望非 500）
 *
 * 用法：DB_PATH=./b10_qa.db node scripts/qa_b10_spotcheck.mjs http://127.0.0.1:3311
 * 退出码：0 = 全绿；1 = 有失败
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const BASE = (process.argv[2] || 'http://127.0.0.1:3311').replace(/\/$/, '');
const DB_FILE = process.env.DB_PATH || './b10_qa.db';

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
}

function dayOffset(n) {
  const d = new Date(Date.now() + n * 86400000);
  return d.toISOString().slice(0, 10);
}

function openDb() {
  const Database = require('better-sqlite3');
  return new Database(path.resolve(ROOT, DB_FILE), { readonly: true });
}
function dbAll(sql, params) {
  const db = openDb();
  try { return db.prepare(sql).all(...(params || [])); } finally { db.close(); }
}
function dbExec(sql, params) {
  const Database = require('better-sqlite3');
  const db = new Database(path.resolve(ROOT, DB_FILE));
  try { return db.prepare(sql).run(...(params || [])); } finally { db.close(); }
}

let PROJ_SEQ = 0;
async function createProject(name, type, extra) {
  const x = extra || {};
  const members = x.members || [
    { userOpenId: ADMIN, role: 'pm' },
    { userOpenId: TL, role: 'tl' },
  ];
  return okData(
    await call('POST', '/api/projects', {
      name: name,
      type: type || 'A',
      customer: 'B10 spotcheck 客户',
      contractAmount: 300,
      background: 'qa_b10_spotcheck 自动创建',
      goal: ['B10 边界验证'],
      planStart: dayOffset(0),
      planEnd: dayOffset(180),
      pm: ADMIN,
      classifyInput: { contractAmount: 300, hasHardware: type === 'A', hasAcceptance: type === 'A', isSelfIteration: type === 'B', isInfrastructure: type === 'C' },
      classifySuggested: type || 'A',
      classifyOverrideReason: '',
      members: members,
      milestones: x.milestones || [],
    }),
    '建项目 ' + name,
  );
}
async function transition(pid, to, comment) {
  return call('POST', '/api/projects/' + pid + '/transition', { to: to, comment: comment || '' });
}
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

async function main() {
  console.log('═══ B10 边界独立抽查（' + BASE + ' / DB=' + DB_FILE + '）═══');
  await loginAs(ADMIN);
  assert(!!token, '管理员登录');

  /* ── S1：审批链边界 ────────────────────────────── */
  console.log('\n── S1 未知 reviewType / 未知 project.type 兜底 ──');
  const pS1 = await createProject('S1-链 ' + Date.now(), 'A', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PMO, role: 'pmo' }],
  });
  const pS1Id = pS1 && pS1.id;
  let r = await call('POST', '/api/reviews', { projectId: pS1Id, reviewType: 'bogus', title: '未知类型' });
  expectError(r, 'E_VALIDATION', 400, '未知 reviewType → 400 E_VALIDATION');
  r = await call('POST', '/api/reviews', { projectId: pS1Id, reviewType: 'project', title: '  ' });
  expectError(r, 'E_VALIDATION', 400, '空 title → 400 E_VALIDATION');
  /* 未知 project.type → _default ['pm','tl'] 兜底（DB 直改 type='X'） */
  dbExec("UPDATE projects SET type='X' WHERE id=?", [pS1Id]);
  const rvX = okData(
    await call('POST', '/api/reviews', { projectId: pS1Id, refType: 'project', refId: pS1Id, reviewType: 'project', title: '未知类型兜底' }),
    '未知 project.type 发起 project 评审',
  );
  assertEq(rvX && rvX.templateKey, 'project:X', '未知 type → templateKey project:X');
  assert(rvX && rvX.steps.length === 2, '未知 type → _default 链 2 步', rvX && rvX.steps.map((s) => s.role));
  assertEq(rvX && rvX.steps[0].role, 'pm', '_default step0 pm');
  assertEq(rvX && rvX.steps[1].role, 'tl', '_default step1 tl');

  /* ── S2：parallel 部分票已决，其余步仍 current ──── */
  console.log('\n── S2 parallel 部分票已决时其余步骤未决态 ──');
  const pS2 = await createProject('S2-par ' + Date.now(), 'A', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PMO, role: 'pmo' }],
  });
  const pS2Id = pS2 && pS2.id;
  const rvPar = okData(
    await call('POST', '/api/reviews', { projectId: pS2Id, reviewType: 'formal', title: '并行部分票' }),
    '发起 formal（4 步 parallel）',
  );
  const rvParId = rvPar && rvPar.id;
  await loginAs(PMO);
  okData(await call('POST', '/api/reviews/' + rvParId + '/approve', { comment: '第 1 票' }), 'pmo 第 1 票');
  const rvPar2 = okData(await call('POST', '/api/reviews/' + rvParId + '/approve', { comment: 'customer_rep 票' }), 'customer_rep（同为 pmo）第 2 票');
  assertEq(rvPar2 && rvPar2.status, '审批中', '两票后仍审批中');
  const voted = rvPar2 && rvPar2.steps.filter((s) => s.status === 'approved');
  const open = rvPar2 && rvPar2.steps.filter((s) => s.status === 'current');
  assertEq(voted && voted.length, 2, '已决 2 步 approved', voted && voted.map((s) => s.role));
  assertEq(open && open.length, 2, '其余 2 步仍 current（未决态）', open && open.map((s) => s.role));
  assert(rvPar2 && rvPar2.steps.every((s) => s.status !== 'pending'), 'parallel 无 pending 步骤');

  /* ── S3：withdraw 后 steps 状态保持不变 ─────────── */
  console.log('\n── S3 withdraw 后步骤状态不变（不置 skipped）──');
  await loginAs(ADMIN);
  const pS3 = await createProject('S3-wd ' + Date.now(), 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
  });
  const pS3Id = pS3 && pS3.id;
  const rvW = okData(
    await call('POST', '/api/reviews', { projectId: pS3Id, reviewType: 'project', title: '撤回边界' }),
    '发起 B 类 project 评审',
  );
  const rvWId = rvW && rvW.id;
  /* step0 pm(admin) 通过 → step1 current */
  await loginAs(ADMIN);
  okData(await call('POST', '/api/reviews/' + rvWId + '/approve', { comment: 'pm 过' }), 'step0 approve');
  const beforeW = okData(await call('GET', '/api/reviews/' + rvWId), 'GET 评审（撤回前）');
  okData(await call('POST', '/api/reviews/' + rvWId + '/withdraw', { comment: '撤回' }), '发起人撤回');
  const afterW = okData(await call('GET', '/api/reviews/' + rvWId), 'GET 评审（撤回后）');
  assertEq(afterW && afterW.status, '已撤回', '撤回后 status 已撤回');
  assertEq(afterW && afterW.steps[0].status, 'approved', '撤回后 step0 保持 approved（不重置）');
  assertEq(afterW && afterW.steps[1].status, 'current', '撤回后 step1 保持 current（不置 skipped）');
  assert(
    JSON.stringify(afterW && afterW.steps.map((s) => s.status)) === JSON.stringify(beforeW && beforeW.steps.map((s) => s.status)),
    '撤回前后 steps 状态完全一致（仅 review 状态变更）',
    { before: beforeW && beforeW.steps.map((s) => s.status), after: afterW && afterW.steps.map((s) => s.status) },
  );

  /* ── S4：customer_rep assignees 覆盖（其余步角色绑定） ── */
  console.log('\n── S4 customer_rep assignees 覆盖 + 其余步角色绑定 ──');
  const pS4 = await createProject('S4-cust ' + Date.now(), 'A', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PMO, role: 'pmo' }],
  });
  const pS4Id = pS4 && pS4.id;
  /* assignees 只覆盖 4 步中的 customer_rep 位（第 4 位）；前 3 位不给 → 走角色绑定 */
  const rvCust = okData(
    await call('POST', '/api/reviews', { projectId: pS4Id, reviewType: 'formal', title: 'cust覆盖', assignees: [undefined, undefined, undefined, MEMBER2] }),
    '发起 formal（仅第 4 位 assignee）',
  );
  assertEq(rvCust && rvCust.steps[0].assigneeOpenId, PMO, 'step0 pmo 角色绑定');
  assertEq(rvCust && rvCust.steps[1].assigneeOpenId, TL, 'step1 tl 角色绑定');
  assertEq(rvCust && rvCust.steps[2].assigneeOpenId, MGMT, 'step2 management 全局绑定');
  assertEq(rvCust && rvCust.steps[3].assigneeOpenId, MEMBER2, 'step3 customer_rep 经 assignees 覆盖');

  /* ── S5：transition 全合法边扫 ──────────────────── */
  console.log('\n── S5 transition 全合法边 ──');
  await loginAs(ADMIN);
  const pS5 = await createProject('S5-flow ' + Date.now(), 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
    milestones: [{ code: 'M1', name: '里程碑一', date: dayOffset(30), required: true, gate: null }],
  });
  const pS5Id = pS5 && pS5.id;
  let p = okData(await transition(pS5Id, '审批中'), '草稿→审批中');
  assertEq(p && p.status, '审批中', '草稿→审批中 OK');
  p = okData(await transition(pS5Id, '已批准'), '审批中→已批准（无 project 评审，legacy 直转）');
  assertEq(p && p.status, '已批准', '审批中→已批准 OK');
  p = okData(await transition(pS5Id, '进行中'), '已批准→进行中');
  assertEq(p && p.status, '进行中', '已批准→进行中 OK');
  p = okData(await transition(pS5Id, '挂起'), '进行中→挂起');
  assertEq(p && p.status, '挂起', '进行中→挂起 OK');
  p = okData(await transition(pS5Id, '进行中'), '挂起→进行中');
  assertEq(p && p.status, '进行中', '挂起→进行中 OK');
  dbExec('UPDATE milestones SET done_at = ? WHERE project_id = ?', [dayOffset(0), pS5Id]);
  p = okData(await transition(pS5Id, '已结项'), '进行中→已结项（无阻塞）');
  assertEq(p && p.status, '已结项', '进行中→已结项 OK');
  /* 已驳回→草稿 */
  const pS5b = await createProject('S5-flow2 ' + Date.now(), 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
  });
  const pS5bId = pS5b && pS5b.id;
  await transition(pS5bId, '审批中');
  await transition(pS5bId, '已驳回');
  p = okData(await transition(pS5bId, '草稿'), '已驳回→草稿');
  assertEq(p && p.status, '草稿', '已驳回→草稿 OK');
  /* 已批准→已终止 */
  const pS5c = await createProject('S5-flow3 ' + Date.now(), 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
  });
  const pS5cId = pS5c && pS5c.id;
  await transition(pS5cId, '审批中');
  await transition(pS5cId, '已批准');
  p = okData(await transition(pS5cId, '已终止'), '已批准→已终止');
  assertEq(p && p.status, '已终止', '已批准→已终止 OK');
  /* 进行中→已终止 */
  const pS5d = await createProject('S5-flow4 ' + Date.now(), 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
  });
  const pS5dId = pS5d && pS5d.id;
  await transition(pS5dId, '审批中');
  await transition(pS5dId, '已批准');
  await transition(pS5dId, '进行中');
  p = okData(await transition(pS5dId, '已终止'), '进行中→已终止');
  assertEq(p && p.status, '已终止', '进行中→已终止 OK');

  /* ── S6：归档态所有出边拒绝 ─────────────────────── */
  console.log('\n── S6 归档态（已结项）无出边 ──');
  r = await transition(pS5Id, '草稿');
  expectError(r, 'E_PROJECT_ARCHIVED', 403, '已结项 → 草稿 403');
  r = await transition(pS5Id, '审批中');
  expectError(r, 'E_PROJECT_ARCHIVED', 403, '已结项 → 审批中 403');
  r = await transition(pS5cId, '草稿');
  expectError(r, 'E_PROJECT_ARCHIVED', 403, '已终止 → 草稿 403');

  /* ── S7：结项阻塞组合（gate+milestone+review） ───── */
  console.log('\n── S7 结项阻塞组合：gate + milestone + review 同时阻塞 ──');
  const pS7 = await createProject('S7-block ' + Date.now(), 'A', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PMO, role: 'pmo' }],
    milestones: [
      { code: 'M1', name: '启动门', date: dayOffset(30), required: true, gate: { code: 'G1', name: '需求冻结', ownerRole: 'pmo', items: [{ content: '需求清单冻结', ownerRole: 'pmo' }] } },
      { code: 'M2', name: '交付', date: dayOffset(90), required: true, gate: null },
    ],
  });
  const pS7Id = pS7 && pS7.id;
  await pushProject(pS7Id, '进行中');
  await loginAs(ADMIN);
  okData(
    await call('POST', '/api/reviews', { projectId: pS7Id, refType: 'project', refId: pS7Id, reviewType: 'project', title: '结项组合评审' }),
    '进行中项目发起审批中评审',
  );
  const cc7 = okData(await call('GET', '/api/projects/' + pS7Id + '/close-check'), 'close-check（组合阻塞）');
  const kinds = (cc7 || []).map((b) => b.kind);
  assert(kinds.indexOf('gate') >= 0, '含 gate 阻塞', kinds);
  assert(kinds.indexOf('milestone') >= 0, '含 milestone 阻塞', kinds);
  assert(kinds.indexOf('review') >= 0, '含 review 阻塞', kinds);
  assert(kinds.length >= 3, '至少 3 类阻塞', kinds);
  r = await transition(pS7Id, '已结项');
  expectError(r, 'E_CLOSE_BLOCKED', 409, '组合阻塞 transition → 409');
  const rb = r.json && r.json.data && r.json.data.blockers;
  assert(Array.isArray(rb) && rb.length === cc7.length, 'transition blockers 与 close-check 数量一致', { rb: rb && rb.length, cc: cc7 && cc7.length });

  /* ── S8：Q3 边界（非 project 评审不拦截直转） ────── */
  console.log('\n── S8 Q3 边界：非 project 类型评审不拦截 审批中→已批准 ──');
  const pS8 = await createProject('S8-q3b ' + Date.now(), 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
  });
  const pS8Id = pS8 && pS8.id;
  await pushProject(pS8Id, '审批中');
  await loginAs(ADMIN);
  okData(
    await call('POST', '/api/reviews', { projectId: pS8Id, refType: 'project', refId: pS8Id, reviewType: 'formal', title: '非立项评审' }),
    '审批中项目发起 formal 评审（非 project 类型）',
  );
  const p8 = okData(await transition(pS8Id, '已批准'), '审批中→已批准（仅有 formal 评审）');
  assertEq(p8 && p8.status, '已批准', '非 project 评审不触发 Q3 拦截 → 直转成功');

  /* ── S9：工作台无我参与项目 ─────────────────────── */
  console.log('\n── S9 工作台：无参与项目用户（CM）──');
  await loginAs(CM);
  const wbEmpty = okData(await call('GET', '/api/workbench'), 'GET /workbench（cm）');
  assert(wbEmpty && wbEmpty.stats && wbEmpty.stats.pendingApprovals === 0 && wbEmpty.stats.missingReports === 0 && wbEmpty.stats.overdueTasks === 0, 'cm stats 全 0', wbEmpty && wbEmpty.stats);
  assert(Array.isArray(wbEmpty && wbEmpty.myProjects) && wbEmpty.myProjects.length === 0, 'cm myProjects 空');
  assert(Array.isArray(wbEmpty && wbEmpty.myTasks) && wbEmpty.myTasks.length === 0, 'cm myTasks 空');
  assert(Array.isArray(wbEmpty && wbEmpty.reportReminders) && wbEmpty.reportReminders.length === 0, 'cm reportReminders 空');
  assert(wbEmpty && wbEmpty.stats && !Number.isNaN(wbEmpty.stats.pendingApprovals) && !Number.isNaN(wbEmpty.stats.missingReports), 'cm stats 无 NaN');

  /* ── S10：周报编辑后 filled 仍 true ──────────────── */
  console.log('\n── S10 周报编辑（PATCH）后 filled 保持 ──');
  await loginAs(ADMIN);
  const pS10 = await createProject('S10-rep ' + Date.now(), 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
    milestones: [{ code: 'M1', name: '里程碑一', date: dayOffset(30), required: true, gate: null }],
  });
  const pS10Id = pS10 && pS10.id;
  await pushProject(pS10Id, '进行中');
  dbExec('UPDATE milestones SET done_at = ? WHERE project_id = ?', [dayOffset(0), pS10Id]);
  const curWeek = (() => {
    const d = new Date();
    const ms = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    const day = new Date(ms);
    const dow = (day.getUTCDay() + 6) % 7;
    const thu = new Date(ms); thu.setUTCDate(day.getUTCDate() + (3 - dow));
    const y = thu.getUTCFullYear();
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const j4d = (jan4.getUTCDay() + 6) % 7;
    const w1 = new Date(jan4); w1.setUTCDate(jan4.getUTCDate() - j4d);
    const wk = Math.floor((thu.getTime() - w1.getTime()) / 86400000 / 7) + 1;
    return y + '-W' + String(wk).padStart(2, '0');
  })();
  const rep = okData(
    await call('POST', '/api/projects/' + pS10Id + '/reports', {
      projectId: pS10Id, week: curWeek, doneNote: 'S10 周报', planItems: ['X'], resourceNote: '', tasks: [], risks: [], submit: true,
    }),
    '提交周报',
  );
  assert(!!rep && rep.id, '周报提交成功');
  const wbA = okData(await call('GET', '/api/workbench'), 'GET /workbench（提交后）');
  assertEq(!!wbA && wbA.reportReminders.find((x) => x.projectId === pS10Id).filled, true, '提交后 filled=true');
  const repEdit = okData(
    await call('PATCH', '/api/projects/' + pS10Id + '/reports/' + rep.id, { doneNote: 'S10 周报编辑后' }),
    'PATCH 编辑周报',
  );
  assert(!!repEdit, '周报编辑成功');
  const wbB = okData(await call('GET', '/api/workbench'), 'GET /workbench（编辑后）');
  assertEq(!!wbB && wbB.reportReminders.find((x) => x.projectId === pS10Id).filled, true, '编辑后 filled 仍 true（已提交态保持）');
  assertEq(wbB && wbB.stats.missingReports, wbA && wbA.stats.missingReports, '编辑后 missingReports 不变');

  /* ── S11：weekCode 边界 ─────────────────────────── */
  console.log('\n── S11 weekCode 边界（周一起始 / 周末 / 跨年）──');
  const datesLib = require(path.join(ROOT, 'server/lib/dates.js'));
  assertEq(datesLib.weekCode('2026-08-10'), '2026-W33', '2026-08-10（周一）→ 2026-W33');
  assertEq(datesLib.weekCode('2026-08-16'), '2026-W33', '2026-08-16（周日）→ 2026-W33（与周一同周）');
  assertEq(datesLib.weekCode('2026-08-17'), '2026-W34', '2026-08-17（下周一）→ 2026-W34');
  assertEq(datesLib.weekCode('2025-12-29'), '2026-W01', '2025-12-29（周一跨年）→ 2026-W01');
  assertEq(datesLib.weekCode('2024-12-30'), '2025-W01', '2024-12-30（周一跨年）→ 2025-W01');
  assertEq(datesLib.weekCode('2020-12-28'), '2020-W53', '2020-12-28（周一）→ 2020-W53（跨年 53 周）');
  const wr = datesLib.weekRange('2026-W33');
  assertEq(wr.start, '2026-08-10T00:00:00Z', 'weekRange 2026-W33 start = 周一');
  assertEq(wr.end, '2026-08-16T00:00:00Z', 'weekRange 2026-W33 end = 周日');

  /* ── S12：非 admin my-approvals 口径 ─────────────── */
  console.log('\n── S12 非 admin my-approvals（TL 仅在轮到当前步时出现）──');
  await loginAs(ADMIN);
  const pS12 = await createProject('S12-appr ' + Date.now(), 'B', {
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }, { userOpenId: PO, role: 'po' }],
  });
  const pS12Id = pS12 && pS12.id;
  const rv12 = okData(
    await call('POST', '/api/reviews', { projectId: pS12Id, reviewType: 'project', title: 'TL审批口径' }),
    '发起 B 类评审（链 pm→tl）',
  );
  const rv12Id = rv12 && rv12.id;
  await loginAs(TL);
  let myApprTL = okData(await call('GET', '/api/reviews/my-approvals'), 'TL my-approvals（step0=pm）');
  assert(!myApprTL.some((x) => x.id === rv12Id), 'step0 未轮到 TL → TL 待办不含该评审');
  await loginAs(ADMIN);
  okData(await call('POST', '/api/reviews/' + rv12Id + '/approve', { comment: 'pm 过' }), 'step0 pm 通过');
  await loginAs(TL);
  myApprTL = okData(await call('GET', '/api/reviews/my-approvals'), 'TL my-approvals（step1=tl）');
  assert(myApprTL.some((x) => x.id === rv12Id), 'step1 轮到 TL → TL 待办包含该评审');
  const tlReview = myApprTL.find((x) => x.id === rv12Id);
  assert(!!tlReview && tlReview.currentStep === 1 && tlReview.steps[1].status === 'current', 'TL 待办评审 currentStep=1 且 step1 current');

  /* ── S13：创建评审缺 projectId 健壮性 ────────────── */
  console.log('\n── S13 缺 projectId 健壮性（期望 400/404，非 500）──');
  await loginAs(ADMIN);
  r = await call('POST', '/api/reviews', { reviewType: 'project', title: '缺 projectId' });
  assert(r.status !== 500, '缺 projectId 非 500', { status: r.status, code: r.json && r.json.code, message: r.json && r.json.message });
  assert(r.status === 404 || r.status === 400, '缺 projectId → 400 或 404', { status: r.status, code: r.json && r.json.code });
  assert(!r.json || findSnakeCaseKeys(r.json).length === 0, '缺 projectId 错误响应无 snake_case');

  /* ── 汇总 ───────────────────────────────────────── */
  console.log('\n═══ B10 边界抽查完成：PASS ' + passed + ' / FAIL ' + failed + ' ═══');
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach(function (f) { console.log('  - ' + f); });
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('qa_b10_spotcheck 运行异常：', e);
  process.exit(1);
});
