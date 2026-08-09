#!/usr/bin/env node
/**
 * QA 独立补充测试 · B4 / T01 —— WBS 骨架回填脚本 `scripts/backfill-wbs-skeleton.js`
 *
 * 工程师的 smoke_b4.mjs 只覆盖了「建项自动生成骨架」，**没有**覆盖回填脚本本身。
 * 本脚本独立验证回填脚本的幂等性与边界：
 *
 *   B1 空 WBS 表（MAX(board_order) 返回 NULL）→ board_order 应从 0 起，不应崩/不应错位
 *   B2 单里程碑项目          → 补 1 条
 *   B3 多里程碑项目          → 补 N 条，wbs_code / board_order 按序
 *   B4 部分绑定项目          → 只补缺口，已绑定的跳过；board_order 接在现有最大值之后
 *   B5 完整项目              → 一条不补
 *   B6 零里程碑项目          → 返回 0，不崩
 *   B7 **幂等**：连跑两次，节点总数不变、无重复插入
 *
 * 用法：
 *   DB_PATH=./qa_b4.db node scripts/qa_b4_t01_backfill.mjs [baseUrl]
 *   （baseUrl 指向以同一 DB_PATH 启动的服务，默认 http://127.0.0.1:3399）
 *
 * 退出码：0 = 全绿；1 = 有断言失败
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const BASE = (process.argv[2] || process.env.SMOKE_BASE || 'http://127.0.0.1:3399').replace(/\/$/, '');
const DB_FILE = process.env.DB_PATH || './qa_b4.db';

const ADMIN_OPEN_ID = 'ou_xuwenbin01';
const TL_OPEN_ID = 'ou_wangqiang02';

let passed = 0;
let failed = 0;
const failures = [];

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
    const line = label + (detail === undefined ? '' : '  → ' + JSON.stringify(detail));
    failures.push(line);
    console.log('  \u2717 ' + line);
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
  try { json = JSON.parse(text); } catch (e) { json = { __parseError: true, raw: text.slice(0, 200) }; }
  return { status: res.status, json: json };
}

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
 * 建项目（走真实建项链路，会自动生成骨架，随后由本脚本人为拆成「老项目」形态）。
 * @param {string} tag
 * @param {Array<object>} milestones
 * @returns {Promise<object>} Project
 */
async function createProject(tag, milestones) {
  const r = await call('POST', '/api/projects', {
    name: 'QA·T01回填·' + tag + ' ' + STAMP,
    type: 'A',
    customer: 'QA',
    contractAmount: 100,
    background: 'qa_b4_t01_backfill fixture',
    goal: ['回填脚本验证'],
    planStart: dayOffset(0),
    planEnd: dayOffset(200),
    pm: ADMIN_OPEN_ID,
    classifyInput: {
      contractAmount: 100, hasHardware: true, hasAcceptance: true, isSelfIteration: false, isInfrastructure: false,
    },
    classifySuggested: 'A',
    classifyOverrideReason: '',
    members: [{ userOpenId: ADMIN_OPEN_ID, role: 'pm' }, { userOpenId: TL_OPEN_ID, role: 'tl' }],
    milestones: milestones,
  });
  if (!r.json || r.json.code !== 0) {
    console.error('建项失败：', JSON.stringify(r.json));
    process.exit(1);
  }
  return r.json.data;
}

/**
 * 里程碑规格生成。
 * @param {number} n
 * @returns {Array<object>}
 */
function msSpecs(n) {
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    out.push({ code: 'M' + i, name: '碑' + i, target: '目标' + i, required: true, date: dayOffset(20 * i) });
  }
  return out;
}

/* ── 直连库（与服务同一 DB 文件，WAL 下多进程可并发） ── */

const Database = require('better-sqlite3');
const conn = new Database(path.resolve(ROOT, DB_FILE));
conn.pragma('journal_mode = WAL');

/**
 * 取项目的骨架节点（按 board_order）。
 * @param {string} projectId
 * @returns {object[]}
 */
function nodesOf(projectId) {
  return conn
    .prepare('SELECT * FROM wbs_nodes WHERE project_id = ? ORDER BY board_order, rowid')
    .all(projectId);
}

/**
 * 取项目的里程碑（与回填脚本同序：planned_date, code）。
 * @param {string} projectId
 * @returns {object[]}
 */
function milestonesOf(projectId) {
  return conn
    .prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY planned_date, code')
    .all(projectId);
}

/**
 * 执行一次回填脚本，返回 stdout。
 * @returns {string}
 */
function runBackfill() {
  return execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'backfill-wbs-skeleton.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { DB_PATH: DB_FILE }),
    encoding: 'utf8',
  });
}

/* ── 主流程 ─────────────────────────────────────────── */

/**
 * @returns {Promise<void>}
 */
async function main() {
  console.log('QA·T01 回填脚本独立测试 · base = ' + BASE + ' · db = ' + DB_FILE);

  const login = await call('POST', '/api/auth/devlogin', { openId: ADMIN_OPEN_ID });
  token = (login.json && login.json.data && login.json.data.token) || '';
  assert(!!token, '管理员登录成功');

  console.log('\n─── 铺 fixture：把新项目人为退化成「老项目」 ───');

  /* PA：3 碑 → 删光全部骨架节点（模拟 B3 时期建的老项目，wbs_nodes 该项目下为空表） */
  const pa = await createProject('PA-空表3碑', msSpecs(3));
  conn.prepare('DELETE FROM wbs_nodes WHERE project_id = ?').run(pa.id);
  assertEq(nodesOf(pa.id).length, 0, 'PA fixture：清空后 0 节点（触发 MAX(board_order) = NULL 路径）');

  /* PB：3 碑 → 只留 1 个绑定节点，并把它的 board_order 拨到 5（验证接续排序） */
  const pb = await createProject('PB-部分绑定', msSpecs(3));
  const pbMs = milestonesOf(pb.id);
  conn.prepare('DELETE FROM wbs_nodes WHERE project_id = ? AND milestone_id <> ?').run(pb.id, pbMs[0].id);
  conn.prepare('UPDATE wbs_nodes SET board_order = 5 WHERE project_id = ?').run(pb.id);
  assertEq(nodesOf(pb.id).length, 1, 'PB fixture：保留 1 个已绑定节点（board_order=5）');

  /* PC：1 碑 → 原样保留（已完整，应一条不补） */
  const pc = await createProject('PC-已完整', msSpecs(1));
  assertEq(nodesOf(pc.id).length, 1, 'PC fixture：单碑项目骨架已完整');

  /* PD：2 碑 → 删光节点 + 删光里程碑（零里程碑项目，脚本应安全返回 0） */
  const pd = await createProject('PD-零里程碑', msSpecs(2));
  conn.prepare('DELETE FROM wbs_nodes WHERE project_id = ?').run(pd.id);
  conn.prepare('DELETE FROM milestones WHERE project_id = ?').run(pd.id);
  assertEq(milestonesOf(pd.id).length, 0, 'PD fixture：里程碑已清空');

  /* ── 第 1 次回填 ── */
  console.log('\n─── 第 1 次回填 ───');
  let out = '';
  try {
    out = runBackfill();
    assert(true, '回填脚本执行成功（exit 0）');
  } catch (e) {
    assert(false, '回填脚本执行成功（exit 0）', { status: e.status, stderr: String(e.stderr || '').slice(0, 300) });
    out = String(e.stdout || '');
  }
  assert(/完成，共补插入 \d+ 条/.test(out), '脚本打印补插入总数', out.split('\n').slice(-2)[0]);

  /* B1 + B3：PA 空表 → 3 条，board_order 从 0 起 */
  const paNodes = nodesOf(pa.id);
  const paMs = milestonesOf(pa.id);
  assertEq(paNodes.length, 3, 'B1/B3 PA：补齐 3 条骨架节点');
  assertEq(
    JSON.stringify(paNodes.map((n) => n.board_order)), JSON.stringify([0, 1, 2]),
    'B1 PA：空表时 board_order 从 0 起（MAX(board_order)=NULL 不误判）',
  );
  assertEq(
    JSON.stringify(paNodes.map((n) => n.wbs_code)), JSON.stringify(['1', '2', '3']),
    'B3 PA：wbs_code 按里程碑序号 1/2/3',
  );
  assertEq(
    JSON.stringify(paNodes.map((n) => n.milestone_id).sort()),
    JSON.stringify(paMs.map((m) => m.id).sort()),
    'B3 PA：与里程碑一一对应（无重复 / 无遗漏）',
  );
  assert(paNodes.every((n) => n.level === 1 && n.parent_id === null), 'B3 PA：恒为顶层节点（level=1 / parent 为空）');
  assert(paNodes.every((n) => n.node_type === 'task'), 'B3 PA：node_type 恒为 task');
  assert(paNodes.every((n) => n.status === '待办' && n.progress === 0), 'B3 PA：status=待办 / progress=0');
  assert(paNodes.every((n) => n.is_critical === 0 && n.estimate_days === 0), 'B3 PA：is_critical=0 / estimate_days=0');
  assert(
    paNodes.every((n) => {
      const ms = paMs.filter((m) => m.id === n.milestone_id)[0];
      return ms && n.due_date === ms.planned_date;
    }),
    'B3 PA：due_date 取里程碑 planned_date',
  );
  assert(paNodes.every((n) => /回填生成/.test(String(n.description || ''))), 'B3 PA：description 标注「回填生成」');

  /* B4：PB 部分绑定 → 只补 2 条，board_order 接在 5 之后 */
  const pbNodes = nodesOf(pb.id);
  assertEq(pbNodes.length, 3, 'B4 PB：只补缺口，总数 1 + 2 = 3');
  const pbNew = pbNodes.filter((n) => n.board_order !== 5);
  assertEq(
    JSON.stringify(pbNew.map((n) => n.board_order).sort((a, b) => a - b)), JSON.stringify([6, 7]),
    'B4 PB：新节点 board_order 接续既有最大值（5 → 6/7），不与既有节点撞序',
  );
  const pbBound = pbNodes.map((n) => n.milestone_id).sort();
  assertEq(
    JSON.stringify(pbBound), JSON.stringify(milestonesOf(pb.id).map((m) => m.id).sort()),
    'B4 PB：三个里程碑各恰好 1 个绑定节点',
  );

  /* B5：PC 完整 → 不动 */
  assertEq(nodesOf(pc.id).length, 1, 'B5 PC：已完整项目一条不补');

  /* B6：PD 零里程碑 → 不崩、不插 */
  assertEq(nodesOf(pd.id).length, 0, 'B6 PD：零里程碑项目补 0 条且不报错');

  /* ── 第 2 次回填（幂等性核心断言） ── */
  console.log('\n─── 第 2 次回填（幂等性） ───');
  const snapshotBefore = conn.prepare('SELECT COUNT(*) AS n FROM wbs_nodes').get().n;
  let out2 = '';
  try {
    out2 = runBackfill();
    assert(true, '第 2 次执行成功（exit 0）');
  } catch (e) {
    assert(false, '第 2 次执行成功（exit 0）', { status: e.status, stderr: String(e.stderr || '').slice(0, 300) });
    out2 = String(e.stdout || '');
  }
  const snapshotAfter = conn.prepare('SELECT COUNT(*) AS n FROM wbs_nodes').get().n;

  assertEq(snapshotAfter, snapshotBefore, 'B7 幂等：全库 wbs_nodes 总数不变');
  assert(/完成，共补插入 0 条/.test(out2), 'B7 幂等：第 2 次补插入 0 条', out2.split('\n').filter(Boolean).slice(-1)[0]);
  assertEq(nodesOf(pa.id).length, 3, 'B7 幂等：PA 仍为 3 条（未翻倍）');
  assertEq(nodesOf(pb.id).length, 3, 'B7 幂等：PB 仍为 3 条（未翻倍）');
  assertEq(nodesOf(pc.id).length, 1, 'B7 幂等：PC 仍为 1 条');

  /* 幂等的语义保证：本脚本 fixture 项目内不存在「同一里程碑被回填出 2 个骨架节点」。
     ⚠ 作用域必须限定在 fixture 项目：一个里程碑下**允许**有多个人工创建的 WBS 任务
     （smoke_b3 就会手工建 M2 任务1/2/3），全库扫描会误报。 */
  const fixtureIds = [pa.id, pb.id, pc.id, pd.id];
  const dup = conn.prepare(`
    SELECT milestone_id, COUNT(*) AS n FROM wbs_nodes
     WHERE milestone_id IS NOT NULL AND project_id IN (?,?,?,?)
     GROUP BY milestone_id HAVING n > 1
  `).all(fixtureIds);
  assertEq(dup.length, 0, 'B7 幂等：fixture 项目内无「一个里程碑被回填出多个骨架节点」', dup.slice(0, 3));

  /* 再跑第 3 次，确认幂等是稳定性质而非一次性巧合 */
  const before3 = conn.prepare('SELECT COUNT(*) AS n FROM wbs_nodes').get().n;
  runBackfill();
  assertEq(conn.prepare('SELECT COUNT(*) AS n FROM wbs_nodes').get().n, before3, 'B7 幂等：第 3 次执行总数仍不变');

  conn.close();

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
  console.error('QA T01 回填测试异常终止：', e);
  process.exit(1);
});
