/**
 * 全局总览聚合服务（B12 · `GET /api/dashboard/overview`）
 *
 * 一次请求把「4 个指标 + 3 张图 + 1 张明细表」全算完，前端只发一个请求，
 * 避免 B11 那种「多次取数 + 前端拼装」在多项目量级下的抖动与瀑布流。
 *
 * ── 已拍板决策（不得擅改） ─────────────────────────────
 *  ① 统计范围按角色：admin / pmo / management 可看公司全量（scope=all）；
 *     其余角色**后端强制降级为 mine**（不报错、不白屏 · P1-9），
 *     mine 内可再用 `onlyMine` 在「我参与的 / 我负责的（我是 PM）」之间切换。
 *  ② 本期不做时间筛选：`timeRange` 入参接受但忽略（保留字段兼容前端）。
 *  ③ 负责人负荷 = 在办任务数 + 逾期数。
 *  ④ 项目明细表服务端分页，行点击由前端钻取到 B11 单项目仪表盘。
 *  ⑥ 统计口径恒为「在管三态」：已批准 / 进行中 / 挂起；
 *     草稿 / 审批中 / 已驳回 / 已结项 / 已终止**一律不计入**。
 *     即使前端传 `status=草稿` 也会被丢弃回落三态基线 —— 决策 ⑥ 是硬边界。
 *
 * ── 性能口径 ──────────────────────────────────────────
 *  - 项目侧复用 `project.service.loadListContext` + `toListItem`：
 *    PM 名 / 里程碑 / 质量门三张表各 1 条 `IN (...)`，杜绝 N+1。
 *  - 任务侧 1 条 `IN (...)` 拉全量 `wbs_nodes`，内存里按项目分组后判真叶子。
 *  - 周报侧 1 条 `SELECT DISTINCT project_id` 批量判「本周是否已提交」。
 *  - `IN (...)` 参数按 `SQL_IN_CHUNK` 分片，规避 SQLite 变量数上限。
 */

const { paged } = require('../lib/envelope');
const dates = require('../lib/dates');
const mappers = require('../lib/mappers');
const wbs = require('../lib/wbs');
const agg = require('../lib/portfolioAgg');
const enums = require('../config/enums');
const { canDo } = require('../config/permissions');
const projectService = require('./project.service');

/** 决策 ⑥：在管三态 —— 全局总览的统计基线 */
const MANAGED_STATUSES = ['已批准', '进行中', '挂起'];

/** 明细表分页默认值 */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

/** 单条 SQL 的 `IN (...)` 最大参数个数（SQLite 默认上限 999，留足余量） */
const SQL_IN_CHUNK = 400;

/** 明细表可选排序键 */
const SORTS = ['health', 'progress', 'overdue', 'nextMilestone'];

/** 健康度排序权重：红 → 黄 → 绿（问题优先） */
const HEALTH_RANK = { red: 0, yellow: 1, green: 2 };

/* ── 内部工具 ───────────────────────────────────────── */

/**
 * 数组分片。
 * @param {Array} list
 * @param {number} size
 * @returns {Array<Array>}
 */
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 生成 `?,?,?` 占位串。
 * @param {Array} list
 * @returns {string}
 */
function placeholders(list) {
  return list.map(function () { return '?'; }).join(',');
}

/**
 * 入参归一（含非法值兜底）。
 *
 * 所有过滤值都做**白名单校验**：非法取值一律降级为「不过滤」，
 * 而不是拼进 SQL 后返回空列表 —— 前端手抖传错参数时应该看到数据，不是空白页。
 *
 * @param {object} query 原始 `req.query`
 * @returns {{scope: string, type: string, status: string, health: string, keyword: string, onlyMine: boolean, page: number, pageSize: number, sort: string}}
 */
function normalizeQuery(query) {
  const q = query && typeof query === 'object' ? query : {};
  const page = Math.max(DEFAULT_PAGE, parseInt(q.page, 10) || DEFAULT_PAGE);
  const rawSize = parseInt(q.pageSize, 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, rawSize));
  const onlyMine = q.onlyMine === true || q.onlyMine === 'true' || q.onlyMine === '1' || q.onlyMine === 1;

  return {
    scope: q.scope === 'all' || q.scope === 'mine' ? String(q.scope) : '',
    type: enums.PROJECT_TYPES.indexOf(q.type) >= 0 ? String(q.type) : '',
    /* 决策 ⑥：只接受在管三态，其它一律回落三态基线 */
    status: MANAGED_STATUSES.indexOf(q.status) >= 0 ? String(q.status) : '',
    health: enums.HEALTHS.indexOf(q.health) >= 0 ? String(q.health) : '',
    keyword: String(q.keyword === undefined || q.keyword === null ? '' : q.keyword).trim(),
    onlyMine: !!onlyMine,
    page: page,
    pageSize: pageSize,
    sort: SORTS.indexOf(q.sort) >= 0 ? String(q.sort) : 'health',
  };
}

/**
 * 解析实际生效的统计范围（决策 ① / 决策 ⑤ 的唯一实现点）。
 *
 * - 有 `dashboard:global` 权限（admin / pmo / management）：
 *   不传 scope → `all`；显式传 `mine` → `mine`。
 * - 无权限：**恒为 `mine`**，即使显式传 `all` 也强制降级（不抛 403，见 P1-9）。
 *
 * @param {object} me users 行
 * @param {string} requested 归一后的 scope（'' 表示未指定）
 * @returns {'all'|'mine'}
 */
function resolveScope(me, requested) {
  const role = String((me && me.global_role) || '');
  const canSeeAll = canDo(role, 'dashboard:global');
  if (!canSeeAll) return 'mine';
  return requested === 'mine' ? 'mine' : 'all';
}

/* ── 取数 ───────────────────────────────────────────── */

/**
 * 范围内的项目行（已应用 scope + 过滤 + 决策 ⑥ 状态基线）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} q 归一后的入参
 * @param {object} me users 行
 * @param {'all'|'mine'} scope
 * @returns {Array<object>} projects 行
 */
function listScopedRows(db, q, me, scope) {
  const where = ['p.deleted_at IS NULL'];
  const args = [];

  if (q.status) {
    where.push('p.status = ?');
    args.push(q.status);
  } else {
    where.push('p.status IN (' + placeholders(MANAGED_STATUSES) + ')');
    MANAGED_STATUSES.forEach(function (s) { args.push(s); });
  }

  if (q.type) { where.push('p.type = ?'); args.push(q.type); }
  if (q.health) { where.push('p.health = ?'); args.push(q.health); }
  if (q.keyword) {
    where.push("(LOWER(p.name) LIKE ? OR LOWER(p.code) LIKE ? OR LOWER(IFNULL(p.customer, '')) LIKE ?)");
    const like = '%' + q.keyword.toLowerCase() + '%';
    args.push(like, like, like);
  }

  if (scope === 'mine') {
    const openId = String((me && me.open_id) || '');
    if (!openId) return [];
    where.push(
      q.onlyMine
        ? "EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_open_id = ? AND pm.project_role = 'pm')"
        : 'EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_open_id = ?)',
    );
    args.push(openId);
  }

  return db
    .prepare('SELECT p.* FROM projects p WHERE ' + where.join(' AND ') + ' ORDER BY p.updated_at DESC, p.id DESC')
    .all(args);
}

/**
 * 范围内的 `ProjectListItem[]`（复用列表页同一套聚合，保证两处百分比一致）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} q 归一后的入参
 * @param {object} me users 行
 * @param {'all'|'mine'} scope
 * @returns {Array<object>} ProjectListItem[]
 */
function listScopedItems(db, q, me, scope) {
  const rows = listScopedRows(db, q, me, scope);
  if (!rows.length) return [];
  const ids = rows.map(function (r) { return String(r.id); });
  const ctx = projectService.loadListContext(db, ids);
  const todayStr = dates.today();
  return rows.map(function (r) { return projectService.toListItem(r, ctx, todayStr); });
}

/**
 * 范围内项目的「在办叶子任务」。
 *
 * 真叶子判定必须在**项目全量节点**上做（`wbs.leafNodesOf` 依赖 parentId 全集），
 * 所以先按项目分组再判叶子，不能一把过滤。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string>} projectIds
 * @returns {Array<object>} WbsNode[]（含 ownerName）
 */
function listScopeLeafTasks(db, projectIds) {
  const ids = (projectIds || []).map(String).filter(Boolean);
  if (!ids.length) return [];

  const nameOf = mappers.makeNameLookup(db);
  const byProject = {};

  chunk(ids, SQL_IN_CHUNK).forEach(function (part) {
    db.prepare('SELECT * FROM wbs_nodes WHERE project_id IN (' + placeholders(part) + ')')
      .all(part)
      .forEach(function (r) {
        const n = mappers.toApiWbsNode(r, nameOf);
        if (!n) return;
        if (!byProject[n.projectId]) byProject[n.projectId] = [];
        byProject[n.projectId].push(n);
      });
  });

  const out = [];
  Object.keys(byProject).forEach(function (pid) {
    wbs.leafNodesOf(byProject[pid]).forEach(function (n) {
      if (n.status !== '完成') out.push(n);
    });
  });
  return out;
}

/**
 * 本周周报填报情况（口径与 `workbench.service.listReportReminders` 一致）。
 *
 * `filled` = 该项目本周存在 `work_reports.status = '已提交'`（项目级，任一成员提交即算，草稿不计）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string>} projectIds 应填报项目（范围内 status = '进行中'）
 * @returns {{week: string, due: number, filled: number, missingIds: Array<string>}}
 */
function countReportFill(db, projectIds) {
  const ids = (projectIds || []).map(String).filter(Boolean);
  const week = dates.weekCode();
  if (!ids.length) return { week: week, due: 0, filled: 0, missingIds: [] };

  const filledSet = {};
  chunk(ids, SQL_IN_CHUNK).forEach(function (part) {
    db.prepare(
      'SELECT DISTINCT project_id FROM work_reports WHERE project_id IN ('
      + placeholders(part)
      + ") AND week = ? AND status = '已提交'",
    )
      .all(part.concat([week]))
      .forEach(function (r) { filledSet[mappers.toStr(r.project_id)] = true; });
  });

  const missingIds = ids.filter(function (id) { return !filledSet[id]; });
  return { week: week, due: ids.length, filled: ids.length - missingIds.length, missingIds: missingIds };
}

/* ── 明细表排序 ─────────────────────────────────────── */

/**
 * 明细表排序（返回新数组，不改动入参）。
 *
 * 四种口径（与前端下拉文案一一对应）：
 *  - `health`       健康度（红 → 绿），同档按进度 ↑（落后的在前）
 *  - `progress`     进度（低 → 高）
 *  - `overdue`      逾期数（多 → 少）
 *  - `nextMilestone` 下个里程碑（近 → 远），无日期恒最后
 * 兜底 tie-break 一律 `项目名 ↑`，保证同一份数据每次刷新顺序稳定（分页不跳行）。
 *
 * @param {Array<object>} items ProjectListItem[]
 * @param {string} sort
 * @param {Object<string, number>} overdueByProject projectId → 逾期任务数
 * @returns {Array<object>}
 */
function sortItems(items, sort, overdueByProject) {
  const map = overdueByProject || {};
  const list = (items || []).slice();

  return list.sort(function (a, b) {
    if (sort === 'progress') {
      const pa = Number(a.progress) || 0;
      const pb = Number(b.progress) || 0;
      if (pa !== pb) return pa - pb;
    } else if (sort === 'overdue') {
      const oa = map[String(a.id)] || 0;
      const ob = map[String(b.id)] || 0;
      if (oa !== ob) return ob - oa;
    } else if (sort === 'nextMilestone') {
      const da = String(a.nextMilestoneDate || '');
      const dbv = String(b.nextMilestoneDate || '');
      if (!da !== !dbv) return da ? -1 : 1;           // 无日期恒最后
      if (da !== dbv) return da < dbv ? -1 : 1;
    } else {
      const ra = HEALTH_RANK[String(a.health)] === undefined ? 3 : HEALTH_RANK[String(a.health)];
      const rb = HEALTH_RANK[String(b.health)] === undefined ? 3 : HEALTH_RANK[String(b.health)];
      if (ra !== rb) return ra - rb;
      const pa = Number(a.progress) || 0;
      const pb = Number(b.progress) || 0;
      if (pa !== pb) return pa - pb;
    }
    return agg.compareText(a.name, b.name);
  });
}

/* ── 对外主函数 ─────────────────────────────────────── */

/**
 * 全局总览聚合。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} query `req.query`（DashboardOverviewQuery）
 * @param {object} me users 行（`requireAuth` 挂载）
 * @returns {object} DashboardOverview
 */
function getDashboardOverview(db, query, me) {
  const q = normalizeQuery(query);
  const scope = resolveScope(me, q.scope);
  const todayStr = dates.today();

  const items = listScopedItems(db, q, me, scope);
  const projectIds = items.map(function (p) { return String(p.id); });
  const tasks = listScopeLeafTasks(db, projectIds);

  /* 项目名 / PM 名查表：ownerLoad 的跨项目明细与 reportMissing 共用 */
  const nameById = {};
  const pmById = {};
  items.forEach(function (p) {
    const id = String(p.id);
    nameById[id] = String(p.name || '') || agg.UNNAMED_PROJECT;
    pmById[id] = String(p.pmName || '') || projectService.NO_PM_PLACEHOLDER;
  });

  const health = agg.aggregateHealth(items);
  const statusDonut = agg.aggregateStatusDonut(items);
  const overdue = agg.aggregateOverdue(items, tasks, todayStr);
  const ownerLoad = agg.aggregateOwnerLoad(tasks, todayStr, nameById);
  const overdueTasks = agg.countOverdueTasks(tasks, todayStr);

  /* 周报：只有「进行中」项目才需要填（与工作台提醒同一口径） */
  const activeIds = items
    .filter(function (p) { return p.status === '进行中'; })
    .map(function (p) { return String(p.id); });
  const fill = countReportFill(db, activeIds);

  const reportMissing = fill.missingIds.map(function (id) {
    return {
      projectId: id,
      projectName: nameById[id] || agg.UNNAMED_PROJECT,
      pmName: pmById[id] || projectService.NO_PM_PLACEHOLDER,
    };
  });

  const overdueByProject = {};
  overdue.forEach(function (r) { overdueByProject[r.projectId] = r.overdue; });

  const sorted = sortItems(items, q.sort, overdueByProject);
  const start = (q.page - 1) * q.pageSize;

  return {
    scope: scope,
    generatedAt: dates.nowIso(),
    stats: {
      managedProjects: items.length,
      redProjects: health.red,
      overdueTasks: overdueTasks,
      /* 无应填项目时视为 100%（0 缺口），避免空数据把卡片染成告警色 */
      reportFillRate: fill.due ? Math.round((fill.filled / fill.due) * 100) : 100,
      reportFilled: fill.filled,
      reportDue: fill.due,
      averageProgress: agg.averageProgress(items),
    },
    statusDonut: statusDonut,
    health: health,
    overdue: overdue,
    ownerLoad: ownerLoad,
    reportMissing: reportMissing,
    projects: paged(sorted.slice(start, start + q.pageSize), items.length, q.page, q.pageSize),
  };
}

module.exports = {
  MANAGED_STATUSES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  normalizeQuery,
  resolveScope,
  listScopedItems,
  listScopeLeafTasks,
  countReportFill,
  sortItems,
  getDashboardOverview,
};
