/** 结构化周报（P0-08 / B14-块2 轻量闭环） */

/**
 * 周报状态机（B14-块2 → B15 扩展）：`草稿 → 已提交 → 已确认`，打回进入独立 `已打回` 态
 *
 * - `草稿`   作者可继续编辑；仅「草稿」可被作者本人或 admin 删除（B15）
 * - `已提交` 等待上级确认；此态下确认人可「确认」或「打回」
 * - `已确认` 终态；写入 `confirmedBy` / `confirmedAt`
 * - `已打回` B15 新增独立态：确认人打回后进入，作者**只能修改、不能删除**，
 *          修改后重新提交回到「已提交」；带 `rejectReason` 供作者查看
 *
 * ⚠️ SK-B14-2：状态流转**只能**由后端 `report.service#confirmReport / rejectReport` 驱动，
 * 前端禁止直接 PATCH `status`；「我能否确认」以 `GET /api/reports/pending-confirmation`
 * 的返回为准（服务端已按 `resolveConfirmers` 过滤），前端不重复实现确认人解析。
 */
export type ReportStatus = '草稿' | '已提交' | '已确认' | '已打回';

export interface ReportTaskRow {
  reportId: string;
  nodeId: string;
  nodeCode: string;
  nodeName: string;
  progressBefore: number;
  progressAfter: number;
  /** 是否被作者勾选计入本周完成 */
  selected: boolean;
  /** 本周实际工时（人日，B8 R3）：该日志行登记值；编辑态冲正回填源 */
  weekActualDays: number;
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
  /** @deprecated 作者 openId（飞书跨系统标识，会变）；判断「是不是我的周报」请用 authorUserId */
  author: string;
  /**
   * 作者系统身份键 users.id —— 本系统内身份判定的唯一正规入口。
   * null = 历史行未回填 author_user_id（此时才回退用 author）。
   */
  authorUserId?: number | null;
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
  /** 确认人 openId（B14-块2）；未确认为 `null`。打回时会被清空 */
  confirmedBy: string | null;
  /** 确认时间 ISO（B14-块2）；未确认为 `null`。打回时会被清空 */
  confirmedAt: string | null;
  /** 打回原因（B14-块2 → B15：打回时必填）；未被打回为 `null`。重新提交后清空，再次确认时也会被清空 */
  rejectReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 编辑回传任务行的最小契约：nodeId + progressAfter + selected 必须与原始 report.tasks 完全一致（R3-7）。
 * 引擎 `updateReport` 按 `payload.tasks` 整体重建 `report.tasks`，编辑提交必须原样回传，
 * 否则关联会被清空。
 *
 * B8（R2）：`actualDays` 为本周实际工时（人日）入参，**仅勾选叶子行携带**（未勾选 / 父节点携带 → 后端 400 E_VALIDATION）。
 */
export type ReportTaskRef = Pick<ReportTaskRow, 'nodeId' | 'progressAfter' | 'selected'> & {
  /** 本周实际工时（人日，B8 R2）：仅勾选叶子携带；0 ≤ v ≤ 100、最多 2 位小数 */
  actualDays?: number;
};

/** 周报校验结果（提交前本地强校验，服务端会再判一次） */
export interface ReportValidation {
  ok: boolean;
  /** 缺 owner / due 的风险行号（从 1 开始） */
  invalidRiskRows: number[];
  messages: string[];
}
