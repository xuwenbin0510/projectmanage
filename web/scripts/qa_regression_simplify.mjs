/**
 * qa_regression_simplify.mjs —— QA 独立回归（fresh-eyes，方案一·极简）
 *
 * 与工程师的 smoke_engine.mjs / verify_simplify.mjs 形成互补：
 * 工程师脚本覆盖「链路可渲染 + 门数守恒 + 主路径」，本脚本用**独立视角**
 * 专攻 7 类工程师脚本未充分覆盖的风险点，且直接跑真实源码（Vite SSR）。
 *
 * 覆盖组：
 *   G-A  叶子口径加权进度（SK-4）：非叶子 progress 不污染 rollup
 *   G-B  状态五级链（P1~P5）对真实 deriveMilestoneStatus 的单元级走查
 *   G-C  里程碑 CRUD 全分支：M{max+1} 编码、级联删门/检查项、提前可改延后拒
 *   G-D  质量门挂接：一碑一门、过门即达成、P2 优先于 P1 覆盖、重判幂等
 *   G-E  WBS 2 类型硬约束：subtask→subtask 拒(E_WBS_PARENT_TYPE)、超深拒(E_WBS_DEPTH)
 *   G-F  建项数量守恒：A=7/B=4/C=5 碑-门-骨架节点一一对应
 *   G-G  术语禁用词静态扫描：工作分区/工作包/生命周期阶段/归属阶段/阶段推进/锚点 零命中
 *
 * 运行：node scripts/qa_regression_simplify.mjs   （退出码 0 = 全通过 / IS_PASS；1 = 有失败）
 */
import { createServer } from 'vite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
function eq(actual, expected, label, detail = '') {
  ok(actual === expected, label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)} ${detail}`);
}
function section(title) {
  console.log(`\n════ ${title} ════`);
}
async function throws(fn, code, label) {
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
  const rules = await server.ssrLoadModule('/src/api/mock/rules.ts');
  const { deriveMilestoneStatus, isOverrideValid, rollupProjectProgress, validateWbsPlacement, resolveWbsRules } =
    rules;

  const api = new MockApiClient();
  resetDb();
  await api.devLogin(OPEN_IDS.xuwenbin);

  /* ───────────────────────────────────────────────
   * G-A 叶子口径加权进度（SK-4）
   * ─────────────────────────────────────────────── */
  section('G-A 叶子口径加权进度（SK-4）');
  {
    const nodes = [
      { id: 'a', parentId: null, level: 1, nodeType: 'task', progress: 100, estimateDays: 1 },
      { id: 'b', parentId: null, level: 1, nodeType: 'task', progress: 0, estimateDays: 3 },
      // 非叶子：故意把 progress 设满，验证 rollup 不会把它当权重累加
      { id: 'p', parentId: null, level: 1, nodeType: 'task', progress: 100, estimateDays: 0 },
    ];
    // 手工建立父子（p 是 a/b 的父）
    nodes[0].parentId = 'p';
    nodes[1].parentId = 'p';
    const leaves = leafNodesOf(nodes);
    eq(leaves.length, 2, '真叶子数 = 2（父节点 p 被排除）');
    eq(rollupProjectProgress(nodes), 25, 'rollup = (1×100 + 3×0)/(1+3) = 25%', `（父 p.progress=100 未污染）`);

    // 纯叶子集合直接加权：两叶子 100/0，权重 1:1 → 50%
    const flat = [
      { id: 'x', parentId: null, level: 1, nodeType: 'task', progress: 100, estimateDays: 5 },
      { id: 'y', parentId: null, level: 1, nodeType: 'task', progress: 0, estimateDays: 5 },
    ];
    eq(rollupProjectProgress(flat), 50, '同级等权 100/0 → 50%');
  }

  /* ───────────────────────────────────────────────
   * G-B 状态五级链对真实 deriveMilestoneStatus 的走查
   * ─────────────────────────────────────────────── */
  section('G-B 状态五级链（真实 deriveMilestoneStatus）');
  const T = '2026-03-01';
  const baseCtx = (over) => ({ today: T, startFrom: '2026-01-01', stats: { progress: 0, total: 0, done: 0 }, ...over });
  // P2 已达成：doneAt 非空优先
  eq(
    deriveMilestoneStatus(
      { statusOverride: null, overrideBaseDate: null, doneAt: '2026-02-01', currentDate: T },
      baseCtx(),
    ),
    '已达成',
    'P2 doneAt → 已达成',
  );
  // P3 已逾期：today > currentDate 且未达成
  eq(
    deriveMilestoneStatus(
      { statusOverride: null, overrideBaseDate: null, doneAt: null, currentDate: '2026-02-20' },
      baseCtx(),
    ),
    '已逾期',
    'P3 逾期',
  );
  // P4 进行中：today ≥ 起算日
  eq(
    deriveMilestoneStatus(
      { statusOverride: null, overrideBaseDate: null, doneAt: null, currentDate: '2026-04-01' },
      baseCtx({ startFrom: '2026-02-15' }),
    ),
    '进行中',
    'P4 已过起算日 → 进行中',
  );
  // P4 进行中：完成度 > 0 也触发
  eq(
    deriveMilestoneStatus(
      { statusOverride: null, overrideBaseDate: null, doneAt: null, currentDate: '2026-04-01' },
      baseCtx({ stats: { progress: 30, total: 1, done: 0 } }),
    ),
    '进行中',
    'P4 完成度>0 → 进行中',
  );
  // P5 未开始：today < 起算日 且 0%
  eq(
    deriveMilestoneStatus(
      { statusOverride: null, overrideBaseDate: null, doneAt: null, currentDate: '2026-04-01' },
      baseCtx({ startFrom: '2026-05-01' }),
    ),
    '未开始',
    'P5 today<起算日 → 未开始',
  );
  // P1 覆盖有效优先于 P3 逾期（overrideBaseDate 须与 currentDate 对齐才有效，见 SK-7）
  eq(
    deriveMilestoneStatus(
      { statusOverride: '进行中', overrideBaseDate: '2026-02-20', doneAt: null, currentDate: '2026-02-20' },
      baseCtx(),
    ),
    '进行中',
    'P1 覆盖有效 → 优先 P3（baseDate 对齐 currentDate）',
  );
  ok(isOverrideValid({ statusOverride: '未开始', overrideBaseDate: T, currentDate: T }), 'isOverrideValid：baseDate 对齐 → true');
  ok(
    !isOverrideValid({ statusOverride: '未开始', overrideBaseDate: '2026-02-01', currentDate: T }),
    'isOverrideValid：改期后 baseDate 错位 → false（SK-7）',
  );

  /* ───────────────────────────────────────────────
   * G-C 里程碑 CRUD 全分支
   * ─────────────────────────────────────────────── */
  section('G-C 里程碑 CRUD 全分支');
  const pid = 'P0012';
  const beforeList = await api.listMilestones(pid);
  /* ⚠ 用例已随 delta-prd-milestone-fixes P0-M1 更新（QA 严过关 2026-xx 回归）：
   * 新增碑不再简单取 M{max+1} 追加，而是全量按 currentDate 升序重排为 M1..Mn，
   * 因此插在中间的碑会拿到中间编号，其后各碑顺延（旧用例期望 M8/M9 已失效）。 */
  const c1 = await api.createMilestone(pid, { name: 'QA碑-A', date: addDays(today(), 10) });
  const afterC1 = await api.listMilestones(pid);
  eq(afterC1.length, beforeList.length + 1, '新增后碑数 +1');
  ok(
    afterC1.every((m, i) => m.code === `M${i + 1}`),
    'P0-M1 新增后编号按日期序重排为连续 M1..Mn',
    afterC1.map((m) => `${m.code}@${m.currentDate}`).join(' '),
  );
  eq(
    afterC1.find((m) => m.id === c1.id).code,
    `M${afterC1.findIndex((m) => m.id === c1.id) + 1}`,
    '新增碑编码 = 其日期序位次',
  );

  const c2 = await api.createMilestone(pid, { name: 'QA碑-B', date: addDays(today(), 12) });
  const afterC2 = await api.listMilestones(pid);
  ok(
    afterC2.every((m, i) => m.code === `M${i + 1}`),
    'P0-M1 再增一碑后编号仍连续无空号',
    afterC2.map((m) => `${m.code}@${m.currentDate}`).join(' '),
  );
  ok(
    afterC2.every((m, i, arr) => i === 0 || arr[i - 1].currentDate <= m.currentDate),
    'P0-M3 列表顺序与编号同序',
  );
  ok(c1.id !== c2.id, '两碑 id 唯一');

  // 提前可直改（不抛 E_MS_NEED_CHANGE）
  const advanced = await api.updateMilestone(c1.id, { currentDate: addDays(c1.currentDate, -2) });
  eq(advanced.currentDate, addDays(c1.currentDate, -2), '里程碑提前直改成功');
  // 延后必须走变更单
  await throws(
    () => api.updateMilestone(c1.id, { currentDate: addDays(advanced.currentDate, 10) }),
    'E_MS_NEED_CHANGE',
    '延后 → E_MS_NEED_CHANGE',
  );

  // 级联删门 + 检查项（数据层注入一个非必备碑 + 门 + 检查项，再删）
  const dbC = getDb();
  const tmplGate = dbC.gates.find((g) => g.projectId === pid);
  const tmplItems = dbC.gateItems.filter((g) => g.projectId === pid).slice(0, 2);
  const injMs = {
    id: 'MSQAX', projectId: pid, code: 'MQX', name: '级联验证碑', required: false,
    currentDate: addDays(today(), 8), baselineDate: addDays(today(), 8),
    status: '未开始', done: false, doneAt: null, statusOverride: null, overrideBaseDate: null,
    ownerRole: 'pmo', createdBy: OPEN_IDS.xuwenbin, createdAt: today(), updatedAt: today(),
  };
  const injGate = { ...tmplGate, id: 'GQAX', milestoneId: 'MSQAX', code: 'QQX', status: '待评审' };
  const injItems = tmplItems.map((it, i) => ({ ...it, id: `GIQX${i}`, gateId: 'GQAX', checked: false }));
  dbC.milestones.push(injMs);
  dbC.gates.push(injGate);
  dbC.gateItems.push(...injItems);
  eq(getDb().gates.filter((g) => g.id === 'GQAX').length, 1, '注入门成功');
  eq(getDb().gateItems.filter((i) => i.gateId === 'GQAX').length, injItems.length, '注入检查项成功');
  await api.deleteMilestone('MSQAX');
  eq(getDb().gates.filter((g) => g.id === 'GQAX').length, 0, '删碑级联删门');
  eq(getDb().gateItems.filter((i) => i.gateId === 'GQAX').length, 0, '删碑级联删检查项');

  // 清理本次新增的两碑
  await api.deleteMilestone(c1.id);
  await api.deleteMilestone(c2.id);
  const afterList = await api.listMilestones(pid);
  eq(afterList.length, beforeList.length, '清理后碑数还原');

  /* ───────────────────────────────────────────────
   * G-D 质量门挂接
   * ─────────────────────────────────────────────── */
  section('G-D 质量门挂接');
  {
    const list = await api.listMilestones(pid);
    // 一碑一门：每碑 gate 为 null 或恰好一个且 milestoneId 自洽
    ok(
      list.every((m) => m.gate === null || (m.gate.milestoneId === m.id)),
      '一碑最多一门（gate 自洽）',
    );
    const gated = list.filter((m) => m.gate);
    ok(gated.length > 0, `存在带门碑（${gated.length}）`);
    // 选一个带门且未达成的碑
    const target = gated.find((m) => !m.done && m.gate.status !== '已通过');
    ok(!!target, `找到待过门碑「${target?.code}」`);
    // C-G4 已随「用户反馈②」取消门控：门未过也可手工达成（K-1 决策确认），随即复位交门流验证
    const manual = await api.updateMilestone(target.id, { achieved: true });
    eq(manual.status, '已达成', 'C-G4 门未过也可手工达成（门不再卡达成）');
    await api.updateMilestone(target.id, { achieved: false });
    // 检查项未齐 → 门控拒
    const unchecked = target.gateItems.filter((i) => !i.checked);
    if (unchecked.length) {
      await throws(
        () => api.decideGate(pid, { gateId: target.gate.id, conclusion: '已通过', comment: '' }),
        'E_GATE_ITEM_INCOMPLETE',
        '检查项未齐 → E_GATE_ITEM_INCOMPLETE',
      );
    }
    for (const it of unchecked) await api.toggleGateItem(it.id, true);
    const res = await api.decideGate(pid, { gateId: target.gate.id, conclusion: '已通过', comment: 'QA' });
    const ach = res.find((m) => m.id === target.id);
    eq(ach.status, '已达成', '过门 → 自动达成（P2 写入 doneAt）');
    ok(!!ach.doneAt, 'doneAt 已写入');
    eq(ach.statusOverride, null, '达成动作清空人工覆盖（P2 > P1 不冲突）');
    // 重判幂等：已过的门再 decide 仍保持达成
    const res2 = await api.decideGate(pid, { gateId: target.gate.id, conclusion: '已通过', comment: 'QA重判' });
    const ach2 = res2.find((m) => m.id === target.id);
    eq(ach2.status, '已达成', '已过门重判幂等（仍 已达成）');
    // 取消达成回落派生
    const reverted = await api.updateMilestone(target.id, { achieved: false });
    eq(reverted.doneAt, null, '取消达成清空 doneAt');
  }

  /* ───────────────────────────────────────────────
   * G-E WBS 2 类型硬约束（fresh-eyes 关键缺口）
   * ─────────────────────────────────────────────── */
  section('G-E WBS 2 类型硬约束');
  {
    const wbsP = await api.createProject({
      name: 'QA-WBS 约束项目',
      type: 'B',
      customer: '内部',
      contractAmount: 0,
      background: 'WBS 约束验证',
      goal: ['验证 E_WBS_PARENT_TYPE / E_WBS_DEPTH'],
      planStart: today(),
      planEnd: addDays(today(), 40),
      pm: OPEN_IDS.xuwenbin,
      classifyInput: { contractAmount: 0, teamSize: 2, durationMonths: 1, hasHardware: false, customerType: '内部' },
      classifySuggested: 'B',
      classifyOverrideReason: '',
      members: [
        { userOpenId: OPEN_IDS.xuwenbin, role: 'pm' },
        { userOpenId: OPEN_IDS.wangqiang, role: 'tl' },
        { userOpenId: OPEN_IDS.sunyue, role: 'po' },
      ],
    });
    const wpid = wbsP.id;
    const owner = OPEN_IDS.xuwenbin;
    // 1) subtask 下不可挂 subtask → E_WBS_PARENT_TYPE
    const t1 = await api.createWbsNode(wpid, { nodeType: 'task', name: '父任务', owner, estimateDays: 1 });
    const s1 = await api.createWbsNode(wpid, { parentId: t1.id, nodeType: 'subtask', name: '子任务', owner, estimateDays: 1 });
    await throws(
      () => api.createWbsNode(wpid, { parentId: s1.id, nodeType: 'subtask', name: '孙任务(应拒)', owner, estimateDays: 1 }),
      'E_WBS_PARENT_TYPE',
      'subtask 下挂 subtask → E_WBS_PARENT_TYPE',
    );
    // task 下挂 subtask 是被允许的（正面用例）
    ok(true, 'task→subtask 合法（已成功创建 s1）');
    // 2) 超深（>4 级）→ E_WBS_DEPTH：构造 task→task→task→task→task
    let parent = t1;
    const chain = [t1];
    for (let i = 0; i < 3; i++) {
      const n = await api.createWbsNode(wpid, { parentId: parent.id, nodeType: 'task', name: `链${i}`, owner, estimateDays: 1 });
      chain.push(n);
      parent = n;
    }
    // 此时链已 5 个节点（t1 L1 + 3 新建 = 4 级），再建第 5 级应拒
    await throws(
      () => api.createWbsNode(wpid, { parentId: parent.id, nodeType: 'task', name: '第5级(应拒)', owner, estimateDays: 1 }),
      'E_WBS_DEPTH',
      '深度超过 4 → E_WBS_DEPTH',
    );
  }

  /* ───────────────────────────────────────────────
   * G-F 建项数量守恒（A / C 类补齐）
   * ─────────────────────────────────────────────── */
  section('G-F 建项数量守恒（A / C 类）');
  for (const type of ['A', 'C']) {
    const np = await api.createProject({
      name: `QA-${type} 类建项`,
      type,
      customer: '内部',
      contractAmount: 0,
      background: `${type} 类数量守恒`,
      goal: ['验证碑/门/骨架数量'],
      planStart: today(),
      planEnd: addDays(today(), 60),
      pm: OPEN_IDS.xuwenbin,
      classifyInput: { contractAmount: 0, teamSize: 3, durationMonths: 2, hasHardware: false, customerType: '内部' },
      classifySuggested: type,
      classifyOverrideReason: '',
      members: [
        { userOpenId: OPEN_IDS.xuwenbin, role: 'pm' },
        { userOpenId: OPEN_IDS.wangqiang, role: 'tl' },
        { userOpenId: OPEN_IDS.sunyue, role: 'po' },
      ],
    });
    const ms = await api.listMilestones(np.id);
    const expect = type === 'A' ? 7 : 5;
    eq(ms.length, expect, `${type} 类碑数 = ${expect}`);
    eq(ms.filter((m) => m.gate).length, 0, `${type} 类建项不生成质量门（K-1）`);
    eq(ms.filter((m) => m.required).length, expect, `${type} 类模板碑全部 required`);
    const nodes = getDb().wbsNodes.filter((n) => n.projectId === np.id);
    eq(nodes.length, expect, `${type} 类骨架节点数 = ${expect}（per-milestone）`);
    ok(nodes.every((n) => n.milestoneId && ms.some((m) => m.id === n.milestoneId)), `${type} 类骨架与碑一一绑定`);
  }

  /* ───────────────────────────────────────────────
   * G-G 术语禁用词静态扫描
   * ─────────────────────────────────────────────── */
  section('G-G 术语禁用词扫描');
  {
    const FORBIDDEN = ['工作分区', '工作包', '生命周期阶段', '归属阶段', '阶段推进', '锚点'];
    const SRC = resolve(process.cwd(), 'src');
    const hits = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.(ts|tsx|vue|js|jsx)$/.test(p)) {
          const text = readFileSync(p, 'utf8');
          for (const term of FORBIDDEN) {
            if (text.includes(term)) hits.push(`${p}:「${term}」`);
          }
        }
      }
    };
    walk(SRC);
    eq(hits.length, 0, '术语禁用词零命中', hits.length ? `\n    ${hits.join('\n    ')}` : '');
  }
} finally {
  await server.close();
}

console.log('\n════════════════════════════════════');
console.log(`QA 断言 ${pass + fail} 条 · 通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.log('失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  console.log('结果：FAILED');
  process.exit(1);
}
console.log('结果：ALL PASS（IS_PASS）');
process.exit(0);
