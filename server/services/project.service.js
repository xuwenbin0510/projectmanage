/**
 * 项目主链路服务（P0-02 / P0-03 / P0-04 · 建项 → 列表 → 详情 → 里程碑）
 *
 * 职责边界：
 *  - 事务、校验、错误码在本层；纯算法在 `server/lib/rules.js`；行↔对象在 `server/lib/mappers.js`
 *  - **派生值 `status` / `done` 不落库**（SK-2），读路径统一用 `rules.applyMilestoneStatuses` 推导
 *  - 建项**不自动生成质量门**（K-1）；仅当向导在 `payload.milestones[].gate` 显式提交门规格时才落库
 *  - 建项按模板 `wbsRules.skeleton==='per-milestone'` 生成顶层 WBS 骨架节点（B4/B3 补丁）；
 *    看板配置 `board_configs` 仍由 `board.service.ensureBoardConfig` 惰性创建
 */

const { AppError, ErrorCode } = require('../lib/errors');
const { paged } = require('../lib/envelope');
const dates = require('../lib/dates');
const rules = require('../lib/rules');
const wbs = require('../lib/wbs');
const ids = require('../lib/ids');
const mappers = require('../lib/mappers');
const enums = require('../config/enums');
const rbac = require('../config/permissions');
const roleCatalog = require('./roleCatalog');
const classifyService = require('./classify.service');
const milestoneService = require('./milestone.service');
const documentService = require('./document.service');
const riskService = require('./risk.service');
const { resolveGlobalRoles } = require('../middleware/auth');

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

/**
 * 编辑项目基本信息（E1：管理员/项目负责人可改类型、成员等必要字段）。
 *
 * 权限：admin 恒放行；否则仅项目负责人（pm）或创建人。
 * 与 legacy `PUT /projects/:id` 同源 SQL，但按 PATCH 语义只更新传入字段，
 * 且支持 `code` / `type` 等本次放开的字段。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} req Express request（`req.user` 为 users 行）
 * @param {string} id
 * @param {object} payload 前端 UpdateProjectPayload + code/type
 * @returns {object} API 形态 Project
 * @throws {AppError} E_NOT_FOUND / E_FORBIDDEN / E_VALIDATION
 */
function updateProjectBasic(db, req, id, payload) {
  const me = req.user || {};
  const p = requireProjectRow(db, id);

  /* 权限：admin 恒放行；否则项目负责人或创建人；
     q-0 放开：矩阵里被分配 project:edit 的角色（如 pmo，全局 scope）也能编辑任意项目。
     其余 4 处归属判定（周报作者/确认人、评审发起人）保持 owner/author-only 不动。 */
  const meId = me && me.id != null ? me.id : null;
  const isOwner =
    (meId != null && p.created_by_user_id === meId) ||
    (meId != null && db.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND member_user_id = ? AND project_role = 'pm'").get(id, meId) != null);
  // 矩阵对齐：canDo 对 admin 短路放行，故无需额外 isAdmin 判定
  const canEditByMatrix = rbac.canDo(resolveGlobalRoles(me), 'project:edit');
  if (!isOwner && !canEditByMatrix) {
    throw new AppError(ErrorCode.E_FORBIDDEN, '仅项目负责人、管理员或被授权角色可编辑', { projectId: id });
  }

  const b = payload || {};
  const fields = [];
  const vals = [];

  if (b.code !== undefined) {
    fields.push('code = ?');
    vals.push(String(b.code ?? '').trim());
  }
  if (b.name !== undefined) {
    fields.push('name = ?');
    vals.push(String(b.name ?? '').trim());
  }
  if (b.type !== undefined) {
    if (enums.PROJECT_TYPES.indexOf(b.type) < 0) {
      throw new AppError(ErrorCode.E_VALIDATION, '项目类型不合法', { type: b.type });
    }
    fields.push('type = ?');
    vals.push(String(b.type));
  }

  /* 模板：归属「生效分类」且启用方可选（与建项向导同源校验） */
  const effectiveType = b.type !== undefined ? String(b.type) : p.type;
  if (b.templateId !== undefined) {
    if (b.templateId === '' || b.templateId == null) {
      fields.push('template_id = ?');
      vals.push(null); // 清空为系统默认
    } else {
      const tplRow = db
        .prepare(
          'SELECT * FROM lifecycle_templates WHERE id = ? AND project_type = ? AND is_active = 1',
        )
        .get(String(b.templateId), effectiveType);
      if (!tplRow) {
        throw new AppError(
          ErrorCode.E_VALIDATION,
          '指定的生命周期模板不存在、已停用或不属于该项目分类',
          { templateId: String(b.templateId), projectType: effectiveType },
        );
      }
      fields.push('template_id = ?');
      vals.push(String(b.templateId));
    }
  }
  if (b.customer !== undefined) {
    fields.push('customer = ?');
    vals.push(String(b.customer ?? '').trim());
  }
  if (b.contractAmount !== undefined) {
    const amt = Number(b.contractAmount) || 0;
    fields.push('amount = ?');
    vals.push(amt);
  }
  if (b.background !== undefined) {
    fields.push('background = ?');
    vals.push(String(b.background ?? ''));
  }
  if (b.goal !== undefined) {
    const goal = Array.isArray(b.goal) ? b.goal : [];
    fields.push('goal = ?');
    vals.push(JSON.stringify(goal));
  }
  if (b.planStart !== undefined) {
    fields.push('plan_start = ?');
    vals.push(String(b.planStart ?? ''));
  }
  if (b.planEnd !== undefined) {
    fields.push('plan_end = ?');
    vals.push(String(b.planEnd ?? ''));
  }

  if (!fields.length) return mappers.toApiProject(p);

  fields.push('updated_at = ?');
  vals.push(dates.nowIso());
  vals.push(String(id));

  const tx = db.transaction(function () {
    db.prepare('UPDATE projects SET ' + fields.join(', ') + ' WHERE id = ?').run(...vals);
    /* 类型变更：同步重整“系统自动生成的模板交付物”，用户自定义数据（CUS- 必交付项 / 手动上传 / 里程碑 / 质量门 / WBS）一律不动 */
    if (b.type !== undefined && String(b.type) !== p.type) {
      reconcileTemplateDeliverablesOnTypeChange(db, id, p, b);
    }
  });
  tx();

  return mappers.toApiProject(requireProjectRow(db, id));
}

/**
 * 类型变更时重整模板交付物（D-BUG 修复）：
 * - 删除「旧类型的自动交付物」（待交付、非 CUS- 自定义、非手动上传），避免与旧类型残留纠缠；
 * - 按新类型模板重新派生（幂等：已存在的 key 不重复插入）；
 * - 用户自定义的里程碑 / 质量门 / WBS / CUS- 必交付项 / 手动上传文件：全部保留。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {object} oldRow 变更前 projects 行（含 type / template_id）
 * @param {object} payload 本次变更入参（含 type / templateId?）
 */
function reconcileTemplateDeliverablesOnTypeChange(db, projectId, oldRow, payload) {
  const newType = String(payload.type);
  /* 新模板：显式指定 templateId 优先，否则取新类型生效模板 */
  let newTplRow = null;
  if (payload.templateId) {
    newTplRow = db
      .prepare('SELECT * FROM lifecycle_templates WHERE id = ? AND project_type = ? AND is_active = 1')
      .get(String(payload.templateId), newType);
  }
  if (!newTplRow) {
    newTplRow = db
      .prepare('SELECT * FROM lifecycle_templates WHERE project_type = ? AND is_active = 1 ORDER BY version DESC LIMIT 1')
      .get(newType);
  }
  if (!newTplRow) return; // 无模板可派生，跳过

  const keepPrefix = String(newTplRow.id) + '-%';
  db.prepare(
    "DELETE FROM project_documents WHERE project_id = ? AND status = '待交付' AND template_key != '' AND template_key NOT LIKE ? AND template_key NOT LIKE 'CUS-%'",
  ).run(projectId, keepPrefix);

  documentService.deriveTemplateDocs(db, projectId, newTplRow);
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
         LEFT JOIN users u ON u.id = m.member_user_id
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
 * 里程碑任务统计索引（口径 Y · SK-M4）。
 *
 * 口径 Y：某碑的任务全集 = **直接绑定该碑的节点 ∪ 这些节点子树里的真叶子**；
 * `total` / `done` 按全集计，`progress` 只按真叶子加权（`wbs.milestoneTaskStats` 已实现）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {Array<string>} [milestoneIds] 只统计这些碑；省略则统计项目内全部绑定到的碑
 * @returns {Object<string, {total:number,done:number,progress:number}>}
 */
function loadTaskStats(db, projectId, milestoneIds) {
  const stats = {};
  const rows = db.prepare('SELECT * FROM wbs_nodes WHERE project_id = ?').all(String(projectId));
  const nodes = wbs.sortByWbsCode(rows.map(mappers.toApiWbsNode));

  let ids = Array.isArray(milestoneIds) ? milestoneIds.slice() : null;
  if (!ids) {
    const seen = {};
    ids = [];
    nodes.forEach(function (n) {
      if (!n.milestoneId || seen[n.milestoneId]) return;
      seen[n.milestoneId] = true;
      ids.push(n.milestoneId);
    });
  }

  ids.forEach(function (msId) {
    const key = String(msId || '');
    if (!key) return;
    stats[key] = nodes.length ? wbs.milestoneTaskStats(nodes, key) : rules.emptyTaskStats();
  });
  return stats;
}

/**
 * 里程碑 + 门 + 检查项 + 任务统计 聚合视图（里程碑页 / 概览页唯一数据源）。
 *
 * ⚠ 批次 3 起本函数**只做薄转发**：真实现统一在 `milestone.service.listMilestonesWithGate`，
 *   与写路径（create / update / delete / decideGate）共用同一份「重排 + 派生状态 + 门聚合」逻辑，
 *   避免读写两份实现漂移（T04-4）。
 *
 *   循环依赖说明：`milestone.service` **不反向 require 本文件**（项目行它自己查），
 *   因此这里用顶层 require 是安全的。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {Array<object>} MilestoneWithGate[]
 */
function listMilestones(db, projectId) {
  requireProjectRow(db, projectId);
  return milestoneService.listMilestonesWithGate(db, projectId);
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
  const nameOf = mappers.makeNameLookup(db);

  db.prepare(
    `SELECT m.project_id, m.user_open_id, u.name AS user_name
       FROM project_members m
       LEFT JOIN users u ON u.id = m.member_user_id
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
      const g = mappers.toApiGate(r, nameOf);
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
 * @param {import('better-sqlite3').Database} db
 * @returns {object} ProjectListItem
 */
function toListItem(row, ctx, todayStr, db, highRiskMap) {
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
    /* 列表进度口径 = 里程碑达成率（与前端 Mock `toListItem` 逐字一致，不用 WBS 加权，
       否则同一个项目在列表页与项目详情页会显示两个不同的百分比） */
    progress: status === '已结项'
      ? 100
      : (sorted.length ? Math.round((milestoneDone / sorted.length) * 100) : 0),
    milestoneDone: milestoneDone,
    milestoneTotal: sorted.length,
    nextMilestoneDate: next ? next.currentDate || null : null,
    /* 高风险数：risk_value >= 12（与前端 Mock `toListItem` 逐字一致），现由风险表实时统计；
       优先用调用方一次性批量算好的 Map（消除逐项目 N+1），缺失时回退单查以保兼容 */
    highRiskCount: highRiskMap
      ? (highRiskMap.get(projectId) || 0)
      : riskService.countHighRisks(db, projectId),
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
  if (q.onlyMine && me && me.id != null) {
    where.push('EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.member_user_id = ?)');
    args.push(me.id);
  }

  const rows = db
    .prepare('SELECT p.* FROM projects p WHERE ' + where.join(' AND ') + ' ORDER BY p.updated_at DESC, p.id DESC')
    .all(args);

  const ctx = loadListContext(db, rows.map(function (r) { return String(r.id); }));
  const todayStr = dates.today();
  /* 一次性批量统计所有项目高风险数（替代 toListItem 内逐项目 N+1 查询） */
  const highRiskMap = riskService.countHighRisksBatch(db, rows.map(function (r) { return String(r.id); }));
  let items = rows.map(function (r) { return toListItem(r, ctx, todayStr, db, highRiskMap); });

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
  const myId = me && me.id != null ? me.id : '';
  if (!myId) return [];
  const rows = db
    .prepare(
      `SELECT p.* FROM projects p
        WHERE p.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.member_user_id = ?)
        ORDER BY p.updated_at DESC, p.id DESC`,
    )
    .all(myId);
  const ctx = loadListContext(db, rows.map(function (r) { return String(r.id); }));
  const todayStr = dates.today();
  return rows.map(function (r) { return toListItem(r, ctx, todayStr, db); });
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
  if (enums.PROJECT_TYPES.indexOf(p.type) < 0) fields.push({ field: 'type', message: '项目类型必须为 A / B / C / D 之一' });
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
 * @param {object} tpl 生命周期模板（API 形态，含 definition.team）
 * @throws {AppError} E_PROJECT_PO_REQUIRED / E_ROLE_CARDINALITY / E_VALIDATION
 *
 * 团队约束优先级：模板 definition.team（min ≤ 人数 ≤ max，max=-1 不限）→
 * 缺省回落系统默认（PM/TL 各恰 1；B 类另需 PO 恰 1）——老模板零行为变化。
 */
function assertMemberCardinality(members, tpl) {
  const list = Array.isArray(members) ? members : [];

  /* 角色合法性（与模板无关，保留）：scope=project 且启用的角色方可作为项目成员角色 */
  const bad = list.filter(function (m) {
    return !m || !String(m.userOpenId || '').trim() || !roleCatalog.isProjectRole(m.role);
  });
  if (bad.length) {
    throw new AppError(ErrorCode.E_VALIDATION, '成员角色不合法', {
      fields: [{ field: 'members', message: '成员必须包含合法 userOpenId 与 projectRole' }],
    });
  }

  /* 团队约束：模板 team 优先，缺省回落系统默认 */
  const team =
    tpl && tpl.definition && Array.isArray(tpl.definition.team) && tpl.definition.team.length
      ? tpl.definition.team
      : defaultTeamRules(tpl);
  for (const rule of team) {
    const role = String(rule.role || '');
    const count = list.filter(function (m) { return m.role === role; }).length;
    const min = Number(rule.min) || 0;
    const maxRaw = Number(rule.max);
    const max = maxRaw === -1 ? Infinity : maxRaw;
    if (count < min || count > max) {
      /* 回退规则场景保留原错误码语义（前端依赖的提示文案） */
      if (role === 'po' && count === 0 && min === 1) {
        throw new AppError(ErrorCode.E_PROJECT_PO_REQUIRED, undefined, { projectType: tpl ? tpl.projectType : 'B' });
      }
      if ((role === 'pm' || role === 'tl') && count !== 1) {
        throw new AppError(ErrorCode.E_ROLE_CARDINALITY, undefined, { pmCount: countOf(list, 'pm'), tlCount: countOf(list, 'tl') });
      }
      throw new AppError(ErrorCode.E_VALIDATION, '团队成员不满足模板约束', {
        fields: [{ field: 'members', message: `模板要求角色「${role}」${min}~${maxRaw === -1 ? '不限' : maxRaw} 人，当前 ${count} 人` }],
      });
    }
  }
}

/** 模板未配置 team 时的系统默认约束（与历史硬编码完全一致） */
function defaultTeamRules(tpl) {
  const rules = [
    { role: 'pm', min: 1, max: 1 },
    { role: 'tl', min: 1, max: 1 },
  ];
  if (tpl && tpl.projectType === 'B') rules.push({ role: 'po', min: 1, max: 1 });
  return rules;
}

function countOf(list, role) {
  return list.filter(function (m) { return m.role === role; }).length;
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
 * 取项目分类对应的**全部启用模板**（API 形态，version DESC）。
 * 方案A（阶段三补）：建项向导「生命周期模板」下拉的数据源。
 * @param {import('better-sqlite3').Database} db
 * @param {'A'|'B'|'C'} type
 * @returns {Array<object>} LifecycleTemplate[]
 */
function listActiveTemplateOptions(db, type) {
  if (enums.PROJECT_TYPES.indexOf(type) < 0) return [];
  return db
    .prepare(
      'SELECT * FROM lifecycle_templates WHERE project_type = ? AND is_active = 1 ORDER BY version DESC',
    )
    .all(String(type))
    .map(mappers.toApiTemplate);
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
 * 按 id 取模板（API 形态，含停用模板）；缺失返回 null。
 * 阶段三：管理后台模板 CRUD 的读取出口。
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {object|null} LifecycleTemplate | null
 */
function getTemplateById(db, id) {
  const row = db.prepare('SELECT * FROM lifecycle_templates WHERE id = ?').get(String(id));
  return row ? mappers.toApiTemplate(row) : null;
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

  /* 方案A（阶段三补）：向导显式选模板 → 优先用 payload.templateId；
     校验归属分类 + 必须启用；不传时回落「分类下唯一生效模板」（旧行为） */
  let tplRow;
  if (payload.templateId) {
    tplRow = db
      .prepare(
        'SELECT * FROM lifecycle_templates WHERE id = ? AND project_type = ? AND is_active = 1',
      )
      .get(String(payload.templateId), type);
    if (!tplRow) {
      throw new AppError(
        ErrorCode.E_VALIDATION,
        '指定的生命周期模板不存在、已停用或不属于该项目分类',
        { templateId: String(payload.templateId), projectType: type },
      );
    }
  } else {
    tplRow = requireActiveTemplateRow(db, type);
  }
  const tpl = mappers.toApiTemplate(tplRow);

  /* 成员基数校验必须放在模板选择之后：约束来源 = 模板 definition.team（缺省回落系统默认） */
  assertMemberCardinality(payload.members, tpl);

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
      pm, approved_by, created_by, created_by_user_id, created_at, updated_at, deleted_at
    ) VALUES (
      @id, @code, @name, @type, @classify_input, @classify_suggested, @classify_override_reason,
      @customer, @contract_amount, @background, @goal, @status, @health,
      @plan_start, @plan_end, NULL, @approval_step, @template_id,
      @pm, NULL, @created_by, @created_by_user_id, @created_at, @updated_at, NULL
    )
  `);
  const insMember = db.prepare(`
    INSERT INTO project_members (id, project_id, user_open_id, project_role, assigned_by, assigned_at, member_user_id, assigned_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
  const insWbsNode = db.prepare(`
    INSERT INTO wbs_nodes (
      id, project_id, parent_id, wbs_code, level, node_type, name, description,
      owner, estimate_days, actual_days, start_date, due_date, status, progress,
      board_order, is_critical, milestone_id, created_by, created_at, updated_at
    ) VALUES (
      @id, @project_id, @parent_id, @wbs_code, @level, @node_type, @name, @description,
      @owner, @estimate_days, @actual_days, @start_date, @due_date, @status, @progress,
      @board_order, @is_critical, @milestone_id, @created_by, @created_at, @updated_at
    )
  `);

  const pmMember = (payload.members || []).filter(function (m) { return m.role === 'pm'; })[0];
  const createdBy = me && me.open_id ? String(me.open_id) : '';
  const createdByUserId = me && me.id != null ? Number(me.id) : mappers.resolveUserId(db, createdBy);

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
      pm: pmMember ? String(pmMember.userOpenId) : createdBy,
      created_by: createdBy,
      created_by_user_id: createdByUserId,
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
        mappers.resolveUserId(db, m.userOpenId),
        createdByUserId,
      );
    });

    /* 决策「开放自建 + 自己是 PM」：创建人恒登记为 PM 成员
       —— 若其已在 payload.members 中以 pm 角色出现则跳过，避免 (project_id, user_open_id, project_role) UNIQUE 冲突 */
    const creatorIsPm = (payload.members || []).some(function (m) {
      return m.role === 'pm' && String(m.userOpenId) === createdBy;
    });
    if (createdBy && !creatorIsPm) {
      insMember.run(projectId + '-MBC', projectId, createdBy, 'pm', createdBy, createdByUserId, createdByUserId);
    }

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

      /* B4 / B3补丁：按模板 WBS 规则生成顶层骨架节点，绑定 milestoneId（复刻旧 Mock per-milestone 行为） */
      const wbsRules = rules.resolveWbsRules(tpl);
      if (wbsRules && wbsRules.skeleton === 'per-milestone') {
        insWbsNode.run({
          id: ids.genId('W'),
          project_id: projectId,
          parent_id: null,
          wbs_code: String(idx + 1),
          level: 1,
          node_type: 'task',
          name: String(spec.name || ''),
          description: '由 ' + String(tpl.name || '') + ' 模板里程碑「'
            + String(spec.code || 'M' + (idx + 1)) + ' ' + String(spec.name || '') + '」自动生成',
          owner: '',
          estimate_days: 0,
          actual_days: 0,
          start_date: '',
          due_date: date,
          status: '待办',
          progress: 0,
          board_order: idx,
          is_critical: 0,
          milestone_id: msId,
          created_by: createdBy,
          created_at: ts,
          updated_at: ts,
        });
      }

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

  /* D04：按模板派生「待交付物清单」（事务外 + try/catch：派生失败不阻塞建项，列表懒派生兜底） */
  try {
    documentService.deriveTemplateDocs(db, projectId, tplRow);
  } catch (e) {
    // 忽略：文档列表接口的懒派生会重试
  }

  /* 落库后统一重排 code（向导可能改过日期 / 加过碑，模板 code 顺序已失效 · P0-M1） */
  listMilestones(db, projectId);

  /* WBS 骨架已在上方按模板 skeleton 规则生成；board_configs 由 board.service 惰性创建 */

  // TODO(批次4): 写入 audit 日志（建项审计与项目流转审计一并接入）

  return getProject(db, projectId);
}

/**
 * 删除项目（管理员专属，路由层已 `assertCan(db, req, 'project:delete')`）。
 *
 * 采用**软删**（置 `deleted_at`），保留项目成员 / 里程碑 / WBS 等关联数据以便必要时恢复，
 * 列表与详情均按 `deleted_at IS NULL` 过滤，软删后即对所有普通用户不可见。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id 项目 id
 * @returns {{ id: string, deleted: boolean }}
 * @throws {AppError} E_NOT_FOUND
 */
function deleteProject(db, id) {
  const p = requireProjectRow(db, id); // 已软删 / 不存在 → E_NOT_FOUND
  const ts = dates.nowIso();
  db.prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, p.id);
  return { id: p.id, deleted: true };
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
  listActiveTemplateOptions,
  listTemplates,
  getTemplateById,
  templateMilestoneSpecs,
  assertCreatePayload,
  assertMemberCardinality,
  createProject,
  updateProjectBasic,
  deleteProject,
};
