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
const auditService = require('../services/audit.service');

const router = Router();

/** 审计分页查询 */
router.get(
  '/audit',
  requireAuth,
  asyncHandler(async function listAudit(req, res) {
    res.json(ok(auditService.listAudit(db, req.query || {})));
  }),
);

module.exports = router;
