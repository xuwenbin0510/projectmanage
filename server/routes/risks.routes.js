/**
 * 风险登记册路由（本期新增功能域）
 *
 * 权限：全部写操作复用 `project:edit`（service 层 `assertCan` 强制），
 *   路由层只挂 `requireAuth`，权限判定交给 service 统一处理。
 *
 * 返回形状（以 `web/src/api/contract.ts` 为准）：
 *  - listRisks    → `Risk[]`
 *  - createRisk   → 单个 `Risk`
 *  - updateRisk   → 单个 `Risk`
 *  - deleteRisk   → `{ id }`
 *
 * ⚠ 读接口 `GET /api/projects/:projectId/risks` 留在本文件（与写操作同域，
 *   不再拆到 projects.routes.js，保持风险域自洽）。
 */

const express = require('express');

const db = require('../../db');
const { ok, asyncHandler } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const riskService = require('../services/risk.service');

const router = express.Router();

/* ── 风险读 ───────────────────────────────────────── */

/** 项目风险列表 */
router.get(
  '/projects/:projectId/risks',
  requireAuth,
  asyncHandler(async function listRisks(req, res) {
    res.json(ok(riskService.listRisks(db, req.params.projectId)));
  }),
);

/* ── 风险写 ───────────────────────────────────────── */

/** 新建风险 */
router.post(
  '/projects/:projectId/risks',
  requireAuth,
  asyncHandler(async function createRisk(req, res) {
    res.json(ok(riskService.createRisk(db, req, req.params.projectId, req.body || {}), '风险已登记'));
  }),
);

/** 编辑风险（全字段可选 patch） */
router.patch(
  '/risks/:id',
  requireAuth,
  asyncHandler(async function updateRisk(req, res) {
    res.json(ok(riskService.updateRisk(db, req, req.params.id, req.body || {}), '风险已更新'));
  }),
);

/** 删除风险 */
router.delete(
  '/risks/:id',
  requireAuth,
  asyncHandler(async function deleteRisk(req, res) {
    res.json(ok(riskService.deleteRisk(db, req, req.params.id), '风险已删除'));
  }),
);

module.exports = router;
