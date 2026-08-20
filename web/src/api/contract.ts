import type { Paged } from '@/types/api';
import type {
  User,
  CreateUserPayload,
  UpdateUserPayload,
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
  MilestoneWithGate,
  MilestoneOverride,
  CloseBlocker,
  ReviewTemplateConfig,
  CreateReviewTemplatePayload,
  UpdateReviewTemplatePayload,
  CreateTemplatePayload,
  UpdateTemplatePayload,
} from '@/types/project';
import type { WbsNode, WbsNodeType, TaskStatus, Priority, BoardConfig, BoardView } from '@/types/wbs';
import type { Report } from '@/types/report';
import type { EffortReport } from '@/types/effort';
import type { Review, ReviewType, ReviewRefType } from '@/types/review';
import type { Change, ChangeType, RouteResult } from '@/types/change';
import type { AuditLog, Risk, ProjectDocument, UploadDocumentPayload, CreateLinkDocumentPayload } from '@/types/audit';
import type { WorkbenchData, Session } from '@/types/workbench';
import type {
  DashboardDeliverableRow,
  DashboardDeliverablesQuery,
  DashboardGateRow,
  DashboardGatesQuery,
  DashboardOverview,
  DashboardOverviewQuery,
  DashboardTasksQuery,
  DashboardTaskRow,
} from '@/types/dashboard';

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
   * 新建项目时随项目一起提交的里程碑规格（取代静默生成）。
   * 为空时服务端回退到模板静默生成（向后兼容）。
   * 向导中由模板带出、用户可改名称 / 日期、可新增（非必备）。
   */
  milestones?: CreateMilestoneSpec[];
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

/** 新建里程碑入参（Q-2）：`code` 由服务端按 `M{max+1}` 生成，`required=false`，无门 */
export interface MilestoneCreatePayload {
  name: string;
  /** 目标 / 达成标准；缺省 '' */
  target?: string;
  /** 计划日期 `YYYY-MM-DD`，同时作为 baselineDate 与 currentDate */
  date: string;
}

/** 新建项目随项目提交的里程碑门规格（对应模板 gate 结构） */
export interface CreateMilestoneGateSpec {
  code: string;
  name: string;
  ownerRole: string;
  items: Array<{ content: string; ownerRole: string }>;
}

/**
 * 新建项目时提交的里程碑规格（取代静默生成 · 用户反馈①）。
 * 向导由模板带出，用户可改 `name` / `date`，可新增（默认 `required=false`）。
 * `gate` 为 null 表示无门；`required` 保留模板血缘语义（R3-1：字段保留、页面不展示「必备」UI）。
 */
export interface CreateMilestoneSpec {
  code: string;
  name: string;
  /** 目标 / 达成标准 */
  target?: string;
  /** 计划日期 `YYYY-MM-DD`（绝对日期，向导用 planStart + 模板偏移预填，用户可改） */
  date: string;
  /** 模板血缘语义（R3-1：字段保留、页面不展示「必备」UI） */
  required: boolean;
  /** 质量门规格；null = 该里程碑无门 */
  gate: CreateMilestoneGateSpec | null;
}

export interface MilestoneUpdatePayload {
  name?: string;
  /** 目标 / 达成标准（里程碑页可编辑，不触发单向日期约束） */
  target?: string;
  /** 提前可直接改；延后抛 `E_MS_NEED_CHANGE`。改期后清空 override 三元组（SK-7） */
  currentDate?: string;
  /**
   * 标记 / 取消达成（替代原 `done`，消除双轨命名歧义）。
   * `true` 时校验 C-G4：有门且门未过 → `E_GATE_NOT_PASSED`
   */
  achieved?: boolean;
  /**
   * 人工覆盖状态；`null` = 撤销覆盖。
   * ⚠️ SK-7b：类型层已排除「已达成」，不允许绕过门控达成。
   */
  statusOverride?: MilestoneOverride | null;
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
  /**
   * 任务优先级（B14-块1）。不传 = 服务端按 `P2` 落库；
   * 传非法值（不在 P0–P3 内）→ 后端 `E_VALIDATION`。
   */
  priority?: Priority;
  /** 关联里程碑（任务 / 子任务均可）；跨项目引用一律 E_VALIDATION */
  milestoneId?: string | null;
}

export interface ReportPayload {
  projectId: string;
  week: string;
  doneNote: string;
  planItems: string[];
  resourceNote: string;
  /** B8（R2）：tasks[].actualDays 为本周实际工时（人日）入参，仅勾选叶子行携带 */
  tasks: Array<{ nodeId: string; progressAfter: number; selected: boolean; actualDays?: number }>;
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
  /**
   * 取服务端下发的飞书 AppID（`GET /api/appid`，免鉴权）。
   * 供 JSSDK `requestAuthCode(appId)` 使用——**不得**用前端环境变量顶替。
   * 服务端未配置 FEISHU_APP_ID 时返回空串，调用方据此回落到开发登录。
   */
  getAppId(): Promise<string>;
  devLogin(openId: string): Promise<Session>;
  feishuLogin(code: string): Promise<Session>;
  /**
   * 浏览器飞书 Web OAuth 登录（普通浏览器，不经过 JSSDK）。
   * @prd P0-11 / B4-T03 对应 `POST /api/auth/feishu/web`；返回内联 `{token,user}`（与 `Session` 同构）。
   */
  loginByFeishuCode(code: string): Promise<{ token: string; user: User }>;
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

  /* 质量门 P0-05 P0-06（挂在里程碑上 · 决策 D-A） */
  toggleGateItem(itemId: string, checked: boolean): Promise<MilestoneWithGate[]>;
  decideGate(projectId: string, payload: GateDecisionPayload): Promise<MilestoneWithGate[]>;
  /** D05：检查项管理（milestone:edit；custom 可改删，template 只读） */
  addGateItem(gateId: string, payload: { content: string; ownerRole?: string }): Promise<MilestoneWithGate[]>;
  updateGateItem(itemId: string, payload: { content: string; ownerRole?: string }): Promise<MilestoneWithGate[]>;
  deleteGateItem(itemId: string): Promise<MilestoneWithGate[]>;

  /* 里程碑 P0-07（唯一时间轴：一次带出门 + 检查项 + 关联任务统计） */
  listMilestones(projectId: string): Promise<MilestoneWithGate[]>;
  createMilestone(projectId: string, payload: MilestoneCreatePayload): Promise<MilestoneWithGate>;
  updateMilestone(id: string, payload: MilestoneUpdatePayload): Promise<MilestoneWithGate>;
  /** 级联删门与检查项，关联 WBS 节点解绑（SK-12）；不再按「必备」锁删（R3-1） */
  deleteMilestone(id: string): Promise<void>;

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
  /** 编辑提交必须原样回传原始 report.tasks（selected/progressAfter 不变），引擎按 payload.tasks 整体重建，否则关联被清空（R3-7） */
  updateReport(id: string, payload: ReportPayload): Promise<Report>;

  /* 周报轻量闭环 B14-块2（草稿 → 已提交 → 已确认；确认人由服务端 resolveConfirmers 判定） */
  /** 确认周报：仅 status='已提交' 且当前用户在服务端确认人集合内才成功，成功后 status='已确认' */
  confirmReport(projectId: string, id: string): Promise<Report>;
  /** 打回周报：reason 必填，成功后 status 回退为 '草稿' 并写入 rejectReason */
  rejectReport(projectId: string, id: string, reason: string): Promise<Report>;
  /** 待我确认的周报（服务端按 resolveConfirmers 过滤，跨项目聚合，供统一待办中心消费） */
  listPendingConfirmation(): Promise<Report[]>;

  /* 工时统计报表 B9（只读聚合，与 WBS/看板同级可见性） */
  getEffortReport(projectId: string): Promise<EffortReport>;

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

  /* 全局总览 B12（多项目组合视图） */
  /**
   * 全局总览一次性聚合（`GET /api/dashboard/overview`）。
   *
   * ⚠ `scope` 只是**期望值**：无 `dashboard:global` 权限的角色即使传 `all`，
   *   服务端也会强制降级为 `mine`（不抛 403）。真实生效范围以返回值的
   *   `DashboardOverview.scope` 为准，前端据此回显开关状态。
   */
  getDashboardOverview(query: DashboardOverviewQuery): Promise<DashboardOverview>;

  /**
   * B18：分布图点档下钻任务明细（`GET /api/dashboard/tasks`）。
   * 与 overview 同 scope/过滤口径；维度参数三选一互斥（taskStatus → overdueBucket → priority）。
   */
  getDashboardTasks(query: DashboardTasksQuery): Promise<Paged<DashboardTaskRow>>;

  /** 第二批：质量门明细（`GET /api/dashboard/gates`），gateStatus 过滤 + 分页 */
  getDashboardGates(query: DashboardGatesQuery): Promise<Paged<DashboardGateRow>>;

  /** 第二批：交付物明细（`GET /api/dashboard/deliverables`），docStatus 过滤 + 分页 */
  getDashboardDeliverables(query: DashboardDeliverablesQuery): Promise<Paged<DashboardDeliverableRow>>;

  /* 管理后台 */
  listUsers(): Promise<User[]>;
  updateUserRole(openId: string, role: GlobalRole): Promise<User>;
  /** 阶段一：新增用户（仅 admin） */
  createUser(payload: CreateUserPayload): Promise<User>;
  /** 阶段一：通用更新（角色/状态/部门/姓名/工号/邮箱，仅 admin；只传需要更新的字段） */
  updateUser(openId: string, patch: UpdateUserPayload): Promise<User>;
  listTemplates(): Promise<LifecycleTemplate[]>;
  resetDemoData(): Promise<void>;

  /* 阶段三：生命周期模板管理（仅 admin） */
  createTemplate(payload: CreateTemplatePayload): Promise<LifecycleTemplate>;
  updateTemplate(id: string, patch: UpdateTemplatePayload): Promise<LifecycleTemplate>;
  toggleTemplateActive(id: string, active: boolean): Promise<LifecycleTemplate>;
  deleteTemplate(id: string): Promise<{ id: string }>;
  duplicateTemplate(id: string): Promise<LifecycleTemplate>;

  /* 阶段二：审批流程模板管理（仅 admin） */
  listReviewTemplates(): Promise<ReviewTemplateConfig[]>;
  createReviewTemplate(payload: CreateReviewTemplatePayload): Promise<ReviewTemplateConfig>;
  updateReviewTemplate(key: string, patch: UpdateReviewTemplatePayload): Promise<ReviewTemplateConfig>;
  toggleReviewTemplateActive(key: string, active: boolean): Promise<ReviewTemplateConfig>;
  deleteReviewTemplate(key: string): Promise<{ key: string }>;

  /* P1 占位 */
  listRisks(projectId: string): Promise<Risk[]>;

  /* C01 任务附件 */
  listDocuments(projectId: string, opts?: { nodeId?: string; milestoneId?: string }): Promise<ProjectDocument[]>;
  uploadDocument(projectId: string, payload: UploadDocumentPayload): Promise<ProjectDocument>;
  /** D02：关联飞书/外链文档（粘贴链接，服务端自动抓标题） */
  createLinkDocument(projectId: string, payload: CreateLinkDocumentPayload): Promise<ProjectDocument>;
  deleteDocument(projectId: string, id: string): Promise<ProjectDocument>;
  /** D05：对已交付模板项建立基线（幂等） */
  baselineDocument(projectId: string, docId: string): Promise<ProjectDocument>;
  /** D06：项目内增补门控必交付项（milestone:edit；生成待交付项，自动参与门校验） */
  addRequiredDeliverable(projectId: string, payload: { milestoneId: string; name: string }): Promise<ProjectDocument>;
  /** D07：给无门里程碑挂质量门（mode=template 模板门库 / blank 空白新建） */
  setMilestoneGate(
    projectId: string,
    milestoneId: string,
    payload: { mode: 'template' | 'blank'; templateCode?: string; name?: string; ownerRole?: string; items?: { content: string; ownerRole?: string }[] },
  ): Promise<MilestoneWithGate[]>;
  /** D07：修改门名称/责任角色 */
  updateGate(gateId: string, payload: { name?: string; ownerRole?: string }): Promise<MilestoneWithGate[]>;
  /** D07：删除门（里程碑回无门状态） */
  deleteGate(gateId: string): Promise<MilestoneWithGate[]>;
  /** 取附件文件流（http 走真实端点，mock 合成占位文件）；asDownload 控制下载/预览 */
  downloadDocument(projectId: string, id: string, opts?: { asDownload?: boolean }): Promise<Blob>;
}
