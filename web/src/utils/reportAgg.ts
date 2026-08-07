import type { Report } from '@/types/report';

/**
 * WBS 节点日志聚合纯函数（R3-5）。
 *
 * 口径约定（与 ReportsPage 列表「关联任务数」严格同源）：
 * 「某节点被勾选关联」 = `report.tasks` 中存在 `nodeId` 命中且 `selected === true` 的行。
 * 一律经本文件计算，禁止页面自行 for 循环推导（SK：计数唯一真源）。
 */

/**
 * 每个 WBS 节点被勾选关联的日志条数。
 *
 * @param reports 项目全部工作日志（flowStore.reports）
 * @returns `Map<nodeId, count>`；未命中节点取值 `0`
 */
export function reportCountByNode(reports: Report[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of reports) {
    for (const t of r.tasks) {
      if (t.selected) counts.set(t.nodeId, (counts.get(t.nodeId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * 某节点关联的全部日志：按 `createdAt` 升序。
 * 每条日志在弹窗中取该节点 `selected` 行用于展示进度 before → after。
 *
 * @param reports 项目全部工作日志（flowStore.reports）
 * @param nodeId  WBS 节点 id
 * @returns 关联日志（createdAt 升序）；无关联时为空数组
 */
export function nodeReportsOf(reports: Report[], nodeId: string): Report[] {
  return reports
    .filter((r) => r.tasks.some((t) => t.nodeId === nodeId && t.selected))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}
