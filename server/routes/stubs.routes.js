/**
 * 降级桩（§3.9）—— 「切到真后端后首屏不炸」的保证
 *
 * 批次 1 一次性把契约里全部 48 个接口注册齐；批次 3 已删除 12 条（WBS / 看板 /
 * 里程碑写 / 质量门 / 成员写），本文件**只剩批次 4 及以后**的域：
 * 项目流转、结项检查、周报、评审、变更、审计、风险、文档、演示数据复位。
 *
 * 未实现接口按域降级：
 *  - 列表型 GET  → `{code:0, data: []}`（前端 `.map` 不炸）
 *  - 分页型 GET  → `{code:0, data:{items:[],total:0,page,pageSize}}`
 *  - 单实体 GET  → `501 E_NOT_IMPLEMENTED`（返回 `[]` 会让前端把数组当对象读，更难排查）
 *  - 全部写操作  → `501 E_NOT_IMPLEMENTED`「该功能尚未上线」
 *  - reset-demo → `403 E_FORBIDDEN`「真实后端不支持复位演示数据」
 *
 * ⚠ 每个桩都带 `// TODO(批次N)` 注释；对应批次实现后**从本文件删除该行**，
 *   由真实路由接管（本文件必须挂在真实路由**之后**）。
 *
 * ⚠ 注册顺序：静态段早于 `:id` 段
 *   - `GET /reviews/my-approvals` 早于 `GET /reviews/:id`
 *   - `POST /changes/route`       早于 `GET /changes/:id`
 */

const express = require('express');

const { ok, asyncHandler, AppError, ErrorCode } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/* ── 桩工厂 ─────────────────────────────────────────── */

/**
 * 空列表桩。
 * @returns {Function} express handler
 */
function emptyList() {
  return asyncHandler(async function stubEmptyList(req, res) {
    res.json(ok([]));
  });
}

/**
 * 空分页桩（`Paged<T>` 形态）。
 * @returns {Function} express handler
 */
function emptyPaged() {
  return asyncHandler(async function stubEmptyPaged(req, res) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, parseInt(req.query.pageSize, 10) || 20);
    res.json(ok({ items: [], total: 0, page: page, pageSize: pageSize }));
  });
}

/**
 * `null` 桩（契约声明可为 null 的单实体读，如 `getReport`）。
 * @returns {Function} express handler
 */
function nullEntity() {
  return asyncHandler(async function stubNull(req, res) {
    res.json(ok(null));
  });
}

/**
 * 未实现桩：501 `E_NOT_IMPLEMENTED`。
 * @param {string} route 路由标识（便于前端 / 日志定位）
 * @returns {Function} express handler
 */
function notImplemented(route) {
  return asyncHandler(async function stubNotImplemented() {
    throw new AppError(ErrorCode.E_NOT_IMPLEMENTED, '该功能尚未上线', { route: route });
  });
}

/* ── 周报：桩已于批次 4 移除，真实实现见 server/routes/reports.routes.js ── */

/* ── 评审：桩已于 B10 移除，真实实现见 server/routes/reviews.routes.js ── */

/* ── 变更（静态段 route 必须早于 :id） ────────────────── */

// TODO(批次4): 变更路由判定 / 列表 / 详情 / 创建 / 提交 / 生效
router.post('/changes/route', requireAuth, notImplemented('POST /api/changes/route'));
router.get('/projects/:projectId/changes', requireAuth, emptyList());
router.get('/changes/:id', requireAuth, notImplemented('GET /api/changes/:id'));
router.post('/projects/:projectId/changes', requireAuth, notImplemented('POST /api/projects/:projectId/changes'));
router.post('/changes/:id/submit', requireAuth, notImplemented('POST /api/changes/:id/submit'));
router.post('/changes/:id/apply', requireAuth, notImplemented('POST /api/changes/:id/apply'));

/* ── 审计 ───────────────────────────────────────────── */

// TODO(批次4): 审计日志（第二个分页接口）
router.get('/audit', requireAuth, emptyPaged());

/* ── 风险 / 文档 ────────────────────────────────────── */

// TODO(后续批次): 风险台账
router.get('/projects/:projectId/risks', requireAuth, emptyList());

/* ── 演示数据复位 ───────────────────────────────────── */

/**
 * Mock 模式下由前端清 localStorage 实现；真实后端语义不成立，
 * 明确 403 拒绝，避免管理员在生产误点后期待「数据被重置」。
 */
router.post(
  '/admin/reset-demo',
  requireAuth,
  asyncHandler(async function resetDemo() {
    throw new AppError(ErrorCode.E_FORBIDDEN, '真实后端不支持复位演示数据', { route: 'POST /api/admin/reset-demo' });
  }),
);

module.exports = router;
