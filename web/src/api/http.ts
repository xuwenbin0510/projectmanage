import type { ApiEnvelope, Paged } from '@/types/api';
import { ApiError, ErrorCode } from '@/types/api';
import type {
  User,
  CreateUserPayload,
  UpdateUserPayload,
  GlobalRole,
  Project,
  ProjectListItem,
  ProjectMember,
  ProjectRole,
  ProjectStatus,
  ProjectType,
  ClassifyInput,
  ClassifyResult,
  LifecycleTemplate,
  MilestoneWithGate,
  CloseBlocker,
  ReviewTemplateConfig,
  CreateReviewTemplatePayload,
  UpdateReviewTemplatePayload,
  CreateTemplatePayload,
  UpdateTemplatePayload,
} from '@/types/project';
import type { WbsNode, TaskStatus, BoardConfig, BoardView } from '@/types/wbs';
import type { Report } from '@/types/report';
import type { EffortReport } from '@/types/effort';
import type { Review } from '@/types/review';
import type { Change, RouteResult } from '@/types/change';
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
import type {
  ApiClient,
  ProjectQuery,
  CreateProjectPayload,
  UpdateProjectPayload,
  GateDecisionPayload,
  MilestoneCreatePayload,
  MilestoneUpdatePayload,
  WbsNodePayload,
  ReportPayload,
  CreateReviewPayload,
  DecisionPayload,
  ChangePayloadInput,
  AuditQuery,
  MetaData,
} from './contract';
import { genRequestId } from '@/utils/format';

/* ═══════════════════════════════════════════════════
 * 真实 HTTP 实现（VITE_USE_MOCK=false 时启用）
 * 与 MockApiClient 签名完全一致
 * ═══════════════════════════════════════════════════ */

const TOKEN_KEY = 'pm_token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

const BASE = import.meta.env.VITE_API_BASE || '/api';

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    sp.append(k, String(v));
  });
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': genRequestId(),
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(ErrorCode.E_NETWORK, undefined, undefined, 0);
  }

  let payload: ApiEnvelope<T> | null = null;
  try {
    payload = (await res.json()) as ApiEnvelope<T>;
  } catch {
    payload = null;
  }

  if (!res.ok || !payload || payload.code !== 0) {
    const code = payload && payload.code !== 0 ? String(payload.code) : ErrorCode.E_NETWORK;
    throw new ApiError(code, payload?.message, (payload as unknown as { data?: unknown })?.data, res.status);
  }
  return payload.data;
}

const get = <T>(p: string): Promise<T> => request<T>('GET', p);
const post = <T>(p: string, b?: unknown): Promise<T> => request<T>('POST', p, b ?? {});
const put = <T>(p: string, b?: unknown): Promise<T> => request<T>('PUT', p, b ?? {});
const patch = <T>(p: string, b?: unknown): Promise<T> => request<T>('PATCH', p, b ?? {});
const del = <T>(p: string): Promise<T> => request<T>('DELETE', p);

export class HttpApiClient implements ApiClient {
  /* 认证 */
  async getAppId(): Promise<string> {
    const res = await get<{ appId: string } | null>('/appid');
    return res && typeof res.appId === 'string' ? res.appId : '';
  }

  async devLogin(openId: string): Promise<Session> {
    const s = await post<Session>('/auth/devlogin', { openId });
    setToken(s.token);
    return s;
  }

  async feishuLogin(code: string): Promise<Session> {
    const s = await post<Session>('/auth/feishu', { code });
    setToken(s.token);
    return s;
  }

  /** @prd P0-11 / B4-T03 飞书网页登录（浏览器 Web OAuth，对应 `POST /auth/feishu/web`） */
  async loginByFeishuCode(code: string): Promise<{ token: string; user: User }> {
    const r = await post<{ token: string; user: User }>('/auth/feishu/web', { code });
    setToken(r.token);
    return r;
  }

  me(): Promise<User> {
    return get<User>('/auth/me');
  }

  async logout(): Promise<void> {
    await post<null>('/auth/logout');
    setToken('');
  }

  /* 元数据 */
  getMeta(): Promise<MetaData> {
    return get<MetaData>('/meta');
  }

  getLifecycleTemplate(type: ProjectType): Promise<LifecycleTemplate | null> {
    return get<LifecycleTemplate | null>(`/meta/templates/${type}`);
  }

  /* 项目 */
  classify(input: ClassifyInput): Promise<ClassifyResult> {
    return post<ClassifyResult>('/projects/classify', input);
  }

  listProjects(query: ProjectQuery): Promise<Paged<ProjectListItem>> {
    return get<Paged<ProjectListItem>>(`/projects${qs(query as Record<string, unknown>)}`);
  }

  getProject(id: string): Promise<Project> {
    return get<Project>(`/projects/${id}`);
  }

  createProject(payload: CreateProjectPayload): Promise<Project> {
    return post<Project>('/projects', payload);
  }

  updateProject(id: string, payload: UpdateProjectPayload): Promise<Project> {
    return patch<Project>(`/projects/${id}`, payload);
  }

  transitionProject(id: string, to: ProjectStatus, comment: string): Promise<Project> {
    return post<Project>(`/projects/${id}/transition`, { to, comment });
  }

  checkClose(id: string): Promise<CloseBlocker[]> {
    return get<CloseBlocker[]>(`/projects/${id}/close-check`);
  }

  /* 成员 */
  listMembers(projectId: string): Promise<ProjectMember[]> {
    return get<ProjectMember[]>(`/projects/${projectId}/members`);
  }

  addMember(projectId: string, userOpenId: string, role: ProjectRole): Promise<ProjectMember> {
    return post<ProjectMember>(`/projects/${projectId}/members`, { userOpenId, role });
  }

  async removeMember(projectId: string, memberId: string): Promise<void> {
    await del<null>(`/projects/${projectId}/members/${memberId}`);
  }

  /* 质量门（挂在里程碑上 · 决策 D-A） */
  toggleGateItem(itemId: string, checked: boolean): Promise<MilestoneWithGate[]> {
    return patch<MilestoneWithGate[]>(`/gate-items/${itemId}`, { checked });
  }

  decideGate(projectId: string, payload: GateDecisionPayload): Promise<MilestoneWithGate[]> {
    return post<MilestoneWithGate[]>(`/projects/${projectId}/gates/${payload.gateId}/decide`, payload);
  }

  /* D05 检查项管理 */
  addGateItem(gateId: string, payload: { content: string; ownerRole?: string }): Promise<MilestoneWithGate[]> {
    return post<MilestoneWithGate[]>(`/gates/${gateId}/items`, payload);
  }

  updateGateItem(itemId: string, payload: { content: string; ownerRole?: string }): Promise<MilestoneWithGate[]> {
    return patch<MilestoneWithGate[]>(`/gate-items/${itemId}/update`, payload);
  }

  deleteGateItem(itemId: string): Promise<MilestoneWithGate[]> {
    return del<MilestoneWithGate[]>(`/gate-items/${itemId}`);
  }

  /* 里程碑 */
  listMilestones(projectId: string): Promise<MilestoneWithGate[]> {
    return get<MilestoneWithGate[]>(`/projects/${projectId}/milestones`);
  }

  createMilestone(projectId: string, payload: MilestoneCreatePayload): Promise<MilestoneWithGate> {
    return post<MilestoneWithGate>(`/projects/${projectId}/milestones`, payload);
  }

  updateMilestone(id: string, payload: MilestoneUpdatePayload): Promise<MilestoneWithGate> {
    return patch<MilestoneWithGate>(`/milestones/${id}`, payload);
  }

  async deleteMilestone(id: string): Promise<void> {
    await del<null>(`/milestones/${id}`);
  }

  /* WBS */
  listWbs(projectId: string): Promise<WbsNode[]> {
    return get<WbsNode[]>(`/projects/${projectId}/wbs`);
  }

  createWbsNode(projectId: string, payload: WbsNodePayload): Promise<WbsNode> {
    return post<WbsNode>(`/projects/${projectId}/wbs`, payload);
  }

  updateWbsNode(id: string, payload: Partial<WbsNodePayload>): Promise<WbsNode> {
    return patch<WbsNode>(`/wbs/${id}`, payload);
  }

  async deleteWbsNode(id: string): Promise<void> {
    await del<null>(`/wbs/${id}`);
  }

  moveWbsNode(id: string, newParentId: string | null, index: number): Promise<WbsNode[]> {
    return post<WbsNode[]>(`/wbs/${id}/move`, { newParentId, index });
  }

  /* 看板 */
  getBoard(projectId: string): Promise<BoardView> {
    return get<BoardView>(`/projects/${projectId}/board`);
  }

  moveTask(nodeId: string, status: TaskStatus, order: number): Promise<BoardView> {
    return post<BoardView>(`/wbs/${nodeId}/move-status`, { status, order });
  }

  updateBoardConfig(projectId: string, wipLimits: Record<string, number>): Promise<BoardConfig> {
    return patch<BoardConfig>(`/projects/${projectId}/board-config`, { wipLimits });
  }

  /* 周报 */
  listReports(projectId: string): Promise<Report[]> {
    return get<Report[]>(`/projects/${projectId}/reports`);
  }

  getReport(projectId: string, week: string): Promise<Report | null> {
    return get<Report | null>(`/projects/${projectId}/reports/${week}`);
  }

  saveReport(payload: ReportPayload): Promise<Report> {
    return post<Report>(`/projects/${payload.projectId}/reports`, { ...payload, submit: false });
  }

  submitReport(payload: ReportPayload): Promise<Report> {
    return post<Report>(`/projects/${payload.projectId}/reports`, { ...payload, submit: true });
  }

  updateReport(id: string, payload: ReportPayload): Promise<Report> {
    return patch<Report>(`/projects/${payload.projectId}/reports/${id}`, payload);
  }

  /* 周报轻量闭环 B14-块2 */
  confirmReport(projectId: string, id: string): Promise<Report> {
    return post<Report>(`/projects/${projectId}/reports/${id}/confirm`, {});
  }

  rejectReport(projectId: string, id: string, reason: string): Promise<Report> {
    return post<Report>(`/projects/${projectId}/reports/${id}/reject`, { reason });
  }

  listPendingConfirmation(): Promise<Report[]> {
    return get<Report[]>('/reports/pending-confirmation');
  }

  /* 工时统计报表 B9 */
  getEffortReport(projectId: string): Promise<EffortReport> {
    return get<EffortReport>(`/projects/${projectId}/effort-report`);
  }

  /* 评审 */
  listReviews(projectId?: string): Promise<Review[]> {
    return get<Review[]>(`/reviews${qs({ projectId })}`);
  }

  listMyApprovals(): Promise<Review[]> {
    return get<Review[]>('/reviews/my-approvals');
  }

  getReview(id: string): Promise<Review> {
    return get<Review>(`/reviews/${id}`);
  }

  createReview(payload: CreateReviewPayload): Promise<Review> {
    return post<Review>('/reviews', payload);
  }

  approveReview(id: string, payload: DecisionPayload): Promise<Review> {
    return post<Review>(`/reviews/${id}/approve`, payload);
  }

  rejectReview(id: string, payload: DecisionPayload): Promise<Review> {
    return post<Review>(`/reviews/${id}/reject`, payload);
  }

  withdrawReview(id: string, payload: DecisionPayload): Promise<Review> {
    return post<Review>(`/reviews/${id}/withdraw`, payload);
  }

  /* 变更 */
  routeChange(input: { changeType: Change['changeType']; effortDays: number; targetType: string }): Promise<RouteResult> {
    return post<RouteResult>('/changes/route', input);
  }

  listChanges(projectId: string): Promise<Change[]> {
    return get<Change[]>(`/projects/${projectId}/changes`);
  }

  getChange(id: string): Promise<Change> {
    return get<Change>(`/changes/${id}`);
  }

  createChange(payload: ChangePayloadInput): Promise<Change> {
    return post<Change>(`/projects/${payload.projectId}/changes`, payload);
  }

  submitChange(id: string): Promise<Change> {
    return post<Change>(`/changes/${id}/submit`);
  }

  applyChange(id: string): Promise<Change> {
    return post<Change>(`/changes/${id}/apply`);
  }

  /* 审计 */
  listAudit(query: AuditQuery): Promise<Paged<AuditLog>> {
    return get<Paged<AuditLog>>(`/audit${qs(query as Record<string, unknown>)}`);
  }

  /* 工作台 */
  getWorkbench(): Promise<WorkbenchData> {
    return get<WorkbenchData>('/workbench');
  }

  /* 全局总览 B12 */
  getDashboardOverview(query: DashboardOverviewQuery): Promise<DashboardOverview> {
    /* `qs` 会跳过 undefined / null / ''，所以未选中的筛选项不会污染 URL；
       `onlyMine: false` 会被序列化成 'false'，服务端只认 'true' / '1'，语义一致。 */
    return get<DashboardOverview>(`/dashboard/overview${qs(query as Record<string, unknown>)}`);
  }

  getDashboardTasks(query: DashboardTasksQuery): Promise<Paged<DashboardTaskRow>> {
    /* qs 跳过 undefined / null / ''，未选中的维度参数不污染 URL；语义与服务端一致 */
    return get<Paged<DashboardTaskRow>>(`/dashboard/tasks${qs(query as Record<string, unknown>)}`);
  }

  /* 第二批：质量与交付下探明细（门控 / 交付物） */
  getDashboardGates(query: DashboardGatesQuery): Promise<Paged<DashboardGateRow>> {
    return get<Paged<DashboardGateRow>>(`/dashboard/gates${qs(query as Record<string, unknown>)}`);
  }

  getDashboardDeliverables(query: DashboardDeliverablesQuery): Promise<Paged<DashboardDeliverableRow>> {
    return get<Paged<DashboardDeliverableRow>>(`/dashboard/deliverables${qs(query as Record<string, unknown>)}`);
  }

  /* 管理后台 */
  listUsers(): Promise<User[]> {
    return get<User[]>('/admin/users');
  }

  updateUserRole(openId: string, role: GlobalRole): Promise<User> {
    return patch<User>(`/admin/users/${openId}`, { globalRole: role });
  }

  /** 阶段一：新增用户（仅 admin） */
  createUser(payload: CreateUserPayload): Promise<User> {
    return post<User>('/admin/users', payload);
  }

  /** 阶段一：通用更新（角色/状态/部门/姓名/工号/邮箱，仅 admin） */
  updateUser(openId: string, patchBody: UpdateUserPayload): Promise<User> {
    return patch<User>(`/admin/users/${openId}`, patchBody);
  }

  listTemplates(): Promise<LifecycleTemplate[]> {
    return get<LifecycleTemplate[]>('/admin/templates');
  }

  async resetDemoData(): Promise<void> {
    await post<null>('/admin/reset-demo');
  }

  /* 阶段三：生命周期模板管理（仅 admin） */
  createTemplate(payload: CreateTemplatePayload): Promise<LifecycleTemplate> {
    return post<LifecycleTemplate>('/admin/templates', payload);
  }
  updateTemplate(id: string, patchBody: UpdateTemplatePayload): Promise<LifecycleTemplate> {
    return put<LifecycleTemplate>(`/admin/templates/${encodeURIComponent(id)}`, patchBody);
  }
  toggleTemplateActive(id: string, active: boolean): Promise<LifecycleTemplate> {
    return patch<LifecycleTemplate>(`/admin/templates/${encodeURIComponent(id)}/active`, { active });
  }
  deleteTemplate(id: string): Promise<{ id: string }> {
    return del<{ id: string }>(`/admin/templates/${encodeURIComponent(id)}`);
  }
  duplicateTemplate(id: string): Promise<LifecycleTemplate> {
    return post<LifecycleTemplate>(`/admin/templates/${encodeURIComponent(id)}/duplicate`);
  }

  /* 阶段二：审批流程模板管理（仅 admin） */
  listReviewTemplates(): Promise<ReviewTemplateConfig[]> {
    return get<ReviewTemplateConfig[]>('/admin/review-templates');
  }
  createReviewTemplate(payload: CreateReviewTemplatePayload): Promise<ReviewTemplateConfig> {
    return post<ReviewTemplateConfig>('/admin/review-templates', payload);
  }
  updateReviewTemplate(key: string, patchBody: UpdateReviewTemplatePayload): Promise<ReviewTemplateConfig> {
    return put<ReviewTemplateConfig>(`/admin/review-templates/${encodeURIComponent(key)}`, patchBody);
  }
  toggleReviewTemplateActive(key: string, active: boolean): Promise<ReviewTemplateConfig> {
    return patch<ReviewTemplateConfig>(`/admin/review-templates/${encodeURIComponent(key)}/active`, { active });
  }
  deleteReviewTemplate(key: string): Promise<{ key: string }> {
    return del<{ key: string }>(`/admin/review-templates/${encodeURIComponent(key)}`);
  }

  /* P1 */
  listRisks(projectId: string): Promise<Risk[]> {
    return get<Risk[]>(`/projects/${projectId}/risks`);
  }

  /* C01 任务附件 */
  listDocuments(projectId: string, opts?: { nodeId?: string; milestoneId?: string }): Promise<ProjectDocument[]> {
    const q = qs({ nodeId: opts?.nodeId, milestoneId: opts?.milestoneId });
    return get<ProjectDocument[]>(`/projects/${projectId}/documents${q}`);
  }

  /**
   * 上传附件：multipart/form-data，字段名 `file`。
   * 不走通用 request()（它强制 JSON），这里单独构造 FormData + Bearer 鉴权，
   * 解析方式与服务端信封一致。
   */
  async uploadDocument(projectId: string, payload: UploadDocumentPayload): Promise<ProjectDocument> {
    const fd = new FormData();
    fd.append('file', payload.file);
    if (payload.nodeId) fd.append('nodeId', payload.nodeId);
    if (payload.milestoneId) fd.append('milestoneId', payload.milestoneId);
    if (payload.templateKey) fd.append('templateKey', payload.templateKey);
    if (payload.changeNote) fd.append('changeNote', payload.changeNote);

    let res: Response;
    try {
      res = await fetch(`${BASE}/projects/${projectId}/documents`, {
        method: 'POST',
        headers: { ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
        body: fd,
      });
    } catch {
      throw new ApiError(ErrorCode.E_NETWORK, undefined, undefined, 0);
    }

    let p: ApiEnvelope<ProjectDocument> | null = null;
    try {
      p = (await res.json()) as ApiEnvelope<ProjectDocument>;
    } catch {
      p = null;
    }
    if (!res.ok || !p || p.code !== 0) {
      const code = p && p.code !== 0 ? String(p.code) : ErrorCode.E_NETWORK;
      throw new ApiError(code, p?.message, (p as unknown as { data?: unknown })?.data, res.status);
    }
    return p.data;
  }

  /** D02：关联飞书/外链文档（JSON 体，服务端自动抓标题） */
  async createLinkDocument(projectId: string, payload: CreateLinkDocumentPayload): Promise<ProjectDocument> {
    const body: Record<string, string> = { url: payload.url };
    if (payload.name) body.name = payload.name;
    if (payload.nodeId) body.nodeId = payload.nodeId;
    if (payload.milestoneId) body.milestoneId = payload.milestoneId;
    if (payload.templateKey) body.templateKey = payload.templateKey;
    if (payload.changeNote) body.changeNote = payload.changeNote;

    let res: Response;
    try {
      res = await fetch(`${BASE}/projects/${projectId}/documents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError(ErrorCode.E_NETWORK, undefined, undefined, 0);
    }

    let p: ApiEnvelope<ProjectDocument> | null = null;
    try {
      p = (await res.json()) as ApiEnvelope<ProjectDocument>;
    } catch {
      p = null;
    }
    if (!res.ok || !p || p.code !== 0) {
      const code = p && p.code !== 0 ? String(p.code) : ErrorCode.E_NETWORK;
      throw new ApiError(code, p?.message, (p as unknown as { data?: unknown })?.data, res.status);
    }
    return p.data;
  }

  async deleteDocument(projectId: string, id: string): Promise<ProjectDocument> {
    return del<ProjectDocument>(`/projects/${projectId}/documents/${id}`);
  }

  /** D05：对已交付模板项建立基线 */
  baselineDocument(projectId: string, docId: string): Promise<ProjectDocument> {
    return post<ProjectDocument>(`/projects/${projectId}/documents/${docId}/baseline`, {});
  }

  /** D06：项目内增补门控必交付项 */
  addRequiredDeliverable(projectId: string, payload: { milestoneId: string; name: string }): Promise<ProjectDocument> {
    return post<ProjectDocument>(`/projects/${projectId}/documents/required`, payload);
  }

  /** D07：给无门里程碑挂质量门 */
  setMilestoneGate(
    projectId: string,
    milestoneId: string,
    payload: { mode: 'template' | 'blank'; templateCode?: string; name?: string; ownerRole?: string; items?: { content: string; ownerRole?: string }[] },
  ): Promise<MilestoneWithGate[]> {
    return post<MilestoneWithGate[]>(`/projects/${projectId}/milestones/${milestoneId}/gate`, payload);
  }

  /** D07：修改门名称/责任角色 */
  updateGate(gateId: string, payload: { name?: string; ownerRole?: string }): Promise<MilestoneWithGate[]> {
    return patch<MilestoneWithGate[]>(`/gates/${gateId}`, payload);
  }

  /** D07：删除门 */
  deleteGate(gateId: string): Promise<MilestoneWithGate[]> {
    return del<MilestoneWithGate[]>(`/gates/${gateId}`);
  }

  /** 取附件二进制流（服务端按 Content-Type 返回，便于预览/下载） */
  async downloadDocument(projectId: string, id: string, opts?: { asDownload?: boolean }): Promise<Blob> {
    const q = opts?.asDownload ? '?download=1' : '';
    let res: Response;
    try {
      res = await fetch(`${BASE}/projects/${projectId}/documents/${id}/download${q}`, {
        headers: { ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
      });
    } catch {
      throw new ApiError(ErrorCode.E_NETWORK, undefined, undefined, 0);
    }
    if (!res.ok) {
      throw new ApiError(ErrorCode.E_NOT_FOUND, '文件不存在或无权访问', undefined, res.status);
    }
    return res.blob();
  }
}

export const httpClient = new HttpApiClient();
