#!/usr/bin/env node
/**
 * QA 独立抽查 · B4 / N5 修复收口（Round 2 回归补充）
 *
 * 背景：N5 源码 Bug ——「周报提交越权回写其他项目 WBS 进度」。
 * 工程师修复：`server/services/report.service.js#resolveTaskRefs` 新增第三参
 * `projectId`（服务端真源），跨项目 nodeId 一律抛 `E_VALIDATION`（400）。
 *
 * 本脚本在 qa_b4_edge.mjs 的 N5「不泄漏探针」基础上，进一步断言**修复语义本身**：
 *   N5-1 create 路径：跨项目 nodeId 提交 → 显式 400 E_VALIDATION（不是静默吞、不是 500）
 *   N5-2 拒绝文案点名「不属于当前项目」
 *   N5-3 被拒后 MAIN 未落周报行（无部分写入）
 *   N5-4 被拒后 OTHER 目标节点进度未被回写（数据隔离双保险）
 *   N5-5 update 路径：编辑已有周报引用跨项目 nodeId → 同样显式 400 E_VALIDATION
 *   N5-6 update 被拒后原报告内容未被篡改（无部分写入）
 *   N5-7 修复无副作用：同项目节点提交 → 正常落库 + 快照正确
 *   N5-8 同项目进度回写仍生效（WBS 节点 progress 更新）
 *   N5-9 同项目编辑仍正常
 *
 * 用法：
 *   DB_PATH=./qa_b4.db node scripts/qa_b4_n5_spotcheck.mjs http://127.0.0.1:3311
 *   （baseUrl 指向以同一 DB_PATH 启动的服务）
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
const DB_FILE = process.env.DB_PATH || './qa_b4.db';

const ADMIN_OPEN_ID = 'ou_xuwenbin01';   // globalRole = admin
const TL_OPEN_ID = 'ou_wangqiang02';     // globalRole = tl

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
  assert(actual === expected, label, { expected: expected, actual: actual });
}

/* ── HTTP ───────────────────────────────────────────── */

let token = '';

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

function expectError(r, code, httpStatus, label) {
  assertEq(r.status, httpStatus, label + ' → HTTP ' + httpStatus);
  assertEq(r.json && r.json.code, code, label + ' → code ' + code);
}

async function loginAs(openId) {
  const r = await call('POST', '/api/auth/devlogin', { openId: openId }, null);
  token = (r.json && r.json.data && r.json.data.token) || '';
  return token;
}

function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const STAMP = Date.now();

async function createProject(tag, msCount) {
  const milestones = [];
  for (let i = 1; i <= msCount; i += 1) {
    milestones.push({ code: 'M' + i, name: '碑' + i, target: 'T' + i, required: true, date: dayOffset(20 * i) });
  }
  const r = await call('POST', '/api/projects', {
    name: 'QA·N5·' + tag + ' ' + STAMP,
    type: 'A',
    customer: 'QA',
    contractAmount: 100,
    background: 'qa_b4_n5_spotcheck fixture',
    goal: ['N5 修复抽查'],
    planStart: dayOffset(0),
    planEnd: dayOffset(200),
    pm: ADMIN_OPEN_ID,
    classifyInput: {
      contractAmount: 100, hasHardware: true, hasAcceptance: true, isSelfIteration: false, isInfrastructure: false,
    },
    classifySuggested: 'A',
    classifyOverrideReason: '',
    members: [{ userOpenId: ADMIN_OPEN_ID, role: 'pm' }, { userOpenId: TL_OPEN_ID, role: 'tl' }],
    milestones: milestones,
  });
  if (!r.json || r.json.code !== 0) {
    console.error('建项失败：', JSON.stringify(r.json));
    process.exit(1);
  }
  return r.json.data;
}

function validPayload(week, over) {
  return Object.assign({
    submit: true,
    week: week,
    doneNote: 'N5 抽查',
    planItems: ['下周做 Y'],
    resourceNote: '',
    tasks: [],
    risks: [{ description: '风险一', owner: TL_OPEN_ID, dueDate: dayOffset(10) }],
  }, over || {});
}

/* ── 主流程 ─────────────────────────────────────────── */

async function main() {
  console.log('QA·B4 N5 修复抽查 · base = ' + BASE + ' · db = ' + DB_FILE + '\n');

  await loginAs(ADMIN_OPEN_ID);
  const mainProj = await createProject('MAIN', 3);
  const otherProj = await createProject('OTHER', 2);
  const mainUrl = '/api/projects/' + mainProj.id + '/reports';
  const otherUrl = '/api/projects/' + otherProj.id + '/reports';

  const mainNodes = ((await call('GET', '/api/projects/' + mainProj.id + '/wbs')).json || {}).data || [];
  const otherNodes = ((await call('GET', '/api/projects/' + otherProj.id + '/wbs')).json || {}).data || [];
  assert(mainNodes.length >= 1, 'M0 MAIN 项目有骨架节点', mainNodes.length);
  assert(otherNodes.length >= 1, 'M0 OTHER 项目有骨架节点', otherNodes.length);
  const ownNode = mainNodes[0];
  const foreign = otherNodes[0];
  const foreignBefore = foreign.progress;

  console.log('\n─── create 路径：跨项目 nodeId 显式 400 ───');
  const n5post = await call('POST', mainUrl, validPayload('2032-W01', {
    tasks: [{ nodeId: foreign.id, progressAfter: 77, selected: true }],
  }));
  expectError(n5post, 'E_VALIDATION', 400, 'N5-1 跨项目 nodeId 提交被显式拒绝（400 E_VALIDATION）');
  assert(
    ((n5post.json && n5post.json.message) || '').indexOf('不属于当前项目') >= 0,
    'N5-2 拒绝文案点明「不属于当前项目」', n5post.json && n5post.json.message,
  );

  /* 被拒后不得有部分写入 */
  const n5Rejected = await call('GET', mainUrl + '/2032-W01');
  assert(
    n5Rejected.json && n5Rejected.json.code === 0 && n5Rejected.json.data === null,
    'N5-3 被拒提交未落库（MAIN 无 2032-W01 周报行）',
    n5Rejected.json && n5Rejected.json.code,
  );
  const otherAfter = ((await call('GET', '/api/projects/' + otherProj.id + '/wbs')).json || {}).data || [];
  const foreignAfter = otherAfter.filter((n) => n.id === foreign.id)[0];
  const leaked = foreignAfter && foreignAfter.progress === 77 && foreignBefore !== 77;
  assert(
    !leaked,
    'N5-4 被拒后 OTHER 目标节点进度未被回写',
    { before: foreignBefore, after: foreignAfter && foreignAfter.progress },
  );

  console.log('\n─── update 路径：编辑引用跨项目 nodeId 同样显式 400 ───');
  const base = await call('POST', mainUrl, validPayload('2032-W02', {
    tasks: [{ nodeId: ownNode.id, progressAfter: 30, selected: true }],
  }));
  assert(base.json && base.json.code === 0, 'N5-5 先建一条同项目报告供 update 探针', base.json && base.json.code);
  const baseId = base.json.data.id;

  const n5patch = await call('PATCH', mainUrl + '/' + baseId, {
    doneNote: 'update 跨项目探针',
    planItems: ['下周做 Y'],
    tasks: [{ nodeId: foreign.id, progressAfter: 66, selected: true }],
    risks: [],
  });
  expectError(n5patch, 'E_VALIDATION', 400, 'N5-5 编辑引用跨项目 nodeId 亦被拒（400 E_VALIDATION）');

  const afterPatch = await call('GET', mainUrl + '/2032-W02');
  const patchedRep = afterPatch.json && afterPatch.json.data;
  assertEq(patchedRep && patchedRep.doneNote, 'N5 抽查', 'N5-6 update 被拒后原报告内容未被篡改');
  const patchTasks = (patchedRep && patchedRep.tasks || []).filter((t) => t.nodeId === foreign.id);
  assertEq(patchTasks.length, 0, 'N5-6 update 被拒后未写入跨项目任务行');

  console.log('\n─── 修复无副作用：同项目合法流程不受影响 ───');
  const ok = await call('POST', mainUrl, validPayload('2032-W03', {
    tasks: [{ nodeId: ownNode.id, progressAfter: 55, selected: true }],
  }));
  assert(ok.json && ok.json.code === 0, 'N5-7 同项目节点提交仍正常（修复无副作用）', ok.json && ok.json.code);
  assertEq(ok.json && ok.json.data && ok.json.data.snapshot[ownNode.id], 55, 'N5-7 同项目快照记录正确');
  const wbsAfterOk = ((await call('GET', '/api/projects/' + mainProj.id + '/wbs')).json || {}).data || [];
  assertEq(
    wbsAfterOk.filter((n) => n.id === ownNode.id)[0].progress, 55,
    'N5-8 同项目节点进度回写仍生效（WBS progress = 55）',
  );

  const editOk = await call('PATCH', mainUrl + '/' + ok.json.data.id, validPayload('2032-W03', {
    doneNote: '同项目编辑正常',
  }));
  assert(editOk.json && editOk.json.code === 0, 'N5-9 同项目编辑仍正常', editOk.json && editOk.json.code);
  assertEq(editOk.json && editOk.json.data && editOk.json.data.doneNote, '同项目编辑正常', 'N5-9 编辑内容生效');

  console.log('\n══════════════════════════════════════');
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach(function (f) { console.log('  - ' + f); });
  }
  console.log('IS_PASS: ' + (failed === 0 ? 'YES' : 'NO'));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('N5 抽查脚本异常终止：', e && e.stack ? e.stack : e);
  process.exit(1);
});
