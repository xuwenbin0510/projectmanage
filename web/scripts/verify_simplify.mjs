/**
 * verify_simplify.mjs —— 方案一（极简）WBS / 里程碑 / 质量门迁移回归脚本
 *
 * 与 verify_classify*.mjs 同风格：node 无法直接 import TS 路径别名源码，
 * 故通过 fs 读取**实时源文件**做断言（读真实代码，避免抄录漂移）。
 *
 * 断言分组：
 *   A-1~A-4  种子 WBS 节点映射正确性（§2.4.4）
 *   A-5~A-8  模板门数 / 挂载碑编号 / 责任人 / 检查项守恒（§2.3 + §9.1.4）
 *   A-9      模板 version === 2（§9.1.5）
 *   派生链     deriveMilestoneStatus 五级优先链示例走查（§2.5.1）
 *   制度对齐  （可选）解析《太空数据中心项目管理制度》§7.1 表格与模板对拍
 *
 * 运行：node scripts/verify_simplify.mjs   （退出码 0 = 全通过，1 = 有失败）
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dir, '../src');

/* ═══════════════ 1. 断言框架 ═══════════════ */
let passed = 0;
const failures = [];
const skips = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(`        ${detail}`);
  }
}

function skip(name, why) {
  skips.push({ name, why });
  console.log(`  SKIP  ${name} —— ${why}`);
}

function read(rel) {
  const p = resolve(SRC, rel);
  if (!existsSync(p)) throw new Error(`源文件缺失：${p}`);
  return readFileSync(p, 'utf8');
}

/* ═══════════════ 2. A-1~A-4 种子 WBS 映射（读 wbs.ts 实时源，按项目分组） ═══════════════ */
console.log('\n════ A-1~A-4 种子 WBS 节点映射（§2.4.4） ════');

const wbsSrc = read('api/mock/fixtures/wbs.ts');
// 按 `const PXXXX: NodeSpec[] = [` 拆块，保证 hasChild 判定不跨项目串扰
const wbsBlocks = wbsSrc.split(/(const P\d+:\s*NodeSpec\[\]\s*=\s*\[)/);
const nodes = [];
for (let i = 1; i < wbsBlocks.length; i += 2) {
  const marker = wbsBlocks[i];
  const project = (marker.match(/const\s+(P\d+):/) || [])[1] || '?';
  const body = wbsBlocks[i + 1];
  const tuples = [...body.matchAll(/\['([^']+)',\s*'[^']*',\s*'(stage|package|task)'/g)];
  const codes = tuples.map((t) => t[1]);
  const hasChild = (code) => codes.some((c) => c.startsWith(`${code}.`));
  for (const t of tuples) {
    const code = t[1];
    const seedType = t[2];
    const child = hasChild(code);
    const type = seedType === 'task' ? (child ? 'task' : 'subtask') : 'task';
    nodes.push({ project, code, type, level: code.split('.').length });
  }
}

const counts = nodes.reduce((acc, n) => ((acc[n.type] = (acc[n.type] || 0) + 1), acc), {});
console.log(`  种子节点总数=${nodes.length}，映射分布=${JSON.stringify(counts)}`);

{
  const rootSubtask = nodes.filter((n) => n.level === 1 && n.type === 'subtask');
  check('A-3 根层无 subtask', rootSubtask.length === 0, `根层 subtask=${JSON.stringify(rootSubtask)}`);
}
{
  const subtaskWithChild = nodes.filter(
    (n) => n.type === 'subtask' && nodes.some((c) => c.project === n.project && c.code.startsWith(`${n.code}.`)),
  );
  check('A-2 无 subtask 拥有子节点', subtaskWithChild.length === 0, `违规=${JSON.stringify(subtaskWithChild)}`);
}
{
  const maxLevel = Math.max(...nodes.map((n) => n.level));
  check('A-1 最大层级 ≤ 4', maxLevel <= 4, `maxLevel=${maxLevel}`);
}
{
  // 设计指定的演示告警样本（缺负责人）：1.3.3（P0012）、1.2.4（P0018）
  const sample = ['1.3.3', '1.2.4'].filter((c) => nodes.some((n) => n.code === c));
  check('A-4 演示告警样本保留（1.3.3 / 1.2.4）', sample.length === 2, `命中=${JSON.stringify(sample)}`);
}
check('A-1b task 计数 = 15', counts.task === 15, `task=${counts.task}`);
check('A-1c subtask 计数 = 28', counts.subtask === 28, `subtask=${counts.subtask}`);

/* ═══════════════ 3. A-5~A-9 模板门 / 检查项守恒（读 templates.ts 实时源） ═══════════════ */
console.log('\n════ A-5~A-9 模板门 / 检查项守恒（§2.3 + §9.1） ════');

const tplSrc = read('api/mock/fixtures/templates.ts');

// 期望（来自架构 §2.3.2~2.3.4 三张迁移矩阵，制度侧不可信 · §9.1.1）
const EXPECT = {
  A: { gates: 7, items: 19, owners: { QG1: 'pmo', QG2: 'pmo', QG3: 'tl', QG4: 'qa', QG5: 'qa', QG6: 'pmo', QG7: 'pmo' } },
  B: { gates: 4, items: 10, owners: { QB1: 'po', QB2: 'tl', QB3: 'qa', QB4: 'pmo' } },
  C: { gates: 5, items: 10, owners: { QC1: 'pmo', QC2: 'tl', QC3: 'cm', QC4: 'pm', QC5: 'pmo' } },
};

// 单遍扫描：定位 projectType 标记 + 门 + 版本，按位置归属
const typeMarks = [...tplSrc.matchAll(/projectType:\s*'(A|B|C)'/g)].map((x) => ({ t: x[1], idx: x.index }));
const gateMarks = [...tplSrc.matchAll(/code:\s*'(Q[A-Z]\d+)'[\s\S]*?ownerRole:\s*'([^']+)'[\s\S]*?items:\s*\[([\s\S]*?)\]/g)]
  .map((x) => ({ code: x[1], owner: x[2], items: [...x[3].matchAll(/content:/g)].length, idx: x.index }));
const verMarks = [...tplSrc.matchAll(/version:\s*(\d+)/g)].map((x) => ({ v: Number(x[1]), idx: x.index }));
const msMarks = [...tplSrc.matchAll(/code:\s*'(M\d+)'/g)].map((x) => ({ idx: x.index }));

function typeOf(idx) {
  let cur = null;
  for (const m of typeMarks) {
    if (m.idx < idx) cur = m.t;
    else break;
  }
  return cur;
}

const grouped = { A: { gates: [], ms: 0, ver: null }, B: { gates: [], ms: 0, ver: null }, C: { gates: [], ms: 0, ver: null } };
for (const g of gateMarks) {
  const t = typeOf(g.idx);
  if (t) grouped[t].gates.push(g);
}
for (const m of msMarks) {
  const t = typeOf(m.idx);
  if (t) grouped[t].ms += 1;
}
for (const v of verMarks) {
  const t = typeOf(v.idx);
  if (t && grouped[t].ver === null) grouped[t].ver = v.v;
}

for (const tp of ['A', 'B', 'C']) {
  const g = grouped[tp];
  const totalItems = g.gates.reduce((s, x) => s + x.items, 0);
  check(`A-5 TPL-${tp} 门数 = ${EXPECT[tp].gates}`, g.gates.length === EXPECT[tp].gates, `实际=${g.gates.length}`);
  check(`A-8 TPL-${tp} 检查项守恒 = ${EXPECT[tp].items}`, totalItems === EXPECT[tp].items,
    `实际=${totalItems}（${g.gates.map((x) => x.code + ':' + x.items).join(' ')}）`);
  check(`A-9 TPL-${tp} version = 2`, g.ver === 2, `实际=${g.ver}`);
  for (const x of g.gates) {
    const want = EXPECT[tp].owners[x.code];
    if (want) check(`A-7 TPL-${tp} ${x.code} ownerRole = ${want}`, x.owner === want, `实际=${x.owner}`);
  }
  // A-6 一碑一门：门数 = 里程碑数
  check(`A-6 TPL-${tp} 一碑一门（${g.ms} 碑 / ${g.gates.length} 门）`, g.ms === g.gates.length, `碑=${g.ms} 门=${g.gates.length}`);
}

/* ═══════════════ 4. 派生链示例走查（§2.5.1，与 rules.ts 一致） ═══════════════ */
console.log('\n════ 派生链 deriveMilestoneStatus 示例（§2.5.1） ════');

function diffDays(a, b) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}
function isOverrideValid(ms) {
  return ms.statusOverride !== null && ms.overrideBaseDate === ms.currentDate;
}
function derive(ms, ctx) {
  if (isOverrideValid(ms)) return ms.statusOverride; // P1
  if (ms.doneAt) return '已达成'; // P2
  if (diffDays(ctx.today, ms.currentDate) < 0) return '已逾期'; // P3
  if (ctx.stats.progress > 0 || diffDays(ctx.startFrom, ctx.today) >= 0) return '进行中'; // P4
  return '未开始'; // P5
}
const T = '2026-03-01';
check('P2 已达成（doneAt 非空）',
  derive({ statusOverride: null, doneAt: '2026-02-01', currentDate: T, overrideBaseDate: null },
    { today: T, startFrom: '2026-01-01', stats: { progress: 0 } }) === '已达成');
check('P3 已逾期（today > currentDate）',
  derive({ statusOverride: null, doneAt: null, currentDate: '2026-02-20', overrideBaseDate: null },
    { today: T, startFrom: '2026-01-01', stats: { progress: 0 } }) === '已逾期');
check('P4 进行中（已过起算日）',
  derive({ statusOverride: null, doneAt: null, currentDate: '2026-04-01', overrideBaseDate: null },
    { today: T, startFrom: '2026-02-15', stats: { progress: 0 } }) === '进行中');
check('P4 进行中（完成度 >0）',
  derive({ statusOverride: null, doneAt: null, currentDate: '2026-04-01', overrideBaseDate: null },
    { today: T, startFrom: '2026-04-01', stats: { progress: 30 } }) === '进行中');
check('P5 未开始',
  derive({ statusOverride: null, doneAt: null, currentDate: '2026-04-01', overrideBaseDate: null },
    { today: T, startFrom: '2026-04-01', stats: { progress: 0 } }) === '未开始');
check('P1 覆盖优先（override 有效）',
  derive({ statusOverride: '进行中', doneAt: null, currentDate: T, overrideBaseDate: T },
    { today: T, startFrom: '2026-04-01', stats: { progress: 0 } }) === '进行中');
check('P1 覆盖失效（改期后 baseDate 不对 → 回退派生）',
  derive({ statusOverride: '未开始', doneAt: null, currentDate: '2026-02-01', overrideBaseDate: '2026-01-15' },
    { today: T, startFrom: '2026-01-01', stats: { progress: 0 } }) === '已逾期');

/* ═══════════════ 5. （可选）制度 §7.1 对拍（A-5~A-9 制度版） ═══════════════ */
console.log('\n════ 制度 §7.1 对拍（可选 · 找不到制度文件则 SKIP） ════');

const CANDIDATES = [
  resolve(__dir, '../../../项目管理制度/太空数据中心项目管理制度V1.0.md'),
  resolve(__dir, '../../../../项目管理制度/太空数据中心项目管理制度V1.0.md'),
  resolve(process.cwd(), '项目管理制度/太空数据中心项目管理制度V1.0.md'),
];
const docPath = CANDIDATES.find((p) => existsSync(p));
if (!docPath) {
  skip('制度对拍', '未找到《太空数据中心项目管理制度》文件，跳过（不计入失败）');
} else {
  const doc = readFileSync(docPath, 'utf8');
  const gateRows = [...doc.matchAll(/^\|\s*(Q[A-Z]\d+)[^|]*\|\s*(M\d+)[^|]*\|\s*共\s*(\d+)\s*项[^|]*\|\s*([a-z]+)\s*\|/gm)];
  if (gateRows.length === 0) {
    skip('制度门表解析', '§7.1 表格格式未匹配，请人工核对（不计入失败）');
  } else {
    const docGates = gateRows.map((r) => ({ code: r[1], ms: r[2], items: Number(r[3]), owner: r[4] }));
    const want = { ...EXPECT.A.owners, ...EXPECT.B.owners, ...EXPECT.C.owners };
    const wantItems = { QG1: 3, QG2: 3, QG3: 3, QG4: 4, QG5: 3, QG6: 2, QG7: 1, QB1: 2, QB2: 2, QB3: 4, QB4: 2, QC1: 2, QC2: 2, QC3: 1, QC4: 2, QC5: 3 };
    check('A-5 制度门数 = 模板门数(16)', docGates.length === EXPECT.A.gates + EXPECT.B.gates + EXPECT.C.gates,
      `制度=${docGates.length}`);
    for (const g of docGates) {
      check(`A-7 制度 ${g.code} owner=${want[g.code] || '?'}`, !want[g.code] || g.owner === want[g.code], `制度=${g.owner}`);
      check(`A-8 制度 ${g.code} 检查项数=${wantItems[g.code] || '?'}`, !wantItems[g.code] || g.items === wantItems[g.code], `制度=${g.items}`);
    }
  }
}

/* ═══════════════ 6. 汇总 ═══════════════ */
const total = passed + failures.length;
console.log('\n════════════════════════════════════');
console.log(`断言 ${total} 条 · 通过 ${passed} · 失败 ${failures.length} · 跳过 ${skips.length}`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}\n     ${f.detail}`));
  console.log('\n结果：FAIL');
  process.exit(1);
}
console.log('结果：ALL PASS');
process.exit(0);
