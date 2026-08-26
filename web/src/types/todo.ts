/**
 * 统一待办中心聚合类型（B14-块3）
 *
 * ⚠️ 零后端新增原则（架构 §8 / 决策 #3）：
 * 待办中心是**纯前端并发聚合**，六源全部复用既有端点，**绝不新增** `/api/todos` 之类汇总接口。
 *
 * 六源与端点映射（`hooks/useTodos.ts` 唯一实现）：
 * | # | TodoType         | 来源端点                                        | 说明 |
 * |---|------------------|-------------------------------------------------|------|
 * | ① | `APPROVAL`       | `GET /api/approvals`（`api.listMyApprovals`）    | 待我审批的评审 |
 * | ② | `ASSIGNED`       | `GET /api/workbench` → `myCycleTasks`（计划周期内）| 计划周期内的任务 |
 * | ④ | `OVERDUE`        | `myTasks` 中 `isOverdue(dueDate)`（B13 口径）    | 我的逾期任务 |
 * | ⑤ | `BLOCKED`        | `myTasks` 中 `status === '阻塞'`                 | 我的阻塞任务 |
 * | ⑥ | `REPORT_CONFIRM` | `GET /api/reports/pending-confirmation`（块2）   | 待我确认的周报 |
 */
import type { Priority } from './wbs';

/** 待办分类（顺序即下拉分组展示顺序） */
export type TodoType =
  | 'APPROVAL'
  | 'REPORT_CONFIRM'
  | 'OVERDUE'
  | 'ASSIGNED'
  | 'BLOCKED';

/**
 * 归一化后的单条待办。
 *
 * 设计约束：
 * - 六源结构各异，**统一压平**为本结构后再渲染，组件不感知来源差异。
 * - `targetRoute` 必须是可直接 `navigate()` 的应用内路径（含 query/hash），
 *   点击即跳到能「处理掉这条待办」的页面。
 */
export interface TodoItem {
  /** 唯一键（`${type}:${业务id}`），用于 React key 与去重 */
  id: string;
  type: TodoType;
  /** 一行摘要标题（含任务编号 / 周次等辨识信息） */
  title: string;
  /** 补充说明（负责人、截止、原因等），可为空串 */
  subtitle: string;
  projectId: string;
  projectName: string;
  /**
   * 排序权重（架构 §3 契约）：任务类取 `PRIORITY_RANK[priority]`（P0=0 … P3=3）；
   * **非任务类（审批 / 周报）恒为 `-1`**（无优先级维度）。
   *
   * 排序实现见 `useTodos#compareTodo`：先按 `type` 分组隔离，
   * 组内**仅任务类**用 `priorityRank` 升序（P0 置顶），非任务类按 `dueDate` 升序，
   * 因此 `-1` 与 `0..3` 永不混排，语义无歧义。
   */
  priorityRank: number;
  /** 原始优先级（仅任务类有值），用于行内色标 Chip */
  priority: Priority | null;
  /** 截止日 `YYYY-MM-DD`；无截止为 `null` */
  dueDate: string | null;
  /** 点击跳转的应用内路由 */
  targetRoute: string;
  /** 透传原始载荷（调试 / 二次加工用，渲染层不依赖具体形状） */
  payload: Record<string, unknown>;
}

/** 按 `TodoType` 分组后的一组待办（下拉按组渲染） */
export interface TodoGroup {
  type: TodoType;
  /** 分组中文标题（来自 `TODO_TYPE_LABEL`） */
  label: string;
  items: TodoItem[];
}

/** `useTodos()` 的返回形状 */
export interface TodoState {
  /** 徽标总数 = 所有分组条目数之和 */
  total: number;
  /** 仅含非空分组，顺序 = `TODO_TYPE_ORDER` */
  groups: TodoGroup[];
  loading: boolean;
  /** 任一源失败的提示（部分失败不阻断其余源，容错聚合） */
  error: string;
  /** 手动重新聚合（确认 / 打回后调用） */
  reload: () => void;
}
