// D11 仪表盘升级 · 后端集成验证（只读 pm.db，不写业务数据）
// 验证三处新聚合：门控 / 交付物 / 周报闭环 + 工作台「待我确认周报」。
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'qa-secret';

const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.QA_DB || path.join(ROOT, 'pm.db');

let pass = 0,
  fail = 0;
const fails = [];
function ok(cond, msg, extra) {
  if (cond) {
    pass++;
    console.log('  ✓', msg);
  } else {
    fail++;
    fails.push(msg);
    console.log('  ✗', msg, extra !== undefined ? '→ ' + JSON.stringify(extra) : '');
  }
}

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma('journal_mode = WAL');
} catch (e) {
  console.error('无法以只读方式打开数据库：', DB_PATH, e.message);
  process.exit(3);
}

// 动态 require 服务（避免硬编码相对路径的运行时解析问题）
const dashboardService = require(path.join(ROOT, 'server/services/dashboard.service.js'));
const workbenchService = require(path.join(ROOT, 'server/services/workbench.service.js'));

// ── 范围内项目 id（与 dashboard.service 决策⑥一致：在管三态 + 未删除） ──
const MANAGED = ['已批准', '进行中', '挂起'];
const projectIds = db
  .prepare('SELECT id FROM projects WHERE deleted_at IS NULL AND status IN (?,?,?)')
  .all(...MANAGED)
  .map((r) => String(r.id));
console.log(`范围内项目数：${projectIds.length}`);

// 取一个 admin 用户作为 me（确认人场景）
const adminRow =
  db.prepare("SELECT open_id, name, global_role FROM users WHERE global_role = 'admin' LIMIT 1").get() || {};
const me = { open_id: adminRow.open_id || 'ou_xuwenbin01', global_role: 'admin', name: adminRow.name || 'admin' };

console.log('\n── 1. 门控聚合（aggregateGates） ──');
const gates = dashboardService.aggregateGates(db, projectIds);
// 独立 SQL 核对
const gateCheck = db
  .prepare(
    'SELECT status, COUNT(*) c FROM quality_gates WHERE project_id IN (' +
      projectIds.map(() => '?').join(',') +
      ') GROUP BY status',
  )
  .all(...projectIds)
  .reduce((acc, r) => ((acc[r.status] = r.c), acc), {});
ok(typeof gates.total === 'number' && typeof gates.pending === 'number', '返回字段为 number');
ok(gates.notStarted === (gateCheck['未开始'] || 0), 'notStarted 与原始 SQL 一致', gates.notStarted);
ok(gates.pendingCheck === (gateCheck['待检查'] || 0), 'pendingCheck 与原始 SQL 一致', gates.pendingCheck);
ok(gates.passed === (gateCheck['已通过'] || 0), 'passed 与原始 SQL 一致', gates.passed);
ok(
  gates.pending === gates.notStarted + gates.pendingCheck,
  'pending = 未开始 + 待检查',
  { pending: gates.pending, sum: gates.notStarted + gates.pendingCheck },
);
const gateSum = ['未开始', '待检查', '已通过', '有条件通过', '不通过'].reduce((s, k) => s + (gateCheck[k] || 0), 0);
ok(gates.total === gateSum, 'total = 五态之和', { total: gates.total, sum: gateSum });

console.log('\n── 2. 交付物聚合（aggregateDeliverables） ──');
const deliveries = dashboardService.aggregateDeliverables(db, projectIds);
const docRows = db
  .prepare(
    'SELECT status, baseline_flag, COUNT(*) c FROM project_documents WHERE project_id IN (' +
      projectIds.map(() => '?').join(',') +
      ') GROUP BY status, baseline_flag',
  )
  .all(...projectIds);
let expTotal = 0,
  expDelivered = 0,
  expPending = 0,
  expBaselined = 0;
docRows.forEach((r) => {
  const c = r.c;
  expTotal += c;
  if (r.status === '已交付') expDelivered += c;
  else if (r.status === '待交付') expPending += c;
  if (r.baseline_flag) expBaselined += c;
});
const expRate = expTotal ? Math.round((expBaselined / expTotal) * 100) : 0;
ok(
  deliveries.total === expTotal && deliveries.delivered === expDelivered && deliveries.pending === expPending && deliveries.baselined === expBaselined,
  '交付物四项计数与原始 SQL 一致',
  deliveries,
);
ok(deliveries.baselineRate === expRate, 'baselineRate 计算正确', { got: deliveries.baselineRate, exp: expRate });

console.log('\n── 3. 周报闭环聚合（countReportClosure） ──');
const closure = dashboardService.countReportClosure(db, projectIds);
const closureCheck = db
  .prepare(
    "SELECT status, COUNT(*) c FROM work_reports WHERE project_id IN (" +
      projectIds.map(() => '?').join(',') +
      ") AND status IN ('已提交','已确认') GROUP BY status",
  )
  .all(...projectIds)
  .reduce((acc, r) => ((acc[r.status] = r.c), acc), {});
ok(closure.submitted === (closureCheck['已提交'] || 0), 'submitted 与原始 SQL 一致', closure.submitted);
ok(closure.confirmed === (closureCheck['已确认'] || 0), 'confirmed 与原始 SQL 一致', closure.confirmed);
const denom = closure.submitted + closure.confirmed;
const expClosureRate = denom ? Math.round((closure.confirmed / denom) * 100) : 0;
ok(closure.closureRate === expClosureRate, 'closureRate 计算正确', { got: closure.closureRate, exp: expClosureRate });

console.log('\n── 4. 工作台·待我确认周报（listReportConfirmations） ──');
const confirmations = workbenchService.listReportConfirmations(db, me);
ok(Array.isArray(confirmations), '返回为数组');
if (confirmations.length) {
  const sample = confirmations[0];
  ok(
    ['id', 'projectId', 'projectName', 'week', 'authorName', 'submittedAt'].every((k) => k in sample),
    '每条含全部约定字段',
    Object.keys(sample),
  );
  ok(confirmations.every((c) => c.projectName !== undefined), 'projectName 已映射（非 undefined）');
  const cnt = workbenchService.countPendingConfirmations(db, me);
  ok(cnt === confirmations.length, 'countPendingConfirmations 与 list 长度一致', { cnt, len: confirmations.length });
} else {
  console.log('  (该 admin 当前无待确认周报，仅校验返回形态)');
  ok(true, '空数组返回形态正确');
}

console.log('\n── 5. getDashboardOverview 端到端（admin·scope=all） ──');
const overview = dashboardService.getDashboardOverview(db, { scope: 'all' }, me);
ok(overview && overview.gates && overview.deliverables, 'overview 含 gates / deliverables');
ok(
  overview.gates.total === gates.total && overview.deliverables.total === deliveries.total,
  'overview.gates/deliverables 与单测一致',
);
ok(
  overview.stats.pendingReportConfirm === closure.submitted &&
    overview.stats.reportClosureRate === closure.closureRate,
  'overview.stats 含周报闭环字段',
);

db.close();

console.log(`\nD11 后端集成验证：通过 ${pass} / 失败 ${fail}`);
if (fail) console.log('失败项：\n - ' + fails.join('\n - '));
process.exit(fail ? 1 : 0);
