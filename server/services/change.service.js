/**
 * 变更单服务（D08 · 打通变更流程）
 *
 * 对齐 `web/src/api/mock/index.ts` 变更段 + `web/src/types/change.ts` 契约：
 *  - 类型：milestone_date（里程碑改期）/ requirement_baseline / scope / other
 *  - 路由判定（对齐 mock/rules.ts routeOfChange）：milestone_date / requirement_baseline /
 *    工作量 ≥ CCB_EFFORT_THRESHOLD(3) 人日 → ccb；否则 pm_only
 *  - 状态机：草稿 → 审批中（ccb → REVIEW_TEMPLATES.ccb 串行链；pm_only → PM 单人 single）
 *            → 已批准（onReviewApproved）→ 已实施（applyChange）；驳回 → 已驳回
 *  - 审批复用 review 引擎：submitChange 调 reviewService.createReview（ref_type='change'）
 *  - applyChange：milestone_date → 里程碑 planned_date 应用 + 审计 + 状态刷新
 *
 * 约定（沿用铁律）：service 零 Express 依赖；事务在 service；响应体禁 snake_case；审计事务外。
 */

const { genId } = require('../lib/ids');
const dates = require('../lib/dates');
const mappers = require('../lib/mappers');
const { AppError, ErrorCode } = require('../lib/errors');
const { writeAudit } = require('../lib/audit');
const rbac = require('../middleware/rbac');
const enums = require('../config/enums');
const reviewService = require('./review.service');
const milestoneService = require('./milestone.service');
const notificationService = require('./notification.service');

/* ── 行 → API 对象 ────────────────────────────────── */

/**
 * changes 行 → Change（API 形态，含 code/reviewId/appliedAt/payload 解析）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} row
 * @returns {object}
 */
function toApiChange(db, row) {
  let payload = {};
  try {
    payload = row.payload ? JSON.parse(row.payload) : {};
  } catch (e) {
    payload = {};
  }
  let createdByName = '';
  if (row.created_by_user_id) {
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(Number(row.created_by_user_id));
    createdByName = u ? mappers.toStr(u.name) : '';
  }
  if (!createdByName && row.created_by) {
    const u = db.prepare('SELECT name FROM users WHERE open_id = ?').get(String(row.created_by));
    createdByName = u ? mappers.toStr(u.name) : '';
  }
  return {
    id: mappers.toStr(row.id),
    projectId: mappers.toStr(row.project_id),
    code: mappers.toStr(row.code),
    changeType: mappers.toStr(row.change_type),
    title: mappers.toStr(row.title),
    content: mappers.toStr(row.content),
    impactAnalysis: mappers.toStr(row.impact_analysis),
    effortDays: mappers.toNum(row.effort_days, 0),
    targetType: mappers.toStr(row.target_type),
    targetId: mappers.toStr(row.target_id),
    payload: payload,
    route: mappers.toStr(row.route, 'pm_only'),
    status: mappers.toStr(row.status, '草稿'),
    reviewId: mappers.toNull(row.review_id),
    createdBy: mappers.toStr(row.created_by),
    createdByName: createdByName,
    createdAt: mappers.toStr(row.created_at),
    appliedAt: mappers.toNull(row.applied_at),
  };
}

function getChangeRow(db, id) {
  const row = db.prepare('SELECT * FROM changes WHERE id = ?').get(String(id || ''));
  if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, '变更单不存在', { id: String(id || '') });
  return row;
}

/* ── 路由判定 ─────────────────────────────────────── */

/**
 * 路由判定（对齐 mock rules.ts routeOfChange）：基线/工作量超阈值 → ccb，否则 pm_only。
 * @param {{changeType?: string, effortDays?: number, targetType?: string}} input
 * @returns {{route: string, chain: string[], reasons: string[]}}
 */
function routeChange(db, input) { // eslint-disable-line no-unused-vars
  const p = input || {};
  const reasons = [];
  let route = 'pm_only';
  const changeType = mappers.toStr(p.changeType);

  if (changeType === 'milestone_date') {
    route = 'ccb';
    reasons.push('变更类型为「里程碑日期」→ 必须走 CCB');
  }
  if (changeType === 'requirement_baseline') {
    route = 'ccb';
    reasons.push('变更类型为「需求基线」→ 必须走 CCB');
  }
  const effort = Number(p.effortDays) || 0;
  if (effort >= enums.CCB_EFFORT_THRESHOLD) {
    route = 'ccb';
    reasons.push('预计工作量 ' + String(effort) + ' 人日 ≥ ' + String(enums.CCB_EFFORT_THRESHOLD) + ' 人日阈值 → 走 CCB');
  }
  if (route === 'pm_only') {
    reasons.push('未涉及基线且工作量 < ' + String(enums.CCB_EFFORT_THRESHOLD) + ' 人日 → 由 PM 直接审批');
  }

  const chain = route === 'ccb' ? enums.REVIEW_TEMPLATES.ccb.chain : ['pm'];
  return { route: route, chain: chain, reasons: reasons };
}

/* ── 查询 ─────────────────────────────────────────── */

/**
 * 项目变更单列表（新→旧）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {Array<object>} Change[]
 */
function listChanges(db, projectId) {
  return db
    .prepare('SELECT * FROM changes WHERE project_id = ? ORDER BY created_at DESC, id DESC')
    .all(String(projectId))
    .map(function (r) { return toApiChange(db, r); });
}

/**
 * 变更单详情。
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {object} Change
 * @throws {AppError} E_NOT_FOUND
 */
function getChange(db, id) {
  return toApiChange(db, getChangeRow(db, id));
}

/* ── 创建 / 提交 / 实施 ───────────────────────────── */

/**
 * 创建变更单（草稿态，路由已判定）。
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} projectId
 * @param {object} payload ChangePayloadInput
 * @returns {object} Change
 */
function createChange(db, req, projectId, payload) {
  const p = payload || {};
  const title = mappers.toStr(p.title).trim();
  if (!title) throw new AppError(ErrorCode.E_VALIDATION, '请填写变更标题');
  const changeType = mappers.toStr(p.changeType);
  if (enums.CHANGE_TYPES.indexOf(changeType) < 0) {
    throw new AppError(ErrorCode.E_VALIDATION, '变更类型非法，允许值：' + enums.CHANGE_TYPES.join(' / '));
  }

  const id = genId('CHG');
  const code = 'CHG-' + String(id).replace(/^CHG-/, '').slice(-6).toUpperCase();
  const openId = mappers.toStr(req.user && (req.user.open_id !== undefined ? req.user.open_id : req.user.openId));

  const tx = db.transaction(function () {
    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'change:create', projectId);

    const routing = routeChange(db, {
      changeType: changeType,
      effortDays: Number(p.effortDays) || 0,
      targetType: mappers.toStr(p.targetType),
    });

    const ts = dates.nowIso();
    const payloadJson = JSON.stringify(p.payload || {});
    const createdByUserId = mappers.resolveUserId(db, openId);

    db.prepare(
      `INSERT INTO changes (
        id, project_id, change_type, title, content, impact_analysis, effort_days,
        target_type, target_id, status, route, created_by, created_by_user_id, created_at, updated_at,
        code, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '草稿', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, String(projectId), changeType, title, mappers.toStr(p.content),
      mappers.toStr(p.impactAnalysis), Number(p.effortDays) || 0,
      mappers.toStr(p.targetType), mappers.toStr(p.targetId),
      routing.route, openId, createdByUserId, ts, ts, code, payloadJson,
    );

    writeAudit(db, me, 'change', id, 'create', String(projectId), '创建变更单 ' + code + '「' + title + '」（路由：' + routing.route + '）');
    return toApiChange(db, getChangeRow(db, id));
  });
  const created = tx();

  /* 通知：项目 PM + 全局 admin/pmo（剔除创建人自身） */
  notificationService.notify(db, {
    recipients: notificationService.resolveRecipients(db, {
      projectId: String(projectId),
      projectRoles: ['pm'],
      globalRoles: ['admin', 'pmo'],
      excludeOpenId: openId,
    }),
    type: notificationService.NOTIFICATION_TYPES.CHANGE_CREATED,
    title: '新的变更单：' + code + ' ' + title,
    body: '「' + code + ' ' + title + '」已创建，待提交审批',
    projectId: String(projectId),
    refType: 'change',
    refId: id,
  });

  return created;
}

/**
 * 提交变更单审批：ccb → CCB 串行评审；pm_only → PM 单人评审。
 * 复用 review 引擎（ref_type='change'，ref_id=变更单 id）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} id
 * @returns {object} Change
 * @throws {AppError} E_VALIDATION / E_FORBIDDEN
 */
function submitChange(db, req, id) {
  const openId = mappers.toStr(req.user && (req.user.open_id !== undefined ? req.user.open_id : req.user.openId));
  const tx = db.transaction(function () {
    const row = getChangeRow(db, id);
    const projectId = mappers.toStr(row.project_id);
    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'change:submit', projectId);
    if (mappers.toStr(row.status) !== '草稿') throw new AppError(ErrorCode.E_VALIDATION, '仅草稿状态可提交');

    const reviewType = mappers.toStr(row.route) === 'ccb' ? 'ccb' : 'pm_only';
    const tpl = enums.REVIEW_TEMPLATES[reviewType];
    const title = mappers.toStr(row.code) + ' ' + mappers.toStr(row.title) + ' · ' + tpl.label;

    /* 复用评审引擎创建审批（ref_type='change'） */
    reviewService.createReview(db, {
      projectId: projectId,
      refType: 'change',
      refId: String(row.id),
      reviewType: reviewType,
      title: title,
    }, me);

    const rid = db
      .prepare("SELECT id FROM reviews WHERE ref_type = 'change' AND ref_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(String(row.id)).id;
    db.prepare("UPDATE changes SET status = '审批中', review_id = ?, updated_at = ? WHERE id = ?")
      .run(rid, dates.nowIso(), String(row.id));

    writeAudit(db, me, 'change', String(row.id), 'update', projectId, '变更单 ' + mappers.toStr(row.code) + ' 提交' + tpl.label);
    return toApiChange(db, getChangeRow(db, id));
  });
  const result = tx();

  /* 通知：项目 PM + 全局 admin/pmo（剔除提交人自身） */
  notificationService.notify(db, {
    recipients: notificationService.resolveRecipients(db, {
      projectId: mappers.toStr(result.projectId),
      projectRoles: ['pm'],
      globalRoles: ['admin', 'pmo'],
      excludeOpenId: openId,
    }),
    type: notificationService.NOTIFICATION_TYPES.CHANGE_SUBMITTED,
    title: '变更单待审批：' + mappers.toStr(result.code) + ' ' + mappers.toStr(result.title),
    body: '「' + mappers.toStr(result.code) + ' ' + mappers.toStr(result.title) + '」已提交，待审批',
    projectId: mappers.toStr(result.projectId),
    refType: 'change',
    refId: id,
  });

  return result;
}

/**
 * 实施变更单（已批准 → 已实施）。
 *  - milestone_date：里程碑 planned_date 应用 + 审计 + 全项目状态刷新；
 *  - 其他类型：仅标记实施（人工确认，不自动改数据）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} id
 * @returns {object} Change
 * @throws {AppError} E_VALIDATION / E_FORBIDDEN
 */
function applyChange(db, req, id) {
  const openId = mappers.toStr(req.user && (req.user.open_id !== undefined ? req.user.open_id : req.user.openId));
  const tx = db.transaction(function () {
    const row = getChangeRow(db, id);
    const projectId = mappers.toStr(row.project_id);
    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'change:submit', projectId);
    if (mappers.toStr(row.status) !== '已批准') throw new AppError(ErrorCode.E_VALIDATION, '仅已批准的变更单可实施');

    let payload = {};
    try {
      payload = row.payload ? JSON.parse(row.payload) : {};
    } catch (e) {
      payload = {};
    }

    if (mappers.toStr(row.change_type) === 'milestone_date' && mappers.toStr(row.target_type) === 'milestone') {
      const ms = db.prepare('SELECT * FROM milestones WHERE id = ?').get(String(row.target_id || ''));
      const toDate = mappers.toStr(payload.toDate);
      if (ms && toDate) {
        const before = mappers.toStr(ms.planned_date);
        db.prepare('UPDATE milestones SET planned_date = ?, last_change_id = ?, updated_at = ? WHERE id = ?')
          .run(toDate, String(row.id), dates.nowIso(), String(ms.id));
        writeAudit(db, me, 'milestone', String(ms.id), 'apply', projectId,
          '变更实施：' + mappers.toStr(ms.code) + ' 计划日期 ' + before + ' → ' + toDate + '（基线日期不变）', [
            { field: 'planned_date', label: '计划日期', before: before, after: toDate },
          ]);
        milestoneService.refreshMilestoneStatuses(db, projectId);
      }
    }

    db.prepare("UPDATE changes SET status = '已实施', applied_at = ?, updated_at = ? WHERE id = ?")
      .run(dates.nowIso(), dates.nowIso(), String(row.id));
    writeAudit(db, me, 'change', String(row.id), 'apply', projectId, '变更单 ' + mappers.toStr(row.code) + ' 已实施');
    return toApiChange(db, getChangeRow(db, id));
  });
  const result = tx();

  /* 通知变更创建人（剔除实施人自身） */
  const creatorOpenId = mappers.toStr(result.createdBy !== undefined ? result.createdBy : '');
  if (creatorOpenId && creatorOpenId !== openId) {
    notificationService.notify(db, {
      recipients: [creatorOpenId],
      type: notificationService.NOTIFICATION_TYPES.CHANGE_APPLIED,
      title: '变更单已实施：' + mappers.toStr(result.code) + ' ' + mappers.toStr(result.title),
      body: '「' + mappers.toStr(result.code) + ' ' + mappers.toStr(result.title) + '」已实施',
      projectId: mappers.toStr(result.projectId),
      refType: 'change',
      refId: id,
    });
  }

  return result;
}

module.exports = {
  routeChange,
  listChanges,
  getChange,
  createChange,
  submitChange,
  applyChange,
};
