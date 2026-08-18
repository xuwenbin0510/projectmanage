/**
 * WBS 路由（批次 3 · T02-4 / T03-2）
 *
 * 路由风格（§3.4）：
 *  - 按项目查询 / 创建 → 嵌套式 `/api/projects/:projectId/wbs`
 *  - 已知 id 的单实体   → 顶层 `/api/wbs/:id`
 *  - 全站禁用 PUT，改动一律 PATCH
 *
 * ⚠ 返回形状差异（D13，别顺手统一）：
 *  - `POST /projects/:projectId/wbs` / `PATCH /wbs/:id` → **单个 WbsNode**
 *  - `POST /wbs/:id/move`                               → **整个项目节点数组**（前端靠它重建树）
 *  - `DELETE /wbs/:id`                                  → `null`
 *  - `POST /wbs/:nodeId/move-status`                    → **整个 BoardView**（由 board.service 提供）
 *
 * ⚠ 请求体字段以 `web/src/api/http.ts` 为准：
 *  - move        → `{newParentId, index}`（任务分解文档里写的 `{parentId}` 是简写，此处兼容两种键名）
 *  - move-status → `{status, order}`
 */

const express = require('express');

const db = require('../../db');
const { ok, asyncHandler } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const wbsService = require('../services/wbs.service');
const boardService = require('../services/board.service');

const router = express.Router();

/* ── 项目维度（嵌套式） ─────────────────────────────── */

/** WBS 全量扁平数组（树由前端 `utils/wbs.ts#buildTree` 组装，按 compareWbsCode 已排好序） */
router.get(
  '/projects/:projectId/wbs',
  requireAuth,
  asyncHandler(async function listWbs(req, res) {
    res.json(ok(wbsService.listWbs(db, req.params.projectId)));
  }),
);

/** 新建 WBS 节点（层级 / 截止 / 估算三重校验，返回单节点） */
router.post(
  '/projects/:projectId/wbs',
  requireAuth,
  asyncHandler(async function createWbsNode(req, res) {
    res.json(ok(wbsService.createWbsNode(db, req, req.params.projectId, req.body || {}), '任务创建成功'));
  }),
);

/* ── 单实体（顶层） ─────────────────────────────────── */

/** 编辑 WBS 节点（R-4 类型锁 / SK-13 叶子完整性，返回单节点） */
router.patch(
  '/wbs/:id',
  requireAuth,
  asyncHandler(async function updateWbsNode(req, res) {
    res.json(ok(wbsService.updateWbsNode(db, req, req.params.id, req.body || {}), '任务已更新'));
  }),
);

/** 删除 WBS 节点（级联整棵子树，返回 null） */
router.delete(
  '/wbs/:id',
  requireAuth,
  asyncHandler(async function deleteWbsNode(req, res) {
    res.json(ok(wbsService.deleteWbsNode(db, req, req.params.id), '任务已删除'));
  }),
);

/** 移动节点（改父 + 子树 wbsCode 重排，**返回整个项目节点数组** · D13） */
router.post(
  '/wbs/:id/move',
  requireAuth,
  asyncHandler(async function moveWbsNode(req, res) {
    const body = req.body || {};
    /* 契约键名 newParentId 优先；parentId 为任务分解文档里的等价简写 */
    const newParentId = body.newParentId !== undefined ? body.newParentId : body.parentId;
    res.json(ok(wbsService.moveWbsNode(db, req, req.params.id, newParentId, body.index), '任务已移动'));
  }),
);

/**
 * 看板拖拽改状态（实现委托 `board.service`，路由归属 WBS 域）。
 * 放在 `POST /wbs/:id/move` 之后仅为文件内可读性；`move-status` 与 `:id/move` 静态段不冲突。
 */
router.post(
  '/wbs/:nodeId/move-status',
  requireAuth,
  asyncHandler(async function moveTask(req, res) {
    const body = req.body || {};
    res.json(ok(boardService.moveTask(db, req, req.params.nodeId, body.status, body.order)));
  }),
);

module.exports = router;
