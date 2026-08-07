/**
 * QA · 第四轮优化专项验证（R4-P0-1 ~ P1-2）· 严过关独立回归
 *
 * 通过 Vite SSR 加载器运行真实源码（自动解析 `@/` 别名），验证：
 *   R4-P0-2/P0-3 纯函数：syncNodeStatusFromProgress / rollupProgress / rollupProgressFlat /
 *                  progressToneOf（D2 规则唯一实现 + 父节点加权口径 + 状态色调映射）
 *   R4-P0-3 引擎六写路径收口：createWbsNode / updateWbsNode / deleteWbsNode / moveWbsNode /
 *                  moveTask / upsertReport(日志提交) → 叶子+父链 status 收敛、父节点 progress 落库=子树加权
 *   R4-P1-1 里程碑联动缺口：日志提交 / 看板拖拽后 taskStats 实时变化；全 100% 不自动达成；
 *                  一键标记达成 → doneAt/doneBy=当前用户、status=已达成
 *   R4-P0-1 建项向导残留清理（grep 有质量门/必备 UI 文案）
 *   R4-P0-4/P0-5 源码核验：ReportFormModal 锁定 + keepOpenOnSubmit；WbsPage 全节点进度条 +
 *                  Tooltip + StatusChip + 页内写日志；MilestonesPage 来源标识 + 一键达成
 *   边界（已拍板）：moveTask 拖「进行中」但 progress=100 → 强规则拉回「完成」；
 *                  拖 0% 到「进行中」→ 回落「待办」
 *
 * 用法：node scripts/qa_round4_optimize.mjs
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

function section(title) {
  console.log(`\n════ ${title} ════`);
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
  const { syncNodeStatusFromProgress, milestoneStartFrom } = await server.ssrLoadModule('/src/api/mock/rules.ts');
  const { rollupProgress, rollupProgressFlat, buildTree, milestoneTaskStats } = await server.ssrLoadModule('/src/utils/wbs.ts');
  const { progressToneOf, toneOf } = await server.ssrLoadModule('/src/theme/tokens.ts');
  const { today } = await server.ssrLoadModule('/src/utils/date.ts');

  /* ═══════════════════════════════════════════════════
   * R4-P0-3 · syncNodeStatusFromProgress 纯函数（D2 规则唯一实现）
   * ═══════════════════════════════════════════════════ */
  section('R4-P0-3 · syncNodeStatusFromProgress 纯函数');
  /* 强规则：progress>=100 → 完成（无条件，含 阻塞/待评审） */
  eq(syncNodeStatusFromProgress('待办', 100), '完成', '强规则：待办 100 → 完成');
  eq(syncNodeStatusFromProgress('进行中', 100), '完成', '强规则：进行中 100 → 完成');
  eq(syncNodeStatusFromProgress('完成', 100), '完成', '强规则：完成 100 → 完成');
  eq(syncNodeStatusFromProgress('待评审', 100), '完成', '强规则：待评审 100 → 完成（人工态也被覆盖）');
  eq(syncNodeStatusFromProgress('阻塞', 100), '完成', '强规则：阻塞 100 → 完成（人工态也被覆盖）');
  /* 弱规则：progress===0 且 当前∈{进行中,完成} → 待办 */
  eq(syncNodeStatusFromProgress('进行中', 0), '待办', '弱规则：进行中 0 → 待办');
  eq(syncNodeStatusFromProgress('完成', 0), '待办', '弱规则：完成 0 → 待办');
  eq(syncNodeStatusFromProgress('待办', 0), '待办', '弱规则：待办 0 → 待办（不变）');
  eq(syncNodeStatusFromProgress('待评审', 0), '待评审', '人工边界：待评审 0 → 保留');
  eq(syncNodeStatusFromProgress('阻塞', 0), '阻塞', '人工边界：阻塞 0 → 保留');
  /* 弱规则：0<p<100 且 当前∈{待办,完成} → 进行中 */
  eq(syncNodeStatusFromProgress('待办', 50), '进行中', '弱规则：待办 50 → 进行中');
  eq(syncNodeStatusFromProgress('完成', 50), '进行中', '弱规则：完成 50 → 进行中');
  eq(syncNodeStatusFromProgress('进行中', 50), '进行中', '弱规则：进行中 50 → 进行中（不变）');
  eq(syncNodeStatusFromProgress('待评审', 50), '待评审', '人工边界：待评审 50 → 保留');
  eq(syncNodeStatusFromProgress('阻塞', 50), '阻塞', '人工边界：阻塞 50 → 保留');

  /* ═══════════════════════════════════════════════════
   * R4-P0-2 · rollupProgress / rollupProgressFlat 纯函数（口径 Y 加权）
   * ═══════════════════════════════════════════════════ */
  section('R4-P0-2 · rollupProgress / rollupProgressFlat 纯函数');
  const mkNode = (id, parentId, est, progress, status = '待办') => ({
    id, parentId, nodeType: 'subtask', name: id, description: '', owner: 'ou_xuwenbin01',
    ownerName: '', estimateDays: est, actualDays: 0, startDate: '', dueDate: '',
    status, progress, boardOrder: 0, isCritical: false, milestoneId: null,
    createdBy: '', createdAt: '', updatedAt: '', wbsCode: '1.1', level: 2, children: [],
  });
  /* 树形版：真叶子按 estimateDays 加权 */
  const leafA = mkNode('A', 'P', 2, 100, '完成');
  const leafB = mkNode('B', 'P', 3, 0, '待办');
  const parentNode = { ...mkNode('P', null, 0, 0, '待办'), children: [leafA, leafB] };
  eq(rollupProgress(parentNode), 40, 'rollupProgress：A(2d,100%) B(3d,0%) → 40（加权 (2*100+3*0)/5）');
  const parentAllDone = { ...parentNode, children: [leafA, { ...leafB, progress: 100, status: '完成' }] };
  eq(rollupProgress(parentAllDone), 100, 'rollupProgress：全叶子 100 → 父 100');
  /* 扁平版与树形版同算法 */
  const flatNodes = [parentNode, leafA, leafB].map((n) => ({ ...n, children: undefined }));
  eq(rollupProgressFlat(flatNodes, 'P'), 40, 'rollupProgressFlat：扁平节点集 P → 40（与 rollupProgress 一致）');
  eq(rollupProgressFlat(flatNodes, 'A'), 100, 'rollupProgressFlat：叶子 A 返回自身 progress 100');
  eq(rollupProgressFlat(flatNodes, 'B'), 0, 'rollupProgressFlat：叶子 B 返回自身 progress 0');
  /* 空/孤立节点防御 */
  eq(rollupProgressFlat([], 'X'), 0, 'rollupProgressFlat：空集 → 0');
  eq(rollupProgressFlat(flatNodes, 'NO_SUCH'), 0, 'rollupProgressFlat：不存在 id → 0');
  /* ═══════════════════════════════════════════════════
   * R4-P0-5 · progressToneOf 状态色调映射
   * ═══════════════════════════════════════════════════ */
  section('R4-P0-5 · progressToneOf 色调');
  eq(progressToneOf('待办'), 'neutral', '待办 → neutral');
  eq(progressToneOf('进行中'), 'brand', '进行中 → brand（与 StatusChip warning 解耦）');
  eq(progressToneOf('待评审'), 'warning', '待评审 → warning');
  eq(progressToneOf('完成'), 'success', '完成 → success');
  eq(progressToneOf('阻塞'), 'danger', '阻塞 → danger');
  eq(progressToneOf(null), 'neutral', 'null → neutral（回落）');
  ok(
    progressToneOf('进行中') !== toneOf('进行中'),
    '进行中 tone 与 toneOf 不同（brand vs warning，决策 E 例外生效）',
  );

  /* ═══════════════════════════════════════════════════
   * R4-P0-3 · 引擎六写路径收口（真实 API 联动）
   * ═══════════════════════════════════════════════════ */
  section('R4-P0-3 · 引擎六写路径收口');
  const api = new MockApiClient();
  resetDb();
  await api.devLogin(OPEN_IDS.xuwenbin);

  const mkPayload = (name, planStart, planEnd) => ({
    name,
    type: 'A',
    customer: 'QA 客户',
    contractAmount: 3_000_000,
    background: 'QA 回归 R4',
    goal: ['验证第四轮优化'],
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
      { userOpenId: OPEN_IDS.wangqiang, role: 'tl' },
    ],
  });

  const proj = await api.createProject(mkPayload('QA-R4', '2026-08-01', '2026-08-31'));
  const wbs0 = await api.listWbs(proj.id);
  ok(wbs0.length > 0, 'R4 前置：per-milestone 骨架已生成');
  const rootSkeleton = wbs0.find((n) => n.parentId === null);
  ok(rootSkeleton !== undefined, 'R4 前置：存在根骨架任务');

  /* ── ① createWbsNode：叶子 progress=100 → 完成；父节点回写=加权 ── */
  const t1 = await api.createWbsNode(proj.id, {
    parentId: null, nodeType: 'task', name: '父任务', owner: OPEN_IDS.xuwenbin, estimateDays: 5,
    startDate: '2026-08-01', dueDate: '2026-08-31', status: '待办', progress: 0,
  });
  const c1 = await api.createWbsNode(proj.id, {
    parentId: t1.id, nodeType: 'subtask', name: '子任务1', owner: OPEN_IDS.xuwenbin, estimateDays: 2,
    startDate: '2026-08-01', dueDate: '2026-08-31', status: '待办', progress: 100,
  });
  eq(c1.status, '完成', '① createWbsNode：新建叶子 progress=100 → status=完成（强规则）');
  const afterCreate1 = await api.listWbs(proj.id);
  const parentAfter1 = afterCreate1.find((n) => n.id === t1.id);
  eq(parentAfter1?.progress, 100, '① createWbsNode：父节点 progress 落库=子树叶子加权 100');
  eq(parentAfter1?.status, '完成', '① createWbsNode：父节点 status 收敛为完成');

  /* ── ② createWbsNode：0<p<100 → 进行中；父节点加权变化 ── */
  const c2 = await api.createWbsNode(proj.id, {
    parentId: t1.id, nodeType: 'subtask', name: '子任务2', owner: OPEN_IDS.xuwenbin, estimateDays: 3,
    startDate: '2026-08-01', dueDate: '2026-08-31', status: '待办', progress: 40,
  });
  eq(c2.status, '进行中', '② createWbsNode：新建叶子 0<p<100 → status=进行中');
  const afterCreate2 = await api.listWbs(proj.id);
  const parentAfter2 = afterCreate2.find((n) => n.id === t1.id);
  eq(parentAfter2?.progress, 64, '② createWbsNode：父节点 progress = (2*100+3*40)/5 = 64');
  eq(parentAfter2?.status, '进行中', '② createWbsNode：父节点 0<p<100 → 进行中');

  /* ── ③ updateWbsNode：进度改 0 → 回落待办；父节点回落 ── */
  const upd0 = await api.updateWbsNode(c2.id, { progress: 0 });
  eq(upd0.status, '待办', '③ updateWbsNode：叶子 progress=0 且原进行中 → 回落待办');
  const afterUpd0 = await api.listWbs(proj.id);
  eq(
    afterUpd0.find((n) => n.id === t1.id)?.progress,
    40,
    '③ updateWbsNode：父节点 progress = (2*100+3*0)/5 = 40',
  );
  eq(afterUpd0.find((n) => n.id === t1.id)?.status, '进行中', '③ updateWbsNode：父节点 0<p<100 → 进行中');

  /* ── ④ 日志提交 upsertReport：叶子 progress 改 100 → 完成；父链收敛 ── */
  const rp = await api.submitReport({
    projectId: proj.id,
    week: '2026-W33',
    doneNote: '完成子任务2',
    planItems: ['计划'],
    resourceNote: '',
    tasks: [{ nodeId: c2.id, progressAfter: 100, selected: true }],
    risks: [],
  });
  ok(rp.id !== undefined, '④ 前置：日志提交成功');
  const afterReport = await api.listWbs(proj.id);
  eq(
    afterReport.find((n) => n.id === c2.id)?.status,
    '完成',
    '④ upsertReport：叶子 progress=100 → status=完成（强规则）',
  );
  eq(
    afterReport.find((n) => n.id === t1.id)?.progress,
    100,
    '④ upsertReport：父节点 progress 落库 = (2*100+3*100)/5 = 100',
  );
  eq(afterReport.find((n) => n.id === t1.id)?.status, '完成', '④ upsertReport：父节点全 100 → 完成');

  /* ── ⑤ moveTask 边界 1：拖「进行中」但 progress=100 → 强规则拉回「完成」 ── */
  const board1 = await api.moveTask(c1.id, '进行中', 0);
  ok(board1 !== undefined, '⑤ 前置：moveTask 不抛');
  const afterMove1 = await api.listWbs(proj.id);
  eq(
    afterMove1.find((n) => n.id === c1.id)?.status,
    '完成',
    '⑤ moveTask 边界：拖「进行中」但 progress=100 → 强规则拉回「完成」',
  );

  /* ── ⑥ moveTask 边界 2：拖 0% 到「进行中」→ 回落「待办」 ── */
  const c3 = await api.createWbsNode(proj.id, {
    parentId: t1.id, nodeType: 'subtask', name: '子任务3', owner: OPEN_IDS.xuwenbin, estimateDays: 1,
    startDate: '2026-08-01', dueDate: '2026-08-31', status: '待办', progress: 0,
  });
  const board2 = await api.moveTask(c3.id, '进行中', 0);
  ok(board2 !== undefined, '⑥ 前置：moveTask 0% 不抛');
  const afterMove2 = await api.listWbs(proj.id);
  eq(
    afterMove2.find((n) => n.id === c3.id)?.status,
    '待办',
    '⑥ moveTask 边界：拖 0% 到「进行中」→ 回落「待办」（防脏状态）',
  );

  /* ── ⑦ deleteWbsNode：删除叶子 → 父节点回写 ── */
  await api.deleteWbsNode(c3.id);
  const afterDelete = await api.listWbs(proj.id);
  ok(!afterDelete.some((n) => n.id === c3.id), '⑦ deleteWbsNode：节点已删除');
  eq(
    afterDelete.find((n) => n.id === t1.id)?.progress,
    100,
    '⑦ deleteWbsNode：父节点 progress 仍 = (2*100+3*100)/5 = 100（c3 删除不影响，0 权重）',
  );

  /* ── ⑧ moveWbsNode：移动子树 → 新旧父节点回写 ── */
  const t2 = await api.createWbsNode(proj.id, {
    parentId: null, nodeType: 'task', name: '父任务2', owner: OPEN_IDS.xuwenbin, estimateDays: 1,
    startDate: '2026-08-01', dueDate: '2026-08-31', status: '待办', progress: 0,
  });
  const c4 = await api.createWbsNode(proj.id, {
    parentId: t2.id, nodeType: 'subtask', name: '子任务4', owner: OPEN_IDS.xuwenbin, estimateDays: 4,
    startDate: '2026-08-01', dueDate: '2026-08-31', status: '待办', progress: 50,
  });
  eq((await api.listWbs(proj.id)).find((n) => n.id === t2.id)?.progress, 50, '⑧ 前置：t2 进度 50');
  /* 把 c4 从 t2 移到 t1 下 */
  const moved = await api.moveWbsNode(c4.id, t1.id, 0);
  const afterMoveWbs = moved;
  eq(afterMoveWbs.find((n) => n.id === t1.id)?.progress, 78, '⑧ moveWbsNode：t1 进度 = (2*100+3*100+4*50)/9 = 78');
  /* t2 失去子节点后变回叶子：叶子保留自身存储值（50 为移动前父汇总落库值），不再按父汇总 */
  eq(afterMoveWbs.find((n) => n.id === t2.id)?.progress, 50, '⑧ moveWbsNode：t2 变回叶子，保留自身存储值 50（叶子口径）');
  eq(afterMoveWbs.find((n) => n.id === t2.id)?.status, '进行中', '⑧ moveWbsNode：t2 0<p<100 → 进行中');

  /* ═══════════════════════════════════════════════════
   * R4-P1-1 · 里程碑联动缺口 + 不自动达成 + 一键达成
   * ═══════════════════════════════════════════════════ */
  section('R4-P1-1 · 里程碑 taskStats 联动 / 不自动达成 / 一键达成');
  const milestones0 = await api.listMilestones(proj.id);
  const m1 = milestones0[0];
  /* 给 M1 骨架下挂两个子任务：直接改进度使 taskStats 变化 */
  const msRoot = (await api.listWbs(proj.id)).find((n) => n.milestoneId === m1.id && n.parentId === null);
  ok(msRoot !== undefined, 'R4-P1-1 前置：M1 有骨架根节点');
  const mc1 = await api.createWbsNode(proj.id, {
    parentId: msRoot.id, nodeType: 'subtask', name: 'M1-子1', owner: OPEN_IDS.xuwenbin, estimateDays: 2,
    startDate: '2026-08-01', dueDate: '2026-08-01', status: '待办', progress: 100,
  });
  const mc2 = await api.createWbsNode(proj.id, {
    parentId: msRoot.id, nodeType: 'subtask', name: 'M1-子2', owner: OPEN_IDS.xuwenbin, estimateDays: 3,
    startDate: '2026-08-01', dueDate: '2026-08-01', status: '待办', progress: 0,
  });
  const msAfterCreate = await api.listMilestones(proj.id);
  const m1a = msAfterCreate.find((m) => m.id === m1.id);
  ok(m1a !== undefined, 'R4-P1-1 前置：能取到 M1');
  eq(m1a.taskStats.progress, 40, 'R4-P1-1 ① createWbsNode 后 M1 taskStats.progress = 40（实时联动）');
  ok(m1a.doneAt === null && m1a.doneBy === null, 'R4-P1-1 ② 任务未全完成时 doneAt/doneBy 仍 null');
  /* 日志提交把 mc2 拉到 100 → taskStats 100 但里程碑不自动达成 */
  await api.submitReport({
    projectId: proj.id,
    week: '2026-W33',
    doneNote: 'M1 子任务全完成',
    planItems: ['计划'],
    resourceNote: '',
    tasks: [{ nodeId: mc2.id, progressAfter: 100, selected: true }],
    risks: [],
  });
  const msAfterReport = await api.listMilestones(proj.id);
  const m1b = msAfterReport.find((m) => m.id === m1.id);
  eq(m1b.taskStats.progress, 100, 'R4-P1-1 ③ 日志提交后 M1 taskStats.progress = 100（D3 缺口已修复）');
  /* total = 绑定节点(msRoot) + 子树真叶子(mc1,mc2) = 3；全 100 后 done = 3（含回写后的父节点） */
  eq(m1b.taskStats.total, 3, 'R4-P1-1 ③ total=3（绑定父 + 2 真叶子）');
  eq(m1b.taskStats.done, 3, 'R4-P1-1 ③ done=3（全 100，含回写后父节点）');
  ok(m1b.doneAt === null && m1b.doneBy === null, 'R4-P1-1 ④ 全 100% 仍不自动达成（doneAt/doneBy 保持 null）');
  ok(m1b.done === false, 'R4-P1-1 ④ done=false（未自动达成，状态仍由时间轴判定）');
  /* 一键达成：updateMilestone{achieved:true} → doneAt/doneBy=当前用户、status=已达成 */
  const achieved = await api.updateMilestone(m1.id, { achieved: true });
  eq(achieved.doneAt, today(), 'R4-P1-1 ⑤ 标记达成后 doneAt=today');
  eq(achieved.doneBy, OPEN_IDS.xuwenbin, 'R4-P1-1 ⑤ doneBy=当前用户（审计留痕）');
  eq(achieved.status, '已达成', 'R4-P1-1 ⑤ status → 已达成');
  eq(achieved.done, true, 'R4-P1-1 ⑤ done → true');

  /* ── 看板拖拽联动：moveTask 到完成 → taskStats 变化（D3 缺口修复） ── */
  const mc3 = await api.createWbsNode(proj.id, {
    parentId: msRoot.id, nodeType: 'subtask', name: 'M1-子3', owner: OPEN_IDS.xuwenbin, estimateDays: 1,
    startDate: '2026-08-01', dueDate: '2026-08-01', status: '待办', progress: 0,
  });
  await api.moveTask(mc3.id, '完成', 0); // 拖到完成 → progress=100
  const msAfterMoveTask = await api.listMilestones(proj.id);
  const m1c = msAfterMoveTask.find((m) => m.id === m1.id);
  ok(m1c.taskStats.progress === 100, 'R4-P1-1 ⑥ moveTask 拖到完成 → M1 taskStats.progress=100（实时联动）');

  /* ═══════════════════════════════════════════════════
   * R4-P0-1 · 建项向导残留清理（源码 grep）
   * ═══════════════════════════════════════════════════ */
  section('R4-P0-1 · 建项向导残留清理');
  const createSrc = readFileSync(new URL('../src/pages/projects/ProjectCreatePage.tsx', import.meta.url), 'utf8');
  const jsxLines = createSrc.split('\n').filter(
    (l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'),
  );
  const visibleQualityGate = jsxLines.filter(
    (l) => l.includes('有质量门') && !l.includes('质量门由生命周期模板'),
  );
  const visibleBiBei = jsxLines.filter((l) => l.includes('必备') && !l.includes('不再展示「必备」') && !l.includes('不再按「必备」'));
  eq(visibleQualityGate.length, 0, 'R4-P0-1① 向导无「有质量门」Chip UI 文案');
  eq(visibleBiBei.length, 0, 'R4-P0-1③ 向导无「必备」UI 文案');
  ok(
    !createSrc.includes('最终分类（决定生命周期模板与质量门）'),
    'R4-P0-1② 副标题不再含「质量门」',
  );
  ok(
    createSrc.includes('最终分类（决定生命周期模板与默认里程碑）'),
    'R4-P0-1② 副标题改为「最终分类（决定生命周期模板与默认里程碑）」',
  );

  /* ═══════════════════════════════════════════════════
   * R4-P0-4 · WBS 页内写日志 Modal（源码核验）
   * ═══════════════════════════════════════════════════ */
  section('R4-P0-4 · WBS 页内写日志 Modal');
  const wbsSrc = readFileSync(new URL('../src/pages/projects/WbsPage.tsx', import.meta.url), 'utf8');
  ok(
    wbsSrc.includes('setReportLockNodeId(node.id)') && wbsSrc.includes('setReportModalOpen(true)'),
    'R4-P0-4① WbsPage「写日志」不再 navigate，改为页内开 Modal（lockNodeId=当前节点）',
  );
  ok(!wbsSrc.includes("navigate(ROUTES.projectReports(id)"), 'R4-P0-4① 无 navigate 跳转工作日志页');
  ok(
    wbsSrc.includes('<ReportFormModal') && wbsSrc.includes('keepOpenOnSubmit') && wbsSrc.includes('lockNodeId={reportLockNodeId}'),
    'R4-P0-4① WbsPage 渲染 ReportFormModal（keepOpenOnSubmit=true，lockNodeId 传入）',
  );
  ok(
    wbsSrc.includes('void fetchWbs(id, projectType)') && wbsSrc.includes('void refreshMilestones(id)'),
    'R4-P0-4① 提交后刷新 WBS 树 + 里程碑',
  );
  /* ReportFormModal 内部：锁定 + 连续添加 */
  const modalSrc = readFileSync(new URL('../src/components/report/ReportFormModal.tsx', import.meta.url), 'utf8');
  ok(
    modalSrc.includes('checked={t.selected || locked}') && modalSrc.includes('disabled={readOnly || locked}'),
    'R4-P0-4② 锁定节点 checkbox checked+disabled（不可取消）',
  );
  ok(
    modalSrc.includes('LockOutlinedIcon') && modalSrc.includes('由「写日志」进入，该任务已锁定；可继续勾选其他任务'),
    'R4-P0-4② 锁图标 + tooltip',
  );
  ok(
    modalSrc.includes('const locked = !editingReport && lockNodeId === n.id'),
    'R4-P0-4② 锁定仅新建态生效（编辑态只读走 readOnly）',
  );
  ok(
    modalSrc.includes('disabled={readOnly}') &&
      modalSrc.includes('label="完%"'),
    'R4-P0-4③ 进度值输入保持可编辑（锁不影响进度输入）',
  );
  /* 精确核验：进度输入 disabled 只用 readOnly（不含 locked） */
  const progressBlock = modalSrc.slice(modalSrc.indexOf('label="完%"') - 260, modalSrc.indexOf('label="完%"') + 160);
  ok(
    progressBlock.includes('disabled={readOnly}') && !progressBlock.includes('disabled={readOnly || locked}'),
    'R4-P0-4③ 进度输入 disabled={readOnly}（锁节点进度仍可编辑）',
  );
  ok(
    modalSrc.includes('if (keepOpenOnSubmit)') &&
      modalSrc.includes('reset({ week: weekOptions[0], doneNote: \'\', resourceNote: \'\', planItems: [\'\'], risks: [] })') &&
      modalSrc.includes('selected: n.id === lockNodeId'),
    'R4-P0-4④ keepOpenOnSubmit=true → 保持打开并重置（周次本周、锁定任务保留勾选）→ 连续添加',
  );
  /* ReportsPage 入口行为不变（keepOpenOnSubmit=false） */
  const reportsSrc = readFileSync(new URL('../src/pages/projects/ReportsPage.tsx', import.meta.url), 'utf8');
  ok(
    reportsSrc.includes('<ReportFormModal') && reportsSrc.includes('keepOpenOnSubmit={false}'),
    'R4-P0-4⑤ ReportsPage 换用 Modal 且 keepOpenOnSubmit=false（提交后关闭，行为不变）',
  );
  ok(
    reportsSrc.includes('prefillNodeId') && reportsSrc.includes('prefillLockNodeId'),
    'R4-P0-4⑤ ReportsPage 保留 prefillNodeId 兼容（旧链接 → lockNodeId）',
  );

  /* ═══════════════════════════════════════════════════
   * R4-P0-5 · 进度条 Tooltip / 状态色 / StatusChip / 里程碑来源标识
   * ═══════════════════════════════════════════════════ */
  section('R4-P0-5 · 进度条 UX + 里程碑来源标识');
  ok(
    wbsSrc.includes('Tooltip title={`${node.name} ${progress}%（${node.status}）`}'),
    'R4-P0-5① WBS 进度条 Tooltip「{名} {p}%（{状态}）」',
  );
  ok(
    modalSrc.includes('Tooltip title={`${n.name} ${n.progress}%（${n.status}）`}'),
    'R4-P0-5① ReportsPage 任务树进度条 Tooltip 同文案',
  );
  ok(
    wbsSrc.includes('tone={progressToneOf(node.status)}'),
    'R4-P0-5② WBS 进度条用 progressToneOf 状态色',
  );
  ok(
    modalSrc.includes('tone={progressToneOf(n.status)}'),
    'R4-P0-5② ReportsPage 任务树进度条用 progressToneOf',
  );
  /* 父节点进度条保留：ProgressBar 不在 isLeaf 条件内 */
  const wbsProgressBlock = wbsSrc.slice(wbsSrc.indexOf('R4-P0-5：进度条全节点渲染'), wbsSrc.indexOf('R4-P0-5：进度条全节点渲染') + 220);
  ok(
    wbsProgressBlock.includes('<Tooltip') && wbsProgressBlock.includes('<ProgressBar') &&
      !/isLeaf &&/.test(wbsProgressBlock),
    'R4-P0-5/D1 进度条全节点渲染（不在 isLeaf 条件内）',
  );
  ok(
    wbsSrc.includes('<StatusChip') && wbsSrc.includes('status={node.status}') && wbsSrc.includes('variant="soft"'),
    'R4-P0-5③ WBS 节点行 StatusChip（全节点）',
  );
  /* 里程碑来源标识 + 一键达成 */
  const msSrc = readFileSync(new URL('../src/pages/projects/MilestonesPage.tsx', import.meta.url), 'utf8');
  ok(
    msSrc.includes("m.status === '进行中' && !m.statusOverride") &&
      msSrc.includes("m.taskStats.progress === 0") &&
      msSrc.includes('diffDays(startFrom, today()) >= 0'),
    'R4-P1-2 时间驱动判定（进行中且非人工覆盖，progress=0 且起算日已到）',
  );
  ok(
    msSrc.includes('时间驱动') && msSrc.includes('任务驱动') && msSrc.includes('已到计划起算日'),
    'R4-P1-2 来源标识灰字 + tooltip 话术',
  );
  ok(
    msSrc.includes('m.taskStats.progress === 100') && msSrc.includes('!m.done') &&
      msSrc.includes('关联任务已全部完成') && msSrc.includes('标记达成'),
    'R4-P1-1 全完成提示 + 一键标记达成入口',
  );
  ok(
    msSrc.includes('void handleAchieve(m)'),
    'R4-P1-1 入口走既有 handleAchieve（updateMilestone{achieved:true}）',
  );
  ok(
    msSrc.includes('任务全部完成不会自动达成里程碑，需人工确认'),
    'R4-P1-1 顶部 Alert 补充「不自动达成」说明',
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
