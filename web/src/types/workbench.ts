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

export interface WorkbenchData {
  stats: {
    pendingApprovals: number;
    overdueTasks: number;
    missingReports: number;
  };
  myProjects: ProjectListItem[];
  myTasks: WbsNode[];
  myApprovals: Review[];
  reportReminders: ReportReminder[];
}

/** 登录会话 */
export interface Session {
  token: string;
  user: import('./project').User;
}
