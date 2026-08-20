/** 用户 / 项目 / 成员 / 生命周期模板 / 质量门 / 里程碑（简化方案一 · 无阶段实体） */

import type { WbsRules } from '@/types/wbs';

export type GlobalRole =
  | 'admin'
  | 'management'
  | 'pmo'
  | 'pm'
  | 'tl'
  | 'qa'
  | 'cm'
  | 'po'
  | 'member';

export type ProjectRole = 'pm' | 'tl' | 'po' | 'qa' | 'cm' | 'pmo' | 'member';

export type ProjectType = 'A' | 'B' | 'C';

export type ProjectStatus =
  | '草稿'
  | '审批中'
  | '已批准'
  | '进行中'
  | '挂起'
  | '已结项'
  | '已终止'
  | '已驳回';

export type Health = 'green' | 'yellow' | 'red';

export type GateStatus = '未开始' | '待检查' | '已通过' | '有条件通过' | '不通过';

export type MilestoneStatus = '未开始' | '进行中' | '已达成' | '已逾期';

/**
 * 里程碑状态的「人工覆盖」值域（🔒 U-5 / SK-7b 定案）。
 *
 * **恒不含「已达成」** —— 达成有且只有一条写入路径 `doneAt`：
 * - 有门的碑：门决议为「已通过 / 有条件通过」时引擎自动写入，或 `achieved=true` 但受 C-G4 拦截；
 * - 无门的自建碑：`achieved=true` 直接写入。
 *
 * 把「已达成」放进 override 等于给「绕过门控达成」开后门，与制度 §1.2.3 / §7.1 冲突。
 * 这里在**类型层**收口，不是只在 UI 下拉里少放一个选项。
 */
export type MilestoneOverride = '未开始' | '进行中' | '已逾期';

export interface User {
  id: number;
  openId: string;
  employeeId: string;
  name: string;
  email: string;
  dept: string;
  avatarUrl: string;
  globalRole: GlobalRole;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

/** 分类判定输入（P0-01） */
export interface ClassifyInput {
  contractAmount: number;
  hasHardware: boolean;
  hasAcceptance: boolean;
  isSelfIteration: boolean;
  isInfrastructure: boolean;
}

/** 分类判定结果 */
export interface ClassifyResult {
  suggested: ProjectType;
  reasons: string[];
}

export interface Project {
  id: string;
  code: string;
  name: string;
  type: ProjectType;
  classifyInput: ClassifyInput;
  classifySuggested: ProjectType;
  classifyOverrideReason: string;
  customer: string;
  contractAmount: number;
  background: string;
  goal: string[];
  status: ProjectStatus;
  health: Health;
  planStart: string;
  planEnd: string;
  actualEnd: string | null;
  approvalStep: number;
  templateId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 项目列表行（附带聚合展示字段）
 * 「项目走到第几步」由「下一里程碑 + 已过 N/M 道门」表达（§3.2 / N-5）
 */
export interface ProjectListItem extends Project {
  pmName: string;
  /** 下一个未达成里程碑（按 currentDate 升序首个 !done）的编码 / 名称；无则为 '' */
  nextMilestoneCode: string;
  nextMilestoneName: string;
  /** 下一个未达成里程碑所挂的门；无门为 '' / '未开始' */
  currentGateCode: string;
  currentGateStatus: GateStatus;
  /** 已通过（含有条件通过）的门数 / 门总数 */
  gatePassed: number;
  gateTotal: number;
  progress: number;
  milestoneDone: number;
  milestoneTotal: number;
  nextMilestoneDate: string | null;
  highRiskCount: number;
  /** 第三批：近 30 天到期里程碑（仅 dashboard 明细行注入，其他列表页可能为 undefined） */
  milestoneDue?: { total: number; overdue: number; upcoming: number };
}

export interface ProjectMember {
  id: string;
  projectId: string;
  userOpenId: string;
  userName: string;
  projectRole: ProjectRole;
  assignedBy: string;
  assignedAt: string;
}

/** 模板内联的质量门检查项 */
export interface TemplateGateItem {
  content: string;
  ownerRole: string;
}

/** 模板内联的质量门（一碑最多一门 · C-G1） */
export interface TemplateGate {
  code: string;
  name: string;
  ownerRole: string;
  items: TemplateGateItem[];
}

/**
 * 模板里程碑骨架。
 * - `offsetDays`：相对 `project.planStart` 的天数偏移
 * - `required`：模板必备里程碑，实例化后锁删（仅可改期 · Q-2）
 * - `gate`：该碑挂载的质量门；缺省 = 无门（C-G2：必备碑恒配门，自建碑无门）
 */
export interface TemplateMilestone {
  code: string;
  name: string;
  offsetDays: number;
  required: boolean;
  gate?: TemplateGate;
}

/** 模板交付物清单项（D04：结构化，按里程碑挂载） */
export interface TemplateDocItem {
  /** 交付物名称（如「需求规格说明书」） */
  name: string;
  /** 所属模板里程碑 code（如 'M2'）；派生时按 code 匹配项目里程碑填充 milestone_id */
  milestoneCode: string;
}

export interface LifecycleTemplate {
  id: string;
  projectType: ProjectType;
  version: number;
  name: string;
  definition: {
    /** 里程碑骨架（唯一时间轴）；阶段实体已在方案一中彻底删除 */
    milestones: TemplateMilestone[];
    /** D04 起：交付物清单（结构化，关联里程碑） */
    docs: TemplateDocItem[];
    /** WBS 层级规则；只写差异项，其余由 `DEFAULT_WBS_RULES` 兜底（决策 D-2 / SK-5） */
    wbsRules?: Partial<WbsRules>;
  };
  isActive: boolean;
  createdAt: string;
}

export interface GateChecklistItem {
  id: string;
  gateId: string;
  seq: number;
  content: string;
  ownerRole: string;
  checked: boolean;
  checkedBy: string | null;
  checkedAt: string | null;
  source: 'template' | 'custom';
}

/**
 * 质量门（决策 D-A：独立表，外键由 `stageId` 改挂 `milestoneId`）
 * C-G1：同一 `projectId` 下 `milestoneId` 唯一（一碑最多一门）
 */
export interface QualityGate {
  id: string;
  projectId: string;
  /** 挂载的里程碑 id */
  milestoneId: string;
  code: string;
  name: string;
  ownerRole: string;
  status: GateStatus;
  conclusion: string;
  comment: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  code: string;
  name: string;
  /** 目标 / 达成标准（交付物）；模板生成时为 ''，允许空串但不为 null */
  target: string;
  /** 模板必备里程碑（Q-2）：锁删，仅可改期；用户自建碑为 false */
  required: boolean;
  /** 原始基线，永不修改 */
  baselineDate: string;
  /** 当前计划，仅提前可直接改，延后须走变更单 */
  currentDate: string;
  /** currentDate - baselineDate（天）；正数 = 延期，负数 = 提前 */
  delayDays: number;
  /**
   * ⚠️ SK-2 **派生值**，由 `refreshMilestoneStatuses()` 唯一写入。
   * 任何业务代码禁止直接赋值。
   */
  status: MilestoneStatus;
  /** ⚠️ SK-2 派生值：`done = (status === '已达成')` */
  done: boolean;
  /** 达成时间（真值来源之一）；null = 未达成 */
  doneAt: string | null;
  /** 达成操作人 openId */
  doneBy: string | null;
  /** 人工覆盖值（真值来源之二）；null = 未覆盖 */
  statusOverride: MilestoneOverride | null;
  overrideBy: string | null;
  overrideAt: string | null;
  /** 覆盖时的 `currentDate` 快照，用于「改期后覆盖自动失效」判定（SK-7） */
  overrideBaseDate: string | null;
  lastChangeId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 里程碑关联任务完成度（§2.5.3 · 口径 Y，SK-M4） */
export interface MilestoneTaskStats {
  /** 关联节点数 = 直接绑定该碑的节点 ∪ 其子树真叶子（按 id 去重） */
  total: number;
  /** 上述集合中 `progress >= 100` 的节点数 */
  done: number;
  /** 加权完成度 0~100：**仅对集合中的真叶子**按 estimateDays 加权，汇总节点权重为 0 */
  progress: number;
}

/**
 * 里程碑 + 门 + 关联任务统计 聚合视图
 * （取代原 `StageWithGate`，是里程碑页 / 概览页的唯一数据源）
 */
export interface MilestoneWithGate extends Milestone {
  /** SK-1：无门的碑恒为 `null`，不是空对象 */
  gate: QualityGate | null;
  /** 该门下的检查项（按 seq 升序）；无门时为空数组 */
  gateItems: GateChecklistItem[];
  taskStats: MilestoneTaskStats;
}

/** 结项阻塞项（P0-17） */
export interface CloseBlocker {
  kind: 'gate' | 'milestone' | 'change' | 'review';
  message: string;
}
