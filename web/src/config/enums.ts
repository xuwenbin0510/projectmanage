/**
 * 全部状态枚举与中文文案（文案集中，未来接 i18n 成本可控 · 架构 O3）
 */
import type {
  GlobalRole,
  ProjectRole,
  RoleKey,
  ProjectStatus,
  ProjectType,
  GateStatus,
  MilestoneStatus,
  MilestoneOverride,
  Health,
} from '@/types/project';
import type { TaskStatus, WbsNodeType, WbsRules, Priority } from '@/types/wbs';
import type { ReviewType, ReviewMode, ReviewStatus, ReviewStepStatus } from '@/types/review';
import type { ChangeType, ChangeRoute, ChangeStatus } from '@/types/change';
import type { AuditAction, AuditEntityType } from '@/types/audit';
import type { ReportStatus } from '@/types/report';
import type { TodoType } from '@/types/todo';

/* ── 角色 ─────────────────────────────────────────── */

import { ROLE_CATALOG, allRoleKeys, projectRoleKeys } from './roles-catalog';

/** 全部启用角色 key（按 order_no）。运行时单一真相源为后端 roles 表；此处仅前端/mock 用。 */
export const ALL_ROLES: RoleKey[] = allRoleKeys() as RoleKey[];

/** 项目视角启用角色 key（可作为项目成员角色）。 */
export const PROJECT_ROLES: RoleKey[] = projectRoleKeys() as RoleKey[];

export const GLOBAL_ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  cpo: '产品总监',
  cto: '技术总监',
  management: '管理层',
  pmo: 'PMO',
  cm: '配置管理员',
  dev: '研发工程师',
  member: '普通成员',
  ops: '运维工程师',
  pm: '项目经理',
  po: '产品负责人',
  qa: '质量负责人',
  sale: '商务',
  tl: '技术负责人',
  ued: '体验设计师',
};

export const GLOBAL_ROLE_LABEL_MAP = GLOBAL_ROLE_LABEL;

export const PROJECT_ROLE_LABEL: Record<string, string> = {
  pm: '项目经理 PM',
  tl: '技术负责人 TL',
  po: '产品负责人 PO',
  qa: '质量负责人 QA',
  cm: '配置管理员 CM',
  pmo: 'PMO',
  member: '成员',
  cpo: '产品总监',
  cto: '技术总监',
  dev: '研发工程师',
  ops: '运维工程师',
  sale: '商务',
  ued: '体验设计师',
};

/** 评审链里出现的角色（含虚拟的客户代表，仅内部系统历史模板保留，无实际外部用户） */
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

/* ── 任务优先级 B14-块1 ──────────────────────────── */

/**
 * 优先级下拉选项（**单一真源** · SK-B14-1）
 *
 * 色标口径：P0 红 / P1 橙 / P2 蓝 / P3 灰；`color` 取 MUI Chip 语义色，
 * 图表侧不得直接用本字段（图表层必须走 `useChartPalette()` 拿真 hex）。
 */
export const PRIORITY_OPTIONS: ReadonlyArray<{
  value: Priority;
  label: string;
  hint: string;
  color: 'error' | 'warning' | 'info' | 'default';
}> = [
  { value: 'P0', label: 'P0 最高', hint: '阻塞交付，必须立即处理', color: 'error' },
  { value: 'P1', label: 'P1 高', hint: '本周内必须完成', color: 'warning' },
  { value: 'P2', label: 'P2 中', hint: '常规排期（缺省）', color: 'info' },
  { value: 'P3', label: 'P3 低', hint: '有余力再做，可延后', color: 'default' },
];

/** 优先级取值列表（校验 / 遍历用；顺序 = 由高到低） */
export const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];

/** 优先级缺省值（与后端迁移 `DEFAULT 'P2'` 逐字一致 · 决策 #1） */
export const DEFAULT_PRIORITY: Priority = 'P2';

/**
 * 排序权重：**升序**排列即「P0 置顶」。
 * ⚠️ 一切按优先级排序都必须 `PRIORITY_RANK[a] - PRIORITY_RANK[b]`，禁止字符串比较。
 */
export const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** 短标签（表格 / Chip 内用，省空间） */
export const PRIORITY_SHORT: Record<Priority, string> = { P0: 'P0', P1: 'P1', P2: 'P2', P3: 'P3' };

/** Chip 语义色（按值直取，避免遍历 `PRIORITY_OPTIONS`） */
export const PRIORITY_COLOR: Record<Priority, 'error' | 'warning' | 'info' | 'default'> = {
  P0: 'error',
  P1: 'warning',
  P2: 'info',
  P3: 'default',
};

/**
 * 把任意值收敛为合法 `Priority`（读到脏数据 / 旧数据时兜底 `P2`）。
 * 前端只做展示兜底，**合法性最终由后端 `normalizePriority` 保证**。
 */
export function normalizePriority(raw: unknown): Priority {
  const v = String(raw ?? '').trim().toUpperCase();
  return (PRIORITIES as string[]).includes(v) ? (v as Priority) : DEFAULT_PRIORITY;
}

/** 取排序权重（脏值兜底为 P2 的权重） */
export function priorityRankOf(raw: unknown): number {
  return PRIORITY_RANK[normalizePriority(raw)];
}

/* ── 评审 ─────────────────────────────────────────── */

export const REVIEW_TYPE_LABEL: Record<ReviewType, string> = {
  formal: '正式评审',
  technical: '技术评审',
  code: '代码评审',
  ccb: 'CCB 变更评审',
  pm_only: 'PM 审批',
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

/* ── 风险登记册（前端镜像；服务端 enums.js 取值逐字一致） ── */

export type RiskCategory = '进度' | '成本' | '质量' | '技术' | '资源' | '外部依赖' | '范围' | '其他';
export type RiskStatus = '待评估' | '监控中' | '应对中' | '已发生' | '已关闭';

export const RISK_CATEGORIES: RiskCategory[] = ['进度', '成本', '质量', '技术', '资源', '外部依赖', '范围', '其他'];
export const RISK_STATUSES: RiskStatus[] = ['待评估', '监控中', '应对中', '已发生', '已关闭'];

/** 概率 / 影响取值域 1~5，风险值 = 概率 × 影响 */
export const RISK_LEVELS: number[] = [1, 2, 3, 4, 5];

/** 高风险阈值：riskValue >= 12 */
export const RISK_HIGH_THRESHOLD = 12;

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
  baseline: '建立基线',
  baseline_change: '基线变更',
  'reset-password': '重置密码',
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
  document: '文档',
  review_template: '审批模板',
  template: '生命周期模板',
  risk: '风险',
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

/* ── 周报状态机 B14-块2 ──────────────────────────── */

/** 周报状态取值（状态机：`草稿 → 已提交 → 已确认`，打回进入独立 `已打回` 态） */
export const REPORT_STATUSES: ReportStatus[] = ['草稿', '已提交', '已确认', '已打回'];

/** 周报状态 Chip 配色 */
export const REPORT_STATUS_COLOR: Record<
  ReportStatus,
  'default' | 'info' | 'success' | 'warning' | 'error' | 'primary' | 'secondary'
> = {
  草稿: 'default',
  已提交: 'info',
  已确认: 'success',
  已打回: 'warning',
};

/** 周报状态提示语（列表/详情 Tooltip） */
export const REPORT_STATUS_HINT: Record<ReportStatus, string> = {
  草稿: '尚未提交，作者可继续编辑或删除；若曾被打回会显示打回原因',
  已提交: '等待上级确认；确认人可「确认」或「打回」',
  已确认: '已被上级确认，流程闭环',
  已打回: '已被打回，作者可修改后重新提交（仅可改、不可删）',
};

/** 打回原因长度上限（与后端校验一致） */
export const REJECT_REASON_MAX = 500;

/* ── 统一待办中心 B14-块3 ────────────────────────── */

/** 待办分组展示顺序（审批 / 待确认最紧急 → 任务类） */
export const TODO_TYPE_ORDER: TodoType[] = [
  'APPROVAL',
  'REPORT_CONFIRM',
  'REPORT_FILL',
  'OVERDUE',
  'BLOCKED',
  'ASSIGNED',
];

export const TODO_TYPE_LABEL: Record<TodoType, string> = {
  APPROVAL: '待我审批',
  REPORT_CONFIRM: '待我确认周报',
  REPORT_FILL: '待我填写周报',
  OVERDUE: '我的逾期任务',
  BLOCKED: '我的阻塞任务',
  ASSIGNED: '分配给我的任务',
};

/** 分组标题色（MUI 语义色，逾期/阻塞用告警色） */
export const TODO_TYPE_COLOR: Record<TodoType, 'error' | 'warning' | 'info' | 'primary'> = {
  APPROVAL: 'primary',
  REPORT_CONFIRM: 'primary',
  REPORT_FILL: 'info',
  OVERDUE: 'error',
  BLOCKED: 'warning',
  ASSIGNED: 'info',
};

/** 「任务类」待办（这几类才有 `priority`，组内按 `priorityRank` 升序排） */
export const TODO_TASK_TYPES: TodoType[] = ['OVERDUE', 'BLOCKED', 'ASSIGNED'];

/** 铃铛下拉每组最多展示条数（超出显「还有 N 条」） */
export const TODO_GROUP_MAX = 5;
