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

export interface WorkbenchData {
  stats: {
    pendingApprovals: number;
    overdueTasks: number;
    missingReports: number;
    /** D10：门控待办数 */
    pendingGates: number;
  };
  myProjects: ProjectListItem[];
  myTasks: WbsNode[];
  myApprovals: Review[];
  reportReminders: ReportReminder[];
  /** D10：门控待办明细（点击跳项目概览门区） */
  gateTodos: GateTodo[];
}

/** 登录会话 */
export interface Session {
  token: string;
  user: import('./project').User;
}
