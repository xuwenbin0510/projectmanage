import type { Paged } from '@/types/api';
import type {
  User,
  GlobalRole,
  Project,
  ProjectListItem,
  ProjectMember,
  ProjectRole,
  ProjectType,
  ProjectStatus,
  ClassifyInput,
  ClassifyResult,
  LifecycleTemplate,
  StageWithGate,
  Milestone,
  MilestoneDraft,
  CloseBlocker,
} from '@/types/project';
import type { WbsNode, WbsNodeType, TaskStatus, BoardConfig, BoardView } from '@/types/wbs';
import type { Report } from '@/types/report';
import type { Review, ReviewType, ReviewRefType } from '@/types/review';
import type { Change, ChangeType, RouteResult } from '@/types/change';
import type { AuditLog, Risk, ProjectDocument } from '@/types/audit';
import type { WorkbenchData, Session } from '@/types/workbench';

/* ── 请求参数类型 ─────────────────────────────────── */

export interface ProjectQuery {
  keyword?: string;
  type?: ProjectType | '';
  status?: ProjectStatus | '';
  health?: string;
  pm?: string;
  onlyMine?: boolean;
  page?: number;
  pageSize?: number;
}

export interface CreateProjectPayload {
  name: string;
  type: ProjectType;
  customer: string;
  contractAmount: number;
  background: string;
  goal: string[];
  planStart: string;
  planEnd: string;
  pm: string;
  classifyInput: ClassifyInput;
  classifySuggested: ProjectType;
  classifyOverrideReason: string;
  members: Array<{ userOpenId: string; role: ProjectRole }>;
  /**
   * 里程碑（三态语义，任何中间层禁止把 `[]` 归一成 undefined / null）：
   * - `undefined` → 按生命周期模板生成（既有调用方行为不变）
   * - `[]`        → 显式清空，不生成任何里程碑
   * - 非空数组    → 完全覆盖模板
   */
  milestones?: MilestoneDraft[];
}

export interface UpdateProjectPayload {
  name?: string;
  customer?: string;
  contractAmount?: number;
  background?: string;
  goal?: string[];
  planStart?: string;
  planEnd?: string;
  health?: string;
}

export interface GateDecisionPayload {
  gateId: string;
  conclusion: '已通过' | '有条件通过' | '不通过';
  comment: string;
}

export interface MilestoneUpdatePayload {
  currentDate?: string;
  done?: boolean;
  name?: string;
  /** 目标 / 达成标准（里程碑页可编辑，不触发单向日期约束） */
  target?: string;
}

export interface WbsNodePayload {
  parentId: string | null;
  nodeType: WbsNodeType;
  name: string;
  description?: string;
  owner?: string;
  estimateDays?: number;
  startDate?: string;
  dueDate?: string;
  status?: TaskStatus;
  progress?: number;
}

export interface ReportPayload {
  projectId: string;
  week: string;
  doneNote: string;
  planItems: string[];
  resourceNote: string;
  tasks: Array<{ nodeId: string; progressAfter: number; selected: boolean }>;
  risks: Array<{ description: string; owner: string; dueDate: string }>;
}

export interface CreateReviewPayload {
  projectId: string;
  refType: ReviewRefType;
  refId: string;
  reviewType: ReviewType;
  title: string;
  /** 可选：覆盖模板默认审批人 */
  assignees?: string[];
}

export interface DecisionPayload {
  comment: string;
  evidenceUrl?: string;
}

export interface ChangePayloadInput {
  projectId: string;
  changeType: ChangeType;
  title: string;
  content: string;
  impactAnalysis: string;
  effortDays: number;
  targetType: 'milestone' | 'requirement' | 'scope' | '';
  targetId: string;
  payload?: Record<string, unknown>;
}

export interface AuditQuery {
  projectId?: string;
  entityType?: string;
  action?: string;
  actor?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface MetaData {
  templates: LifecycleTemplate[];
  reviewTemplates: Array<{ key: string; label: string; mode: string; chain: string[] }>;
  wipDefault: number;
}

/* ── 客户端接口（Mock / HTTP 双实现共用） ───────────── */

/**
 * 前端 API 契约 —— Mock 与 HTTP 两套实现签名完全一致，
 * 页面代码通过 `VITE_USE_MOCK` 零改动切换。
 */
export interface ApiClient {
  /* 认证 P0-11 */
  devLogin(openId: string): Promise<Session>;
  feishuLogin(code: string): Promise<Session>;
  me(): Promise<User>;
  logout(): Promise<void>;

  /* 元数据 */
  getMeta(): Promise<MetaData>;
  /** 按项目分类取当前生效的生命周期模板（向导里程碑预填用）；模板缺失返回 null，不抛 404 */
  getLifecycleTemplate(type: ProjectType): Promise<LifecycleTemplate | null>;

  /* 项目 P0-01 ~ P0-04 P0-17 */
  classify(input: ClassifyInput): Promise<ClassifyResult>;
  listProjects(query: ProjectQuery): Promise<Paged<ProjectListItem>>;
  getProject(id: string): Promise<Project>;
  createProject(payload: CreateProjectPayload): Promise<Project>;
  updateProject(id: string, payload: UpdateProjectPayload): Promise<Project>;
  transitionProject(id: string, to: ProjectStatus, comment: string): Promise<Project>;
  checkClose(id: string): Promise<CloseBlocker[]>;

  /* 成员 */
  listMembers(projectId: string): Promise<ProjectMember[]>;
  addMember(projectId: string, userOpenId: string, role: ProjectRole): Promise<ProjectMember>;
  removeMember(projectId: string, memberId: string): Promise<void>;

  /* 阶段 / 质量门 P0-05 P0-06 */
  listStages(projectId: string): Promise<StageWithGate[]>;
  toggleGateItem(itemId: string, checked: boolean): Promise<StageWithGate[]>;
  decideGate(projectId: string, payload: GateDecisionPayload): Promise<StageWithGate[]>;

  /* 里程碑 P0-07 */
  listMilestones(projectId: string): Promise<Milestone[]>;
  updateMilestone(id: string, payload: MilestoneUpdatePayload): Promise<Milestone>;

  /* WBS P0-11 */
  listWbs(projectId: string): Promise<WbsNode[]>;
  createWbsNode(projectId: string, payload: WbsNodePayload): Promise<WbsNode>;
  updateWbsNode(id: string, payload: Partial<WbsNodePayload>): Promise<WbsNode>;
  deleteWbsNode(id: string): Promise<void>;
  moveWbsNode(id: string, newParentId: string | null, index: number): Promise<WbsNode[]>;

  /* 看板 P0-12 */
  getBoard(projectId: string): Promise<BoardView>;
  moveTask(nodeId: string, status: TaskStatus, order: number): Promise<BoardView>;
  updateBoardConfig(projectId: string, wipLimits: Record<string, number>): Promise<BoardConfig>;

  /* 周报 P0-08 */
  listReports(projectId: string): Promise<Report[]>;
  getReport(projectId: string, week: string): Promise<Report | null>;
  saveReport(payload: ReportPayload): Promise<Report>;
  submitReport(payload: ReportPayload): Promise<Report>;

  /* 评审 P0-09 P0-10 */
  listReviews(projectId?: string): Promise<Review[]>;
  listMyApprovals(): Promise<Review[]>;
  getReview(id: string): Promise<Review>;
  createReview(payload: CreateReviewPayload): Promise<Review>;
  approveReview(id: string, payload: DecisionPayload): Promise<Review>;
  rejectReview(id: string, payload: DecisionPayload): Promise<Review>;
  withdrawReview(id: string, payload: DecisionPayload): Promise<Review>;

  /* 变更 P0-14 P0-15 */
  routeChange(input: Pick<ChangePayloadInput, 'changeType' | 'effortDays' | 'targetType'>): Promise<RouteResult>;
  listChanges(projectId: string): Promise<Change[]>;
  getChange(id: string): Promise<Change>;
  createChange(payload: ChangePayloadInput): Promise<Change>;
  submitChange(id: string): Promise<Change>;
  applyChange(id: string): Promise<Change>;

  /* 审计 P0-16 */
  listAudit(query: AuditQuery): Promise<Paged<AuditLog>>;

  /* 工作台 P0-13 */
  getWorkbench(): Promise<WorkbenchData>;

  /* 管理后台 */
  listUsers(): Promise<User[]>;
  updateUserRole(openId: string, role: GlobalRole): Promise<User>;
  listTemplates(): Promise<LifecycleTemplate[]>;
  resetDemoData(): Promise<void>;

  /* P1 占位 */
  listRisks(projectId: string): Promise<Risk[]>;
  listDocuments(projectId: string): Promise<ProjectDocument[]>;
}
