/**
 * 全局总览路由（B12）
 *
 *  GET /api/dashboard/overview?scope=all|mine&type=&status=&health=&keyword=&onlyMine=&page=&pageSize=&sort=
 *      → DashboardOverview
 *
 * 鉴权口径（决策 ① / P1-9）：
 *  - 中间件只用 `requireAuth`，**不加角色守卫**；
 *  - 「能不能看公司全量」由 `dashboard.service.resolveScope` 内部按
 *    `dashboard:global` 权限判定，无权限者静默降级为 `scope=mine`。
 *  - 这样非管理角色直链 `/metrics` 时看到的是「我的项目总览」，
 *    而不是 403 白屏 —— 拿不到别人的数据，但也不会被拒之门外。
 *
 * 响应里的 `scope` 字段是**实际生效值**，前端据此回显开关状态
 * （用户点了「看全部」但无权限时，开关会自动弹回「我的」）。
 */

const express = require('express');

const db = require('../../db');
const { ok, asyncHandler } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const dashboardService = require('../services/dashboard.service');

const router = express.Router();

router.get(
  '/dashboard/overview',
  requireAuth,
  asyncHandler(async function getDashboardOverview(req, res) {
    res.json(ok(dashboardService.getDashboardOverview(db, req.query, req.user)));
  }),
);

module.exports = router;
