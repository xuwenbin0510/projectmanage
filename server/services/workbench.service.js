/**
 * 工作台聚合服务（P0-13）
 *
 * B3 已补齐「我的任务」；B10 补齐「评审 / 周报」四函数：
 *  - `listMyApprovals`     待我审批完整 Review[]（复用 review.service，同一 canDecide 口径）
 *  - `countPendingApprovals`  = listMyApprovals().length
 *  - `listReportReminders`  我参与且进行中项目，每项目一行（本周是否已提交周报）
 *  - `countMissingReports`   = 未填周报行数
 * D10 补齐「门控待办」：
 *  - `listGateTodos`       我有决议权限（global admin/pmo/qa/tl，或项目成员 qa/tl/pmo）的
 *                          未决议门（status 未开始/待检查），含项目/里程碑上下文
 *
 * ⚠ 口径（docs/B10-任务分解.md D8 / §A3.4）：
 *  - `reportReminders` 仅「我参与（project_members 含我）且 status='进行中'」的项目；
 *  - `filled` = 本周存在 `work_reports.status='已提交'`（项目级、任一成员提交即算，草稿不计）；
 *  - `week` = `dates.weekCode()`（如 `2026-W33`）；
 *  - `weekStart/weekEnd` = `dates.weekRange(week).start/end` **截前 10 位**（`YYYY-MM-DD`，
 *    与前端展示逐字一致；服务端 weekRange 返回 ISO 带时区串）。
 */

const dates = require('../lib/dates');
const mappers = require('../lib/mappers');
const wbs = require('../lib/wbs');
const reviewService = require('./review.service');
const reportService = require('./report.service');

/**
 * 我负责且未完成的真叶子任务（按 dueDate 升序，与 Mock L2069 一致）。
 *
 * 只统计我参与项目里的节点，且排除已结项 / 已终止项目（与 `listMyProjectItems` 口径一致），
 * 避免归档项目的历史任务一直挂在工作台上。
 *
 * B11（**纯字段追加**，老客户端无感）：每行挂 `projectName`。
 *   逾期柱状图要按项目分组显示名称，而 `myTasks` 可能含「草稿 / 审批中 / 挂起」项目的任务，
 *   `myProjects` 只列在办 → 前端 join 会漏，服务端直接给名字最稳。
 *   ⚠ 过滤口径（叶子判定 / owner===me / status!=='完成' / 排除归档）与排序**一字未改**。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} me 当前用户 users 行
 * @returns {Array<object>} WbsNode[]（含 B11 追加的 `projectName`）
 */
function listMyTasks(db, me) {
  const openId = String((me && (me.open_id || me.openId)) || '');
  if (!openId) return [];

  const rows = db
    .prepare(
      `SELECT n.*, p.name AS __project_name
         FROM wbs_nodes n
         JOIN projects p ON p.id = n.project_id
        WHERE p.deleted_at IS NULL
          AND p.status NOT IN ('已结项', '已终止')
          AND n.project_id IN (SELECT project_id FROM project_members WHERE user_open_id = ?)`,
    )
    .all(openId);

  /* B11：projectId → 项目名（来自同一次 JOIN，零额外查询） */
  const projectNameById = {};
  rows.forEach(function (r) {
    projectNameById[mappers.toStr(r.project_id)] = mappers.toStr(r.__project_name);
  });

  /* leafNodesOf 要在**项目全量节点**上判定，故先按项目分组再取叶子 */
  const byProject = {};
  rows.map(mappers.toApiWbsNode).forEach(function (n) {
    if (!byProject[n.projectId]) byProject[n.projectId] = [];
    byProject[n.projectId].push(n);
  });

  const mine = [];
  Object.keys(byProject).forEach(function (pid) {
    wbs.leafNodesOf(byProject[pid]).forEach(function (n) {
      if (n.owner === openId && n.status !== '完成') {
        /* B11 纯追加：不改任何既有字段，仅补 projectName */
        n.projectName = projectNameById[n.projectId] || '';
        mine.push(n);
      }
    });
  });

  return mine.sort(function (a, b) {
    const da = String(a.dueDate || '');
    const dbv = String(b.dueDate || '');
    if (da === dbv) return wbs.compareWbsCode(a.wbsCode, b.wbsCode);
    return da < dbv ? -1 : 1;
  });
}

/**
 * 已逾期任务数：`diffDays(today, dueDate) < 0`（与 Mock L2089 逐字一致）。
 * @param {Array<object>} tasks WbsNode[]
 * @returns {number}
 */
function countOverdue(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const t = dates.today();
  return list.filter(function (n) {
    return !!n.dueDate && dates.diffDays(t, n.dueDate) < 0;
  }).length;
}

/**
 * 待我审批：完整 Review[]（含 steps 供 ReviewStepper 渲染）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} me users 行
 * @returns {Array<object>} Review[]
 */
function listMyApprovals(db, me) {
  return reviewService.listMyApprovals(db, me);
}

/**
 * 待我审批数：`listMyApprovals().length`（与 myApprovals 同一 canDecide 口径）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} me users 行
 * @returns {number}
 */
function countPendingApprovals(db, me) {
  return listMyApprovals(db, me).length;
}

/**
 * 周报提醒：我参与且进行中项目，每项目一行（D8 / Mock L2352-2364）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} me users 行
 * @returns {Array<{projectId: string, projectName: string, week: string, weekStart: string, weekEnd: string, filled: boolean}>} ReportReminder[]
 */
function listReportReminders(db, me) {
  const openId = String((me && (me.open_id !== undefined ? me.open_id : me.openId)) || '');
  if (!openId) return [];

  const curWeek = dates.weekCode();
  const range = dates.weekRange(curWeek);
  const weekStart = String((range && range.start) || '').slice(0, 10);
  const weekEnd = String((range && range.end) || '').slice(0, 10);

  const rows = db
    .prepare(
      `SELECT p.id, p.name
         FROM projects p
        WHERE p.deleted_at IS NULL
          AND p.status = '进行中'
          AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_open_id = ?)
        ORDER BY p.updated_at DESC, p.id DESC`,
    )
    .all(openId);

  const filledStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM work_reports WHERE project_id = ? AND week = ? AND status = '已提交'",
  );
  const confirmedStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM work_reports WHERE project_id = ? AND week = ? AND status = '已确认'",
  );

  return rows.map(function (r) {
    const pid = mappers.toStr(r.id);
    const submitted = (filledStmt.get(pid, curWeek) || {}).c > 0;
    const confirmed = (confirmedStmt.get(pid, curWeek) || {}).c > 0;
    /* 三态：待填（无提交）/ 待确认（已提交未确认）/ 已确认（终态） */
    const state = !submitted ? '待填' : confirmed ? '已确认' : '待确认';
    return {
      projectId: pid,
      projectName: mappers.toStr(r.name),
      week: curWeek,
      weekStart: weekStart,
      weekEnd: weekEnd,
      filled: !!submitted,
      state: state,
    };
  });
}

/**
 * 本周待填周报数：`reportReminders` 中未填行数。
 * @param {import('better-sqlite3').Database} db
 * @param {object} me users 行
 * @returns {number}
 */
function countMissingReports(db, me) {
  return listReportReminders(db, me).filter(function (r) { return !r.filled; }).length;
}

/**
 * 门控待办（D10）：我有决议权限的未决议质量门。
 *
 * 权限口径（与 config/permissions.js `gate:decide` 一致）：
 *  - 全局角色 admin/pmo/qa/tl → 全部未结项项目的未决议门；
 *  - 否则 → 我以项目成员身份持有 qa/tl/pmo 角色的项目。
 *
 * 门状态口径：`status IN ('未开始','待检查')`（已通过/有条件通过/不通过为终态，不计）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} me users 行
 * @returns {Array<{gateId: string, projectId: string, projectName: string,
 *   milestoneCode: string, milestoneName: string, gateCode: string, gateName: string,
 *   ownerRole: string}>} GateTodo[]
 */
function listGateTodos(db, me) {
  const openId = String((me && (me.open_id !== undefined ? me.open_id : me.openId)) || '');
  if (!openId) return [];
  const globalRole = String((me && me.global_role) || '');
  const gateRoles = ['admin', 'pmo', 'qa', 'tl'];

  let projectIds = [];
  if (gateRoles.indexOf(globalRole) >= 0) {
    projectIds = db
      .prepare("SELECT id FROM projects WHERE deleted_at IS NULL AND status NOT IN ('已结项', '已终止')")
      .all()
      .map(function (r) { return mappers.toStr(r.id); });
  } else {
    projectIds = db
      .prepare(
        "SELECT DISTINCT pm.project_id AS pid FROM project_members pm WHERE pm.user_open_id = ? AND pm.project_role IN ('qa', 'tl', 'pmo')",
      )
      .all(openId)
      .map(function (r) { return mappers.toStr(r.pid); });
  }
  if (projectIds.length === 0) return [];

  const ph = projectIds.map(function () { return '?'; }).join(',');
  const rows = db
    .prepare(
      `SELECT g.id AS gate_id, g.project_id, g.code AS gate_code, g.name AS gate_name, g.owner_role,
              m.code AS ms_code, m.name AS ms_name, p.name AS project_name
         FROM quality_gates g
         JOIN milestones m ON m.id = g.milestone_id
         JOIN projects p ON p.id = g.project_id
        WHERE g.project_id IN (${ph})
          AND g.status IN ('未开始', '待检查')
        ORDER BY m.planned_date ASC, g.code ASC`,
    )
    .all(...projectIds);
  return rows.map(function (r) {
    return {
      gateId: mappers.toStr(r.gate_id),
      projectId: mappers.toStr(r.project_id),
      projectName: mappers.toStr(r.project_name),
      milestoneCode: mappers.toStr(r.ms_code),
      milestoneName: mappers.toStr(r.ms_name),
      gateCode: mappers.toStr(r.gate_code),
      gateName: mappers.toStr(r.gate_name),
      ownerRole: mappers.toStr(r.owner_role),
    };
  });
}

/**
 * 待我确认周报（D11）：我是确认人且状态为「已提交」的周报。
 *
 * 复用 `report.service.listPendingConfirmation`（同一 `resolveConfirmers` 口径，
 * 确认人解析单一真源，前端/工作台不重复实现）；再补 `projectName` 映射供面板展示。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} me users 行
 * @returns {Array<{id: string, projectId: string, projectName: string, week: string, authorName: string, submittedAt: string}>}
 */
function listReportConfirmations(db, me) {
  const openId = String((me && (me.open_id !== undefined ? me.open_id : me.openId)) || '');
  if (!openId) return [];
  const reports = reportService.listPendingConfirmation(db, openId);
  if (!reports.length) return [];

  const pids = reports.map(function (r) { return String(r.projectId); });
  const nameById = {};
  if (pids.length) {
    db.prepare('SELECT id, name FROM projects WHERE id IN (' + pids.map(function () { return '?'; }).join(',') + ')')
      .all(pids)
      .forEach(function (r) { nameById[mappers.toStr(r.id)] = mappers.toStr(r.name); });
  }

  return reports.map(function (r) {
    return {
      id: mappers.toStr(r.id),
      projectId: mappers.toStr(r.projectId),
      projectName: nameById[mappers.toStr(r.projectId)] || '',
      week: mappers.toStr(r.week),
      authorName: mappers.toStr(r.authorName),
      submittedAt: r.submittedAt ? String(r.submittedAt) : '',
    };
  });
}

/**
 * 待我确认周报数：`listReportConfirmations().length`（同一 resolveConfirmers 口径）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} me users 行
 * @returns {number}
 */
function countPendingConfirmations(db, me) {
  return listReportConfirmations(db, me).length;
}

module.exports = {
  listMyTasks,
  countOverdue,
  listMyApprovals,
  countPendingApprovals,
  listReportReminders,
  countMissingReports,
  listGateTodos,
  listReportConfirmations,
  countPendingConfirmations,
};
