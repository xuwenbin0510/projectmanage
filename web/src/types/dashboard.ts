/**
 * 工作台仪表盘聚合结果类型（B11）
 *
 * 全部由 `utils/dashboardAgg.ts` 的**纯函数**从 `GET /api/workbench` 的返回值派生，
 * **不对应任何后端接口**（B11 期不新增 `/api/dashboard`，见架构 §1.3）。
 *
 * B12 追加「全局总览」类型（文件尾部），对应 `GET /api/dashboard/overview`。
 */
import type { Paged } from '@/types/api';
import type { Health, ProjectListItem, ProjectStatus, ProjectType } from '@/types/project';
import type { TaskStatus } from '@/types/wbs';

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

/* ==========================================================================
 * B12 · 全局总览（多项目）
 * 对应后端接口 `GET /api/dashboard/overview`，服务端一次性聚合返回。
 * ========================================================================== */

/** 统计范围：all = 公司全量（仅 admin/pmo/management）；mine = 我参与/负责 */
export type DashboardScope = 'all' | 'mine';

/** 全局总览查询入参（全部可选，后端有默认值与角色降级） */
export interface DashboardOverviewQuery {
  /** 不传时后端按角色推导：有 `dashboard:global` → all，否则 mine */
  scope?: DashboardScope;
  type?: ProjectType | '';
  status?: ProjectStatus | '';
  health?: Health | '';
  keyword?: string;
  /** scope=mine 时：false=我参与的，true=我负责的（我是 PM） */
  onlyMine?: boolean;
  /** 本期不做时间筛选，保留字段占位（后端忽略） */
  timeRange?: '30d' | 'quarter' | 'all';
  /** 明细表分页（1 起） */
  page?: number;
  pageSize?: number;
  sort?: 'health' | 'progress' | 'overdue' | 'nextMilestone';
}

/** 顶部四张指标卡的数据来源 */
export interface OverviewStats {
  /** 在管项目数（已批准 / 进行中 / 挂起） */
  managedProjects: number;
  /** 红灯项目数（health === 'red'） */
  redProjects: number;
  /** 范围内叶子任务的逾期数 */
  overdueTasks: number;
  /** 周报填报率 0~100（整数） */
  reportFillRate: number;
  /** 本周已填报项目数 */
  reportFilled: number;
  /** 本周应填报项目数（范围内 status='进行中'） */
  reportDue: number;
  /** 整体进度 0~100（口径：里程碑达成率的算术平均） */
  averageProgress: number;
}

/** 状态环单段 */
export interface StatusDonutSegment {
  status: ProjectStatus;
  value: number;
}

/** 项目状态分布环 */
export interface StatusDonut {
  segments: StatusDonutSegment[];
  total: number;
}

/** 某负责人在单个项目下的任务分布（`OwnerLoadDrawer` 下钻用） */
export interface OwnerLoadProjectRow {
  projectId: string;
  projectName: string;
  /** 该项目下此人的在办任务数 */
  activeTasks: number;
  /** 其中已逾期数 */
  overdueTasks: number;
}

/** 负责人负荷单行（负荷 = 在办任务数 + 逾期数） */
export interface OwnerLoadRow {
  /** 负责人 openId；未分配为空串 */
  owner: string;
  /** 负责人姓名；未分配为「未分配」 */
  ownerName: string;
  /** 在办任务数（叶子且 status !== '完成'） */
  activeTasks: number;
  /** 其中已逾期数 */
  overdueTasks: number;
  /** 跨越的项目数（= `projects.length`） */
  projectCount: number;
  /**
   * 跨项目明细，排序「逾期 ↓ → 在办 ↓ → 项目名 ↑」。
   *
   * 供 P1-6 负责人下钻抽屉直接渲染，避免抽屉再发一次请求
   * （聚合成本为零：服务端本来就要按项目去重才能算 `projectCount`）。
   */
  projects: OwnerLoadProjectRow[];
}

/** 本周未填报周报的项目 */
export interface ReportMissingRow {
  projectId: string;
  projectName: string;
  pmName: string;
}

/** 全局总览完整响应 */
export interface DashboardOverview {
  /** 后端实际生效的范围（非特权角色即使传 all 也会被降为 mine） */
  scope: DashboardScope;
  /** 数据生成时间（ISO 字符串），用于「更新于」提示 */
  generatedAt: string;
  stats: OverviewStats;
  statusDonut: StatusDonut;
  health: HealthDistribution;
  /** 按「逾期 ↓ → 临期 ↓ → 项目名」排序，只含有逾期或临期的项目 */
  overdue: OverdueByProject[];
  /** 按「逾期 ↓ → 在办 ↓ → 姓名 ↑」排序，未分配恒最后 */
  ownerLoad: OwnerLoadRow[];
  reportMissing: ReportMissingRow[];
  /** 项目明细表（服务端分页），行点击可钻取至 B11 单项目仪表盘 */
  projects: Paged<ProjectListItem>;
}

/* ==========================================================================
 * B13 · 逾期 / 临期任务下探抽屉
 * 点击「逾期/临期报表」里某项目 → 右侧抽屉展示该项目的逾期 / 临期任务明细。
 * ========================================================================== */

/** 抽屉 Tab 字面量：默认 'overdue'（先救最急的） */
export type OverdueDrawerTab = 'overdue' | 'dueSoon';

/** 抽屉表格行视图模型：由 `WbsNode` + 里程碑名解析映射得到（B13） */
export interface OverdueTaskRow {
  /** 节点 id（WbsNode.id），作为表格行 key */
  id: string;
  /** WBS 编码，如 "1.2.3" */
  wbsCode: string;
  /** 任务名 */
  name: string;
  /** 负责人姓名（WbsNode.ownerName）；空 → 「未分配」 */
  ownerName: string;
  /** 计划完成日 YYYY-MM-DD */
  dueDate: string;
  /** 任务状态（看板五态之一） */
  status: TaskStatus;
  /** 进度 0~100 */
  progress: number;
  /** 所属里程碑名（milestoneId 解析；无 → 「未关联」） */
  milestoneName: string;
}
