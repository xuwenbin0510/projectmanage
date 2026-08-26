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
const { isGlobalRole } = require('../services/roleCatalog');
const permissionCatalog = require('../services/permissionCatalog');
const { resolveGlobalRoles } = require('../middleware/auth');
const projectService = require('./project.service');

/** 决策 ⑥：在管三态 —— 全局总览的统计基线 */
const MANAGED_STATUSES = ['已批准', '进行中', '挂起'];

/** B18：逾期档位白名单（与 portfolioAgg.overdueBucketOf 返回值逐字一致） */
const OVERDUE_BUCKETS = ['1to7', '8to30', 'over30'];

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
    /* 任务负责人（openId）：按「项目内含该负责人的真叶子任务」过滤项目；空串 = 不过滤 */
    ownerOpenId: String(q.ownerOpenId === undefined || q.ownerOpenId === null ? '' : q.ownerOpenId).trim(),
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
  // E1.5：用户的全部全局职位取并集，任一命中 dashboard:global 即可看全量
  const roles = resolveGlobalRoles(me);
  const canSeeAll = canDo(roles, 'dashboard:global');
  if (!canSeeAll) return 'mine';
  return requested === 'mine' ? 'mine' : 'all';
}

/**
 * 优先级归一（P0-P3 白名单，脏值兜底 P2）。
 * 与 portfolioAgg.aggregatePriorityDist / wbs.service 优先级口径逐字一致（PRD P0-3）。
 * @param {*} raw
 * @returns {string}
 */
function normalizePriorityValue(raw) {
  const v = String(raw === null || raw === undefined ? '' : raw).trim().toUpperCase();
  return agg.PRIORITIES.indexOf(v) >= 0 ? v : agg.DEFAULT_PRIORITY;
}

/**
 * 解析 B18 维度过滤参数（三选一互斥 · PRD P0-6）。
 * 顺序：taskStatus → overdueBucket → priority，只取第一个**合法**维度生效，其余忽略。
 * - taskStatus：白名单 enums.TASK_STATUSES；非法 → 视为未传，继续看下一维度。
 * - overdueBucket：白名单 OVERDUE_BUCKETS；非法 → 视为未传，继续看下一维度。
 * - priority：P0-P3 白名单，**非法值（P9 / 空串 / 小写）兜底归一为 P2**（等价传 P2，
 *   与 aggregatePriorityDist 脏值兜底一致）；未传（undefined/null）→ 不按优先级过滤。
 * 注意：本函数读**原始 query**（normalizeQuery 不保留这三个字段），normalizeQuery 零改动。
 * @param {object} query 原始 req.query
 * @returns {{kind: 'taskStatus'|'overdueBucket'|'priority'|'none', value: string}}
 */
function resolveDimension(query) {
  const raw = query && typeof query === 'object' ? query : {};
  if (enums.TASK_STATUSES.indexOf(raw.taskStatus) >= 0) {
    return { kind: 'taskStatus', value: String(raw.taskStatus) };
  }
  if (OVERDUE_BUCKETS.indexOf(raw.overdueBucket) >= 0) {
    return { kind: 'overdueBucket', value: String(raw.overdueBucket) };
  }
  if (raw.priority !== undefined && raw.priority !== null) {
    return { kind: 'priority', value: normalizePriorityValue(raw.priority) };
  }
  return { kind: 'none', value: '' };
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
  /* D01.5 任务负责人：项目内含该负责人（openId）的**真叶子任务**（无子节点）即命中；
     相关子查询判叶子，与 D01 任务进展块 / 看板卡片口径一致（node_type 无法排除父节点） */
  if (q.ownerOpenId) {
    where.push(
      'EXISTS (SELECT 1 FROM wbs_nodes w WHERE w.project_id = p.id AND w.owner = ? '
      + 'AND NOT EXISTS (SELECT 1 FROM wbs_nodes c WHERE c.parent_id = w.id))',
    );
    args.push(q.ownerOpenId);
  }

  if (scope === 'mine') {
    const openId = String((me && me.open_id) || '');
    if (!openId) return [];
    if (q.onlyMine) {
      // 「我负责的项目」= 我以「项目负责人」角色参与的项目；角色集从权限矩阵动态取，避免硬编码漏判
      const ownerRoles = permissionCatalog.rolesFor('project:edit').roles.filter(function (r) { return !isGlobalRole(r); }); // 项目视角负责人角色（例：['pm']）
      const ph = ownerRoles.map(function () { return '?'; }).join(',');
      where.push(
        'EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_open_id = ? '
        + 'AND pm.project_role IN (' + ph + '))',
      );
      args.push(openId);
      ownerRoles.forEach(function (r) { args.push(String(r)); });
    } else {
      where.push(
        'EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_open_id = ?)',
      );
      args.push(openId);
    }
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
  return rows.map(function (r) { return projectService.toListItem(r, ctx, todayStr, db); });
}

/**
 * 范围内项目的叶子任务（私有拉取，`listScopeLeafTasks` / `listScopeAllLeafTasks` 共用）。
 *
 * 真叶子判定必须在**项目全量节点**上做（`wbs.leafNodesOf` 依赖 parentId 全集），
 * 所以先按项目分组再判叶子，不能一把过滤。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string>} projectIds
 * @param {boolean} includeDone 为 `true` 时含已完成叶子（B17 状态分布口径）
 * @returns {Array<object>} WbsNode[]（含 ownerName）
 */
function collectScopeLeafTasks(db, projectIds, includeDone) {
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
      if (includeDone || n.status !== '完成') out.push(n);
    });
  });
  return out;
}

/**
 * 范围内项目的「在办叶子任务」。
 * 与 `listScopeAllLeafTasks` 共享私有拉取，唯一差异 = 过滤 `status === '完成'`。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string>} projectIds
 * @returns {Array<object>} WbsNode[]（含 ownerName）
 */
function listScopeLeafTasks(db, projectIds) {
  return collectScopeLeafTasks(db, projectIds, false);
}

/**
 * 范围内项目的「全部叶子任务」（含已完成）。
 * 与 `listScopeLeafTasks` 共享私有拉取，唯一差异 = 不过滤 `status === '完成'`
 * （B17 状态分布口径，零额外 SQL）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string>} projectIds
 * @returns {Array<object>} WbsNode[]（含 ownerName，含已完成叶子）
 */
function listScopeAllLeafTasks(db, projectIds) {
  return collectScopeLeafTasks(db, projectIds, true);
}

/**
 * 本周周报填报情况（口径与 `workbench.service.listReportReminders` 一致）。
 *
 * `filled` = 该项目本周存在 `work_reports.status = '已提交'`（项目级，任一成员提交即算，草稿不计）。
 *
 * 计划周期门控（2026-08-26，与工作台 `listReportReminders` 同源对齐）：
 *  应填报项目**不再等于全部「进行中」项目**，而是「有 ≥1 个未完成（status!='完成'）叶子任务
 *  （任意负责人）其计划窗口与本周(周一~周日)相交」的项目；无日期任务视为「有活」恒计入。
 *  这样仪表盘「待填周报」与工作台「本周待填周报」口径一致，不再出现「全员必填」式冗余提醒。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string>} projectIds 范围内 status = '进行中' 的项目
 * @returns {{week: string, due: number, filled: number, missingIds: Array<string>}}
 */
function countReportFill(db, projectIds) {
  const ids = (projectIds || []).map(String).filter(Boolean);
  const week = dates.weekCode();
  if (!ids.length) return { week: week, due: 0, filled: 0, missingIds: [] };

  const range = dates.weekRange(week);
  const weekStart = String((range && range.start) || '').slice(0, 10);
  const weekEnd = String((range && range.end) || '').slice(0, 10);

  /* 计划周期门控：仅「本周有 ≥1 未完成叶子任务（任意负责人）计划窗口相交」的项目才需填报 */
  const dueIds = ids.filter(function (id) {
    const hit = db
      .prepare(
        `SELECT 1 FROM wbs_nodes w
          WHERE w.project_id = ?
            AND w.status != '完成'
            AND NOT EXISTS (SELECT 1 FROM wbs_nodes c WHERE c.parent_id = w.id)
            AND (
              (w.start_date IS NULL AND w.due_date IS NULL)
              OR (w.start_date IS NULL AND date(w.due_date) >= date(?))
              OR (w.due_date IS NULL AND date(w.start_date) <= date(?))
              OR (date(w.start_date) <= date(?) AND date(w.due_date) >= date(?))
            )
          LIMIT 1`,
      )
      .get(id, weekStart, weekEnd, weekStart, weekEnd);
    return !!hit;
  });
  if (!dueIds.length) return { week: week, due: 0, filled: 0, missingIds: [] };

  const filledSet = {};
  chunk(dueIds, SQL_IN_CHUNK).forEach(function (part) {
    db.prepare(
      'SELECT DISTINCT project_id FROM work_reports WHERE project_id IN ('
      + placeholders(part)
      + ") AND week = ? AND status = '已提交'",
    )
      .all(part.concat([week]))
      .forEach(function (r) { filledSet[mappers.toStr(r.project_id)] = true; });
  });

  const missingIds = dueIds.filter(function (id) { return !filledSet[id]; });
  return { week: week, due: dueIds.length, filled: dueIds.length - missingIds.length, missingIds: missingIds };
}

/** 质量门状态白名单（与质量门状态机一致，顺序即分布图段序） */
const GATE_STATUSES = ['未开始', '待检查', '已通过', '有条件通过', '不通过'];

/**
 * 范围内质量门状态聚合（D11 · 全局总览「门控总览」）。
 *
 * 输入 = 范围内项目 id（已应用 scope / 过滤 / 决策 ⑥ 在管三态）；
 * `quality_gates` 经 `project_id IN (...)` 统计各状态计数。
 * `pending`（待决议）= 未开始 + 待检查；`total` = 全部状态之和。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string>} projectIds 范围内项目 id
 * @returns {{passed: number, conditional: number, failed: number, pendingCheck: number, notStarted: number, pending: number, total: number}}
 */
function aggregateGates(db, projectIds) {
  const ids = (projectIds || []).map(String).filter(Boolean);
  const result = { passed: 0, conditional: 0, failed: 0, pendingCheck: 0, notStarted: 0, pending: 0, total: 0 };
  if (!ids.length) return result;

  const counts = {};
  chunk(ids, SQL_IN_CHUNK).forEach(function (part) {
    db.prepare('SELECT status, COUNT(*) c FROM quality_gates WHERE project_id IN (' + placeholders(part) + ') GROUP BY status')
      .all(part)
      .forEach(function (r) { counts[String(r.status)] = mappers.toNum(r.c, 0); });
  });

  result.notStarted = counts['未开始'] || 0;
  result.pendingCheck = counts['待检查'] || 0;
  result.passed = counts['已通过'] || 0;
  result.conditional = counts['有条件通过'] || 0;
  result.failed = counts['不通过'] || 0;
  result.pending = result.notStarted + result.pendingCheck;
  result.total = GATE_STATUSES.reduce(function (s, k) { return s + (counts[k] || 0); }, 0);
  return result;
}

/**
 * 范围内交付物聚合（D11 · 全局总览「交付物总览」）。
 *
 * 输入 = 范围内项目 id；`project_documents` 按 `status` × `baseline_flag` 分组计数：
 *  - `delivered` = status='已交付'；`pending` = status='待交付'；
 *  - `baselined` = baseline_flag=1（不论状态，已交付或待交付均可纳入基线）；
 *  - `baselineRate` = baselined / total（total=0 时为 0）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string>} projectIds 范围内项目 id
 * @returns {{total: number, delivered: number, pending: number, baselined: number, baselineRate: number}}
 */
function aggregateDeliverables(db, projectIds) {
  const ids = (projectIds || []).map(String).filter(Boolean);
  const result = { total: 0, delivered: 0, pending: 0, baselined: 0, baselineRate: 0 };
  if (!ids.length) return result;

  const rows = [];
  chunk(ids, SQL_IN_CHUNK).forEach(function (part) {
    db.prepare(
      'SELECT status, baseline_flag, COUNT(*) c FROM project_documents WHERE project_id IN (' + placeholders(part) + ') GROUP BY status, baseline_flag',
    )
      .all(part)
      .forEach(function (r) { rows.push({ status: String(r.status), bl: mappers.toNum(r.baseline_flag, 0), c: mappers.toNum(r.c, 0) }); });
  });

  let total = 0;
  let delivered = 0;
  let pending = 0;
  let baselined = 0;
  rows.forEach(function (r) {
    total += r.c;
    if (r.status === '已交付') delivered += r.c;
    else if (r.status === '待交付') pending += r.c;
    if (r.bl) baselined += r.c;
  });
  result.total = total;
  result.delivered = delivered;
  result.pending = pending;
  result.baselined = baselined;
  result.baselineRate = total ? Math.round((baselined / total) * 100) : 0;
  return result;
}

/**
 * 范围内里程碑到期聚合（第一批 · 全局总览「近 30 天到期里程碑」）。
 *
 * 输入 = 范围内项目 id（已应用 scope / 过滤 / 决策⑥）。
 * 仅统计**未完成**（done_at IS NULL）且**有计划日期**（planned_date 非空）的里程碑，
 * 且 planned_date ≤ 今天 + 30 天：
 *  - `overdue`（已过期）= planned_date < today；
 *  - `upcoming`（未来 30 天）= today ≤ planned_date ≤ today+30；
 *  - `total` = overdue + upcoming。
 * 附带 `items`（按计划日期升序，至多 20 条）供后续下探/列表直接渲染，本批前端只用计数。
 * 附带 `byProject`（projectId → {total, overdue, upcoming}）供明细表加列「近 30 天到期」。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string>} projectIds 范围内项目 id
 * @returns {{total: number, overdue: number, upcoming: number, items: Array<{projectId: string, projectName: string, name: string, plannedDate: string, overdue: boolean}>, byProject: Object<string, {total: number, overdue: number, upcoming: number}>}}
 */
function aggregateMilestones(db, projectIds) {
  const ids = (projectIds || []).map(String).filter(Boolean);
  const result = { total: 0, overdue: 0, upcoming: 0, items: [], byProject: {} };
  if (!ids.length) return result;

  const todayStr = dates.today();                            // 'YYYY-MM-DD'
  const limitIso = dates.addDays(todayStr, 30);              // ISO（可能带 T00:00:00Z）
  const limitStr = String(limitIso).slice(0, 10);            // 'YYYY-MM-DD'

  const projName = {};
  chunk(ids, SQL_IN_CHUNK).forEach(function (part) {
    db.prepare('SELECT id, name FROM projects WHERE id IN (' + placeholders(part) + ')')
      .all(part)
      .forEach(function (r) { projName[mappers.toStr(r.id)] = mappers.toStr(r.name) || agg.UNNAMED_PROJECT; });
  });

  const rows = [];
  chunk(ids, SQL_IN_CHUNK).forEach(function (part) {
    db.prepare(
      'SELECT id, project_id, name, planned_date FROM milestones '
      + 'WHERE project_id IN (' + placeholders(part) + ') '
      + "AND done_at IS NULL AND planned_date IS NOT NULL AND planned_date != '' AND planned_date <= ? "
      + 'ORDER BY planned_date ASC',
    )
      .all(part.concat([limitStr]))
      .forEach(function (r) { rows.push(r); });
  });

  rows.forEach(function (r) {
    const pid = mappers.toStr(r.project_id);
    const planned = mappers.toStr(r.planned_date);           // 'YYYY-MM-DD'
    const isOverdue = planned < todayStr;
    result.total += 1;
    if (isOverdue) result.overdue += 1;
    else result.upcoming += 1;
    /* byProject 累计（每个项目的近 30 天到期里程碑数） */
    if (!result.byProject[pid]) result.byProject[pid] = { total: 0, overdue: 0, upcoming: 0 };
    result.byProject[pid].total += 1;
    if (isOverdue) result.byProject[pid].overdue += 1;
    else result.byProject[pid].upcoming += 1;
    if (result.items.length < 20) {
      result.items.push({
        projectId: pid,
        projectName: projName[pid] || agg.UNNAMED_PROJECT,
        name: mappers.toStr(r.name),
        plannedDate: planned,
        overdue: isOverdue,
      });
    }
  });
  return result;
}

/**
 * 范围内周报闭环聚合（D11 · 全局总览「周报闭环」）。
 *
 * 仅统计 `status IN ('已提交','已确认')` 的周报（草稿不计入闭环口径）：
 *  - `submitted` = 已提交（待确认）；`confirmed` = 已确认；
 *  - `closureRate` = confirmed / (submitted + confirmed)（分母=0 时 100）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string>} projectIds 范围内项目 id
 * @returns {{submitted: number, confirmed: number, closureRate: number}}
 */
function countReportClosure(db, projectIds) {
  const ids = (projectIds || []).map(String).filter(Boolean);
  const result = { submitted: 0, confirmed: 0, closureRate: 0 };
  if (!ids.length) return result;

  const cnt = {};
  chunk(ids, SQL_IN_CHUNK).forEach(function (part) {
    db.prepare(
      "SELECT status, COUNT(*) c FROM work_reports WHERE project_id IN (" + placeholders(part) + ") AND status IN ('已提交','已确认') GROUP BY status",
    )
      .all(part)
      .forEach(function (r) { cnt[String(r.status)] = mappers.toNum(r.c, 0); });
  });
  result.submitted = cnt['已提交'] || 0;
  result.confirmed = cnt['已确认'] || 0;
  const denom = result.submitted + result.confirmed;
  result.closureRate = denom ? Math.round((result.confirmed / denom) * 100) : 0;
  return result;
}

/**
 * 上周工作进展（D01 · 全局总览面板「上周工作进展」）。
 *
 * 三个维度，全部基于「**上周**（上一自然 ISO 周 · 周一~周日）」范围——周一开周例会回顾的是
 * 上一个完整周的主要进展，周报 `week` 字段即按周码存储，天然匹配：
 *  ① 周报动态：范围内项目上周（`week = 上周周码`）的周报，按提交/更新时间倒序。
 *  ② 上周任务进展：范围内叶子任务（`node_type='task'`）中 `updated_at` 落在
 *     [上周一 00:00, 本周一 00:00) 者，含「仅进度更新」与「已完成」两类（完成态置 `done:true` 高亮）。
 *  ③ 上周达成里程碑：范围内里程碑 `done_at（YYYY-MM-DD）` 落在上周区间者。
 *
 * 与全局总览同源同口径：scope / 过滤 / 决策 ⑥ 已通过 `projectIds` 传入（调用方已算好范围），
 * 本函数**只**在范围内取数，不重新做 scope 判定。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string>} projectIds 范围内项目 id（已在调用方完成 scope/过滤/决策⑥）
 * @returns {{week: string, reports: Array<object>, tasks: Array<object>, milestones: Array<object>}}
 */
function computeWeeklyProgress(db, projectIds) {
  const ids = (projectIds || []).map(String).filter(Boolean);
  /* 上周周码：今天减 7 天必落在上一自然周，取该日所在 ISO 周 */
  const week = dates.weekCode(dates.addDays(dates.today(), -7));
  const lastRange = dates.weekRange(week);                       // { start, end } ISO
  const lastStartIso = lastRange.start;                          // 'YYYY-MM-DDT00:00:00Z'（上周一）
  const lastStart = lastStartIso.slice(0, 10);                   // 'YYYY-MM-DD'（里程碑 done_at 是纯日期）
  const lastEnd = lastRange.end.slice(0, 10);                    // 'YYYY-MM-DD'（上周日）
  /* 任务上界：本周一 00:00（上周 [周一, 周一) 半开区间，避免把本周动态混入） */
  const thisWeekStartIso = dates.weekRange(dates.weekCode()).start;

  if (!ids.length) {
    return { week: week, reports: [], tasks: [], milestones: [], missing: [] };
  }

  /* 项目名/状态查表：id → name（缺失回落未命名项目）+ status（用于未提交周报口径），一次性 SELECT */
  const projName = {};
  const projStatus = {};
  chunk(ids, SQL_IN_CHUNK).forEach(function (part) {
    db.prepare('SELECT id, name, status FROM projects WHERE id IN (' + placeholders(part) + ')')
      .all(part)
      .forEach(function (r) {
        projName[mappers.toStr(r.id)] = mappers.toStr(r.name) || agg.UNNAMED_PROJECT;
        projStatus[mappers.toStr(r.id)] = mappers.toStr(r.status);
      });
  });

  /* ① 周报动态：上周（week=上周周码）范围内项目周报，提交优先、提交/更新倒序 */
  const reports = [];
  chunk(ids, SQL_IN_CHUNK).forEach(function (part) {
    db.prepare(
      'SELECT id, project_id, author_name, status, submitted_at, done_note, updated_at '
      + 'FROM work_reports WHERE project_id IN (' + placeholders(part) + ') AND week = ? '
      + 'ORDER BY (CASE WHEN submitted_at IS NULL THEN 1 ELSE 0 END), submitted_at DESC, updated_at DESC',
    )
      .all(part.concat([week]))
      .forEach(function (r) {
        reports.push({
          id: mappers.toStr(r.id),
          projectId: mappers.toStr(r.project_id),
          projectName: projName[mappers.toStr(r.project_id)] || agg.UNNAMED_PROJECT,
          authorName: mappers.toStr(r.author_name),
          status: mappers.toStr(r.status, '草稿'),
          submittedAt: mappers.toStr(r.submitted_at),
          updatedAt: mappers.toStr(r.updated_at),
          summary: mappers.toStr(r.done_note),
        });
      });
  });

  /* ①.5 周报任务进度明细：work_report_tasks 中 selected=1（周报勾选的关键任务）逐条补齐到周报上 */
  const reportIds = reports.map(function (r) { return r.id; });
  if (reportIds.length) {
    const rowsByReport = {};
    chunk(reportIds, SQL_IN_CHUNK).forEach(function (part) {
      db.prepare(
        'SELECT report_id, node_code, node_name, progress_before, progress_after '
        + 'FROM work_report_tasks WHERE report_id IN (' + placeholders(part) + ') AND selected = 1',
      )
        .all(part)
        .forEach(function (r) {
          if (!rowsByReport[r.report_id]) rowsByReport[r.report_id] = [];
          rowsByReport[r.report_id].push({
            nodeCode: mappers.toStr(r.node_code),
            nodeName: mappers.toStr(r.node_name),
            progressBefore: mappers.toNum(r.progress_before, 0),
            progressAfter: mappers.toNum(r.progress_after, 0),
          });
        });
    });
    reports.forEach(function (r) { r.taskRows = rowsByReport[r.id] || []; });
  } else {
    reports.forEach(function (r) { r.taskRows = []; });
  }

  /* ①.6 上周未提交周报的项目（应填口径=进行中，与 countReportFill 一致；week=上周周码） */
  const activeIds = ids.filter(function (id) { return projStatus[id] === '进行中'; });
  const filledLastWeek = {};
  chunk(activeIds, SQL_IN_CHUNK).forEach(function (part) {
    db.prepare(
      'SELECT DISTINCT project_id FROM work_reports WHERE project_id IN ('
      + placeholders(part) + ') AND week = ? AND status = ?',
    )
      .all(part.concat([week, '已提交']))
      .forEach(function (r) { filledLastWeek[mappers.toStr(r.project_id)] = true; });
  });
  const missing = activeIds
    .filter(function (id) { return !filledLastWeek[id]; })
    .map(function (id) {
      return { projectId: id, projectName: projName[id] || agg.UNNAMED_PROJECT };
    })
    .sort(function (a, b) { return agg.compareText(a.projectName, b.projectName); });

  /* ② 上周任务进展：**真叶子**（leafNodesOf，含已完成）且 updated_at 落在 [上周一, 本周一)。
     不用 `node_type='task'` 直滤——父节点 node_type 也是 task（实测 9 个有子父任务），会混入汇总行；
     `collectScopeLeafTasks` 复用总览同款全量拉取 + 项目分组判叶子，口径与看板卡片一致。 */
  const tasks = collectScopeLeafTasks(db, ids, true)
    .filter(function (n) { return n.updatedAt >= lastStartIso && n.updatedAt < thisWeekStartIso; })
    .sort(function (a, b) {
      return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
    })
    .map(function (n) {
      const st = mappers.toStr(n.status, '待办');
      return {
        id: n.id,
        projectId: n.projectId,
        projectName: projName[n.projectId] || agg.UNNAMED_PROJECT,
        wbsCode: n.wbsCode,
        name: n.name,
        ownerName: n.ownerName || '',
        status: st,
        progress: mappers.toNum(n.progress, 0),
        updatedAt: n.updatedAt,
        done: st === '完成',
      };
    });

  /* ③ 上周达成里程碑：done_at（YYYY-MM-DD）落在上周区间 [上周一, 上周日] */
  const milestones = [];
  chunk(ids, SQL_IN_CHUNK).forEach(function (part) {
    db.prepare(
      'SELECT id, project_id, name, done_at '
      + 'FROM milestones WHERE project_id IN (' + placeholders(part) + ') '
      + 'AND done_at IS NOT NULL AND done_at >= ? AND done_at <= ? '
      + 'ORDER BY done_at DESC',
    )
      .all(part.concat([lastStart, lastEnd]))
      .forEach(function (r) {
        milestones.push({
          id: mappers.toStr(r.id),
          projectId: mappers.toStr(r.project_id),
          projectName: projName[mappers.toStr(r.project_id)] || agg.UNNAMED_PROJECT,
          name: mappers.toStr(r.name),
          doneAt: mappers.toStr(r.done_at),
        });
      });
  });

  /* ④ D03 任务进度环比：上周 vs 前周全量快照（progress_snapshots，周报提交时采集） */
  const prevWeek = dates.weekCode(dates.addDays(dates.today(), -14));
  const snapByWeek = function (wk) {
    const map = {}; // objectId -> {progress, status, wbsCode, name, projectId}
    chunk(ids, SQL_IN_CHUNK).forEach(function (part) {
      db.prepare(
        'SELECT s.object_id, s.progress, s.status, n.wbs_code, n.name, n.project_id '
        + 'FROM progress_snapshots s JOIN wbs_nodes n ON n.id = s.object_id '
        + 'WHERE s.project_id IN (' + placeholders(part) + ") AND s.object_type = 'task' AND s.week = ?",
      )
        .all(part.concat([wk]))
        .forEach(function (r) {
          map[mappers.toStr(r.object_id)] = {
            progress: mappers.toNum(r.progress, 0),
            status: mappers.toStr(r.status),
            wbsCode: mappers.toStr(r.wbs_code),
            name: mappers.toStr(r.name),
            projectId: mappers.toStr(r.project_id),
          };
        });
    });
    return map;
  };
  const prevSnap = snapByWeek(prevWeek);
  const lastSnap = snapByWeek(week);

  const deltaTasks = [];
  Object.keys(lastSnap).forEach(function (objectId) {
    const ls = lastSnap[objectId];
    const ps = prevSnap[objectId];
    const added = !ps;
    const prevProgress = added ? -1 : ps.progress;
    const progress = ls.progress;
    const delta = added ? 0 : progress - prevProgress;
    if (!added && delta === 0) return; // 只看有实质变化的（新增 / 推进 / 回退 / 完成）
    deltaTasks.push({
      nodeId: objectId,
      wbsCode: ls.wbsCode,
      name: ls.name,
      projectId: ls.projectId,
      projectName: projName[ls.projectId] || agg.UNNAMED_PROJECT,
      prevProgress: prevProgress, // -1 = 前周无快照（新增任务）
      progress: progress,
      delta: delta,
      done: ls.status === '完成' || progress >= 100,
      added: added,
    });
  });
  deltaTasks.sort(function (a, b) { return b.delta - a.delta; });
  const delta = {
    prevWeek: prevWeek,
    tasks: deltaTasks.slice(0, 50),
    advancedCount: deltaTasks.filter(function (t) { return t.delta > 0; }).length,
    completedCount: deltaTasks.filter(function (t) { return t.done; }).length,
    addedCount: deltaTasks.filter(function (t) { return t.added; }).length,
    netPoints: deltaTasks.reduce(function (s, t) { return s + (t.delta > 0 ? t.delta : 0); }, 0),
  };

  /* ⑤ D03 里程碑双周对比：done_at 落在 [前周一, 前周日] 的达成数（上周达成 = milestones.length） */
  const prevRange = dates.weekRange(prevWeek);
  const prevStart = prevRange.start.slice(0, 10);
  const prevEnd = prevRange.end.slice(0, 10);
  let prevDone = 0;
  chunk(ids, SQL_IN_CHUNK).forEach(function (part) {
    prevDone += db
      .prepare(
        'SELECT COUNT(*) c FROM milestones WHERE project_id IN (' + placeholders(part) + ') '
        + 'AND done_at IS NOT NULL AND done_at >= ? AND done_at <= ?',
      )
      .get(part.concat([prevStart, prevEnd])).c;
  });
  const milestoneCompare = { prevWeek: prevWeek, prevDone: prevDone, lastDone: milestones.length };

  return {
    week: week,
    reports: reports,
    tasks: tasks,
    milestones: milestones,
    missing: missing,
    delta: delta,
    milestoneCompare: milestoneCompare,
  };
}

/**
 * 任务负责人选项池（D01.5 · 全局总览「负责人」下拉数据源）。
 *
 * 选项 = 范围内项目的**真叶子任务**（无子节点）负责人去重，姓名来自 users 表；
 * 基于「scope + 决策⑥ 在管三态」的项目集计算（调用方传未过滤 ownerOpenId 的项目 id），
 * 保证选中后下拉选项不随其他筛选漂移。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string>} projectIds 范围内项目 id
 * @returns {Array<{openId: string, name: string}>} 按姓名升序
 */
function computeOwnerOptions(db, projectIds) {
  const ids = (projectIds || []).map(String).filter(Boolean);
  if (!ids.length) return [];

  const map = {}; // openId → name（先到先得）
  chunk(ids, SQL_IN_CHUNK).forEach(function (part) {
    db.prepare(
      'SELECT DISTINCT w.owner AS open_id, u.name AS user_name '
      + 'FROM wbs_nodes w '
      + 'LEFT JOIN users u ON u.open_id = w.owner '
      + 'WHERE w.project_id IN (' + placeholders(part) + ') '
      + "AND w.owner IS NOT NULL AND w.owner != '' "
      + 'AND NOT EXISTS (SELECT 1 FROM wbs_nodes c WHERE c.parent_id = w.id)',
    )
      .all(part)
      .forEach(function (r) {
        if (map[r.open_id] === undefined) {
          map[r.open_id] = r.user_name || mappers.REMOVED_USER_NAME;
        }
      });
  });

  return Object.keys(map)
    .map(function (openId) { return { openId: openId, name: map[openId] }; })
    .sort(function (a, b) { return agg.compareText(a.name, b.name); });
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
  /* 全量叶子（含已完成）· 同一批 wbs_nodes SELECT，零额外 SQL（B17 状态分布口径） */
  const allLeafTasks = listScopeAllLeafTasks(db, projectIds);
  /* 在办叶子（既有口径逐字不变：所有既有聚合继续用 tasks） */
  const tasks = allLeafTasks.filter(function (n) { return n.status !== '完成'; });

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

  /* B17 追加三张分布图（放在 overdueTasks 之后） */
  const priorityDist = agg.aggregatePriorityDist(tasks);           // 在办叶子
  const statusDist = agg.aggregateStatusDist(allLeafTasks);        // 全量叶子（含已完成）
  const overdueDuration = agg.aggregateOverdueDuration(tasks, todayStr); // 在办叶子

  /* 周报：只有「进行中」且「本周有未完成叶子任务计划窗口相交」的项目才需填（与工作台提醒同一口径） */
  const activeIds = items
    .filter(function (p) { return p.status === '进行中'; })
    .map(function (p) { return String(p.id); });
  const fill = countReportFill(db, activeIds);

  /* D11：门控 / 交付物 / 周报闭环聚合（输入 = 范围内项目 id，继承 scope / 决策⑥） */
  const gates = aggregateGates(db, projectIds);
  const deliverables = aggregateDeliverables(db, projectIds);
  const reportClosure = countReportClosure(db, projectIds);

  /* 第一批：近 30 天到期里程碑（未完成 & 有计划日期 & ≤ 今天+30，分段 已过期/未来30天） */
  const milestoneDue = aggregateMilestones(db, projectIds);

  const reportMissing = fill.missingIds.map(function (id) {
    return {
      projectId: id,
      projectName: nameById[id] || agg.UNNAMED_PROJECT,
      pmName: pmById[id] || projectService.NO_PM_PLACEHOLDER,
    };
  });

  /* D01：上周工作进展（周报动态 / 任务进展 / 达成里程碑），与全局总览同源同范围 */
  const weeklyProgress = computeWeeklyProgress(db, projectIds);

  /* D01.5：任务负责人选项池（基于「忽略 ownerOpenId 过滤」的范围项目集，选项不随筛选漂移） */
  const optionRows = listScopedRows(db, Object.assign({}, q, { ownerOpenId: '' }), me, scope);
  const ownerOptions = computeOwnerOptions(db, optionRows.map(function (r) { return String(r.id); }));

  const overdueByProject = {};
  overdue.forEach(function (r) { overdueByProject[r.projectId] = r.overdue; });

  const sorted = sortItems(items, q.sort, overdueByProject);
  const start = (q.page - 1) * q.pageSize;

  /* 第三批：分页项注入 milestoneDue（明细表「近 30 天到期」列数据源；只给前端渲染用，total 仍为 items.length） */
  const dueMap = milestoneDue.byProject || {};
  const pageItems = sorted.slice(start, start + q.pageSize).map(function (p) {
    return Object.assign({}, p, { milestoneDue: dueMap[String(p.id)] || { total: 0, overdue: 0, upcoming: 0 } });
  });

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
      /* D11：周报闭环（范围内待确认周报数 + 已闭环率） */
      pendingReportConfirm: reportClosure.submitted,
      reportClosureRate: reportClosure.closureRate,
      averageProgress: agg.averageProgress(items),
    },
    statusDonut: statusDonut,
    health: health,
    priorityDist: priorityDist,
    statusDist: statusDist,
    overdueDuration: overdueDuration,
    /* D11：门控总览 / 交付物总览（聚合结果，前端构造分布图段） */
    gates: gates,
    deliverables: deliverables,
    /* 第一批：近 30 天到期里程碑（已过期 / 未来 30 天分段） */
    milestones: milestoneDue,
    overdue: overdue,
    ownerLoad: ownerLoad,
    reportMissing: reportMissing,
    weeklyProgress: weeklyProgress,
    ownerOptions: ownerOptions,
    projects: paged(pageItems, items.length, q.page, q.pageSize),
  };
}

/**
 * B18：分布图点档下钻任务明细（GET /api/dashboard/tasks）。
 *
 * 与 getDashboardOverview 同源同口径：
 *  - normalizeQuery / resolveScope / listScopedItems 全部复用（scope / 筛选 / 决策 ⑥ / 权限降级逐字一致；
 *    q.sort 忽略，本接口排序固定）；
 *  - 行字段 = toApiWbsNode 派生 + projectName 映射补齐（缺失回落 UNNAMED_PROJECT）。
 *
 * 基数规则（PRD P0-6）：
 *  - taskStatus 命中 → 范围内**全量叶子（含已完成）**（listScopeAllLeafTasks）——「完成」档可出数；
 *  - 否则 → 范围内**在办叶子**（listScopeLeafTasks），再按 priority / overdueBucket 过滤；
 *  - 均未传维度 → 返回范围内全部在办叶子任务分页。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} query req.query（DashboardTasksQuery）
 * @param {object} me users 行（requireAuth 挂载）
 * @returns {{items: Array<object>, total: number, page: number, pageSize: number}}
 */
function getDashboardTasks(db, query, me) {
  const q = normalizeQuery(query);
  const scope = resolveScope(me, q.scope);
  const todayStr = dates.today();

  const items = listScopedItems(db, q, me, scope);  // ProjectListItem[]（含 name）
  const projectIds = items.map(function (p) { return String(p.id); });

  const dim = resolveDimension(query);              // { kind, value }

  /* 基数：taskStatus → 全量叶子（含已完成）；否则 → 在办叶子 */
  const base = dim.kind === 'taskStatus'
    ? listScopeAllLeafTasks(db, projectIds)
    : listScopeLeafTasks(db, projectIds);

  /* projectId → projectName（范围内项目名，缺失回落未命名项目） */
  const nameById = {};
  items.forEach(function (p) { nameById[String(p.id)] = String(p.name || '') || agg.UNNAMED_PROJECT; });

  const rows = base
    .filter(function (n) {
      if (dim.kind === 'taskStatus') return n.status === dim.value;
      if (dim.kind === 'priority') return normalizePriorityValue(n.priority) === dim.value;
      if (dim.kind === 'overdueBucket') return agg.overdueBucketOf(todayStr, n.dueDate) === dim.value;
      return true;
    })
    .map(function (n) {
      return {
        id: n.id,
        projectId: n.projectId,
        projectName: nameById[String(n.projectId)] || agg.UNNAMED_PROJECT,
        wbsCode: n.wbsCode,
        name: n.name,
        priority: normalizePriorityValue(n.priority),
        status: n.status,
        dueDate: n.dueDate,
        progress: n.progress,
        ownerName: n.ownerName || '',
      };
    })
    .sort(function (a, b) {
      /* 排序固定（PRD P0-8）：优先级 P0→P3 → 截止日升序（空 dueDate 恒最后）→ 名称升序 */
      const RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
      const ra = RANK[a.priority] !== undefined ? RANK[a.priority] : 2; // 防御：脏值按 P2
      const rb = RANK[b.priority] !== undefined ? RANK[b.priority] : 2;
      if (ra !== rb) return ra - rb;
      const da = String(a.dueDate || '');
      const dbv = String(b.dueDate || '');
      if (!da !== !dbv) return da ? -1 : 1;        // 无截止日恒最后
      if (da !== dbv) return da < dbv ? -1 : 1;
      return agg.compareText(a.name, b.name);
    });

  const start = (q.page - 1) * q.pageSize;
  return paged(rows.slice(start, start + q.pageSize), rows.length, q.page, q.pageSize);
}

/**
 * 质量门明细（第二批 · 全局总览「质量与交付」下探）。
 *
 * 与 getDashboardTasks 同源同口径：normalizeQuery / resolveScope / listScopedItems 全部复用
 * （scope / 筛选 / 决策⑥ / 权限降级逐字一致）。行 = 门 × 项目 × 里程碑 × 决议人。
 * 过滤：`gateStatus`（五态白名单）命中 → 只返回该状态的门；未传 → 全量。
 * 排序：项目名 ↑ → 门编码 ↑。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} query req.query（DashboardGatesQuery）
 * @param {object} me users 行
 * @returns {{items: Array<object>, total: number, page: number, pageSize: number}}
 */
function getDashboardGates(db, query, me) {
  const q = normalizeQuery(query);
  const scope = resolveScope(me, q.scope);
  const items = listScopedItems(db, q, me, scope);
  const projectIds = items.map(function (p) { return String(p.id); });
  if (!projectIds.length) return paged([], 0, q.page, q.pageSize);

  const nameById = {};
  items.forEach(function (p) { nameById[String(p.id)] = String(p.name || '') || agg.UNNAMED_PROJECT; });
  const nameOf = mappers.makeNameLookup(db);

  const gateStatus = GATE_STATUSES.indexOf(String(query && query.gateStatus)) >= 0 ? String(query.gateStatus) : '';
  const rows = [];
  chunk(projectIds, SQL_IN_CHUNK).forEach(function (part) {
    const where = ['g.project_id IN (' + placeholders(part) + ')'];
    const args = part.slice();
    if (gateStatus) { where.push('g.status = ?'); args.push(gateStatus); }
    db.prepare(
      'SELECT g.id, g.project_id, g.milestone_id, g.code, g.name, g.status, g.decided_by, g.decided_at, m.name AS milestone_name '
      + 'FROM quality_gates g LEFT JOIN milestones m ON m.id = g.milestone_id '
      + 'WHERE ' + where.join(' AND '),
    )
      .all(args)
      .forEach(function (r) { rows.push(r); });
  });

  const out = rows
    .map(function (r) {
      return {
        id: mappers.toStr(r.id),
        projectId: mappers.toStr(r.project_id),
        projectName: nameById[mappers.toStr(r.project_id)] || agg.UNNAMED_PROJECT,
        milestoneId: mappers.toStr(r.milestone_id),
        milestoneName: mappers.toStr(r.milestone_name) || '未关联里程碑',
        code: mappers.toStr(r.code),
        name: mappers.toStr(r.name),
        status: mappers.toStr(r.status, '未开始'),
        decidedByName: nameOf(mappers.toStr(r.decided_by)),
        decidedAt: mappers.toStr(r.decided_at),
      };
    })
    .sort(function (a, b) {
      const c = agg.compareText(a.projectName, b.projectName);
      return c !== 0 ? c : agg.compareText(a.code, b.code);
    });

  const start = (q.page - 1) * q.pageSize;
  return paged(out.slice(start, start + q.pageSize), out.length, q.page, q.pageSize);
}

/** 交付物状态白名单（手动/链接记录恒「已交付」，模板项 待交付/已交付） */
const DOC_STATUSES = ['待交付', '已交付'];

/**
 * 交付物明细（第二批 · 全局总览「质量与交付」下探）。
 *
 * 口径同 getDashboardTasks / getDashboardGates：复用 scope / 筛选 / 决策⑥ / 权限降级。
 * 行 = 交付物 × 项目 × 上传人 × 基线信息。
 * 过滤：`docStatus`（待交付/已交付）命中 → 只返回该状态的交付物；未传 → 全量。
 * 排序：项目名 ↑ → 模板项编码 ↑（手动记录恒最后）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} query req.query（DashboardDeliverablesQuery）
 * @param {object} me users 行
 * @returns {{items: Array<object>, total: number, page: number, pageSize: number}}
 */
function getDashboardDeliverables(db, query, me) {
  const q = normalizeQuery(query);
  const scope = resolveScope(me, q.scope);
  const items = listScopedItems(db, q, me, scope);
  const projectIds = items.map(function (p) { return String(p.id); });
  if (!projectIds.length) return paged([], 0, q.page, q.pageSize);

  const nameById = {};
  items.forEach(function (p) { nameById[String(p.id)] = String(p.name || '') || agg.UNNAMED_PROJECT; });
  const nameOf = mappers.makeNameLookup(db);

  const docStatus = DOC_STATUSES.indexOf(String(query && query.docStatus)) >= 0 ? String(query.docStatus) : '';
  const rows = [];
  chunk(projectIds, SQL_IN_CHUNK).forEach(function (part) {
    const where = ['d.project_id IN (' + placeholders(part) + ')'];
    const args = part.slice();
    if (docStatus) { where.push('d.status = ?'); args.push(docStatus); }
    db.prepare(
      'SELECT d.id, d.project_id, d.template_key, d.name, d.version, d.status, d.baseline_flag, d.baselined_at, d.baselined_by, d.uploaded_by, d.uploaded_at '
      + 'FROM project_documents d WHERE ' + where.join(' AND '),
    )
      .all(args)
      .forEach(function (r) { rows.push(r); });
  });

  const out = rows
    .map(function (r) {
      return {
        id: mappers.toStr(r.id),
        projectId: mappers.toStr(r.project_id),
        projectName: nameById[mappers.toStr(r.project_id)] || agg.UNNAMED_PROJECT,
        templateKey: mappers.toStr(r.template_key),
        name: mappers.toStr(r.name),
        version: mappers.toNum(r.version, 1),
        status: mappers.toStr(r.status, '已交付'),
        baselineFlag: mappers.toNum(r.baseline_flag, 0) === 1,
        baselinedAt: mappers.toStr(r.baselined_at),
        baselinedByName: nameOf(mappers.toStr(r.baselined_by)),
        uploadedByName: nameOf(mappers.toStr(r.uploaded_by)),
        uploadedAt: mappers.toStr(r.uploaded_at),
      };
    })
    .sort(function (a, b) {
      const c = agg.compareText(a.projectName, b.projectName);
      if (c !== 0) return c;
      const ka = String(a.templateKey || '');
      const kb = String(b.templateKey || '');
      if (ka !== kb) return ka < kb ? -1 : ka > kb ? 1 : 0;
      return agg.compareText(a.name, b.name);
    });

  const start = (q.page - 1) * q.pageSize;
  return paged(out.slice(start, start + q.pageSize), out.length, q.page, q.pageSize);
}

module.exports = {
  MANAGED_STATUSES,
  OVERDUE_BUCKETS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  normalizeQuery,
  normalizePriorityValue,
  resolveScope,
  resolveDimension,
  listScopedItems,
  listScopeLeafTasks,
  listScopeAllLeafTasks,
  countReportFill,
  computeWeeklyProgress,
  computeOwnerOptions,
  aggregateGates,
  aggregateDeliverables,
  aggregateMilestones,
  countReportClosure,
  sortItems,
  getDashboardOverview,
  getDashboardTasks,
  getDashboardGates,
  getDashboardDeliverables,
};
