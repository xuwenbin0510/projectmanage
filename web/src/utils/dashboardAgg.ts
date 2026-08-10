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
  OverdueByProject,
  TaskProgressSummary,
} from '@/types/dashboard';
import type { ProjectListItem } from '@/types/project';
import type { WbsNode } from '@/types/wbs';
import type { WorkbenchData } from '@/types/workbench';
import { diffDays, today } from '@/utils/date';

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
 * 仪表盘总聚合入口：一次调用产出三张图所需的全部数据。
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
  };
}
