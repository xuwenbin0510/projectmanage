/**
 * 管理后台路由
 *
 *  GET   /api/admin/users            → User[]              （**批次 1 必须真实**：建项向导选成员用）
 *  PATCH /api/admin/users/:openId    → User                （改全局角色）
 *  GET   /api/admin/templates        → LifecycleTemplate[]
 *  POST  /api/admin/reset-demo       → 403 E_FORBIDDEN     （见 stubs.routes.js）
 *
 * 注册顺序：`/admin/users` `/admin/templates` 均为静态段，`:openId` 挂在 users 之下不冲突。
 */

const express = require('express');

const db = require('../../db');
const { ok, asyncHandler, AppError, ErrorCode } = require('../lib/envelope');
const { requireAuth, requireGlobalRole } = require('../middleware/auth');
const { toApiUser } = require('../lib/mappers');
const { nowIso } = require('../lib/dates');
const { GLOBAL_ROLES } = require('../config/enums');
const projectService = require('../services/project.service');

const router = express.Router();

/**
 * 用户列表。
 *
 * ⚠ 不限管理员：建项向导需要用它来挑成员，普通 PM 也必须能读。
 * 返回全字段 `User`（含 globalRole / dept），前端 `GLOBAL_ROLE_LABEL` 依赖之。
 */
router.get(
  '/admin/users',
  requireAuth,
  asyncHandler(async function listUsers(req, res) {
    const rows = db
      .prepare('SELECT * FROM users ORDER BY id ASC')
      .all();
    res.json(ok(rows.map(toApiUser)));
  }),
);

/** 生命周期模板列表 */
router.get(
  '/admin/templates',
  requireAuth,
  asyncHandler(async function listTemplates(req, res) {
    res.json(ok(projectService.listTemplates(db)));
  }),
);

/**
 * 修改用户全局角色（仅 admin）。
 *
 * 守卫：
 *  - `E_SELF_ROLE`  不能改自己的角色（防误操作把自己降权）
 *  - `E_LAST_ADMIN` 系统至少保留一名 admin
 */
router.patch(
  '/admin/users/:openId',
  requireAuth,
  requireGlobalRole('admin'),
  asyncHandler(async function updateUserRole(req, res) {
    const openId = String(req.params.openId || '');
    const role = String((req.body && req.body.globalRole) || '');

    if (GLOBAL_ROLES.indexOf(role) < 0) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'globalRole', message: '全局角色不合法' }],
      });
    }
    const target = db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId);
    if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '用户不存在', { openId: openId });

    if (openId === String(req.user.open_id)) {
      throw new AppError(ErrorCode.E_SELF_ROLE, undefined, { openId: openId });
    }
    if (target.global_role === 'admin' && role !== 'admin') {
      const cnt = db.prepare("SELECT COUNT(*) AS n FROM users WHERE global_role = 'admin'").get();
      if (!cnt || Number(cnt.n) <= 1) {
        throw new AppError(ErrorCode.E_LAST_ADMIN, undefined, { openId: openId });
      }
    }

    db.prepare('UPDATE users SET global_role = ?, updated_at = ? WHERE open_id = ?')
      .run(role, nowIso(), openId);

    // TODO(批次4): 写入 audit 日志（audit_logs 表批次 4 建立）
    res.json(ok(toApiUser(db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId)), '角色已更新'));
  }),
);

module.exports = router;
