/**
 * 评审路由（B10 · R1）
 *
 * 端点（全部挂在 `/api` 前缀下，由 `index.routes.js` 统一挂载）：
 *  - `GET  /api/reviews`                    评审列表（可选 ?projectId=）
 *  - `GET  /api/reviews/my-approvals`       待我审批（canDecide 命中）
 *  - `GET  /api/reviews/:id`                评审详情
 *  - `POST /api/reviews`                    发起评审（模板生成审批链）
 *  - `POST /api/reviews/:id/approve`        通过
 *  - `POST /api/reviews/:id/reject`         驳回（comment 必填）
 *  - `POST /api/reviews/:id/withdraw`       撤回（仅发起人 / admin）
 *
 * RBAC 守卫次序（共享约定 §4）：`requireAuth` → 查实体 → `assertWritable`（归档拦截，
 * 仅发起新评审）→ `assertCan` → 业务校验（service 内）。
 * 决策 / 撤回**不**做 assertWritable：归档项目已存在评审的决策按评审状态校验
 * （对齐 PRD §3.1 矩阵）。
 *
 * ⚠ 静态段 `my-approvals` 必须早于 `:id`（stubs.routes.js 同款注释）。
 * ⚠ 本路由必须挂载在 `stubs.routes.js` **之前**，否则会被 501 桩抢先命中。
 */

const express = require('express');
const db = require('../../db');
const { ok, asyncHandler } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const rbac = require('../middleware/rbac');
const reviewSvc = require('../services/review.service');

const router = express.Router();

/* ── 静态段（必须早于 /:id） ─────────────────────────── */

/** 待我审批：返回我可决策的评审完整列表（含 steps 供 ReviewStepper） */
router.get(
  '/reviews/my-approvals',
  requireAuth,
  asyncHandler(async function listMyApprovals(req, res) {
    res.json(ok(reviewSvc.listMyApprovals(db, req.user)));
  }),
);

/* ── 列表 / 详情 ────────────────────────────────────── */

/** 评审列表（createdAt 倒序；可选 projectId 过滤） */
router.get(
  '/reviews',
  requireAuth,
  asyncHandler(async function listReviews(req, res) {
    const q = req.query || {};
    res.json(ok(reviewSvc.listReviews(db, q.projectId)));
  }),
);

/** 评审详情 */
router.get(
  '/reviews/:id',
  requireAuth,
  asyncHandler(async function getReview(req, res) {
    res.json(ok(reviewSvc.getReview(db, req.params.id)));
  }),
);

/* ── 写 ─────────────────────────────────────────────── */

/** 发起评审：归档项目拦截（E_PROJECT_ARCHIVED）+ review:start 权限 */
router.post(
  '/reviews',
  requireAuth,
  asyncHandler(async function createReview(req, res) {
    const body = req.body || {};
    rbac.assertWritable(db, body.projectId);
    rbac.assertCan(db, req, 'review:start', body.projectId);
    res.json(ok(reviewSvc.createReview(db, body, req.user), '评审已发起'));
  }),
);

/** 审批通过 */
router.post(
  '/reviews/:id/approve',
  requireAuth,
  asyncHandler(async function approveReview(req, res) {
    res.json(ok(reviewSvc.approveReview(db, req.params.id, req.body || {}, req.user), '已通过'));
  }),
);

/** 审批驳回（comment 必填） */
router.post(
  '/reviews/:id/reject',
  requireAuth,
  asyncHandler(async function rejectReview(req, res) {
    res.json(ok(reviewSvc.rejectReview(db, req.params.id, req.body || {}, req.user), '已驳回'));
  }),
);

/** 撤回（仅发起人 / admin） */
router.post(
  '/reviews/:id/withdraw',
  requireAuth,
  asyncHandler(async function withdrawReview(req, res) {
    res.json(ok(reviewSvc.withdrawReview(db, req.params.id, req.body || {}, req.user), '已撤回'));
  }),
);

module.exports = router;
