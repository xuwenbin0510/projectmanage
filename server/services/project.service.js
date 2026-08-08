/**
 * 项目主链路服务（P0-02 / P0-03 / P0-04 · 建项 → 列表 → 详情 → 里程碑）
 *
 * 职责边界：
 *  - 事务、校验、错误码在本层；纯算法在 `server/lib/rules.js`；行↔对象在 `server/lib/mappers.js`
 *  - **派生值 `status` / `done` 不落库**（SK-2），读路径统一用 `rules.applyMilestoneStatuses` 推导
 *  - 建项**不自动生成质量门**（K-1）；仅当向导在 `payload.milestones[].gate` 显式提交门规格时才落库
 *  - WBS 骨架 / 看板配置属批次 3，本批次不建表不生成（前端走降级桩）
 */

const { AppError, ErrorCode } = require('../lib/errors');
const { paged } = require('../lib/envelope');
const dates = require('../lib/dates');
const rules = require('../lib/rules');
const ids = require('../lib/ids');
const mappers = require('../lib/mappers');
const enums = require('../config/enums');
const classifyService = require('./classify.service');

/** 无 PM 时列表页展示的占位（与前端 Mock `toListItem` 一致） */
const NO_PM_PLACEHOLDER = '—';

/** 列表默认分页 */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

/* ── 基础读取 ───────────────────────────────────────── */

/**
 * 按 id 读项目行（不存在返回 undefined）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {object|undefined}
 */
function findProjectRow(db, id) {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(String(id || ''));
}

/**
 * 按 id 读项目行，不存在直接 404。
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {object}
 * @throws {AppError} E_NOT_FOUND
 */
function requireProjectRow(db, id) {
  const row = findProjectRow(db, id);
  if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, '项目不存在', { projectId: String(id || '') });
  return row;
}

/**
 * 项目详情（API 形态）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {object} Project
 */
function getProject(db, id) {
  return mappers.toApiProject(requireProjectRow(db, id));
}

/* ── 成员 ───────────────────────────────────────────── */

/**
 * 项目成员列表（API 形态，含派生 userName）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {Array<object>} ProjectMember[]
 */
function listMembers(db, projectId) {
  requireProjectRow(db, projectId);
  const rows = db
    .prepare(
      `SELECT m.*, u.name AS user_name
         FROM project_members m
         LEFT JOIN users u ON u.open_id = m.user_open_id
        WHERE m.project_id = ?
        ORDER BY m.assigned_at ASC, m.id ASC`,
    )
    .all(String(projectId));
  const nameOf = mappers.makeNameLookup(db);
  return rows.map(function (r) { return mappers.toApiMember(r, nameOf); });
}

/* ── 里程碑聚合 ─────────────────────────────────────── */

/**
 * 读取项目全部质量门 + 检查项，按 milestone_id 建索引。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {{gateByMs: Object, itemsByGate: Object, gates: Array<object>}}
 */
function loadGates(db, projectId) {
  const gateRows = db
    .prepare('SELECT * FROM quality_gates WHERE project_id = ? ORDER BY created_at ASC, id ASC')
    .all(String(projectId));
  const gates = gateRows.map(mappers.toApiGate);

  const gateByMs = {};
  const gateIds = [];
  gates.forEach(function (g) {
    gateByMs[g.milestoneId] = g;
    gateIds.push(g.id);
  });

  const itemsByGate = {};
  if (gateIds.length) {
    const placeholders = gateIds.map(function () { return '?'; }).join(',');
    const itemRows = db
      .prepare('SELECT * FROM gate_checklist_items WHERE gate_id IN (' + placeholders + ') ORDER BY seq ASC, id ASC')
      .all(gateIds);
    itemRows.forEach(function (r) {
      const item = mappers.toApiGateItem(r);
      if (!itemsByGate[item.gateId]) itemsByGate[item.gateId] = [];
      itemsByGate[item.gateId].push(item);
    });
  }
  return { gateByMs: gateByMs, itemsByGate: itemsByGate, gates: gates };
}

/**
 * 里程碑任务统计索引。
 *
 * ⚠ 批次 1 尚未落 `wbs_nodes` 表，一律返回空统计（`{total:0,done:0,progress:0}`）；
 *   批次 3 接入 WBS 后在此处替换为真实口径 Y 统计（SK-M4）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {Object<string, {total:number,done:number,progress:number}>}
 */
function loadTaskStats(db, projectId) {
  // TODO(批次3): 接入 wbs_nodes 后按「直接绑定 ∪ 子树真叶子」口径 Y 计算
  void db;
  void projectId;
  return {};
}

/**
 * 里程碑 + 门 + 检查项 + 任务统计 聚合视图（里程碑页 / 概览页唯一数据源）。
 *
 * 读路径副作用（与前端 Mock 一致）：
 *  - **幂等重排** code 为 M1..Mn，发现漂移即落库自愈（P0-M2 / F-2）
 *  - 统一推导派生 status / done（SK-2）
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {Array<object>} MilestoneWithGate[]
 */
function listMilestones(db, projectId) {
  const project = requireProjectRow(db, projectId);
  const rows = db
    .prepare('SELECT * FROM milestones WHERE project_id = ? ')
    .all(String(projectId));
  const list = rows.map(mappers.toApiMilestone);

  /* 幂等重排；有漂移才写库，避免每次读都产生写放大 */
  const changed = rules.renumberMilestones(list);
  if (changed.length) {
    const upd = db.prepare('UPDATE milestones SET code = ? WHERE id = ?');
    const tx = db.transaction(function (items) {
      items.forEach(function (m) { upd.run(m.code, m.id); });
    });
    tx(changed);
  }

  const stats = loadTaskStats(db, projectId);
  rules.applyMilestoneStatuses(list, mappers.toStr(project.plan_start), dates.today(), stats);

  const gateIdx = loadGates(db, projectId);
  return rules.sortMilestones(list).map(function (m) {
    const gate = gateIdx.gateByMs[m.id] || null;
    const gateItems = gate ? gateIdx.itemsByGate[gate.id] || [] : [];
    return mappers.toApiMilestoneWithGate(m, gate, gateItems, stats[m.id] || rules.emptyTaskStats());
  });
}

/* ── 列表聚合 ───────────────────────────────────────── */

/**
 * 一次性加载列表聚合所需的关联数据（避免 N+1 逐项目查询）。
 * @param {import('better-sqlite3').Database} db
 * @param {Array<string>} projectIds
 * @returns {{pmName: Object, milestones: Object, gates: Object}}
 */
function loadListContext(db, projectIds) {
  const ctx = { pmName: {}, milestones: {}, gates: {} };
  if (!projectIds.length) return ctx;
  const placeholders = projectIds.map(function () { return '?'; }).join(',');

  db.prepare(
    `SELECT m.project_id, m.user_open_id, u.name AS user_name
       FROM project_members m
       LEFT JOIN users u ON u.open_id = m.user_open_id
      WHERE m.project_id IN (` + placeholders + `) AND m.project_role = 'pm'
      ORDER BY m.assigned_at ASC`,
  )
    .all(projectIds)
    .forEach(function (r) {
      if (ctx.pmName[r.project_id]) return; // 取最早指派的那个 pm
      ctx.pmName[r.project_id] = r.user_name || mappers.REMOVED_USER_NAME;
    });

  db.prepare('SELECT * FROM milestones WHERE project_id IN (' + placeholders + ')')
    .all(projectIds)
    .forEach(function (r) {
      const m = mappers.toApiMilestone(r);
      if (!ctx.milestones[m.projectId]) ctx.milestones[m.projectId] = [];
      ctx.milestones[m.projectId].push(m);
    });

  db.prepare('SELECT * FROM quality_gates WHERE project_id IN (' + placeholders + ')')
    .all(projectIds)
    .forEach(function (r) {
      const g = mappers.toApiGate(r);
      if (!ctx.gates[g.projectId]) ctx.gates[g.projectId] = [];
      ctx.gates[g.projectId].push(g);
    });

  return ctx;
}

/**
 * 项目行 → `ProjectListItem`（聚合下一里程碑 / 当前门 / 过门数 / 进度）。
 *
 * 「项目走到第几步」由「下一里程碑 + 已过 N/M 道门」表达（§3.2 / N-5）。
 *
 * @param {object} row projects 行
 * @param {{pmName: Object, milestones: Object, gates: Object}} ctx
 * @param {string} todayStr
 * @returns {object} ProjectListItem
 */
function toListItem(row, ctx, todayStr) {
  const projectId = mappers.toStr(row.id);
  const msList = (ctx.milestones[projectId] || []).slice();
  const gates = ctx.gates[projectId] || [];

  /* 派生状态（列表页无 WBS 统计，taskStats 全为空） */
  rules.applyMilestoneStatuses(msList, mappers.toStr(row.plan_start), todayStr, {});
  const sorted = rules.sortMilestones(msList);
  rules.renumberMilestones(sorted); // 仅内存显示用，列表读路径不落库

  const next = sorted.filter(function (m) { return !m.done; })[0] || null;
  const gate = next ? gates.filter(function (g) { return g.milestoneId === next.id; })[0] || null : null;
  const status = mappers.toStr(row.status, '草稿');
  const milestoneDone = sorted.filter(function (m) { return m.done; }).length;

  return mappers.toApiProjectListItem(row, {
    pmName: ctx.pmName[projectId] || NO_PM_PLACEHOLDER,
    nextMilestoneCode: next ? next.code : '',
    nextMilestoneName: next ? next.name : '',
    currentGateCode: gate ? gate.code : '',
    currentGateStatus: gate ? gate.status : '未开始',
    gatePassed: rules.countPassedGates(gates),
    gateTotal: gates.length,
    // TODO(批次3): 接入 wbs_nodes 后用 rollupProjectProgress(nodes) 替换里程碑达成率
    progress: status === '已结项'
      ? 100
      : (sorted.length ? Math.round((milestoneDone / sorted.length) * 100) : 0),
    milestoneDone: milestoneDone,
    milestoneTotal: sorted.length,
    nextMilestoneDate: next ? next.currentDate || null : null,
    // TODO(批次4): 接入 risks 表后统计 riskValue >= 12 的高风险数
    highRiskCount: 0,
  });
}

/**
 * 项目列表（过滤 + 排序 + 分页）。
 *
 * 返回值形态为 `Paged<ProjectListItem>`（`{items,total,page,pageSize}`），
 * 与 `listAudit` 并列，是**仅有的两个**分页接口。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} query ProjectQuery
 * @param {object} me 当前用户 users 行
 * @returns {{items: Array<object>, total: number, page: number, pageSize: number}}
 */
function listProjects(db, query, me) {
  const q = query && typeof query === 'object' ? query : {};
  const page = Math.max(DEFAULT_PAGE, parseInt(q.page, 10) || DEFAULT_PAGE);
  const rawSize = parseInt(q.pageSize, 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, rawSize));

  const where = ['p.deleted_at IS NULL'];
  const args = [];

  const keyword = String(q.keyword === undefined || q.keyword === null ? '' : q.keyword).trim().toLowerCase();
  if (keyword) {
    where.push('(LOWER(p.name) LIKE ? OR LOWER(p.code) LIKE ? OR LOWER(IFNULL(p.customer, \'\')) LIKE ?)');
    const like = '%' + keyword + '%';
    args.push(like, like, like);
  }
  if (q.type) { where.push('p.type = ?'); args.push(String(q.type)); }
  if (q.status) { where.push('p.status = ?'); args.push(String(q.status)); }
  if (q.health) { where.push('p.health = ?'); args.push(String(q.health)); }
  if (q.onlyMine && me && me.open_id) {
    where.push('EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_open_id = ?)');
    args.push(String(me.open_id));
  }

  const rows = db
    .prepare('SELECT p.* FROM projects p WHERE ' + where.join(' AND ') + ' ORDER BY p.updated_at DESC, p.id DESC')
    .all(args);

  const ctx = loadListContext(db, rows.map(function (r) { return String(r.id); }));
  const todayStr = dates.today();
  let items = rows.map(function (r) { return toListItem(r, ctx, todayStr); });

  /* pm 过滤按「PM 姓名」匹配（与前端 Mock 口径一致），须在聚合后进行 */
  if (q.pm) {
    const pmName = String(q.pm);
    items = items.filter(function (r) { return r.pmName === pmName; });
  }

  const total = items.length;
  const start = (page - 1) * pageSize;
  return paged(items.slice(start, start + pageSize), total, page, pageSize);
}

/**
 * 「我参与的项目」列表项（工作台用）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} me 当前用户 users 行
 * @returns {Array<object>} ProjectListItem[]
 */
function listMyProjectItems(db, me) {
  const openId = me && me.open_id ? String(me.open_id) : '';
  if (!openId) return [];
  const rows = db
    .prepare(
      `SELECT p.* FROM projects p
        WHERE p.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_open_id = ?)
        ORDER BY p.updated_at DESC, p.id DESC`,
    )
    .all(openId);
  const ctx = loadListContext(db, rows.map(function (r) { return String(r.id); }));
  const todayStr = dates.today();
  return rows.map(function (r) { return toListItem(r, ctx, todayStr); });
}

/* ── 建项校验 ───────────────────────────────────────── */

/**
 * 建项参数校验（字段级）。
 * @param {object} payload CreateProjectPayload
 * @throws {AppError} E_VALIDATION
 */
function assertCreatePayload(payload) {
  const fields = [];
  const p = payload && typeof payload === 'object' ? payload : {};

  if (!String(p.name || '').trim()) fields.push({ field: 'name', message: '项目名称不能为空' });
  if (enums.PROJECT_TYPES.indexOf(p.type) < 0) fields.push({ field: 'type', message: '项目类型必须为 A / B / C 之一' });
  if (!dates.isDate(p.planStart)) fields.push({ field: 'planStart', message: '计划开始日期格式须为 YYYY-MM-DD' });
  if (!dates.isDate(p.planEnd)) fields.push({ field: 'planEnd', message: '计划结束日期格式须为 YYYY-MM-DD' });
  if (dates.isDate(p.planStart) && dates.isDate(p.planEnd) && dates.diffDays(p.planStart, p.planEnd) < 0) {
    fields.push({ field: 'planEnd', message: '计划结束日期不能早于开始日期' });
  }
  if (!Array.isArray(p.members) || !p.members.length) {
    fields.push({ field: 'members', message: '至少需要指派一名项目成员' });
  }
  if (p.contractAmount !== undefined && p.contractAmount !== null && !Number.isFinite(Number(p.contractAmount))) {
    fields.push({ field: 'contractAmount', message: '合同额必须为数字（单位：万元）' });
  }

  if (fields.length) throw new AppError(ErrorCode.E_VALIDATION, undefined, { fields: fields });
}

/**
 * 成员角色基数校验（PM / TL 各恰好 1 人；B 类必须有 PO）。
 * @param {Array<{userOpenId:string, role:string}>} members
 * @param {'A'|'B'|'C'} type
 * @throws {AppError} E_PROJECT_PO_REQUIRED / E_ROLE_CARDINALITY
 */
function assertMemberCardinality(members, type) {
  const list = Array.isArray(members) ? members : [];

  if (type === 'B' && !list.some(function (m) { return m.role === 'po'; })) {
    throw new AppError(ErrorCode.E_PROJECT_PO_REQUIRED, undefined, { projectType: 'B' });
  }
  const pmCount = list.filter(function (m) { return m.role === 'pm'; }).length;
  const tlCount = list.filter(function (m) { return m.role === 'tl'; }).length;
  if (pmCount !== 1 || tlCount !== 1) {
    throw new AppError(ErrorCode.E_ROLE_CARDINALITY, undefined, { pmCount: pmCount, tlCount: tlCount });
  }
  const bad = list.filter(function (m) {
    return !m || !String(m.userOpenId || '').trim() || enums.PROJECT_ROLES.indexOf(m.role) < 0;
  });
  if (bad.length) {
    throw new AppError(ErrorCode.E_VALIDATION, '成员角色不合法', {
      fields: [{ field: 'members', message: '成员必须包含合法 userOpenId 与 projectRole' }],
    });
  }
}

/**
 * 取项目类型对应的生效模板行；缺失抛 404（建项必须有模板）。
 * @param {import('better-sqlite3').Database} db
 * @param {'A'|'B'|'C'} type
 * @returns {object} lifecycle_templates 行
 */
function requireActiveTemplateRow(db, type) {
  const row = db
    .prepare('SELECT * FROM lifecycle_templates WHERE project_type = ? AND is_active = 1 ORDER BY version DESC LIMIT 1')
    .get(String(type));
  if (!row) {
    throw new AppError(ErrorCode.E_NOT_FOUND, '未找到该项目类型的生命周期模板', { projectType: String(type) });
  }
  return row;
}

/**
 * 取项目类型对应的生效模板（API 形态）；缺失返回 `null`（**不抛 404**，见契约注释）。
 * @param {import('better-sqlite3').Database} db
 * @param {'A'|'B'|'C'} type
 * @returns {object|null} LifecycleTemplate | null
 */
function getLifecycleTemplate(db, type) {
  if (enums.PROJECT_TYPES.indexOf(type) < 0) return null;
  const row = db
    .prepare('SELECT * FROM lifecycle_templates WHERE project_type = ? AND is_active = 1 ORDER BY version DESC LIMIT 1')
    .get(String(type));
  return row ? mappers.toApiTemplate(row) : null;
}

/**
 * 全部生命周期模板（API 形态）。
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<object>} LifecycleTemplate[]
 */
function listTemplates(db) {
  return db
    .prepare('SELECT * FROM lifecycle_templates ORDER BY project_type ASC, version DESC')
    .all()
    .map(mappers.toApiTemplate);
}

/**
 * 由模板生成里程碑规格（向导未提交 `payload.milestones` 时的回退路径）。
 *
 * K-1：模板回退**不生成质量门**（`gate: null`），只保留类型契约。
 *
 * @param {object} template LifecycleTemplate（API 形态）
 * @param {string} planStart
 * @param {string} planEnd
 * @returns {Array<{code:string,name:string,target:string,date:string,required:boolean,gate:null}>}
 */
function templateMilestoneSpecs(template, planStart, planEnd) {
  const defs = (template && template.definition && template.definition.milestones) || [];
  const fitted = dates.fitMilestoneDates(planStart, planEnd, defs.map(function (d) { return d.offsetDays; }));
  return defs.map(function (d, i) {
    return {
      code: String(d.code || ''),
      name: String(d.name || ''),
      target: '',
      date: fitted[i] || dates.addDays(planStart, d.offsetDays || 0),
      required: !!d.required,
      gate: null, // K-1
    };
  });
}

/* ── 建项事务 ───────────────────────────────────────── */

/**
 * 新建项目（P0-02）。
 *
 * 事务内一次性落：1 项目 + N 成员 + N 里程碑（+ 向导显式提交的 M 门 / K 检查项）。
 * 任一步失败整体回滚，不留半截数据。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} payload CreateProjectPayload
 * @param {object} me 当前用户 users 行
 * @returns {object} Project
 */
function createProject(db, payload, me) {
  assertCreatePayload(payload);

  const type = payload.type;
  const suggested = enums.PROJECT_TYPES.indexOf(payload.classifySuggested) >= 0
    ? payload.classifySuggested
    : type;
  classifyService.assertOverrideReason(type, suggested, payload.classifyOverrideReason);
  assertMemberCardinality(payload.members, type);

  const tplRow = requireActiveTemplateRow(db, type);
  const tpl = mappers.toApiTemplate(tplRow);

  const seqRow = db.prepare('SELECT COUNT(*) AS n FROM projects').get();
  const seq = (seqRow && seqRow.n ? Number(seqRow.n) : 0) + 1;
  const projectId = ids.genId('P');
  const code = ids.projectCode(seq);
  const ts = dates.nowIso();

  const specList = Array.isArray(payload.milestones) && payload.milestones.length
    ? payload.milestones
    : templateMilestoneSpecs(tpl, payload.planStart, payload.planEnd);

  const insProject = db.prepare(`
    INSERT INTO projects (
      id, code, name, type, classify_input, classify_suggested, classify_override_reason,
      customer, contract_amount, background, goal, status, health,
      plan_start, plan_end, actual_end, approval_step, template_id,
      pm, approved_by, created_by, created_at, updated_at, deleted_at
    ) VALUES (
      @id, @code, @name, @type, @classify_input, @classify_suggested, @classify_override_reason,
      @customer, @contract_amount, @background, @goal, @status, @health,
      @plan_start, @plan_end, NULL, @approval_step, @template_id,
      @pm, NULL, @created_by, @created_at, @updated_at, NULL
    )
  `);
  const insMember = db.prepare(`
    INSERT INTO project_members (id, project_id, user_open_id, project_role, assigned_by, assigned_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insMilestone = db.prepare(`
    INSERT INTO milestones (
      id, project_id, code, name, target, required,
      baseline_date, planned_date, done_at, done_by,
      status_override, override_by, override_at, override_base_date,
      last_change_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
  `);
  const insGate = db.prepare(`
    INSERT INTO quality_gates (
      id, project_id, milestone_id, code, name, owner_role, status,
      conclusion, comment, decided_by, decided_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, '未开始', '', '', NULL, NULL, ?)
  `);
  const insGateItem = db.prepare(`
    INSERT INTO gate_checklist_items (id, gate_id, seq, content, owner_role, checked, checked_by, checked_at, source)
    VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, 'template')
  `);

  const pmMember = (payload.members || []).filter(function (m) { return m.role === 'pm'; })[0];
  const createdBy = me && me.open_id ? String(me.open_id) : '';

  const tx = db.transaction(function () {
    insProject.run({
      id: projectId,
      code: code,
      name: String(payload.name).trim(),
      type: type,
      classify_input: JSON.stringify(classifyService.normalizeInput(payload.classifyInput)),
      classify_suggested: suggested,
      classify_override_reason: String(payload.classifyOverrideReason || ''),
      customer: String(payload.customer || ''),
      contract_amount: Number(payload.contractAmount) || 0,
      background: String(payload.background || ''),
      goal: JSON.stringify(Array.isArray(payload.goal) ? payload.goal.map(String) : []),
      status: '草稿',
      health: 'green',
      plan_start: String(payload.planStart),
      plan_end: String(payload.planEnd),
      approval_step: 0,
      template_id: tpl.id,
      pm: pmMember ? String(pmMember.userOpenId) : '',
      created_by: createdBy,
      created_at: ts,
      updated_at: ts,
    });

    (payload.members || []).forEach(function (m, i) {
      insMember.run(
        projectId + '-MB' + (i + 1),
        projectId,
        String(m.userOpenId),
        String(m.role),
        createdBy,
        ts,
      );
    });

    specList.forEach(function (spec, idx) {
      const msId = projectId + '-MS' + (idx + 1);
      const date = String(spec.date || payload.planStart);
      insMilestone.run(
        msId,
        projectId,
        String(spec.code || 'M' + (idx + 1)),
        String(spec.name || ''),
        String(spec.target || ''),
        spec.required ? 1 : 0,
        date, // 创建即基线
        date,
        ts,
        ts,
      );

      /* K-1：仅当向导显式提交门规格时才落门；模板回退路径 gate 恒为 null */
      if (spec.gate && typeof spec.gate === 'object') {
        const gateId = msId + '-G';
        insGate.run(
          gateId,
          projectId,
          msId,
          String(spec.gate.code || ''),
          String(spec.gate.name || ''),
          String(spec.gate.ownerRole || ''),
          ts,
        );
        const gateItems = Array.isArray(spec.gate.items) ? spec.gate.items : [];
        gateItems.forEach(function (item, j) {
          insGateItem.run(
            gateId + '-I' + (j + 1),
            gateId,
            j + 1,
            String(item && item.content ? item.content : ''),
            String(item && item.ownerRole ? item.ownerRole : ''),
          );
        });
      }
    });
  });

  tx();

  /* 落库后统一重排 code（向导可能改过日期 / 加过碑，模板 code 顺序已失效 · P0-M1） */
  listMilestones(db, projectId);

  // TODO(批次3): 生成 per-milestone WBS 骨架与 board_configs（wbs_nodes 表批次 3 建立）
  // TODO(批次4): 写入 audit 日志（audit_logs 表批次 4 建立）

  return getProject(db, projectId);
}

module.exports = {
  NO_PM_PLACEHOLDER,
  findProjectRow,
  requireProjectRow,
  getProject,
  listMembers,
  listMilestones,
  listProjects,
  listMyProjectItems,
  toListItem,
  loadListContext,
  getLifecycleTemplate,
  listTemplates,
  templateMilestoneSpecs,
  assertCreatePayload,
  assertMemberCardinality,
  createProject,
};
