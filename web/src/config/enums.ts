/**
 * 全部状态枚举与中文文案（文案集中，未来接 i18n 成本可控 · 架构 O3）
 */
import type {
  GlobalRole,
  ProjectRole,
  ProjectStatus,
  ProjectType,
  GateStatus,
  MilestoneStatus,
  MilestoneOverride,
  Health,
} from '@/types/project';
import type { TaskStatus, WbsNodeType, WbsRules } from '@/types/wbs';
import type { ReviewType, ReviewMode, ReviewStatus, ReviewStepStatus } from '@/types/review';
import type { ChangeType, ChangeRoute, ChangeStatus } from '@/types/change';
import type { AuditAction, AuditEntityType } from '@/types/audit';

/* ── 角色 ─────────────────────────────────────────── */

export const GLOBAL_ROLE_LABEL: Record<GlobalRole, string> = {
  admin: '管理员',
  management: '管理层',
  pmo: 'PMO',
  pm: '项目经理',
  tl: '技术负责人',
  qa: '质量负责人',
  cm: '配置管理员',
  po: '产品负责人',
  member: '普通成员',
};

export const GLOBAL_ROLES: GlobalRole[] = [
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

export const PROJECT_ROLE_LABEL: Record<ProjectRole, string> = {
  pm: '项目经理 PM',
  tl: '技术负责人 TL',
  po: '产品负责人 PO',
  qa: '质量负责人 QA',
  cm: '配置管理员 CM',
  pmo: 'PMO',
  member: '成员',
};

export const PROJECT_ROLES: ProjectRole[] = ['pm', 'tl', 'po', 'qa', 'cm', 'pmo', 'member'];

/** 评审链里出现的角色（含虚拟的客户代表） */
export const CHAIN_ROLE_LABEL: Record<string, string> = {
  ...PROJECT_ROLE_LABEL,
  management: '管理层',
  customer_rep: '客户代表',
};

/* ── 项目 ─────────────────────────────────────────── */

export const PROJECT_TYPE_LABEL: Record<ProjectType, string> = {
  A: 'A 类（交付型）',
  B: 'B 类（产品型）',
  C: 'C 类（基建型）',
};

export const PROJECT_TYPE_SHORT: Record<ProjectType, string> = {
  A: 'A类',
  B: 'B类',
  C: 'C类',
};

export const PROJECT_TYPES: ProjectType[] = ['A', 'B', 'C'];

export const PROJECT_STATUSES: ProjectStatus[] = [
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
export const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  草稿: ['审批中'],
  审批中: ['已批准', '已驳回'],
  已驳回: ['草稿'],
  已批准: ['进行中', '已终止'],
  进行中: ['挂起', '已结项', '已终止'],
  挂起: ['进行中', '已终止'],
  已结项: [],
  已终止: [],
};

export const HEALTH_LABEL: Record<Health, string> = {
  green: '正常',
  yellow: '有风险',
  red: '逾期/高风险',
};

export const HEALTH_HINT: Record<Health, string> = {
  green: '里程碑与质量门均正常',
  yellow: '里程碑临期或质量门待检',
  red: '存在逾期里程碑或高风险',
};

/* ── 质量门 / 里程碑 ────────────────────────────────── */

export const GATE_STATUSES: GateStatus[] = ['未开始', '待检查', '已通过', '有条件通过', '不通过'];

/** 门控结论可选项（提交结论时用） */
export const GATE_CONCLUSIONS: GateStatus[] = ['已通过', '有条件通过', '不通过'];

/** 已「过门」的两种终态（概览页「已过 N/M 道门」口径） */
export const GATE_PASSED_STATUSES: GateStatus[] = ['已通过', '有条件通过'];

/** 门状态图标（概览页质量门进度条） */
export const GATE_ICON: Record<GateStatus, string> = {
  已通过: '✔',
  有条件通过: '✔',
  待检查: '◉',
  不通过: '✖',
  未开始: '○',
};

export const MILESTONE_STATUSES: MilestoneStatus[] = ['未开始', '进行中', '已达成', '已逾期'];

/**
 * 里程碑状态人工覆盖的可选值（🔒 U-5 / SK-7b）。
 * **恒不含「已达成」** —— 达成只能通过质量门决议或 `achieved=true` 写入 `doneAt`。
 */
export const MILESTONE_OVERRIDES: MilestoneOverride[] = ['未开始', '进行中', '已逾期'];

/** 里程碑状态配色（MUI Chip color） */
export const MILESTONE_STATUS_COLOR: Record<MilestoneStatus, 'default' | 'info' | 'success' | 'error'> = {
  未开始: 'default',
  进行中: 'info',
  已达成: 'success',
  已逾期: 'error',
};

/* ── WBS / 看板 ───────────────────────────────────── */

export const TASK_STATUSES: TaskStatus[] = ['待办', '进行中', '待评审', '完成', '阻塞'];

/**
 * WBS 节点类型文案（简化方案一：只剩 2 类，靠层级区分容器与叶子）
 * - 「任务」既可当容器又可自己干活；「子任务」恒为最底层
 */
export const WBS_NODE_TYPE_LABEL: Record<WbsNodeType, string> = {
  task: '任务',
  subtask: '子任务',
};

export const WBS_NODE_TYPES: WbsNodeType[] = ['task', 'subtask'];

/**
 * WBS 层级规则缺省值（决策 D-2 / SK-5：三类项目一致，模板只覆盖差异项）
 * - 任何业务代码都应通过 `resolveWbsRules(template)` 取值，不要直接读本常量做判断
 */
export const DEFAULT_WBS_RULES: WbsRules = {
  maxDepth: 4,
  skeleton: 'per-milestone',
  childTypes: {
    root: ['task'],
    task: ['task', 'subtask'],
    subtask: [],
  },
};

/** 粒度上限（人日）：A 类 >5 告警，B 类 >2 告警，C 类沿用 A */
export const GRANULARITY_LIMIT: Record<ProjectType, number> = { A: 5, B: 2, C: 5 };

/** 本周实际工时登记上限（人日/次）：B8 R5，工作日志单行 actualDays 上限，与后端 server/config/enums.js 一致 */
export const WEEK_ACTUAL_DAYS_MAX = 100;

/** 累计实际工时上限（人日）：B8 R3/R5，节点 effortHours 累计值上限（防溢出 + 防负数），与后端一致 */
export const EFFORT_DAYS_CUM_MAX = 10000;

/** WIP 默认上限（架构 O8：进行中 ≤ 5，0 = 不限） */
export const DEFAULT_WIP_LIMIT = 5;

/* ── 评审 ─────────────────────────────────────────── */

export const REVIEW_TYPE_LABEL: Record<ReviewType, string> = {
  formal: '正式评审',
  technical: '技术评审',
  code: '代码评审',
  ccb: 'CCB 变更评审',
  project: '立项审批',
};

export const REVIEW_MODE_LABEL: Record<ReviewMode, string> = {
  serial: '串行逐级',
  parallel_veto: '并行一票否决',
  single: '单人决议',
};

export const REVIEW_STATUSES: ReviewStatus[] = ['草稿', '审批中', '已通过', '已驳回', '已撤回'];

export const REVIEW_STEP_STATUS_LABEL: Record<ReviewStepStatus, string> = {
  pending: '待审',
  current: '待审',
  approved: '通过',
  rejected: '否决',
  skipped: '已跳过',
};

/** 评审模板（前端镜像；服务端 REVIEW_TEMPLATES 为准） */
export const REVIEW_TEMPLATES: Record<
  ReviewType,
  { key: ReviewType; label: string; mode: ReviewMode; chain: string[]; description: string }
> = {
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

export const CHANGE_TYPE_LABEL: Record<ChangeType, string> = {
  milestone_date: '里程碑日期',
  requirement_baseline: '需求基线',
  scope: '范围变更',
  other: '其他',
};

export const CHANGE_ROUTE_LABEL: Record<ChangeRoute, string> = {
  pm_only: '仅 PM 审批',
  ccb: 'CCB 审批',
};

export const CHANGE_STATUSES: ChangeStatus[] = ['草稿', '审批中', '已批准', '已驳回', '已实施'];

/** 变更路由判定阈值：≥3 人日走 CCB */
export const CCB_EFFORT_THRESHOLD = 3;

/** 项目分类金额参考阈值（万元）：无本质特征且 ≥ 该值时建议 A 类 */
export const CLASSIFY_AMOUNT_THRESHOLD = 100;

/* ── 审计 ─────────────────────────────────────────── */

export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  create: '创建',
  update: '修改',
  delete: '删除',
  status_change: '状态流转',
  decide: '门控决议',
  approve: '审批通过',
  reject: '审批否决',
  apply: '变更应用',
};

export const AUDIT_ENTITY_LABEL: Record<AuditEntityType, string> = {
  project: '项目',
  gate: '质量门',
  gate_item: '门检查项',
  milestone: '里程碑',
  wbs_node: 'WBS 节点',
  report: '工作日志',
  review: '评审',
  change: '变更',
  user: '用户',
};

/* ── 周报 ─────────────────────────────────────────── */

export const REPORT_SECTION_TITLE = {
  done: '① 本周完成（对照计划）',
  plan: '② 下周计划',
  risks: '③ 风险与问题（每条必须有责任人和截止日）',
  resource: '④ 需要协调的资源',
  /** R3-6：任务关联区固定标题（新建 / 编辑共用） */
  taskAssoc: '任务关联（勾选本日志涉及的任务，可同步更新进度）',
} as const;
