/**
 * 工作台路由（P0-13）
 *
 *  GET /api/workbench → WorkbenchData
 *
 * B10（R3）：`stats.pendingApprovals` / `stats.missingReports` / `myApprovals` /
 * `reportReminders` 全部接真数据；`myProjects` / `myTasks` / `overdueTasks` 已真实不动。
 *
 * 口径（docs/B10-任务分解.md §A3.4）：
 *  - `pendingApprovals === myApprovals.length`（同一 canDecide 判定）
 *  - `missingReports === reportReminders 未填数`
 *  - `reportReminders` 每「我参与且进行中」项目一行（week / weekStart / weekEnd / filled）
 *
 * B11（仪表盘）：`myTasks[]` **纯追加** `projectName` 字段（所属项目名，见
 * `workbench.service.js#listMyTasks`），供工作台「逾期柱状图」按项目分组展示。
 * 本路由**代码零改动**（透传 service 返回），结构与既有字段一字未变，老客户端无感。
 *
 * 注意返回结构必须字段齐全，缺字段会让前端 `data.stats.xxx` 取到 undefined 后渲染 NaN。
 */

const express = require('express');

const db = require('../../db');
const { ok, paged, asyncHandler } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const projectService = require('../services/project.service');
const workbenchService = require('../services/workbench.service');
const dashboardService = require('../services/dashboard.service');
const mappers = require('../lib/mappers');

const router = express.Router();

/* 工作台下钻：复用 listMyProjectItems 取「我参与项目」id（与卡片 aggregateDeliverables/countReportClosure 完全同源），
 * 避免复用全局总览的 listScopedItems（其在管三态过滤导致「卡片 vs 抽屉」对不上）。
 * 见 WorkbenchPage 两张快捷卡修复（feat/workbench-cards-fix）。 */

/** SQL IN 占位符 */
function placeholders(arr) {
  return arr.map(function () { return '?'; }).join(',');
}
/** 按 50 一組切分，避免 IN 子句过长 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

router.get(
  '/workbench',
  requireAuth,
  asyncHandler(async function getWorkbench(req, res) {
    const myProjects = projectService.listMyProjectItems(db, req.user);
    const myTasks = workbenchService.listMyTasks(db, req.user);
    const myCompletedTasks = workbenchService.listMyCompletedTasks(db, req.user);
    const myCycleTasks = workbenchService.listMyCycleTasks(db, req.user);
    const myApprovals = workbenchService.listMyApprovals(db, req.user);
    const reportReminders = workbenchService.listReportReminders(db, req.user);
    const gateTodos = workbenchService.listGateTodos(db, req.user);
    const reportConfirmations = workbenchService.listReportConfirmations(db, req.user);

    /* 工作台补「交付物已交付率 / 周报闭环率」两张快捷卡（范围=我的项目，与 myTasks/myApprovals 口径一致） */
    const myProjectIds = myProjects.map(function (p) { return p.id; });
    const deliverables = dashboardService.aggregateDeliverables(db, myProjectIds);
    const reportClosure = dashboardService.countReportClosure(db, myProjectIds);

    res.json(
      ok({
        stats: {
          pendingApprovals: myApprovals.length,
          overdueTasks: workbenchService.countOverdue(myTasks),
          missingReports: reportReminders.filter(function (r) { return !r.filled; }).length,
          /* D10：门控待办数（= gateTodos.length，同一 listGateTodos 口径） */
          pendingGates: gateTodos.length,
          /* D11：待我确认周报数（= reportConfirmations.length，同一 resolveConfirmers 口径） */
          pendingConfirmations: reportConfirmations.length,
        },
        myProjects: myProjects,
        myTasks: myTasks,
        /* Q4：我负责的已完成叶子任务（供「我的任务进度」环「已完成」段，不进入「我的任务」列表/逾期派生） */
        completedTasks: myCompletedTasks,
        myCycleTasks: myCycleTasks,
        myApprovals: myApprovals,
        reportReminders: reportReminders,
        gateTodos: gateTodos,
        reportConfirmations: reportConfirmations,
        /* 工作台快捷卡数据（与全局总览同源聚合，复用 dashboard.service） */
        deliverables: deliverables,
        reportClosure: reportClosure,
      }),
    );
  }),
);

/**
 * 工作台交付物明细下钻（与「交付物已交付率」卡片同源：均基于 listMyProjectItems）。
 * GET /api/workbench/deliverables?docStatus=&page=&pageSize=
 * 返回 { items: DashboardDeliverableRow[], total }，分页。
 */
router.get(
  '/workbench/deliverables',
  requireAuth,
  asyncHandler(async function getWorkbenchDeliverables(req, res) {
    const myProjects = projectService.listMyProjectItems(db, req.user);
    const projectIds = myProjects.map(function (p) { return String(p.id); });
    const nameById = {};
    myProjects.forEach(function (p) { nameById[String(p.id)] = String(p.name || '') || '未命名项目'; });

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '8'), 10) || 8));
    const docStatus = req.query.docStatus === '已交付' || req.query.docStatus === '待交付' ? String(req.query.docStatus) : '';

    if (!projectIds.length) {
      res.json(paged([], 0, page, pageSize));
      return;
    }

    const nameOf = mappers.makeNameLookup(db);
    const allRows = [];
    chunk(projectIds, 50).forEach(function (part) {
      let sql = 'SELECT * FROM project_documents WHERE project_id IN (' + placeholders(part) + ')';
      const params = part.slice();
      if (docStatus) { sql += ' AND status = ?'; params.push(docStatus); }
      sql += ' ORDER BY created_at DESC';
      db.prepare(sql).all(params).forEach(function (r) {
        allRows.push({
          id: String(r.id),
          projectId: String(r.project_id),
          projectName: nameById[String(r.project_id)] || '未命名项目',
          templateKey: String(r.template_key || ''),
          name: String(r.name || ''),
          version: mappers.toNum(r.version, 1),
          status: r.status === '已交付' ? '已交付' : '待交付',
          baselineFlag: !!mappers.toNum(r.baseline_flag, 0),
          baselinedAt: r.baselined_at ? String(r.baselined_at) : '',
          baselinedByName: r.baselined_by ? nameOf(String(r.baselined_by)) : '',
          uploadedByName: r.uploaded_by ? nameOf(String(r.uploaded_by)) : '',
          uploadedAt: r.uploaded_at ? String(r.uploaded_at) : '',
        });
      });
    });

    res.json(ok(paged(allRows, allRows.length, page, pageSize)));
  }),
);

/**
 * 工作台周报闭环下钻（与「周报闭环率」卡片同源：均基于 listMyProjectItems）。
 * GET /api/workbench/report-closure
 * 返回 { submitted, confirmed, closureRate, items: [{projectId, projectName, submitted, confirmed, rate}] }。
 */
router.get(
  '/workbench/report-closure',
  requireAuth,
  asyncHandler(async function getWorkbenchReportClosure(req, res) {
    const myProjects = projectService.listMyProjectItems(db, req.user);
    const projectIds = myProjects.map(function (p) { return String(p.id); });
    const nameById = {};
    myProjects.forEach(function (p) { nameById[String(p.id)] = String(p.name || '') || '未命名项目'; });

    if (!projectIds.length) {
      res.json(ok({ submitted: 0, confirmed: 0, closureRate: 0, items: [] }));
      return;
    }

    const cntByProject = {};
    projectIds.forEach(function (id) { cntByProject[id] = { submitted: 0, confirmed: 0 }; });
    let submitted = 0;
    let confirmed = 0;
    chunk(projectIds, 50).forEach(function (part) {
      db.prepare(
        "SELECT project_id, status, COUNT(*) c FROM work_reports WHERE project_id IN (" + placeholders(part) + ") AND status IN ('已提交','已确认') GROUP BY project_id, status",
      )
        .all(part)
        .forEach(function (r) {
          const pid = String(r.project_id);
          const c = mappers.toNum(r.c, 0);
          if (r.status === '已提交') { cntByProject[pid].submitted += c; submitted += c; }
          else if (r.status === '已确认') { cntByProject[pid].confirmed += c; confirmed += c; }
        });
    });

    const items = projectIds
      .map(function (pid) {
        const s = cntByProject[pid].submitted;
        const cf = cntByProject[pid].confirmed;
        const denom = s + cf;
        return {
          projectId: pid,
          projectName: nameById[pid] || '未命名项目',
          submitted: s,
          confirmed: cf,
          rate: denom ? Math.round((cf / denom) * 100) : 0,
        };
      })
      .filter(function (it) { return it.submitted + it.confirmed > 0; })
      .sort(function (a, b) { return b.rate - a.rate; });

    const denom = submitted + confirmed;
    res.json(ok({
      submitted: submitted,
      confirmed: confirmed,
      closureRate: denom ? Math.round((confirmed / denom) * 100) : 0,
      items: items,
    }));
  }),
);

module.exports = router;
