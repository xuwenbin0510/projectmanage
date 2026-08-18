/**
 * 工作台仪表盘聚合层 · 纯函数模块（B11 · SK-B11-5）
 *
 * ══════════════════════════════════════════════════════════════════
 * 🚫 本文件**零 React 依赖**：不 import react / MUI / store / 组件，
 *    无副作用，输入输出确定 —— 可被 `scripts/qa_b11_verify.mjs` 直接
 *    import 断言，也便于 P2 把逻辑平移到服务端。
 *
 * ⚠️ SK-B11-4 日期口径**唯一来源** = `utils/date.ts`：
 *      逾期 = `diffDays(today(), dueDate) < 0`
 *      临期 = 非逾期 且 `diffDays(today(), dueDate) <= 3`
 *    与 `server/services/workbench.service.js#countOverdue` 逐字一致。
 *    🚫 禁止在本文件出现 `new Date()` / 手撸字符串比较，否则前后端数字对不上。
 *
 * 📐 §1.3：本期**不新增** `GET /api/dashboard`。三张图所需原子数据
 *    已全在 `GET /api/workbench` 的返回值里，服务端再聚合一次收益为零。
 * ══════════════════════════════════════════════════════════════════
 *
 * @prd B11
 */

import type {
  DashboardSummary,
  HealthDistribution,
  OverdueBucket,
  OverdueByProject,
  OverdueDurationDistribution,
  PriorityDistribution,
  TaskProgressSummary,
  TaskStatusDistribution,
} from '@/types/dashboard';
import type { ProjectListItem } from '@/types/project';
import type { Priority, TaskStatus, WbsNode } from '@/types/wbs';
import type { WorkbenchData } from '@/types/workbench';
import { diffDays, isOverdue, today } from '@/utils/date';
import { PRIORITIES, TASK_STATUSES, normalizePriority, priorityRankOf } from '@/config/enums';

/** 临期阈值（天）：与 `WorkbenchPage` 既有 `soon` 判定一致 */
export const DUE_SOON_DAYS = 3;

/** 项目名缺失时的兜底文案（T04 完成标准 #4 的第三级回落） */
export const UNNAMED_PROJECT = '未命名项目';

/** 逾期：`diffDays(today, dueDate) < 0`（空 dueDate 恒 false） */
function overdueOf(dueDate: string | null | undefined): boolean {
  if (!dueDate) return false;
  return diffDays(today(), dueDate) < 0;
}

/** 临期：非逾期 且 `diffDays(today, dueDate) <= DUE_SOON_DAYS`（空 dueDate 恒 false） */
function dueSoonOf(dueDate: string | null | undefined): boolean {
  if (!dueDate) return false;
  const d = diffDays(today(), dueDate);
  return d >= 0 && d <= DUE_SOON_DAYS;
}

/**
 * 进度环聚合：按 `status` 三段计数 + 总完成度。
 *
 * 分段口径（§1.3 表格）：
 * - `done`    = `完成`
 * - `active`  = `进行中` + `待评审`
 * - `pending` = `待办` + `阻塞`
 *
 * > 说明：`GET /api/workbench` 的 `myTasks` 已在服务端滤掉 `status === '完成'`
 * > （`workbench.service.js#listMyTasks`），因此实际数据里 `done` 通常为 0，
 * > 环形图会渲染成两段。这里**仍按完整口径实现**：一来与设计文档逐字对齐，
 * > 二来若将来放开过滤（或复用本函数聚合 WBS 全量节点）无需改代码。
 *
 * `completionRate` = 所有任务 `progress` 的算术平均（四舍五入取整），
 * `total === 0` 时恒为 `0`（**不返回 NaN**，T04 完成标准 #3）。
 *
 * @param tasks 我的任务（`WorkbenchData.myTasks`）
 */
export function aggregateTaskProgress(tasks: WbsNode[]): TaskProgressSummary {
  const list = Array.isArray(tasks) ? tasks : [];
  const total = list.length;

  if (total === 0) {
    return { total: 0, done: 0, active: 0, pending: 0, completionRate: 0 };
  }

  let done = 0;
  let active = 0;
  let pending = 0;
  let progressSum = 0;

  list.forEach((t) => {
    switch (t.status) {
      case '完成':
        done += 1;
        break;
      case '进行中':
      case '待评审':
        active += 1;
        break;
      case '待办':
      case '阻塞':
      default:
        pending += 1;
        break;
    }
    const p = Number(t.progress);
    progressSum += Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
  });

  return {
    total,
    done,
    active,
    pending,
    completionRate: Math.round(progressSum / total),
  };
}

/**
 * 逾期柱状聚合：按项目分组统计「已逾期 / 临期(≤3d)」。
 *
 * 项目名三级回落（T04 完成标准 #4）：
 * `task.projectName`（B11 服务端追加）→ join `myProjects` → `未命名项目`。
 * 之所以优先用服务端字段：`myTasks` 可能含「草稿 / 审批中 / 挂起」项目的任务，
 * 而 `myProjects` 只列在办项目，纯前端 join 会漏名。
 *
 * 返回值**只含有逾期或临期的项目**（两者皆 0 的项目不出现在柱状图里），
 * 排序：逾期数 ↓ → 临期数 ↓ → 项目名 ↑。
 *
 * @param tasks    我的任务
 * @param projects 我的在办项目（用于项目名回落，可传空数组）
 */
export function aggregateOverdue(
  tasks: WbsNode[],
  projects: ProjectListItem[] = [],
): OverdueByProject[] {
  const list = Array.isArray(tasks) ? tasks : [];
  const projectList = Array.isArray(projects) ? projects : [];

  const nameById = new Map<string, string>();
  projectList.forEach((p) => {
    if (p && p.id) nameById.set(p.id, p.name || '');
  });

  const byProject = new Map<string, OverdueByProject>();

  list.forEach((t) => {
    const overdue = overdueOf(t.dueDate);
    const soon = !overdue && dueSoonOf(t.dueDate);
    if (!overdue && !soon) return;

    const pid = t.projectId || '';
    let row = byProject.get(pid);
    if (!row) {
      const name = t.projectName || nameById.get(pid) || UNNAMED_PROJECT;
      row = { projectId: pid, projectName: name, overdue: 0, dueSoon: 0 };
      byProject.set(pid, row);
    }
    if (overdue) row.overdue += 1;
    else row.dueSoon += 1;
  });

  return Array.from(byProject.values()).sort((a, b) => {
    if (a.overdue !== b.overdue) return b.overdue - a.overdue;
    if (a.dueSoon !== b.dueSoon) return b.dueSoon - a.dueSoon;
    return a.projectName.localeCompare(b.projectName, 'zh-CN');
  });
}

/**
 * 健康分布聚合：`myProjects[].health` 按 `green / yellow / red` 计数。
 *
 * 非法 / 缺失 `health` 一律不计入任何一档（`total` 仍只统计三档之和，
 * 保证 `green + yellow + red === total` 恒成立）。
 *
 * @param projects 我的在办项目
 */
export function aggregateHealth(projects: ProjectListItem[]): HealthDistribution {
  const list = Array.isArray(projects) ? projects : [];
  let green = 0;
  let yellow = 0;
  let red = 0;

  list.forEach((p) => {
    switch (p.health) {
      case 'green':
        green += 1;
        break;
      case 'yellow':
        yellow += 1;
        break;
      case 'red':
        red += 1;
        break;
      default:
        break;
    }
  });

  return { green, yellow, red, total: green + yellow + red };
}

/**
 * 优先级分布聚合（B14-块1 · 环图数据源）。
 *
 * 口径：
 * - 逐个任务按 `priority` 落到 P0–P3 四档；**脏值 / 缺失一律兜底 `P2`**
 *   （复用 `config/enums#normalizePriority`，与后端 `toApiWbsNode` 的 `toStr(row.priority,'P2')` 同口径）。
 * - `total` = 四档之和 = 入参有效元素个数，故 `P0+P1+P2+P3 === total` 恒成立。
 * - 空数组 → 全零（**不返回 NaN**），组件据 `total === 0` 渲染空态。
 *
 * ⚠️ 不做「过滤已完成」：本图是「我手上任务的优先级构成」，
 * 而 `GET /api/workbench#myTasks` 服务端已滤掉 `完成`，二次过滤属重复口径。
 * 若调用方传入项目全量 WBS 需要排除已完成，请在调用前自行过滤。
 *
 * @param nodes 任务列表（`WorkbenchData.myTasks` 或 `api.listWbs` 的结果）
 */
export function aggregatePriorityDistribution(nodes: WbsNode[]): PriorityDistribution {
  const list = Array.isArray(nodes) ? nodes : [];
  const counts: Record<Priority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };

  list.forEach((n) => {
    counts[normalizePriority(n?.priority)] += 1;
  });

  return {
    P0: counts.P0,
    P1: counts.P1,
    P2: counts.P2,
    P3: counts.P3,
    total: PRIORITIES.reduce((sum, p) => sum + counts[p], 0),
  };
}

/**
 * 按优先级升序比较（**P0 置顶**），同级再按截止日升序（早的在前，空值垫底）。
 *
 * B14-块1 的排序**单一实现**：逾期清单、抽屉明细、待办中心任务类分组全部复用本函数，
 * 禁止在组件里手写 `a.priority < b.priority`（字符串比较会把 P0 排到最后是错的口径反例，
 * 且无法处理脏值）。
 */
export function comparePriority(
  a: { priority?: unknown; dueDate?: string | null },
  b: { priority?: unknown; dueDate?: string | null },
): number {
  const rank = priorityRankOf(a?.priority) - priorityRankOf(b?.priority);
  if (rank !== 0) return rank;
  /* 同优先级：截止日早的靠前；无截止日恒垫底 */
  const da = a?.dueDate || '';
  const db = b?.dueDate || '';
  if (!da && !db) return 0;
  if (!da) return 1;
  if (!db) return -1;
  return da.localeCompare(db);
}

/**
 * 按优先级排序（不改原数组，返回新数组）。
 *
 * @param nodes 任务列表
 */
export function sortByPriority<T extends { priority?: unknown; dueDate?: string | null }>(
  nodes: T[],
): T[] {
  return (Array.isArray(nodes) ? [...nodes] : []).sort(comparePriority);
}

/**
 * 仪表盘总聚合入口：一次调用产出四张图所需的全部数据。
 *
 * 在 `WorkbenchPage` 里用 `useMemo(() => buildDashboard(data), [data])` 包裹，
 * 保证筛选 / 重渲染时零重复计算。
 *
 * @param data `GET /api/workbench` 返回值；`null`/`undefined` 时返回全零结构（不抛异常）
 */
export function buildDashboard(data: WorkbenchData | null | undefined): DashboardSummary {
  const tasks = data?.myTasks ?? [];
  const projects = data?.myProjects ?? [];

  return {
    progress: aggregateTaskProgress(tasks),
    overdue: aggregateOverdue(tasks, projects),
    health: aggregateHealth(projects),
    /* B14-块1：优先级分布环图 */
    priority: aggregatePriorityDistribution(tasks),
  };
}

/**
 * 任务状态分布聚合（B17 · 与后端 portfolioAgg.aggregateStatusDist 逐字一致）。
 * 入参 = 全量叶子任务（含已完成）；档序按 TASK_STATUSES；脏状态不计入。
 */
export function aggregateStatusDist(nodes: WbsNode[]): TaskStatusDistribution {
  const list = Array.isArray(nodes) ? nodes : [];
  const counts: Record<TaskStatus, number> = { 待办: 0, 进行中: 0, 待评审: 0, 完成: 0, 阻塞: 0 };
  list.forEach((n) => {
    const s = n?.status;
    if (!s || !(s in counts)) return; // 脏状态不计入
    counts[s] += 1;
  });
  return { ...counts, total: TASK_STATUSES.reduce((sum, s) => sum + counts[s], 0) };
}

/**
 * 逾期时长分段聚合（B17 · 与后端 portfolioAgg.aggregateOverdueDuration 逐字一致）。
 * 入参 = 在办叶子任务；逾期判定复用 utils/date#isOverdue（dayjs isBefore today，空 dueDate 恒 false）；
 * days = diffDays(dueDate, todayStr)；分段 1–7 / 8–30 / ≥31。
 */
export function aggregateOverdueDuration(
  nodes: WbsNode[],
  todayStr: string = today(),
): OverdueDurationDistribution {
  const list = Array.isArray(nodes) ? nodes : [];
  const dist = { days1to7: 0, days8to30: 0, daysOver30: 0, total: 0 };
  list.forEach((n) => {
    if (!n?.dueDate || !isOverdue(n.dueDate)) return;
    const days = diffDays(n.dueDate, todayStr);
    if (days <= 7) dist.days1to7 += 1;
    else if (days <= 30) dist.days8to30 += 1;
    else dist.daysOver30 += 1;
    dist.total += 1;
  });
  return dist;
}

/**
 * 逾期档位（B18 · 镜像 server/lib/portfolioAgg.js#overdueBucketOf）。
 * 入参 = 截止日（+ 可选 todayStr）；未逾期（含今天到期）/ 无 dueDate → null。
 * days = diffDays(dueDate, todayStr)；分段 1–7 / 8–30 / ≥31。
 * 供 mock 按档过滤与 QA 断言，杜绝前后端分段漂移。
 */
export function overdueBucketOf(
  dueDate: string | null | undefined,
  todayStr: string = today(),
): OverdueBucket | null {
  if (!dueDate) return null;
  const days = diffDays(dueDate, todayStr);
  if (days < 1) return null;
  if (days <= 7) return '1to7';
  if (days <= 30) return '8to30';
  return 'over30';
}

/**
 * 按日期口径把 WBS 节点拆成「逾期 / 临期」两组（B13 · 下探抽屉过滤的**单一真相**）。
 *
 * 口径与 `aggregateOverdue` / 后端 `countOverdue` 逐字一致：
 * - 逾期 = `diffDays(today(), dueDate) < 0`
 * - 临期 = `0 <= diffDays(today(), dueDate) <= DUE_SOON_DAYS(3)`
 * - 过滤掉 `status === '完成'`（只计在办）
 *
 * ⚠️ 返回的是**原始 WbsNode**（不是视图模型）：里程碑名解析（`milestoneId → name`）
 * 依赖 `GET /api/.../milestones`，需调用方（抽屉）在拿到 milestones 后再做映射，
 * 本函数保持纯日期判定、零外部依赖，便于被脚本直接断言。
 *
 * @param nodes 项目全量 WBS 扁平节点（`api.listWbs` 的返回值）
 */
export function splitOverdueByStatus(nodes: WbsNode[]): {
  overdue: WbsNode[];
  dueSoon: WbsNode[];
} {
  const list = Array.isArray(nodes) ? nodes : [];
  const overdue: WbsNode[] = [];
  const dueSoon: WbsNode[] = [];

  list.forEach((t) => {
    /* 已完成的不计入风险（与 B12 / 后端逐字一致） */
    if (t.status === '完成') return;
    const isOver = overdueOf(t.dueDate);
    const isSoon = !isOver && dueSoonOf(t.dueDate);
    if (isOver) overdue.push(t);
    else if (isSoon) dueSoon.push(t);
  });

  return { overdue, dueSoon };
}
