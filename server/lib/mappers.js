/**
 * DB 行 ↔ API 对象 显式映射层（设计方案 §3.8）
 *
 * 硬约束：
 *  1. **逐实体显式映射**，禁止通用 snake→camel 自动转换（字段有例外，见下表）
 *  2. 例外表：
 *     - `milestones.planned_date` → API `currentDate`
 *     - `users.global_role`       → API `globalRole`
 *     - `wbs_nodes.board_order`   → API `boardOrder`
 *     其余 `wbs_code` / `node_type` / `is_critical` 等属于常规 snake→camel，不算例外，
 *     但仍由 `toApiWbsNode` **逐字段显式**列出（约束 1）。
 *  3. 布尔：DB `INTEGER 0/1` → API `true/false`
 *  4. JSON：DB `TEXT` → API 真数组 / 真对象
 *  5. 空值：一律 `null`，不要 `''` / `0`
 *  6. 派生显示字段：`pm` 必带 `pmName`，`owner` 必带 `ownerName`；
 *     人已被移除时返回 `'(已移除)'` 而非 `null`
 */

const { diffDays } = require('./dates');

/** 人员已移除时的占位显示名（§3.8） */
const REMOVED_USER_NAME = '(已移除)';

/** DB 列 → API 字段 例外映射表（仅登记，供检索与文档用） */
const FIELD_EXCEPTIONS = Object.freeze({
  'milestones.planned_date': 'currentDate',
  'users.global_role': 'globalRole',
  'wbs_nodes.board_order': 'boardOrder',
});

/* ── 基础工具 ───────────────────────────────────────── */

/**
 * DB INTEGER → boolean。
 * @param {*} v
 * @returns {boolean}
 */
function toBool(v) {
  return v === 1 || v === true || v === '1';
}

/**
 * boolean → DB INTEGER。
 * @param {*} v
 * @returns {number}
 */
function toInt(v) {
  return v ? 1 : 0;
}

/**
 * 空值归一：`undefined` / `''` → `null`。
 * @param {*} v
 * @returns {*}
 */
function toNull(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v === '') return null;
  return v;
}

/**
 * 字符串归一：`null` / `undefined` → `''`（用于契约里声明为 string 的字段）。
 * @param {*} v
 * @param {string} [fallback='']
 * @returns {string}
 */
function toStr(v, fallback) {
  const fb = fallback === undefined ? '' : fallback;
  if (v === undefined || v === null) return fb;
  return String(v);
}

/**
 * 数字归一：非法值退回 fallback。
 * @param {*} v
 * @param {number} [fallback=0]
 * @returns {number}
 */
function toNum(v, fallback) {
  const fb = fallback === undefined ? 0 : fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

/**
 * DB TEXT → JSON 对象 / 数组；解析失败返回 fallback。
 * @param {*} raw
 * @param {*} fallback
 * @returns {*}
 */
function parseJson(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(String(raw));
    return v === null || v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

/**
 * DB TEXT → string[]。
 * @param {*} raw
 * @returns {string[]}
 */
function parseStringArray(raw) {
  const v = parseJson(raw, []);
  if (!Array.isArray(v)) return [];
  return v.map(function (x) { return String(x === null || x === undefined ? '' : x); });
}

/** 分类输入默认值（前端 `ClassifyInput` 全字段必填） */
function defaultClassifyInput() {
  return {
    contractAmount: 0,
    hasHardware: false,
    hasAcceptance: false,
    isSelfIteration: false,
    isInfrastructure: false,
  };
}

/**
 * DB TEXT → ClassifyInput（补齐缺失字段，避免前端表单 undefined）。
 * @param {*} raw
 * @returns {{contractAmount:number,hasHardware:boolean,hasAcceptance:boolean,isSelfIteration:boolean,isInfrastructure:boolean}}
 */
function parseClassifyInput(raw) {
  const src = parseJson(raw, {}) || {};
  const base = defaultClassifyInput();
  return {
    contractAmount: toNum(src.contractAmount, base.contractAmount),
    hasHardware: !!src.hasHardware,
    hasAcceptance: !!src.hasAcceptance,
    isSelfIteration: !!src.isSelfIteration,
    isInfrastructure: !!src.isInfrastructure,
  };
}

/* ── 姓名解析（派生显示字段） ─────────────────────────── */

/**
 * 构造 openId → 姓名 的查询函数（带进程内单次请求缓存）。
 *
 * 用法：`const nameOf = makeNameLookup(db); nameOf('ou_xxx') // → '李明' | '(已移除)'`
 * 空 openId 返回 `''`（表示「本来就没人」，区别于「人被移除」）。
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {(openId: string) => string}
 */
function makeNameLookup(db) {
  const cache = new Map();
  const stmt = db.prepare('SELECT name FROM users WHERE open_id = ?');
  return function nameOf(openId) {
    const key = toStr(openId);
    if (!key) return '';
    if (cache.has(key)) return cache.get(key);
    let name = REMOVED_USER_NAME;
    try {
      const row = stmt.get(key);
      if (row && row.name) name = String(row.name);
    } catch (e) {
      name = REMOVED_USER_NAME;
    }
    cache.set(key, name);
    return name;
  };
}

/* ── User ───────────────────────────────────────────── */

/**
 * users 行 → API `User`。
 * ⚠ DB `global_role` → API `globalRole`（例外表）。
 * @param {object} row
 * @returns {object|null}
 */
function toApiUser(row) {
  if (!row) return null;
  return {
    id: toNum(row.id, 0),
    openId: toStr(row.open_id),
    employeeId: toStr(row.employee_id),
    name: toStr(row.name),
    email: toStr(row.email),
    dept: toStr(row.dept),
    avatarUrl: toStr(row.avatar_url),
    globalRole: toStr(row.global_role, 'member'),
    status: toStr(row.status, 'active'),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  };
}

/* ── Project ────────────────────────────────────────── */

/**
 * projects 行 → API `Project`。
 * @param {object} row
 * @returns {object|null}
 */
function toApiProject(row) {
  if (!row) return null;
  return {
    id: toStr(row.id),
    code: toStr(row.code),
    name: toStr(row.name),
    type: toStr(row.type, 'B'),
    classifyInput: parseClassifyInput(row.classify_input),
    classifySuggested: toStr(row.classify_suggested, toStr(row.type, 'B')),
    classifyOverrideReason: toStr(row.classify_override_reason),
    customer: toStr(row.customer),
    contractAmount: toNum(row.contract_amount, 0),
    background: toStr(row.background),
    goal: parseStringArray(row.goal),
    status: toStr(row.status, '草稿'),
    health: toStr(row.health, 'green'),
    planStart: toStr(row.plan_start),
    planEnd: toStr(row.plan_end),
    actualEnd: toNull(row.actual_end),
    approvalStep: toNum(row.approval_step, -1),
    templateId: toStr(row.template_id),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  };
}

/** 列表行聚合字段默认值（无里程碑 / 无门时的安全值） */
function defaultListAggregates() {
  return {
    pmName: '',
    nextMilestoneCode: '',
    nextMilestoneName: '',
    currentGateCode: '',
    currentGateStatus: '未开始',
    gatePassed: 0,
    gateTotal: 0,
    progress: 0,
    milestoneDone: 0,
    milestoneTotal: 0,
    nextMilestoneDate: null,
    highRiskCount: 0,
  };
}

/**
 * projects 行 + 聚合 → API `ProjectListItem`。
 * @param {object} row projects 行
 * @param {object} [aggregates] 聚合字段（缺省用安全默认值）
 * @returns {object|null}
 */
function toApiProjectListItem(row, aggregates) {
  const base = toApiProject(row);
  if (!base) return null;
  const agg = Object.assign(defaultListAggregates(), aggregates || {});
  return Object.assign(base, {
    pmName: toStr(agg.pmName),
    nextMilestoneCode: toStr(agg.nextMilestoneCode),
    nextMilestoneName: toStr(agg.nextMilestoneName),
    currentGateCode: toStr(agg.currentGateCode),
    currentGateStatus: toStr(agg.currentGateStatus, '未开始'),
    gatePassed: toNum(agg.gatePassed, 0),
    gateTotal: toNum(agg.gateTotal, 0),
    progress: toNum(agg.progress, 0),
    milestoneDone: toNum(agg.milestoneDone, 0),
    milestoneTotal: toNum(agg.milestoneTotal, 0),
    nextMilestoneDate: toNull(agg.nextMilestoneDate),
    highRiskCount: toNum(agg.highRiskCount, 0),
  });
}

/* ── ProjectMember ──────────────────────────────────── */

/**
 * project_members 行 → API `ProjectMember`（含派生 `userName`）。
 * @param {object} row
 * @param {(openId:string)=>string} [nameOf]
 * @returns {object|null}
 */
function toApiMember(row, nameOf) {
  if (!row) return null;
  const openId = toStr(row.user_open_id);
  let userName = toStr(row.user_name);
  if (!userName) userName = typeof nameOf === 'function' ? nameOf(openId) : REMOVED_USER_NAME;
  return {
    id: toStr(row.id),
    projectId: toStr(row.project_id),
    userOpenId: openId,
    userName: userName,
    projectRole: toStr(row.project_role, 'member'),
    assignedBy: toStr(row.assigned_by),
    assignedAt: toStr(row.assigned_at),
  };
}

/* ── 质量门 ─────────────────────────────────────────── */

/**
 * quality_gates 行 → API `QualityGate`。
 * @param {object} row
 * @returns {object|null}
 */
function toApiGate(row) {
  if (!row) return null;
  return {
    id: toStr(row.id),
    projectId: toStr(row.project_id),
    milestoneId: toStr(row.milestone_id),
    code: toStr(row.code),
    name: toStr(row.name),
    ownerRole: toStr(row.owner_role),
    status: toStr(row.status, '未开始'),
    conclusion: toStr(row.conclusion),
    comment: toStr(row.comment),
    decidedBy: toNull(row.decided_by),
    decidedAt: toNull(row.decided_at),
    createdAt: toStr(row.created_at),
  };
}

/**
 * gate_checklist_items 行 → API `GateChecklistItem`。
 * @param {object} row
 * @returns {object|null}
 */
function toApiGateItem(row) {
  if (!row) return null;
  return {
    id: toStr(row.id),
    gateId: toStr(row.gate_id),
    seq: toNum(row.seq, 0),
    content: toStr(row.content),
    ownerRole: toStr(row.owner_role),
    checked: toBool(row.checked),
    checkedBy: toNull(row.checked_by),
    checkedAt: toNull(row.checked_at),
    source: toStr(row.source, 'template'),
  };
}

/* ── 里程碑 ─────────────────────────────────────────── */

/**
 * milestones 行 → API `Milestone`（未含派生 status / done）。
 *
 * ⚠ 例外：DB `planned_date` → API `currentDate`。
 * ⚠ `status` / `done` 是派生值（SK-2），这里先给占位，
 *   由 `rules.applyMilestoneStatuses()` 统一覆写，禁止业务代码直写。
 *
 * @param {object} row
 * @returns {object|null}
 */
function toApiMilestone(row) {
  if (!row) return null;
  const baselineDate = toStr(row.baseline_date);
  const currentDate = toStr(row.planned_date);
  return {
    id: toStr(row.id),
    projectId: toStr(row.project_id),
    code: toStr(row.code),
    name: toStr(row.name),
    target: toStr(row.target),
    required: toBool(row.required),
    baselineDate: baselineDate,
    currentDate: currentDate,
    delayDays: baselineDate && currentDate ? diffDays(baselineDate, currentDate) : 0,
    // 以下两项为派生占位值，最终由 applyMilestoneStatuses 覆写
    status: '未开始',
    done: false,
    doneAt: toNull(row.done_at),
    doneBy: toNull(row.done_by),
    statusOverride: toNull(row.status_override),
    overrideBy: toNull(row.override_by),
    overrideAt: toNull(row.override_at),
    overrideBaseDate: toNull(row.override_base_date),
    lastChangeId: toNull(row.last_change_id),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  };
}

/**
 * 组装 API `MilestoneWithGate`（SK-1：无门恒为 `null`，不是空对象）。
 * @param {object} milestone `toApiMilestone` 的结果
 * @param {object|null} gate `toApiGate` 的结果
 * @param {Array<object>} gateItems `toApiGateItem` 的结果数组
 * @param {{total:number,done:number,progress:number}} taskStats
 * @returns {object}
 */
function toApiMilestoneWithGate(milestone, gate, gateItems, taskStats) {
  return Object.assign({}, milestone, {
    gate: gate || null,
    gateItems: Array.isArray(gateItems) ? gateItems : [],
    taskStats: taskStats || { total: 0, done: 0, progress: 0 },
  });
}

/* ── WBS 节点 ───────────────────────────────────────── */

/**
 * wbs_nodes 行 → API `WbsNode`（20 字段，全 camelCase）。
 *
 * ⚠ 例外：DB `board_order` → API `boardOrder`（FIELD_EXCEPTIONS 已登记）。
 * ⚠ B8：`effortHours` 映射**存储累计值**（累计实际工时·人日；叶子=历次已提交日志累加值/0）；
 *   父节点的最终 Σ 由 `wbs.service.loadNodes` 的 `decorateEffort` 装饰覆盖，此处不计算。
 * ⚠ `ownerName`：未指派（owner 为空）时返回 `''` 而非 `'(已移除)'`
 *   —— 「本来就没人」区别于「人被移除」，与 `makeNameLookup` 语义一致。
 * ⚠ `parentId` / `milestoneId`：空串归一为 `null`（契约里是 `string | null`）。
 *
 * @param {object} row wbs_nodes 行
 * @param {(openId:string)=>string} [nameOf] 姓名解析器（`makeNameLookup(db)`）
 * @returns {object|null}
 */
function toApiWbsNode(row, nameOf) {
  if (!row) return null;
  const owner = toStr(row.owner);
  const ownerName = owner && typeof nameOf === 'function' ? nameOf(owner) : '';
  return {
    id: toStr(row.id),
    projectId: toStr(row.project_id),
    parentId: toNull(row.parent_id),
    wbsCode: toStr(row.wbs_code),
    level: toNum(row.level, 1),
    nodeType: toStr(row.node_type, 'task'),
    name: toStr(row.name),
    description: toStr(row.description),
    owner: owner,
    ownerName: ownerName,
    estimateDays: toNum(row.estimate_days, 0),
    actualDays: toNum(row.actual_days, 0),
    // B8：叶子=存储累计值（累计实际人日，NULL→0）；父节点最终值由 decorateEffort 覆盖（父列恒 NULL，展示走 Σ 子）
    effortHours: toNum(row.effort_hours, 0),
    startDate: toStr(row.start_date),
    dueDate: toStr(row.due_date),
    status: toStr(row.status, '待办'),
    progress: toNum(row.progress, 0),
    // B14 块1：任务优先级（P0/P1/P2/P3）；历史行经 v7 回填，读出恒有值，兜底 P2
    priority: toStr(row.priority, 'P2'),
    boardOrder: toNum(row.board_order, 0),
    isCritical: toBool(row.is_critical),
    milestoneId: toNull(row.milestone_id),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  };
}

/* ── 看板 ───────────────────────────────────────────── */

/**
 * board_configs 行 → API `BoardConfig`。
 * 行不存在时由 service 懒创建，本函数只做形态转换。
 * @param {object} row board_configs 行
 * @returns {object|null}
 */
function toApiBoardConfig(row) {
  if (!row) return null;
  const columns = parseJson(row.columns, []);
  const wipLimits = parseJson(row.wip_limits, {});
  return {
    projectId: toStr(row.project_id),
    columns: Array.isArray(columns) ? columns : [],
    wipLimits: wipLimits && typeof wipLimits === 'object' && !Array.isArray(wipLimits) ? wipLimits : {},
    updatedAt: toStr(row.updated_at),
  };
}

/**
 * 组装 API `BoardView`。
 * @param {string} projectId
 * @param {Array<{status:string, cards:Array, wipLimit:number}>} columns 已排好序的列
 * @param {object} config `toApiBoardConfig` 的结果
 * @returns {{projectId: string, columns: Array, config: object}}
 */
function toApiBoardView(projectId, columns, config) {
  return {
    projectId: toStr(projectId),
    columns: (Array.isArray(columns) ? columns : []).map(function (c) {
      return {
        status: toStr(c.status),
        cards: Array.isArray(c.cards) ? c.cards : [],
        wipLimit: toNum(c.wipLimit, 0),
      };
    }),
    config: config || { projectId: toStr(projectId), columns: [], wipLimits: {}, updatedAt: '' },
  };
}

/* ── 审计 ───────────────────────────────────────────── */

/**
 * audit_logs 行 → API `AuditLog`。
 * @param {object} row
 * @param {(projectId:string)=>string} [projectNameOf] 项目名解析器
 * @returns {object|null}
 */
function toApiAuditLog(row, projectNameOf) {
  if (!row) return null;
  const projectId = toStr(row.project_id);
  const diff = parseJson(row.diff, []);
  return {
    id: toStr(row.id),
    projectId: projectId,
    projectName: typeof projectNameOf === 'function' ? toStr(projectNameOf(projectId)) : toStr(row.project_name),
    entityType: toStr(row.entity_type),
    entityId: toStr(row.entity_id),
    action: toStr(row.action),
    actorOpenId: toStr(row.actor_open_id),
    actorName: toStr(row.actor_name),
    before: parseJson(row.before_json, null),
    after: parseJson(row.after_json, null),
    diff: Array.isArray(diff) ? diff : [],
    summary: toStr(row.summary),
    createdAt: toStr(row.created_at),
  };
}

/* ── 生命周期模板 ───────────────────────────────────── */

/**
 * lifecycle_templates 行 → API `LifecycleTemplate`。
 * @param {object} row
 * @returns {object|null}
 */
function toApiTemplate(row) {
  if (!row) return null;
  const definition = parseJson(row.definition, { milestones: [], docs: [] }) || {};
  return {
    id: toStr(row.id),
    projectType: toStr(row.project_type, 'B'),
    version: toNum(row.version, 1),
    name: toStr(row.name),
    definition: {
      milestones: Array.isArray(definition.milestones) ? definition.milestones : [],
      docs: Array.isArray(definition.docs) ? definition.docs : [],
      wbsRules: definition.wbsRules && typeof definition.wbsRules === 'object' ? definition.wbsRules : undefined,
      team: Array.isArray(definition.team) && definition.team.length ? definition.team : undefined,
    },
    isActive: toBool(row.is_active),
    createdAt: toStr(row.created_at),
  };
}

module.exports = {
  REMOVED_USER_NAME,
  FIELD_EXCEPTIONS,
  toBool,
  toInt,
  toNull,
  toStr,
  toNum,
  parseJson,
  parseStringArray,
  parseClassifyInput,
  defaultClassifyInput,
  makeNameLookup,
  toApiUser,
  toApiProject,
  toApiProjectListItem,
  defaultListAggregates,
  toApiMember,
  toApiGate,
  toApiGateItem,
  toApiMilestone,
  toApiMilestoneWithGate,
  toApiWbsNode,
  toApiBoardConfig,
  toApiBoardView,
  toApiAuditLog,
  toApiTemplate,
};
