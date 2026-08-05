/** 用户 / 项目 / 成员 / 生命周期 / 阶段 / 质量门 / 里程碑（对齐架构 3.1 ER 图） */

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

export type StageStatus = '未开始' | '进行中' | '已完成';

export type GateStatus = '未开始' | '待检查' | '已通过' | '有条件通过' | '不通过';

export type MilestoneStatus = '未开始' | '进行中' | '已达成' | '已逾期';

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
  currentStageId: string | null;
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

/** 项目列表行（附带聚合展示字段） */
export interface ProjectListItem extends Project {
  pmName: string;
  currentStageName: string;
  currentGateCode: string;
  currentGateStatus: GateStatus;
  progress: number;
  milestoneDone: number;
  milestoneTotal: number;
  nextMilestoneDate: string | null;
  highRiskCount: number;
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

export interface LifecycleTemplate {
  id: string;
  projectType: ProjectType;
  version: number;
  name: string;
  definition: {
    stages: Array<{ code: string; name: string; gate: { code: string; name: string; ownerRole: string; items: Array<{ content: string; ownerRole: string }> } }>;
    milestones: Array<{ code: string; name: string; offsetDays: number }>;
    docs: string[];
  };
  isActive: boolean;
  createdAt: string;
}

export interface ProjectStage {
  id: string;
  projectId: string;
  seq: number;
  code: string;
  name: string;
  status: StageStatus;
  startedAt: string | null;
  finishedAt: string | null;
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

export interface QualityGate {
  id: string;
  projectId: string;
  stageId: string;
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

/** 阶段 + 门 聚合视图（概览页阶段条 / 门检查清单用） */
export interface StageWithGate extends ProjectStage {
  gate: QualityGate | null;
  /** 该门下的检查项（按 seq 升序）；无门时为空数组 */
  gateItems: GateChecklistItem[];
}

export interface Milestone {
  id: string;
  projectId: string;
  code: string;
  name: string;
  /** 目标 / 达成标准（交付物）；模板生成时为 ''，允许空串但不为 null */
  target: string;
  /** 原始基线，永不修改 */
  baselineDate: string;
  /** 当前计划，仅变更单可改 */
  currentDate: string;
  delayDays: number;
  status: MilestoneStatus;
  done: boolean;
  doneAt: string | null;
  lastChangeId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 创建向导中的里程碑草稿（未落库）
 * - `code`：M1/M2…，模板带来或前端补号 `M{max+1}`
 * - `date`：计划日期，`YYYY-MM-DD`（复用 DATE_FMT）
 */
export interface MilestoneDraft {
  code: string;
  name: string;
  target: string;
  date: string;
}

/** 结项阻塞项（P0-17） */
export interface CloseBlocker {
  kind: 'gate' | 'milestone' | 'change' | 'review';
  message: string;
}
