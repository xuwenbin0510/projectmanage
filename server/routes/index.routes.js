/**
 * 路由装配总入口
 *
 * **挂载顺序即匹配优先级**，不可随意调整：
 *   1. auth       免鉴权 / 登录相关，最先
 *   2. meta       静态段，无 `:id` 冲突
 *   3. projects   ⚠ 内部已保证 `/projects/classify` 早于 `/projects/:id`
 *   4. wbs        批次 3：`/projects/:id/wbs` + `/wbs/*`
 *   5. milestones 批次 3：里程碑写 + 质量门
 *   6. admin      静态段
 *   7. workbench  静态段
 *   8. dashboard  静态段（B12 全局总览）
 *   9. stubs      降级桩：只兜住上面**没实现**的路径（批次 3 后只剩 B4 项）
 *  10. legacy     旧路由（@deprecated · D-9）：只兜住新契约**没占用**的方法
 *
 * 全站禁用 `PUT`：新契约的改动一律 `PATCH`。
 * （`legacy.routes.js` 里的 `PUT` 是待淘汰的历史包袱，随批次 4 删除。）
 *
 * 所有 `/api/*` 未命中路径由 `apiNotFound` 返回信封化 404，
 * 避免落到 SPA fallback 后前端把 HTML 当 JSON 解析。
 */

const express = require('express');

const { apiNotFound } = require('../lib/envelope');

const authRoutes = require('./auth.routes');
const metaRoutes = require('./meta.routes');
const projectsRoutes = require('./projects.routes');
const wbsRoutes = require('./wbs.routes');
const milestonesRoutes = require('./milestones.routes');
const adminRoutes = require('./admin.routes');
const workbenchRoutes = require('./workbench.routes');
const dashboardRoutes = require('./dashboard.routes');
const reportsRoutes = require('./reports.routes');
const reviewsRoutes = require('./reviews.routes');
const documentsRoutes = require('./documents.routes');
const changeRoutes = require('./change.routes');
const auditRoutes = require('./audit.routes');
const stubsRoutes = require('./stubs.routes');
const legacyRoutes = require('./legacy.routes');

const router = express.Router();

/* ── 新契约（批次 1 已实现） ─────────────────────────── */
router.use(authRoutes);
router.use(metaRoutes);
router.use(projectsRoutes);

/* ── 新契约（批次 3：WBS / 看板 / 里程碑写 / 质量门） ─── */
router.use(wbsRoutes);
router.use(milestonesRoutes);

router.use(adminRoutes);
router.use(workbenchRoutes);

/* ── 新契约（B12：全局总览） ────────────────────────── */
/* ⚠ 必须先于 stubsRoutes，否则 /dashboard/* 会被 501 桩抢先命中 */
router.use(dashboardRoutes);

/* ── 新契约（批次 4：结构化周报 / 工作日志） ─────────── */
/* ⚠ 必须先于 stubsRoutes，否则周报请求会被 501 桩抢先命中 */
router.use(reportsRoutes);

/* ── 新契约（B10：评审 7 接口） ─────────────────────── */
/* ⚠ 必须先于 stubsRoutes，否则评审请求会被 501 桩抢先命中 */
router.use(reviewsRoutes);

/* ── 新契约（C01：任务附件） ───────────────────────── */
/* ⚠ 必须先于 stubsRoutes，否则文档请求会被 501 桩抢先命中 */
router.use(documentsRoutes);

/* ── 新契约（D08：变更流程，替换变更桩） ────────────── */
/* ⚠ 必须先于 stubsRoutes，否则变更请求会被 501 桩抢先命中 */
router.use(changeRoutes);

/* ── 新契约（D08.3：审计日志，替换审计桩） ──────────── */
/* ⚠ 必须先于 stubsRoutes，否则 /audit 会被空分页桩抢先命中 */
router.use(auditRoutes);

/* ── 降级桩：批次 4 后只兜未实现项（周报 / 评审桩已删） ─ */
router.use(stubsRoutes);

/* ── 旧路由兼容层（@deprecated，批次 4 删除） ────────── */
router.use(legacyRoutes);

/* ── /api 兜底 404（信封形态） ───────────────────────── */
router.use(apiNotFound);

module.exports = router;
module.exports.warnDeprecated = legacyRoutes.warnDeprecated;
