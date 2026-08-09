/** 工时统计报表（B9）—— 服务端聚合接口契约（`GET /projects/:id/effort-report`） */

import type { WbsNodeType } from '@/types/wbs';

/**
 * 汇总卡片口径（共享约定 B9-1）：一律只算**叶子**（SK-4 = 无子节点）。
 * 偏差率 = Σ实际/Σ估算 − 1；估算总和为 0 → null（前端「—」）。
 * 超支判定独立于偏差率：actual > estimate 即超支（估 0 且实 > 0 也计）。
 */
export interface EffortSummary {
  /** Σ 全部叶子 estimateDays（人日） */
  estimateTotal: number;
  /** Σ 全部叶子 effortHours（人日，工作日志累计） */
  actualTotal: number;
  /** actualTotal - estimateTotal（正=超支、负=结余） */
  diff: number;
  /** Σ实际/Σ估算 − 1；estimateTotal===0 → null（前端「—」） */
  diffRate: number | null;
  /** 叶子中 actual > estimate 的计数（估 0 且实>0 也计） */
  overrunCount: number;
  /** 叶子任务数 */
  leafCount: number;
  /** 父（容器/里程碑）节点数 */
  parentCount: number;
}

/**
 * 报表明细行（全节点扁平，compareWbsCode 树序，父在前）。
 * 父=容器汇总行、叶=任务行；「里程碑」作行内 badge（不做独立分组头，D-B9-3）。
 */
export interface EffortReportRow {
  id: string;
  parentId: string | null;
  wbsCode: string;
  level: number;
  nodeType: WbsNodeType;
  name: string;
  owner: string;
  ownerName: string;
  /** 叶=自身估算；父=Σ 子树叶子估算（仅报表比较用，读时算不落库） */
  estimateDays: number;
  /** 叶=累计存储；父=Σ 直接子（服务端 decorateEffort 已递归 = 子树 Σ） */
  effortHours: number;
  /** 直接子节点数（「由 N 个子任务汇总」的 N） */
  effortChildCount: number;
  /** 行差值 = effortHours - estimateDays */
  diff: number;
  /** 行偏差率 = effortHours/estimateDays − 1；estimateDays===0 → null */
  diffRate: number | null;
  /** effortHours > estimateDays（估 0 且实>0 也计） */
  isOverrun: boolean;
  progress: number;
  status: string;
  /** 无子节点（SK-4 叶子口径） */
  isLeaf: boolean;
  /** 绑定里程碑（服务端一次查表带出 code/name，前端零状态） */
  milestoneId: string | null;
  milestoneCode: string;
  milestoneName: string;
}

/**
 * 实际工时构成明细行（B9 R4）：由哪几篇**已提交**周报累加而成。
 * 草稿不计入；周倒序；前端可对明细求和并与 `effortHours` 比对（|差|>0.01 视为数据异常提示，不阻断）。
 */
export interface EffortBreakdownItem {
  /** '2026-W33' */
  week: string;
  /** work_reports.author_name */
  reporterName: string;
  /** work_reports.submitted_at（ISO） */
  submittedAt: string | null;
  /** 当周实际工时（人日） */
  weekActualDays: number;
}

/** 工时统计报表响应体（信封 `{code:0, data, message}` 的 data） */
export interface EffortReport {
  projectId: string;
  summary: EffortSummary;
  /** 全节点扁平（compareWbsCode 树序，父在前），行含父/叶两种 */
  rows: EffortReportRow[];
  /** nodeId → 已提交周报贡献行（周倒序）；无贡献的节点不出现 key */
  effortBreakdown: Record<string, EffortBreakdownItem[]>;
}
