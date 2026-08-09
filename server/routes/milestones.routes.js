/**
 * 里程碑写操作 + 质量门路由（批次 3 · T04-3）
 *
 * ⚠ 读接口 `GET /api/projects/:projectId/milestones` **留在 `projects.routes.js`**（批次 1 已实现，
 *   不搬家，避免读写分家引发回归）。本文件只放写操作。
 *
 * ⚠ 返回形状（以 `web/src/api/contract.ts` 为准）：
 *  - createMilestone / updateMilestone → 单个 `MilestoneWithGate`
 *  - deleteMilestone                   → `null`
 *  - toggleGateItem / decideGate       → **整个 `MilestoneWithGate[]`**（前端勾完直接整表刷新）
 *
 * ⚠ 改期延后走 `E_MS_NEED_CHANGE`（HTTP 409）+ `data.changeDraft`，
 *   前端 `MilestonesPage.tsx` 直接读 `e.data.changeDraft` 弹变更单草稿。
 */

const express = require('express');

const db = require('../../db');
const { ok, asyncHandler } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const milestoneService = require('../services/milestone.service');
const gateService = require('../services/gate.service');

const router = express.Router();

/* ── 里程碑写 ───────────────────────────────────────── */

/** 新建里程碑（不自动建质量门 · K-1） */
router.post(
  '/projects/:projectId/milestones',
  requireAuth,
  asyncHandler(async function createMilestone(req, res) {
    res.json(ok(milestoneService.createMilestone(db, req, req.params.projectId, req.body || {}), '里程碑创建成功'));
  }),
);

/** 编辑里程碑（改期 SK-7 / 达成 C-G4 / 状态覆盖 SK-2） */
router.patch(
  '/milestones/:id',
  requireAuth,
  asyncHandler(async function updateMilestone(req, res) {
    res.json(ok(milestoneService.updateMilestone(db, req, req.params.id, req.body || {}), '里程碑已更新'));
  }),
);

/** 删除里程碑（关联 WBS 节点仅解绑不删除 · SK-12） */
router.delete(
  '/milestones/:id',
  requireAuth,
  asyncHandler(async function deleteMilestone(req, res) {
    res.json(ok(milestoneService.deleteMilestone(db, req, req.params.id), '里程碑已删除'));
  }),
);

/* ── 质量门 ─────────────────────────────────────────── */

/** 勾选 / 取消勾选检查项 */
router.patch(
  '/gate-items/:itemId',
  requireAuth,
  asyncHandler(async function toggleGateItem(req, res) {
    const body = req.body || {};
    res.json(ok(gateService.toggleGateItem(db, req, req.params.itemId, body.checked)));
  }),
);

/** 质量门决议（通过 / 有条件通过 → 自动达成里程碑） */
router.post(
  '/projects/:projectId/gates/:gateId/decide',
  requireAuth,
  asyncHandler(async function decideGate(req, res) {
    res.json(
      ok(gateService.decideGate(db, req, req.params.projectId, req.params.gateId, req.body || {}), '质量门已决议'),
    );
  }),
);

module.exports = router;
