/**
 * 方案一（极简）Mock 引擎运行时冒烟测试 · T03 验收
 *
 * 通过 Vite 的 SSR 加载器直接跑真实源码（自动解析 `@/` 别名），
 * 覆盖设计文档要求的四条链路 + 种子数据可渲染性：
 *   链路 1  五个种子项目均可渲染（列表聚合 / 里程碑聚合不炸）
 *   链路 2  新建里程碑（自由增）+ 删除（必备碑锁删 E_MS_REQUIRED_LOCKED）
 *   链路 3  质量门通过 → 挂载里程碑自动达成
 *   链路 4  零任务里程碑随日期自然「进行中」（P4 时间输入）
 * 另含：C-G4 门未过不得手工达成、SK-7 改期使人工覆盖失效、叶子口径一致性。
 *
 * 用法：node scripts/smoke_engine.mjs
 */
import { createServer } from 'vite';

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
  ok(actual === expected, label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n════ ${title} ════`);
}

/** 断言调用会抛出指定 code 的 ApiError */
async function throwsCode(fn, code, label) {
  try {
    await fn();
    ok(false, label, '未抛错');
  } catch (e) {
    ok(e?.code === code, label, `期望 ${code}，实际 ${e?.code ?? e?.message}`);
  }
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
  const { leafNodesOf } = await server.ssrLoadModule('/src/utils/wbs.ts');
  const { today, addDays } = await server.ssrLoadModule('/src/utils/date.ts');

  const api = new MockApiClient();
  resetDb();
  await api.devLogin(OPEN_IDS.xuwenbin); // PMO，权限最全

  /* ───────────────────────────────────────────────
   * 结构断言：阶段实体已彻底消失
   * ─────────────────────────────────────────────── */
  section('Q-1 阶段实体清除');
  const db0 = getDb();
  ok(!('stages' in db0), 'MockDb 无 stages 表');
  ok(db0.projects.every((p) => !('currentStageId' in p)), 'Project 无 currentStageId');
  ok(db0.milestones.every((m) => !('stageId' in m) && !('anchor' in m)), 'Milestone 无 stageId / anchor');
  ok(db0.gates.every((g) => typeof g.milestoneId === 'string' && g.milestoneId), 'QualityGate 外键改挂 milestoneId');
  ok(db0.wbsNodes.every((n) => !('lifecycleStageId' in n)), 'WbsNode 无 lifecycleStageId');
  ok(
    db0.wbsNodes.every((n) => n.nodeType === 'task' || n.nodeType === 'subtask'),
    'WbsNode 类型收敛为 task / subtask 两型',
  );
  ok(typeof api.listStages !== 'function', 'ApiClient 不再暴露 listStages');
  ok(typeof api.createMilestone === 'function', 'ApiClient 暴露 createMilestone');
  ok(typeof api.deleteMilestone === 'function', 'ApiClient 暴露 deleteMilestone');

  /* ───────────────────────────────────────────────
   * 链路 1：五个种子项目均可渲染
   * ─────────────────────────────────────────────── */
  section('链路 1 · 五个种子项目可渲染');
  const page = await api.listProjects({ page: 1, pageSize: 50 });
  eq(page.total, 5, '项目总数 = 5');
  for (const row of page.items) {
    ok(
      typeof row.gatePassed === 'number' && typeof row.gateTotal === 'number',
      `${row.code} 列表行含 已过 N/M 道门 字段（${row.gatePassed}/${row.gateTotal}）`,
    );
    ok(!('currentStageName' in row), `${row.code} 列表行不含 currentStageName`);
  }
  for (const row of page.items) {
    const list = await api.listMilestones(row.id);
    ok(list.length > 0, `${row.code} 里程碑聚合非空（${list.length} 碑）`);
    ok(
      list.every((m) => m.gate === null || m.gate.milestoneId === m.id),
      `${row.code} 门挂载自洽（SK-1 无门为 null）`,
    );
    ok(
      list.every((m) => m.taskStats && typeof m.taskStats.progress === 'number'),
      `${row.code} 每碑带 taskStats`,
    );
    ok(list.filter((m) => m.gate).length <= list.length, `${row.code} 一碑最多一门（C-G1）`);
    ok(list.every((m) => m.done === (m.status === '已达成')), `${row.code} done 与 status 恒等同步（SK-2）`);
  }

  /* 门数守恒：A=7 / B=4 / C=5 */
  section('§2.3 门数守恒');
  const byType = {};
  for (const row of page.items) byType[row.type] = (byType[row.type] ?? []).concat(row);
  const expectGate = { A: 7, B: 4, C: 5 };
  for (const [type, rows] of Object.entries(byType)) {
    for (const r of rows) {
      const list = await api.listMilestones(r.id);
      eq(list.length, expectGate[type], `${r.code}（${type} 类）里程碑数 = ${expectGate[type]}`);
      eq(list.filter((m) => m.gate).length, expectGate[type], `${r.code}（${type} 类）门数 = ${expectGate[type]}`);
    }
  }

  /* ───────────────────────────────────────────────
   * 链路 2：里程碑自由增 + 必备碑锁删
   * ─────────────────────────────────────────────── */
  section('链路 2 · 里程碑 增 / 删（Q-2）');
  const pid = 'P0012';
  const before = await api.listMilestones(pid);
  const created = await api.createMilestone(pid, {
    name: '中期客户演示',
    target: '演示环境可用并通过客户初评',
    date: addDays(today(), 20),
  });
  eq(created.required, false, '自建碑 required = false');
  eq(created.gate, null, '自建碑不带门（C-G2）');
  ok(created.taskStats.total === 0, '自建碑初始无关联任务');
  const afterCreate = await api.listMilestones(pid);
  eq(afterCreate.length, before.length + 1, '新增后里程碑数 +1');
  ok(
    afterCreate.every((m, i, arr) => i === 0 || arr[i - 1].currentDate <= m.currentDate),
    '列表按 currentDate 升序（确定性排序）',
  );

  /* ⚠ 用例已随 delta-prd-milestone-fixes P1-M13 更新（QA 严过关 2026-xx 回归）：
   * 必备碑由「引擎锁删」改为「允许删除 + 前端强化二次确认文案」，
   * 引擎侧不再抛 E_MS_REQUIRED_LOCKED（前端 catch 分支保留作真实后端兼容）。 */
  const requiredMs = before.find((m) => m.required);
  await api.deleteMilestone(requiredMs.id);
  const afterReqDel = await api.listMilestones(pid);
  eq(afterReqDel.length, before.length, 'P1-M13 必备碑可删除（引擎不再锁删）');
  ok(
    afterReqDel.every((m, i) => m.code === `M${i + 1}`),
    'P0-M1 删除必备碑后编号重排为连续 M1..Mn',
  );

  await api.deleteMilestone(created.id);
  const afterDelete = await api.listMilestones(pid);
  eq(afterDelete.length, before.length - 1, '删除自建碑后数量再 -1');

  /* 删除会解绑 WBS 而不删任务 */
  const msForUnbind = await api.createMilestone(pid, { name: '解绑验证碑', date: addDays(today(), 25) });
  const dbU = getDb();
  const victim = dbU.wbsNodes.find((n) => n.projectId === pid);
  victim.milestoneId = msForUnbind.id;
  const nodeCountBefore = dbU.wbsNodes.filter((n) => n.projectId === pid).length;
  await api.deleteMilestone(msForUnbind.id);
  const dbU2 = getDb();
  eq(dbU2.wbsNodes.filter((n) => n.projectId === pid).length, nodeCountBefore, '删碑不删任务');
  eq(dbU2.wbsNodes.find((n) => n.id === victim.id).milestoneId, null, '删碑仅解绑关联任务');

  /* ───────────────────────────────────────────────
   * 链路 3：质量门通过 → 里程碑自动达成
   * ─────────────────────────────────────────────── */
  section('链路 3 · 门通过 → 碑自动达成（§4.3）');
  const msList = await api.listMilestones(pid);
  const target = msList.find((m) => m.gate && !m.done && m.gate.status !== '已通过');
  ok(!!target, `找到待过门的里程碑「${target?.code} ${target?.name}」`);

  /* C-G4 已随「用户反馈②」取消门控：门未过也可手工标记达成（K-1 决策确认） */
  const manualAchieve = await api.updateMilestone(target.id, { achieved: true });
  eq(manualAchieve.status, '已达成', 'C-G4 门未过也可手工达成（门不再卡达成）');
  await api.updateMilestone(target.id, { achieved: false }); // 复位，交由下方门流验证

  /* 检查项未齐 → 门控结论被拒 */
  const unchecked = target.gateItems.filter((i) => !i.checked);
  if (unchecked.length) {
    await throwsCode(
      () => api.decideGate(pid, { gateId: target.gate.id, conclusion: '已通过', comment: '' }),
      'E_GATE_ITEM_INCOMPLETE',
      '检查项未齐备 → 门控结论被拒 E_GATE_ITEM_INCOMPLETE',
    );
  }
  for (const it of unchecked) await api.toggleGateItem(it.id, true);
  const afterGate = await api.decideGate(pid, {
    gateId: target.gate.id,
    conclusion: '已通过',
    comment: '冒烟测试通过',
  });
  const achieved = afterGate.find((m) => m.id === target.id);
  eq(achieved.status, '已达成', '门通过后里程碑 status = 已达成');
  eq(achieved.done, true, '门通过后 done = true');
  ok(!!achieved.doneAt, 'doneAt 已写入（真值来源 P2）');
  ok(!!achieved.doneBy, 'doneBy 已写入');
  eq(achieved.statusOverride, null, '达成动作清空人工覆盖');
  ok(afterGate.every((m) => m.done === (m.status === '已达成')), '达成后全表 done/status 仍恒等');

  /* 取消达成回落派生 */
  const reverted = await api.updateMilestone(target.id, { achieved: false });
  ok(reverted.status !== '已达成', '取消达成后 status 回落派生链');
  eq(reverted.doneAt, null, '取消达成清空 doneAt');
  await api.updateMilestone(target.id, { achieved: true }); // 门已过，可再次达成
  const reAchieved = (await api.listMilestones(pid)).find((m) => m.id === target.id);
  eq(reAchieved.status, '已达成', '门已过 → 可手工重新达成');

  /* ───────────────────────────────────────────────
   * 链路 4：零任务里程碑随日期自然「进行中」
   * ─────────────────────────────────────────────── */
  section('链路 4 · 零任务碑随日期自然进行中（P4）');
  /* 造一个「起算日已过、截止日未到、零关联任务」的碑 */
  const futureMs = await api.createMilestone(pid, { name: '零任务时间驱动碑', date: addDays(today(), 3) });
  eq(futureMs.taskStats.total, 0, '该碑零关联任务');
  eq(futureMs.taskStats.progress, 0, '该碑完成度 0%');
  eq(futureMs.status, '进行中', '起算日已过 → P4 判定「进行中」（不靠任何任务）');

  /* 逾期优先于进行中 */
  const dbO = getDb();
  const overdueMs = dbO.milestones.find((m) => m.id === futureMs.id);
  overdueMs.currentDate = addDays(today(), -2);
  overdueMs.baselineDate = overdueMs.currentDate;
  const overdueRow = (await api.listMilestones(pid)).find((m) => m.id === futureMs.id);
  eq(overdueRow.status, '已逾期', 'today > currentDate → P3 判定「已逾期」');

  /* P1 人工覆盖优先 */
  const overridden = await api.updateMilestone(futureMs.id, { statusOverride: '进行中' });
  eq(overridden.status, '进行中', 'P1 人工覆盖优先于 P3 逾期');
  eq(overridden.statusOverride, '进行中', 'statusOverride 已记录');
  ok(!!overridden.overrideBy && !!overridden.overrideAt, '覆盖三元组留痕（overrideBy / overrideAt）');
  eq(overridden.overrideBaseDate, overridden.currentDate, 'overrideBaseDate 快照当前计划日');

  /* SK-7：改期（提前）使覆盖自动失效 */
  const earlier = addDays(overridden.currentDate, -3);
  const moved = await api.updateMilestone(futureMs.id, { currentDate: earlier });
  eq(moved.statusOverride, null, 'SK-7 改期后覆盖三元组被清空');
  eq(moved.status, '已逾期', '覆盖失效后回落派生链（仍逾期）');

  /* 撤销覆盖 */
  await api.updateMilestone(futureMs.id, { statusOverride: '未开始' });
  const cancelled = await api.updateMilestone(futureMs.id, { statusOverride: null });
  eq(cancelled.statusOverride, null, '显式传 null 可撤销覆盖');

  /* 延后必须走变更单 */
  await throwsCode(
    () => api.updateMilestone(futureMs.id, { currentDate: addDays(cancelled.currentDate, 10) }),
    'E_MS_NEED_CHANGE',
    '里程碑延后 → E_MS_NEED_CHANGE（单向规则保留）',
  );
  await api.deleteMilestone(futureMs.id);

  /* ───────────────────────────────────────────────
   * 叶子口径一致性（Q-3）
   * ─────────────────────────────────────────────── */
  section('Q-3 叶子口径统一');
  const board = await api.getBoard(pid);
  const dbL = getDb();
  const leaves = leafNodesOf(dbL.wbsNodes.filter((n) => n.projectId === pid));
  const cardCount = board.columns.reduce((s, c) => s + c.cards.length, 0);
  const leavesInColumns = leaves.filter((n) => board.config.columns.includes(n.status)).length;
  eq(cardCount, leavesInColumns, '看板卡片数 = 真叶子数（不是 nodeType==="task" 数）');
  ok(
    board.columns.every((c) => c.cards.every((card) => leaves.some((l) => l.id === card.id))),
    '看板卡片全部是真叶子',
  );
  const wb = await api.getWorkbench();
  ok(
    wb.myTasks.every((t) => !dbL.wbsNodes.some((n) => n.parentId === t.id)),
    '工作台「我的任务」只含真叶子',
  );

  /* ───────────────────────────────────────────────
   * 建项链路：静默生成 碑 + 门 + per-milestone 骨架
   * ─────────────────────────────────────────────── */
  section('§4.1 建项 · 静默生成 碑/门/骨架');
  const np = await api.createProject({
    name: '冒烟测试项目',
    type: 'B',
    customer: '内部',
    contractAmount: 0,
    background: '冒烟',
    goal: ['验证建项链路'],
    planStart: today(),
    planEnd: addDays(today(), 60),
    pm: OPEN_IDS.xuwenbin,
    classifyInput: { contractAmount: 0, teamSize: 3, durationMonths: 2, hasHardware: false, customerType: '内部' },
    classifySuggested: 'B',
    classifyOverrideReason: '',
    members: [
      { userOpenId: OPEN_IDS.xuwenbin, role: 'pm' },
      { userOpenId: OPEN_IDS.wangqiang, role: 'tl' },
      { userOpenId: OPEN_IDS.sunyue, role: 'po' },
    ],
  });
  ok(!('currentStageId' in np), '新项目无 currentStageId');
  const npMs = await api.listMilestones(np.id);
  eq(npMs.length, 4, 'B 类建项生成 4 个里程碑（含 U-1 新增 M4）');
  eq(npMs.filter((m) => m.gate).length, 0, 'B 类建项不生成质量门（K-1）');
  eq(npMs.filter((m) => m.required).length, 4, '模板碑全部 required = true');
  const npNodes = getDb().wbsNodes.filter((n) => n.projectId === np.id);
  eq(npNodes.length, 4, 'per-milestone 骨架：4 个顶层任务');
  ok(npNodes.every((n) => n.nodeType === 'task'), '骨架节点均为 task 型');
  ok(npNodes.every((n) => n.parentId === null && n.level === 1), '骨架节点均在根层');
  ok(
    npNodes.every((n) => npMs.some((m) => m.id === n.milestoneId)),
    '骨架节点逐一绑定到里程碑',
  );
  eq(new Set(npNodes.map((n) => n.milestoneId)).size, 4, '骨架与里程碑一一对应');
  const npRow = (await api.listProjects({ page: 1, pageSize: 50 })).items.find((r) => r.id === np.id);
  eq(npRow.gateTotal, 0, '列表行 gateTotal = 0（不生成门）');
  eq(npRow.gatePassed, 0, '列表行 gatePassed = 0');
  ok(!!npRow.nextMilestoneCode, `列表行 nextMilestone = ${npRow.nextMilestoneCode} ${npRow.nextMilestoneName}`);
} finally {
  await server.close();
}

console.log('\n════════════════════════════════════');
console.log(`断言 ${pass + fail} 条 · 通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.log('失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  console.log('结果：FAILED');
  process.exit(1);
}
console.log('结果：ALL PASS');
