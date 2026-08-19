const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../../config');
const { AppError, ErrorCode } = require('../lib/errors');

/**
 * 任务附件 / 文档模块（C01）服务层。
 * 方案 A：把「任务附件」作为现有文档模块的第一个真正实现——
 * 在 WBS 任务或里程碑上挂文件，上传到自有服务器磁盘，列表/预览/删除。
 * （生命周期模板派生 + 基线管控暂缓，后续单独讨论。）
 */

/** 允许的文件 MIME 白名单（阻断可执行文件等危险类型） */
const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'text/markdown',
  'application/zip', 'application/x-zip-compressed',
  'application/json',
]);
const MAX_SIZE = 20 * 1024 * 1024;

function root() {
  return cfg.ATTACHMENT_ROOT;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function mapRow(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    nodeId: r.node_id || '',
    milestoneId: r.milestone_id || '',
    name: r.name,
    fileName: r.file_name,
    fileSize: r.file_size,
    mimeType: r.mime_type || '',
    storagePath: r.storage_path,
    docType: r.doc_type || 'file',
    url: r.url || '',
    uploadedBy: r.uploaded_by || '',
    uploadedAt: r.uploaded_at,
    createdAt: r.created_at,
  };
}

function listDocuments(db, projectId, opts) {
  opts = opts || {};
  const params = [projectId];
  let sql = 'SELECT * FROM project_documents WHERE project_id = ?';
  if (opts.nodeId) { sql += ' AND node_id = ?'; params.push(opts.nodeId); }
  if (opts.milestoneId) { sql += ' AND milestone_id = ?'; params.push(opts.milestoneId); }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params).map(mapRow);
}

function getDocument(db, id) {
  const r = db.prepare('SELECT * FROM project_documents WHERE id = ?').get(id);
  if (!r) throw new AppError(ErrorCode.E_NOT_FOUND, '附件不存在');
  return mapRow(r);
}

/**
 * 关联校验（nodeId / milestoneId 必须存在且属于当前项目）；非法抛 E_VALIDATION。
 * 上传与链接创建共用，杜绝两处口径漂移。
 */
function assertAssociation(db, projectId, nodeId, milestoneId) {
  if (nodeId) {
    const node = db.prepare('SELECT id, project_id FROM wbs_nodes WHERE id = ?').get(nodeId);
    if (!node || node.project_id !== projectId) {
      throw new AppError(ErrorCode.E_VALIDATION, '关联任务不存在或不属于当前项目');
    }
  }
  if (milestoneId) {
    const ms = db.prepare('SELECT id, project_id FROM milestones WHERE id = ?').get(milestoneId);
    if (!ms || ms.project_id !== projectId) {
      throw new AppError(ErrorCode.E_VALIDATION, '关联里程碑不存在或不属于当前项目');
    }
  }
}

function uploadDocument(db, projectId, payload) {
  const file = payload.file;
  if (!file || !file.buffer || !file.originalname) {
    throw new AppError(ErrorCode.E_VALIDATION, '未收到有效文件');
  }
  if (file.size > MAX_SIZE) {
    throw new AppError(ErrorCode.E_VALIDATION, '文件超过 20MB 上限');
  }
  const mime = file.mimetype || '';
  if (!ALLOWED_MIME.has(mime)) {
    throw new AppError(ErrorCode.E_VALIDATION, '不支持的文件类型：' + (mime || '未知'));
  }

  const nodeId = payload.nodeId || '';
  const milestoneId = payload.milestoneId || '';
  assertAssociation(db, projectId, nodeId, milestoneId);

  const safeName = String(file.originalname).replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(-120) || 'file';
  const storedName = crypto.randomUUID() + '_' + safeName;
  const projectDir = path.join(root(), projectId);
  ensureDir(projectDir);
  fs.writeFileSync(path.join(projectDir, storedName), file.buffer);

  const now = new Date().toISOString();
  const id = 'DOC_' + crypto.randomUUID().slice(0, 12);
  db.prepare(
    `INSERT INTO project_documents
      (id, project_id, node_id, milestone_id, name, file_name, file_size, mime_type, storage_path, uploaded_by, uploaded_at, created_at)
     VALUES (@id, @projectId, @nodeId, @milestoneId, @name, @fileName, @fileSize, @mimeType, @storagePath, @uploadedBy, @uploadedAt, @createdAt)`
  ).run({
    id: id,
    projectId: projectId,
    nodeId: nodeId,
    milestoneId: milestoneId,
    name: file.originalname,
    fileName: storedName,
    fileSize: file.size,
    mimeType: mime,
    storagePath: path.join(projectId, storedName),
    uploadedBy: (payload.me && payload.me.open_id) || '',
    uploadedAt: now,
    createdAt: now,
  });

  return getDocument(db, id);
}

function deleteDocument(db, id) {
  const doc = getDocument(db, id);
  const full = path.join(root(), doc.storagePath);
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch (e) {
    // 文件已丢失不影响记录清理（沙箱 safe-delete 拦截等异常忽略）
  }
  db.prepare('DELETE FROM project_documents WHERE id = ?').run(id);
  return doc;
}

/**
 * 创建外链文档记录（D02 · 飞书文档关联）。
 *
 * - `url` 必须为 http(s) 链接（飞书/外链均可），存 url 列，doc_type='link'，storage_path=''；
 * - 名称优先级：用户填写 name > 飞书自动抓取 title > 链接本身；
 * - 关联校验与上传共用 `assertAssociation`（RBAC 由路由层保证，本函数只做数据层校验）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {{url: string, name?: string, nodeId?: string, milestoneId?: string, me?: object, title?: string}} payload
 *   `title` 由路由层调 feishu.fetchDocTitle 抓取（失败/未配凭证为空串）
 * @returns {object} ProjectDocument（mapRow 形态）
 */
function createLinkDocument(db, projectId, payload) {
  const url = String(payload.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new AppError(ErrorCode.E_VALIDATION, '链接必须以 http:// 或 https:// 开头');
  }
  const nodeId = payload.nodeId || '';
  const milestoneId = payload.milestoneId || '';
  assertAssociation(db, projectId, nodeId, milestoneId);

  const title = String(payload.title || '').trim();
  const name = String(payload.name || '').trim() || title || url;

  const now = new Date().toISOString();
  const id = 'DOC_' + crypto.randomUUID().slice(0, 12);
  db.prepare(
    `INSERT INTO project_documents
      (id, project_id, node_id, milestone_id, name, file_name, file_size, mime_type,
       storage_path, doc_type, url, uploaded_by, uploaded_at, created_at)
     VALUES (@id, @projectId, @nodeId, @milestoneId, @name, '', 0, '',
       '', 'link', @url, @uploadedBy, @uploadedAt, @createdAt)`,
  ).run({
    id: id,
    projectId: projectId,
    nodeId: nodeId,
    milestoneId: milestoneId,
    name: name,
    url: url,
    uploadedBy: (payload.me && payload.me.open_id) || '',
    uploadedAt: now,
    createdAt: now,
  });

  return getDocument(db, id);
}

module.exports = { listDocuments, getDocument, uploadDocument, createLinkDocument, deleteDocument };
