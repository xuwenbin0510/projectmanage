import type { ProjectListItem } from './project';
import type { WbsNode } from './wbs';
import type { Review } from './review';

/** 我的工作台聚合数据（P0-13） */

export interface ReportReminder {
  projectId: string;
  projectName: string;
  week: string;
  weekStart: string;
  weekEnd: string;
  filled: boolean;
  /** D11：周报状态四态（待填 / 待确认 / 待他人确认 / 已确认） */
  state: '待填' | '待确认' | '待他人确认' | '已确认';
}

/** D10：门控待办（我有决议权限的未决议门） */
export interface GateTodo {
  gateId: string;
  projectId: string;
  projectName: string;
  milestoneCode: string;
  milestoneName: string;
  gateCode: string;
  gateName: string;
  ownerRole: string;
}

/** D11：待我确认周报（我是确认人且状态=已提交） */
export interface ReportConfirmation {
  id: string;
  projectId: string;
  projectName: string;
  week: string;
  authorName: string;
  submittedAt: string;
}

export interface WorkbenchData {
  stats: {
    pendingApprovals: number;
    overdueTasks: number;
    missingReports: number;
    /** D10：门控待办数 */
    pendingGates: number;
    /** D11：待我确认周报数 */
    pendingConfirmations: number;
  };
  myProjects: ProjectListItem[];
  myTasks: WbsNode[];
  myApprovals: Review[];
  reportReminders: ReportReminder[];
  /** D10：门控待办明细（点击跳项目概览门区） */
  gateTodos: GateTodo[];
  /** D11：待我确认周报明细（点击跳项目周报确认） */
  reportConfirmations: ReportConfirmation[];
}

/** 登录会话 */
export interface Session {
  token: string;
  user: import('./project').User;
}
