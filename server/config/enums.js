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
// 注意：角色目录与视野(scope)的单一来源是 DB `roles` 表（+ server/config/roles-catalog.js 出生种子），
// 运行时一律读表（server/services/roleCatalog.js），此处不再写死角色清单。

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

/**
 * 看板列（B11：补「阻塞」列，共 5 列，与前端 web/src/types/wbs.ts BOARD_COLUMNS 逐字一致）
 *
 * 顺序口径（决策 D-B11-3）：`待办 → 进行中 → 阻塞 → 待评审 → 完成`
 *   —— 「阻塞」是「进行中的异常分支」，紧邻「进行中」；「完成」恒为最右终点。
 *
 * ⚠ 本常量是**看板列的定义源**，但运行时单一数据源是 `board_configs.columns`
 *   （懒创建时的枚举快照）。`board.service.js#ensureBoardConfig` 会做「读时自愈」，
 *   发现 DB 快照与本数组不一致即就地改写，故未来增删列只需改这里 + 前端镜像。
 */
const BOARD_COLUMNS = ['待办', '进行中', '阻塞', '待评审', '完成'];

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

/** 粒度上限（人日）：三类一致，叶子任务 >5 人日告警（非阻塞，仅建议拆分） */
const GRANULARITY_LIMIT = { A: 5, B: 5, C: 5 };

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

/* D08：pm_only 变更路由 → PM 单人审批（single） */
const REVIEW_TYPES = ['formal', 'technical', 'code', 'ccb', 'pm_only', 'project'];

const REVIEW_MODES = ['serial', 'parallel_veto', 'single'];

const REVIEW_STATUSES = ['草稿', '审批中', '已通过', '已驳回', '已撤回'];

const REVIEW_STEP_STATUSES = ['pending', 'current', 'approved', 'rejected', 'skipped'];

/* ── 风险登记册 ────────────────────────────────────── */

/** 风险类别（前端同名字段取值必须逐字一致） */
const RISK_CATEGORIES = ['进度', '成本', '质量', '技术', '资源', '外部依赖', '范围', '其他'];

/** 风险状态（前端同名字段取值必须逐字一致） */
const RISK_STATUSES = ['待评估', '监控中', '应对中', '已发生', '已关闭'];

/** 概率 / 影响取值域（1~5），风险值 = 概率 × 影响 */
const RISK_LEVELS = [1, 2, 3, 4, 5];

/** 高风险阈值：riskValue >= 12 */
const RISK_HIGH_THRESHOLD = 12;

// 审批链角色兜底顺序不再写死：运行时由 server/services/roleCatalog.js 按 roles 表
// scope=global 的启用角色动态生成（globalFallbacks）。

/** 评审模板（服务端为准，GET /api/meta 直接下发给前端） */
const REVIEW_TEMPLATES = {
  formal: {
    key: 'formal',
    label: '正式评审',
    mode: 'parallel_veto',
    chain: ['pmo', 'tl', 'management'],
    description: '立项/需求/设计/验收 → 管理层 + PMO + TL，一票否决',
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
    chain: ['pm', 'tl', 'po'],
    description: '基线变更 → PM → TL → PO 串行逐级',
  },
  pm_only: {
    key: 'pm_only',
    label: 'PM 审批',
    mode: 'single',
    chain: ['pm'],
    description: '非基线小变更 → PM 单人决议并留痕',
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
  RISK_CATEGORIES,
  RISK_STATUSES,
  RISK_LEVELS,
  RISK_HIGH_THRESHOLD,
  CHANGE_TYPES,
  CHANGE_ROUTES,
  CHANGE_STATUSES,
  CCB_EFFORT_THRESHOLD,
  CLASSIFY_AMOUNT_THRESHOLD,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  USER_STATUSES,
};
