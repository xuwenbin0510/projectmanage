/**
 * 周报（工作日志）路由（B4 · T02-4）
 *
 * 端点（全部挂在 `/api` 前缀下，由 `index.routes.js` 统一挂载）：
 *  - `GET    /projects/:projectId/reports`        列表（含历史多次提交）
 *  - `GET    /projects/:projectId/reports/:week`  指定周次最新一条（无则 `data: null`）
 *  - `POST   /projects/:projectId/reports`        暂存 / 提交（body `submit: true|false`）
 *  - `PATCH  /projects/:projectId/reports/:id`    编辑（作者本人或 admin）
 *
 * RBAC 守卫次序（共享约定 §4）：`requireAuth` → `assertCan('report.write')` → 业务校验。
 * `report:write` 的 `project: []` 为空 ⇒ 实际只校验全局角色，与 Mock 一致。
 *
 * ⚠ 本路由必须挂载在 `stubs.routes.js` **之前**，否则会被 501 桩抢先命中。
 */

const express = require('express');
const db = require('../../db');
const { ok, asyncHandler } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const rbac = require('../middleware/rbac');
const reportSvc = require('../services/report.service');

const router = express.Router();

/* ── 读 ─────────────────────────────────────────────── */

/** 周报列表：登录即可读（读路径不做项目角色守卫，与工作台口径一致） */
router.get(
  '/projects/:projectId/reports',
  requireAuth,
  asyncHandler(async function listReports(req, res) {
    res.json(ok(reportSvc.listReports(db, req.params.projectId)));
  }),
);

/** 指定周次周报：同周多次提交时返回最新一条；无则 `data: null` */
router.get(
  '/projects/:projectId/reports/:week',
  requireAuth,
  asyncHandler(async function getReport(req, res) {
    res.json(ok(reportSvc.getReport(db, req.params.projectId, req.params.week)));
  }),
);

/** 工时统计报表（B9 · 只读聚合）：loadNodes + 父估算 Σ 叶子 + 已提交日志构成明细。
 *  `requireAuth` 即可读（与 WBS/看板/周报列表同级可见性，无需 report:write）；
 *  `rbac.loadProject` 404 兜底（与 WBS 读路径一致）。 */
router.get(
  '/projects/:projectId/effort-report',
  requireAuth,
  asyncHandler(async function getEffortReport(req, res) {
    rbac.loadProject(db, req.params.projectId);
    res.json(ok(reportSvc.getEffortReport(db, req.params.projectId)));
  }),
);

/* ── 写 ─────────────────────────────────────────────── */

/** 暂存 / 提交：用 body.submit 区分（对齐 web/src/api/http.ts#saveReport/submitReport） */
router.post(
  '/projects/:projectId/reports',
  requireAuth,
  asyncHandler(async function createReport(req, res) {
    const projectId = req.params.projectId;
    rbac.assertWritable(db, projectId);
    rbac.assertCan(db, req, 'report.write', projectId);

    const body = req.body || {};
    const submit = body.submit === true;
    /* 路径参数是唯一真源，防止 body.projectId 与 URL 不一致造成跨项目写入 */
    const payload = Object.assign({}, body, { projectId: projectId });

    const report = reportSvc.createReport(db, payload, req.user, submit);
    res.json(ok(report, submit ? '提交成功' : '已保存草稿'));
  }),
);

/** 编辑：作者本人或 admin（service 层做 D-2 收紧校验） */
router.patch(
  '/projects/:projectId/reports/:id',
  requireAuth,
  asyncHandler(async function updateReport(req, res) {
    const projectId = req.params.projectId;
    rbac.assertWritable(db, projectId);
    rbac.assertCan(db, req, 'report.write', projectId);

    const payload = Object.assign({}, req.body || {}, { projectId: projectId });
    const report = reportSvc.updateReport(db, req.params.id, payload, req.user);
    res.json(ok(report, '已更新'));
  }),
);

module.exports = router;
