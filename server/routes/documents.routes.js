/**
 * 任务附件（C01）路由 —— 方案 A：把「任务附件」作为文档模块的第一个真正实现。
 *
 * 端点（挂在 /api 前缀下，由 index.routes.js 统一挂载）：
 *  - GET    /projects/:projectId/documents           列表（支持 ?nodeId= / ?milestoneId= 过滤）
 *  - POST   /projects/:projectId/documents           上传（multipart/form-data，字段名 file）
 *  - DELETE /projects/:projectId/documents/:id        删除
 *
 * RBAC 守卫次序（共享约定 §4）：requireAuth → assertWritable → assertCan。
 *  - 上传：document:upload（全员可传，见 server/config/permissions.js）
 *  - 删除：document:delete（仅 admin / 项目负责人）
 *
 * ⚠ 本路由必须挂载在 stubs.routes.js 之前，否则文档请求会被 501 桩抢先命中。
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const db = require('../../db');
const cfg = require('../../config');
const { ok, asyncHandler, AppError, ErrorCode } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const rbac = require('../middleware/rbac');
const documentSvc = require('../services/document.service');

const router = express.Router();

/* multer 内存存储：文件进 req.file.buffer，由 service 落盘（便于 UUID 重命名 + MIME 二次校验）。
 * 限制单文件、20MB；超限转 AppError，由全局 errorMiddleware 统一转信封形态。 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

/** multer 错误 → AppError 包装（避免 Express 默认 HTML 500 吞掉错误） */
function uploadSingle(field) {
  const m = upload.single(field);
  return function (req, res, next) {
    m(req, res, function (err) {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(ErrorCode.E_VALIDATION, '文件超过 20MB 上限'));
      }
      return next(new AppError(ErrorCode.E_VALIDATION, '文件上传失败：' + (err.message || '未知错误')));
    });
  };
}

/* ── 读 ─────────────────────────────────────────────── */

/** 附件列表：登录即可读（与任务 / 周报列表同级可见性）；支持 nodeId / milestoneId 过滤 */
router.get(
  '/projects/:projectId/documents',
  requireAuth,
  asyncHandler(async function listDocuments(req, res) {
    const projectId = req.params.projectId;
    rbac.loadProject(db, projectId); // 404 兜底
    const opts = {};
    if (req.query.nodeId) opts.nodeId = String(req.query.nodeId);
    if (req.query.milestoneId) opts.milestoneId = String(req.query.milestoneId);
    res.json(ok(documentSvc.listDocuments(db, projectId, opts)));
  }),
);

/* ── 写 ─────────────────────────────────────────────── */

/** 上传：multipart/form-data，字段名 `file`；可选 `nodeId` / `milestoneId` 关联任务或里程碑 */
router.post(
  '/projects/:projectId/documents',
  requireAuth,
  uploadSingle('file'),
  asyncHandler(async function uploadDocument(req, res) {
    const projectId = req.params.projectId;
    rbac.assertWritable(db, projectId);
    rbac.assertCan(db, req, 'document:upload', projectId);

    const body = req.body || {};
    const doc = documentSvc.uploadDocument(db, projectId, {
      file: req.file,
      nodeId: body.nodeId || '',
      milestoneId: body.milestoneId || '',
      me: req.user,
    });
    res.json(ok(doc, '上传成功'));
  }),
);

/** 删除：仅 admin / 项目负责人（document:delete） */
router.delete(
  '/projects/:projectId/documents/:id',
  requireAuth,
  asyncHandler(async function deleteDocument(req, res) {
    const projectId = req.params.projectId;
    rbac.assertWritable(db, projectId);
    rbac.assertCan(db, req, 'document:delete', projectId);

    const doc = documentSvc.deleteDocument(db, req.params.id);
    res.json(ok(doc, '已删除'));
  }),
);

/**
 * 下载 / 预览：把磁盘文件流式返回。
 *  - `?download=1` → Content-Disposition: attachment（触发浏览器下载）
 *  - 否则 inline（图片 / PDF 可直接在浏览器预览）
 * 鉴权：登录即可（与列表同口径）；并强制 storagePath 落在 ATTACHMENT_ROOT 内，防越权 / 路径穿越。
 */
router.get(
  '/projects/:projectId/documents/:id/download',
  requireAuth,
  asyncHandler(async function downloadDocument(req, res) {
    const projectId = req.params.projectId;
    const doc = documentSvc.getDocument(db, req.params.id);
    if (doc.projectId !== projectId) {
      throw new AppError(ErrorCode.E_FORBIDDEN, '附件不属于当前项目');
    }

    const root = cfg.ATTACHMENT_ROOT;
    const full = path.join(root, doc.storagePath);
    const resolved = path.resolve(full);
    if (resolved !== path.join(path.resolve(root), doc.storagePath)) {
      throw new AppError(ErrorCode.E_NOT_FOUND, '文件路径非法');
    }
    if (!fs.existsSync(full)) {
      throw new AppError(ErrorCode.E_NOT_FOUND, '文件已不存在');
    }

    const asDownload = req.query.download === '1' || req.query.download === 'true';
    const disposition = asDownload ? 'attachment' : 'inline';
    const safeName = encodeURIComponent(doc.name || doc.fileName || 'file');
    res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${safeName}"; filename*=UTF-8''${safeName}`,
    );

    const stream = fs.createReadStream(full);
    stream.on('error', function () {
      if (!res.headersSent) res.status(404).json(ok(null, '文件读取失败'));
    });
    stream.pipe(res);
  }),
);

module.exports = router;
