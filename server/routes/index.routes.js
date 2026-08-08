/**
 * 路由装配总入口
 *
 * **挂载顺序即匹配优先级**，不可随意调整：
 *   1. auth      免鉴权 / 登录相关，最先
 *   2. meta      静态段，无 `:id` 冲突
 *   3. projects  ⚠ 内部已保证 `/projects/classify` 早于 `/projects/:id`
 *   4. admin     静态段
 *   5. workbench 静态段
 *   6. stubs     降级桩：只兜住上面**没实现**的路径
 *   7. legacy    旧路由（@deprecated · D-9）：只兜住新契约**没占用**的方法
 *
 * 全站禁用 `PUT`：新契约的改动一律 `PATCH`。
 * （`legacy.routes.js` 里的 `PUT` 是待淘汰的历史包袱，随批次 3/4 删除。）
 *
 * 所有 `/api/*` 未命中路径由 `apiNotFound` 返回信封化 404，
 * 避免落到 SPA fallback 后前端把 HTML 当 JSON 解析。
 */

const express = require('express');

const { apiNotFound } = require('../lib/envelope');

const authRoutes = require('./auth.routes');
const metaRoutes = require('./meta.routes');
const projectsRoutes = require('./projects.routes');
const adminRoutes = require('./admin.routes');
const workbenchRoutes = require('./workbench.routes');
const stubsRoutes = require('./stubs.routes');
const legacyRoutes = require('./legacy.routes');

const router = express.Router();

/* ── 新契约（批次 1 已实现） ─────────────────────────── */
router.use(authRoutes);
router.use(metaRoutes);
router.use(projectsRoutes);
router.use(adminRoutes);
router.use(workbenchRoutes);

/* ── 新契约（批次 1 降级桩，补齐 48 接口） ───────────── */
router.use(stubsRoutes);

/* ── 旧路由兼容层（@deprecated，批次 3/4 逐步删除） ───── */
router.use(legacyRoutes);

/* ── /api 兜底 404（信封形态） ───────────────────────── */
router.use(apiNotFound);

module.exports = router;
module.exports.warnDeprecated = legacyRoutes.warnDeprecated;
