/** 评审引擎（P0-09） */

/* D08：pm_only 变更路由 → PM 单人审批 */
export type ReviewType = 'formal' | 'technical' | 'code' | 'ccb' | 'pm_only' | 'project';

export type ReviewMode = 'serial' | 'parallel_veto' | 'single';

export type ReviewStatus = '草稿' | '审批中' | '已通过' | '已驳回' | '已撤回';

export type ReviewStepStatus = 'pending' | 'current' | 'approved' | 'rejected' | 'skipped';

export type ReviewRefType = 'project' | 'stage' | 'gate' | 'milestone' | 'change' | 'doc' | 'pr';

export type ApprovalAction = 'submit' | 'approve' | 'reject' | 'withdraw' | 'proxy_approve';

export interface ReviewStep {
  id: string;
  reviewId: string;
  stepIndex: number;
  role: string;
  assigneeOpenId: string | null;
  assigneeName: string;
  required: boolean;
  status: ReviewStepStatus;
  decidedBy: string | null;
  decidedByName: string;
  decidedAt: string | null;
  comment: string;
}

export interface Approval {
  id: string;
  reviewId: string;
  projectId: string;
  stepIndex: number;
  stepRole: string;
  actorOpenId: string;
  actorName: string;
  action: ApprovalAction;
  comment: string;
  evidenceUrl: string;
  createdAt: string;
}

export interface Review {
  id: string;
  projectId: string;
  projectName: string;
  refType: ReviewRefType;
  refId: string;
  reviewType: ReviewType;
  title: string;
  templateKey: string;
  mode: ReviewMode;
  status: ReviewStatus;
  currentStep: number;
  initiator: string;
  initiatorName: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  steps: ReviewStep[];
  approvals: Approval[];
}

/** 评审模板（前端镜像，运行时以 /api/meta 为准） */
export interface ReviewTemplate {
  key: ReviewType;
  label: string;
  mode: ReviewMode;
  chain: string[];
  description: string;
}
