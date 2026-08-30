/**
 * 周报（工作日志）路由（B4 · T02-4）
 *
 * 端点（全部挂在 `/api` 前缀下，由 `index.routes.js` 统一挂载）：
 *  - `GET    /projects/:projectId/reports`        列表（含历史多次提交）
 *  - `GET    /projects/:projectId/reports/:week`  指定周次最新一条（无则 `data: null`）
 *  - `POST   /projects/:projectId/reports`        暂存 / 提交（body `submit: true|false`）
 *  - `PATCH  /projects/:projectId/reports/:id`    编辑（作者本人或 admin）
 *  - `DELETE /projects/:projectId/reports/:id`    删除草稿（仅作者本人或 admin，仅「草稿」可删）
 *
 * B14 块2（轻量闭环）新增：
 *  - `POST   /projects/:projectId/reports/:id/confirm`  确认（`已提交` → `已确认`）
 *  - `POST   /projects/:projectId/reports/:id/reject`   打回（`已提交` → `草稿`，body.reason 必填）
 *  - `GET    /reports/pending-confirmation`             待我确认的周报（服务端解析确认人）
 *
 * RBAC 守卫次序（共享约定 §4）：`requireAuth` → `assertCan('report.write')` → 业务校验。
 * `report:write` 的 `project: []` 为空 ⇒ 实际只校验全局角色，与 Mock 一致。
 *
 * ⚠ 确认/打回**不走** `assertCan('report.write')`：授权真源是
 *   `reportSvc.resolveConfirmers`（项目有 PM → 本项目 PM 确认，PM 可自批自己的周报；
 *   项目无 PM → PMO ∪ admin 兜底；普通成员写的周报由 PM 批、作者恒被排除）。
 *   若再叠加全局角色白名单，会把「是项目 pm 但全局角色为 management」的合法确认人误拒。
 *
 * ⚠ `GET /reports/pending-confirmation` 是**静态段**路径（`/reports/...`），
 *   与 `/projects/:projectId/reports/:week` 不在同一前缀下，无 `:id` 冲突风险。
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

/**
 * B14 块2：待我确认的周报（跨项目）。
 *
 * 服务端逐条 `resolveConfirmers` 过滤，只返回当前用户有权确认的 `已提交` 周报；
 * 「我能否确认」以本接口结果为唯一判据（前端不重复实现确认人解析，架构 §8）。
 *
 * ⚠ 必须声明在 `/projects/:projectId/reports/:week` 之前无冲突（不同前缀），
 *   但仍前置声明以保证「静态段优先」的阅读直觉。
 */
router.get(
  '/reports/pending-confirmation',
  requireAuth,
  asyncHandler(async function listPendingConfirmation(req, res) {
    const me = req.user || {};
    res.json(ok(reportSvc.listPendingConfirmation(db, me.id)));
  }),
);

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

/** 删除草稿：仅「草稿」可删，作者本人或 admin（service 层做状态/权限收紧校验）。
 *  与编辑同守卫：项目已结项/终止由 assertWritable 拦截。 */
router.delete(
  '/projects/:projectId/reports/:id',
  requireAuth,
  asyncHandler(async function deleteReport(req, res) {
    const projectId = req.params.projectId;
    rbac.assertWritable(db, projectId);
    rbac.assertCan(db, req, 'report.write', projectId);

    const result = reportSvc.deleteReport(db, req.params.id, req.user);
    res.json(ok(result, '已删除'));
  }),
);

/* ── B14 块2：轻量闭环（确认 / 打回） ───────────────── */

/**
 * 确认周报：`已提交` → `已确认`，写 `confirmed_by` / `confirmed_at`。
 * 授权由 service 层 `resolveConfirmers` 判定（作者天然被排除）。
 */
router.post(
  '/projects/:projectId/reports/:id/confirm',
  requireAuth,
  asyncHandler(async function confirmReport(req, res) {
    const projectId = req.params.projectId;
    rbac.assertWritable(db, projectId);

    const report = reportSvc.confirmReport(db, req.params.id, req.user);
    res.json(ok(report, '已确认'));
  }),
);

/**
 * 打回周报：`已提交` → `草稿`，写 `reject_reason`（body.reason 必填，空 → 400）。
 * 授权同 confirm，由 service 层 `resolveConfirmers` 判定。
 */
router.post(
  '/projects/:projectId/reports/:id/reject',
  requireAuth,
  asyncHandler(async function rejectReport(req, res) {
    const projectId = req.params.projectId;
    rbac.assertWritable(db, projectId);

    const body = req.body || {};
    /* 兼容前端两种字段名：reason（契约）/ rejectReason（防御） */
    const reason = body.reason !== undefined ? body.reason : body.rejectReason;
    const report = reportSvc.rejectReport(db, req.params.id, reason, req.user);
    res.json(ok(report, '已打回'));
  }),
);

module.exports = router;
