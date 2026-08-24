/**
 * 元数据路由
 *
 *  GET /api/meta                          → MetaData {templates, reviewTemplates, wipDefault}
 *  GET /api/meta/templates/options?type=X → LifecycleTemplate[]（该分类全部启用模板，version DESC；方案A 建项向导下拉）
 *  GET /api/meta/templates/:type          → LifecycleTemplate | null（**缺失返回 null，不抛 404**）
 *
 * `/api/meta` 取代旧的 `/api/approval-config`。
 * 注册顺序：静态段 `/meta`、`/meta/templates/options` 必须在前——否则 `options` 会被 `/meta/templates/:type` 的 `:type` 吃掉。
 */

const express = require('express');

const db = require('../../db');
const { ok, asyncHandler } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const { REVIEW_TEMPLATES, DEFAULT_WIP_LIMIT } = require('../config/enums');
const projectService = require('../services/project.service');

const router = express.Router();

/**
 * 评审模板精简视图（契约 `MetaData.reviewTemplates`：只要 key/label/mode/chain）。
 * 阶段二：DB 优先（scope='business' 且 active=1）→ 回落 enums.REVIEW_TEMPLATES。
 * 项目类（scope='project'，如 project:A/B/C/_default）不进 meta——立项链由建项流程自动选择，
 * 前端发起评审弹窗仍只展示业务类模板（与旧行为一致，零前端改动）。
 * @returns {Array<{key:string,label:string,mode:string,chain:string[]}>}
 */
function reviewTemplateSummaries() {
  try {
    const rows = db
      .prepare("SELECT key, label, mode, chain FROM review_templates WHERE scope = 'business' AND active = 1 ORDER BY key ASC")
      .all();
    if (rows.length) {
      return rows.map(function (r) {
        return { key: r.key, label: r.label, mode: r.mode, chain: JSON.parse(r.chain || '[]') };
      });
    }
  } catch (e) {
    /* 表不存在（老库未迁移）→ 回落旧配置 */
  }
  return Object.keys(REVIEW_TEMPLATES).map(function (k) {
    const t = REVIEW_TEMPLATES[k];
    return { key: t.key, label: t.label, mode: t.mode, chain: t.chain.slice() };
  });
}

router.get(
  '/meta',
  requireAuth,
  asyncHandler(async function getMeta(req, res) {
    res.json(
      ok({
        templates: projectService.listTemplates(db),
        reviewTemplates: reviewTemplateSummaries(),
        wipDefault: DEFAULT_WIP_LIMIT,
      }),
    );
  }),
);

router.get(
  '/meta/templates/options',
  requireAuth,
  asyncHandler(async function listTemplateOptions(req, res) {
    /* 方案A：建项向导「生命周期模板」下拉数据源——该分类全部启用模板（version DESC） */
    res.json(ok(projectService.listActiveTemplateOptions(db, String(req.query.type || ''))));
  }),
);

router.get(
  '/meta/templates/:type',
  requireAuth,
  asyncHandler(async function getLifecycleTemplate(req, res) {
    /* 契约明确：模板缺失返回 null，不抛 404（向导需要能优雅降级为「手工填里程碑」） */
    res.json(ok(projectService.getLifecycleTemplate(db, String(req.params.type || ''))));
  }),
);

const permissionCatalog = require('../services/permissionCatalog');

/**
 * GET /api/meta/permissions —— 权限矩阵只读元数据（角色 + 权限点分组），
 * 供后台「权限矩阵」页渲染列头 / 行分组。仅 requireAuth（矩阵本身只读展示）。
 * 真实授权由后端 canDo 把关，前端矩阵只控制按钮显隐。
 */
router.get(
  '/meta/permissions',
  requireAuth,
  asyncHandler(async function getMetaPermissions(req, res) {
    res.json(ok({
      roles: db.prepare('SELECT role_key AS roleKey, name, scope, enabled FROM roles WHERE enabled = 1 ORDER BY order_no ASC').all(),
      actions: permissionCatalog.allActions().filter(function (a) { return a.enabled; }),
    }));
  }),
);

/**
 * GET /api/meta/permission-matrix —— 当前生效矩阵（所有登录用户可读，用于前端按钮显隐 hydrate）。
 * 不含写接口；仅返回 action → { roleKey: granted }（启用角色 + 启用 action），
 * 与后端 permissionCatalog.rolesFor 同源，确保前端 canDo 与后端一致。
 */
router.get(
  '/meta/permission-matrix',
  requireAuth,
  asyncHandler(async function getMetaPermissionMatrix(req, res) {
    const enabledRoles = new Set(db.prepare('SELECT role_key FROM roles WHERE enabled = 1').all().map(function (x) { return x.role_key; }));
    const enabledActions = new Set(
      db.prepare('SELECT action FROM permission_actions WHERE enabled = 1').all().map(function (x) { return x.action; }),
    );
    const rules = db.prepare('SELECT action, role_key, granted FROM permission_rules').all();
    const matrix = {};
    rules.forEach(function (r) {
      if (!enabledActions.has(r.action) || !enabledRoles.has(r.role_key) || !r.granted) return;
      if (!matrix[r.action]) matrix[r.action] = {};
      matrix[r.action][r.role_key] = true;
    });
    res.json(ok({ matrix: matrix }));
  }),
);

module.exports = router;
