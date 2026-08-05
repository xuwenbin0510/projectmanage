/** 变更控制（P0-14） */

export type ChangeType = 'milestone_date' | 'requirement_baseline' | 'scope' | 'other';

export type ChangeRoute = 'pm_only' | 'ccb';

export type ChangeStatus = '草稿' | '审批中' | '已批准' | '已驳回' | '已实施';

export interface ChangePayload {
  fromDate?: string;
  toDate?: string;
  [key: string]: unknown;
}

export interface Change {
  id: string;
  projectId: string;
  code: string;
  changeType: ChangeType;
  title: string;
  content: string;
  impactAnalysis: string;
  effortDays: number;
  targetType: 'milestone' | 'requirement' | 'scope' | '';
  targetId: string;
  payload: ChangePayload;
  route: ChangeRoute;
  status: ChangeStatus;
  reviewId: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  appliedAt: string | null;
}

/** 路由判定结果（实时提示用） */
export interface RouteResult {
  route: ChangeRoute;
  chain: string[];
  reasons: string[];
}

/** 里程碑延后时后端回传的变更单草稿（E_MS_NEED_CHANGE.data.changeDraft） */
export interface ChangeDraft {
  projectId: string;
  changeType: ChangeType;
  title: string;
  targetType: 'milestone';
  targetId: string;
  payload: { fromDate: string; toDate: string };
}
