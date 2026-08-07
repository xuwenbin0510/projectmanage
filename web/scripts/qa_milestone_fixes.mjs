/**
 * QA 回归脚本 · 里程碑模块 4 项用户反馈修复（delta-design-milestone-fixes v1.0）
 *
 * 通过 Vite 的 SSR 加载器直接跑**真实源码**（自动解析 `@/` 别名），
 * 不抄录、不 mock 业务逻辑，断言全部打在生产代码路径上。
 *
 * 覆盖：
 *   §1 纯函数 fitMilestoneDatesEx        —— 设计 §3.1.3 S1~S6 + 索引对齐 + 幂等
 *   §2 纯函数 compareMilestones          —— F-3 / F-4 三级 tie-break + 不依赖 code
 *   §3 纯函数 milestoneTaskDetail        —— 口径 Y（P0-M8 / P0-M9 / P0-M10）
 *   §4 剧本 A  清空缓存 · 压缩 + 重排      —— P0-M4 / P0-M1 触发点⑤
 *   §5 剧本 B  存量脏数据自愈（F-2）       —— P0-M2 读路径幂等 + 真实 sessionStorage 重载
 *   §6 剧本 C  插入 / 改期 / 删除重排      —— P0-M1 触发点①②③
 *   §7 剧本 D  两段式提交（F-5 / P0-M7）   —— 含「合并提交会丢文本」的反例证明
 *   §8 剧本 E  计数与钻取同源（SK-M5）
 *   §9 剧本 F  极端周期不阻断（P1-M12）
 *   §10 变更单回写重排（P0-M1 触发点④）
 *
 * 用法：node scripts/qa_milestone_fixes.mjs   （退出码 0 = 全通过，1 = 有失败）
 */

/* ═══════════ 0. sessionStorage 垫片（用于剧本 B 的真实「刷新」模拟）═══════════ */
class MemoryStorage {
  #m = new Map();
  getItem(k) {
    return this.#m.has(k) ? this.#m.get(k) : null;
  }
  setItem(k, v) {
    this.#m.set(k, String(v));
  }
  removeItem(k) {
    this.#m.delete(k);
  }
  clear() {
    this.#m.clear();
  }
}
globalThis.sessionStorage = new MemoryStorage();

import { createServer } from 'vite';

/* ═══════════ 1. 断言框架 ═══════════ */
let pass = 0;
const failures = [];

function ok(cond, label, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push({ label, detail });
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
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
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`,
  );
}
function section(t) {
  console.log(`\n════════ ${t} ════════`);
}
async function throwsCode(fn, code, label) {
  try {
    await fn();
    ok(false, label, '未抛错');
    return null;
  } catch (e) {
    ok(e?.code === code, label, `期望 ${code}，实际 ${e?.code ?? e?.message}`);
    return e;
  }
}

/* 里程碑列表 → "M1@2026-03-01" 形式，便于一眼核对编号与日期同序 */
const brief = (list) => list.map((m) => `${m.code}@${m.currentDate}`);

async function newServer() {
  return createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
    // SSR 直读源码，不需要依赖预构建；关掉可避免写/删 node_modules/.vite/deps_temp_*
    optimizeDeps: { noDiscovery: true, include: [] },
  });
}

const server = await newServer();
let server2 = null;

try {
  const { MockApiClient } = await server.ssrLoadModule('/src/api/mock/index.ts');
  const { getDb, resetDb, saveDb } = await server.ssrLoadModule('/src/api/mock/db.ts');
  const { OPEN_IDS } = await server.ssrLoadModule('/src/api/mock/fixtures/users.ts');
  const { fitMilestoneDatesEx, fitMilestoneDates } = await server.ssrLoadModule('/src/utils/date.ts');
  const { compareMilestones, sortMilestones } = await server.ssrLoadModule('/src/api/mock/rules.ts');
  const { milestoneTaskDetail, milestoneTaskStats, milestoneTaskNodes } =
    await server.ssrLoadModule('/src/utils/wbs.ts');

  /* ══════════════════════════════════════════════════════════════
   * §1 fitMilestoneDatesEx —— 设计 §3.1.3 六组验收样例
   * ══════════════════════════════════════════════════════════════ */
  section('§1 fitMilestoneDatesEx（P0-M4 / SK-M7）');
  const A_OFFSETS = [0, 30, 70, 125, 170, 210, 232];

  const s1 = fitMilestoneDatesEx('2026-03-01', '2026-03-31', A_OFFSETS);
  deepEq(
    s1.dates,
    ['2026-03-01', '2026-03-05', '2026-03-10', '2026-03-17', '2026-03-23', '2026-03-28', '2026-03-31'],
    'S1 30 天周期等比压缩逐字命中 PRD P0-M4',
  );
  eq(s1.compressed, true, 'S1 compressed=true');
  eq(s1.stacked, false, 'S1 stacked=false');
  ok(Math.abs(s1.ratio - 30 / 232) < 1e-9, `S1 ratio≈0.1293（实际 ${s1.ratio.toFixed(5)}）`);
  eq(s1.planDays, 30, 'S1 planDays=30');
  eq(s1.templateSpan, 232, 'S1 templateSpan=232');
  eq(s1.dates[6], '2026-03-31', 'S1 规则4：末碑恰好 = planEnd');
  ok(s1.dates.every((d) => d <= '2026-03-31'), 'S1 无任何碑晚于 planEnd');

  const s2 = fitMilestoneDatesEx('2026-03-01', '2026-12-31', A_OFFSETS);
  deepEq(
    s2.dates,
    ['2026-03-01', '2026-03-31', '2026-05-10', '2026-07-04', '2026-08-18', '2026-09-27', '2026-10-19'],
    'S2 周期足够时不压缩，保持模板绝对节奏',
  );
  eq(s2.compressed, false, 'S2 compressed=false');
  eq(s2.ratio, 1, 'S2 ratio=1');

  const s3 = fitMilestoneDatesEx('2026-03-01', '2026-03-07', A_OFFSETS);
  deepEq(
    s3.dates,
    ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07'],
    'S3 planDays(6)===碑数-1，恰好逐日错开',
  );
  eq(s3.stacked, false, 'S3 stacked=false（刚好够错开）');

  const s4 = fitMilestoneDatesEx('2026-03-01', '2026-03-03', A_OFFSETS);
  deepEq(
    s4.dates,
    ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-03', '2026-03-03', '2026-03-03', '2026-03-03'],
    'S4 极端周期封顶堆叠，不越界',
  );
  eq(s4.stacked, true, 'S4 stacked=true → 触发 P1-M12 非阻塞告警');

  const s5 = fitMilestoneDatesEx('2026-03-01', '2026-03-01', A_OFFSETS);
  ok(s5.dates.every((d) => d === '2026-03-01'), 'S5 零周期全部落 planStart');
  eq(s5.stacked, true, 'S5 stacked=true');

  const s6 = fitMilestoneDatesEx('2026-03-01', '2026-03-31', [0, 0, 0]);
  ok(s6.dates.every((d) => d === '2026-03-01'), 'S6 全零 offset 全部落 planStart');
  eq(s6.templateSpan, 0, 'S6 templateSpan=0');
  eq(s6.stacked, true, 'S6 stacked=true');

  /* 边界补强：空数组 / 负周期 / 非法数字 —— 永不抛异常（SK-M7） */
  const sEmpty = fitMilestoneDatesEx('2026-03-01', '2026-03-31', []);
  deepEq(sEmpty.dates, [], 'B1 空 offsets 降级返回空数组');
  const sNeg = fitMilestoneDatesEx('2026-03-31', '2026-03-01', A_OFFSETS);
  eq(sNeg.planDays, 0, 'B2 负周期按 0 处理，不抛异常');
  ok(sNeg.dates.every((d) => d === '2026-03-31'), 'B2 负周期全部落 planStart');
  const sNaN = fitMilestoneDatesEx('2026-03-01', '2026-03-31', [0, Number.NaN, 232]);
  eq(sNaN.dates.length, 3, 'B3 NaN offset 不炸（视作 0）');
  eq(sNaN.dates[1], '2026-03-02', 'B3 NaN→0 但非首碑保底至 planStart+1（规则2）');

  /* 索引对齐：乱序 offsets 返回值必须与入参同索引 */
  const shuffled = [232, 0, 125, 30, 210, 70, 170];
  const sShuf = fitMilestoneDatesEx('2026-03-01', '2026-03-31', shuffled);
  const sSorted = fitMilestoneDatesEx('2026-03-01', '2026-03-31', A_OFFSETS);
  const mapById = Object.fromEntries(A_OFFSETS.map((o, i) => [o, sSorted.dates[i]]));
  deepEq(
    sShuf.dates,
    shuffled.map((o) => mapById[o]),
    'B4 乱序 offsets 返回值与入参同索引对齐，不错位',
  );

  /* 幂等 / 纯函数 */
  deepEq(
    fitMilestoneDates('2026-03-01', '2026-03-31', A_OFFSETS),
    s1.dates,
    'B5 fitMilestoneDates 薄封装与 Ex 结果一致',
  );
  deepEq(
    fitMilestoneDatesEx('2026-03-01', '2026-03-31', A_OFFSETS).dates,
    s1.dates,
    'B6 连续两次调用结果完全相同（无内部状态）',
  );
  const inputCopy = [...A_OFFSETS];
  fitMilestoneDatesEx('2026-03-01', '2026-03-31', inputCopy);
  deepEq(inputCopy, A_OFFSETS, 'B7 不修改入参数组（纯函数）');

  /* ══════════════════════════════════════════════════════════════
   * §2 compareMilestones —— F-3 / F-4
   * ══════════════════════════════════════════════════════════════ */
  section('§2 compareMilestones（SK-M1 / F-3 / F-4）');
  const mk = (id, currentDate, createdAt, code) => ({ id, currentDate, createdAt, code });

  ok(
    compareMilestones(mk('a', '2026-03-01', 'T1'), mk('b', '2026-03-05', 'T1')) < 0,
    'C1 currentDate 为主序',
  );
  ok(
    compareMilestones(mk('a', '2026-03-01', 'T1'), mk('b', '2026-03-01', 'T2')) < 0,
    'C2 同日按 createdAt 升序（先建在前）',
  );
  /* F-4：createProject 同批里程碑 createdAt 完全相同，必须靠 id 终结 */
  ok(
    compareMilestones(mk('P1-MS2', '2026-03-01', 'T1'), mk('P1-MS10', '2026-03-01', 'T1')) < 0,
    'C3 F-4 同日同 createdAt → id numeric 序：P1-MS2 排在 P1-MS10 之前',
  );
  /* F-3：比较结果绝不受 code 影响 */
  const x1 = mk('P1-MS1', '2026-03-10', 'T1', 'M9');
  const y1 = mk('P1-MS2', '2026-03-20', 'T1', 'M1');
  ok(
    compareMilestones(x1, y1) < 0,
    'C4 F-3 脏 code（M9 vs M1）不影响比较结果，无 sort→code→sort 循环依赖',
  );
  /* 排序稳定 / 幂等 / 不改原数组 */
  const rnd = [
    mk('P1-MS3', '2026-03-20', 'T1', 'M9'),
    mk('P1-MS1', '2026-03-01', 'T1', 'M3'),
    mk('P1-MS10', '2026-03-10', 'T1', 'M1'),
    mk('P1-MS2', '2026-03-10', 'T1', 'M7'),
  ];
  const snapshot = rnd.map((m) => m.id);
  const sorted1 = sortMilestones(rnd);
  deepEq(
    sorted1.map((m) => m.id),
    ['P1-MS1', 'P1-MS2', 'P1-MS10', 'P1-MS3'],
    'C5 sortMilestones 结果符合三级键（含 numeric id）',
  );
  deepEq(rnd.map((m) => m.id), snapshot, 'C6 sortMilestones 不改原数组（纯函数）');
  deepEq(
    sortMilestones(sorted1).map((m) => m.id),
    sorted1.map((m) => m.id),
    'C7 排序幂等：对已排序集合再排序结果不变',
  );

  /* ══════════════════════════════════════════════════════════════
   * §3 milestoneTaskDetail —— 口径 Y
   * ══════════════════════════════════════════════════════════════ */
  section('§3 milestoneTaskDetail 口径 Y（P0-M8 / P0-M10 / SK-M4）');
  const node = (o) => ({
    id: o.id,
    projectId: 'P',
    parentId: o.parentId ?? null,
    wbsCode: o.wbsCode,
    level: o.wbsCode.split('.').length,
    nodeType: o.parentId ? 'subtask' : 'task',
    name: o.id,
    estimateDays: o.est ?? 0,
    progress: o.prog ?? 0,
    milestoneId: o.ms ?? null,
  });

  /* 场景：骨架 task（est=0, prog=0）绑 MS1，尚未拆分 */
  const unsplit = [node({ id: 'W1', wbsCode: '1', ms: 'MS1' })];
  const dUnsplit = milestoneTaskDetail(unsplit, 'MS1');
  eq(dUnsplit.nodes.length, 1, 'Y1 骨架未拆分 total=1（数字只增不减）');
  eq(dUnsplit.leaves.length, 1, 'Y1 骨架自身即叶子');
  eq(dUnsplit.rollupIds.size, 0, 'Y1 无汇总节点');

  /* 拆出 4 个子任务，各 est=2，其中 2 个 100% */
  const split = [
    node({ id: 'W1', wbsCode: '1', ms: 'MS1' }),
    node({ id: 'W1.1', parentId: 'W1', wbsCode: '1.1', est: 2, prog: 100 }),
    node({ id: 'W1.2', parentId: 'W1', wbsCode: '1.2', est: 2, prog: 100 }),
    node({ id: 'W1.3', parentId: 'W1', wbsCode: '1.3', est: 2, prog: 0 }),
    node({ id: 'W1.10', parentId: 'W1', wbsCode: '1.10', est: 2, prog: 0 }),
    /* 干扰项：不属于 MS1 的另一棵树 */
    node({ id: 'W2', wbsCode: '2', ms: 'MS2' }),
    node({ id: 'W2.1', parentId: 'W2', wbsCode: '2.1', est: 5, prog: 100 }),
  ];
  const dSplit = milestoneTaskDetail(split, 'MS1');
  eq(dSplit.nodes.length, 5, 'Y2 拆分后 total=5（骨架不蒸发，口径 Y 关键）');
  eq(dSplit.leaves.length, 4, 'Y2 leaves=4（仅真叶子）');
  eq(dSplit.rollupIds.size, 1, 'Y2 rollupIds=1（骨架为汇总节点）');
  ok(dSplit.rollupIds.has('W1'), 'Y2 汇总节点正是骨架 W1');
  deepEq(
    dSplit.nodes.map((n) => n.wbsCode),
    ['1', '1.1', '1.2', '1.3', '1.10'],
    'Y3 按 wbsCode 自然序（1 在 1.1 前，1.2 在 1.10 前）',
  );
  const stSplit = milestoneTaskStats(split, 'MS1');
  eq(stSplit.total, 5, 'Y4 stats.total=5');
  eq(stSplit.done, 2, 'Y4 stats.done=2');
  eq(stSplit.progress, 50, 'Y4 stats.progress=50（0 工时骨架未参与加权、未被稀释）');
  ok(
    milestoneTaskStats(split, 'MS1').progress !== 40,
    'Y5 反例校验：若误把骨架计入加权则为 40，当前非 40 → 加权口径正确',
  );
  eq(milestoneTaskNodes(split, 'MS1').length, 5, 'Y6 milestoneTaskNodes 为 detail.nodes 薄封装');

  /* 父子同时绑同一碑 → Map 去重不重复计数 */
  const bothBound = [
    node({ id: 'W1', wbsCode: '1', ms: 'MS1' }),
    node({ id: 'W1.1', parentId: 'W1', wbsCode: '1.1', est: 2, prog: 0, ms: 'MS1' }),
  ];
  eq(milestoneTaskDetail(bothBound, 'MS1').nodes.length, 2, 'Y7 父子同绑一碑不重复计数（id 去重）');

  /* 多层：task → subtask → 孙层，只收真叶子 */
  const deep = [
    node({ id: 'W1', wbsCode: '1', ms: 'MS1' }),
    node({ id: 'W1.1', parentId: 'W1', wbsCode: '1.1' }),
    node({ id: 'W1.1.1', parentId: 'W1.1', wbsCode: '1.1.1', est: 3, prog: 100 }),
    node({ id: 'W1.1.2', parentId: 'W1.1', wbsCode: '1.1.2', est: 1, prog: 0 }),
  ];
  const dDeep = milestoneTaskDetail(deep, 'MS1');
  deepEq(
    dDeep.nodes.map((n) => n.id),
    ['W1', 'W1.1.1', 'W1.1.2'],
    'Y8 多层子树只并入真叶子（中间层 W1.1 不入集）',
  );
  eq(dDeep.leaves.length, 2, 'Y8 leaves=2');
  eq(milestoneTaskStats(deep, 'MS1').progress, 75, 'Y8 加权 = (3×100+1×0)/4 = 75');
  eq(milestoneTaskDetail(split, 'NOT_EXIST').nodes.length, 0, 'Y9 不存在的碑返回空集合');

  /* ══════════════════════════════════════════════════════════════
   * §4 剧本 A —— 清空缓存 · 压缩 + 重排
   * ══════════════════════════════════════════════════════════════ */
  section('§4 剧本 A · 清空缓存（压缩 + 重排）');
  const api = new MockApiClient();
  resetDb();
  await api.devLogin(OPEN_IDS.xuwenbin);

  const mkPayload = (name, planStart, planEnd) => ({
    name,
    type: 'A',
    customer: 'QA 客户',
    contractAmount: 3_000_000,
    background: 'QA 回归',
    goal: ['验证里程碑压缩与重排'],
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
    /* 不传 milestones → 走引擎 templateSpecs 兜底分支（验证引擎侧压缩） */
  });

  const projA = await api.createProject(mkPayload('QA-剧本A', '2026-03-01', '2026-03-31'));
  const listA = await api.listMilestones(projA.id);
  eq(listA.length, 7, 'A1 A 类模板生成 7 个里程碑');
  deepEq(
    listA.map((m) => m.currentDate),
    ['2026-03-01', '2026-03-05', '2026-03-10', '2026-03-17', '2026-03-23', '2026-03-28', '2026-03-31'],
    'A2 引擎侧日期 = 等比压缩结果（与向导同源 SK-M7）',
  );
  deepEq(
    listA.map((m) => m.code),
    ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'],
    'A3 编号 M1..M7 连续',
  );
  ok(
    listA.every((m, i, a) => i === 0 || a[i - 1].currentDate <= m.currentDate),
    'A4 列表顺序与日期同序',
  );
  ok(listA.every((m) => m.currentDate <= projA.planEnd), 'A5 无任何碑晚于 planEnd');
  ok(
    listA.every((m) => m.baselineDate === m.currentDate),
    'A6 创建即基线：baselineDate === currentDate === 压缩后日期',
  );
  /* 骨架 description 内嵌的 code 必须是重排后的（renumber 早于骨架生成） */
  const dbA = getDb();
  const skeletons = dbA.wbsNodes.filter((n) => n.projectId === projA.id && n.parentId === null);
  eq(skeletons.length, 7, 'A7 生成 7 个 per-milestone 骨架节点');
  const codeInDescOk = skeletons.every((n) => {
    const ms = dbA.milestones.find((m) => m.id === n.milestoneId);
    return ms && n.description.includes(`${ms.code} ${ms.name}`);
  });
  ok(codeInDescOk, 'A8 骨架 description 内嵌 code 与重排后编号一致（renumber 早于骨架生成）');

  /* 向导传 milestones（用户改过日期）时，走 specList 分支也要重排 */
  const wizardPayload = mkPayload('QA-向导改期', '2026-03-01', '2026-03-31');
  wizardPayload.milestones = [
    { code: 'M1', name: '项目立项', target: '', date: '2026-03-20', required: true, gate: null },
    { code: 'M2', name: '需求确认', target: '', date: '2026-03-02', required: true, gate: null },
    { code: 'M3', name: '结项', target: '', date: '2026-03-10', required: true, gate: null },
  ];
  const projW = await api.createProject(wizardPayload);
  const listW = await api.listMilestones(projW.id);
  deepEq(
    brief(listW),
    ['M1@2026-03-02', 'M2@2026-03-10', 'M3@2026-03-20'],
    'A9 向导 specList 分支：乱序日期在创建后即被重排为连续且同序',
  );

  /* ══════════════════════════════════════════════════════════════
   * §5 剧本 B —— 存量脏数据自愈（F-2 / P0-M2）★最关键
   * ══════════════════════════════════════════════════════════════ */
  section('§5 剧本 B · 不清缓存 · 存量脏 code 自愈（F-2）');
  const dbB = getDb();
  const dirtyTargets = dbB.milestones.filter((m) => m.projectId === projA.id);
  dirtyTargets[2].code = 'M9';
  dirtyTargets[5].code = 'M9';
  dirtyTargets[0].code = 'XX';
  saveDb();
  ok(true, `B0 已注入脏 code：${dirtyTargets.map((m) => m.code).join(',')}`);

  const healed = await api.listMilestones(projA.id);
  deepEq(
    healed.map((m) => m.code),
    ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'],
    'B1 读路径幂等自愈：脏 code 自动修复为连续编号',
  );
  ok(!healed.some((m) => m.code === 'M9'), 'B2 不再出现 M9');

  /* 连刷 10 次不抖动 */
  let stable = true;
  let lastSnap = healed.map((m) => `${m.id}:${m.code}`).join('|');
  for (let i = 0; i < 10; i += 1) {
    const again = await api.listMilestones(projA.id);
    const snap = again.map((m) => `${m.id}:${m.code}`).join('|');
    if (snap !== lastSnap) stable = false;
    lastSnap = snap;
  }
  ok(stable, 'B3 连续刷新 10 次编号稳定不抖动（幂等性）');

  /* 真实「刷新页面」：脏数据落 sessionStorage → 全新模块实例重新 load */
  const dbB2 = getDb();
  dbB2.milestones.filter((m) => m.projectId === projA.id)[4].code = 'M42';
  saveDb();
  server2 = await newServer();
  const { MockApiClient: MockApiClient2 } = await server2.ssrLoadModule('/src/api/mock/index.ts');
  const api2 = new MockApiClient2();
  await api2.devLogin(OPEN_IDS.xuwenbin);
  const afterReload = await api2.listMilestones(projA.id);
  eq(afterReload.length, 7, 'B4 新模块实例从 sessionStorage 成功还原项目（真实刷新）');
  deepEq(
    afterReload.map((m) => m.code),
    ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'],
    'B5 真实刷新后 M42 被自愈为连续编号（F-2 端到端）',
  );

  /* ══════════════════════════════════════════════════════════════
   * §6 剧本 C —— 插入 / 改期 / 删除（P0-M1 / F-1）
   * ══════════════════════════════════════════════════════════════ */
  section('§6 剧本 C · 插入 / 改期 / 删除 重排（F-1）');
  const inserted = await api.createMilestone(projA.id, {
    name: 'QA 插入碑',
    target: '插入后应为 M4',
    date: '2026-03-13',
  });
  const listC1 = await api.listMilestones(projA.id);
  eq(listC1.length, 8, 'C1 插入后共 8 碑');
  eq(listC1.find((m) => m.id === inserted.id).code, 'M4', 'C2 03-13 新碑编号为 M4（不是 M8/M9）');
  deepEq(
    listC1.map((m) => m.code),
    ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'],
    'C3 编号连续，不出现 M9',
  );
  ok(
    listC1.every((m, i, a) => i === 0 || a[i - 1].currentDate <= m.currentDate),
    'C4 列表顺序与日期同序',
  );

  /* 末碑（M8@03-31）提前到 03-02 → 应立即变 M2（F-1 主因验证） */
  const lastMs = listC1[listC1.length - 1];
  eq(lastMs.currentDate, '2026-03-31', 'C5 末碑当前为 03-31');
  await api.updateMilestone(lastMs.id, { currentDate: '2026-03-02' });
  const listC2 = await api.listMilestones(projA.id);
  eq(
    listC2.find((m) => m.id === lastMs.id).code,
    'M2',
    'C6 F-1 改期提前后编号立即重排为 M2（不再「M8 排在 M2 上面」）',
  );
  deepEq(
    brief(listC2),
    [
      'M1@2026-03-01',
      'M2@2026-03-02',
      'M3@2026-03-05',
      'M4@2026-03-10',
      'M5@2026-03-13',
      'M6@2026-03-17',
      'M7@2026-03-23',
      'M8@2026-03-28',
    ],
    'C7 列表顺序与编号完全同步',
  );

  /* 删除必备碑 M2（此时 M2 恰为 required 的模板碑） */
  const target2 = listC2.find((m) => m.code === 'M2');
  eq(target2.required, true, 'C8 待删的 M2 是模板必备碑');
  const nodesBoundBefore = getDb().wbsNodes.filter((n) => n.milestoneId === target2.id).length;
  const wbsCountBefore = getDb().wbsNodes.filter((n) => n.projectId === projA.id).length;
  await api.deleteMilestone(target2.id);
  const listC3 = await api.listMilestones(projA.id);
  eq(listC3.length, 7, 'C9 必备碑删除成功（引擎不再锁删）');
  deepEq(
    listC3.map((m) => m.code),
    ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'],
    'C10 删除后剩余碑重排为连续 M1..M7，无空号',
  );
  eq(
    getDb().wbsNodes.filter((n) => n.projectId === projA.id).length,
    wbsCountBefore,
    'C11 删碑不删任务（WBS 节点数不变）',
  );
  ok(nodesBoundBefore > 0, `C12 删除前该碑绑定 ${nodesBoundBefore} 个 WBS 节点`);
  eq(
    getDb().wbsNodes.filter((n) => n.milestoneId === target2.id).length,
    0,
    'C13 关联 WBS 节点已解绑（milestoneId=null）',
  );

  /* ══════════════════════════════════════════════════════════════
   * §7 剧本 D —— 两段式提交（P0-M7 / F-5）
   * ══════════════════════════════════════════════════════════════ */
  section('§7 剧本 D · 编辑两段式提交（F-5 / SK-M6）');
  const listD0 = await api.listMilestones(projA.id);
  const editMs = listD0[3];
  const laterDate = '2026-06-30';

  /* ---- 反例证明：合并提交会丢掉文本修改（F-5 根因）---- */
  await throwsCode(
    () =>
      api.updateMilestone(editMs.id, {
        name: '合并提交名称',
        target: '合并提交目标',
        currentDate: laterDate,
      }),
    'E_MS_NEED_CHANGE',
    'D1 合并提交（name+target+延后日期）被 E_MS_NEED_CHANGE 拦截',
  );
  const afterCombined = (await api.listMilestones(projA.id)).find((m) => m.id === editMs.id);
  ok(
    afterCombined.name !== '合并提交名称' && afterCombined.target !== '合并提交目标',
    'D2 ★反例成立：合并提交时文本修改全部丢失 → 两段式是功能正确性前提，不可省',
  );

  /* ---- 正例：前端两段式（MilestonesPage.handleEditSubmit 的等价调用序列）---- */
  await api.updateMilestone(editMs.id, { name: '两段式新名称', target: '两段式新目标' });
  const err = await throwsCode(
    () => api.updateMilestone(editMs.id, { currentDate: laterDate }),
    'E_MS_NEED_CHANGE',
    'D3 段2 日期延后被拦截并抛 E_MS_NEED_CHANGE',
  );
  ok(Boolean(err?.data?.changeDraft), 'D4 异常携带 changeDraft（供前端弹变更单引导）');
  eq(err?.data?.changeDraft?.changeType, 'milestone_date', 'D5 changeDraft.changeType 正确');
  eq(err?.data?.changeDraft?.payload?.toDate, laterDate, 'D6 changeDraft 预填目标日期');

  const afterTwoPhase = (await api.listMilestones(projA.id)).find((m) => m.id === editMs.id);
  eq(afterTwoPhase.name, '两段式新名称', 'D7 重开编辑框：名称为新值（段1 已落库）');
  eq(afterTwoPhase.target, '两段式新目标', 'D8 重开编辑框：目标为新值');
  eq(afterTwoPhase.currentDate, editMs.currentDate, 'D9 重开编辑框：日期为旧值（段2 被拦截）');

  /* ---- 只提前日期一次成功且立即重排 ---- */
  const beforeEarly = await api.listMilestones(projA.id);
  const mover = beforeEarly.find((m) => m.code === 'M5');
  await api.updateMilestone(mover.id, { currentDate: '2026-03-01' });
  const afterEarly = await api.listMilestones(projA.id);
  const movedCode = afterEarly.find((m) => m.id === mover.id).code;
  ok(['M1', 'M2'].includes(movedCode), `D10 仅提前日期一次成功且立即重排（M5 → ${movedCode}）`);
  ok(
    afterEarly.every((m, i, a) => i === 0 || a[i - 1].currentDate <= m.currentDate),
    'D11 提前后列表顺序仍与日期同序',
  );
  deepEq(
    afterEarly.map((m) => m.code),
    afterEarly.map((_, i) => `M${i + 1}`),
    'D12 提前后编号仍连续',
  );

  /* 仅改 name/target 不影响日期与编号 */
  const codesBeforeText = (await api.listMilestones(projA.id)).map((m) => m.code).join(',');
  await api.updateMilestone(afterEarly[0].id, { name: '仅改名称' });
  const codesAfterText = (await api.listMilestones(projA.id)).map((m) => m.code).join(',');
  eq(codesAfterText, codesBeforeText, 'D13 仅改文本不触发日期分支，编号不变');

  /* ══════════════════════════════════════════════════════════════
   * §8 剧本 E —— 计数与钻取同源（P0-M8/M9/M10 / SK-M5）
   * ══════════════════════════════════════════════════════════════ */
  section('§8 剧本 E · 计数与钻取严格同源');
  const listE0 = await api.listMilestones(projA.id);
  const dbE = getDb();
  const anchor = dbE.wbsNodes.find((n) => n.projectId === projA.id && n.milestoneId);
  const anchorMsId = anchor.milestoneId;
  const msE0 = listE0.find((m) => m.id === anchorMsId);
  eq(msE0.taskStats.total, 1, 'E1 骨架未拆分时 total=1');

  /* 直接向 db 挂 4 个子任务（绕开与本次改动无关的 WBS 校验器，聚合链路仍走真实引擎） */
  const nowTs = new Date().toISOString().slice(0, 19);
  [1, 2, 3, 4].forEach((i) => {
    dbE.wbsNodes.push({
      id: `${projA.id}-QA-SUB${i}`,
      projectId: projA.id,
      parentId: anchor.id,
      wbsCode: `${anchor.wbsCode}.${i}`,
      level: 2,
      nodeType: 'subtask',
      name: `QA 子任务 ${i}`,
      description: '',
      owner: OPEN_IDS.xuwenbin,
      ownerName: 'QA',
      estimateDays: 2,
      actualDays: 0,
      startDate: '2026-03-01',
      dueDate: '2026-03-05',
      status: i <= 2 ? '已完成' : '待办',
      progress: i <= 2 ? 100 : 0,
      boardOrder: i,
      isCritical: false,
      milestoneId: null,
      createdAt: nowTs,
      updatedAt: nowTs,
    });
  });
  saveDb();

  const listE1 = await api.listMilestones(projA.id);
  const msE1 = listE1.find((m) => m.id === anchorMsId);
  eq(msE1.taskStats.total, 5, 'E2 拆出 4 子任务后列表显示 x/5（口径 Y，骨架不蒸发）');
  eq(msE1.taskStats.done, 2, 'E3 done=2');
  eq(msE1.taskStats.progress, 50, 'E4 progress=50%（0 工时骨架未参与加权）');

  /* 前端钻取：同一函数 + 同一数据源（listWbs） */
  const wbsForDrill = await api.listWbs(projA.id);
  const drillDetail = milestoneTaskDetail(wbsForDrill, anchorMsId);
  eq(drillDetail.nodes.length, msE1.taskStats.total, 'E5 ★弹窗条目数 === 列表 total（SK-M5 铁律）');
  eq(drillDetail.rollupIds.size, 1, 'E6 骨架带「汇总」Chip（rollupIds=1）');
  ok(drillDetail.rollupIds.has(anchor.id), 'E7 汇总节点正是骨架 task');
  eq(drillDetail.leaves.length, 4, 'E8 4 条子任务为叶子（渲染工时）');
  deepEq(
    drillDetail.nodes.map((n) => n.level),
    [1, 2, 2, 2, 2],
    'E9 层级用于缩进：骨架 level=1，子任务 level=2',
  );
  /* 全项目所有碑逐一核对同源 */
  const allSame = listE1.every(
    (m) => milestoneTaskDetail(wbsForDrill, m.id).nodes.length === m.taskStats.total,
  );
  ok(allSame, 'E10 项目内全部里程碑「钻取条目数 === 列表 total」逐一核对通过');

  /* ══════════════════════════════════════════════════════════════
   * §9 剧本 F —— 极端周期（P1-M12 / W13）
   * ══════════════════════════════════════════════════════════════ */
  section('§9 剧本 F · 极端周期不阻断');
  const fitF = fitMilestoneDatesEx('2026-03-01', '2026-03-03', A_OFFSETS);
  eq(fitF.stacked, true, 'F1 stacked=true → 向导展示黄色堆叠告警');
  const projF = await api.createProject(mkPayload('QA-剧本F', '2026-03-01', '2026-03-03'));
  ok(Boolean(projF?.id), 'F2 极端周期仍能成功创建项目（不阻断）');
  const listF = await api.listMilestones(projF.id);
  eq(listF.length, 7, 'F3 仍生成 7 碑');
  eq(listF[listF.length - 1].currentDate, '2026-03-03', 'F4 末碑 = planEnd = 03-03');
  ok(listF.every((m) => m.currentDate <= '2026-03-03'), 'F5 无碑越界');
  ok(
    new Set(listF.map((m) => m.currentDate)).size < listF.length,
    'F6 允许同日堆叠（周期过短的预期降级）',
  );
  deepEq(
    listF.map((m) => m.code),
    ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'],
    'F7 同日堆叠下编号仍连续（三级 tie-break 生效）',
  );
  /* 同日堆叠时编号必须稳定 —— 这是 F-4 id tie-break 的真实压力场景 */
  const codesF1 = (await api.listMilestones(projF.id)).map((m) => `${m.id}:${m.code}`).join('|');
  const codesF2 = (await api.listMilestones(projF.id)).map((m) => `${m.id}:${m.code}`).join('|');
  eq(codesF2, codesF1, 'F8 同日堆叠场景连续读取编号不抖动（F-4 兜底生效）');

  /* ══════════════════════════════════════════════════════════════
   * §10 变更单回写重排（P0-M1 触发点④）
   * ══════════════════════════════════════════════════════════════ */
  section('§10 变更单审批回写后重排（触发点④）');
  const listG0 = await api.listMilestones(projA.id);
  const gTarget = listG0[1];
  const gToDate = '2026-05-20';
  let changeVerified = false;
  try {
    const change = await api.createChange({
      projectId: projA.id,
      changeType: 'milestone_date',
      title: `${gTarget.code} ${gTarget.name} 日期调整`,
      targetType: 'milestone',
      targetId: gTarget.id,
      payload: { fromDate: gTarget.currentDate, toDate: gToDate },
      reason: 'QA 回归',
      impact: '无',
    });
    const db2 = getDb();
    const raw = db2.changes.find((c) => c.id === change.id);
    raw.status = '已批准';
    saveDb();
    await api.applyChange(change.id);
    const listG1 = await api.listMilestones(projA.id);
    const moved = listG1.find((m) => m.id === gTarget.id);
    eq(moved.currentDate, gToDate, 'G1 变更实施后日期回写成功');
    eq(moved.code, `M${listG1.length}`, 'G2 回写后重排：该碑成为末位编号');
    deepEq(
      listG1.map((m) => m.code),
      listG1.map((_, i) => `M${i + 1}`),
      'G3 回写后编号连续',
    );
    ok(
      listG1.every((m, i, a) => i === 0 || a[i - 1].currentDate <= m.currentDate),
      'G4 回写后列表顺序与日期同序',
    );
    ok(moved.baselineDate !== moved.currentDate, 'G5 基线日期保持不变（单向规则基石）');
    changeVerified = true;
  } catch (e) {
    ok(false, 'G0 变更单链路执行失败', `${e?.code ?? ''} ${e?.message ?? e}`);
  }
  if (changeVerified) ok(true, 'G6 P0-M1 六个 renumber 触发点全部经运行时验证');
} catch (e) {
  console.error('\n脚本执行异常：', e);
  failures.push({ label: '脚本执行异常', detail: String(e?.stack ?? e) });
} finally {
  await server.close();
  if (server2) await server2.close();
}

/* ═══════════ 汇总 ═══════════ */
console.log(`\n${'═'.repeat(64)}`);
console.log(`  通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('\n  失败明细：');
  for (const f of failures) console.log(`   ✗ ${f.label}${f.detail ? `\n     ${f.detail}` : ''}`);
}
console.log(`${'═'.repeat(64)}\n`);
process.exit(failures.length ? 1 : 0);
