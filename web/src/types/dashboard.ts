/**
 * 工作台仪表盘聚合结果类型（B11）
 *
 * 全部由 `utils/dashboardAgg.ts` 的**纯函数**从 `GET /api/workbench` 的返回值派生，
 * **不对应任何后端接口**（本期不新增 `/api/dashboard`，见架构 §1.3）。
 */

/** 进度环：我的任务三段分布 + 总完成度 */
export interface TaskProgressSummary {
  /** 参与统计的任务总数（= myTasks.length + 已完成计数口径见下） */
  total: number;
  /** 已完成（status === '完成'） */
  done: number;
  /** 在办（进行中 + 待评审） */
  active: number;
  /** 未启动 / 卡住（待办 + 阻塞） */
  pending: number;
  /** 加权完成度 0~100（按 progress 平均，保留整数）；total=0 时为 0 */
  completionRate: number;
}

/** 逾期柱状：按项目分组的逾期 / 临期计数 */
export interface OverdueByProject {
  projectId: string;
  /** 项目名（优先 myTasks[].projectName，回落 myProjects join，再回落「未命名项目」） */
  projectName: string;
  /** 已逾期任务数（diffDays(today, dueDate) < 0） */
  overdue: number;
  /** 临期任务数（非逾期 且 diffDays(today, dueDate) <= 3） */
  dueSoon: number;
}

/** 健康分布：我的在办项目健康度计数 */
export interface HealthDistribution {
  green: number;
  yellow: number;
  red: number;
  /** 三项之和，便于组件判空与算占比 */
  total: number;
}

/** 仪表盘聚合总结果 */
export interface DashboardSummary {
  progress: TaskProgressSummary;
  /** 按「逾期数 ↓ → 临期数 ↓ → 项目名」排序，且**只含有逾期或临期的项目** */
  overdue: OverdueByProject[];
  health: HealthDistribution;
}
