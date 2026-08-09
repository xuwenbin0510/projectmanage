#!/usr/bin/env node
/**
 * Connect v1 · 批次 4 冒烟脚本（docs/connect-B4-任务分解.md §六 DoD）
 *
 * 用法：
 *   1. 先起服务：`DB_PATH=./b4_smoke.db node server.js`
 *   2. 另开终端：`DB_PATH=./b4_smoke.db node scripts/smoke_b4.mjs [baseUrl]`
 *      默认 baseUrl = http://127.0.0.1:3000
 *
 * 覆盖域：
 *   ① T01 WBS 骨架自动生成（建项 + 回填脚本幂等）
 *   ② T02 周报后端（迁移 v3 / 列表 / 详情 / 暂存 / 提交 / 编辑 / 强校验 / 联动 / 审计）
 *   ③ T03 浏览器飞书 Web OAuth（缺 code / 降级哨兵码 / 缺凭证）
 *
 * 断言口径与 smoke_b3.mjs 同源：成功恒 `code === 0`（数字），失败恒 `E_` 开头 + 精确 HTTP 状态，
 * 响应体不允许出现 snake_case 字段。
 *
 * 退出码：0 = 全绿；1 = 有断言失败
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
/** globalRole = member 的普通账号（D-2 越权反面用例） */
const MEMBER_OPEN_ID = 'ou_wudi09';

let passed = 0;
let failed = 0;
const failures = [];

/* ── 断言工具 ───────────────────────────────────────── */

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
    failures.push(label + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
    console.log('  \u2717 ' + label + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
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
 * 递归检查对象里是否混入了 snake_case 字段。
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
      /* snapshot 的键是 WBS 节点 id（如 W_xxx），不是字段名，跳过 */
      if (k.indexOf('_') >= 0 && p.indexOf('.snapshot') < 0) bad.push(p + '.' + k);
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
 * @returns {void}
 */
function expectError(r, code, httpStatus, label) {
  assertEq(r.status, httpStatus, label + ' → HTTP ' + httpStatus);
  assertEq(r.json && r.json.code, code, label + ' → code ' + code);
}

/* ── 小工具 ─────────────────────────────────────────── */

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
 * 登录切换账号。
 * @param {string} openId
 * @returns {Promise<object>}
 */
async function loginAs(openId) {
  const r = await call('POST', '/api/auth/devlogin', { openId: openId });
  token = (r.json && r.json.data && r.json.data.token) || '';
  return r;
}

/**
 * 建项目。
 * @param {string} tag
 * @param {Array<object>} milestones
 * @returns {Promise<object>} Project
 */
async function createProject(tag, milestones) {
  const payload = {
    name: 'B4冒烟·' + tag + ' ' + STAMP,
    type: 'A',
    customer: '星舰客户',
    contractAmount: 500,
    background: 'smoke_b4 自动创建',
    goal: ['B4 冒烟验证'],
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
  return okData(r, '建项目「' + tag + '」') || {};
}

/**
 * 打开冒烟库直连连接（用于表结构 / 审计断言）。
 * @returns {import('better-sqlite3').Database}
 */
function openDb() {
  const Database = require('better-sqlite3');
  const dbFile = process.env.DB_PATH ? path.resolve(ROOT, process.env.DB_PATH) : path.join(ROOT, 'pm.db');
  return new Database(dbFile, { readonly: true });
}

/**
 * 本周周编码 `YYYY-Www`（ISO）。
 * @returns {string}
 */
function currentWeekCode() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3); // 移到本周四（ISO 周归属年）
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const firstMon = new Date(jan4);
  firstMon.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const week = Math.round((d.getTime() - firstMon.getTime()) / (7 * 86400000)) + 1;
  return year + '-W' + String(week).padStart(2, '0');
}

/* ── ① T01 WBS 骨架自动生成 ────────────────────────── */

/**
 * @returns {Promise<object>} 建出的项目
 */
async function testWbsSkeleton() {
  console.log('\n─── ① T01 WBS 骨架自动生成 ───');
  await loginAs(ADMIN_OPEN_ID);

  const project = await createProject('SKELETON', [
    { code: 'M1', name: '需求冻结', target: '需求基线', required: true, date: dayOffset(30) },
    { code: 'M2', name: '开发完成', target: '功能齐备', required: true, date: dayOffset(90) },
    { code: 'M3', name: '验收交付', target: '客户签字', required: true, date: dayOffset(150) },
  ]);

  const msRes = await call('GET', '/api/projects/' + project.id + '/milestones');
  const milestones = (msRes.json && msRes.json.data) || [];
  const wbsRes = await call('GET', '/api/projects/' + project.id + '/wbs');
  const nodes = okData(wbsRes, 'WBS 树读取') || [];

  assertEq(nodes.length, milestones.length, '骨架节点数 == 里程碑数（' + milestones.length + '）');
  assert(nodes.every(function (n) { return !!n.milestoneId; }), '每个骨架节点 milestoneId 非空');
  assert(nodes.every(function (n) { return n.level === 1 && !n.parentId; }), '骨架恒为顶层节点（level=1, 无 parent）');
  assert(nodes.every(function (n) { return n.nodeType === 'task'; }), '骨架 nodeType 恒为 task');
  assert(nodes.every(function (n) { return n.progress === 0 && n.status === '待办'; }), '骨架 progress=0 / status=待办');

  const msIds = milestones.map(function (m) { return m.id; }).sort();
  const boundIds = nodes.map(function (n) { return n.milestoneId; }).sort();
  assertEq(JSON.stringify(boundIds), JSON.stringify(msIds), '骨架与里程碑一一对应（无重复 / 无遗漏）');

  return project;
}

/* ── ② T02 周报后端 ────────────────────────────────── */

/**
 * @param {object} project ① 中建出的项目
 * @returns {Promise<void>}
 */
async function testReports(project) {
  console.log('\n─── ② T02 周报后端 ───');
  await loginAs(ADMIN_OPEN_ID);

  /* 迁移 v3：三张表建齐 */
  const conn = openDb();
  const tables = conn
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'work_report%' ORDER BY name")
    .all()
    .map(function (r) { return r.name; });
  conn.close();
  assertEq(
    JSON.stringify(tables),
    JSON.stringify(['work_report_risks', 'work_report_tasks', 'work_reports']),
    'migrationV3 建齐 work_reports / work_report_tasks / work_report_risks',
  );

  const pid = project.id;
  const week = currentWeekCode();

  /* 列表初始为空（且不再是 501 桩） */
  const l0 = await call('GET', '/api/projects/' + pid + '/reports');
  const list0 = okData(l0, '周报列表（初始）');
  assert(Array.isArray(list0) && list0.length === 0, '初始周报列表为空数组');

  /* 详情不存在返回 null（不是 404） */
  const g0 = await call('GET', '/api/projects/' + pid + '/reports/' + week);
  assert(g0.json && g0.json.code === 0 && g0.json.data === null, '未写周报时详情返回 data: null');

  /* 取一个骨架节点用于进度回写 */
  const nodes = ((await call('GET', '/api/projects/' + pid + '/wbs')).json || {}).data || [];
  const target = nodes[0];
  assert(!!target, '存在可回写的骨架节点');

  /* 暂存草稿：允许残缺（无风险责任人也能存） */
  const draftRes = await call('POST', '/api/projects/' + pid + '/reports', {
    submit: false,
    week: week,
    doneNote: '本周完成需求梳理（草稿）',
    planItems: ['下周进入开发'],
    resourceNote: '',
    tasks: nodes.map(function (n) { return { nodeId: n.id, progressAfter: n.progress, selected: false }; }),
    risks: [{ description: '接口未定', owner: '', dueDate: '' }],
  });
  const draft = okData(draftRes, '暂存草稿');
  assertEq(draft && draft.status, '草稿', '草稿 status = 草稿');
  assertEq(draft && draft.submittedAt, null, '草稿 submittedAt = null');
  assertEq(draft && draft.snapshot, null, '草稿 snapshot = null');
  assert(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test((draft && draft.weekStart) || ''), 'weekStart 形态为 YYYY-MM-DDT00:00:00Z');
  assert(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test((draft && draft.weekEnd) || ''), 'weekEnd 形态为 YYYY-MM-DDT00:00:00Z');
  assertEq(draft && draft.author, ADMIN_OPEN_ID, '草稿 author = 当前用户 openId');
  assertEq(draft && draft.tasks.length, nodes.length, '草稿 tasks 全量落行');

  /* 提交强校验：风险缺责任人 → E_REPORT_RISK_INCOMPLETE */
  const badRes = await call('POST', '/api/projects/' + pid + '/reports', {
    submit: true,
    week: week,
    doneNote: '本周完成',
    planItems: ['下周继续'],
    resourceNote: '',
    tasks: [],
    risks: [{ description: '接口未定', owner: '', dueDate: '' }],
  });
  expectError(badRes, 'E_REPORT_RISK_INCOMPLETE', 400, '提交缺风险责任人');
  assert(
    badRes.json && badRes.json.data && Array.isArray(badRes.json.data.invalidRiskRows)
      && badRes.json.data.invalidRiskRows[0] === 1,
    '错误响应带 invalidRiskRows 行号',
    badRes.json && badRes.json.data,
  );

  /* 提交强校验：下周计划为空 */
  const badPlanRes = await call('POST', '/api/projects/' + pid + '/reports', {
    submit: true, week: week, doneNote: 'x', planItems: ['  '], resourceNote: '', tasks: [], risks: [],
  });
  expectError(badPlanRes, 'E_REPORT_RISK_INCOMPLETE', 400, '提交缺下周计划');
  assert(
    ((badPlanRes.json && badPlanRes.json.message) || '').indexOf('「下周计划」至少填写 1 条') >= 0,
    '缺计划文案与 Mock 一致',
    badPlanRes.json && badPlanRes.json.message,
  );

  /* 正式提交：勾选首个节点回写 60% */
  const submitRes = await call('POST', '/api/projects/' + pid + '/reports', {
    submit: true,
    week: week,
    doneNote: '本周完成需求冻结',
    planItems: ['下周进入开发', '补充测试用例'],
    resourceNote: '需要 1 名测试',
    tasks: nodes.map(function (n) {
      return n.id === target.id
        ? { nodeId: n.id, progressAfter: 60, selected: true }
        : { nodeId: n.id, progressAfter: n.progress, selected: false };
    }),
    risks: [{ description: '接口未定', owner: TL_OPEN_ID, dueDate: dayOffset(14) }],
  });
  const submitted = okData(submitRes, '提交周报');
  assertEq(submitted && submitted.status, '已提交', '提交后 status = 已提交');
  assert(!!(submitted && submitted.submittedAt), '提交后 submittedAt 非空');
  assert(
    !!(submitted && submitted.snapshot && submitted.snapshot[target.id] === 60),
    '快照冻结勾选节点进度 60',
    submitted && submitted.snapshot,
  );
  assertEq(
    submitted && Object.keys(submitted.snapshot || {}).length, 1,
    '快照仅含 selected 节点（1 条）',
  );
  assertEq(submitted && submitted.risks.length, 1, '风险行落库 1 条');
  assertEq(submitted && submitted.risks[0].seq, 1, '风险行 seq 从 1 起');
  assertEq(submitted && submitted.risks[0].promotedRiskId, null, '风险行 promotedRiskId = null');
  assertEq(submitted && submitted.planItems.length, 2, 'planItems 落 2 条');

  /* 进度回写 + 状态联动 */
  const nodesAfter = ((await call('GET', '/api/projects/' + pid + '/wbs')).json || {}).data || [];
  const targetAfter = nodesAfter.filter(function (n) { return n.id === target.id; })[0];
  assertEq(targetAfter && targetAfter.progress, 60, '提交后 WBS 节点进度回写为 60');
  assertEq(targetAfter && targetAfter.status, '进行中', '进度 60 → 状态收敛为「进行中」（syncWbsProgressStatus 生效）');

  const msAfter = ((await call('GET', '/api/projects/' + pid + '/milestones')).json || {}).data || [];
  const boundMs = msAfter.filter(function (m) { return m.id === targetAfter.milestoneId; })[0];
  assert(
    !!(boundMs && boundMs.taskStats && boundMs.taskStats.total >= 1),
    '里程碑 taskStats 已刷新（refreshMilestoneStatuses 生效）',
    boundMs && boundMs.taskStats,
  );

  /* 审计落行 */
  const conn2 = openDb();
  const auditRow = conn2
    .prepare("SELECT * FROM audit_logs WHERE entity_type='report' AND entity_id=? ")
    .get(submitted.id);
  conn2.close();
  assert(!!auditRow, "提交写 audit_logs（entity_type='report'）");
  assertEq(auditRow && auditRow.action, 'create', '审计 action = create');
  assert(
    ((auditRow && auditRow.summary) || '').indexOf('冻结 1 条任务进度快照') >= 0,
    '审计 summary 含快照条数',
    auditRow && auditRow.summary,
  );

  /* 同周多次提交：列表 2 条，详情取最新 */
  const l1 = await call('GET', '/api/projects/' + pid + '/reports');
  const list1 = okData(l1, '周报列表（提交后）') || [];
  assertEq(list1.length, 2, '同周可多次写入，列表 2 条（草稿 + 已提交）');
  const g1 = await call('GET', '/api/projects/' + pid + '/reports/' + week);
  const latest = okData(g1, '周报详情（同周最新）');
  assertEq(latest && latest.id, submitted.id, 'getReport 返回同周最新一条（D-3）');

  /* 编辑：作者本人可改，且不改 status / 不回写进度 */
  const patchRes = await call('PATCH', '/api/projects/' + pid + '/reports/' + submitted.id, {
    week: week,
    doneNote: '本周完成需求冻结（已修订）',
    planItems: ['下周进入开发'],
    resourceNote: '需要 2 名测试',
    tasks: submitted.tasks.map(function (t) {
      return { nodeId: t.nodeId, progressAfter: 100, selected: t.selected };
    }),
    risks: [{ description: '接口未定', owner: TL_OPEN_ID, dueDate: dayOffset(14) }],
  });
  const patched = okData(patchRes, '编辑周报');
  assertEq(patched && patched.doneNote, '本周完成需求冻结（已修订）', '编辑更新 doneNote');
  assertEq(patched && patched.planItems.length, 1, '编辑重建 planItems');
  assertEq(patched && patched.status, '已提交', '编辑不改 status');
  assertEq(
    patched && patched.snapshot && patched.snapshot[target.id], 60,
    '编辑不重算快照（仍为提交时冻结值 60）',
  );
  const nodesAfterPatch = ((await call('GET', '/api/projects/' + pid + '/wbs')).json || {}).data || [];
  const targetAfterPatch = nodesAfterPatch.filter(function (n) { return n.id === target.id; })[0];
  assertEq(targetAfterPatch && targetAfterPatch.progress, 60, '编辑不回写 WBS 进度（仍为 60）');

  /* D-2：他人不可编辑 */
  await loginAs(MEMBER_OPEN_ID);
  const forbidRes = await call('PATCH', '/api/projects/' + pid + '/reports/' + submitted.id, {
    week: week, doneNote: '越权改写', planItems: ['x'], resourceNote: '', tasks: [], risks: [],
  });
  expectError(forbidRes, 'E_FORBIDDEN', 403, '非作者非 admin 编辑他人周报（D-2）');
  await loginAs(ADMIN_OPEN_ID);

  /* 不存在的周报 */
  const nfRes = await call('PATCH', '/api/projects/' + pid + '/reports/RP_NOT_EXIST', {
    week: week, doneNote: 'x', planItems: ['x'], resourceNote: '', tasks: [], risks: [],
  });
  expectError(nfRes, 'E_NOT_FOUND', 404, '编辑不存在的周报');
}

/* ── ③ T03 浏览器飞书 Web OAuth ───────────────────── */

/**
 * @returns {Promise<void>}
 */
async function testFeishuWebLogin() {
  console.log('\n─── ③ T03 浏览器飞书 Web OAuth ───');

  /* 缺 code → E_VALIDATION */
  const noCode = await call('POST', '/api/auth/feishu/web', {});
  expectError(noCode, 'E_VALIDATION', 400, '缺 code');

  /* 降级哨兵码（需 ALLOW_DEV_LOGIN=true 且未配 FEISHU_APP_ID/SECRET） */
  const dev = await call('POST', '/api/auth/feishu/web', { code: 'dev:' + ADMIN_OPEN_ID });
  if (dev.json && dev.json.code === 0) {
    const data = okData(dev, '降级哨兵码登录');
    assert(!!(data && data.token), '降级路径签发 token');
    assertEq(data && data.user && data.user.openId, ADMIN_OPEN_ID, '降级路径返回正确用户');
    assert(
      ((dev.json && dev.json.message) || '').indexOf('开发降级') >= 0,
      '降级路径 message 标注「开发降级」',
      dev.json && dev.json.message,
    );

    /* 非 dev 码且缺凭证 → E_FORBIDDEN，文案点名 SECRET */
    const forbid = await call('POST', '/api/auth/feishu/web', { code: 'real-code-xxx' });
    expectError(forbid, 'E_FORBIDDEN', 403, '缺凭证 + 非 dev 码');
    assert(
      ((forbid.json && forbid.json.message) || '').indexOf('FEISHU_APP_SECRET') >= 0,
      'E_FORBIDDEN 文案点名 FEISHU_APP_SECRET',
      forbid.json && forbid.json.message,
    );
  } else {
    console.log('  ⓘ 当前环境已配置飞书凭证，跳过降级路径断言（需真实 code 才能验证）');
    assert(dev.status === 401 || dev.status === 500 || dev.status === 403, '已配凭证时 dev 码被真实换码链路拒绝', dev.json);
  }

  /* 回归：JSSDK 免登路径不受影响 */
  const jssdk = await call('POST', '/api/auth/feishu', {});
  expectError(jssdk, 'E_VALIDATION', 400, '回归 /auth/feishu 缺 code 仍为 E_VALIDATION');

  /* 回归：devlogin 仍可用 */
  const dl = await call('POST', '/api/auth/devlogin', { openId: ADMIN_OPEN_ID });
  const dlData = okData(dl, '回归 devlogin');
  assert(!!(dlData && dlData.token), 'devlogin 仍签发 token');
}

/* ── 主流程 ─────────────────────────────────────────── */

/**
 * @returns {Promise<void>}
 */
async function main() {
  console.log('B4 冒烟 · base = ' + BASE);

  const project = await testWbsSkeleton();
  await testReports(project);
  await testFeishuWebLogin();

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
  console.error('冒烟脚本异常终止：', e);
  process.exit(1);
});
