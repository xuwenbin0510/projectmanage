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

/* ── 变更摘要（审批通知富文本） ───────────────────── */

/**
 * 取字符串首行（跳过空行、去首尾空白）；把长文本压缩成单行摘要用。
 * @param {*} v
 * @returns {string}
 */
function firstLineOf(v) {
  const s = mappers.toStr(v);
  if (!s) return '';
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t) return t;
  }
  return '';
}

/**
 * 截断字符串到指定长度（超出追加省略号）。
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function truncate(s, n) {
  const str = mappers.toStr(s).trim();
  if (str.length <= n) return str;
  return str.slice(0, n) + '…';
}

/**
 * 计算两个「YYYY-MM-DD」日期的天数差（原生 Date，不引第三方依赖）。
 * 返回 `to - from`：正数=延后，负数=提前，0=同日；无法解析时回落 0。
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
function dayDiff(from, to) {
  const a = new Date(String(from).slice(0, 10) + 'T00:00:00');
  const b = new Date(String(to).slice(0, 10) + 'T00:00:00');
  const ta = a.getTime();
  const tb = b.getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

/**
 * 生成变更单「一句话中文摘要」（≤ 120 字），供审批通知正文与变更详情面板复用。
 *
 * 兼容两种入参形态：
 *  - 已映射的 API 对象（camelCase，payload 已解析为对象）；
 *  - changes 表原始行（snake_case，payload 为 JSON 字符串）。
 *
 * 规则：
 *  - milestone_date + milestone → `里程碑「名称」计划日期 from → to（延后/提前 N 天）`；
 *  - 其他类型回落 content 首行（截断 60 字）→ impact_analysis 首行；
 *  - effortDays > 0 追加 ` · 预计 N 人日`；
 *  - 最终整体截断 120 字，无可用信息返回 ''。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} change 变更单 API 对象或 changes 行
 * @returns {string}
 */
function summarizeChange(db, change) {
  const c = change && typeof change === 'object' ? change : {};
  const read = function (camel, snake) {
    const v = c[camel] !== undefined ? c[camel] : c[snake];
    return mappers.toStr(v);
  };

  const changeType = read('changeType', 'change_type');
  const targetType = read('targetType', 'target_type');
  const targetId = read('targetId', 'target_id');
  const effortDays = mappers.toNum(c.effortDays !== undefined ? c.effortDays : c.effort_days, 0);

  /* payload：API 对象已解析为对象；原始行为 JSON 字符串 —— 与 applyChange 同源安全解析 */
  let payload = {};
  const rawPayload = c.payload;
  if (rawPayload && typeof rawPayload === 'object') {
    payload = rawPayload;
  } else if (typeof rawPayload === 'string' && rawPayload) {
    try {
      payload = JSON.parse(rawPayload) || {};
    } catch (e) {
      payload = {};
    }
  }

  let summary = '';

  if (changeType === 'milestone_date' && targetType === 'milestone') {
    let msName = targetId;
    if (targetId) {
      const ms = db.prepare('SELECT name FROM milestones WHERE id = ?').get(String(targetId));
      if (ms && ms.name) msName = mappers.toStr(ms.name);
    }
    const fromDate = mappers.toStr(payload.fromDate).slice(0, 10);
    const toDate = mappers.toStr(payload.toDate).slice(0, 10);
    let datePart = '';
    if (fromDate && toDate) {
      const delta = dayDiff(fromDate, toDate);
      let suffix = '（日期不变）';
      if (delta > 0) suffix = '（延后 ' + delta + ' 天）';
      else if (delta < 0) suffix = '（提前 ' + Math.abs(delta) + ' 天）';
      datePart = fromDate + ' → ' + toDate + suffix;
    } else if (fromDate) {
      datePart = fromDate;
    } else if (toDate) {
      datePart = toDate;
    }
    summary = '里程碑「' + msName + '」计划日期' + (datePart ? ' ' + datePart : '');
  } else {
    const first = firstLineOf(read('content', 'content')) || firstLineOf(read('impactAnalysis', 'impact_analysis'));
    summary = truncate(first, 60);
  }

  if (effortDays > 0) {
    const effortNote = '预计 ' + effortDays + ' 人日';
    summary = summary ? summary + ' · ' + effortNote : effortNote;
  }

  return truncate(summary, 120);
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

  /* milestone_date：目标日期不得晚于项目计划截止（与 updateMilestone 同源约束，applyChange 另有防御复查） */
  if (changeType === 'milestone_date') {
    const cp = p.payload || {};
    const toDate = mappers.toStr(cp.toDate);
    const projRow = db.prepare('SELECT plan_end FROM projects WHERE id = ?').get(String(projectId));
    const planEnd = mappers.toStr(projRow && projRow.plan_end).slice(0, 10);
    if (toDate && planEnd && toDate > planEnd) {
      throw new AppError(ErrorCode.E_VALIDATION,
        '里程碑目标日期 ' + toDate + ' 不能晚于项目计划截止 ' + planEnd + '，请先在「编辑项目信息」中调整计划周期',
        { toDate: toDate, planEnd: planEnd });
    }
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

  /* 摘要富化：把「变更了什么」带进通知正文（无可用信息时回落旧文案） */
  const createdSummary = summarizeChange(db, created);

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
    body: createdSummary
      ? '「' + code + ' ' + title + '」已创建，待提交审批：' + createdSummary
      : '「' + code + ' ' + title + '」已创建，待提交审批',
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
  let summary = '';
  const tx = db.transaction(function () {
    const row = getChangeRow(db, id);
    const projectId = mappers.toStr(row.project_id);
    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'change:submit', projectId);
    if (mappers.toStr(row.status) !== '草稿') throw new AppError(ErrorCode.E_VALIDATION, '仅草稿状态可提交');

    const reviewType = mappers.toStr(row.route) === 'ccb' ? 'ccb' : 'pm_only';
    const tpl = enums.REVIEW_TEMPLATES[reviewType];
    const title = mappers.toStr(row.code) + ' ' + mappers.toStr(row.title) + ' · ' + tpl.label;

    /* 摘要富化：同一份摘要同时喂给评审通知正文与变更通知正文 */
    summary = summarizeChange(db, row);

    /* 复用评审引擎创建审批（ref_type='change'）；detail 为新增可选字段，旧调用方不受影响 */
    reviewService.createReview(db, {
      projectId: projectId,
      refType: 'change',
      refId: String(row.id),
      reviewType: reviewType,
      title: title,
      detail: summary,
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
    body: summary
      ? '「' + mappers.toStr(result.code) + ' ' + mappers.toStr(result.title) + '」待审批：' + summary
      : '「' + mappers.toStr(result.code) + ' ' + mappers.toStr(result.title) + '」已提交，待审批',
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
        /* 防御复查：批准到实施之间项目计划周期可能已被收缩 */
        const projRow = db.prepare('SELECT plan_end FROM projects WHERE id = ?').get(projectId);
        const planEnd = mappers.toStr(projRow && projRow.plan_end);
        if (planEnd && toDate > planEnd) {
          throw new AppError(ErrorCode.E_VALIDATION,
            '里程碑目标日期 ' + toDate + ' 已超出项目当前计划截止 ' + planEnd + '（实施期间项目周期被调整），请重新发起变更',
            { toDate: toDate, planEnd: planEnd });
        }
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
  summarizeChange,
};
