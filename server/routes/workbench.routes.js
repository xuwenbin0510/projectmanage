/**
 * 工作台路由（P0-13）
 *
 *  GET /api/workbench → WorkbenchData
 *
 * 批次 1 为**降级实现**（§3.9）：
 *  - `stats.pendingApprovals` / `stats.missingReports` → 0（评审 / 周报属批次 4）
 *  - `stats.overdueTasks`                             → 0（WBS 属批次 3）
 *  - `myProjects`                                     → **真实**（我参与的项目列表项）
 *  - `myTasks` / `myApprovals` / `reportReminders`    → `[]`
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

    res.json(
      ok({
        stats: {
          // TODO(批次4): 接入 reviews 表后统计待我审批数
          pendingApprovals: 0,
          overdueTasks: workbenchService.countOverdue(myTasks),
          // TODO(批次4): 接入 reports 表后统计我应填未填的周报数
          missingReports: 0,
        },
        myProjects: myProjects,
        myTasks: myTasks,
        myApprovals: [],      // TODO(批次4)
        reportReminders: [],  // TODO(批次4)
      }),
    );
  }),
);

module.exports = router;
