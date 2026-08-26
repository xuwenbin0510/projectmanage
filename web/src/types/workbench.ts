import type { ProjectListItem } from './project';
import type { WbsNode } from './wbs';
import type { Review } from './review';
import type { TaskStatus } from './wbs';

/** 我的工作台聚合数据（P0-13） */

/** 周报提醒命中任务（「周报提醒」卡片下钻展示） */
export interface ReportReminderTask {
  id: string;
  wbsCode: string;
  name: string;
  startDate: string;
  dueDate: string;
  status: TaskStatus;
  progress: number;
}

export interface ReportReminder {
  projectId: string;
  projectName: string;
  week: string;
  weekStart: string;
  weekEnd: string;
  filled: boolean;
  /** D11：周报状态四态（待填 / 待确认 / 待他人确认 / 已确认） */
  state: '待填' | '待确认' | '待他人确认' | '已确认';
  /** Q1：本周计划窗口内、我名下未完成的命中任务（下钻展示） */
  tasks?: ReportReminderTask[];
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
  /** Q4：我负责的已完成真叶子任务（供「我的任务进度」环「已完成」段；不进入「我的任务」列表/逾期派生） */
  completedTasks?: WbsNode[];
  /** 计划周期内的任务（待办中心「计划周期内的任务」聚焦子集，前瞻 CYCLE_LOOKAHEAD_DAYS 天） */
  myCycleTasks?: WbsNode[];
  myApprovals: Review[];
  reportReminders: ReportReminder[];
  /** D10：门控待办明细（点击跳项目概览门区） */
  gateTodos: GateTodo[];
  /** D11：待我确认周报明细（点击跳项目周报确认） */
  reportConfirmations: ReportConfirmation[];
  /** 工作台快捷卡：交付物已交付率（范围=我的项目，与全局总览同源聚合） */
  deliverables?: {
    total: number;
    delivered: number;
    pending: number;
    baselined: number;
    baselineRate: number;
  };
  /** 工作台快捷卡：周报闭环率（范围=我的项目，与全局总览同源聚合） */
  reportClosure?: {
    submitted: number;
    confirmed: number;
    closureRate: number;
  };
}

/** 工作台周报闭环下钻：各项目明细 + 汇总（feat/workbench-cards-fix） */
export interface WorkbenchReportClosureItem {
  projectId: string;
  projectName: string;
  submitted: number;
  confirmed: number;
  /** 闭环率（已确认 / (已提交+已确认)） */
  rate: number;
}

export interface WorkbenchReportClosure {
  submitted: number;
  confirmed: number;
  closureRate: number;
  items: WorkbenchReportClosureItem[];
}

/** 登录会话 */
export interface Session {
  token: string;
  user: import('./project').User;
  /** 首次登录/重置密码后强制改密 */
  mustChangePwd?: boolean;
}
