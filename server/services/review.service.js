/**
 * 评审引擎服务（B10 · R1）
 *
 * 契约源：`web/src/api/mock/index.ts`（评审段 L1956-2148）+ `web/src/types/review.ts`，
 * 逐字段对齐；前端 ApprovalsPage / ReviewsPage 零改动切换。
 *
 * 关键决策（docs/B10-任务分解.md §0）：
 *  - D2：`reviewType==='project'` → `config.APPROVAL_TEMPLATES[project.type]`
 *        （A/C 三级 serial、B 二级），`templateKey='project:'+type`；其余类型 →
 *        `enums.REVIEW_TEMPLATES[reviewType]`，`templateKey=tpl.key`。
 *  - D3：角色绑定优先级 `assignees[idx]` 覆盖 > 项目成员 `project_role===role` >
 *        全局用户 `global_role===role`（仅全局视角角色可跨项目兜底，池取自 `roles`
 *        表 scope=global 的启用角色，按 order_no）；项目视角角色缺成员即「待指派」，
 *        绝不从全局拉人；绑不到人 `assigneeName='待指派'`、`assigneeOpenId=null`。
 *  - D4：**admin 兜底可批/驳任意当前步骤**（serial=steps[currentStep]、
 *        parallel_veto=首个 current step）——与 Mock `canDecide`（仅按 assignee 匹配）
 *        有差异，属预期，见 `canDecide` 注释。
 *  - 终态联动（onReviewApproved）：project → 项目 `审批中→已批准` + 审计；
 *        gate → **仅留痕（D08.2：评审不再联动门，门控唯一通道=门区决议，避免绕过
 *        检查项+交付物硬校验）**；change → 变更 `审批中→已批准`（milestone_date 待 apply 实施）。
 *
 * 约定（沿用既有铁律）：
 *  - service 零 Express 依赖；事务在 service；响应体禁 snake_case；审计 `writeAudit` 事务外。
 *  - 状态机校验顺序：`审批中` 否则 `E_REVIEW_CLOSED`(409) → canDecide 否则
 *    `E_NOT_APPROVER`(403) → customer_rep 缺意见且缺凭证 `E_PROXY_EVIDENCE_REQUIRED`(400)
 *    → 驳回缺意见 `E_VALIDATION`(400)。
 */

const config = require('../../config');
const { genId } = require('../lib/ids');
const dates = require('../lib/dates');
const mappers = require('../lib/mappers');
const { AppError, ErrorCode } = require('../lib/errors');
const { writeAudit, diffEntry } = require('../lib/audit');
const enums = require('../config/enums');
const milestoneService = require('./milestone.service');
const { resolveGlobalRoles } = require('../middleware/auth');
const roleCatalog = require('./roleCatalog');
const notificationService = require('./notification.service');

/* ── 行 → API 对象 ──────────────────────────────────── */

/**
 * review_steps 行 → ReviewStep（API 形态）。
 * @param {object} row
 * @returns {object}
 */
function toApiStep(row) {
  return {
    id: mappers.toStr(row.id),
    reviewId: mappers.toStr(row.review_id),
    stepIndex: mappers.toNum(row.step_index, 0),
    role: mappers.toStr(row.role),
    assigneeOpenId: mappers.toNull(row.assignee_open_id),
    assigneeName: mappers.toStr(row.assignee_name, '待指派'),
    required: mappers.toBool(row.required),
    status: mappers.toStr(row.status, 'pending'),
    decidedBy: mappers.toNull(row.decided_by),
    decidedByName: mappers.toStr(row.decided_by_name),
    decidedAt: mappers.toNull(row.decided_at),
    comment: mappers.toStr(row.comment),
  };
}

/**
 * review_approvals 行 → Approval（API 形态）。
 * @param {object} row
 * @returns {object}
 */
function toApiApproval(row) {
  return {
    id: mappers.toStr(row.id),
    reviewId: mappers.toStr(row.review_id),
    projectId: mappers.toStr(row.project_id),
    stepIndex: mappers.toNum(row.step_index, 0),
    stepRole: mappers.toStr(row.step_role),
    actorOpenId: mappers.toStr(row.actor_open_id),
    actorName: mappers.toStr(row.actor_name),
    action: mappers.toStr(row.action),
    comment: mappers.toStr(row.comment),
    evidenceUrl: mappers.toStr(row.evidence_url),
    createdAt: mappers.toStr(row.created_at),
  };
}

/**
 * reviews 行 → Review（API 形态，含 steps / approvals / projectName）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} row
 * @returns {object}
 */
function toApiReview(db, row) {
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(mappers.toStr(row.project_id));
  const steps = db
    .prepare('SELECT * FROM review_steps WHERE review_id = ? ORDER BY step_index ASC, id ASC')
    .all(mappers.toStr(row.id))
    .map(toApiStep);
  const approvals = db
    .prepare('SELECT * FROM review_approvals WHERE review_id = ? ORDER BY created_at ASC, id ASC')
    .all(mappers.toStr(row.id))
    .map(toApiApproval);

  return {
    id: mappers.toStr(row.id),
    projectId: mappers.toStr(row.project_id),
    projectName: project ? mappers.toStr(project.name) : '',
    refType: mappers.toStr(row.ref_type, 'project'),
    refId: mappers.toStr(row.ref_id),
    reviewType: mappers.toStr(row.review_type),
    title: mappers.toStr(row.title),
    templateKey: mappers.toStr(row.template_key),
    mode: mappers.toStr(row.mode, 'serial'),
    status: mappers.toStr(row.status, '审批中'),
    currentStep: mappers.toNum(row.current_step, 0),
    initiator: mappers.toStr(row.initiator_open_id),
    initiatorName: mappers.toStr(row.initiator_name),
    createdAt: mappers.toStr(row.created_at),
    updatedAt: mappers.toStr(row.updated_at),
    closedAt: mappers.toNull(row.closed_at),
    steps: steps,
    approvals: approvals,
  };
}

/**
 * 按 id 读评审行；不存在 404。
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {object} reviews 行
 * @throws {AppError} E_NOT_FOUND
 */
function getReviewRow(db, id) {
  const row = db.prepare('SELECT * FROM reviews WHERE id = ?').get(String(id || ''));
  if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, '评审不存在', { reviewId: String(id || '') });
  return row;
}

/* ── 读 ─────────────────────────────────────────────── */

/**
 * 评审列表（createdAt 倒序，可选 projectId 过滤）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} [projectId]
 * @returns {Array<object>} Review[]
 */
function listReviews(db, projectId) {
  const rows = projectId
    ? db
        .prepare('SELECT * FROM reviews WHERE project_id = ? ORDER BY created_at DESC, id DESC')
        .all(String(projectId))
    : db.prepare('SELECT * FROM reviews ORDER BY created_at DESC, id DESC').all();
  return rows.map(function (r) { return toApiReview(db, r); });
}

/**
 * 待我审批：我可决策的评审完整列表（createdAt 倒序，与 canDecide 同一口径）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} me users 行
 * @returns {Array<object>} Review[]
 */
function listMyApprovals(db, me) {
  const openId = mappers.toStr(me && (me.open_id !== undefined ? me.open_id : me.openId));
  if (!openId) return [];
  // E1.5：全局职位取并集传入
  const globalRoles = resolveGlobalRoles(me);
  const rows = db
    .prepare("SELECT * FROM reviews WHERE status = '审批中' ORDER BY created_at DESC, id DESC")
    .all();
  return rows
    .map(function (r) { return toApiReview(db, r); })
    .filter(function (r) { return canDecide(r, openId, globalRoles) !== null; });
}

/**
 * 评审详情。
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {object} Review
 */
function getReview(db, id) {
  return toApiReview(db, getReviewRow(db, id));
}

/* ── 审批链生成（D3） ───────────────────────────────── */

/**
 * 生成审批步骤：assignees 覆盖 > 项目成员角色 > 全局角色 > 兜底。
 *
 * ⚠ 与 Mock `buildSteps`（index.ts L416-452）逐字段一致；`parallel_veto`
 * 的「全 current」由调用方（createReview）在生成后统一置位（Mock L1994）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} reviewId
 * @param {string} projectId
 * @param {string[]} chain 有序角色链
 * @param {string[]} [assignees] 可选覆盖审批人 open_id 列表
 * @returns {Array<object>} ReviewStep[]（API 形态）
 */
/**
 * 审批模板 DB 优先读取（管理后台阶段二：审批流程可配置）。
 *
 * 查 `review_templates` 表 active=1 的记录；无记录返回 null，由调用方回落旧配置
 * （config.APPROVAL_TEMPLATES / enums.REVIEW_TEMPLATES），保证老库零行为变化。
 * @param {object} db
 * @param {string} key
 * @returns {{key:string,scope:string,label:string,mode:string,chain:string[]}|null}
 */
function getReviewTemplate(db, key) {
  try {
    const row = db
      .prepare('SELECT key, scope, label, mode, chain FROM review_templates WHERE key = ? AND active = 1')
      .get(String(key));
    if (!row) return null;
    return {
      key: row.key,
      scope: row.scope,
      label: row.label,
      mode: row.mode,
      chain: JSON.parse(row.chain || '[]'),
    };
  } catch (e) {
    return null; // 表不存在（极端情况：迁移未执行）→ 回落旧配置
  }
}

function buildSteps(db, reviewId, projectId, chain, assignees) {
  const roleList = Array.isArray(chain) ? chain : [];
  const assigneeList = Array.isArray(assignees) ? assignees : [];

  /* 项目成员：每个 project_role 取最早一条（幂等键 UNIQUE(project_id,user_open_id,project_role)） */
  const membersByRole = {};
  db.prepare('SELECT user_open_id, project_role FROM project_members WHERE project_id = ? ORDER BY assigned_at ASC, id ASC')
    .all(String(projectId))
    .forEach(function (m) {
      const role = mappers.toStr(m.project_role);
      if (role && membersByRole[role] === undefined) membersByRole[role] = mappers.toStr(m.user_open_id);
    });

  /* 全局角色：每个 global_role 取第一个用户（与 Mock find 语义一致）。
   * E1.5：除主职位 `users.global_role` 外，额外职位 `user_roles.role_key` 也参与绑定，
   * 保证「身兼多职」的用户能被审批链正确选到。 */
  const globalByRole = {};
  db.prepare('SELECT open_id, global_role FROM users ORDER BY id ASC')
    .all()
    .forEach(function (u) {
      const role = mappers.toStr(u.global_role);
      if (role && globalByRole[role] === undefined) globalByRole[role] = mappers.toStr(u.open_id);
    });
  db.prepare('SELECT user_open_id, role_key FROM user_roles ORDER BY user_open_id ASC')
    .all()
    .forEach(function (r) {
      const role = mappers.toStr(r.role_key);
      if (role && globalByRole[role] === undefined) globalByRole[role] = mappers.toStr(r.user_open_id);
    });

  const nameStmt = db.prepare('SELECT name FROM users WHERE open_id = ?');
  const userNameOf = function (openId) {
    const u = nameStmt.get(String(openId || ''));
    return u ? mappers.toStr(u.name) : '';
  };

  return roleList.map(function (role, idx) {
    let openId = mappers.toStr(assigneeList[idx] || '');
    if (!openId) openId = membersByRole[role] || '';
    /* 全局视角角色：项目成员里不会有（项目成员是 project scope），只能从全局用户兜底；
       项目视角角色：仅项目内有效，缺成员则「待指派」，绝不从全局拉人。 */
    if (!openId && roleCatalog.isGlobalRole(role)) {
      openId = globalByRole[role] || '';
      if (!openId) {
        // 全局兜底池（scope=global 的启用角色，按 order_no），从 roles 表实时取
        const fallbacks = roleCatalog.globalFallbacks();
        for (let i = 0; i < fallbacks.length; i += 1) {
          if (globalByRole[fallbacks[i]]) {
            openId = globalByRole[fallbacks[i]];
            break;
          }
        }
      }
    }

    return {
      id: reviewId + '-S' + (idx + 1),
      reviewId: reviewId,
      stepIndex: idx,
      role: role,
      assigneeOpenId: openId || null,
      assigneeName: openId ? userNameOf(openId) || '待指派' : '待指派',
      required: true,
      status: idx === 0 ? 'current' : 'pending',
      decidedBy: null,
      decidedByName: '',
      decidedAt: null,
      comment: '',
    };
  });
}

/* ── 发起评审（D2） ─────────────────────────────────── */

/**
 * 发起评审：按模板生成审批链 + 事务写 review/steps/submit 留痕 + 审计。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} payload `{projectId, refType, refId, reviewType, title, assignees?}`
 * @param {object} me users 行
 * @returns {object} Review
 * @throws {AppError} E_NOT_FOUND / E_VALIDATION
 */
function createReview(db, payload, me) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const projectId = mappers.toStr(p.projectId || '');
  const reviewType = mappers.toStr(p.reviewType || '');
  const title = mappers.toStr(p.title || '').trim();

  const project = db
    .prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL')
    .get(projectId);
  if (!project) throw new AppError(ErrorCode.E_NOT_FOUND, '项目不存在', { projectId: projectId });

  if (enums.REVIEW_TYPES.indexOf(reviewType) < 0) {
    throw new AppError(ErrorCode.E_VALIDATION, undefined, {
      fields: [{ field: 'reviewType', message: '评审类型必须为 formal / technical / code / ccb / project 之一' }],
    });
  }
  if (!title) {
    throw new AppError(ErrorCode.E_VALIDATION, undefined, {
      fields: [{ field: 'title', message: '评审标题不能为空' }],
    });
  }

  /* 模板选择（D2，阶段二：DB 优先 → 回落旧配置） */
  let chain;
  let mode;
  let templateKey;
  let tplLabel;
  if (reviewType === 'project') {
    const type = mappers.toStr(project.type, 'B');
    const dbTpl = getReviewTemplate(db, 'project:' + type) || getReviewTemplate(db, 'project:_default');
    if (dbTpl) {
      chain = dbTpl.chain;
      mode = dbTpl.mode;
      templateKey = dbTpl.key;
      tplLabel = dbTpl.label;
    } else {
      chain =
        (config.APPROVAL_TEMPLATES && config.APPROVAL_TEMPLATES[type]) ||
        config.APPROVAL_TEMPLATES._default ||
        ['pm', 'tl'];
      mode = 'serial';
      templateKey = 'project:' + type;
      tplLabel = '立项审批';
    }
  } else {
    const dbTpl = getReviewTemplate(db, reviewType);
    if (dbTpl) {
      chain = dbTpl.chain;
      mode = dbTpl.mode;
      templateKey = dbTpl.key;
      tplLabel = dbTpl.label;
    } else {
      const tpl = enums.REVIEW_TEMPLATES[reviewType];
      if (!tpl) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'reviewType', message: '评审类型必须为 formal / technical / code / ccb / project 之一' }],
        });
      }
      chain = tpl.chain;
      mode = tpl.mode;
      templateKey = tpl.key;
      tplLabel = tpl.label;
    }
  }

  const id = genId('RV');
  const ts = dates.nowIso();
  const openId = mappers.toStr(me && (me.open_id !== undefined ? me.open_id : me.openId));
  const name = mappers.toStr(me && (me.name !== undefined ? me.name : ''));

  const steps = buildSteps(db, id, projectId, chain, p.assignees);
  if (mode === 'parallel_veto') {
    steps.forEach(function (s) { s.status = 'current'; });
  }

  const insertReview = db.prepare(`
    INSERT INTO reviews (
      id, project_id, ref_type, ref_id, review_type, title, template_key, mode,
      status, current_step, initiator_open_id, initiator_name, created_at, updated_at, closed_at
    ) VALUES (
      @id, @project_id, @ref_type, @ref_id, @review_type, @title, @template_key, @mode,
      '审批中', 0, @initiator_open_id, @initiator_name, @created_at, @updated_at, NULL
    )
  `);
  const insertStep = db.prepare(`
    INSERT INTO review_steps (
      id, review_id, step_index, role, assignee_open_id, assignee_name,
      required, status, decided_by, decided_by_name, decided_at, comment
    ) VALUES (
      @id, @review_id, @step_index, @role, @assignee_open_id, @assignee_name,
      1, @status, NULL, '', NULL, ''
    )
  `);
  const insertApproval = db.prepare(`
    INSERT INTO review_approvals (
      id, review_id, project_id, step_index, step_role,
      actor_open_id, actor_name, action, comment, evidence_url, created_at
    ) VALUES (
      @id, @review_id, @project_id, @step_index, @step_role,
      @actor_open_id, @actor_name, @action, @comment, @evidence_url, @created_at
    )
  `);

  const refType = mappers.toStr(p.refType, 'project');
  const refId = mappers.toStr(p.refId || '', projectId);

  const tx = db.transaction(function () {
    insertReview.run({
      id: id,
      project_id: projectId,
      ref_type: refType,
      ref_id: refId,
      review_type: reviewType,
      title: title,
      template_key: templateKey,
      mode: mode,
      initiator_open_id: openId,
      initiator_name: name,
      created_at: ts,
      updated_at: ts,
    });
    steps.forEach(function (s) {
      insertStep.run({
        id: s.id,
        review_id: id,
        step_index: s.stepIndex,
        role: s.role,
        assignee_open_id: s.assigneeOpenId,
        assignee_name: s.assigneeName,
        status: s.status,
      });
    });
    /* 首条 submit 留痕：stepIndex=-1、stepRole=initiator（对齐 Mock L2014-2027） */
    insertApproval.run({
      id: id + '-A0',
      review_id: id,
      project_id: projectId,
      step_index: -1,
      step_role: 'initiator',
      actor_open_id: openId,
      actor_name: name,
      action: 'submit',
      comment: '发起评审',
      evidence_url: '',
      created_at: ts,
    });
  });
  tx();

  /* 通知：项目 PM + 全局 admin/pmo（剔除发起人自身），点开跳项目评审 tab */
  notificationService.notify(db, {
    recipients: notificationService.resolveRecipients(db, {
      projectId: projectId,
      projectRoles: ['pm'],
      globalRoles: ['admin', 'pmo'],
      excludeOpenId: openId,
    }),
    type: notificationService.NOTIFICATION_TYPES.REVIEW_CREATED,
    title: '新的评审待处理：' + title,
    body: '「' + (project.name || projectId) + '」发起评审「' + title + '」，请你审批',
    projectId: projectId,
    refType: 'review',
    refId: id,
  });

  writeAudit(db, me, 'review', id, 'create', projectId, '发起评审「' + title + '」（' + tplLabel + '·' + mode + '）');

  return toApiReview(db, getReviewRow(db, id));
}

/* ── 可决策判定（D4） ───────────────────────────────── */

/**
 * 判定某用户是否为评审当前可决策人。
 *
 * ⚠ 与 Mock `canDecide`（index.ts L455-463）的差异（B10 预期，见 D4）：
 *   Mock 仅按 `assigneeOpenId === me && status==='current'` 匹配；
 *   服务端**额外**提供 admin 兜底——serial/single 取 `steps[currentStep]`（status current）、
 *   parallel_veto 取首个 current step。因此 admin 的「待我审批」会包含全部审批中评审。
 *
 * @param {object} review Review（API 形态，含 steps）
 * @param {string} openId 当前用户 open_id
 * @param {string} [globalRole] 当前用户全局角色（传 'admin' 触发兜底）
 * @returns {object|null} ReviewStep 或 null
 */
function canDecide(review, openId, globalRoles) {
  if (!review || review.status !== '审批中') return null;
  const me = String(openId || '');
  // E1.5：全局职位取并集，任一为 admin 即享 admin 兜底决议权
  const roles = Array.isArray(globalRoles) ? globalRoles : [globalRoles];
  const isAdmin = roles.indexOf('admin') >= 0;
  const steps = Array.isArray(review.steps) ? review.steps : [];
  const isCurrent = function (s) { return !!s && s.status === 'current'; };

  if (review.mode === 'parallel_veto') {
    const mine = steps.find(function (s) { return isCurrent(s) && s.assigneeOpenId === me; });
    if (mine) return mine;
    if (isAdmin) return steps.find(isCurrent) || null;
    return null;
  }

  const step = steps[review.currentStep || 0];
  if (!step || step.status !== 'current') return null;
  if (step.assigneeOpenId === me) return step;
  if (isAdmin) return step;
  return null;
}

/* ── 审批决策（R1.2 / R1.4） ─────────────────────────── */

/**
 * 审批通过 / 驳回的统一引擎。
 *
 * 状态机：
 *  - reject → 整单 `已驳回` + closedAt，其余 pending/current 置 skipped + 审计 diff
 *  - parallel_veto approve → 记一票；全票通过 → `已通过` + closedAt + onReviewApproved
 *  - serial/single approve → currentStep+1、下一人 current；末步 → `已通过` + onReviewApproved
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id 评审 id
 * @param {'approve'|'reject'} action
 * @param {object} payload `{comment, evidenceUrl?}`
 * @param {object} me users 行
 * @returns {object} Review
 * @throws {AppError} E_REVIEW_CLOSED / E_NOT_APPROVER / E_PROXY_EVIDENCE_REQUIRED / E_VALIDATION
 */
function decide(db, id, action, payload, me) {
  const row = getReviewRow(db, id);
  if (row.status !== '审批中') throw new AppError(ErrorCode.E_REVIEW_CLOSED);

  const openId = mappers.toStr(me && (me.open_id !== undefined ? me.open_id : me.openId));
  // E1.5：全局职位取并集传入
  const globalRoles = resolveGlobalRoles(me);
  const actorName = mappers.toStr(me && (me.name !== undefined ? me.name : ''));

  const review = toApiReview(db, row);
  const step = canDecide(review, openId, globalRoles);
  if (!step) throw new AppError(ErrorCode.E_NOT_APPROVER);

  const body = payload && typeof payload === 'object' ? payload : {};
  const comment = mappers.toStr(body.comment || '');
  const evidenceUrl = mappers.toStr(body.evidenceUrl || '');

  if (step.role === 'customer_rep' && !comment.trim() && !evidenceUrl) {
    throw new AppError(ErrorCode.E_PROXY_EVIDENCE_REQUIRED);
  }
  if (action === 'reject' && !comment.trim()) {
    throw new AppError(ErrorCode.E_VALIDATION, '驳回必须填写意见');
  }

  const ts = dates.nowIso();
  const stepStatus = action === 'approve' ? 'approved' : 'rejected';

  const tx = db.transaction(function () {
    db.prepare(
      "UPDATE review_steps SET status = ?, decided_by = ?, decided_by_name = ?, decided_at = ?, comment = ? WHERE id = ?"
    ).run(stepStatus, openId, actorName, ts, comment, step.id);

    db.prepare(`
      INSERT INTO review_approvals (
        id, review_id, project_id, step_index, step_role,
        actor_open_id, actor_name, action, comment, evidence_url, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      genId('AP'),
      id,
      row.project_id,
      step.stepIndex,
      step.role,
      openId,
      actorName,
      action,
      comment,
      evidenceUrl,
      ts,
    );

    if (action === 'reject') {
      db.prepare(
        "UPDATE review_steps SET status = 'skipped' WHERE review_id = ? AND id <> ? AND status IN ('pending', 'current')"
      ).run(id, step.id);
      db.prepare('UPDATE reviews SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?').run(
        '已驳回', ts, ts, id,
      );
      return;
    }

    if (review.mode === 'parallel_veto') {
      const remaining = db
        .prepare("SELECT COUNT(*) AS c FROM review_steps WHERE review_id = ? AND status <> 'approved'")
        .get(id);
      if (remaining && Number(remaining.c) === 0) {
        db.prepare('UPDATE reviews SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?').run(
          '已通过', ts, ts, id,
        );
      } else {
        db.prepare('UPDATE reviews SET updated_at = ? WHERE id = ?').run(ts, id);
      }
      return;
    }

    /* serial / single：末步 → 终审；否则推进下一人 */
    const total = db
      .prepare('SELECT COUNT(*) AS c FROM review_steps WHERE review_id = ?')
      .get(id);
    const nextIdx = Number(row.current_step || 0) + 1;
    const totalSteps = total ? Number(total.c) : 0;
    if (nextIdx >= totalSteps) {
      db.prepare('UPDATE reviews SET status = ?, current_step = ?, closed_at = ?, updated_at = ? WHERE id = ?').run(
        '已通过', totalSteps, ts, ts, id,
      );
    } else {
      db.prepare("UPDATE review_steps SET status = 'current' WHERE review_id = ? AND step_index = ?").run(id, nextIdx);
      db.prepare('UPDATE reviews SET current_step = ?, updated_at = ? WHERE id = ?').run(nextIdx, ts, id);
    }
  });
  tx();

  /* 审计 + 终态联动（事务外，沿用铁律） */
  const updated = toApiReview(db, getReviewRow(db, id));

  /* 终态 → 通知发起人（变更类评审由变更单决议通知覆盖，避免重复） */
  if ((updated.status === '已通过' || updated.status === '已驳回') && row.ref_type !== 'change') {
    if (row.initiator_open_id && row.initiator_open_id !== openId) {
      notificationService.notify(db, {
        recipients: [row.initiator_open_id],
        type: notificationService.NOTIFICATION_TYPES.REVIEW_DECIDED,
        title: '评审已' + (updated.status === '已通过' ? '通过' : '驳回') + '：' + row.title,
        body: '「' + row.title + '」已由 ' + actorName + (updated.status === '已通过' ? ' 通过' : ' 驳回') + (comment ? '：' + comment : ''),
        projectId: row.project_id,
        refType: 'review',
        refId: id,
      });
    }
  }

  if (action === 'reject') {
    writeAudit(db, me, 'review', id, 'reject', row.project_id, '驳回评审「' + row.title + '」：' + comment, [
      diffEntry('status', '评审状态', '审批中', '已驳回'),
    ]);
    /* BUG-2 修复：驳回联动（镜像 onReviewApproved）——立项评审驳回 → 项目 审批中→已驳回 */
    onReviewRejected(db, updated, me);
    return updated;
  }

  if (review.mode === 'parallel_veto') {
    writeAudit(db, me, 'review', id, 'approve', row.project_id, actorName + ' 在「' + row.title + '」投出通过票');
  } else if (updated.status === '已通过') {
    writeAudit(db, me, 'review', id, 'approve', row.project_id, '评审「' + row.title + '」终审通过', [
      diffEntry('status', '评审状态', '审批中', '已通过'),
    ]);
  } else {
    writeAudit(db, me, 'review', id, 'approve', row.project_id, '评审「' + row.title + '」第 ' + (step.stepIndex + 1) + ' 步通过，流转至下一审批人');
  }

  if (updated.status === '已通过') {
    onReviewApproved(db, updated, me);
  }

  return updated;
}

/**
 * 审批通过（R1）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {object} payload
 * @param {object} me
 * @returns {object} Review
 */
function approveReview(db, id, payload, me) {
  return decide(db, id, 'approve', payload, me);
}

/**
 * 审批驳回（R1）——comment 必填（对齐 Mock L2043）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {object} payload
 * @param {object} me
 * @returns {object} Review
 */
function rejectReview(db, id, payload, me) {
  return decide(db, id, 'reject', payload, me);
}

/**
 * 撤回评审：仅发起人 / admin；已终态 409。
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {object} payload
 * @param {object} me users 行
 * @returns {object} Review
 * @throws {AppError} E_REVIEW_CLOSED / E_FORBIDDEN
 */
function withdrawReview(db, id, payload, me) {
  const row = getReviewRow(db, id);
  if (row.status !== '审批中') throw new AppError(ErrorCode.E_REVIEW_CLOSED);

  const openId = mappers.toStr(me && (me.open_id !== undefined ? me.open_id : me.openId));
  // E1.5：任一全局职位为 admin 即可强制撤回
  const isAdmin = resolveGlobalRoles(me).indexOf('admin') >= 0;
  if (row.initiator_open_id !== openId && !isAdmin) {
    throw new AppError(ErrorCode.E_FORBIDDEN, '仅发起人可撤回');
  }

  const body = payload && typeof payload === 'object' ? payload : {};
  const comment = mappers.toStr(body.comment || '');
  const evidenceUrl = mappers.toStr(body.evidenceUrl || '');
  const actorName = mappers.toStr(me && (me.name !== undefined ? me.name : ''));
  const ts = dates.nowIso();

  const tx = db.transaction(function () {
    db.prepare('UPDATE reviews SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?').run(
      '已撤回', ts, ts, id,
    );
    db.prepare(`
      INSERT INTO review_approvals (
        id, review_id, project_id, step_index, step_role,
        actor_open_id, actor_name, action, comment, evidence_url, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      genId('AP'),
      id,
      row.project_id,
      row.current_step,
      'initiator',
      openId,
      actorName,
      'withdraw',
      comment,
      evidenceUrl,
      ts,
    );
  });
  tx();

  writeAudit(db, me, 'review', id, 'update', row.project_id, '撤回评审「' + row.title + '」');

  return toApiReview(db, getReviewRow(db, id));
}

/* ── 终态联动（R1.2） ───────────────────────────────── */

/**
 * 评审终审通过后的联动（对齐 Mock `onReviewApproved` L466-494）：
 *  - refType='project' → 项目 `审批中→已批准` + 审计 status_change
 *  - refType='gate'    → 门 `已通过` + `achieveMilestoneByGate`（幂等）
 *  - refType='change'  → 变更 `审批中→已批准`（防御性，本期 changes 表为空）
 *
 * ⚠ 本函数在评审事务**外**调用：写项目/门/变更 + 审计全部旁路。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} review Review（API 形态）
 * @param {object} actor users 行
 * @returns {void}
 */
function onReviewApproved(db, review, actor) {
  const actorOpenId = mappers.toStr(actor && (actor.open_id !== undefined ? actor.open_id : actor.openId));

  /* ⚠ D08.2：评审通过**不再联动质量门**——门控唯一通道是门区决议（检查项勾齐 +
   * 交付物硬校验，decideGate）。挂门评审通过仅留痕，避免绕过门控校验的旁路。 */
  if (review.refType === 'gate') {
    writeAudit(db, actor, 'review', String(review.id), 'approve', String(review.project_id),
      '评审通过（不联动质量门）：「' + mappers.toStr(review.title) + '」');
    return;
  }

  if (review.refType === 'project') {
    const p = db
      .prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL')
      .get(String(review.refId || ''));
    if (p && p.status === '审批中') {
      db.prepare("UPDATE projects SET status = '已批准', updated_at = ? WHERE id = ?").run(dates.nowIso(), p.id);
      writeAudit(db, actor, 'project', p.id, 'status_change', p.id, '立项审批通过，项目状态变更为「已批准」', [
        diffEntry('status', '项目状态', '审批中', '已批准'),
      ]);
    }
    return;
  }

  if (review.refType === 'change') {
    const c = db.prepare('SELECT * FROM changes WHERE id = ?').get(String(review.refId || ''));
    if (c && c.status === '审批中') {
      db.prepare("UPDATE changes SET status = '已批准', updated_at = ? WHERE id = ?").run(dates.nowIso(), c.id);
      writeAudit(db, actor, 'change', c.id, 'approve', mappers.toStr(c.project_id), '变更单 ' + mappers.toStr(c.code) + ' 审批通过，待实施');
      /* 通知变更单创建人（剔除决议人自身） */
      if (c.created_by && c.created_by !== actorOpenId) {
        notificationService.notify(db, {
          recipients: [c.created_by],
          type: notificationService.NOTIFICATION_TYPES.CHANGE_DECIDED,
          title: '变更单已批准：' + mappers.toStr(c.code) + ' ' + mappers.toStr(c.title),
          body: '「' + mappers.toStr(c.code) + ' ' + mappers.toStr(c.title) + '」已审批通过，待实施',
          projectId: mappers.toStr(c.project_id),
          refType: 'change',
          refId: c.id,
        });
      }
    }
  }
}

/**
 * 评审驳回后的联动（BUG-2 · 镜像 `onReviewApproved` 的 project 分支）：
 *  - refType='project' → 项目 `审批中→已驳回` + 审计 status_change
 *
 * 契约：立项评审被驳回后项目必须离开「审批中」态，否则项目卡在审批中且
 * 会误触发 BUG-1 的回退重提路径异常（原始投诉）。仅当 `p.status==='审批中'`
 * 时翻转，保证幂等（重复驳回 / 已终态项目不重复写）。
 *
 * ⚠ 本函数在评审事务**外**调用：写项目 + 审计全部旁路（沿用 onReviewApproved 铁律）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} review Review（API 形态，status 应为「已驳回」）
 * @param {object} actor users 行
 * @returns {void}
 */
function onReviewRejected(db, review, actor) {
  if (review.refType === 'project') {
    const p = db
      .prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL')
      .get(String(review.refId || ''));
    if (p && p.status === '审批中') {
      db.prepare("UPDATE projects SET status = '已驳回', updated_at = ? WHERE id = ?").run(dates.nowIso(), p.id);
      writeAudit(db, actor, 'project', p.id, 'status_change', p.id, '立项审批驳回，项目状态变更为「已驳回」', [
        diffEntry('status', '项目状态', '审批中', '已驳回'),
      ]);
    }
  }

  /* D08：变更单审批驳回 → 变更单「已驳回」（幂等：仅审批中翻转） */
  if (review.refType === 'change') {
    const c = db.prepare('SELECT * FROM changes WHERE id = ?').get(String(review.refId || ''));
    if (c && mappers.toStr(c.status) === '审批中') {
      db.prepare("UPDATE changes SET status = '已驳回', updated_at = ? WHERE id = ?").run(dates.nowIso(), String(c.id));
      writeAudit(db, actor, 'change', String(c.id), 'reject', mappers.toStr(c.project_id),
        '变更单 ' + mappers.toStr(c.code) + ' 审批驳回',
        [diffEntry('status', '变更状态', '审批中', '已驳回')]);
      /* 通知变更单创建人（剔除决议人自身） */
      if (c.created_by && c.created_by !== actorOpenId) {
        notificationService.notify(db, {
          recipients: [c.created_by],
          type: notificationService.NOTIFICATION_TYPES.CHANGE_DECIDED,
          title: '变更单已驳回：' + mappers.toStr(c.code) + ' ' + mappers.toStr(c.title),
          body: '「' + mappers.toStr(c.code) + ' ' + mappers.toStr(c.title) + '」审批被驳回',
          projectId: mappers.toStr(c.project_id),
          refType: 'change',
          refId: c.id,
        });
      }
    }
  }
}

module.exports = {
  listReviews,
  listMyApprovals,
  getReview,
  createReview,
  approveReview,
  rejectReview,
  withdrawReview,
  canDecide,
  onReviewApproved,
  onReviewRejected,
  // 供 T04 工作台复用（同一 canDecide 口径）
  decide,
};
