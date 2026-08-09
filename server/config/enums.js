/**
 * 全部状态枚举常量（后端镜像）
 *
 * ⚠ 唯一契约源是前端 `web/src/config/enums.ts`：本文件的**取值**必须与之逐字一致。
 *   中文「文案」只存在于前端（GLOBAL_ROLE_LABEL / PROJECT_TYPE_LABEL 等），
 *   后端只保留「取值」，不复制 label —— 否则两边文案会各自漂移。
 *
 * 例外：ProjectStatus / GateStatus / MilestoneStatus / TaskStatus 的**取值本身**
 *   就是中文（产品既定设计），此处照抄。
 */

/* ── 角色 ─────────────────────────────────────────── */

/** 全局角色（9 个） */
const GLOBAL_ROLES = [
  'admin',
  'management',
  'pmo',
  'pm',
  'tl',
  'qa',
  'cm',
  'po',
  'member',
];

/** 项目角色（7 个） */
const PROJECT_ROLES = ['pm', 'tl', 'po', 'qa', 'cm', 'pmo', 'member'];

/** 评审链里出现的角色（含虚拟的客户代表） */
const CHAIN_ROLES = PROJECT_ROLES.concat(['management', 'customer_rep']);

/* ── 项目 ─────────────────────────────────────────── */

const PROJECT_TYPES = ['A', 'B', 'C'];

const PROJECT_STATUSES = [
  '草稿',
  '审批中',
  '已批准',
  '进行中',
  '挂起',
  '已结项',
  '已终止',
  '已驳回',
];

/** 项目状态机允许的流转（P0-17） */
const PROJECT_TRANSITIONS = {
  草稿: ['审批中'],
  审批中: ['已批准', '已驳回'],
  已驳回: ['草稿'],
  已批准: ['进行中', '已终止'],
  进行中: ['挂起', '已结项', '已终止'],
  挂起: ['进行中', '已终止'],
  已结项: [],
  已终止: [],
};

/** 只读归档态：命中即拒绝一切写操作（E_PROJECT_ARCHIVED） */
const PROJECT_ARCHIVED_STATUSES = ['已结项', '已终止'];

const HEALTHS = ['green', 'yellow', 'red'];

/* ── 质量门 / 里程碑 ────────────────────────────────── */

const GATE_STATUSES = ['未开始', '待检查', '已通过', '有条件通过', '不通过'];

/** 门控结论可选项（提交结论时用） */
const GATE_CONCLUSIONS = ['已通过', '有条件通过', '不通过'];

/** 已「过门」的两种终态（概览页「已过 N/M 道门」口径） */
const GATE_PASSED_STATUSES = ['已通过', '有条件通过'];

const MILESTONE_STATUSES = ['未开始', '进行中', '已达成', '已逾期'];

/**
 * 里程碑状态人工覆盖的可选值（U-5 / SK-7b）。
 * **恒不含「已达成」** —— 达成只能通过质量门决议或写入 done_at。
 */
const MILESTONE_OVERRIDES = ['未开始', '进行中', '已逾期'];

/* ── WBS / 看板 ───────────────────────────────────── */

const TASK_STATUSES = ['待办', '进行中', '待评审', '完成', '阻塞'];

/** 看板列（不含「阻塞」，与前端 web/src/types/wbs.ts BOARD_COLUMNS 一致） */
const BOARD_COLUMNS = ['待办', '进行中', '待评审', '完成'];

const WBS_NODE_TYPES = ['task', 'subtask'];

/**
 * WBS 节点类型中文文案。
 * ⚠ 本文件原则上「只存取值不存 label」，此处是**唯一例外**：
 *   `validateWbsPlacement` 的报错文案由服务端生成（前端直接展示 message），
 *   与 `web/src/config/enums.ts` 的 `WBS_NODE_TYPE_LABEL` 逐字一致。
 */
const WBS_NODE_TYPE_LABEL = { task: '任务', subtask: '子任务' };

/**
 * 遗留 `tasks.status` → 新契约 `TaskStatus`（迁移 v2 单向映射）。
 * 未命中的取值一律回落 `待办`。
 * ⚠ 迁移层 `server/dal/migrations.js` 内联了同一份映射（迁移层不依赖业务层），
 *   两处改动必须同步。
 */
const LEGACY_TASK_STATUS_MAP = {
  待开始: '待办',
  未开始: '待办',
  待办: '待办',
  进行中: '进行中',
  待评审: '待评审',
  评审中: '待评审',
  已完成: '完成',
  完成: '完成',
  阻塞: '阻塞',
  已阻塞: '阻塞',
};

/**
 * WBS 层级规则缺省值（决策 D-2 / SK-5：三类项目一致，模板只覆盖差异项）
 * 业务代码应通过 resolveWbsRules(template) 取值，不要直接读本常量做判断。
 */
const DEFAULT_WBS_RULES = {
  maxDepth: 4,
  skeleton: 'per-milestone',
  childTypes: {
    root: ['task'],
    task: ['task', 'subtask'],
    subtask: [],
  },
};

/** 粒度上限（人日）：A 类 >5 告警，B 类 >2 告警，C 类沿用 A */
const GRANULARITY_LIMIT = { A: 5, B: 2, C: 5 };

/**
 * 本周实际工时登记上限（人日/次）：B8 R5，工作日志单行 actualDays 上限，
 * 与 web 端 WEEK_ACTUAL_DAYS_MAX 一致。
 */
const WEEK_ACTUAL_DAYS_MAX = 100;

/**
 * 累计实际工时上限（人日）：B8 R3/R5，节点 effort_hours 累计值上限（防溢出 + 防负数），
 * 与 web 端 EFFORT_DAYS_CUM_MAX 一致。
 */
const EFFORT_DAYS_CUM_MAX = 10000;

/** WIP 默认上限（架构 O8：进行中 ≤ 5，0 = 不限） */
const DEFAULT_WIP_LIMIT = 5;

/* ── 评审 ─────────────────────────────────────────── */

const REVIEW_TYPES = ['formal', 'technical', 'code', 'ccb', 'project'];

const REVIEW_MODES = ['serial', 'parallel_veto', 'single'];

const REVIEW_STATUSES = ['草稿', '审批中', '已通过', '已驳回', '已撤回'];

const REVIEW_STEP_STATUSES = ['pending', 'current', 'approved', 'rejected', 'skipped'];

/** 评审模板（服务端为准，GET /api/meta 直接下发给前端） */
const REVIEW_TEMPLATES = {
  formal: {
    key: 'formal',
    label: '正式评审',
    mode: 'parallel_veto',
    chain: ['pmo', 'tl', 'management', 'customer_rep'],
    description: '立项/需求/设计/验收 → 管理层 + PMO + TL + 客户代表，一票否决',
  },
  technical: {
    key: 'technical',
    label: '技术评审',
    mode: 'single',
    chain: ['tl'],
    description: '由技术负责人（TL）单人决议并留痕',
  },
  code: {
    key: 'code',
    label: '代码评审',
    mode: 'single',
    chain: ['tl'],
    description: '≥1 人 Approve 即可通过',
  },
  ccb: {
    key: 'ccb',
    label: 'CCB 变更评审',
    mode: 'serial',
    chain: ['pm', 'tl', 'po', 'customer_rep'],
    description: '基线变更 → PM → TL → PO → 客户代表 串行逐级',
  },
  project: {
    key: 'project',
    label: '立项审批',
    mode: 'serial',
    chain: ['pmo', 'management'],
    description: '立项审批串行链：PMO → 管理层',
  },
};

/* ── 变更 ─────────────────────────────────────────── */

const CHANGE_TYPES = ['milestone_date', 'requirement_baseline', 'scope', 'other'];

const CHANGE_ROUTES = ['pm_only', 'ccb'];

const CHANGE_STATUSES = ['草稿', '审批中', '已批准', '已驳回', '已实施'];

/** 变更路由判定阈值：≥3 人日走 CCB */
const CCB_EFFORT_THRESHOLD = 3;

/** 项目分类金额参考阈值（万元）：无本质特征且 ≥ 该值时建议 A 类 */
const CLASSIFY_AMOUNT_THRESHOLD = 100;

/* ── 审计 ─────────────────────────────────────────── */

const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'status_change',
  'decide',
  'approve',
  'reject',
  'apply',
];

const AUDIT_ENTITY_TYPES = [
  'project',
  'gate',
  'gate_item',
  'milestone',
  'wbs_node',
  'report',
  'review',
  'change',
  'user',
];

/* ── 用户状态 ─────────────────────────────────────── */

const USER_STATUSES = ['active', 'disabled'];

module.exports = {
  GLOBAL_ROLES,
  PROJECT_ROLES,
  CHAIN_ROLES,
  PROJECT_TYPES,
  PROJECT_STATUSES,
  PROJECT_TRANSITIONS,
  PROJECT_ARCHIVED_STATUSES,
  HEALTHS,
  GATE_STATUSES,
  GATE_CONCLUSIONS,
  GATE_PASSED_STATUSES,
  MILESTONE_STATUSES,
  MILESTONE_OVERRIDES,
  TASK_STATUSES,
  BOARD_COLUMNS,
  WBS_NODE_TYPES,
  WBS_NODE_TYPE_LABEL,
  LEGACY_TASK_STATUS_MAP,
  DEFAULT_WBS_RULES,
  GRANULARITY_LIMIT,
  WEEK_ACTUAL_DAYS_MAX,
  EFFORT_DAYS_CUM_MAX,
  DEFAULT_WIP_LIMIT,
  REVIEW_TYPES,
  REVIEW_MODES,
  REVIEW_STATUSES,
  REVIEW_STEP_STATUSES,
  REVIEW_TEMPLATES,
  CHANGE_TYPES,
  CHANGE_ROUTES,
  CHANGE_STATUSES,
  CCB_EFFORT_THRESHOLD,
  CLASSIFY_AMOUNT_THRESHOLD,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  USER_STATUSES,
};
