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
const { ok, asyncHandler, AppError, ErrorCode } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const { REVIEW_TEMPLATES, DEFAULT_WIP_LIMIT } = require('../config/enums');
const projectService = require('../services/project.service');
const projectTypeService = require('../services/projectType.service');
const roleCatalog = require('../services/roleCatalog');

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

/**
 * GET /api/meta/roles —— 职位目录（仅登录可读，供新建项目 / 管理成员等下拉选择）。
 *
 * 与 admin 职位管理写接口（`/api/admin/roles`，需 admin:user:role）刻意分离：
 * 此处只读、不要求管理员权限，避免非管理员在「团队组建 / 管理成员」时因拿不到可选角色而列表为空。
 * 实际成员增删改仍由 `/projects/:id/members` 的 `project:member:assign` 把关，安全性不降级。
 * 仅返回已启用职位（下拉无需展示禁用项）；排序与 `roles` 表 order_no 一致。
 */
router.get(
  '/meta/roles',
  requireAuth,
  asyncHandler(async function getMetaRoles(req, res) {
    const rows = db.prepare('SELECT * FROM roles WHERE enabled = 1 ORDER BY order_no ASC, role_key ASC').all();
    res.json(
      ok(
        rows.map(function (r) {
          return {
            roleKey: r.role_key,
            name: r.name,
            scope: r.scope,
            enabled: Number(r.enabled) === 1,
            description: r.description,
            orderNo: Number(r.order_no) || 0,
          };
        }),
      ),
    );
  }),
);

/**
 * GET /api/meta/project-types —— 项目类型目录（仅 requireAuth：建项页非管理员也要读）。
 *
 * 返回**全部**类型（含已停用，`enabled:false`）：页面按 `enabled` 过滤建项下拉，
 * 按 `code` 解析标签（停用类型的历史项目标签仍可解析，OQ-2）。唯一真相源 = `project_types` 表。
 */
router.get(
  '/meta/project-types',
  requireAuth,
  asyncHandler(async function getMetaProjectTypes(req, res) {
    res.json(ok(projectTypeService.listTypes(db)));
  }),
);

/**
 * GET /api/meta/role-candidates?role=<key>&projectId=<可选>
 * 返回某审批角色的合法候选人 [{openId, name}]，供后台「逐节点指定审批人」下拉取数。
 *
 * 候选池算法与 buildSteps 同款：
 *  - 全局角色（scope=global）：用户 `users.global_role` 或 `user_roles.role_key` 命中该角色，
 *    且 status='active'（收录进候选人 = 引擎真正能绑定的人）。
 *  - 项目角色（scope=project）：仅在提供 projectId 时，返回该项目内 `project_role` 命中该角色的成员；
 *    不提供 projectId（如全局模板编辑器）则返回空（项目角色候选人依赖具体项目，模板层面无法定死）。
 *  - customer_rep 等虚拟角色（不在 roles 表）：走 project 分支，需 projectId，否则返回空。
 */
router.get(
  '/meta/role-candidates',
  requireAuth,
  asyncHandler(async function getRoleCandidates(req, res) {
    const role = String(req.query.role || '');
    const projectId = String(req.query.projectId || '');
    if (!role) {
      throw new AppError(ErrorCode.E_VALIDATION, '缺少 role 参数', { field: 'role' });
    }

    let candidates = [];
    if (roleCatalog.isGlobalRole(role)) {
      const rows = db
        .prepare(
          'SELECT u.open_id AS openId, u.name AS name FROM users u '
          + "WHERE u.status = 'active' AND (u.global_role = ? "
          + 'OR u.open_id IN (SELECT user_open_id FROM user_roles WHERE role_key = ?)) '
          + 'ORDER BY u.id ASC',
        )
        .all(role, role);
      candidates = rows;
    } else if (projectId) {
      const rows = db
        .prepare(
          'SELECT u.open_id AS openId, u.name AS name FROM project_members pm '
          + 'JOIN users u ON u.open_id = pm.user_open_id '
          + "WHERE pm.project_id = ? AND pm.project_role = ? AND u.status = 'active' "
          + 'ORDER BY pm.assigned_at ASC, pm.id ASC',
        )
        .all(projectId, role);
      candidates = rows;
    }

    res.json(ok(candidates));
  }),
);

module.exports = router;
