/**
 * 批次 1 降级桩（§3.9）—— 「切到真后端后首屏不炸」的保证
 *
 * 设计意图：一次性把**契约里全部 48 个接口**注册齐，未实现的按域降级：
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
const { BOARD_COLUMNS, DEFAULT_WIP_LIMIT } = require('../config/enums');
const { nowIso } = require('../lib/dates');

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

/* ── 项目：状态流转 / 结项检查 ───────────────────────── */

// TODO(批次4): 项目状态机流转（审批链 + 归档态拦截）
router.post('/projects/:id/transition', requireAuth, notImplemented('POST /api/projects/:id/transition'));
// TODO(批次4): 结项前置检查（未过门 / 未达成碑 / 未闭环变更与评审）
router.get('/projects/:projectId/close-check', requireAuth, emptyList());

/* ── 成员写操作 ─────────────────────────────────────── */

// TODO(批次3): 增删成员（含 E_ROLE_CARDINALITY 守卫）
router.post('/projects/:projectId/members', requireAuth, notImplemented('POST /api/projects/:projectId/members'));
router.delete(
  '/projects/:projectId/members/:memberId',
  requireAuth,
  notImplemented('DELETE /api/projects/:projectId/members/:memberId'),
);

/* ── 里程碑写操作 / 质量门 ───────────────────────────── */

// TODO(批次3): 里程碑增删改（改期约束 SK-7 / 达成门控 C-G4）
router.post('/projects/:projectId/milestones', requireAuth, notImplemented('POST /api/projects/:projectId/milestones'));
router.patch('/milestones/:id', requireAuth, notImplemented('PATCH /api/milestones/:id'));
router.delete('/milestones/:id', requireAuth, notImplemented('DELETE /api/milestones/:id'));
// TODO(批次3): 质量门勾选与决议
router.patch('/gate-items/:itemId', requireAuth, notImplemented('PATCH /api/gate-items/:itemId'));
router.post(
  '/projects/:projectId/gates/:gateId/decide',
  requireAuth,
  notImplemented('POST /api/projects/:projectId/gates/:gateId/decide'),
);

/* ── WBS ────────────────────────────────────────────── */

// TODO(批次3): WBS 树（扁平数组，树由前端 utils/wbs.ts 组装）
router.get('/projects/:projectId/wbs', requireAuth, emptyList());
router.post('/projects/:projectId/wbs', requireAuth, notImplemented('POST /api/projects/:projectId/wbs'));
router.patch('/wbs/:id', requireAuth, notImplemented('PATCH /api/wbs/:id'));
router.delete('/wbs/:id', requireAuth, notImplemented('DELETE /api/wbs/:id'));
router.post('/wbs/:id/move', requireAuth, notImplemented('POST /api/wbs/:id/move'));
router.post('/wbs/:nodeId/move-status', requireAuth, notImplemented('POST /api/wbs/:nodeId/move-status'));

/* ── 看板 ───────────────────────────────────────────── */

// TODO(批次3): 看板视图（四列 + WIP 限制）
router.get(
  '/projects/:projectId/board',
  requireAuth,
  asyncHandler(async function stubBoard(req, res) {
    const projectId = String(req.params.projectId || '');
    const wipLimits = {};
    wipLimits['进行中'] = DEFAULT_WIP_LIMIT;
    res.json(
      ok({
        projectId: projectId,
        columns: BOARD_COLUMNS.map(function (status) {
          return { status: status, cards: [], wipLimit: wipLimits[status] || 0 };
        }),
        config: {
          projectId: projectId,
          columns: BOARD_COLUMNS.slice(),
          wipLimits: wipLimits,
          updatedAt: nowIso(),
        },
      }),
    );
  }),
);
router.patch(
  '/projects/:projectId/board-config',
  requireAuth,
  notImplemented('PATCH /api/projects/:projectId/board-config'),
);

/* ── 周报 ───────────────────────────────────────────── */

// TODO(批次4): 周报列表 / 详情 / 暂存 / 提交 / 编辑
router.get('/projects/:projectId/reports/:week', requireAuth, nullEntity());
router.get('/projects/:projectId/reports', requireAuth, emptyList());
router.post('/projects/:projectId/reports', requireAuth, notImplemented('POST /api/projects/:projectId/reports'));
router.patch(
  '/projects/:projectId/reports/:id',
  requireAuth,
  notImplemented('PATCH /api/projects/:projectId/reports/:id'),
);

/* ── 评审（静态段 my-approvals 必须早于 :id） ─────────── */

// TODO(批次4): 评审列表 / 待我审批 / 详情 / 发起 / 通过 / 驳回 / 撤回
router.get('/reviews/my-approvals', requireAuth, emptyList());
router.get('/reviews', requireAuth, emptyList());
router.get('/reviews/:id', requireAuth, notImplemented('GET /api/reviews/:id'));
router.post('/reviews', requireAuth, notImplemented('POST /api/reviews'));
router.post('/reviews/:id/approve', requireAuth, notImplemented('POST /api/reviews/:id/approve'));
router.post('/reviews/:id/reject', requireAuth, notImplemented('POST /api/reviews/:id/reject'));
router.post('/reviews/:id/withdraw', requireAuth, notImplemented('POST /api/reviews/:id/withdraw'));

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

// TODO(后续批次): 风险台账与项目文档
router.get('/projects/:projectId/risks', requireAuth, emptyList());
router.get('/projects/:projectId/documents', requireAuth, emptyList());

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
