/** 结构化周报（P0-08） */

export type ReportStatus = '草稿' | '已提交';

export interface ReportTaskRow {
  reportId: string;
  nodeId: string;
  nodeCode: string;
  nodeName: string;
  progressBefore: number;
  progressAfter: number;
  /** 是否被作者勾选计入本周完成 */
  selected: boolean;
}

export interface ReportRisk {
  id: string;
  reportId: string;
  seq: number;
  description: string;
  /** 必填 */
  owner: string;
  /** 必填 YYYY-MM-DD */
  dueDate: string;
  promotedRiskId: string | null;
}

export interface Report {
  id: string;
  projectId: string;
  /** 2026-W11 */
  week: string;
  weekStart: string;
  weekEnd: string;
  author: string;
  authorName: string;
  status: ReportStatus;
  /** ① 补充说明 */
  doneNote: string;
  /** ② 下周计划 */
  planItems: string[];
  /** ④ 需要协调的资源 */
  resourceNote: string;
  /** ① 关联任务 */
  tasks: ReportTaskRow[];
  /** ③ 风险与问题 */
  risks: ReportRisk[];
  /** 提交时冻结的进度快照 */
  snapshot: Record<string, number> | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 周报校验结果（提交前本地强校验，服务端会再判一次） */
export interface ReportValidation {
  ok: boolean;
  /** 缺 owner / due 的风险行号（从 1 开始） */
  invalidRiskRows: number[];
  messages: string[];
}
