#!/usr/bin/env node
/**
 * Connect v1 · 批次 1 冒烟脚本（设计方案 §8 验收清单）
 *
 * 用法：
 *   1. 先起服务：`node server.js`
 *   2. 另开终端：`node scripts/smoke_connect.mjs [baseUrl]`
 *      默认 baseUrl = http://127.0.0.1:3000
 *
 * 断言口径（不是「能返回就算过」）：
 *   - 信封形态：成功恒 `code === 0`（数字），失败恒 `E_` 开头字符串
 *   - 字段命名：一律 camelCase，**响应体里不允许出现下划线字段**
 *   - 列表口径：仅 listProjects / listAudit 是 `Paged`，其余 `data` 直接是数组
 *   - 错误码：建项三条校验必须精确命中 E_ROLE_CARDINALITY / E_PROJECT_PO_REQUIRED /
 *             E_CLASSIFY_REASON_REQUIRED，而不是笼统的 E_VALIDATION
 *
 * 退出码：0 = 全绿；1 = 有断言失败（CI 可直接用）
 */

const BASE = (process.argv[2] || process.env.SMOKE_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');

/** 演示账号：李明（pm），来自 web/src/config/demoAccounts.ts */
const DEMO_OPEN_ID = 'ou_liming03';

let passed = 0;
let failed = 0;
const failures = [];

/* ── 断言工具 ───────────────────────────────────────── */

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
    failures.push(label);
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
 * 递归检查对象里是否混入了 snake_case 字段（§3.8：前端永远见不到下划线）。
 * @param {*} value
 * @param {string} [pathStr]
 * @returns {string[]} 违规字段路径
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
  assert(r.json && r.json.code === 0, label + ' → code === 0（数字）', { status: r.status, code: r.json && r.json.code });
  const snake = findSnakeCaseKeys(r.json && r.json.data);
  assert(snake.length === 0, label + ' → 响应无 snake_case 字段', snake.slice(0, 5));
  return r.json ? r.json.data : null;
}

/**
 * 断言「失败信封」命中指定错误码。
 * @param {{status:number, json:any}} r
 * @param {string} code
 * @param {number} httpStatus
 * @param {string} label
 */
function expectError(r, code, httpStatus, label) {
  assertEq(r.status, httpStatus, label + ' → HTTP ' + httpStatus);
  assertEq(r.json && r.json.code, code, label + ' → code ' + code);
}

/* ── 用例 ───────────────────────────────────────────── */

/** 今天 + n 天 → YYYY-MM-DD */
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log('[smoke] target = ' + BASE + '\n');

  /* ① 免密登录 */
  console.log('① POST /api/auth/devlogin');
  const login = await call('POST', '/api/auth/devlogin', { openId: DEMO_OPEN_ID });
  const session = okData(login, 'devlogin');
  assert(!!(session && session.token), 'devlogin → 返回 token');
  assertEq(session && session.user && session.user.globalRole, 'pm', 'devlogin → user.globalRole === "pm"');
  assert(!!(session && session.user && session.user.name), 'devlogin → user.name 非空');
  token = (session && session.token) || '';

  const bad = await call('POST', '/api/auth/devlogin', { openId: 'ou_not_exist_xxx' });
  expectError(bad, 'E_NOT_FOUND', 404, 'devlogin 不存在的账号');

  /* ② 当前用户 */
  console.log('\n② GET /api/auth/me');
  const me = okData(await call('GET', '/api/auth/me'), 'me');
  assertEq(me && me.openId, DEMO_OPEN_ID, 'me → 直接返回 User（不是 {user}）');

  const noAuthToken = token;
  token = '';
  const unauth = await call('GET', '/api/auth/me');
  expectError(unauth, 'E_UNAUTHORIZED', 401, '未带令牌访问 me');
  token = noAuthToken;

  /* ③ 元数据 + 模板 */
  console.log('\n③ GET /api/meta, /api/meta/templates/A');
  const meta = okData(await call('GET', '/api/meta'), 'meta');
  assert(Array.isArray(meta && meta.templates) && meta.templates.length >= 3, 'meta → templates 至少 3 套 (A/B/C)');
  assert(Array.isArray(meta && meta.reviewTemplates) && meta.reviewTemplates.length > 0, 'meta → reviewTemplates 非空');
  assert(typeof (meta && meta.wipDefault) === 'number', 'meta → wipDefault 为数字');

  const tplA = okData(await call('GET', '/api/meta/templates/A'), 'template A');
  assert(!!(tplA && tplA.definition && tplA.definition.milestones.length > 0), 'template A → definition.milestones 非空');
  const tplX = await call('GET', '/api/meta/templates/X');
  assertEq(tplX.json && tplX.json.code, 0, '未知类型模板 → code 0（不抛 404）');
  assertEq(tplX.json && tplX.json.data, null, '未知类型模板 → data === null');

  /* ④ 分类判定 */
  console.log('\n④ POST /api/projects/classify');
  const cA = okData(
    await call('POST', '/api/projects/classify', {
      contractAmount: 500, hasHardware: true, hasAcceptance: true, isSelfIteration: false, isInfrastructure: false,
    }),
    'classify A',
  );
  assertEq(cA && cA.suggested, 'A', 'classify 硬件+验收 → A');
  const cB = okData(
    await call('POST', '/api/projects/classify', {
      contractAmount: 20, hasHardware: false, hasAcceptance: false, isSelfIteration: true, isInfrastructure: false,
    }),
    'classify B',
  );
  assertEq(cB && cB.suggested, 'B', 'classify 自研迭代 → B');
  const cC = okData(
    await call('POST', '/api/projects/classify', {
      contractAmount: 300, hasHardware: true, hasAcceptance: true, isSelfIteration: true, isInfrastructure: true,
    }),
    'classify C',
  );
  assertEq(cC && cC.suggested, 'C', 'classify 基建（最高优先）→ C');
  assert(Array.isArray(cC && cC.reasons) && cC.reasons.length > 0, 'classify → reasons 非空');

  /* ⑤ 用户列表（建项向导选成员用） */
  console.log('\n⑤ GET /api/admin/users');
  const users = okData(await call('GET', '/api/admin/users'), 'admin/users');
  assert(Array.isArray(users), 'admin/users → data 直接是数组（无 {list,total} 包裹）');
  assert(users.length >= 10, 'admin/users → 已种子化 10 个演示账号', { count: users.length });
  assert(users.every(function (u) { return typeof u.globalRole === 'string' && u.globalRole; }), 'admin/users → 每人都有 globalRole');

  const pickBy = function (role) {
    const hit = users.filter(function (u) { return u.globalRole === role; })[0];
    return hit ? hit.openId : users[0].openId;
  };
  const pmOpenId = DEMO_OPEN_ID;
  const tlOpenId = pickBy('tl');
  const poOpenId = pickBy('po');
  const qaOpenId = pickBy('qa');

  /* ⑥ 建项三条校验 */
  console.log('\n⑥ POST /api/projects · 校验分支');
  const baseProject = {
    name: '冒烟测试项目 ' + Date.now(),
    type: 'A',
    customer: '星舰客户',
    contractAmount: 500,
    background: '冒烟脚本自动创建',
    goal: ['验证建项事务'],
    planStart: dayOffset(0),
    planEnd: dayOffset(120),
    pm: pmOpenId,
    classifyInput: { contractAmount: 500, hasHardware: true, hasAcceptance: true, isSelfIteration: false, isInfrastructure: false },
    classifySuggested: 'A',
    classifyOverrideReason: '',
    members: [{ userOpenId: pmOpenId, role: 'pm' }, { userOpenId: tlOpenId, role: 'tl' }],
  };

  const missTl = await call('POST', '/api/projects', Object.assign({}, baseProject, {
    members: [{ userOpenId: pmOpenId, role: 'pm' }],
  }));
  expectError(missTl, 'E_ROLE_CARDINALITY', 400, '缺 TL');

  const missPo = await call('POST', '/api/projects', Object.assign({}, baseProject, {
    type: 'B', classifySuggested: 'B',
    classifyInput: { contractAmount: 20, hasHardware: false, hasAcceptance: false, isSelfIteration: true, isInfrastructure: false },
  }));
  expectError(missPo, 'E_PROJECT_PO_REQUIRED', 400, 'B 类缺 PO');

  const missReason = await call('POST', '/api/projects', Object.assign({}, baseProject, {
    type: 'C', classifySuggested: 'A', classifyOverrideReason: '',
  }));
  expectError(missReason, 'E_CLASSIFY_REASON_REQUIRED', 400, '覆盖分类未填理由');

  const noName = await call('POST', '/api/projects', Object.assign({}, baseProject, { name: '  ' }));
  expectError(noName, 'E_VALIDATION', 400, '项目名为空');
  assert(
    !!(noName.json && noName.json.data && Array.isArray(noName.json.data.fields)),
    'E_VALIDATION → data.fields 为结构化数组',
  );

  /* ⑦ 建项成功 */
  console.log('\n⑦ POST /api/projects · 成功路径');
  const created = okData(await call('POST', '/api/projects', baseProject), 'createProject');
  assert(!!(created && created.id), 'createProject → 返回 id');
  assertEq(created && created.type, 'A', 'createProject → type = A');
  assertEq(created && created.status, '草稿', 'createProject → status 默认「草稿」');
  assertEq(created && created.health, 'green', 'createProject → health 默认 green');
  assert(Array.isArray(created && created.goal), 'createProject → goal 是真数组');
  assert(!!(created && created.classifyInput && typeof created.classifyInput === 'object'), 'createProject → classifyInput 是真对象');
  assert(!!(created && created.code), 'createProject → 自动生成 code');
  const projectId = created ? created.id : '';

  /* ⑧ 项目列表（唯一分页接口之一） */
  console.log('\n⑧ GET /api/projects');
  const page = okData(await call('GET', '/api/projects?page=1&pageSize=20'), 'listProjects');
  assert(Array.isArray(page && page.items), 'listProjects → data.items 是数组');
  assertEq(typeof (page && page.page), 'number', 'listProjects → data.page 是数字');
  assertEq(typeof (page && page.pageSize), 'number', 'listProjects → data.pageSize 是数字');
  assert(typeof (page && page.total) === 'number' && page.total >= 1, 'listProjects → data.total ≥ 1');
  const mine = (page.items || []).filter(function (r) { return r.id === projectId; })[0];
  assert(!!mine, 'listProjects → 能查到刚建的项目');
  if (mine) {
    assert(typeof mine.pmName === 'string' && mine.pmName.length > 0, 'listItem → 派生 pmName 非空');
    assert(typeof mine.milestoneTotal === 'number' && mine.milestoneTotal > 0, 'listItem → milestoneTotal > 0');
    assert(typeof mine.gateTotal === 'number', 'listItem → gateTotal 存在');
    assert(typeof mine.nextMilestoneCode === 'string', 'listItem → nextMilestoneCode 存在');
  }
  const filtered = okData(await call('GET', '/api/projects?type=A&page=1&pageSize=5'), 'listProjects filter');
  assert((filtered.items || []).every(function (r) { return r.type === 'A'; }), 'listProjects → type 过滤生效');

  /* ⑨ 项目详情 / 成员 / 里程碑 */
  console.log('\n⑨ GET /api/projects/:id 及子资源');
  const detail = okData(await call('GET', '/api/projects/' + projectId), 'getProject');
  assertEq(detail && detail.id, projectId, 'getProject → id 一致');

  const members = okData(await call('GET', '/api/projects/' + projectId + '/members'), 'listMembers');
  assert(Array.isArray(members), 'listMembers → data 直接是数组');
  assertEq(members.length, 2, 'listMembers → 落库 2 名成员');
  assert(members.every(function (m) { return typeof m.userName === 'string' && m.userName; }), 'listMembers → 派生 userName 非空');
  assert(members.some(function (m) { return m.projectRole === 'pm'; }), 'listMembers → 含 pm');

  const milestones = okData(await call('GET', '/api/projects/' + projectId + '/milestones'), 'listMilestones');
  assert(Array.isArray(milestones) && milestones.length > 0, 'listMilestones → 按模板生成里程碑', { count: milestones.length });
  if (milestones.length) {
    assert(milestones.every(function (m) { return Object.prototype.hasOwnProperty.call(m, 'gate'); }), 'milestone → 每项含 gate 字段（可为 null）');
    assert(milestones.every(function (m) { return Array.isArray(m.gateItems); }), 'milestone → 每项含 gateItems 数组');
    assert(milestones.every(function (m) { return m.taskStats && typeof m.taskStats.progress === 'number'; }), 'milestone → 每项含 taskStats');
    assert(milestones.every(function (m) { return typeof m.currentDate === 'string' && m.currentDate; }), 'milestone → planned_date 映射为 currentDate');
    assert(milestones.every(function (m) { return typeof m.status === 'string'; }), 'milestone → status 为派生字符串');
    assert(milestones.every(function (m) { return typeof m.done === 'boolean'; }), 'milestone → done 为布尔');
    const codes = milestones.map(function (m) { return m.code; });
    const expectCodes = milestones.map(function (_, i) { return 'M' + (i + 1); });
    assertEq(codes.join(','), expectCodes.join(','), 'milestone → code 已重排为 M1..Mn');
    const sorted = milestones.every(function (m, i) { return i === 0 || milestones[i - 1].currentDate <= m.currentDate; });
    assert(sorted, 'milestone → 按 currentDate 升序');
  }

  const notFound = await call('GET', '/api/projects/P-not-exist');
  expectError(notFound, 'E_NOT_FOUND', 404, '不存在的项目');

  /* ⑩ 工作台 */
  console.log('\n⑩ GET /api/workbench');
  const wb = okData(await call('GET', '/api/workbench'), 'workbench');
  assert(!!(wb && wb.stats), 'workbench → stats 存在');
  assertEq(typeof (wb && wb.stats && wb.stats.pendingApprovals), 'number', 'workbench → stats.pendingApprovals 是数字');
  assertEq(typeof (wb && wb.stats && wb.stats.overdueTasks), 'number', 'workbench → stats.overdueTasks 是数字');
  assertEq(typeof (wb && wb.stats && wb.stats.missingReports), 'number', 'workbench → stats.missingReports 是数字');
  assert(Array.isArray(wb && wb.myProjects), 'workbench → myProjects 是数组');
  assert((wb.myProjects || []).some(function (r) { return r.id === projectId; }), 'workbench → myProjects 含我参与的项目');
  assert(Array.isArray(wb && wb.myTasks), 'workbench → myTasks 是数组（降级 []）');
  assert(Array.isArray(wb && wb.myApprovals), 'workbench → myApprovals 是数组（降级 []）');
  assert(Array.isArray(wb && wb.reportReminders), 'workbench → reportReminders 是数组（降级 []）');

  /* ⑪ 降级桩 */
  console.log('\n⑪ 降级桩（切真后端首屏不炸）');
  const listStubs = [
    ['/api/projects/' + projectId + '/wbs', 'wbs'],
    ['/api/projects/' + projectId + '/reports', 'reports'],
    ['/api/projects/' + projectId + '/changes', 'changes'],
    ['/api/projects/' + projectId + '/risks', 'risks'],
    ['/api/projects/' + projectId + '/documents', 'documents'],
    ['/api/projects/' + projectId + '/close-check', 'close-check'],
    ['/api/reviews', 'reviews'],
    ['/api/reviews/my-approvals', 'my-approvals'],
  ];
  for (const entry of listStubs) {
    const data = okData(await call('GET', entry[0]), 'stub ' + entry[1]);
    assert(Array.isArray(data), 'stub ' + entry[1] + ' → data 是数组');
  }

  const board = okData(await call('GET', '/api/projects/' + projectId + '/board'), 'stub board');
  assert(Array.isArray(board && board.columns) && board.columns.length === 4, 'stub board → 四列');
  assert(!!(board && board.config && board.config.wipLimits), 'stub board → config.wipLimits 存在');

  const audit = okData(await call('GET', '/api/audit?page=1&pageSize=20'), 'stub audit');
  assert(Array.isArray(audit && audit.items) && audit.total === 0, 'stub audit → 空 Paged');

  const notImpl = await call('POST', '/api/projects/' + projectId + '/wbs', { name: 'x' });
  expectError(notImpl, 'E_NOT_IMPLEMENTED', 501, '未实现写操作');

  const resetDemo = await call('POST', '/api/admin/reset-demo', {});
  expectError(resetDemo, 'E_FORBIDDEN', 403, 'reset-demo 明确拒绝');

  const api404 = await call('GET', '/api/definitely-not-a-route');
  expectError(api404, 'E_NOT_FOUND', 404, '/api 未命中路径返回信封 404');

  /* ⑫ 模板列表 */
  console.log('\n⑫ GET /api/admin/templates');
  const templates = okData(await call('GET', '/api/admin/templates'), 'admin/templates');
  assert(Array.isArray(templates) && templates.length >= 3, 'admin/templates → data 直接是数组且 ≥ 3');
  assert(templates.every(function (t) { return typeof t.projectType === 'string' && t.definition; }), 'admin/templates → 字段完整');

  /* ── 汇总 ── */
  console.log('\n' + '─'.repeat(52));
  console.log('[smoke] 通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed) {
    console.log('[smoke] 失败明细：');
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  }
  console.log('[smoke] 批次 1 冒烟全绿 ✅');
  process.exit(0);
}

main().catch(function (e) {
  console.error('\n[smoke] 脚本异常终止：', e && e.stack ? e.stack : e);
  console.error('[smoke] 请确认服务已启动：node server.js');
  process.exit(1);
});
