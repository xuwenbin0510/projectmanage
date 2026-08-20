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
const { ok, asyncHandler } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const projectService = require('../services/project.service');
const workbenchService = require('../services/workbench.service');

const router = express.Router();

router.get(
  '/workbench',
  requireAuth,
  asyncHandler(async function getWorkbench(req, res) {
    const myProjects = projectService.listMyProjectItems(db, req.user);
    const myTasks = workbenchService.listMyTasks(db, req.user);
    const myApprovals = workbenchService.listMyApprovals(db, req.user);
    const reportReminders = workbenchService.listReportReminders(db, req.user);
    const gateTodos = workbenchService.listGateTodos(db, req.user);
    const reportConfirmations = workbenchService.listReportConfirmations(db, req.user);

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
        myApprovals: myApprovals,
        reportReminders: reportReminders,
        gateTodos: gateTodos,
        reportConfirmations: reportConfirmations,
      }),
    );
  }),
);

module.exports = router;
