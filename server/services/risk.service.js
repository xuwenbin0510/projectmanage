/**
 * 风险登记册服务（本期新增功能域）
 *
 * 权限：复用 `project:edit`（负责人 / 管理员 / 项目负责人），**不新增权限点**，
 *   与里程碑、文档等写操作同口径，避免改动 RBAC 矩阵机制。
 *
 * 口径铁律（与前端 Mock `toListItem` / `riskValue` 列逐字一致）：
 *  - `risk_value = probability * impact`，落库去重算，读路径不再现场乘
 *  - 高风险阈值 `risk_value >= 12`（RISK_HIGH_THRESHOLD）
 *  - `code` 形如 `RISK-序号`，按项目内最大序号 +1，UNIQUE 约束兜底防撞
 *  - 概率 / 影响取值域 1~5（越界自动夹紧）
 *
 * ⚠ **循环依赖纪律**：本文件**不得** `require('./project.service')`，
 *   需要的项目行用 `loadProjectRow` 自查。
 */

const { AppError, ErrorCode } = require('../lib/errors');
const dates = require('../lib/dates');
const ids = require('../lib/ids');
const rbac = require('../middleware/rbac');
const mappers = require('../lib/mappers');
const { writeAudit, diffEntry } = require('../lib/audit');

/** 高风险阈值：risk_value >= 12（与前端 Mock 逐字一致） */
const RISK_HIGH_THRESHOLD = 12;

/** 概率 / 影响取值域（1~5） */
const RISK_LEVEL_MIN = 1;
const RISK_LEVEL_MAX = 5;

/* ═══════════════════════════════════════════════════
 * 一、基础读取
 * ═══════════════════════════════════════════════════ */

/**
 * 读项目行（未删除）；不存在返回 undefined。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {object|undefined}
 */
function loadProjectRow(db, projectId) {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(String(projectId || ''));
}

/**
 * DB 行 → API 形态。
 * @param {object} row risks 行
 * @param {import('better-sqlite3').Database} [db] 用于解析 owner_user_id → 姓名
 * @returns {object} Risk
 */
function toApiRisk(row, db) {
  let ownerName = '';
  // 设计修正：优先用 owner_user_id（users.id，稳定身份键）解析姓名，回落 owner 列历史姓名
  if (row.owner_user_id) {
    const u = db && db.prepare('SELECT name FROM users WHERE id = ?').get(Number(row.owner_user_id));
    ownerName = u ? String(u.name) : '';
  }
  if (!ownerName && row.owner) ownerName = String(row.owner);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    code: String(row.code),
    description: String(row.description),
    category: String(row.category),
    probability: Number(row.probability),
    impact: Number(row.impact),
    riskValue: Number(row.risk_value),
    strategy: String(row.strategy),
    owner: String(row.owner),
    ownerName: ownerName,
    status: String(row.status),
    reviewDate: row.review_date || null,
  };
}

/**
 * 读项目全部风险（按 code / id 升序，确定序）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {Array<object>} Risk[]
 * @throws {AppError} E_NOT_FOUND 项目不存在
 */
function listRisks(db, projectId) {
  const project = loadProjectRow(db, projectId);
  if (!project) {
    throw new AppError(ErrorCode.E_NOT_FOUND, '项目不存在', { projectId: String(projectId || '') });
  }
  return db
    .prepare('SELECT * FROM risks WHERE project_id = ? ORDER BY code ASC, id ASC')
    .all(String(projectId))
    .map(function (r) { return toApiRisk(r, db); });
}

/**
 * 读单条风险行，不存在直接 404。
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {object} risks 行
 * @throws {AppError} E_NOT_FOUND
 */
function requireRiskRow(db, id) {
  const row = db.prepare('SELECT * FROM risks WHERE id = ?').get(String(id || ''));
  if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, '风险记录不存在', { riskId: String(id || '') });
  return row;
}

/**
 * 统计项目高风险数（risk_value >= 12）。
 * 供 `project.service.toListItem` 的 `highRiskCount` 字段复用，消除 mock / 真后端口径漂移。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {number}
 */
function countHighRisks(db, projectId) {
  if (!db) return 0; // 安全网：调用方未传 db 时不抛错，避免整页 500
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM risks WHERE project_id = ? AND risk_value >= ?')
    .get(String(projectId), RISK_HIGH_THRESHOLD);
  return (row && row.c) || 0;
}

/**
 * 批量统计多项目高风险数（消除逐项目 N+1）。
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string>} projectIds
 * @returns {Map<string, number>} projectId -> 高风险数（缺失项目记为 0）
 */
function countHighRisksBatch(db, projectIds) {
  const map = new Map();
  if (!db) return map;
  const ids = (projectIds || []).map(function (x) { return String(x); }).filter(Boolean);
  ids.forEach(function (id) { map.set(id, 0); });
  if (!ids.length) return map;
  const rows = db
    .prepare(
      'SELECT project_id AS pid, COUNT(*) AS c FROM risks WHERE project_id IN (' +
        ids.map(function () { return '?'; }).join(',') +
        ') AND risk_value >= ? GROUP BY project_id'
    )
    .all(...ids, RISK_HIGH_THRESHOLD);
  rows.forEach(function (r) { map.set(String(r.pid), r.c); });
  return map;
}

/* ═══════════════════════════════════════════════════
 * 二、code 自增
 * ═══════════════════════════════════════════════════ */

/**
 * 生成下一个风险 code：`'RISK-' + (maxSeq + 1)`（命中 `RISK-` 前缀的序号）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {string}
 */
function nextRiskCode(db, projectId) {
  const rows = db
    .prepare("SELECT code FROM risks WHERE project_id = ? AND code LIKE 'RISK-%'")
    .all(String(projectId));
  let maxSeq = 0;
  rows.forEach(function (r) {
    const n = parseInt(String(r.code || '').replace(/^RISK-/, ''), 10);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
  });
  return 'RISK-' + (maxSeq + 1);
}

/**
 * 概率 / 影响取值夹紧到 1~5。
 * @param {*} v
 * @returns {number}
 */
function normalizeLevel(v) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = 1;
  if (n < RISK_LEVEL_MIN) n = RISK_LEVEL_MIN;
  if (n > RISK_LEVEL_MAX) n = RISK_LEVEL_MAX;
  return n;
}

/* ═══════════════════════════════════════════════════
 * 三、写操作
 * ═══════════════════════════════════════════════════ */

/**
 * 新建风险。
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req 已过 requireAuth
 * @param {string} projectId
 * @param {{description: string, category?: string, probability?: number, impact?: number, strategy?: string, owner?: string, status?: string, reviewDate?: string}} payload
 * @returns {object} Risk
 * @throws {AppError} E_PROJECT_ARCHIVED / E_FORBIDDEN / E_VALIDATION
 */
function createRisk(db, req, projectId, payload) {
  const p = payload || {};
  const tx = db.transaction(function () {
    /* RBAC 恒定次序：assertWritable → assertCan → 业务校验 */
    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'project:edit', projectId);

    const description = String(p.description === undefined || p.description === null ? '' : p.description).trim();
    if (!description) {
      throw new AppError(ErrorCode.E_VALIDATION, '风险描述不能为空', { fields: { description: '必填' } });
    }

    const category = String(p.category === undefined || p.category === null ? '' : p.category).trim();
    const probability = normalizeLevel(p.probability);
    const impact = normalizeLevel(p.impact);
    const riskValue = probability * impact;
    const strategy = String(p.strategy === undefined || p.strategy === null ? '' : p.strategy);
    const owner = String(p.owner === undefined || p.owner === null ? '' : p.owner).trim();
    const status = String(p.status === undefined || p.status === null ? '' : p.status).trim() || '待评估';
    const reviewDate = p.reviewDate ? String(p.reviewDate) : null;

    const code = nextRiskCode(db, projectId);
    const id = ids.genId('RK');
    const ts = dates.nowIso();
    const createdBy = me.open_id !== undefined ? me.open_id : me.openId;
    // 设计修正：边界把 open_id / 姓名解析为系统稳定身份键 users.id 落库
    const createdByUserId = mappers.resolveUserId(db, createdBy);
    const ownerUserId = mappers.resolveUserIdByName(db, owner);

    db.prepare(
      'INSERT INTO risks (' +
        'id, project_id, code, description, category, probability, impact, risk_value, ' +
        'strategy, owner, status, review_date, created_by, created_by_user_id, owner_user_id, created_at, updated_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id, String(projectId), code, description, category, probability, impact, riskValue,
      strategy, owner, status, reviewDate, createdBy, createdByUserId, ownerUserId, ts, ts
    );

    writeAudit(db, me, 'risk', id, 'create', projectId, '新增风险「' + code + ' ' + description + '」（风险值 ' + riskValue + '）');

    return toApiRisk(db.prepare('SELECT * FROM risks WHERE id = ?').get(id), db);
  });
  return tx();
}

/**
 * 修改风险（全字段可选 patch；probability / impact 任一变化都重算 risk_value）。
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} id 风险 id
 * @param {object} payload 可选字段
 * @returns {object} Risk
 * @throws {AppError} E_NOT_FOUND / E_PROJECT_ARCHIVED / E_FORBIDDEN / E_VALIDATION
 */
function updateRisk(db, req, id, payload) {
  const p = payload || {};
  const tx = db.transaction(function () {
    const row = requireRiskRow(db, id);
    const projectId = String(row.project_id);

    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'project:edit', projectId);

    const before = toApiRisk(row);
    const sets = [];
    const args = [];
    const diff = [];

    if (p.description !== undefined) {
      const v = String(p.description).trim();
      if (!v) throw new AppError(ErrorCode.E_VALIDATION, '风险描述不能为空', { fields: { description: '必填' } });
      if (v !== before.description) {
        sets.push('description = ?'); args.push(v);
        const d = diffEntry('description', '风险描述', before.description, v);
        if (d) diff.push(d);
      }
    }
    if (p.category !== undefined) {
      const v = String(p.category).trim();
      if (v !== before.category) {
        sets.push('category = ?'); args.push(v);
        const d = diffEntry('category', '类别', before.category, v);
        if (d) diff.push(d);
      }
    }
    if (p.probability !== undefined || p.impact !== undefined) {
      const probability = normalizeLevel(p.probability !== undefined ? p.probability : before.probability);
      const impact = normalizeLevel(p.impact !== undefined ? p.impact : before.impact);
      const riskValue = probability * impact;
      sets.push('probability = ?', 'impact = ?', 'risk_value = ?');
      args.push(probability, impact, riskValue);
      if (probability !== before.probability) diff.push(diffEntry('probability', '概率', before.probability, probability));
      if (impact !== before.impact) diff.push(diffEntry('impact', '影响', before.impact, impact));
      if (riskValue !== before.riskValue) diff.push(diffEntry('riskValue', '风险值', before.riskValue, riskValue));
    }
    if (p.strategy !== undefined) {
      const v = String(p.strategy);
      if (v !== before.strategy) {
        sets.push('strategy = ?'); args.push(v);
        const d = diffEntry('strategy', '应对策略', before.strategy, v);
        if (d) diff.push(d);
      }
    }
    if (p.owner !== undefined) {
      const v = String(p.owner).trim();
      if (v !== before.owner) {
        sets.push('owner = ?', 'owner_user_id = ?'); args.push(v, mappers.resolveUserIdByName(db, v));
        const d = diffEntry('owner', '责任人', before.owner, v);
        if (d) diff.push(d);
      }
    }
    if (p.status !== undefined) {
      const v = String(p.status).trim() || '待评估';
      if (v !== before.status) {
        sets.push('status = ?'); args.push(v);
        const d = diffEntry('status', '状态', before.status, v);
        if (d) diff.push(d);
      }
    }
    if (p.reviewDate !== undefined) {
      const v = p.reviewDate ? String(p.reviewDate) : null;
      if (v !== before.reviewDate) {
        sets.push('review_date = ?'); args.push(v);
        const d = diffEntry('reviewDate', '复评日期', before.reviewDate, v);
        if (d) diff.push(d);
      }
    }

    if (sets.length) {
      sets.push('updated_at = ?');
      args.push(dates.nowIso());
      db.prepare('UPDATE risks SET ' + sets.join(', ') + ' WHERE id = ?').run(...args, id);
      writeAudit(db, me, 'risk', id, 'update', projectId, '更新风险「' + before.code + '」', diff);
    }

    return toApiRisk(db.prepare('SELECT * FROM risks WHERE id = ?').get(id), db);
  });
  return tx();
}

/**
 * 删除风险。
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} id 风险 id
 * @returns {{id: string}}
 * @throws {AppError} E_NOT_FOUND / E_PROJECT_ARCHIVED / E_FORBIDDEN
 */
function deleteRisk(db, req, id) {
  const tx = db.transaction(function () {
    const row = requireRiskRow(db, id);
    const projectId = String(row.project_id);

    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'project:edit', projectId);

    const code = String(row.code);
    const desc = String(row.description);

    db.prepare('DELETE FROM risks WHERE id = ?').run(String(id));

    writeAudit(db, me, 'risk', id, 'delete', projectId, '删除风险「' + code + ' ' + desc + '」');

    return { id: String(id) };
  });
  return tx();
}

module.exports = {
  RISK_HIGH_THRESHOLD,
  listRisks,
  requireRiskRow,
  countHighRisks,
  countHighRisksBatch,
  createRisk,
  updateRisk,
  deleteRisk,
};
