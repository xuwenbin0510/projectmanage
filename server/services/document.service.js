const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../../config');
const { AppError, ErrorCode } = require('../lib/errors');
const mappers = require('../lib/mappers');
const { writeAudit } = require('../lib/audit');

/**
 * 任务附件 / 文档模块（C01/D02/D04）服务层。
 * C01 方案 A：任务附件；D02：飞书链接记录；D04：模板派生交付物清单（按里程碑挂载 + 版本升版）。
 * （基线管控 + 质量门联动暂缓，后续单独讨论。）
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

function mapRow(r, nameOf) {
  // 设计修正：优先用 *_user_id（users.id，稳定身份键）解析姓名，open_id 仅兜底
  const nameOfFn = typeof nameOf === 'function' ? nameOf : null;
  const nameFor = function (userId, fallbackKey) {
    if (!nameOfFn) return '';
    const key = userId != null ? userId : (fallbackKey || null);
    if (key == null) return '';
    return nameOfFn(key);
  };
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
    templateKey: r.template_key || '',
    status: r.status || '已交付',
    version: r.version || 1,
    baselineFlag: r.baseline_flag ? 1 : 0,
    baselinedAt: r.baselined_at || '',
    baselinedBy: r.baselined_by || '',
    baselinedByName: nameFor(r.baselined_by_user_id, r.baselined_by),
    uploadedBy: r.uploaded_by || '',
    uploadedByName: nameFor(r.uploaded_by_user_id, r.uploaded_by),
    uploadedAt: r.uploaded_at,
    createdAt: r.created_at,
  };
}

function newDocId() {
  return 'DOC_' + crypto.randomUUID().slice(0, 12);
}

function listDocuments(db, projectId, opts) {
  /* D04 懒派生：存量项目首次列表时按模板补清单（幂等，失败不影响列表） */
  try {
    ensureTemplateDerived(db, projectId);
  } catch (e) {
    // 派生失败静默，下次列表重试
  }
  opts = opts || {};
  const params = [projectId];
  let sql = 'SELECT * FROM project_documents WHERE project_id = ?';
  if (opts.nodeId) { sql += ' AND node_id = ?'; params.push(opts.nodeId); }
  if (opts.milestoneId) { sql += ' AND milestone_id = ?'; params.push(opts.milestoneId); }
  sql += ' ORDER BY created_at DESC';
  const nameOf = mappers.makeNameLookup(db);
  return db.prepare(sql).all(...params).map(function (r) { return mapRow(r, nameOf); });
}

/**
 * 按项目模板派生「待交付物清单」（D04 · 幂等：template_key 判重，不重复派生）。
 *
 * 模板 `definition.docs` 为结构化 `{name, milestoneCode}[]`（D04 起）；
 * 每条派生记录的 milestone_id 按「项目里程碑 code」匹配填充（未匹配 → 项目级 ''）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {object} tplRow lifecycle_templates 行（含 definition JSON）
 * @returns {number} 本次派生的条目数
 */
function deriveTemplateDocs(db, projectId, tplRow) {
  if (!tplRow) return 0;
  let def;
  try {
    def = JSON.parse(tplRow.definition || '{}');
  } catch (e) {
    def = {};
  }
  const docs = Array.isArray(def.docs) ? def.docs : [];
  if (!docs.length) return 0;

  /* 项目里程碑 code → id（派生时按 code 挂载） */
  const msMap = {};
  db.prepare('SELECT id, code FROM milestones WHERE project_id = ?')
    .all(projectId)
    .forEach(function (r) { msMap[String(r.code)] = String(r.id); });

  /* 已存在 template_key → 判重（删除过的模板项不再补派生） */
  const existing = new Set(
    db
      .prepare("SELECT template_key FROM project_documents WHERE project_id = ? AND template_key != ''")
      .all(projectId)
      .map(function (r) { return r.template_key; }),
  );

  /* 用户有意删除过的模板 key → 派生时跳过，避免删了又复活 */
  const removed = new Set(
    db
      .prepare("SELECT template_key FROM removed_template_docs WHERE project_id = ? AND template_key LIKE ?")
      .all(projectId, String(tplRow.id || 'TPL') + '-%')
      .map(function (r) { return r.template_key; }),
  );

  const now = new Date().toISOString();
  const ins = db.prepare(`
    INSERT INTO project_documents
      (id, project_id, node_id, milestone_id, name, file_name, file_size, mime_type,
       storage_path, doc_type, url, uploaded_by, uploaded_at, created_at,
       template_key, status, version, baseline_flag)
    VALUES (?, ?, '', ?, ?, '', 0, '', '', '', '', '', ?, ?, ?, '待交付', 1, 0)
  `);
  let count = 0;
  docs.forEach(function (doc, i) {
    const key = String(tplRow.id || 'TPL') + '-' + String(i + 1);
    if (existing.has(key) || removed.has(key)) return;
    const name = String((doc && doc.name) || '').trim() || '交付物 ' + (i + 1);
    const msId = doc && doc.milestoneCode ? msMap[String(doc.milestoneCode)] || '' : '';
    ins.run(newDocId(), projectId, msId, name, now, now, key);
    count += 1;
  });
  return count;
}

/**
 * 懒派生守卫：当前生效模板的交付物尚未派生时按模板补派生（幂等）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {number} 本次派生的条目数（0 = 无需派生）
 */
function ensureTemplateDerived(db, projectId) {
  const p = db.prepare('SELECT type, template_id FROM projects WHERE id = ?').get(projectId);
  if (!p) return 0;
  const tpl = db
    .prepare('SELECT * FROM lifecycle_templates WHERE project_type = ? AND is_active = 1 ORDER BY version DESC LIMIT 1')
    .get(String(p.type));
  if (!tpl) return 0;
  /* 不再用「has>0 早退」判重：删除全部模板项后 has=0 会整组复活（D-BUG）。
     改由 deriveTemplateDocs 逐 key 判重（existing ∪ removed），删除意图被尊重。 */
  return deriveTemplateDocs(db, projectId, tpl);
}

function getDocument(db, id) {
  const r = db.prepare('SELECT * FROM project_documents WHERE id = ?').get(id);
  if (!r) throw new AppError(ErrorCode.E_NOT_FOUND, '附件不存在');
  return mapRow(r, mappers.makeNameLookup(db));
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

  /* D04：templateKey 命中模板清单项 → 覆盖升版（status='已交付'，version+1，删旧文件） */
  const templateKey = String(payload.templateKey || '').trim();
  if (templateKey) {
    const existing = db
      .prepare('SELECT * FROM project_documents WHERE project_id = ? AND template_key = ?')
      .get(projectId, templateKey);
    if (existing) {
      /* D05：已基线交付物替换必须填写变更原因（写审计留痕，baseline_flag 保留、baselined_at 更新） */
      const changeNote = String((payload && payload.changeNote) || '').trim();
      if (existing.baseline_flag && !changeNote) {
        throw new AppError(ErrorCode.E_DOC_CHANGE_NOTE_REQUIRED);
      }
      try {
        if (existing.storage_path && fs.existsSync(path.join(root(), existing.storage_path))) {
          fs.unlinkSync(path.join(root(), existing.storage_path));
        }
      } catch (e) {
        // 旧文件丢失不影响升版
      }
      /* 覆盖升版：未显式提供关联时保留模板项原有 milestone/node 挂载；
         首次交付（原待交付）保持 v1，已交付再替换才 +1 */
      const keepNode = nodeId || existing.node_id || '';
      const keepMs = milestoneId || existing.milestone_id || '';
      const nextVersion = existing.status === '待交付' ? 1 : (Number(existing.version) || 1) + 1;
      db.prepare(
        `UPDATE project_documents SET
          node_id = @nodeId, milestone_id = @milestoneId, name = @name, file_name = @fileName,
          file_size = @fileSize, mime_type = @mimeType, storage_path = @storagePath,
          doc_type = 'file', url = '', uploaded_by = @uploadedBy, uploaded_by_user_id = @uploadedByUserId, uploaded_at = @uploadedAt,
          status = '已交付', version = @version${existing.baseline_flag ? ', baselined_at = @baselinedAt' : ''}
         WHERE id = @id`,
      ).run({
        id: existing.id,
        nodeId: keepNode,
        milestoneId: keepMs,
        name: file.originalname,
        fileName: storedName,
        fileSize: file.size,
        mimeType: mime,
        storagePath: path.join(projectId, storedName),
        uploadedBy: (payload.me && payload.me.open_id) || '',
        uploadedByUserId: mappers.resolveUserId(db, (payload.me && payload.me.open_id) || ''),
        uploadedAt: now,
        version: nextVersion,
        baselinedAt: now,
      });
      if (existing.baseline_flag && changeNote) {
        writeAudit(
          db, payload.me, 'document', existing.id, 'baseline_change', projectId,
          '替换已基线交付物「' + existing.name + '」：v' + (Number(existing.version) || 1) + ' → v' + nextVersion + '（' + changeNote + '）',
          [{ field: 'version', label: '版本', before: 'v' + (Number(existing.version) || 1), after: 'v' + nextVersion }],
        );
      }
      return getDocument(db, existing.id);
    }
  }

  const id = newDocId();
  db.prepare(
    `INSERT INTO project_documents
      (id, project_id, node_id, milestone_id, name, file_name, file_size, mime_type,
       storage_path, doc_type, url, uploaded_by, uploaded_by_user_id, uploaded_at, created_at,
       template_key, status, version, baseline_flag)
     VALUES (@id, @projectId, @nodeId, @milestoneId, @name, @fileName, @fileSize, @mimeType,
       @storagePath, 'file', '', @uploadedBy, @uploadedByUserId, @uploadedAt, @createdAt,
       '', '已交付', 1, 0)`
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
    uploadedByUserId: mappers.resolveUserId(db, (payload.me && payload.me.open_id) || ''),
    uploadedAt: now,
    createdAt: now,
  });

  return getDocument(db, id);
}

function deleteDocument(db, req, id) {
  const doc = getDocument(db, id);
  const full = path.join(root(), doc.storagePath);
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch (e) {
    // 文件已丢失不影响记录清理（沙箱 safe-delete 拦截等异常忽略）
  }
  db.prepare('DELETE FROM project_documents WHERE id = ?').run(id);
  /* 记录用户有意删除的模板托管项（非 CUS- 自定义项），避免列表派生复活 */
  if (doc.templateKey && !doc.templateKey.startsWith('CUS-')) {
    const operator = (req && req.user && (req.user.openId || req.user.open_id)) || '';
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO removed_template_docs (project_id, template_key, removed_by, removed_at)
      VALUES (?, ?, ?, ?)
    `).run(doc.projectId, doc.templateKey, operator, now);
  }
  return doc;
}

/**
 * 对已交付模板项建立基线（D05 · 幂等：已基线直接返回）。
 *
 * - 仅 `template_key != ''` 且 `status = '已交付'` 的记录可建基线；
 * - baseline_flag=1 + baselined_at/by（操作人）；
 * - 写审计（action='baseline'）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} req express req（用于取操作人）
 * @param {string} projectId
 * @param {string} docId
 * @returns {object} ProjectDocument
 * @throws {AppError} E_NOT_FOUND / E_VALIDATION
 */
function baselineDocument(db, req, projectId, docId) {
  const doc = getDocument(db, docId);
  if (doc.projectId !== String(projectId)) {
    throw new AppError(ErrorCode.E_NOT_FOUND, '文档不存在', { docId: String(docId) });
  }
  if (!doc.templateKey) {
    throw new AppError(ErrorCode.E_VALIDATION, '仅模板交付物可建立基线');
  }
  if (doc.status !== '已交付') {
    throw new AppError(ErrorCode.E_VALIDATION, '交付物尚未交付，不能建立基线');
  }
  if (doc.baselineFlag) return doc;

  const me = req.user || {};
  const now = new Date().toISOString();
  const openId = me.open_id !== undefined ? me.open_id : me.openId;
  // 设计修正：边界把 open_id 解析为系统稳定身份键 users.id 落库
  const baselinedByUserId = mappers.resolveUserId(db, openId);
  db.prepare('UPDATE project_documents SET baseline_flag = 1, baselined_at = ?, baselined_by = ?, baselined_by_user_id = ? WHERE id = ?')
    .run(now, String(openId || ''), baselinedByUserId, String(docId));
  writeAudit(
    db, me, 'document', String(docId), 'baseline', String(projectId),
    '对交付物「' + doc.name + '」建立基线（v' + (doc.version || 1) + '）',
    [{ field: 'baseline_flag', label: '基线', before: '未纳入', after: '已纳入' }],
  );
  return getDocument(db, docId);
}

/**
 * 项目内增补「门控必交付项」（D06 · 项目级覆盖，只影响本项目）。
 *
 * - 生成待交付清单项：`template_key='CUS-<序号>'`（CUS- 前缀，与模板项 TPL- 区分），
 *   milestone_id 挂到目标里程碑，status='待交付'；
 * - **自动参与门控校验**：decideGate 的校验 SQL 是 `template_key != '' AND status='待交付'`，
 *   CUS 项天然被覆盖——门通过前必须交付；
 * - 交付方式与模板项一致（上传/链接覆盖升版）；可删除（删除 = 放弃该义务，不再补派生）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} req express req（权限由路由层校验，此处取操作人写审计）
 * @param {string} projectId
 * @param {{milestoneId?: string, name?: string}} payload
 * @returns {object} ProjectDocument
 * @throws {AppError} E_VALIDATION / E_NOT_FOUND
 */
function addRequiredDeliverable(db, req, projectId, payload) {
  const p = payload || {};
  const msId = String(p.milestoneId || '').trim();
  const name = String(p.name || '').trim();
  if (!msId) throw new AppError(ErrorCode.E_VALIDATION, '请选择里程碑');
  if (!name) throw new AppError(ErrorCode.E_VALIDATION, '必交付项名称不能为空');

  const ms = db.prepare('SELECT id FROM milestones WHERE id = ? AND project_id = ?').get(msId, projectId);
  if (!ms) throw new AppError(ErrorCode.E_NOT_FOUND, '里程碑不存在', { milestoneId: msId });

  const seq = db
    .prepare("SELECT COUNT(*) c FROM project_documents WHERE project_id = ? AND template_key LIKE 'CUS-%'")
    .get(projectId).c + 1;
  const key = 'CUS-' + String(seq);
  const now = new Date().toISOString();
  const id = newDocId();
  db.prepare(
    `INSERT INTO project_documents
      (id, project_id, node_id, milestone_id, name, file_name, file_size, mime_type,
       storage_path, doc_type, url, uploaded_by, uploaded_at, created_at,
       template_key, status, version, baseline_flag)
     VALUES (?, ?, '', ?, ?, '', 0, '', '', '', '', '', ?, ?, ?, '待交付', 1, 0)`,
  ).run(id, String(projectId), msId, name, now, now, key);

  const me = req.user || {};
  writeAudit(
    db, me, 'document', id, 'create', String(projectId),
    '新增门控必交付项「' + name + '」（挂里程碑 ' + msId + '，门通过前须交付）',
    [],
  );
  return getDocument(db, id);
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

  /* D04：templateKey 命中模板清单项 → 覆盖升版（docType='link'） */
  const templateKey = String(payload.templateKey || '').trim();
  if (templateKey) {
    const existing = db
      .prepare('SELECT * FROM project_documents WHERE project_id = ? AND template_key = ?')
      .get(projectId, templateKey);
    if (existing) {
      /* D05：已基线交付物替换必须填写变更原因 */
      const changeNote = String((payload && payload.changeNote) || '').trim();
      if (existing.baseline_flag && !changeNote) {
        throw new AppError(ErrorCode.E_DOC_CHANGE_NOTE_REQUIRED);
      }
      const keepNode = nodeId || existing.node_id || '';
      const keepMs = milestoneId || existing.milestone_id || '';
      const nextVersion = existing.status === '待交付' ? 1 : (Number(existing.version) || 1) + 1;
      db.prepare(
        `UPDATE project_documents SET
          node_id = @nodeId, milestone_id = @milestoneId, name = @name, file_name = '',
          file_size = 0, mime_type = '', storage_path = '',
          doc_type = 'link', url = @url, uploaded_by = @uploadedBy, uploaded_by_user_id = @uploadedByUserId, uploaded_at = @uploadedAt,
          status = '已交付', version = @version${existing.baseline_flag ? ', baselined_at = @baselinedAt' : ''}
         WHERE id = @id`,
      ).run({
        id: existing.id,
        nodeId: keepNode,
        milestoneId: keepMs,
        name: name,
        url: url,
        uploadedBy: (payload.me && payload.me.open_id) || '',
        uploadedByUserId: mappers.resolveUserId(db, (payload.me && payload.me.open_id) || ''),
        uploadedAt: now,
        version: nextVersion,
        baselinedAt: now,
      });
      if (existing.baseline_flag && changeNote) {
        writeAudit(
          db, payload.me, 'document', existing.id, 'baseline_change', projectId,
          '替换已基线交付物「' + existing.name + '」：v' + (Number(existing.version) || 1) + ' → v' + nextVersion + '（' + changeNote + '）',
          [{ field: 'version', label: '版本', before: 'v' + (Number(existing.version) || 1), after: 'v' + nextVersion }],
        );
      }
      return getDocument(db, existing.id);
    }
  }

  const id = newDocId();
  db.prepare(
    `INSERT INTO project_documents
      (id, project_id, node_id, milestone_id, name, file_name, file_size, mime_type,
       storage_path, doc_type, url, uploaded_by, uploaded_by_user_id, uploaded_at, created_at,
       template_key, status, version, baseline_flag)
     VALUES (@id, @projectId, @nodeId, @milestoneId, @name, '', 0, '',
       '', 'link', @url, @uploadedBy, @uploadedByUserId, @uploadedAt, @createdAt,
       '', '已交付', 1, 0)`,
  ).run({
    id: id,
    projectId: projectId,
    nodeId: nodeId,
    milestoneId: milestoneId,
    name: name,
    url: url,
    uploadedBy: (payload.me && payload.me.open_id) || '',
    uploadedByUserId: mappers.resolveUserId(db, (payload.me && payload.me.open_id) || ''),
    uploadedAt: now,
    createdAt: now,
  });

  return getDocument(db, id);
}

module.exports = {
  listDocuments,
  getDocument,
  uploadDocument,
  createLinkDocument,
  deleteDocument,
  baselineDocument,
  addRequiredDeliverable,
  deriveTemplateDocs,
  ensureTemplateDerived,
};
