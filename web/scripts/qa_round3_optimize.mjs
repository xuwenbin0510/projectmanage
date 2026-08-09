/**
 * QA · 第三轮优化专项验证（R3-1 ~ R3-11）· 严过关独立回归
 *
 * 通过 Vite SSR 加载器运行真实源码（自动解析 `@/` 别名），验证：
 *   R3-1 / R3-9  「必备」UI 下线（引擎 required 字段保留）+ 页面可见文案为 0
 *   R3-2 / R3-10 列表仅一列「计划日期（到期）」+ currentDate/baselineDate 已变更条件 + 逾期
 *   R3-3         节点截止日期（dueDate 数据 + WbsPage 渲染源）
 *   R3-4         ★ 排序 bug：插入里程碑后 listMilestones 立即出现/升序/连续/幂等；
 *                refreshMilestones 同步 store；WbsPage 挂载 effect 含刷新调用
 *   R3-5         reportCountByNode / nodeReportsOf 口径与「关联任务数」一致；写日志跳转约定
 *   R3-6 / R3-7 ★ 编辑回传 tasks 原样（selected/progressAfter 不丢、week 不变、同周互不影响）
 *   R3-8         memberNameOf 姓名解析 / openId 回退
 *   R3-11        引擎不再抛 E_MS_REQUIRED_LOCKED / E_GATE_NOT_PASSED（页面死分支清理后的行为）
 *
 * ── R5 断言维护记录（严过关 · 只改测试脚本，未动产品源码）──
 * R5 落地后本脚本 1 条源码核验断言过期（源于 R5 有意变更，非源码 bug），已就地更新，其余保持原样：
 *   · R3-7② 编辑态勾选/进度 disabled → 旧断言 grep 裸 `disabled={readOnly}`；R5-P0-3 令父节点行
 *     checkbox 与「完%」一并禁用，两处表达式分别变为 `readOnly || locked || hasChildren`
 *     与 `readOnly || hasChildren`。新断言逐字核验这两处真实表达式 + `const readOnly = Boolean(editingReport)`，
 *     守住 R3-7② 原不变量：两处均以 `readOnly ||` 打头 → 编辑态无条件双双禁用。
 * 同类过期在 R4 脚本共 5 条，已另行修复（见 qa_round4_optimize.mjs 头部同名记录）。
 *
 * 用法：node scripts/qa_round3_optimize.mjs
 */
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

function eq(actual, expected, label) {
  ok(
    actual === expected,
    label,
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  );
}

function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, label, `期望 ${b}，实际 ${a}`);
}

function section(title) {
  console.log(`\n════ ${title} ════`);
}

function briefMs(list) {
  return list.map((m) => `${m.code}@${m.currentDate}`);
}

function briefTasks(report) {
  return report.tasks
    .filter((t) => t.selected)
    .map((t) => `${t.nodeCode}:${t.progressAfter}`)
    .sort();
}

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

try {
  const { MockApiClient } = await server.ssrLoadModule('/src/api/mock/index.ts');
  const { getDb, resetDb } = await server.ssrLoadModule('/src/api/mock/db.ts');
  const { OPEN_IDS } = await server.ssrLoadModule('/src/api/mock/fixtures/users.ts');
  const { reportCountByNode, nodeReportsOf } = await server.ssrLoadModule('/src/utils/reportAgg.ts');
  const { memberNameOf } = await server.ssrLoadModule('/src/utils/member.ts');
  const { useProjectStore } = await server.ssrLoadModule('/src/stores/projectStore.ts');

  const api = new MockApiClient();
  resetDb();
  await api.devLogin(OPEN_IDS.xuwenbin);

  const mkPayload = (name, planStart, planEnd) => ({
    name,
    type: 'A',
    customer: 'QA 客户',
    contractAmount: 3_000_000,
    background: 'QA 回归 R3',
    goal: ['验证第三轮优化'],
    planStart,
    planEnd,
    pm: OPEN_IDS.xuwenbin,
    classifyInput: {
      contractAmount: 3_000_000,
      hasHardware: true,
      hasAcceptance: true,
      isSelfIteration: false,
      isInfrastructure: false,
    },
    classifySuggested: 'A',
    classifyOverrideReason: '',
    members: [
      { userOpenId: OPEN_IDS.xuwenbin, role: 'pm' },
      { userOpenId: OPEN_IDS.zhaogongcheng ?? Object.values(OPEN_IDS)[1], role: 'tl' },
    ],
  });

  /* ═══════════════════════════════════════════════════
   * R3-1 / R3-9 / R3-11 · 「必备」UI 下线 + 引擎字段保留
   * ═══════════════════════════════════════════════════ */
  section('R3-1/R3-9 · 必备 UI 下线（引擎字段保留）');
  const proj = await api.createProject(mkPayload('QA-R3', '2026-03-01', '2026-03-31'));
  const list0 = await api.listMilestones(proj.id);
  ok(list0.length === 7, 'R3-1⑥ A 类模板生成 7 个里程碑');
  ok(
    list0.every((m) => m.required === true),
    'R3-1⑥ 模板碑 required=true 仍随创建写入（血缘语义保留）',
  );
  ok(
    list0.every((m) => m.currentDate === m.baselineDate),
    'R3-2/R3-10 创建即基线：currentDate === baselineDate（无「已变更」）',
  );
  /* R3-11：删除 required 碑不再抛 E_MS_REQUIRED_LOCKED */
  let deleteErr = null;
  try {
    await api.deleteMilestone(list0[0].id); // 删除 M1（required 碑）
  } catch (e) {
    deleteErr = e;
  }
  ok(deleteErr === null, 'R3-11 删除 required 碑不再抛 E_MS_REQUIRED_LOCKED', deleteErr?.message ?? '');
  const listAfterDelete = await api.listMilestones(proj.id);
  eq(listAfterDelete.length, 6, 'R3-11 删除后剩余 6 个');
  ok(
    listAfterDelete.every((m, i) => m.code === `M${i + 1}`),
    'R3-11/R3-4 删除后编号仍连续 M1..Mn',
  );
  /* R3-11：标记达成不再抛 E_GATE_NOT_PASSED */
  let achieveErr = null;
  try {
    await api.updateMilestone(listAfterDelete[0].id, { achieved: true });
  } catch (e) {
    achieveErr = e;
  }
  ok(achieveErr === null, 'R3-11 标记达成不再抛 E_GATE_NOT_PASSED', achieveErr?.message ?? '');
  /* 页面可见文案 grep（真实源码） */
  const pages = [
    'src/pages/projects/MilestonesPage.tsx',
    'src/pages/projects/ProjectCreatePage.tsx',
    'src/pages/projects/ProjectOverviewPage.tsx',
    'src/pages/projects/WbsPage.tsx',
    'src/pages/projects/ReportsPage.tsx',
  ];
  let visibleBiBei = 0;
  for (const p of pages) {
    const src = readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    // 仅统计 JSX 可见文本中的「必备」；注释/字符串类型注释不算
    const jsxLines = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'));
    const hits = jsxLines.filter((l) => l.includes('必备') && !l.includes('不再按「必备」') && !l.includes('不再展示「必备」'));
    visibleBiBei += hits.length;
    if (hits.length) console.log(`    [info] ${p}: ${hits.join(' | ')}`);
  }
  eq(visibleBiBei, 0, 'R3-9③ 五个页面无「必备」可见文案（仅注释例外）');

  /* ═══════════════════════════════════════════════════
   * R3-4 ★ 排序 bug 回归：插入里程碑 → 立即出现/升序/连续/幂等
   * ═══════════════════════════════════════════════════ */
  section('R3-4 · 插入里程碑排序（真 bug 回归）');
  const proj2 = await api.createProject(mkPayload('QA-R3-排序', '2026-03-01', '2026-03-31'));
  const base = await api.listMilestones(proj2.id);
  eq(base.length, 7, 'R3-4 基线 7 个里程碑');
  deepEq(
    briefMs(base),
    ['M1@2026-03-01', 'M2@2026-03-05', 'M3@2026-03-10', 'M4@2026-03-17', 'M5@2026-03-23', 'M6@2026-03-28', 'M7@2026-03-31'],
    'R3-4 基线按 currentDate 升序（M1..M7）',
  );
  /* 在 M1(03-01) 与 M3(03-10) 之间插入 03-03 的新碑 */
  const created = await api.createMilestone(proj2.id, { name: '插入里程碑', date: '2026-03-03', target: '' });
  const afterInsert = await api.listMilestones(proj2.id);
  eq(afterInsert.length, 8, 'R3-4① 插入后共 8 个');
  deepEq(
    briefMs(afterInsert),
    ['M1@2026-03-01', 'M2@2026-03-03', 'M3@2026-03-05', 'M4@2026-03-10', 'M5@2026-03-17', 'M6@2026-03-23', 'M7@2026-03-28', 'M8@2026-03-31'],
    'R3-4①② 新碑立即出现且按 currentDate 升序、编号连续 M1..Mn（不再排到 M5 后）',
  );
  ok(afterInsert.some((m) => m.id === created.id), 'R3-4④ 新插入的里程碑立即出现在列表（缺行被修复）');
  /* 幂等：再拉一次顺序不变 */
  const afterInsert2 = await api.listMilestones(proj2.id);
  deepEq(briefMs(afterInsert2), briefMs(afterInsert), 'R3-4③ 重复读取顺序与编号不变（幂等）');
  /* store.refreshMilestones 同步：模拟 WbsPage 挂载刷新（R3-4 根因修复路径） */
  useProjectStore.setState({ milestones: base }); // 模拟陈旧快照（只 fetchWbs、未刷新）
  ok(
    !useProjectStore.getState().milestones.some((m) => m.id === created.id),
    'R3-4 前置：陈旧快照中无新碑（复现 bug 场景）',
  );
  await useProjectStore.getState().refreshMilestones(proj2.id);
  const storeMs = useProjectStore.getState().milestones;
  ok(storeMs.some((m) => m.id === created.id), 'R3-4④ refreshMilestones 后新碑进入 store（立即出现）');
  deepEq(
    briefMs(storeMs),
    briefMs(afterInsert),
    'R3-4① 刷新后 store 顺序 = 引擎 listMilestones 顺序（与里程碑页一致）',
  );
  /* WbsPage 挂载 effect 源码检查：确实调用 refreshMilestones + fetchReports */
  const wbsSrc = readFileSync(new URL('../src/pages/projects/WbsPage.tsx', import.meta.url), 'utf8');
  ok(
    wbsSrc.includes('refreshMilestones(id)') && /useEffect\(/.test(wbsSrc),
    'R3-4 源码核验：WbsPage 挂载 effect 含 refreshMilestones(id)（根因修复）',
  );
  ok(
    wbsSrc.includes('fetchReports(id)'),
    'R3-5 源码核验：WbsPage 挂载 effect 含 fetchReports(id)（徽标数据源）',
  );
  ok(
    !/milestones\.slice\(\)\.sort|\.sort\(.*code/.test(wbsSrc.replace(/\s+/g, ' ')),
    'R3-4 无按 code 排序里程碑的调用点',
  );

  /* ═══════════════════════════════════════════════════
   * R3-2 / R3-10 · 已变更弱标记条件 + 逾期
   * ═══════════════════════════════════════════════════ */
  section('R3-2/R3-10 · currentDate 展示口径 / 已变更 / 逾期');
  const ms3 = afterInsert[1]; // M2@03-03（刚插入的）
  const upd = await api.updateMilestone(ms3.id, { currentDate: '2026-03-02' }); // 提前：直接生效
  eq(upd.currentDate, '2026-03-02', 'R3-2 提前改期直接生效（currentDate 更新）');
  eq(upd.baselineDate, '2026-03-03', 'R3-2 基线日期保持不变（内部审计字段）');
  ok(
    upd.currentDate !== upd.baselineDate,
    'R3-10 已变更条件成立：currentDate !== baselineDate（UI 据此显示弱标记+tooltip）',
  );
  const lastMs = afterInsert[7]; // M8@2026-03-31
  ok(
    lastMs.currentDate === '2026-03-31' && lastMs.delayDays >= 0,
    'R3-10 逾期标红数据源保留（delayDays 派生存在）',
  );

  /* ═══════════════════════════════════════════════════
   * R3-3 · 节点截止日期
   * ═══════════════════════════════════════════════════ */
  section('R3-3 · WBS 节点截止日期');
  const wbs = await api.listWbs(proj2.id);
  ok(wbs.length > 0, 'R3-3 WBS 节点存在');
  ok(
    wbs.every((n) => 'dueDate' in n),
    'R3-3 节点均携带 dueDate 字段（页面据此渲染「截止 YYYY-MM-DD」或「截止 —」）',
  );
  ok(
    wbsSrc.includes('截止 {fmtDate(node.dueDate)}'),
    'R3-3 源码核验：节点行渲染「截止 {fmtDate(...)}」（fmtDate 空值回退 —）',
  );

  /* ═══════════════════════════════════════════════════
   * R3-5 · 日志聚合（计数口径 / 详情排序 / 写日志跳转约定）
   * ═══════════════════════════════════════════════════ */
  section('R3-5 · 节点日志聚合');
  const nodeA = wbs[0];
  const nodeB = wbs[1];
  const weekNow = '2026-W11';
  const mkReportPayload = (node, progressAfter, withRisk = false) => ({
    projectId: proj2.id,
    week: weekNow,
    doneNote: `完成 ${node.wbsCode}`,
    planItems: ['计划项'],
    resourceNote: '',
    tasks: [
      { nodeId: node.id, progressAfter, selected: true },
      { nodeId: wbs[2].id, progressAfter: 10, selected: false }, // 未勾选行不计数
    ],
    risks: withRisk
      ? [{ description: '原始风险描述', owner: OPEN_IDS.zhaogongcheng ?? Object.values(OPEN_IDS)[1], dueDate: '2026-03-15' }]
      : [],
  });
  const r1 = await api.submitReport(mkReportPayload(nodeA, 40, true)); // r1 带风险（供 R3-7 编辑验证）
  const r2 = await api.submitReport(mkReportPayload(nodeA, 60));
  const r3 = await api.submitReport(mkReportPayload(nodeB, 20));
  const reports = await api.listReports(proj2.id);
  eq(reports.length, 3, 'R3-5 提交 3 条日志');
  const counts = reportCountByNode(reports);
  eq(counts.get(nodeA.id) ?? 0, 2, 'R3-5④ 徽标计数：nodeA 关联 2 条（selected=true 口径）');
  eq(counts.get(nodeB.id) ?? 0, 1, 'R3-5④ 徽标计数：nodeB 关联 1 条');
  eq(counts.get(wbs[2].id) ?? 0, 0, 'R3-5④ 未勾选行不计数（n=0）');
  /* 与 ReportsPage「关联任务数」同源：sum over reports of tasks.filter(t=>t.selected&&t.nodeId===X) */
  const manualA = reports.filter((r) => r.tasks.some((t) => t.nodeId === nodeA.id && t.selected)).length;
  eq(counts.get(nodeA.id), manualA, 'R3-5④ reportCountByNode === 按 selected 手算（口径一致）');
  /* nodeReportsOf：createdAt 升序 + 只含选中行 */
  const nodeAReps = nodeReportsOf(reports, nodeA.id);
  eq(nodeAReps.length, 2, 'R3-5② 详情弹窗列出 nodeA 全部 2 条');
  ok(
    nodeAReps[0].createdAt <= nodeAReps[1].createdAt,
    'R3-5② 按 createdAt 升序',
  );
  ok(
    nodeAReps.every((r) => r.tasks.some((t) => t.nodeId === nodeA.id && t.selected)),
    'R3-5② 每条均含该节点 selected 行（进度 before→after 有源）',
  );
  /* 写日志约定：源码核验（R4-P0-4 后 WBS 页内开 ReportFormModal 锁定节点，不再 navigate；
   * ReportsPage 保留 prefillNodeId 兼容旧链接） */
  ok(
    wbsSrc.includes('setReportLockNodeId(node.id)') &&
      wbsSrc.includes('setReportModalOpen(true)') &&
      wbsSrc.includes('<ReportFormModal') &&
      wbsSrc.includes('keepOpenOnSubmit'),
    'R3-5③/R4-P0-4 源码核验：WbsPage「写日志」页内开 ReportFormModal（lockNodeId + keepOpenOnSubmit，不再 navigate）',
  );
  ok(
    !wbsSrc.includes("navigate(ROUTES.projectReports(id)"),
    'R3-5③/R4-P0-4 源码核验：WbsPage 不再 navigate 跳转工作日志页',
  );
  const reportsSrc = readFileSync(new URL('../src/pages/projects/ReportsPage.tsx', import.meta.url), 'utf8');
  const modalSrc = readFileSync(new URL('../src/components/report/ReportFormModal.tsx', import.meta.url), 'utf8');
  ok(
    reportsSrc.includes('prefillNodeId') && reportsSrc.includes('openCreateWithPrefill') && reportsSrc.includes('prefilledRef'),
    'R3-5③ 源码核验：ReportsPage 接收 prefillNodeId + ref 防重复触发 + 预勾选（旧链接兼容）',
  );

  /* ═══════════════════════════════════════════════════
   * R3-6 / R3-7 ★ 编辑日志：tasks 原样回传 / 只读边界 / 同周互不影响
   * ═══════════════════════════════════════════════════ */
  section('R3-6/R3-7 · 编辑仅文本可改 / 关联不丢');
  const findReport = async (rid) => {
    const all = await api.listReports(proj2.id);
    return all.find((r) => r.id === rid) ?? null;
  };
  /* 编辑前快照 */
  const before = await findReport(r1.id);
  ok(before !== null, 'R3-7 前置：能取到 r1');
  const beforeTasks = before.tasks
    .filter((t) => t.selected)
    .map((t) => `${t.nodeId}::${t.progressAfter}::${t.selected}`);
  eq(before.week, weekNow, 'R3-7⑤ 编辑前周次');
  /* 模拟前端 assemble 编辑态：tasks 原样回传原始 report.tasks 的 {nodeId,progressAfter,selected} */
  const editPayload = {
    projectId: proj2.id,
    week: before.week, // 编辑态取 editingReport.week（隐藏 input 保持）
    doneNote: '已修改的补充说明',
    planItems: ['修改后计划A', '修改后计划B'],
    resourceNote: '修改后资源',
    tasks: before.tasks.map((t) => ({ nodeId: t.nodeId, progressAfter: t.progressAfter, selected: t.selected })),
    risks: before.risks.map((rk) => ({ description: '风险描述已改', owner: rk.owner, dueDate: rk.dueDate })),
  };
  const edited = await api.updateReport(r1.id, editPayload);
  eq(edited.doneNote, '已修改的补充说明', 'R3-7① doneNote 可改');
  deepEq(edited.planItems, ['修改后计划A', '修改后计划B'], 'R3-7① planItems 可改');
  eq(edited.resourceNote, '修改后资源', 'R3-7① resourceNote 可改');
  eq(edited.week, weekNow, 'R3-7⑤ 周次不随编辑变更');
  deepEq(
    edited.risks.map((rk) => rk.description),
    ['风险描述已改'],
    'R3-7① 风险 description 可改',
  );
  deepEq(
    edited.risks.map((rk) => rk.owner),
    before.risks.map((rk) => rk.owner),
    'R3-7② 风险责任人 owner 保留（只读）',
  );
  deepEq(
    edited.risks.map((rk) => rk.dueDate),
    before.risks.map((rk) => rk.dueDate),
    'R3-7② 风险截止日保留（只读）',
  );
  const afterTasks = edited.tasks
    .filter((t) => t.selected)
    .map((t) => `${t.nodeId}::${t.progressAfter}::${t.selected}`);
  deepEq(afterTasks, beforeTasks, 'R3-7④★ 编辑提交后关联任务（nodeId/progressAfter/selected）与编辑前完全一致');
  eq(edited.tasks.length, before.tasks.length, 'R3-7④ 任务行数不变（含未勾选行）');
  /* 同周多次提交互不影响 */
  const other = await findReport(r2.id);
  eq(other.doneNote, `完成 ${nodeA.wbsCode}`, 'R3-7 同周另一条日志未受 r1 编辑影响（doneNote 保持）');
  ok(
    other.tasks.some((t) => t.nodeId === nodeA.id && t.selected && t.progressAfter === 60),
    'R3-7 同周另一条日志 tasks 独立（progressAfter=60 保持）',
  );
  /* 反证：若编辑把 tasks 从当前全量节点重建（旧 bug），会引入未勾选新行/丢失 —— 证明原样回传的必要性 */
  const badPayload = {
    projectId: proj2.id,
    week: before.week,
    doneNote: '模拟旧逻辑：从当前 nodes 重建',
    planItems: [],
    resourceNote: '',
    tasks: wbs.map((n) => ({ nodeId: n.id, progressAfter: 0, selected: false })),
    risks: [],
  };
  const badEdit = await api.updateReport(r3.id, badPayload);
  eq(
    badEdit.tasks.filter((t) => t.selected).length,
    0,
    'R3-7 反证：非原样回传会清空关联（旧 bug 语义）—— 原样回传机制确有必要',
  );

  /* ═══════════════════════════════════════════════════
   * R3-8 · 责任人姓名解析
   * ═══════════════════════════════════════════════════ */
  section('R3-8 · memberNameOf 责任人姓名');
  const members = await api.listMembers(proj2.id);
  const known = members[0];
  eq(
    memberNameOf(members, known.userOpenId),
    known.userName,
    'R3-8 已知 openId → 解析成员姓名',
  );
  eq(memberNameOf(members, 'openId_不存在_xyz'), 'openId_不存在_xyz', 'R3-8 解析不到回退 openId 原文');
  eq(memberNameOf([], ''), '', 'R3-8 空成员/空 openId 不抛异常（回退原文）');

  /* ═══════════════════════════════════════════════════
   * R3-6 源码核验：任务关联区标题 + 编辑态只读说明
   * ═══════════════════════════════════════════════════ */
  section('R3-6 · 任务关联区标题 / 编辑态只读（源码核验 · R4 后位于 ReportFormModal）');
  ok(
    modalSrc.includes('REPORT_SECTION_TITLE.taskAssoc'),
    'R3-6 源码核验：任务关联区引用 taskAssoc 标题（ReportFormModal）',
  );
  ok(
    modalSrc.includes('编辑已提交日志时该区域只读'),
    'R3-6 源码核验：编辑态追加只读说明（ReportFormModal）',
  );
  /* R5-P0-3 变更：父节点行 checkbox 与「完%」一并禁用，两处 disabled 表达式均追加 hasChildren
     （checkbox 为 `readOnly || locked || hasChildren`，「完%」为 `readOnly || hasChildren`），
     裸 `disabled={readOnly}` 已不存在 → R3 期旧断言过期。
     R3-7② 的原意是「编辑态勾选与进度双双禁用」，该不变量在 R5 仍成立：两处表达式**均以
     `readOnly ||` 打头**，readOnly 为真即无条件禁用。故逐字核验两处真实表达式 + readOnly 定义。 */
  ok(
    modalSrc.includes('disabled={readOnly || locked || hasChildren}') &&
      modalSrc.includes('disabled={readOnly || hasChildren}') &&
      modalSrc.includes('const readOnly = Boolean(editingReport)'),
    'R3-7②/R5-P0-3 源码核验：编辑态任务勾选（readOnly||locked||hasChildren）与进度（readOnly||hasChildren）均 disabled（ReportFormModal）',
  );
  ok(
    modalSrc.includes('editingReport.tasks.map<ReportTaskRef>') ||
      (modalSrc.includes('editingReport.tasks.map') && modalSrc.includes('ReportTaskRef')),
    'R3-7④ 源码核验：assemble 编辑态原样回传 editingReport.tasks（ReportFormModal）',
  );
  ok(
    modalSrc.includes('memberNameOf(members, ') || reportsSrc.includes('memberNameOf(members, rk.owner)'),
    'R3-8 源码核验：详情/编辑态责任人走 memberNameOf',
  );

  /* ═══════════════════════════════════════════════════
   * 汇总
   * ═══════════════════════════════════════════════════ */
  section('结果');
  console.log(`QA 断言 ${pass} 条 · 通过 ${pass} · 失败 ${fail}`);
  if (fail > 0) {
    console.log('失败清单：');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log(fail === 0 ? '结果：ALL PASS' : '结果：HAS FAILURE');
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  await server.close();
}
