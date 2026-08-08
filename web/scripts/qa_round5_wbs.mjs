/**
 * QA · 第五轮 WBS 面板三条交互优化专项回归（R5-P0-1 / R5-P0-2 / R5-P0-3）· 严过关独立回归
 *
 * 测试哲学（沿用 R4 脚本风格：纯 node，不依赖浏览器）：
 *   1) **契约执行验证**（最高价值）——把产品源码中的关键表达式 / 函数体**原文抽取**出来，
 *      注入真实依赖（`utils/wbs.parentIdSet`）后**真正执行**。这样断言的不是「源码里写了什么字符串」，
 *      而是「这段真实代码跑出来是什么结果」，源码一旦漂移即刻失败。
 *      覆盖：`buildNewTaskRefs`（R5 数据一致性契约唯一真源）、`effectiveLockNodeId`、
 *            `lockDowngraded`、WbsPage 写日志 `disabledReason`、`setLockParent(Boolean(parentId))`。
 *   2) **引擎端到端验证**——用真实 MockApiClient 走 createProject → createWbsNode → submitReport，
 *      验证「账实一致」在真实写路径上成立（AC-3.5/3.6/3.7/3.10）。
 *      含**负向对照**（R4 老写法 payload）证明本测试对该缺陷敏感、不是永真断言。
 *   3) **源码解析断言**——`disabled` / label / helperText / Tooltip 文案与设计 §8.2 统一文案表**逐字比对**，
 *      以及硬约束（引擎红线、SK-4 叶子口径唯一入口、编辑态不清洗）。
 *
 * 覆盖的验收标准：
 *   R5-P0-1（关窗）  AC-1.1 / 1.2 / 1.3 / 1.4 / 1.5 / 1.6 / 1.7（1.1/1.2/1.5/1.6/1.7 部分需人工走查，见报告）
 *   R5-P0-2（上级锁定）AC-2.1 / 2.2 / 2.3 / 2.4 / 2.5 / 2.6 / 2.7 / 2.8
 *   R5-P0-3（账实一致）AC-3.1 / 3.2 / 3.3 / 3.4 / 3.5 / 3.6 / 3.7 / 3.8 / 3.9 / 3.10 / 3.11
 *
 * 红线：本脚本**只读**产品源码，不做任何写入。
 *
 * 用法：node scripts/qa_round5_wbs.mjs
 */
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
const failures = [];
/** 断言按文件归类计数（报告用） */
const byArea = {};
let curArea = '(未分类)';

function ok(cond, label, detail = '') {
  byArea[curArea] = byArea[curArea] ?? { pass: 0, fail: 0 };
  if (cond) {
    pass += 1;
    byArea[curArea].pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    byArea[curArea].fail += 1;
    failures.push(`[${curArea}] ${label}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function section(title, area) {
  if (area) curArea = area;
  console.log(`\n════ ${title} ════`);
}

/* ── 源码抽取工具（只读） ── */

/** 从 `marker`（形如 `xxx={`）起做花括号配平，返回大括号内的表达式原文 */
function extractBraceExpr(src, markerEndIndex) {
  let depth = 1;
  let i = markerEndIndex;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    if (depth === 0) break;
    i += 1;
  }
  return src.slice(markerEndIndex, i);
}

/** 抽取某个 JSX 元素的完整原文（从 `<Tag` 到其自闭合 `/>` 或首个 `>`） */
function extractJsxBlock(src, tag) {
  const start = src.indexOf(`<${tag}`);
  if (start < 0) return '';
  const selfClose = src.indexOf('/>', start);
  return selfClose < 0 ? '' : src.slice(start, selfClose + 2);
}

const modalSrc = readFileSync(new URL('../src/components/report/ReportFormModal.tsx', import.meta.url), 'utf8');
const wbsSrc = readFileSync(new URL('../src/pages/projects/WbsPage.tsx', import.meta.url), 'utf8');
const reportsSrc = readFileSync(new URL('../src/pages/projects/ReportsPage.tsx', import.meta.url), 'utf8');

/* ── 设计 §8.2 统一文案表（逐字，禁止改写） ── */
const COPY = {
  wbsParentLogTip: '该任务已有下级，请在具体子任务上记录工作日志',
  modalParentRowTip: '该任务已有下级，进度由子任务加权汇总，请在子任务中记录',
  modalSectionTip: '父任务进度由子任务汇总，不可直接勾选',
  lockDowngradedTip: '该任务已有下级，请到具体子任务记录进度',
  parentLockLabel: '上级节点（已锁定）',
  parentLockHelper: '由「创建下级任务」进入，上级节点已锁定；如需调整层级，请到该节点「编辑」中修改上级',
  lockNodeTip: '由「写日志」进入，该任务已锁定；可继续勾选其他任务',
  lockMilestoneHelper: '该任务继承自上级里程碑，不可修改；如需调整请到上级节点更改',
};

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

try {
  const { MockApiClient } = await server.ssrLoadModule('/src/api/mock/index.ts');
  const { resetDb } = await server.ssrLoadModule('/src/api/mock/db.ts');
  const { OPEN_IDS } = await server.ssrLoadModule('/src/api/mock/fixtures/users.ts');
  const { parentIdSet, flattenTree, buildTree, rollupProgressFlat, isLeafNode } =
    await server.ssrLoadModule('/src/utils/wbs.ts');
  const { reportCountByNode, nodeReportsOf } = await server.ssrLoadModule('/src/utils/reportAgg.ts');
  const { allowedChildTypes } = await server.ssrLoadModule('/src/api/mock/rules.ts');
  const { DEFAULT_WBS_RULES } = await server.ssrLoadModule('/src/config/enums.ts');

  /* ═══════════════════════════════════════════════════
   * 0 · 源码契约抽取（把真实实现变成可执行函数）
   * ═══════════════════════════════════════════════════ */
  section('0 · 源码契约抽取（真实实现 → 可执行）', 'ReportFormModal.tsx');

  /* ① buildNewTaskRefs —— R5 数据一致性契约唯一真源（设计 §3.3） */
  const bStart = modalSrc.indexOf('const buildNewTaskRefs');
  ok(bStart > 0, '0-1 源码存在 `buildNewTaskRefs`（assemble 新建分支的唯一组装入口）');
  const bEnd = modalSrc.indexOf('\n  };', bStart);
  ok(bEnd > bStart, '0-2 能定位 `buildNewTaskRefs` 函数体边界');
  const buildRefsRaw = modalSrc.slice(bStart, bEnd + '\n  };'.length);
  /* 仅剥离 TS 类型注解，逻辑一字不改 */
  const buildRefsJs = buildRefsRaw
    .replace(/: ReportTaskRef\[\]/g, '')
    .replace(/\.map<ReportTaskRef>/g, '.map');
  ok(
    !/[:<]\s*ReportTaskRef/.test(buildRefsJs),
    '0-3 TS 注解剥离干净（仅去类型，逻辑原样）',
  );
  /** 执行真实 buildNewTaskRefs 源码；依赖注入真实 utils/wbs.parentIdSet */
  const runBuildNewTaskRefs = new Function(
    'latestNodesOf',
    'parentIdSet',
    'taskMap',
    `${buildRefsJs}\nreturn buildNewTaskRefs();`,
  );
  const buildRefs = (nodes, taskMap) => runBuildNewTaskRefs(() => nodes, parentIdSet, taskMap);
  ok(typeof buildRefs === 'function', '0-4 `buildNewTaskRefs` 已构造为可执行契约函数');

  /* ② effectiveLockNodeId —— AC-3.8 降级判定 */
  const effLine = modalSrc
    .split('\n')
    .find((l) => l.includes('lockNodeId && !parentIds.has(lockNodeId)'));
  ok(Boolean(effLine), '0-5 源码存在 `effectiveLockNodeId` 派生表达式（AC-3.8）');
  const effExpr = (effLine ?? '() => (null)').trim().replace(/^\(\)\s*=>\s*/, '').replace(/,$/, '');
  const runEffectiveLock = new Function('lockNodeId', 'parentIds', `return ${effExpr};`);
  ok(typeof runEffectiveLock === 'function', '0-6 `effectiveLockNodeId` 已构造为可执行契约函数');

  /* ③ lockDowngraded */
  const dgLine = modalSrc.split('\n').find((l) => l.includes('const lockDowngraded ='));
  ok(Boolean(dgLine), '0-7 源码存在 `lockDowngraded` 派生值');
  const dgExpr = (dgLine ?? 'x = false').split('=').slice(1).join('=').trim().replace(/;$/, '');
  const runLockDowngraded = new Function('lockNodeId', 'effectiveLockNodeId', `return ${dgExpr};`);

  /* ④ WbsPage 写日志 disabledReason —— AC-3.1 / 3.2 */
  section('0 · 源码契约抽取（WbsPage）', 'WbsPage.tsx');
  const tipIdx = wbsSrc.indexOf(COPY.wbsParentLogTip);
  ok(tipIdx > 0, '0-8 WbsPage 存在父节点写日志 Tooltip 文案（逐字命中统一文案表）');
  const drMarker = 'disabledReason={';
  const drStart = wbsSrc.lastIndexOf(drMarker, tipIdx);
  ok(drStart > 0, '0-9 能定位「写日志」按钮的 `disabledReason` 表达式');
  const drExpr = extractBraceExpr(wbsSrc, drStart + drMarker.length);
  const runDisabledReason = new Function('archived', 'isLeaf', `return (${drExpr});`);

  /* ⑤ openCreate 的 setLockParent 参数 —— AC-2.1 / 2.7 */
  const openCreateStart = wbsSrc.indexOf('const openCreate = (parentId: string)');
  ok(openCreateStart > 0, '0-10 源码存在 `openCreate(parentId)`');
  const openCreateEnd = wbsSrc.indexOf('\n  };', openCreateStart);
  const openCreateSrc = wbsSrc.slice(openCreateStart, openCreateEnd);
  const lpLine = openCreateSrc.split('\n').find((l) => l.includes('setLockParent('));
  ok(Boolean(lpLine), '0-11 `openCreate` 内存在 `setLockParent(...)` 赋值');
  const lpExpr = (lpLine ?? 'setLockParent(false)').trim().replace(/^setLockParent\(/, '').replace(/\);?$/, '');
  const runLockParent = new Function('parentId', `return (${lpExpr});`);

  /* ═══════════════════════════════════════════════════
   * 1 · R5-P0-3 账实一致契约（最高优先级）· 纯函数层
   * ═══════════════════════════════════════════════════ */
  section('1 · R5-P0-3 账实一致契约（buildNewTaskRefs 真实源码执行）', 'ReportFormModal.tsx');

  const mkNode = (id, parentId, est, progress, extra = {}) => ({
    id,
    parentId,
    nodeType: parentId ? 'subtask' : 'task',
    name: id,
    description: '',
    owner: 'ou_xuwenbin01',
    ownerName: '',
    estimateDays: est,
    actualDays: 0,
    startDate: '',
    dueDate: '',
    status: '待办',
    progress,
    boardOrder: 0,
    isCritical: false,
    milestoneId: null,
    createdBy: '',
    createdAt: '',
    updatedAt: '',
    wbsCode: id,
    level: parentId ? 2 : 1,
    ...extra,
  });

  /* 固定夹具：P1 为父（存储进度 35 = 叶子加权 (1*30+1*40)/2），L1/L2 为其叶子，S1 为独立根叶子 */
  const fixture = [
    mkNode('P1', null, 0, 35, { wbsCode: '1' }),
    mkNode('L1', 'P1', 1, 30, { wbsCode: '1.1' }),
    mkNode('L2', 'P1', 1, 40, { wbsCode: '1.2' }),
    mkNode('S1', null, 2, 10, { wbsCode: '2' }),
  ];
  eq(rollupProgressFlat(fixture, 'P1'), 35, '1-0 夹具自检：P1 叶子加权 = 35（与其存储进度一致）');

  /* 用户在弹窗里给父节点填了 60（R4 老缺陷的复现输入），叶子 L1 填 90 并勾选 */
  const evilTaskMap = {
    P1: { progressAfter: 60, selected: true },
    L1: { progressAfter: 90, selected: true },
    S1: { progressAfter: 10, selected: false },
    /* L2 刻意缺席 → 走 `?? n.progress` 回落分支 */
  };
  const refs = buildRefs(fixture, evilTaskMap);
  const refOf = (id) => refs.find((r) => r.nodeId === id);

  eq(refs.length, 4, '1-1 payload.tasks 覆盖全部节点（父节点禁用可见但仍在 payload 内）');

  /* ① 父节点 selected 恒 false（AC-3.5 / 设计 §8.5 推论 1） */
  eq(refOf('P1').selected, false, '1-2 ★AC-3.5 父节点 `selected` 恒 false（即使 taskMap 里被置 true）');
  /* ② 父节点 progressAfter = 提交前存储值，用户输入 60 被丢弃（AC-3.5 / 推论 2） */
  eq(refOf('P1').progressAfter, 35, '1-3 ★AC-3.5 父节点 `progressAfter` = 提交前存储值 35（用户输入 60 被丢弃）');
  ok(refOf('P1').progressAfter !== 60, '1-4 ★账实一致：父节点不携带用户输入值 60（R4 缺陷不再复现）');
  eq(
    refOf('P1').progressAfter,
    rollupProgressFlat(fixture, 'P1'),
    '1-5 ★AC-3.6/3.7 父节点回传值 ≡ rollupProgressFlat（口径唯一来源）',
  );

  /* ③ 叶子行为完全不变（AC-3.4） */
  eq(refOf('L1').selected, true, '1-6 AC-3.4 叶子（勾选）`selected` = true');
  eq(refOf('L1').progressAfter, 90, '1-7 AC-3.4 叶子（勾选）`progressAfter` = 用户输入 90');
  eq(refOf('L2').selected, false, '1-8 AC-3.4 叶子（taskMap 缺席）`selected` 回落 false');
  eq(refOf('L2').progressAfter, 40, '1-9 AC-3.4 叶子（taskMap 缺席）`progressAfter` 回落自身存储值 40');
  eq(refOf('S1').selected, false, '1-10 AC-3.4 独立根叶子未勾选 → selected=false');
  eq(refOf('S1').progressAfter, 10, '1-11 AC-3.4 独立根叶子 `progressAfter` = 自身值 10');

  /* ④ 幂等性：父节点写入前后存储值不变（引擎 L1609 退化为无副作用写） */
  const idempotent = refs
    .filter((r) => parentIdSet(fixture).has(r.nodeId))
    .every((r) => r.progressAfter === fixture.find((n) => n.id === r.nodeId).progress);
  ok(idempotent, '1-12 ★设计 §8.5 推论 3：父节点写入幂等（progressAfter ≡ 写入前 node.progress）');

  /* ⑤ 多层父节点：三层树，中间层也必须被判为父 */
  const deep = [
    mkNode('R', null, 0, 50, { wbsCode: '1' }),
    mkNode('M', 'R', 0, 50, { wbsCode: '1.1' }),
    mkNode('D1', 'M', 1, 20, { wbsCode: '1.1.1' }),
    mkNode('D2', 'M', 1, 80, { wbsCode: '1.1.2' }),
  ];
  const deepRefs = buildRefs(deep, {
    R: { progressAfter: 99, selected: true },
    M: { progressAfter: 88, selected: true },
    D1: { progressAfter: 20, selected: true },
  });
  const dOf = (id) => deepRefs.find((r) => r.nodeId === id);
  eq(dOf('R').selected, false, '1-13 三层树：根父节点 selected=false');
  eq(dOf('M').selected, false, '1-14 三层树：中间层父节点 selected=false（不只拦根）');
  eq(dOf('R').progressAfter, 50, '1-15 三层树：根父节点回传存储值 50（99 被丢弃）');
  eq(dOf('M').progressAfter, 50, '1-16 三层树：中间层父节点回传存储值 50（88 被丢弃）');
  eq(dOf('D1').selected, true, '1-17 三层树：最底层叶子仍可勾选');

  /* ⑥ AC-3.11 极端场景：全部根任务都有子节点 → 仍有可填报的叶子 */
  const selectable = buildRefs(deep, { D1: { progressAfter: 100, selected: true }, D2: { progressAfter: 100, selected: true } })
    .filter((r) => r.selected);
  eq(selectable.length, 2, '1-18 AC-3.11 全根任务均有子节点时，叶子仍可正常勾选填报（不出现「无处可填」）');

  /* ⑦ 单节点树（自身即叶子，不应被误判为父） */
  const solo = [mkNode('ONLY', null, 1, 42, { wbsCode: '1' })];
  const soloRefs = buildRefs(solo, { ONLY: { progressAfter: 77, selected: true } });
  eq(soloRefs[0].selected, true, '1-19 边界：单节点树自身是叶子 → 可勾选');
  eq(soloRefs[0].progressAfter, 77, '1-20 边界：单节点树自身是叶子 → 用户输入生效');

  /* ⑧ 空树防御 */
  eq(buildRefs([], {}).length, 0, '1-21 边界：空节点集 → payload.tasks 为空数组（不抛异常）');

  /* ⑨ 与 payload 同源：assemble 内重新基于 latestNodesOf() 求父集（设计 §3.3 ⚠️） */
  ok(
    buildRefsRaw.includes('const latest = latestNodesOf();') &&
      buildRefsRaw.includes('parentIdSet(latest)'),
    '1-22 硬约束：父子判定基于 `latestNodesOf()` 重新求取，与 payload 数组严格同源（防 tree/nodes 漂移）',
  );

  /* ═══════════════════════════════════════════════════
   * 2 · R5-P0-3 · lockNodeId 非叶降级（AC-3.8）
   * ═══════════════════════════════════════════════════ */
  section('2 · R5-P0-3 lockNodeId 非叶降级（AC-3.8）', 'ReportFormModal.tsx');
  const fxTree = buildTree(fixture);
  const fxParentIds = parentIdSet(flattenTree(fxTree));
  eq(fxParentIds.size, 1, '2-0 渲染层 parentIds = parentIdSet(flattenTree(tree)) → 命中 1 个父节点');
  ok(fxParentIds.has('P1'), '2-1 渲染层 parentIds 正确识别 P1 为父节点');

  eq(runEffectiveLock('L1', fxParentIds), 'L1', '2-2 lockNodeId 指向叶子 L1 → effectiveLockNodeId = L1（正常锁定）');
  eq(runEffectiveLock('S1', fxParentIds), 'S1', '2-3 lockNodeId 指向独立根叶子 S1 → 正常锁定');
  eq(runEffectiveLock('P1', fxParentIds), null, '2-4 ★AC-3.8 lockNodeId 指向非叶 P1 → 降级为 null（不锁定）');
  eq(runEffectiveLock(null, fxParentIds), null, '2-5 lockNodeId = null → effectiveLockNodeId = null');
  ok(!runEffectiveLock('', fxParentIds), '2-6 lockNodeId = 空串 → falsy（不锁定）');

  eq(runLockDowngraded('P1', runEffectiveLock('P1', fxParentIds)), true, '2-7 AC-3.8 非叶锁定 → lockDowngraded = true（触发 caption 提示）');
  eq(runLockDowngraded('L1', runEffectiveLock('L1', fxParentIds)), false, '2-8 叶子锁定 → lockDowngraded = false（无多余提示）');
  eq(runLockDowngraded(null, null), false, '2-9 无锁定入参 → lockDowngraded = false');

  /* 降级后 taskMap 初始化不预勾父节点（open effect 用 effectiveLockNodeId） */
  ok(
    modalSrc.includes('selected: n.id === effectiveLockNodeId }'),
    '2-10 AC-3.8 open effect 的 taskMap 初始化改用 `effectiveLockNodeId`（非叶不预勾）',
  );
  ok(
    !/selected: n\.id === lockNodeId\b/.test(modalSrc),
    '2-11 硬约束：源码中已无 `n.id === lockNodeId` 旧口径残留（不留不一致死代码）',
  );
  ok(
    modalSrc.includes('const locked = !editingReport && effectiveLockNodeId === n.id;'),
    '2-12 renderTaskTree 的 `locked` 判定改用 `effectiveLockNodeId`',
  );
  ok(
    modalSrc.includes('{ progressAfter: progressByNode.get(n.id) ?? n.progress, selected: n.id === effectiveLockNodeId }'),
    '2-13 doSave 的 keepOpen 备用分支也已换成 `effectiveLockNodeId`（设计 §8.3）',
  );
  ok(
    modalSrc.includes(COPY.lockDowngradedTip),
    `2-14 AC-3.8 降级提示文案逐字命中统一文案表：「${COPY.lockDowngradedTip}」`,
  );
  ok(
    !modalSrc.includes('toast.warning(LOCK_DOWNGRADED') && !modalSrc.includes('toast.info(LOCK_DOWNGRADED'),
    '2-15 D-2 裁定：降级提示走 caption，不弹 toast',
  );
  /* ReportsPage 侧保持不加第二套判定（设计 §2.3：避免两处口径） */
  ok(
    reportsSrc.includes('prefillNodeId') && !reportsSrc.includes('parentIdSet'),
    '2-16 设计 §2.3：ReportsPage 未新增第二套叶子判定（降级统一由弹窗兜底）',
  );

  /* ═══════════════════════════════════════════════════
   * 3 · R5-P0-3 · 弹窗父节点行禁用（AC-3.3 / 3.4 / 3.9）
   * ═══════════════════════════════════════════════════ */
  section('3 · R5-P0-3 弹窗任务树父行禁用（AC-3.3/3.4/3.9）', 'ReportFormModal.tsx');
  ok(
    modalSrc.includes("import { flattenTree, parentIdSet } from '@/utils/wbs';"),
    '3-1 SK-4：叶子口径走 `utils/wbs` 唯一入口（flattenTree + parentIdSet）',
  );
  ok(
    modalSrc.includes('const parentIds = useMemo(() => parentIdSet(flattenTree(tree)), [tree]);'),
    '3-2 渲染层 parentIds 派生自 tree（与渲染源同源）',
  );
  ok(
    modalSrc.includes('const hasChildren = parentIds.has(n.id);'),
    '3-3 行渲染用 `hasChildren = parentIds.has(n.id)` 判定父节点',
  );
  ok(
    modalSrc.includes('disabled={readOnly || locked || hasChildren}'),
    '3-4 ★AC-3.3 父节点 checkbox `disabled`（readOnly || locked || hasChildren）',
  );
  ok(
    modalSrc.includes('disabled={readOnly || hasChildren}'),
    '3-5 ★AC-3.3 父节点「完%」输入框 `disabled`（灰显当前汇总值）',
  );
  ok(
    modalSrc.includes('checked={t.selected || locked}'),
    '3-6 ★AC-3.9 不变量：`checked` 一字未动（历史父节点关联在编辑态照常勾选展示）',
  );
  ok(
    modalSrc.includes(`const PARENT_ROW_TIP = '${COPY.modalParentRowTip}';`),
    `3-7 AC-3.3 父行 Tooltip 文案逐字命中：「${COPY.modalParentRowTip}」`,
  );
  ok(
    modalSrc.includes('<Tooltip title={PARENT_ROW_TIP} arrow>') &&
      modalSrc.includes("<span style={{ display: 'inline-flex' }}>{checkbox}</span>"),
    '3-8 AC-3.3 disabled input 不触发 hover → 父行 Tooltip 用 `<span>` 包裹（布局不跳动）',
  );
  ok(
    modalSrc.includes(`const PARENT_SECTION_TIP = '${COPY.modalSectionTip}';`),
    `3-9 AC-3.3 任务关联区统一说明文案逐字命中：「${COPY.modalSectionTip}」`,
  );
  ok(
    modalSrc.includes('{!editingReport && (') && modalSrc.includes('{PARENT_SECTION_TIP}'),
    '3-10 AC-3.3 统一说明仅新建态恒显（编辑态不叠加噪音）',
  );
  ok(
    modalSrc.includes("color: hasChildren ? 'text.secondary' : undefined"),
    '3-11 AC-3.3 父节点名称视觉弱化（text.secondary，不改布局）',
  );
  /* Q3 裁定：禁用可见，不隐藏 —— 递归渲染与缩进保持原样 */
  ok(
    modalSrc.includes('{n.children && n.children.length > 0 && renderTaskTree(n.children, depth + 1)}') &&
      modalSrc.includes('sx={{ pl: depth * 2 }}'),
    '3-12 Q3 裁定：父行「禁用可见」不隐藏，层级缩进与递归渲染原样保留',
  );
  ok(
    modalSrc.includes(COPY.lockNodeTip),
    '3-13 AC-3.4 R4 锁定行文案沿用不动（叶子锁定范式不变）',
  );
  /* AC-3.9 编辑态 assemble 分支不清洗存量 */
  ok(
    modalSrc.includes('tasks: editingReport') && modalSrc.includes('? editingReport.tasks.map<ReportTaskRef>((t) => ({'),
    '3-14 ★AC-3.9 编辑态 assemble 原样回传 `editingReport.tasks`（不清洗存量父节点关联）',
  );
  ok(
    !/editingReport\.tasks[\s\S]{0,400}parentIdSet/.test(modalSrc),
    '3-15 AC-3.9 编辑态分支未混入父子过滤逻辑（存量如实展示）',
  );
  /* SK-4 硬约束：禁止散装叶子判定 */
  ok(
    !/nodeType === '(task|subtask)'/.test(modalSrc),
    '3-16 SK-4 硬约束：弹窗内无 `nodeType === task/subtask` 充当叶子判定',
  );
  ok(
    !/n\.children\.length === 0/.test(modalSrc),
    '3-17 SK-4 硬约束：弹窗内无自写 `children.length === 0` 散装判定（统一走 parentIdSet）',
  );
  /* Props 签名零破坏（设计 §3.2） */
  const propsBlock = modalSrc.slice(
    modalSrc.indexOf('export interface ReportFormModalProps'),
    modalSrc.indexOf('export function ReportFormModal'),
  );
  ['open', 'projectId', 'editingReport?', 'lockNodeId?', 'onSubmitted', 'keepOpenOnSubmit?', 'onClose'].forEach((p) => {
    ok(propsBlock.includes(`${p}:`), `3-18 Props 签名零破坏：保留 \`${p}\``);
  });
  ok(
    !propsBlock.includes('hideParent') && !propsBlock.includes('leafOnly'),
    '3-19 Props 签名零破坏：未新增开关型 prop（规则内聚在组件内部，两入口自动一致）',
  );

  /* ═══════════════════════════════════════════════════
   * 4 · R5-P0-3 源头拦截：WBS 写日志入口仅叶子可点（AC-3.1 / 3.2）
   * ═══════════════════════════════════════════════════ */
  section('4 · R5-P0-3 源头拦截：写日志入口仅叶子可点（AC-3.1/3.2）', 'WbsPage.tsx');
  eq(runDisabledReason(false, true), '', '4-1 ★AC-3.1 未归档 + 叶子 → disabledReason 为空（按钮可点）');
  eq(
    runDisabledReason(false, false),
    COPY.wbsParentLogTip,
    `4-2 ★AC-3.2 未归档 + 父节点 → disabledReason =「${COPY.wbsParentLogTip}」（禁用 + Tooltip）`,
  );
  eq(runDisabledReason(true, true), '项目已归档', '4-3 归档优先级最高：归档 + 叶子 → 「项目已归档」');
  eq(runDisabledReason(true, false), '项目已归档', '4-4 归档优先级最高：归档 + 父节点 → 「项目已归档」（不被覆盖）');
  ok(
    Boolean(runDisabledReason(false, false)),
    '4-5 AC-3.2 父节点 disabledReason 非空 → PermissionButton 自动 disabled + Tooltip（复用既有范式）',
  );
  ok(
    wbsSrc.includes('const isLeaf = node.children.length === 0;'),
    '4-6 SK-4：WbsPage 单节点渲染仍用既有 `node.children.length === 0`（未新造判定函数）',
  );
  /* 写日志按钮块结构核验 */
  const logBtnStart = wbsSrc.lastIndexOf('<PermissionButton', tipIdx);
  const logBtnBlock = wbsSrc.slice(logBtnStart, wbsSrc.indexOf('</PermissionButton>', logBtnStart));
  ok(logBtnBlock.includes('action="report:write"'), '4-7 AC-3.1 写日志按钮权限动作仍为 `report:write`（权限模型不变）');
  ok(
    !logBtnBlock.includes('disabled={'),
    '4-8 设计要求：仅用 `disabledReason` 表达（PermissionButton 内部自动 disabled，不重复加 disabled）',
  );
  ok(
    logBtnBlock.includes('setReportLockNodeId(node.id)') && logBtnBlock.includes('setReportModalOpen(true)'),
    '4-9 AC-3.1 叶子行点击仍为「页内开弹窗 + 预关联本节点」（R4 行为不变）',
  );
  ok(
    wbsSrc.includes('{canWriteLog && ('),
    '4-10 RG-10 无 `report:write` 权限 / 归档时按钮渲染条件不变（canWriteLog 未改）',
  );
  ok(
    wbsSrc.includes("const canWriteLog = can('report:write') && !archived;"),
    '4-11 RG-10 权限判定表达式一字未改',
  );
  /* Q1 裁定：禁用置灰而非不渲染 */
  ok(
    !/isLeaf && \(\s*<PermissionButton/.test(wbsSrc) && !/isLeaf &&[\s\S]{0,80}写日志/.test(wbsSrc),
    '4-12 Q1 裁定：父节点按钮「禁用置灰」而非条件不渲染（行布局不跳动）',
  );

  /* ═══════════════════════════════════════════════════
   * 5 · R5-P0-1 提交/存草稿后关窗（AC-1.1~1.7）
   * ═══════════════════════════════════════════════════ */
  section('5 · R5-P0-1 提交 / 存草稿后关窗（AC-1.1~1.7）', 'WbsPage.tsx');
  const rfmBlock = extractJsxBlock(wbsSrc, 'ReportFormModal');
  ok(rfmBlock.length > 0, '5-0 能定位 WbsPage 的 `<ReportFormModal ... />` 元素');
  ok(
    rfmBlock.includes('keepOpenOnSubmit={false}'),
    '5-1 ★AC-1.1/1.2 WbsPage 传 `keepOpenOnSubmit={false}`（提交 / 存草稿后一律关窗）',
  );
  ok(
    !/keepOpenOnSubmit(\s*\/?>|\s+[a-zA-Z])/.test(rfmBlock.replace('keepOpenOnSubmit={false}', '')),
    '5-2 AC-1.1 已无 `keepOpenOnSubmit` 简写（R4 的隐式 true 已消除）',
  );
  ok(!rfmBlock.includes('keepOpenOnSubmit={true}'), '5-3 AC-1.1 未误传 true');
  ok(
    rfmBlock.includes('lockNodeId={reportLockNodeId}'),
    '5-4 AC-1.6 lockNodeId 仍由 state 驱动（每次点击覆盖为新节点）',
  );
  ok(
    rfmBlock.includes('void fetchWbs(id, projectType)') && rfmBlock.includes('void refreshMilestones(id)'),
    '5-5 ★AC-1.4 `onSubmitted` 的 `fetchWbs + refreshMilestones` 保留不动（关窗后数据仍刷新）',
  );
  ok(
    rfmBlock.includes('onClose={() => setReportModalOpen(false)}'),
    '5-6 D-3 裁定：`onClose` 仅关窗',
  );
  ok(
    !/onClose=\{\(\) => \{[\s\S]*setReportLockNodeId\(null\)/.test(rfmBlock),
    '5-7 D-3 裁定：`onClose` 刻意不清 `reportLockNodeId`（避免淡出动画期间锁图标闪烁）',
  );
  ok(!/\bnavigate\s*\(/.test(wbsSrc), '5-8 ★AC-1.3 WbsPage 无任何 `navigate(` 调用（提交后不发生路由跳转）');
  ok(!wbsSrc.includes('useNavigate'), '5-9 AC-1.3 WbsPage 未引入 `useNavigate`');

  section('5 · R5-P0-1 doSave 关窗分支（ReportFormModal）', 'ReportFormModal.tsx');
  const doSaveStart = modalSrc.indexOf('const doSave = async');
  const doSaveSrc = modalSrc.slice(doSaveStart, modalSrc.indexOf('\n  };', doSaveStart));
  ok(doSaveStart > 0, '5-10 能定位 `doSave`');
  ok(doSaveSrc.includes('if (keepOpenOnSubmit) {'), '5-11 `keepOpenOnSubmit` 分支保留（设计 §8.3：备用能力不删）');
  ok(
    /\} else \{\s*\n\s*onClose\(\);\s*\n\s*\}/.test(doSaveSrc),
    '5-12 ★AC-1.1/1.2 `keepOpenOnSubmit` 为 false 时走 `else` 分支调用 `onClose()`（关窗）',
  );
  ok(
    doSaveSrc.indexOf('onSubmitted(saved);') < doSaveSrc.indexOf('onClose();'),
    '5-13 ★AC-1.4 关窗前先执行 `onSubmitted(saved)`（数据刷新不被关窗打断）',
  );
  ok(
    doSaveSrc.includes("toast.success('工作日志已提交');"),
    '5-14 AC-1.1 提交成功 toast 文案「工作日志已提交」不变',
  );
  ok(
    doSaveSrc.includes("toast.success('工作日志已存草稿');"),
    '5-15 AC-1.2 存草稿成功 toast 文案「工作日志已存草稿」不变（Q2 裁定：存草稿同样关窗）',
  );
  /* 存草稿与提交共用 doSave → 同走 onClose 分支（Q2） */
  ok(
    modalSrc.includes('onSubmit={handleSubmit((v) => void doSave(v, true))}') &&
      modalSrc.includes('onClick={handleSubmit((v) => void doSave(v, false))}'),
    '5-16 ★AC-1.2 「提交」与「存草稿」共用 `doSave` → 关窗行为一致（Q2 裁定）',
  );
  /* AC-1.5 失败不关窗 */
  const catchBlock = doSaveSrc.slice(doSaveSrc.indexOf('} catch (e) {'));
  ok(catchBlock.includes('toast.error(e);'), '5-17 AC-1.5 失败分支仅 `toast.error`');
  ok(!catchBlock.includes('onClose()'), '5-18 ★AC-1.5 失败分支不调 `onClose()`（弹窗不关，内容保留）');
  ok(!catchBlock.includes('onSubmitted('), '5-19 AC-1.5 失败分支不调 `onSubmitted`（不触发误刷新）');
  ok(!catchBlock.includes('reset('), '5-20 AC-1.5 失败分支不 reset 表单（内容保留，可修改后重试）');
  /* AC-1.6/1.7 连续填报：lockNodeId 由父层 state 覆盖，弹窗 open effect 依赖 open */
  ok(
    modalSrc.includes('  }, [open]);'),
    '5-21 AC-1.6/1.7 open effect 依赖 `[open]` → 每次重新打开都按最新 lockNodeId 重建 taskMap',
  );
  /* ReportsPage 入口现状不变 */
  section('5 · R5-P0-1 ReportsPage 入口回归', 'ReportsPage.tsx');
  ok(
    reportsSrc.includes('keepOpenOnSubmit={false}'),
    '5-22 RG-2 ReportsPage 入口仍传 `keepOpenOnSubmit={false}`（现状不变）',
  );

  /* ═══════════════════════════════════════════════════
   * 6 · R5-P0-2 创建下级时上级节点锁定（AC-2.1~2.8）
   * ═══════════════════════════════════════════════════ */
  section('6 · R5-P0-2 创建下级上级锁定（AC-2.1~2.8）', 'WbsPage.tsx');
  ok(
    wbsSrc.includes('const [lockParent, setLockParent] = useState<boolean>(false);'),
    '6-1 AC-2.1 新增 `lockParent` state（与 `lockMilestone` 同层同范式）',
  );
  eq(runLockParent('N1'), true, '6-2 ★AC-2.1 `openCreate(parentId)` 有 parentId → lockParent = true');
  eq(runLockParent(''), false, '6-3 ★AC-2.7 顶部「新建任务」`openCreate("")` → lockParent = false（上级可自由选）');
  eq(runLockParent(null), false, '6-4 边界：parentId = null → lockParent = false');
  eq(runLockParent(undefined), false, '6-5 边界：parentId = undefined → lockParent = false');

  const openEditStart = wbsSrc.indexOf('const openEdit = (node: WbsTreeNode)');
  const openEditSrc = wbsSrc.slice(openEditStart, wbsSrc.indexOf('\n  };', openEditStart));
  ok(openEditStart > 0, '6-6 能定位 `openEdit(node)`');
  ok(
    openEditSrc.includes('setLockParent(false);'),
    '6-7 ★AC-2.8 `openEdit` 设 `setLockParent(false)`（编辑是合法的移动节点路径，上级仍可改）',
  );
  ok(openEditSrc.includes('setLockMilestone(false);'), '6-8 AC-2.8 `openEdit` 的里程碑锁定行为不变');

  /* 上级节点 Select 三处改动 */
  const parentSelIdx = wbsSrc.indexOf(`label={lockParent ? '${COPY.parentLockLabel}' : '上级节点'}`);
  ok(parentSelIdx > 0, `6-9 ★AC-2.2 label 逐字命中：「${COPY.parentLockLabel}」/「上级节点」`);
  const parentSelBlock = wbsSrc.slice(wbsSrc.lastIndexOf('<TextField', parentSelIdx), wbsSrc.indexOf('</TextField>', parentSelIdx));
  ok(parentSelBlock.includes('disabled={lockParent}'), '6-10 ★AC-2.1 上级节点 Select `disabled={lockParent}`（不可展开下拉）');
  ok(
    parentSelBlock.includes(COPY.parentLockHelper),
    `6-11 ★AC-2.2 helperText 逐字命中统一文案表：「${COPY.parentLockHelper}」`,
  );
  ok(
    parentSelBlock.includes('根层可建任务；任务下可继续挂任务或子任务，子任务为最底层'),
    '6-12 AC-2.7 非锁定态 helperText 保持原文案（未锁定路径零变化）',
  );
  ok(
    parentSelBlock.includes('value={form.parentId}') && parentSelBlock.includes('onChange={(e) => changeParent(e.target.value)}'),
    '6-13 AC-2.3 `value` / `onChange` 原样保留（disabled 下 value 照常渲染为「编码 名称（类型）」）',
  );
  ok(
    parentSelBlock.includes('<MenuItem value="">（根节点）</MenuItem>'),
    '6-14 AC-2.7 「（根节点）」选项保留（顶部新建入口可选根层）',
  );
  ok(
    parentSelBlock.includes('{n.wbsCode} {n.name}（{WBS_NODE_TYPE_LABEL[n.nodeType]}）'),
    '6-15 AC-2.1 锁定态显示格式「wbsCode 名称（类型）」不变',
  );

  /* AC-2.4 与里程碑锁定共存 */
  ok(
    wbsSrc.includes("label={lockMilestone ? '关联里程碑（已继承上级·锁定）' : '关联里程碑（可选）'}") &&
      wbsSrc.includes('disabled={lockMilestone}') &&
      wbsSrc.includes(COPY.lockMilestoneHelper),
    '6-16 ★AC-2.4 里程碑继承锁定范式一字未动（两个锁定可同屏、文案语气一致）',
  );
  ok(
    wbsSrc.includes('setLockMilestone(Boolean(parent?.milestoneId));'),
    '6-17 AC-2.4 `openCreate` 的里程碑继承锁定逻辑不变',
  );

  /* AC-2.5 类型下拉：openCreate 收敛（D-4 防御），默认规则下行为零变化 */
  ok(
    openCreateSrc.includes('nodeType: allowedChildTypes(parent, rules)[0] ?? EMPTY_FORM.nodeType,'),
    '6-18 AC-2.5 / D-4 `openCreate` 收敛 nodeType 为 `allowedChildTypes(parent, rules)[0]`',
  );
  const taskParent = { id: 'X', nodeType: 'task', level: 1 };
  const subtaskParent = { id: 'Y', nodeType: 'subtask', level: 2 };
  eq(allowedChildTypes(null, DEFAULT_WBS_RULES)[0], 'task', '6-19 AC-2.5 根层 allowedChildTypes[0] = task（顶部新建行为零变化）');
  eq(allowedChildTypes(taskParent, DEFAULT_WBS_RULES)[0], 'task', '6-20 AC-2.5 task 父节点 allowedChildTypes[0] = task（D-4 收敛后行为零变化）');
  eq(allowedChildTypes(subtaskParent, DEFAULT_WBS_RULES).length, 0, '6-21 AC-2.5 subtask 下不可再建（allowedChildTypes 为空，与「+」禁用一致）');
  ok(
    wbsSrc.includes('const allowedTypes = useMemo(() => allowedChildTypes(formParent, rules), [formParent, rules]);'),
    '6-22 AC-2.5 类型下拉仍按 `allowedChildTypes(formParent, rules)` 动态过滤（口径不变）',
  );

  /* AC-2.6 / AC-2.8 校验链路与 changeParent 不变 */
  ok(
    wbsSrc.includes('const preErr = validateWbsPlacement('),
    '6-23 AC-2.6 `validateWbsPlacement` 前端预校验链路不变',
  );
  ok(
    wbsSrc.includes('setLockMilestone(editingId === null && Boolean(parent?.milestoneId));'),
    '6-24 AC-2.8 `changeParent` 内继承逻辑一字未改（编辑态换父仍触发继承）',
  );
  ok(
    !/const changeParent[\s\S]{0,700}setLockParent/.test(wbsSrc),
    '6-25 AC-2.8 `changeParent` 内不写 `setLockParent`（锁定仅在 openCreate/openEdit 两处赋值）',
  );
  const lockParentAssigns = (wbsSrc.match(/setLockParent\(/g) ?? []).length;
  eq(lockParentAssigns, 2, '6-26 设计 §3.2：`setLockParent` 赋值点恰好 2 处（openCreate / openEdit）');
  ok(
    !/interface NodeForm[\s\S]*?lockParent/.test(wbsSrc.slice(0, wbsSrc.indexOf('const EMPTY_FORM'))),
    '6-27 红线：`NodeForm` 未新增字段（锁定是 UI 约束，不污染表单模型）',
  );
  ok(
    wbsSrc.includes('parentId: form.parentId || null,'),
    '6-28 ★AC-2.3 提交 payload 的 `parentId` 直取 `form.parentId`（严格等于入口节点 id）',
  );

  /* ═══════════════════════════════════════════════════
   * 7 · 引擎端到端：账实一致真实链路（AC-3.5/3.6/3.7/3.10）
   * ═══════════════════════════════════════════════════ */
  section('7 · 引擎端到端 · 账实一致主链路（RG-1）', '引擎端到端');
  const api = new MockApiClient();
  resetDb();
  await api.devLogin(OPEN_IDS.xuwenbin);

  const proj = await api.createProject({
    name: 'QA-R5',
    type: 'A',
    customer: 'QA 客户',
    contractAmount: 3_000_000,
    background: 'QA 回归 R5',
    goal: ['验证第五轮 WBS 交互优化'],
    planStart: '2026-09-01',
    planEnd: '2026-09-30',
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

  const mkChild = (parentId, name, est, progress, nodeType = 'subtask') =>
    api.createWbsNode(proj.id, {
      parentId,
      nodeType,
      name,
      owner: OPEN_IDS.xuwenbin,
      estimateDays: est,
      startDate: '2026-09-01',
      dueDate: '2026-09-30',
      status: '待办',
      progress,
    });

  const pNode = await mkChild(null, 'R5 父任务', 5, 0, 'task');
  const lA = await mkChild(pNode.id, 'R5 叶A', 1, 30);
  const lB = await mkChild(pNode.id, 'R5 叶B', 1, 40);

  const beforeNodes = await api.listWbs(proj.id);
  const pBefore = beforeNodes.find((n) => n.id === pNode.id);
  eq(pBefore.progress, 35, '7-1 前置：父节点存储进度 = 叶子加权 (1*30+1*40)/2 = 35');
  eq(rollupProgressFlat(beforeNodes, pNode.id), 35, '7-2 前置：rollupProgressFlat 口径一致 = 35');
  ok(!isLeafNode(beforeNodes, pNode.id), '7-3 前置：父节点被正确识别为非叶');
  ok(isLeafNode(beforeNodes, lA.id), '7-4 前置：叶A 被正确识别为叶子');

  /* 用真实 buildNewTaskRefs 组装 payload：用户给父节点填 60、给叶A 填 90 并勾选 */
  const e2eTaskMap = {
    [pNode.id]: { progressAfter: 60, selected: true },
    [lA.id]: { progressAfter: 90, selected: true },
  };
  const e2eRefs = buildRefs(beforeNodes, e2eTaskMap);
  const e2ePRef = e2eRefs.find((r) => r.nodeId === pNode.id);
  eq(e2ePRef.selected, false, '7-5 ★AC-3.5 真实节点集：父节点 payload.selected = false');
  eq(e2ePRef.progressAfter, 35, '7-6 ★AC-3.5 真实节点集：父节点 payload.progressAfter = 提交前存储值 35');

  const saved = await api.submitReport({
    projectId: proj.id,
    week: '2026-W36',
    doneNote: 'R5 账实一致回归',
    planItems: ['继续推进'],
    resourceNote: '',
    tasks: e2eRefs,
    risks: [],
  });
  ok(Boolean(saved.id), '7-7 前置：日志提交成功');

  const afterNodes = await api.listWbs(proj.id);
  const pAfter = afterNodes.find((n) => n.id === pNode.id);
  const lAAfter = afterNodes.find((n) => n.id === lA.id);
  const lBAfter = afterNodes.find((n) => n.id === lB.id);
  eq(lAAfter.progress, 90, '7-8 叶A 进度按用户输入写入 = 90');
  eq(lBAfter.progress, 40, '7-9 叶B 未勾选，进度保持 40（幂等写入）');
  eq(pAfter.progress, 65, '7-10 ★AC-3.7 父节点进度 = 叶子加权 (1*90+1*40)/2 = 65（rollupProgressFlat 唯一来源）');
  eq(
    pAfter.progress,
    rollupProgressFlat(afterNodes, pNode.id),
    '7-11 ★AC-3.7 落库父进度 ≡ rollupProgressFlat 独立复算（口径零漂移）',
  );
  ok(pAfter.progress !== 60, '7-12 ★账实一致：父节点进度未被用户输入 60 污染');

  const savedPRow = saved.tasks.find((t) => t.nodeId === pNode.id);
  eq(savedPRow.selected, false, '7-13 ★AC-3.5 落库日志中父节点行 `selected` = false');
  eq(savedPRow.progressAfter, 35, '7-14 ★AC-3.5 落库日志中父节点行 `progressAfter` = 提交前存储值 35（非 60）');
  eq(saved.snapshot[pNode.id], 35, '7-15 ★AC-3.6 冻结快照中父节点 = 35（不再冻结用户手填的 60）');

  /* AC-3.6：日志详情只渲染 selected=true 行 → 逐行核对与 WBS 当前进度完全一致 */
  const selectedRows = saved.tasks.filter((t) => t.selected);
  eq(selectedRows.length, 1, '7-16 AC-3.6 本次日志仅 1 条 selected 行（叶A）');
  const mismatched = selectedRows.filter(
    (t) => t.progressAfter !== afterNodes.find((n) => n.id === t.nodeId)?.progress,
  );
  eq(mismatched.length, 0, '7-17 ★AC-3.6 账实一致：全部 selected 行 progressAfter ≡ WBS 当前进度（零偏差）');

  /* AC-3.10：徽标口径（selected=true）→ 父节点不再增计数 */
  const counts = reportCountByNode([saved]);
  eq(counts.get(pNode.id) ?? 0, 0, '7-18 ★AC-3.10 父节点「日志 N」徽标不再因新日志增长（selected=false）');
  eq(counts.get(lA.id) ?? 0, 1, '7-19 AC-3.10 叶A 徽标正常 +1');
  eq(nodeReportsOf([saved], pNode.id).length, 0, '7-20 ★AC-3.6 父节点日志详情列表为空（详情不再展示被丢弃的手填值）');
  eq(nodeReportsOf([saved], lA.id).length, 1, '7-21 AC-3.6 叶A 日志详情正常展示 1 条');

  /* AC-1.4：提交后 fetchWbs 拉到的树进度与引擎一致（关窗前刷新语义） */
  const treeAfter = buildTree(afterNodes);
  const pInTree = flattenTree(treeAfter).find((n) => n.id === pNode.id);
  eq(pInTree.progress, 65, '7-22 AC-1.4 关窗后 fetchWbs 重建树，父节点行进度条为最新值 65');

  /* ── 负向对照：R4 老写法 payload 会复现账实不符（证明本测试对该缺陷敏感） ── */
  section('7 · 负向对照 · R4 老写法应复现账实不符（测试敏感度自证）', '引擎端到端');
  const p2 = await mkChild(null, 'R5 父任务2', 5, 0, 'task');
  const lC = await mkChild(p2.id, 'R5 叶C', 1, 30);
  await mkChild(p2.id, 'R5 叶D', 1, 40);
  const before2 = await api.listWbs(proj.id);
  eq(before2.find((n) => n.id === p2.id).progress, 35, '7-23 对照组前置：父任务2 存储进度 = 35');

  const legacySaved = await api.submitReport({
    projectId: proj.id,
    week: '2026-W37',
    doneNote: 'R4 老写法对照',
    planItems: ['对照'],
    resourceNote: '',
    /* R4 老写法：父节点也带用户输入值且被勾选 */
    tasks: [
      { nodeId: p2.id, progressAfter: 60, selected: true },
      { nodeId: lC.id, progressAfter: 90, selected: true },
    ],
    risks: [],
  });
  const after2 = await api.listWbs(proj.id);
  const p2After = after2.find((n) => n.id === p2.id);
  const legacyPRow = legacySaved.tasks.find((t) => t.nodeId === p2.id);
  eq(p2After.progress, 65, '7-24 对照组：WBS 父任务2 进度被引擎回算为 65');
  eq(legacyPRow.progressAfter, 60, '7-25 对照组：日志详情里父任务2 仍写着 60');
  ok(
    legacyPRow.progressAfter !== p2After.progress,
    '7-26 ★敏感度自证：R4 老写法确实产生账实不符（详情 60 ≠ WBS 65）→ 本测试能检出该缺陷',
  );
  eq(
    reportCountByNode([legacySaved]).get(p2.id) ?? 0,
    1,
    '7-27 ★敏感度自证：R4 老写法会让父节点「日志 N」+1（R5 路径已为 0，见 7-18）',
  );

  /* ── AC-3.9 存量不清洗：编辑态原样回传后，历史父节点关联照常保留 ── */
  section('7 · AC-3.9 存量日志编辑不清洗（RG-3）', '引擎端到端');
  const legacyEcho = legacySaved.tasks.map((t) => ({
    nodeId: t.nodeId,
    progressAfter: t.progressAfter,
    selected: t.selected,
  }));
  const updated = await api.updateReport(legacySaved.id, {
    projectId: proj.id,
    week: legacySaved.week,
    doneNote: '编辑存量日志（不清洗）',
    planItems: ['对照'],
    resourceNote: '',
    tasks: legacyEcho,
    risks: [],
  });
  const updPRow = updated.tasks.find((t) => t.nodeId === p2.id);
  ok(Boolean(updPRow), '7-28 ★AC-3.9 编辑存量日志后，历史父节点关联行仍在（未被清洗）');
  eq(updPRow.selected, true, '7-29 ★AC-3.9 历史父节点 `selected=true` 照常保留（编辑态如实展示）');
  eq(updPRow.progressAfter, 60, '7-30 AC-3.9 历史父节点 `progressAfter` 原值 60 照常保留');
  eq(
    reportCountByNode([updated]).get(p2.id) ?? 0,
    1,
    '7-31 AC-3.10 历史计数保留（Q5 裁定：存量如实展示）',
  );

  /* ═══════════════════════════════════════════════════
   * 8 · 硬约束：引擎红线 / 改动范围
   * ═══════════════════════════════════════════════════ */
  section('8 · 硬约束 · 引擎红线与改动范围', '硬约束');
  const enginePaths = [
    ['../src/api/mock/index.ts', 'mock/index.ts'],
    ['../src/api/mock/rules.ts', 'mock/rules.ts'],
    ['../src/utils/wbs.ts', 'utils/wbs.ts'],
    ['../src/utils/reportAgg.ts', 'utils/reportAgg.ts'],
  ];
  enginePaths.forEach(([p, label]) => {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8');
    ok(!src.includes('R5-P0'), `8-1 引擎红线：\`${label}\` 无 R5 改动痕迹（本轮零引擎改动）`);
  });
  ok(
    readFileSync(new URL('../src/api/mock/index.ts', import.meta.url), 'utf8').includes(
      'node.progress = t.progressAfter;',
    ),
    '8-2 引擎红线：`upsertReport` 写路径一字未改（修复点落在 UI payload 洁净性）',
  );
  ok(
    readFileSync(new URL('../src/utils/wbs.ts', import.meta.url), 'utf8').includes(
      'export function parentIdSet(nodes: WbsNode[]): Set<string>',
    ),
    '8-3 SK-4：`parentIdSet` 仍是叶子口径唯一入口（未新增第二套实现）',
  );
  ok(
    !reportsSrc.includes('keepOpenOnSubmit={true}'),
    '8-4 设计 §8.3：全仓无 `keepOpenOnSubmit={true}`（两入口均传 false）',
  );
  ok(
    modalSrc.includes('keepOpenOnSubmit = false,'),
    '8-5 设计 §8.3：`keepOpenOnSubmit` prop 默认值 false 且分支保留（备用能力不删）',
  );

  /* ═══════════════════════════════════════════════════
   * 汇总
   * ═══════════════════════════════════════════════════ */
  section('结果');
  console.log('按文件/领域分布：');
  Object.entries(byArea).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(22)} 通过 ${String(v.pass).padStart(3)} · 失败 ${v.fail}`);
  });
  console.log(`\nQA 断言 ${pass + fail} 条 · 通过 ${pass} · 失败 ${fail}`);
  if (fail > 0) {
    console.log('失败清单：');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log(fail === 0 ? '结果：ALL PASS' : '结果：HAS FAILURE');
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  await server.close();
}
