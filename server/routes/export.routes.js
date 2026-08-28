/**
 * 数据导出路由（CSV，本期仅导出）。
 *
 *  GET /api/export/projects           → 项目清单 CSV（登录即可；admin/pmo/management 看全量）
 *  GET /api/export/projects/:id/tasks → 项目 WBS 任务 CSV
 *  GET /api/export/projects/:id/reports→ 项目周报 CSV
 *  GET /api/export/audits             → 审计日志 CSV（需 admin:audit:view 权限，与审计日志页同源）
 *
 * 响应：text/csv + Content-Disposition: attachment（文件名含日期戳）。
 * 读取口径完全复用既有 service，不引入新依赖。
 */

const express = require('express');
const db = require('../../db');
const { asyncHandler, AppError, ErrorCode } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const exportService = require('../services/export.service');

const router = express.Router();

/** 以附件形式回 CSV（含 UTF-8 BOM，Excel 中文不乱码）。 */
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(filename) + '"');
  res.send(csv);
}

/** 项目清单导出 */
router.get(
  '/export/projects',
  requireAuth,
  asyncHandler(async function exportProjects(req, res) {
    const csv = exportService.exportProjectsCsv(req.user);
    sendCsv(res, 'projects_' + exportService.dateStamp() + '.csv', csv);
  }),
);

/** 项目 WBS 任务导出 */
router.get(
  '/export/projects/:id/tasks',
  requireAuth,
  asyncHandler(async function exportTasks(req, res) {
    const projectId = String(req.params.id || '');
    if (!db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId)) {
      throw new AppError(ErrorCode.E_NOT_FOUND, '项目不存在', { projectId: projectId });
    }
    const csv = exportService.exportProjectTasksCsv(projectId);
    sendCsv(res, 'project_tasks_' + projectId + '_' + exportService.dateStamp() + '.csv', csv);
  }),
);

/** 项目周报导出 */
router.get(
  '/export/projects/:id/reports',
  requireAuth,
  asyncHandler(async function exportReports(req, res) {
    const projectId = String(req.params.id || '');
    if (!db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId)) {
      throw new AppError(ErrorCode.E_NOT_FOUND, '项目不存在', { projectId: projectId });
    }
    const csv = exportService.exportProjectReportsCsv(projectId);
    sendCsv(res, 'project_reports_' + projectId + '_' + exportService.dateStamp() + '.csv', csv);
  }),
);

/** 审计日志导出（仅管理角色） */
router.get(
  '/export/audits',
  requireAuth,
  requirePermission('admin:audit:view'),
  asyncHandler(async function exportAudits(req, res) {
    const csv = exportService.exportAuditsCsv();
    sendCsv(res, 'audits_' + exportService.dateStamp() + '.csv', csv);
  }),
);

module.exports = router;
