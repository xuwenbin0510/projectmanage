#!/usr/bin/env node
/**
 * QA 独立验证 · B13 逾期/临期任务下探抽屉（下探到任务明细）
 *
 * 验证目标（严格按主理人验收 SOP）：
 *   1. 纯函数口径（splitOverdueByStatus）逻辑正确性 —— 用真实 date.ts 的 today/diffDays
 *      独立复刻同一算法（与 web/src/utils/dashboardAgg.ts L39-50 / L228-246 逐字一致），
 *      喂入覆盖边界的样本，断言 overdue/dueSoon 分区数量正确。
 *   2. 数据通路 E2E —— 启动后端后，对已知项目 P-1003（id=Pmslkpu9a00dx）、
 *      P-2001（id=Pdemo2001）调用抽屉依赖的同一接口（listWbs / listMilestones），
 *      用同一口径独立算出 overdue/dueSoon，断言 > 0（抽屉会渲染出内容）。
 *   3. 回归无破坏 —— 仅做静态/类型层面的结论汇总，tsc 是否 0 错误由单独的 tsc 调用核验。
 *
 * 运行方式（脚本位于 scripts/，需从 pm-app 根目录运行以便解析 web/ 相对路径）：
 *   node --experimental-strip-types --loader ./scripts/qa_b13_loader.mjs scripts/qa_b13_verify.mjs [BASE_URL]
 *   （BASE_URL 默认 http://127.0.0.1:3000）
 *
 * 退出码：0 = 全绿；1 = 有断言失败。
 */

import { today, diffDays, addDays } from '../web/src/utils/date.ts';

/* ════════════════════════════════════════════════════════════════
 * 1) 复刻 splitOverdueByStatus（与 dashboardAgg.ts 逐字一致）
 *    - 逾期 = diffDays(today, dueDate) < 0
 *    - 临期 = 0 <= diffDays(today, dueDate) <= DUE_SOON_DAYS(3)
 *    - 排除 status === '完成'；缺 dueDate 不计
 * ════════════════════════════════════════════════════════════════ */

const DUE_SOON_DAYS = 3;

function overdueOf(dueDate) {
  if (!dueDate) return false;
  return diffDays(today(), dueDate) < 0;
}
function dueSoonOf(dueDate) {
  if (!dueDate) return false;
  const d = diffDays(today(), dueDate);
  return d >= 0 && d <= DUE_SOON_DAYS;
}
function splitOverdueByStatus(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const overdue = [];
  const dueSoon = [];
  list.forEach((t) => {
    if (t.status === '完成') return;
    const isOver = overdueOf(t.dueDate);
    const isSoon = !isOver && dueSoonOf(t.dueDate);
    if (isOver) overdue.push(t);
    else if (isSoon) dueSoon.push(t);
  });
  return { overdue, dueSoon };
}

/* ════════════════════════════════════════════════════════════════
 * 断言工具
 * ════════════════════════════════════════════════════════════════ */

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
  assert(actual === expected, label + '（期望 ' + expected + '，实际 ' + actual + '）', { expected, actual });
}

/* ════════════════════════════════════════════════════════════════
 * Part A · 纯函数口径（边界覆盖样本）
 * ════════════════════════════════════════════════════════════════ */

function buildSample(t) {
  // 全部字段齐备，仅 dueDate / status / milestoneId 随用例变化
  const base = (id, dueDate, status, milestoneId) => ({
    id,
    projectId: 'P-X',
    parentId: null,
    wbsCode: id,
    level: 2,
    nodeType: 'task',
    name: 'task-' + id,
    description: '',
    owner: 'ou_x',
    ownerName: '某同学',
    estimateDays: 3,
    actualDays: 1,
    effortHours: 0,
    effortChildCount: 0,
    startDate: addDays(t, -10),
    dueDate,
    status,
    progress: 50,
    boardOrder: 0,
    isCritical: 0,
    milestoneId: milestoneId ?? null,
    createdBy: 'ou_x',
    createdAt: addDays(t, -10),
    updatedAt: addDays(t, -1),
  });
  return [
    base('n1', addDays(t, 0), '进行中'), // 今天 → 临期
    base('n2', addDays(t, -1), '进行中'), // 昨天 → 逾期
    base('n3', addDays(t, 3), '进行中'), // +3天（边界）→ 临期
    base('n4', addDays(t, 4), '进行中'), // +4天 → 都不算
    base('n5', addDays(t, -5), '完成'), // 逾期日期但已完成 → 排除
    base('n6', null, '进行中'), // 缺 dueDate → 排除
    base('n7', addDays(t, -10), '阻塞', 'M1'), // 逾期 + 有里程碑
    base('n8', addDays(t, 3), '待办', null), // 临期 + 无里程碑
    base('n9', addDays(t, -2), '进行中', 'M2'), // 逾期 + 有里程碑
    base('n10', addDays(t, 1), '待评审'), // +1天 → 临期
  ];
}

function runPartA() {
  console.log('\n═══ Part A · 纯函数 splitOverdueByStatus 口径（真实 date.ts 驱动）═══');
  const t = today();
  console.log('  [基准日 today() = ' + t + ']');

  const sample = buildSample(t);
  const { overdue, dueSoon } = splitOverdueByStatus(sample);

  console.log('\n── A1 分区数量 ──');
  assertEq(overdue.length, 3, '逾期分区数量 = 3（n2 昨天 / n7 -10天 / n9 -2天）');
  assertEq(dueSoon.length, 4, '临期分区数量 = 4（n1 今天 / n3 +3天 / n8 +3天无碑 / n10 +1天）');

  const ovIds = overdue.map((n) => n.id);
  const dsIds = dueSoon.map((n) => n.id);

  console.log('\n── A2 边界与排除规则 ──');
  // 今天（n1）应归入临期、不归入逾期
  assert(dsIds.includes('n1') && !ovIds.includes('n1'), '边界：dueDate=今天 → 临期（非逾期）');
  // +3天（n3）临期边界
  assert(dsIds.includes('n3') && !ovIds.includes('n3'), '边界：dueDate=今天+3 → 临期（DUE_SOON_DAYS 含 3）');
  // +4天（n4）都不算
  assert(!ovIds.includes('n4') && !dsIds.includes('n4'), '边界：dueDate=今天+4 → 逾期/临期均不计');
  // 昨天（n2）逾期
  assert(ovIds.includes('n2'), '边界：dueDate=昨天 → 逾期');
  // 完成态（n5）即便逾期日期也排除
  assert(!ovIds.includes('n5') && !dsIds.includes('n5'), '排除：status=完成 即便逾期日期也不计入');
  // 缺 dueDate（n6）排除
  assert(!ovIds.includes('n6') && !dsIds.includes('n6'), '排除：缺 dueDate 不计入');
  // 有里程碑 / 无里程碑均不影响日期口径（n7 有碑逾期、n8 无碑临期）
  assert(ovIds.includes('n7'), '有 milestoneId 的逾期任务正常计入');
  assert(dsIds.includes('n8'), '无 milestoneId 的临期任务正常计入（抽屉兜底「未关联」）');

  console.log('\n── A3 全部样本归属确定性（无残留/无重复）──');
  const total = ovIds.length + dsIds.length;
  assertEq(total, 7, '10 条样本中有 7 条命中（3 逾期 + 4 临期），另 3 条被排除');
  const allIds = [...ovIds, ...dsIds];
  assertEq(new Set(allIds).size, allIds.length, '分区结果无重复节点');
}

/* ════════════════════════════════════════════════════════════════
 * Part B · 数据通路 E2E（需后端已启动）
 * ════════════════════════════════════════════════════════════════ */

const BASE = (process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const ADMIN = 'ou_xuwenbin01';

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
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = { __parseError: true, raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}
async function loginAs(openId) {
  const r = await call('POST', '/api/auth/devlogin', { openId });
  token = (r.json && r.json.data && r.json.data.token) || '';
  return r;
}
function okData(r, label) {
  if (!r || !r.json || r.json.code !== 0) {
    assert(false, label + '（信封失败 code≠0）', r && r.json);
    return null;
  }
  return r.json.data;
}

const TARGETS = [
  { code: 'P-1003', id: 'Pmslkpu9a00dx', note: '测试项目1' },
  { code: 'P-2001', id: 'Pdemo2001', note: 'demo 项目' },
];

async function runPartB() {
  console.log('\n═══ Part B · 数据通路 E2E（' + BASE + '）═══');

  console.log('\n── B1 管理员登录（devlogin）──');
  await loginAs(ADMIN);
  assert(!!token, 'devlogin 签发 token（admin ' + ADMIN + '）');

  if (!token) {
    console.log('  \u26A0 无 token，跳过后续 E2E（请确认后端已启动且 ALLOW_DEV_LOGIN=true）');
    return;
  }

  // 取得全量总览里的逾期报表，用于交叉比对 report 口径
  const overview = okData(await call('GET', '/api/dashboard/overview'), 'GET /api/dashboard/overview');
  const reportById = {};
  if (overview && Array.isArray(overview.overdue)) {
    overview.overdue.forEach((o) => {
      reportById[o.projectId] = o;
    });
  }

  for (const proj of TARGETS) {
    console.log('\n── B2~B5 ' + proj.note + ' ' + proj.code + '（id=' + proj.id + '）──');

    // B2 listWbs 字段完整性
    const wbs = okData(await call('GET', '/api/projects/' + proj.id + '/wbs'), 'GET /api/projects/' + proj.id + '/wbs');
    assert(Array.isArray(wbs) && wbs.length > 0, 'listWbs 返回数组且非空（' + (wbs ? wbs.length : 0) + ' 条）', wbs && wbs.length);
    if (!Array.isArray(wbs) || wbs.length === 0) continue;

    const first = wbs[0];
    const hasDueDate = 'dueDate' in first;
    const hasStatus = 'status' in first;
    const hasProgress = 'progress' in first;
    const hasMsId = 'milestoneId' in first;
    const hasOwner = 'owner' in first;
    const hasWbsCode = 'wbsCode' in first;
    assert(hasDueDate && hasStatus && hasProgress && hasMsId && hasOwner && hasWbsCode,
      'WBS 节点含抽屉所需字段（dueDate/status/progress/milestoneId/owner/wbsCode，camelCase）',
      { hasDueDate, hasStatus, hasProgress, hasMsId, hasOwner, hasWbsCode });
    // 顺带确认没有 snake_case 字段（接口契约稳定）
    const snake = [];
    const walk = (v, p) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, p + '[' + i + ']'));
      else if (v && typeof v === 'object') Object.keys(v).forEach((k) => { if (k.indexOf('_') >= 0) snake.push(p + '.' + k); walk(v[k], p + '.' + k); });
    };
    walk(wbs, '$');
    assert(snake.length === 0, 'listWbs 响应无 snake_case 字段', snake.slice(0, 5));

    // B3 用抽屉同一口径独立重算
    const { overdue, dueSoon } = splitOverdueByStatus(wbs);
    console.log('    独立重算：overdue=' + overdue.length + ' · dueSoon=' + dueSoon.length);
    assert(overdue.length > 0, '[' + proj.code + '] 抽屉口径 overdue > 0（抽屉会渲染出逾期内容）', overdue.length);
    // dueSoon 可能部分项目为 0，仅记录不硬性断言（PRD 仅要求 overdue>0）
    console.log('    （dueSoon=' + dueSoon.length + '，按 PRD 仅要求 overdue>0）');

    // B4 与总览报表口径交叉比对（report 仅统计叶子，抽屉统计全量；此处仅要求方向一致）
    const rep = reportById[proj.id];
    if (rep) {
      console.log('    总览报表口径：overdue=' + rep.overdue + ' · dueSoon=' + rep.dueSoon);
      assert(rep.overdue > 0, '[' + proj.code + '] 总览报表 overdue > 0（与抽屉口径方向一致）', rep.overdue);
      // 抽屉统计全量节点，报表仅叶子，故抽屉 overdue >= 报表 overdue（phase 父节点一般不在窗口内）
      assert(overdue.length >= rep.overdue,
        '[' + proj.code + '] 抽屉 overdue >= 报表 overdue（抽屉为全量超集）',
        { drawer: overdue.length, report: rep.overdue });
    } else {
      console.log('    \u26A0 总览报表未含该项目（可能不在 admin 全量范围内），跳过交叉比对');
    }

    // B5 milestones 映射通路
    const ms = okData(await call('GET', '/api/projects/' + proj.id + '/milestones'), 'GET /api/projects/' + proj.id + '/milestones');
    assert(Array.isArray(ms) && ms.length > 0, 'listMilestones 返回数组且非空（' + (ms ? ms.length : 0) + ' 条）', ms && ms.length);
    if (Array.isArray(ms) && ms.length > 0) {
      const mapOk = ms.every((m) => 'id' in m && 'name' in m);
      assert(mapOk, 'milestones 含 id/name（可建 milestoneId→name 映射）', { sample: ms[0] });
      // 抽样：WBS 中引用的 milestoneId 能否在映射里解析
      const msMap = new Map(ms.map((m) => [m.id, m.name]));
      const referenced = wbs.filter((n) => n.milestoneId).map((n) => n.milestoneId);
      const unresolved = referenced.filter((mid) => !msMap.has(mid));
      assert(unresolved.length === 0, '[' + proj.code + '] WBS 引用的 milestoneId 均能映射到名称', { unresolved: unresolved.slice(0, 5), total: referenced.length });
    }
  }
}

/* ════════════════════════════════════════════════════════════════ */

async function main() {
  console.log('═══ B13 逾期/临期任务下探抽屉 · QA 独立验证 ═══');
  runPartA();
  await runPartB();

  console.log('\n════════════════════════════════════════════');
  console.log('  通过 ' + passed + ' / 失败 ' + failed);
  if (failed > 0) {
    console.log('  失败项：');
    failures.forEach((f) => console.log('   - ' + f));
  }
  console.log('════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[qa_b13] 运行异常：', err);
  process.exit(1);
});
