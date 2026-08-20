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
import type { Priority, TaskStatus } from '@/types/wbs';

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

/**
 * 优先级分布（B14-块1 · 环图数据源）
 *
 * 由 `aggregatePriorityDistribution(nodes)` 从任务列表派生，**不对应任何后端接口**。
 * `total` 恒等于四档之和，`total === 0` 时组件渲染空态（不画环）。
 */
export interface PriorityDistribution {
  P0: number;
  P1: number;
  P2: number;
  P3: number;
  /** 四档之和，便于组件判空与算占比 */
  total: number;
}

/** 仪表盘聚合总结果 */
export interface DashboardSummary {
  progress: TaskProgressSummary;
  /** 按「逾期数 ↓ → 临期数 ↓ → 项目名」排序，且**只含有逾期或临期的项目** */
  overdue: OverdueByProject[];
  health: HealthDistribution;
  /** B14-块1：我的任务按 P0–P3 计数（环图） */
  priority: PriorityDistribution;
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
  /** 任务负责人（openId）：只保留「项目内含该负责人真叶子任务」的项目；空串 = 不过滤 */
  ownerOpenId?: string;
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
  /** D11：范围内待确认周报数（work_reports.status='已提交'） */
  pendingReportConfirm: number;
  /** D11：周报闭环率 0~100（已确认 / (已提交+已确认)） */
  reportClosureRate: number;
}

/**
 * 质量门状态聚合（D11 · 全局总览「门控总览」）。
 * `pending`（待决议）= 未开始 + 待检查；`total` = 五态之和。
 */
export interface GateStatusSummary {
  /** 已通过 */
  passed: number;
  /** 有条件通过 */
  conditional: number;
  /** 不通过 */
  failed: number;
  /** 待检查 */
  pendingCheck: number;
  /** 未开始 */
  notStarted: number;
  /** 待决议（未开始 + 待检查） */
  pending: number;
  /** 门总数 */
  total: number;
}

/**
 * 交付物聚合（D11 · 全局总览「交付物总览」）。
 * `baselineRate` = 已纳入基线数 / 总数（0~100）。
 */
export interface DeliverableSummary {
  /** 交付物登记总数 */
  total: number;
  /** 已交付 */
  delivered: number;
  /** 待交付 */
  pending: number;
  /** 已纳入基线 */
  baselined: number;
  /** 基线覆盖率 0~100 */
  baselineRate: number;
}

/**
 * 近 30 天到期里程碑聚合（第一批 · 全局总览「近 30 天到期里程碑」卡）。
 * 仅统计未完成（done_at IS NULL）且有计划日期（planned_date 非空）、
 * planned_date ≤ 今天+30 的里程碑；`overdue`（已过期）= planned_date < today。
 */
export interface MilestoneDueSummary {
  /** overdue + upcoming */
  total: number;
  /** 已过期（planned_date < today） */
  overdue: number;
  /** 未来 30 天（today ≤ planned_date ≤ today+30） */
  upcoming: number;
  /** 明细（按计划日期升序，至多 20 条，供后续下探直接渲染） */
  items: Array<{
    projectId: string;
    projectName: string;
    /** 里程碑名 */
    name: string;
    /** 计划日期 YYYY-MM-DD */
    plannedDate: string;
    /** 是否已过期 */
    overdue: boolean;
  }>;
  /** 第三批：按项目聚合（projectId → {total, overdue, upcoming}），明细表「近 30 天到期」列数据源 */
  byProject: Record<string, { total: number; overdue: number; upcoming: number }>;
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

/** 任务负责人选项（D01.5 · 全局总览「负责人」下拉数据源，服务端按姓名升序） */
export interface OwnerOption {
  /** 负责人 openId（wbs 叶子任务 owner；传给 query.ownerOpenId） */
  openId: string;
  /** 负责人姓名；用户已移除回落「(已移除)」 */
  name: string;
}

/**
 * 任务状态分布（B17 · P0-3 · 横向条形）
 * 档序恒按 TASK_STATUSES（待办 / 进行中 / 待评审 / 完成 / 阻塞）；
 * 后端聚合输入为「全量叶子任务（含已完成）」，脏状态不计入，
 * 故 total 可能略小于范围内叶子数（副标题「共 N 个任务（含已完成）」取 total）。
 */
export interface TaskStatusDistribution {
  待办: number;
  进行中: number;
  待评审: number;
  完成: number;
  阻塞: number;
  /** 五档之和 */
  total: number;
}

/**
 * 逾期时长分段（B17 · P0-4 · 横向条形）
 * 仅在办叶子任务中 isOverdue 者，days = diffDays(dueDate, today)；
 * 分段 1–7 / 8–30 / ≥31。total = 三段之和 = 顶部「逾期任务」卡数值。
 */
export interface OverdueDurationDistribution {
  days1to7: number;
  days8to30: number;
  daysOver30: number;
  /** 三段之和（可断言 = stats.overdueTasks） */
  total: number;
}

/* ==========================================================================
 * D01 · 本周工作进展面板（全局总览新增）
 * 对应 `DashboardOverview.weeklyProgress`，服务端 `computeWeeklyProgress` 聚合返回。
 * 口径：本周（ISO 周 · 周一~周日）。
 * ========================================================================== */

/** 周报任务进度行（D02 · 周报勾选的关键任务 before→after） */
export interface WeeklyTaskRowItem {
  /** WBS 编码 */
  nodeCode: string;
  /** 任务名 */
  nodeName: string;
  /** 周报提交前进度 0~100 */
  progressBefore: number;
  /** 周报提交后进度 0~100 */
  progressAfter: number;
}

/** 上周未提交周报的项目（D02 · 应填口径=进行中） */
export interface WeeklyMissingItem {
  projectId: string;
  projectName: string;
}

/** 任务进度环比单行（D03 · 上周 vs 前周全量快照对比） */
export interface TaskDeltaItem {
  /** wbs_nodes.id */
  nodeId: string;
  /** WBS 编码 */
  wbsCode: string;
  /** 任务名 */
  name: string;
  projectId: string;
  projectName: string;
  /** 前周快照进度 0~100；-1 = 前周无快照（新增任务） */
  prevProgress: number;
  /** 上周快照进度 0~100 */
  progress: number;
  /** progress - prevProgress（新增任务恒 0） */
  delta: number;
  /** 上周快照已达成完成（status=完成 或 progress=100） */
  done: boolean;
  /** 前周无快照（上周新出现/新分配的任务） */
  added: boolean;
}

/** 任务进度环比聚合（D03） */
export interface TaskDeltaSummary {
  /** 前周周码 'YYYY-Www' */
  prevWeek: string;
  /** 有变化的任务（推进/完成/新增/回退），按 delta 降序，最多 50 条 */
  tasks: TaskDeltaItem[];
  /** 推进任务数（delta > 0） */
  advancedCount: number;
  /** 完成数 */
  completedCount: number;
  /** 新增任务数 */
  addedCount: number;
  /** 净增百分点（Σ 正向 delta） */
  netPoints: number;
}

/** 里程碑双周对比（D03 · done_at 口径，无需快照） */
export interface MilestoneCompare {
  /** 前周周码 */
  prevWeek: string;
  /** 前周达成数（done_at ∈ [前周一, 前周日]） */
  prevDone: number;
  /** 上周达成数（= milestones.length） */
  lastDone: number;
}

/** 周报动态单行：上周（week=上周周码）范围内项目的周报 */
export interface WeeklyReportItem {
  /** 周报 id（work_reports.id） */
  id: string;
  projectId: string;
  projectName: string;
  /** 报告人姓名（author_name） */
  authorName: string;
  /** 周报状态：草稿 / 已提交 / 已确认 */
  status: string;
  /** 提交时间（ISO；草稿为 ''） */
  submittedAt: string;
  /** 最后更新时间（ISO） */
  updatedAt: string;
  /** 上周完成说明（done_note），未填为 '' */
  summary: string;
  /** D02：该周报勾选的任务进度明细（selected=1；无则空数组） */
  taskRows: WeeklyTaskRowItem[];
}

/** 本周任务进展单行：本周 updated_at 落在 ISO 周内的叶子任务（含进度更新与已完成） */
export interface TaskUpdatedItem {
  /** 节点 id（wbs_nodes.id） */
  id: string;
  projectId: string;
  projectName: string;
  /** WBS 编码，如 "1.2.3" */
  wbsCode: string;
  /** 任务名 */
  name: string;
  /** 负责人姓名；空 → 「未分配」 */
  ownerName: string;
  /** 任务状态（看板五态之一） */
  status: TaskStatus;
  /** 进度 0~100 */
  progress: number;
  /** 最后更新时间（ISO） */
  updatedAt: string;
  /** 是否已完成（status === '完成'），用于高亮 */
  done: boolean;
}

/** 本周达成里程碑单行：done_at（YYYY-MM-DD）落在 ISO 周内的里程碑 */
export interface MilestoneAchievedItem {
  /** 里程碑 id（milestones.id） */
  id: string;
  projectId: string;
  projectName: string;
  /** 里程碑名 */
  name: string;
  /** 达成日期 YYYY-MM-DD */
  doneAt: string;
}

/** 上周工作进展聚合（D01/D02/D03 面板数据源） */
export interface WeeklyProgress {
  /** 上周周码 'YYYY-Www'，用于面板副标题 */
  week: string;
  /** 周报动态列表（提交/更新倒序） */
  reports: WeeklyReportItem[];
  /** 上周任务进展列表（updated_at 倒序；完成后置 done=true） */
  tasks: TaskUpdatedItem[];
  /** 上周达成里程碑列表（done_at 倒序） */
  milestones: MilestoneAchievedItem[];
  /** D02：上周未提交周报的进行中项目（按项目名升序） */
  missing: WeeklyMissingItem[];
  /** D03：任务进度环比（上周 vs 前周全量快照） */
  delta: TaskDeltaSummary;
  /** D03：里程碑双周达成对比 */
  milestoneCompare: MilestoneCompare;
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
  /** B17：在办叶子任务按 P0–P3 计数（脏值兜底 P2；分母与 B14 工作台一致） */
  priorityDist: PriorityDistribution;
  /** B17：全量叶子任务（含已完成）按任务状态五档计数 */
  statusDist: TaskStatusDistribution;
  /** B17：在办叶子任务中已逾期者按 1–7 / 8–30 / >30 天分段 */
  overdueDuration: OverdueDurationDistribution;
  /** D11：范围内质量门状态聚合（门控总览） */
  gates: GateStatusSummary;
  /** D11：范围内交付物聚合（交付物总览） */
  deliverables: DeliverableSummary;
  /** 第一批：近 30 天到期里程碑（已过期 / 未来 30 天分段） */
  milestones: MilestoneDueSummary;
  /** 按「逾期 ↓ → 临期 ↓ → 项目名」排序，只含有逾期或临期的项目 */
  overdue: OverdueByProject[];
  /** 按「逾期 ↓ → 在办 ↓ → 姓名 ↑」排序，未分配恒最后 */
  ownerLoad: OwnerLoadRow[];
  reportMissing: ReportMissingRow[];
  /** D01：上周工作进展（周报动态 / 任务进展 / 达成里程碑） */
  weeklyProgress?: WeeklyProgress;
  /** D01.5：任务负责人选项池（「负责人」筛选下拉数据源） */
  ownerOptions?: OwnerOption[];
  /** 项目明细表（服务端分页），行点击可钻取至 B11 单项目仪表盘 */
  projects: Paged<ProjectListItem>;
}

/* ==========================================================================
 * B13 · 逾期 / 临期任务下探抽屉
 * 点击「逾期/临期报表」里某项目 → 右侧抽屉展示该项目的逾期 / 临期任务明细。
 * ========================================================================== */

/** 抽屉 Tab 字面量：默认 'overdue'（先救最急的） */
export type OverdueDrawerTab = 'overdue' | 'dueSoon';

/** 进度环三段字面量（B15 新增）：'done'=完成 / 'active'=在办(进行中+待评审) / 'pending'=未启动(待办+阻塞) */
export type ProgressSegment = 'done' | 'active' | 'pending';

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
  /** 负责人 openId（WbsNode.owner）；用于「仅看我负责」筛选，空 → 未分配 */
  ownerId: string;
  /** 计划完成日 YYYY-MM-DD */
  dueDate: string;
  /** 任务状态（看板五态之一） */
  status: TaskStatus;
  /** 进度 0~100 */
  progress: number;
  /** 所属里程碑名（milestoneId 解析；无 → 「未关联」） */
  milestoneName: string;
  /** 任务优先级（B14-块1）；脏值兜底 `P2` */
  priority: Priority;
  /** 排序权重 `PRIORITY_RANK[priority]`，升序即 P0 置顶（B14-块1） */
  priorityRank: number;
  /** 所属项目 id（B15 新增：全局模式跨项目行跳转用；单项目模式亦填充 = projectId） */
  projectId: string;
  /** 所属项目名（B15 新增：全局模式「所属项目」列；单项目模式亦填充 = projectName） */
  projectName: string;
}

/* ==========================================================================
 * B18 · 分布图点档下钻任务明细抽屉
 * 点击优先级 / 状态 / 逾期时长分布图某档 → 右侧抽屉展示该档任务明细。
 * 对应后端接口 `GET /api/dashboard/tasks`（本批唯一新接口）。
 * ========================================================================== */

/** 逾期档位字面量（与服务端 portfolioAgg.overdueBucketOf 返回一致） */
export type OverdueBucket = '1to7' | '8to30' | 'over30';

/**
 * 任务明细抽屉查询入参：总览筛选子集 + 维度参数（三选一互斥）+ 分页。
 * 不含 overview 的 timeRange / sort（服务端忽略）；page/pageSize 由抽屉内部追加。
 */
export interface DashboardTasksQuery {
  scope?: DashboardScope;
  type?: ProjectType | '';
  status?: ProjectStatus | '';
  health?: Health | '';
  keyword?: string;
  onlyMine?: boolean;
  /** 维度：优先级（P0-P3；脏值由服务端兜底 P2） */
  priority?: Priority;
  /** 维度：任务状态（五档；命中时基数含已完成） */
  taskStatus?: TaskStatus;
  /** 维度：逾期档位（1to7 / 8to30 / over30） */
  overdueBucket?: OverdueBucket;
  page?: number;
  pageSize?: number;
}

/** 任务明细抽屉表格行（服务端返回字段，与 PRD P0-7 逐字一致） */
export interface DashboardTaskRow {
  id: string;
  projectId: string;
  projectName: string;
  wbsCode: string;
  name: string;
  priority: Priority;
  status: TaskStatus;
  dueDate: string;
  progress: number;
  ownerName: string;
}
