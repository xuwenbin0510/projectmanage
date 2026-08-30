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
 * ⚠ 口径（docs/B10-任务分解.md D8 / §A3.4，2026-08-26 收窄）：
 *  - `reportReminders` 仅在「我参与（project_members 含我）且 status='进行中'」的项目中，
 *    **且我名下有 ≥1 个未完成叶子任务、其计划窗口与本周(周一~周日)相交** 才入选
 *    （无 start_date/due_date 的任务视为「有活」，恒计入，避免库内大量无日期任务整批掉出）；
 *  - `filled` = 本周存在 `work_reports.status='已提交'`（项目级、任一成员提交即算，草稿不计）；
 *  - `week` = `dates.weekCode()`（如 `2026-W35`）；
 *  - `weekStart/weekEnd` = `dates.weekRange(week).start/end` **截前 10 位**（`YYYY-MM-DD`，
 *    与前端展示逐字一致；服务端 weekRange 返回 ISO 带时区串）。
 */

const dates = require('../lib/dates');
const mappers = require('../lib/mappers');
const wbs = require('../lib/wbs');
const reviewService = require('./review.service');
const reportService = require('./report.service');
const { resolveGlobalRoles } = require('../middleware/auth');
const permissionCatalog = require('../services/permissionCatalog');

/** 待办中心「计划周期内的任务」前瞻窗口（天）：已启动或将在该天数内启动的计划任务纳入。 */
const CYCLE_LOOKAHEAD_DAYS = 14;

/**
 * 我负责的真叶子任务（基础集合，不排序）。
 *
 * 过滤口径：我参与项目 + 未结项/未终止 + 叶子 + owner===我。
 * `includeCompleted=true` 时包含 `status='完成'`（供「我的任务进度」环的「已完成」段），
 * 否则仅未完成任务（与 `listMyTasks`/`listMyCycleTasks` 旧行为一致）。
 *
 * B11（**纯字段追加**，老客户端无感）：每行挂 `projectName`（供逾期柱状图按项目分组）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} me 当前用户 users 行
 * @param {boolean} [includeCompleted=false] 是否包含已完成任务
 * @returns {Array<object>} WbsNode[]（含 B11 追加的 `projectName`）
 */
function baseMyTasks(db, me, includeCompleted) {
  const myId = me && me.id != null ? me.id : '';
  if (!myId) return [];

  const rows = db
    .prepare(
      `SELECT n.*, p.name AS __project_name
         FROM wbs_nodes n
         JOIN projects p ON p.id = n.project_id
        WHERE p.deleted_at IS NULL
          AND p.status NOT IN ('已结项', '已终止')
          AND n.project_id IN (SELECT project_id FROM project_members WHERE member_user_id = ?)`,
    )
    .all(myId);

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
      if (n.ownerUserId === myId && (includeCompleted || n.status !== '完成')) {
        /* B11 纯追加：不改任何既有字段，仅补 projectName */
        n.projectName = projectNameById[n.projectId] || '';
        mine.push(n);
      }
    });
  });
  return mine;
}

/** 按 dueDate 升序（同截止按 wbsCode 升序） */
function compareByDueDate(a, b) {
  const da = String(a.dueDate || '');
  const dbv = String(b.dueDate || '');
  if (da === dbv) return wbs.compareWbsCode(a.wbsCode, b.wbsCode);
  return da < dbv ? -1 : 1;
}

/**
 * 我负责且未完成的真叶子任务（全部，供工作台「我的任务」全景 / 逾期 / 阻塞派生）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} me 当前用户 users 行
 * @returns {Array<object>} WbsNode[]（含 B11 追加的 `projectName`）
 */
function listMyTasks(db, me) {
  return baseMyTasks(db, me).sort(compareByDueDate);
}

/**
 * 我负责且**已完成**的真叶子任务（与 `listMyTasks` 互补，供「我的任务进度」环的「已完成」段）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} me 当前用户 users 行
 * @returns {Array<object>} WbsNode[]（含 B11 追加的 `projectName`）
 */
function listMyCompletedTasks(db, me) {
  return baseMyTasks(db, me, true)
    .filter((n) => n.status === '完成')
    .sort(compareByDueDate);
}

/**
 * 计划周期内的任务：owner===我 & 未完成 & 叶子 & 处于计划执行窗口。
 *
 * 口径（与待办中心「计划周期内的任务」对齐）：
 *  - 必须有计划截止日（dueDate），否则无法判定是否在周期内；
 *  - 未逾期（dueDate >= 今天）—— 已逾期由 OVERDUE 源单独兜；
 *  - 已开始（startDate 为空视为已纳入）或 startDate <= 今天 + CYCLE_LOOKAHEAD_DAYS，
 *    即「当前正在推进 或 近 CYCLE_LOOKAHEAD_DAYS 天内将启动」的计划任务。
 *
 * 与 `listMyTasks`（我名下全部未完成）区别：本函数只返回「按计划当下/近期该推进」的聚焦子集，
 * 避免待办中心与工作台「我的任务」全景重复列全量积压。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} me 当前用户 users 行
 * @returns {Array<object>} WbsNode[]（含 projectName）
 */
function listMyCycleTasks(db, me) {
  const horizon = dates.addDays(dates.today(), CYCLE_LOOKAHEAD_DAYS);
  return baseMyTasks(db, me)
    .filter(function (n) {
      if (!n.dueDate) return false;                                  // 无计划截止 → 不纳入周期
      if (dates.diffDays(dates.today(), n.dueDate) < 0) return false; // 已逾期 → 归 OVERDUE 源
      if (n.startDate && dates.diffDays(n.startDate, horizon) < 0) return false; // 启动晚于 horizon → 尚未进入周期
      return true;
    })
    .sort(compareByDueDate);
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
 * 周报提醒：我参与且进行中、且我名下有「本周计划窗口内未完成叶子任务」的项目，每项目一行。
 *
 * 入选门控（2026-08-26 收窄，与 dashboard `countReportFill` 同源）：
 *  - 基础：我参与（project_members 含我）且 status='进行中'；
 *  - 任务门控：我名下 ≥1 个未完成（status!='完成'）叶子任务，其计划窗口与本周(周一~周日)相交；
 *  - 计划窗口相交判定：无日期任务恒计入（视为「有活」），否则 start_date<=weekEnd 且 due_date>=weekStart。
 *
 * 四态口径（与「待我确认周报」面板共用 resolveConfirmers 单一真源）：
 *  - `待填`：本周无「已提交」周报；
 *  - `待确认`：本周已提交未确认，且**当前用户是该周报确认人**；
 *  - `待他人确认`：本周已提交未确认，但当前用户**不是**确认人（中性态，无操作入口）；
 *  - `已确认`：本周已有「已确认」周报（终态）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} me users 行
 * @returns {Array<{projectId: string, projectName: string, week: string, weekStart: string, weekEnd: string, filled: boolean, state: string, tasks: Array<{id:string, wbsCode:string, name:string, startDate:string, dueDate:string, status:string, progress:number}>}>} ReportReminder[]
 */
function listReportReminders(db, me) {
  const myId = me && me.id != null ? me.id : '';
  const meOpenId = me && me.open_id ? String(me.open_id) : '';
  if (!myId) return [];

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
          AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.member_user_id = ?)
          AND EXISTS (
            SELECT 1 FROM wbs_nodes w
             WHERE w.project_id = p.id
               AND w.owner_user_id = ?
               AND w.status != '完成'
               AND NOT EXISTS (SELECT 1 FROM wbs_nodes c WHERE c.parent_id = w.id)
               AND (
                 (w.start_date IS NULL AND w.due_date IS NULL)
                 OR (w.start_date IS NULL AND date(w.due_date) >= date(?))
                 OR (w.due_date IS NULL AND date(w.start_date) <= date(?))
                 OR (date(w.start_date) <= date(?) AND date(w.due_date) >= date(?))
               )
          )
        ORDER BY p.updated_at DESC, p.id DESC`,
    )
    .all(myId, myId, weekStart, weekEnd, weekStart, weekEnd);

  const filledStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM work_reports WHERE project_id = ? AND week = ? AND status = '已提交'",
  );
  const confirmedStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM work_reports WHERE project_id = ? AND week = ? AND status = '已确认'",
  );
  /* 已提交未确认时取作者，用于确认人判定（resolveConfirmers 单一真源，与「待我确认周报」面板一致） */
  const authorStmt = db.prepare(
    "SELECT author_open_id FROM work_reports WHERE project_id = ? AND week = ? AND status = '已提交' LIMIT 1",
  );
  /* 命中任务：与入选门控同源——我名下、未完成叶子、计划窗口∩本周；仅用于前端「周报提醒」下钻展示 */
  const taskStmt = db.prepare(
    `SELECT id, wbs_code, name, start_date, due_date, status, progress
       FROM wbs_nodes w
      WHERE w.project_id = ?
        AND w.owner_user_id = ?
        AND w.status != '完成'
        AND NOT EXISTS (SELECT 1 FROM wbs_nodes c WHERE c.parent_id = w.id)
        AND (
          (w.start_date IS NULL AND w.due_date IS NULL)
          OR (w.start_date IS NULL AND date(w.due_date) >= date(?))
          OR (w.due_date IS NULL AND date(w.start_date) <= date(?))
          OR (date(w.start_date) <= date(?) AND date(w.due_date) >= date(?))
        )
      ORDER BY (CASE WHEN w.due_date IS NULL THEN 1 ELSE 0 END), w.due_date ASC, w.wbs_code ASC`,
  );

  return rows.map(function (r) {
    const pid = mappers.toStr(r.id);
    const submitted = (filledStmt.get(pid, curWeek) || {}).c > 0;
    const confirmed = (confirmedStmt.get(pid, curWeek) || {}).c > 0;
    let state;
    if (!submitted) {
      state = '待填';
    } else if (confirmed) {
      state = '已确认';
    } else {
      /* 已提交未确认：仅当「我是确认人」才标「待确认」，否则标中性「待他人确认」
         （避免非确认人看到「待确认」暗示去确认，却与「待我确认周报」面板为空矛盾） */
      const authorRow = authorStmt.get(pid, curWeek);
      const authorUserId = authorRow ? authorRow.author_user_id : null;
      const isConfirmer = authorUserId != null
        ? reportService.resolveConfirmers(db, pid, authorUserId).has(Number(myId))
        : false;
      state = isConfirmer ? '待确认' : '待他人确认';
    }
    const tasks = taskStmt
      .all(pid, myId, weekStart, weekEnd, weekStart, weekEnd)
      .map(function (t) {
        return {
          id: mappers.toStr(t.id),
          wbsCode: mappers.toStr(t.wbs_code),
          name: mappers.toStr(t.name),
          startDate: t.start_date ? String(t.start_date).slice(0, 10) : '',
          dueDate: t.due_date ? String(t.due_date).slice(0, 10) : '',
          status: mappers.toStr(t.status),
          progress: mappers.toNum(t.progress, 0),
        };
      });
    return {
      projectId: pid,
      projectName: mappers.toStr(r.name),
      week: curWeek,
      weekStart: weekStart,
      weekEnd: weekEnd,
      filled: !!submitted,
      state: state,
      tasks: tasks,
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
  const myId = me && me.id != null ? me.id : '';
  if (!myId) return [];
  // E1.5：全局职位取并集，任一命中门控特权角色即可看全公司待决门
  // 门控特权角色从权限矩阵动态取（单一权威源，避免硬编码漏判管理员调整的职位体系）
  const globalRoles = resolveGlobalRoles(me);
  // 门控特权角色从权限矩阵动态取（单一权威源，与 B19 RBAC 同口径；后台改矩阵即时跟随）
  const gateAllowed = permissionCatalog.rolesFor('gate:decide').roles || [];

  let projectIds = [];
  if (gateAllowed.length > 0 && globalRoles.some(function (r) { return gateAllowed.indexOf(r) >= 0; })) {
    // 用户持有 gate:decide 的全局角色 → 看全公司未结项项目的待决门
    projectIds = db
      .prepare("SELECT id FROM projects WHERE deleted_at IS NULL AND status NOT IN ('已结项', '已终止')")
      .all()
      .map(function (r) { return mappers.toStr(r.id); });
  } else if (gateAllowed.length > 0) {
    // 项目视角：按用户在该项目内持有的 gate:decide 角色过滤
    const ph = gateAllowed.map(function () { return '?'; }).join(',');
    projectIds = db
      .prepare(
        "SELECT DISTINCT pm.project_id AS pid FROM project_members pm WHERE pm.member_user_id = ? AND pm.project_role IN (" + ph + ")",
      )
      .all(myId, ...gateAllowed.map(function (r) { return String(r); }))
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
  const meId = me && me.id != null ? Number(me.id) : null;
  if (!meId) return [];
  const reports = reportService.listPendingConfirmation(db, meId);
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
  listMyCompletedTasks,
  listMyCycleTasks,
  countOverdue,
  listMyApprovals,
  countPendingApprovals,
  listReportReminders,
  countMissingReports,
  listGateTodos,
  listReportConfirmations,
  countPendingConfirmations,
};
