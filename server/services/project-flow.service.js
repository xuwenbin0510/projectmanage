/**
 * 项目状态机流转服务（B10 · R2）
 *
 * 契约源：`web/src/api/mock/index.ts`（transition L887-917 / checkClose L919-932）+
 * `web/src/api/mock/rules.ts#closeBlockers`（L218-250），文案逐字对齐。
 *
 * 关键决策（docs/B10-任务分解.md §0）：
 *  - D5：独立服务文件，`project.service.js` 保持建项/读链不动（最小 diff）；
 *        project-flow 与 review.service **互不依赖**（close-check / Q3 特判直查 reviews 表）。
 *  - D6：完整状态机 = `enums.PROJECT_TRANSITIONS`（不做增减）。特例：
 *        `审批中→已批准/已驳回` 且项目存在 `status='审批中'` 的 `project` 类型评审 →
 *        `E_VALIDATION`「存在审批中的立项评审，请走评审流程」；无该评审（legacy 老数据）
 *        → 允许拥有 `project:transition` 者直转兜底。
 *  - D7：结项阻塞项 = 未过门（quality_gates.status NOT IN (已通过,有条件通过)）/
 *        未达成碑（milestones.done_at IS NULL）/ 审批中评审（reviews.status='审批中'）/
 *        变更（changes 表本期恒空）；与 close-check **同一函数** closeBlockers。
 *
 * 调用顺序（共享约定 §4）：`loadProject` 404 → `assertWritable`（归档 E_PROJECT_ARCHIVED）
 * → `assertCan('project:transition')` → 业务校验（状态机边 → Q3 特判 → 结项检查）。
 */

const dates = require('../lib/dates');
const mappers = require('../lib/mappers');
const { AppError, ErrorCode } = require('../lib/errors');
const { writeAudit, diffEntry } = require('../lib/audit');
const enums = require('../config/enums');
const rbac = require('../middleware/rbac');

/**
 * 结项前置检查（唯一口径，transition→已结项 与 GET /close-check 共用）。
 *
 * 阻塞项顺序与 Mock rules.ts L218-250 一致：gate → milestone → change → review。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {Array<{kind: string, message: string}>} CloseBlocker[]
 */
function closeBlockers(db, projectId) {
  const blockers = [];
  const pid = String(projectId || '');

  /* 未过门：status 不在两个通过态 */
  db.prepare(
    "SELECT * FROM quality_gates WHERE project_id = ? AND status NOT IN ('已通过', '有条件通过') ORDER BY created_at ASC, id ASC"
  )
    .all(pid)
    .forEach(function (g) {
      blockers.push({
        kind: 'gate',
        message: '质量门「' + mappers.toStr(g.code) + ' ' + mappers.toStr(g.name) + '」尚未通过（当前：' + mappers.toStr(g.status) + '）',
      });
    });

  /* 未达成碑：done 由 done_at 派生，故 done_at IS NULL 即未达成 */
  db.prepare(
    'SELECT * FROM milestones WHERE project_id = ? AND done_at IS NULL ORDER BY planned_date ASC, id ASC'
  )
    .all(pid)
    .forEach(function (m) {
      blockers.push({
        kind: 'milestone',
        message: '里程碑「' + mappers.toStr(m.code) + ' ' + mappers.toStr(m.name) + '」尚未达成',
      });
    });

  /* 未关闭变更（本期 changes 表恒空，防御性实现） */
  db.prepare(
    "SELECT * FROM changes WHERE project_id = ? AND status IN ('审批中', '草稿') ORDER BY created_at ASC, id ASC"
  )
    .all(pid)
    .forEach(function (c) {
      blockers.push({
        kind: 'change',
        message: '变更单「' + mappers.toStr(c.code) + ' ' + mappers.toStr(c.title) + '」尚未关闭（当前：' + mappers.toStr(c.status) + '）',
      });
    });

  /* 审批中评审 */
  db.prepare(
    "SELECT * FROM reviews WHERE project_id = ? AND status = '审批中' ORDER BY created_at ASC, id ASC"
  )
    .all(pid)
    .forEach(function (r) {
      blockers.push({
        kind: 'review',
        message: '评审「' + mappers.toStr(r.title) + '」仍在审批中',
      });
    });

  return blockers;
}

/**
 * 结项前置检查接口（GET /projects/:projectId/close-check 直出 CloseBlocker[]）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {Array<{kind: string, message: string}>}
 */
function checkClose(db, projectId) {
  return closeBlockers(db, projectId);
}

/**
 * 项目状态机流转（POST /projects/:id/transition）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req 已过 requireAuth，req.user 是 users 行
 * @param {string} id 项目 id
 * @param {string} to 目标状态
 * @param {string} [comment] 流转说明（审计 summary 用）
 * @returns {object} Project（API 形态）
 * @throws {AppError} E_NOT_FOUND / E_PROJECT_ARCHIVED / E_FORBIDDEN / E_VALIDATION / E_CLOSE_BLOCKED
 */
function transitionProject(db, req, id, to, comment) {
  const p = rbac.loadProject(db, id);               // 404
  rbac.assertWritable(db, id);                      // 归档态 E_PROJECT_ARCHIVED 先拦
  rbac.assertCan(db, req, 'project:transition', id); // 权限

  const target = mappers.toStr(to || '');
  const allowed = enums.PROJECT_TRANSITIONS[p.status] || [];
  if (allowed.indexOf(target) < 0) {
    throw new AppError(ErrorCode.E_VALIDATION, '不允许从「' + p.status + '」流转到「' + target + '」');
  }

  /* Q3 特判（D6）：审批中 → 已批准/已驳回 且存在审批中的立项评审 → 拒绝直转 */
  if ((target === '已批准' || target === '已驳回') && p.status === '审批中') {
    const pending = db
      .prepare("SELECT COUNT(*) AS c FROM reviews WHERE project_id = ? AND review_type = 'project' AND status = '审批中'")
      .get(id);
    if (pending && Number(pending.c) > 0) {
      throw new AppError(ErrorCode.E_VALIDATION, '存在审批中的立项评审，请走评审流程');
    }
  }

  let actualEnd = p.actual_end;
  if (target === '已结项') {
    const blockers = closeBlockers(db, id);
    if (blockers.length) {
      throw new AppError(ErrorCode.E_CLOSE_BLOCKED, '结项被阻塞，请先处理阻塞项', { blockers: blockers });
    }
    actualEnd = dates.today();
  }

  const before = p.status;
  const ts = dates.nowIso();
  db.prepare('UPDATE projects SET status = ?, actual_end = ?, updated_at = ? WHERE id = ?').run(
    target, actualEnd, ts, id,
  );

  writeAudit(
    db,
    req.user,
    'project',
    id,
    'status_change',
    id,
    comment || '项目状态由「' + before + '」变更为「' + target + '」',
    [diffEntry('status', '项目状态', before, target)],
  );

  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return mappers.toApiProject(row);
}

module.exports = {
  transitionProject,
  closeBlockers,
  checkClose,
};
