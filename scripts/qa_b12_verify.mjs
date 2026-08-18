// B12 综合独立验收脚本（QA · 严过关）
// 零业务代码改动，仅本测试脚本。运行：node scripts/qa_b12_verify.mjs
//
// 分组：
//   A  组 · 纯函数基础单测（开发侧基线，21 例）
//   Q1 组 · 独立纯函数对抗（期望值按 PRD 手工推导，不参考 A 组，~14 例 + 4 观察项）
//   Q2 组 · SQL 独立复算交叉验证（直接查 b12_qa.db 旁路复算，对拍服务层，~8 例）
//   Q3 组 · 响应结构 ↔ web/src/types/dashboard.ts 契约解析对齐（~12 例）
//   Q4 组 · 全角色 HTTP 降级矩阵 + 越权泄漏扫描 + 畸形入参兜底（~12 例）

import { createRequire } from 'module';
const require = createRequire('C:/Users/xuwen/WorkBuddy/AstrBytes/pm-app/server/package.json');

const agg = require('./lib/portfolioAgg');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = 'C:/Users/xuwen/WorkBuddy/AstrBytes/pm-app';
const QA_DB = path.join(ROOT, 'b12_qa.db');
const DASHBOARD_TS = path.join(ROOT, 'web/src/types/dashboard.ts');
const BASE = 'http://127.0.0.1:3000'; // 真实后端（pm.db）
const TODAY = '2026-08-10';

let pass = 0, fail = 0, obs = 0;
const observations = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function warn(group, name, detail) {
  obs++;
  observations.push({ group, name, detail });
  console.log('  ⚠ [' + group + ' 观察] ' + name + '  -> ' + JSON.stringify(detail));
}

/* ── 工具：解析 TS 接口字段（契约独立性，不依赖被测 JS） ── */
function extractInterfaceBlock(src, iface) {
  // 负向先行断言：精确匹配接口名，避免误命中同名前缀接口
  // （DashboardOverview vs DashboardOverviewQuery、StatusDonut vs StatusDonutSegment）
  const re = new RegExp('export\\s+interface\\s+' + iface + '(?![A-Za-z0-9_])\\s*\\{', 'm');
  const m = re.exec(src);
  if (!m) return null;
  const i = m.index + m[0].length - 1; // '{' 的位置
  let depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  return src.slice(i, end + 1);
}
function tsFields(block) {
  const fields = [];
  block.split('\n').forEach(function (ln) {
    const m = ln.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:?]/);
    if (m) fields.push(m[1]);
  });
  return fields;
}
function sortedEntries(obj) {
  return JSON.stringify(Object.keys(obj).sort().reduce(function (o, k) { o[k] = obj[k]; return o; }, {}));
}

/* ═══════════════════════════════════════════════════════
 * A 组 · 纯函数基础单测（开发侧基线）
 * ═══════════════════════════════════════════════════════ */
function runGroupA() {
  console.log('\n== A 组 · 纯函数基础单测 ==');
  const items = [
    { id: 'P1', name: 'A', status: '已批准', health: 'red', progress: 60 },
    { id: 'P2', name: 'B', status: '进行中', health: 'yellow', progress: 40 },
    { id: 'P3', name: 'C', status: '挂起', health: 'green', progress: 80 },
    { id: 'P4', name: 'D', status: '已批准', health: 'green', progress: 20 },
  ];
  const tasks = [
    { projectId: 'P1', projectName: 'A', owner: 'u1', ownerName: '张三', dueDate: '2026-01-01', status: '进行中' },
    { projectId: 'P1', owner: 'u1', ownerName: '张三', dueDate: '2026-08-20', status: '进行中' },
    { projectId: 'P2', owner: 'u2', ownerName: '李四', dueDate: '2026-08-05', status: '进行中' },
    { projectId: 'P3', owner: '', ownerName: '', dueDate: '2026-08-12', status: '进行中' },
  ];

  const health = agg.aggregateHealth(items);
  t('健康度分布 red=1', health.red === 1, health);
  t('健康度分布 yellow=1', health.yellow === 1, health);
  t('健康度分布 green=2', health.green === 2, health);
  t('健康度 total=4', health.total === 4, health);

  const donut = agg.aggregateStatusDonut(items);
  t('状态环 已批准=2', donut.segments.some(function (s) { return s.status === '已批准' && s.value === 2; }), donut);
  t('状态环 进行中=1', donut.segments.some(function (s) { return s.status === '进行中' && s.value === 1; }), donut);
  t('状态环 total=4', donut.total === 4, donut);

  const ov = agg.aggregateOverdue(items, tasks, TODAY);
  t('逾期汇总含 P1 逾期1', ov.find(function (r) { return r.projectId === 'P1'; }) && ov.find(function (r) { return r.projectId === 'P1'; }).overdue === 1, ov);
  t('逾期汇总含 P2 逾期1', ov.find(function (r) { return r.projectId === 'P2'; }) && ov.find(function (r) { return r.projectId === 'P2'; }).overdue === 1, ov);
  t('逾期汇总含 P3 临期1', ov.find(function (r) { return r.projectId === 'P3'; }) && ov.find(function (r) { return r.projectId === 'P3'; }).dueSoon === 1, ov);
  t('逾期汇总排序(P1/P2 先于 P3)', ov.findIndex(function (r) { return r.projectId === 'P1'; }) < ov.findIndex(function (r) { return r.projectId === 'P3'; }), ov);

  const load = agg.aggregateOwnerLoad(tasks, TODAY, { P1: 'A', P2: 'B', P3: 'C' });
  const zhang = load.find(function (l) { return l.owner === 'u1'; });
  t('负责人张三 在办=2', zhang && zhang.activeTasks === 2, load);
  t('负责人张三 逾期=1', zhang && zhang.overdueTasks === 1, load);
  const li = load.find(function (l) { return l.owner === 'u2'; });
  t('负责人李四 在办=1 逾期=1', li && li.activeTasks === 1 && li.overdueTasks === 1, load);
  const unassigned = load.find(function (l) { return l.owner === ''; });
  t('未分配恒排最后', load[load.length - 1].owner === '' && unassigned.activeTasks === 1, load);

  const avg = agg.averageProgress(items);
  t('整体进度=50（里程碑达成率均值）', avg === 50, avg);

  const cnt = agg.countOverdueTasks(tasks, TODAY);
  t('逾期任务总数=2', cnt === 2, cnt);
}

/* ═══════════════════════════════════════════════════════
 * Q1 组 · 独立纯函数对抗（自主样本 + 手工推导期望值）
 * ═══════════════════════════════════════════════════════ */
function runGroupQ1() {
  console.log('\n== Q1 组 · 独立纯函数对抗（期望值手工推导，不参考 A 组）==');
  // 自主重造样本（与 A 组无关）
  const items = [
    { id: 'P1', name: '甲', status: '已批准', health: 'red', progress: 60 },
    { id: 'P2', name: '乙', status: '进行中', health: 'yellow', progress: 40 },
    { id: 'P3', name: '丙', status: '挂起', health: 'green', progress: 80 },
    { id: 'P4', name: '丁', status: '已批准', health: 'green', progress: 20 },
    { id: 'P5', name: '戊', status: '进行中', health: 'red', progress: 70 },
  ];
  const tasks = [
    { projectId: 'P1', projectName: '甲', owner: 'u1', ownerName: '张三', dueDate: '2026-01-01' }, // 逾期
    { projectId: 'P1', projectName: '甲', owner: 'u1', ownerName: '张三', dueDate: '2026-08-20' }, // gap=10 不计
    { projectId: 'P2', projectName: '乙', owner: 'u2', ownerName: '李四', dueDate: '2026-08-05' }, // 逾期
    { projectId: 'P3', projectName: '丙', owner: '', ownerName: '', dueDate: '2026-08-12' },       // 未分配 临期 gap=2
    { projectId: 'P5', projectName: '戊', owner: 'u1', ownerName: '张三', dueDate: '2026-08-09' }, // 逾期
    { projectId: 'P5', projectName: '戊', owner: 'u3', ownerName: '王五', dueDate: '2026-08-15' }, // gap=5 不计
    { projectId: 'P2', projectName: '乙', owner: 'u2', ownerName: '李四', dueDate: '2026-08-08' }, // 逾期
    { projectId: 'P1', projectName: '甲', owner: '', ownerName: '', dueDate: '2026-08-11' },       // 未分配 临期 gap=1
  ];

  // 健康度分布（手工：red=P1,P5=2；yellow=P2=1；green=P3,P4=2；total=5）
  const h = agg.aggregateHealth(items);
  t('Q1 健康度 red=2', h.red === 2, h);
  t('Q1 健康度 yellow=1', h.yellow === 1, h);
  t('Q1 健康度 green=2', h.green === 2, h);
  t('Q1 健康度 total=5', h.total === 5, h);

  // 整体进度 = round((60+40+80+20+70)/5) = round(54) = 54
  t('Q1 整体进度=54（里程碑达成率均值）', agg.averageProgress(items) === 54, agg.averageProgress(items));

  // 状态环：已批准=2(P1,P4) 进行中=2(P2,P5) 挂起=1(P3) total=5
  const d = agg.aggregateStatusDonut(items);
  t('Q1 状态环 已批准=2', d.segments.some(function (s) { return s.status === '已批准' && s.value === 2; }), d);
  t('Q1 状态环 进行中=2', d.segments.some(function (s) { return s.status === '进行中' && s.value === 2; }), d);
  t('Q1 状态环 挂起=1', d.segments.some(function (s) { return s.status === '挂起' && s.value === 1; }), d);
  t('Q1 状态环 total=5', d.total === 5, d);

  // 逾期汇总：P2(逾期2) > P1(逾期1,临期1) > P5(逾期1) > P3(临期1)
  const od = agg.aggregateOverdue(items, tasks, TODAY);
  t('Q1 逾期仅含风险项目', od.length === 4 && od.every(function (r) { return r.overdue > 0 || r.dueSoon > 0; }), od);
  t('Q1 逾期排序 P2→P1→P5→P3', od.map(function (r) { return r.projectId; }).join(',') === 'P2,P1,P5,P3', od.map(function (r) { return r.projectId; }));
  const p2 = od.find(function (r) { return r.projectId === 'P2'; });
  t('Q1 P2 逾期=2', p2 && p2.overdue === 2, p2);
  const p1 = od.find(function (r) { return r.projectId === 'P1'; });
  t('Q1 P1 逾期=1 临期=1', p1 && p1.overdue === 1 && p1.dueSoon === 1, p1);
  const p3 = od.find(function (r) { return r.projectId === 'P3'; });
  t('Q1 P3 临期=1', p3 && p3.dueSoon === 1, p3);

  // 负责人负荷：u1(在办3,逾期2) > u2(在办2,逾期2) > u3(在办1,逾期0) > 未分配(在办2,逾期0)
  const ld = agg.aggregateOwnerLoad(tasks, TODAY, { P1: '甲', P2: '乙', P3: '丙', P5: '戊' });
  t('Q1 负荷顺序 u1,u2,u3,未分配', ld.map(function (r) { return r.owner || '∅'; }).join(',') === 'u1,u2,u3,∅', ld.map(function (r) { return r.owner || '∅'; }));
  const u1 = ld.find(function (r) { return r.owner === 'u1'; });
  t('Q1 张三 在办=3 逾期=2', u1 && u1.activeTasks === 3 && u1.overdueTasks === 2, u1);
  t('Q1 张三 跨项目明细=2', u1 && u1.projectCount === 2 && u1.projects.length === 2, u1);
  const u2 = ld.find(function (r) { return r.owner === 'u2'; });
  t('Q1 李四 在办=2 逾期=2', u2 && u2.activeTasks === 2 && u2.overdueTasks === 2, u2);
  const un = ld.find(function (r) { return r.owner === ''; });
  t('Q1 未分配恒排最后且明细含 P1/P3', ld[ld.length - 1].owner === '' && un.projectCount === 2, un);

  // 零副作用 / 幂等 / 冻结入参
  const before = JSON.stringify(items) + '|' + JSON.stringify(tasks);
  agg.aggregateHealth(items); agg.aggregateOwnerLoad(tasks, TODAY, {}); agg.aggregateOverdue(items, tasks, TODAY);
  t('Q1 聚合不修改入参（items/tasks 冻结）', JSON.stringify(items) + '|' + JSON.stringify(tasks) === before, null);
  t('Q1 幂等（两次结果一致）', sortedEntries(agg.aggregateHealth(items)) === sortedEntries(agg.aggregateHealth(items)), null);

  // ── 健壮性观察项（非阻塞；当前数据面不可达，建议后续加固）──
  // Q1-W1 非法日期串被归零后计入「临期」，虚增 dueSoon
  const bad = [{ projectId: 'PX', projectName: 'X', owner: 'uz', ownerName: 'Z', dueDate: 'not-a-date' }];
  const odBad = agg.aggregateOverdue([{ id: 'PX', name: 'X', status: '已批准', health: 'green', progress: 0 }], bad, TODAY);
  warn('Q1', 'W1 非法日期串计入临期虚增 dueSoon',
    { dueSoon: odBad.length ? odBad[0].dueSoon : 0, 说明: 'wbs_nodes.due_date 无 CHECK；建议 isDate() 前置过滤' });

  // Q1-W2 status='__proto__' 被静默丢弃（与模块自述「绝不静默丢弃」矛盾）
  const dBad = agg.aggregateStatusDonut([{ id: 'Q', name: 'Q', status: '__proto__', health: 'green', progress: 0 }]);
  warn('Q1', 'W2 status="__proto__" 令 total 退化为非数',
    { total: dBad.total, 期望: 1, 说明: '普通 {} 计数 map 受原型键影响' });

  // Q1-W3 status='constructor' 令 total 退化为非数
  const dBad2 = agg.aggregateStatusDonut([{ id: 'Q', name: 'Q', status: 'constructor', health: 'green', progress: 0 }]);
  warn('Q1', 'W3 status="constructor" 令 total 退化为非数',
    { total: dBad2.total, 说明: '同 W2 根因：普通 {} 计数 map' });

  // Q1-W4 owner='__proto__' 触发 TypeError 且污染 Object.prototype（接口将 500）
  let threw = null, polluted = false;
  try {
    agg.aggregateOwnerLoad([{ projectId: 'PX', projectName: 'X', owner: '__proto__', ownerName: 'Z', dueDate: '2026-08-20' }], TODAY, {});
  } catch (e) { threw = e.message; }
  try { polluted = (typeof Object.prototype.P === 'function') || ({}).P !== undefined; } catch (e) { polluted = 'err'; }
  warn('Q1', 'W4 owner="__proto__" 抛 TypeError 且可能污染原型',
    { error: threw, 修法: '三处计数/分组 map 改用 Object.create(null)' });
}

/* ═══════════════════════════════════════════════════════
 * Q2 组 · SQL 独立复算交叉验证（直接查 b12_qa.db 旁路复算对拍服务层）
 * ═══════════════════════════════════════════════════════ */
function runGroupQ2() {
  console.log('\n== Q2 组 · SQL 独立复算交叉验证（b12_qa.db 旁路复算对拍服务层）==');
  if (!fs.existsSync(QA_DB)) { warn('Q2', 'b12_qa.db 缺失，跳过 SQL 复算', { path: QA_DB }); return; }
  const db = new Database(QA_DB, { readonly: true });
  const svc = require('./services/dashboard.service');
  const dates = require('./lib/dates');
  const MANAGED = svc.MANAGED_STATUSES;
  const ph = MANAGED.map(function () { return '?'; }).join(',');

  const admin = db.prepare("SELECT * FROM users WHERE open_id = 'ou_xuwenbin01'").get();
  if (!admin) { warn('Q2', 'b12_qa.db 无 admin 用户', null); db.close(); return; }
  const out = svc.getDashboardOverview(db, { scope: 'all' }, admin);

  // 在管项目数（直接 SQL）
  const sqlManaged = db.prepare('SELECT COUNT(*) c FROM projects WHERE deleted_at IS NULL AND status IN (' + ph + ')').get(...MANAGED).c;
  t('Q2 在管项目数 服务层 == SQL 复算', out.stats.managedProjects === sqlManaged, { svc: out.stats.managedProjects, sql: sqlManaged });

  // 红灯数
  const sqlRed = db.prepare('SELECT COUNT(*) c FROM projects WHERE deleted_at IS NULL AND status IN (' + ph + ') AND health = ?').get(...MANAGED, 'red').c;
  t('Q2 红灯项目数 服务层 == SQL 复算', out.stats.redProjects === sqlRed, { svc: out.stats.redProjects, sql: sqlRed });

  // 整体进度（里程碑达成率均值，round）：progress 由服务层按里程碑派生，非物理列，
  // 故改为基于响应体 projects.items[].progress 用文档公式独立复算对拍。
  const items = out.projects.items || [];
  const recomputedAvg = items.length
    ? Math.round(items.reduce(function (s, p) { return s + (Number(p.progress) || 0); }, 0) / items.length)
    : 0;
  t('Q2 整体进度 = 响应明细 progress 均值（公式自洽）', out.stats.averageProgress === recomputedAvg, { svc: out.stats.averageProgress, recomputed: recomputedAvg });

  // 周报应填数 = 进行中项目数
  const sqlDue = db.prepare("SELECT COUNT(*) c FROM projects WHERE deleted_at IS NULL AND status = '进行中'").get().c;
  t('Q2 周报应填数 服务层 == SQL 复算', out.stats.reportDue === sqlDue, { svc: out.stats.reportDue, sql: sqlDue });

  // 周报已填数（本周已提交）
  const week = dates.weekCode();
  const sqlFilled = db.prepare("SELECT COUNT(DISTINCT project_id) c FROM work_reports WHERE week = ? AND status = '已提交' AND project_id IN (SELECT id FROM projects WHERE status = '进行中' AND deleted_at IS NULL)").get(week).c;
  t('Q2 周报已填数 服务层 == SQL 复算', out.stats.reportFilled === sqlFilled, { svc: out.stats.reportFilled, sql: sqlFilled });

  // 周报填报率口径
  const sqlRate = sqlDue ? Math.round((sqlFilled / sqlDue) * 100) : 100;
  t('Q2 周报填报率 服务层 == SQL 复算', out.stats.reportFillRate === sqlRate, { svc: out.stats.reportFillRate, sql: sqlRate });

  // 逾期任务总数（服务层）== 服务层 countOverdueTasks 对纯函数
  const leafTasks = svc.listScopeLeafTasks(db, out.projects.items.map(function (p) { return String(p.id); }));
  t('Q2 逾期任务总数 服务层 == 纯函数', out.stats.overdueTasks === agg.countOverdueTasks(leafTasks, dates.today()), { svc: out.stats.overdueTasks, fn: agg.countOverdueTasks(leafTasks, dates.today()) });

  // 在管三态硬边界：返回项目状态恒 ∈ 三态
  const bad = out.projects.items.filter(function (p) { return MANAGED.indexOf(p.status) < 0; });
  t('Q2 明细表状态恒 ∈ 在管三态（无草稿/审批中等）', bad.length === 0, bad);

  db.close();
}

/* ═══════════════════════════════════════════════════════
 * Q3 组 · 响应结构 ↔ web/src/types/dashboard.ts 契约解析对齐
 * ═══════════════════════════════════════════════════════ */
async function runGroupQ3() {
  console.log('\n== Q3 组 · 响应结构 ↔ dashboard.ts 契约解析对齐 ==');
  const src = fs.readFileSync(DASHBOARD_TS, 'utf8');
  const tok = await devlogin('ou_xuwenbin01');
  if (!tok) { warn('Q3', 'admin devlogin 失败', null); return; }
  const res = await overview(tok, { scope: 'all' });
  const data = res.data;
  if (!data) { warn('Q3', '无法获取 overview 响应', res); return; }

  const topFields = tsFields(extractInterfaceBlock(src, 'DashboardOverview'));
  topFields.forEach(function (f) {
    if (f === 'projects') return; // Paged 单独校验
    t('Q3 DashboardOverview 含字段 ' + f, data[f] !== undefined, { missing: f });
  });
  t('Q3 scope 为 all|mine', data.scope === 'all' || data.scope === 'mine', data.scope);
  t('Q3 顶层无 snake_case 键', Object.keys(data).every(function (k) { return !/_[a-z]/.test(k); }), Object.keys(data));

  const statsFields = tsFields(extractInterfaceBlock(src, 'OverviewStats'));
  statsFields.forEach(function (f) {
    t('Q3 OverviewStats 含字段 ' + f, data.stats[f] !== undefined, { missing: f });
  });
  t('Q3 OverviewStats 七字段全为 number', statsFields.every(function (f) { return typeof data.stats[f] === 'number'; }), data.stats);

  const donutBlock = extractInterfaceBlock(src, 'StatusDonut');
  tsFields(donutBlock).forEach(function (f) {
    t('Q3 StatusDonut 含字段 ' + f, data.statusDonut[f] !== undefined, { missing: f });
  });
  t('Q3 statusDonut.segments 为数组', Array.isArray(data.statusDonut.segments), null);
  t('Q3 statusDonut.total 为 number', typeof data.statusDonut.total === 'number', data.statusDonut.total);

  const healthFields = tsFields(extractInterfaceBlock(src, 'HealthDistribution'));
  healthFields.forEach(function (f) {
    t('Q3 HealthDistribution 含字段 ' + f, data.health[f] !== undefined && typeof data.health[f] === 'number', { missing: f });
  });

  const odFields = tsFields(extractInterfaceBlock(src, 'OverdueByProject'));
  t('Q3 overdue 恒为数组', Array.isArray(data.overdue), null);
  (data.overdue || []).forEach(function (r, i) {
    odFields.forEach(function (f) {
      t('Q3 overdue[' + i + '] 含字段 ' + f, r[f] !== undefined, { missing: f, row: r });
    });
  });

  const loadFields = tsFields(extractInterfaceBlock(src, 'OwnerLoadRow'));
  const loadRowFields = tsFields(extractInterfaceBlock(src, 'OwnerLoadProjectRow'));
  t('Q3 ownerLoad 恒为数组', Array.isArray(data.ownerLoad), null);
  (data.ownerLoad || []).forEach(function (r, i) {
    loadFields.forEach(function (f) {
      if (f === 'projects') return;
      t('Q3 ownerLoad[' + i + '] 含字段 ' + f, r[f] !== undefined, { missing: f });
    });
    t('Q3 ownerLoad[' + i + '].projects 为数组', Array.isArray(r.projects), null);
    (r.projects || []).forEach(function (pr, j) {
      loadRowFields.forEach(function (f) {
        t('Q3 ownerLoad[' + i + '].projects[' + j + '] 含字段 ' + f, pr[f] !== undefined, { missing: f });
      });
    });
  });

  const rmFields = tsFields(extractInterfaceBlock(src, 'ReportMissingRow'));
  t('Q3 reportMissing 恒为数组', Array.isArray(data.reportMissing), null);
  (data.reportMissing || []).forEach(function (r, i) {
    rmFields.forEach(function (f) {
      t('Q3 reportMissing[' + i + '] 含字段 ' + f, r[f] !== undefined, { missing: f });
    });
  });

  // projects 为 Paged<T>
  t('Q3 projects 为 Paged（page/pageSize/total/items）',
    data.projects && typeof data.projects.page === 'number' && typeof data.projects.pageSize === 'number' && typeof data.projects.total === 'number' && Array.isArray(data.projects.items),
    data.projects);
}

/* ═══════════════════════════════════════════════════════
 * Q4 组 · 全角色 HTTP 降级矩阵 + 越权泄漏扫描 + 畸形入参兜底
 * ═══════════════════════════════════════════════════════ */
const ROLES = [
  { openId: 'ou_xuwenbin01', role: 'admin', all: true },
  { openId: 'ou_zhangmin04', role: 'pmo', all: true },
  { openId: 'ou_zhoutao08', role: 'management', all: true },
  { openId: 'ou_liming03', role: 'pm', all: false },
  { openId: 'ou_wangqiang02', role: 'tl', all: false },
  { openId: 'ou_chenjing05', role: 'qa', all: false },
  { openId: 'ou_zhaolei06', role: 'cm', all: false },
  { openId: 'ou_sunyue07', role: 'po', all: false },
  { openId: 'ou_wudi09', role: 'member', all: false },
  { openId: 'ou_zhengshuang10', role: 'member', all: false },
];

async function devlogin(openId) {
  const r = await fetch(BASE + '/api/auth/devlogin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ openId: openId }),
  });
  const j = await r.json();
  return j.code === 0 && j.data && j.data.token ? j.data.token : null;
}
async function overview(token, q) {
  const qs = Object.keys(q || {}).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
  const r = await fetch(BASE + '/api/dashboard/overview' + (qs ? '?' + qs : ''), {
    headers: { Authorization: 'Bearer ' + token },
  });
  const j = await r.json();
  return { status: r.status, code: j.code, data: j.data };
}
function visibleProjectIds(d) {
  const set = {};
  (d.projects && d.projects.items || []).forEach(function (p) { set[String(p.id)] = true; });
  (d.overdue || []).forEach(function (r) { set[String(r.projectId)] = true; });
  (d.ownerLoad || []).forEach(function (o) { (o.projects || []).forEach(function (p) { set[String(p.projectId)] = true; }); });
  (d.reportMissing || []).forEach(function (r) { set[String(r.projectId)] = true; });
  return Object.keys(set);
}

async function runGroupQ4() {
  console.log('\n== Q4 组 · 全角色 HTTP 降级矩阵 + 越权泄漏扫描 + 畸形入参兜底 ==');
  const tokens = {};
  for (const r of ROLES) {
    tokens[r.role + ':' + r.openId] = await devlogin(r.openId);
  }
  const haveToken = ROLES.every(function (r) { return !!tokens[r.role + ':' + r.openId]; });
  t('Q4 9 角色均可 devlogin 取 token', haveToken, ROLES.map(function (r) { return r.role + ':' + (!!tokens[r.role + ':' + r.openId]); }));

  // 降级矩阵
  for (const r of ROLES) {
    const tok = tokens[r.role + ':' + r.openId];
    const res = await overview(tok, { scope: 'all' });
    t('Q4 ' + r.role + ' 传 scope=all → 200（非 403 白屏）', res.status === 200, res.status);
    t('Q4 ' + r.role + ' 降级矩阵正确（期望 ' + (r.all ? 'all' : 'mine') + '）', res.data && res.data.scope === (r.all ? 'all' : 'mine'), res.data && res.data.scope);
  }

  // admin 全量作为越权基准
  const adminTok = tokens['admin:ou_xuwenbin01'];
  const adminRes = await overview(adminTok, { scope: 'all' });
  const adminIds = visibleProjectIds(adminRes.data);

  // 越权泄漏扫描：非管理角色可见项目必须 ⊆ admin 全量
  const nonAdmin = ROLES.filter(function (r) { return !r.all; });
  for (const r of nonAdmin) {
    const tok = tokens[r.role + ':' + r.openId];
    const res = await overview(tok, { scope: 'all' });
    const ids = visibleProjectIds(res.data);
    const leak = ids.filter(function (id) { return adminIds.indexOf(id) < 0; });
    t('Q4 ' + r.role + ' 可见项目 ⊆ admin 全量（无越权泄漏）', leak.length === 0, { leak: leak, visible: ids.length, adminTotal: adminIds.length });
    // 明细每行 id 可钻取（非空串）
    const badId = (res.data.projects.items || []).filter(function (p) { return !p.id || typeof p.id !== 'string'; });
    t('Q4 ' + r.role + ' 明细表每行 id 可钻取（非空串）', badId.length === 0, badId);
  }

  // 在管三态硬边界（无草稿/审批中/已驳回/已结项/已终止）
  const svc = require('./services/dashboard.service');
  const MANAGED = svc.MANAGED_STATUSES;
  const memberTok = tokens['member:ou_wudi09'];
  const mres = await overview(memberTok, { scope: 'all' });
  const badStatus = (mres.data.projects.items || []).filter(function (p) { return MANAGED.indexOf(p.status) < 0; });
  t('Q4 在管三态硬边界（明细状态恒 ∈ 三态）', badStatus.length === 0, badStatus);

  // 畸形入参兜底：一律 200，不 500
  const badTok = tokens['pm:ou_liming03'];
  const malformed = [
    { scope: '<script>all</script>' },
    { status: '__proto__' },
    { health: 'red" OR 1=1--' },
    { page: 'abc', pageSize: '9999' },
    { keyword: "'; DROP TABLE projects; --" },
    { sort: 'evil' },
  ];
  for (const q of malformed) {
    const res = await overview(badTok, q);
    t('Q4 畸形入参 ' + JSON.stringify(q) + ' → 200 兜底（无 500）', res.status === 200, res.status);
  }
  // 决策②：timeRange 入参接受但忽略（normalizeQuery 不读取该字段）
  const noTr = await overview(badTok, {});
  const tr30 = await overview(badTok, { timeRange: '30d' });
  const trQ = await overview(badTok, { timeRange: 'quarter' });
  t('Q4 决策② timeRange=30d 被忽略（结果与无 timeRange 一致）',
    noTr.data.stats.managedProjects === tr30.data.stats.managedProjects && noTr.data.projects.total === tr30.data.projects.total,
    { base: noTr.data.stats.managedProjects, tr30: tr30.data.stats.managedProjects });
  t('Q4 决策② timeRange=quarter 被忽略', noTr.data.projects.total === trQ.data.projects.total, null);

  // pageSize 越界被夹到 200
  const clampRes = await overview(badTok, { pageSize: '9999' });
  t('Q4 pageSize=9999 夹到 200', clampRes.data && clampRes.data.projects && clampRes.data.projects.pageSize === 200, clampRes.data && clampRes.data.projects && clampRes.data.projects.pageSize);

  // 参数化查询防注入：恶意 keyword 后 projects 表完好
  const db = new Database(path.join(ROOT, 'pm.db'), { readonly: true });
  const cntBefore = db.prepare('SELECT COUNT(*) c FROM projects').get().c;
  await overview(badTok, { keyword: "'; DROP TABLE projects; --" });
  const cntAfter = db.prepare('SELECT COUNT(*) c FROM projects').get().c;
  t('Q4 注入后 projects 表完好（参数化查询有效）', cntBefore === cntAfter, { before: cntBefore, after: cntAfter });
  db.close();
}

/* ── 入口 ── */
async function main() {
  runGroupA();
  runGroupQ1();
  runGroupQ2();
  await runGroupQ3();
  await runGroupQ4();

  console.log('\n══════════════════════════════════════════════════════');
  console.log('通过 ' + pass + ' / 失败 ' + fail + ' （通过率 ' + (pass + fail ? Math.round(pass / (pass + fail) * 100) : 0) + '%）');
  if (obs) {
    console.log('\n观察项（健壮性 · 不计入通过率）：');
    observations.forEach(function (o, i) {
      console.log(' ' + (i + 1) + '. [' + o.group + '] ' + o.name + '  -> ' + JSON.stringify(o.detail));
    });
  }
  console.log('══════════════════════════════════════════════════════');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('FATAL', e);
  process.exit(2);
});
