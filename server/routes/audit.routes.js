/**
 * 审计日志路由（D08.3 · 替换 stubs 空桩）
 *
 * GET /audit?projectId=&entityType=&action=&actor=&from=&to=&page=&pageSize=
 * 对齐 `web/src/api/contract.ts` listAudit → Paged<AuditLog>。
 */

const { Router } = require('express');
const db = require('../../db');
const { ok, asyncHandler } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, projectRolesOf, globalRolesOf } = require('../middleware/rbac');
const { AppError, ErrorCode } = require('../lib/errors');
const { canDo } = require('../config/permissions');
const auditService = require('../services/audit.service');

const router = Router();

/**
 * 审计分页查询。
 *  - 全局审计（无 projectId）：与导出端点 /export/audits 同源，需 admin:audit:view 权限矩阵守门。
 *  - 项目级审计（带 projectId）：对「项目成员」或「拥有 admin:audit:view 的管理员」开放；
 *    后端在此强制校验，避免非成员凭 projectId 越权读取他人项目审计日志，
 *    同时保证管理员仍可查看任意项目审计（与全局审计视图权限一致）。
 */
router.get(
  '/audit',
  requireAuth,
  function gateAudit(req, res, next) {
    const projectId = req.query.projectId ? String(req.query.projectId) : null;
    if (!projectId) {
      return requirePermission('admin:audit:view')(req, res, next);
    }
    try {
      const globalRoles = globalRolesOf(db, req.user.id, req.user.global_role);
      const isAuditAdmin = canDo(globalRoles, 'admin:audit:view');
      const isMember = projectRolesOf(db, projectId, req.user.id).length > 0;
      if (!isAuditAdmin && !isMember) {
        throw new AppError(ErrorCode.E_FORBIDDEN, '无权限查看该项目审计日志');
      }
      next();
    } catch (e) {
      next(e);
    }
  },
  asyncHandler(async function listAudit(req, res) {
    res.json(ok(auditService.listAudit(db, req.query || {})));
  }),
);

module.exports = router;
