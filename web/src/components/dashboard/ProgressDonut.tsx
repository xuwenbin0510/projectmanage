/**
 * 我的任务进度环（B11 · T04 → B12 · T04 泛化）
 *
 * 环形图，中心叠加「总完成度 %」大字。
 * 三段：`完成` / `在办(进行中+待评审)` / `未启动(待办+阻塞)`。
 *
 * ── B12 变更（SK-B12-8 复用边界）──────────────────────
 * 渲染逻辑已抽到通用 `DonutChart`，本文件降为**薄封装**：
 *  - props 签名 `{ summary: TaskProgressSummary; loading?: boolean }` **完全不变**；
 *  - `WorkbenchPage.tsx` 的 `<ProgressDonut summary={dashboard.progress} />` **零改动**；
 *  - 视觉与 B11 逐字一致（品牌色阶三段、0 值段进图例不进环、空态文案照旧）。
 *
 * 配色：**量级类 → 品牌色阶**（D-B11-2），从深到浅表达权重递减。
 *
 * ══════════════════════════════════════════════════════════════════
 * 🚫 SK-B11-1：本文件**禁止** import `tokens` / `alphaOf` / `colorOf`。
 *    颜色一律经 `useChartPalette()` 取真 hex。
 * ══════════════════════════════════════════════════════════════════
 *
 * @prd B11
 */

import type { ProgressSegment, TaskProgressSummary } from '@/types/dashboard';
import { useChartPalette } from '@/theme/chartPalette';
import { DonutChart, type DonutSegment } from './DonutChart';

export interface ProgressDonutProps {
  /** `aggregateTaskProgress()` 的结果 */
  summary: TaskProgressSummary;
  /** 加载中 */
  loading?: boolean;
  /** B15 新增：点击某段（含图例 0 值段）下钻；不传则不可点（与 PriorityDonut 现行为一致） */
  onDrill?: (segment: ProgressSegment) => void;
}

/**
 * 我的任务进度环。
 *
 * `summary.total === 0` 时走 `ChartCard` 空态「暂无进行中的任务」，
 * **不会**渲染 `NaN`（T04 完成标准 #3）。
 */
export function ProgressDonut({ summary, loading = false, onDrill }: ProgressDonutProps): JSX.Element {
  const palette = useChartPalette();

  /* 品牌色阶：完成(最深) → 在办 → 未启动(最浅)，同一色系表达量级 */
  const segments: DonutSegment[] = [
    { id: 'done', label: '已完成', value: summary.done, color: palette.brand[0] },
    { id: 'active', label: '在办', value: summary.active, color: palette.brand[1] },
    { id: 'pending', label: '未启动', value: summary.pending, color: palette.brand[2] },
  ];

  return (
    <DonutChart
      title="我的任务进度"
      subtitle={
        summary.total > 0
          ? `共 ${summary.total} 个任务 · 已完成 ${summary.done}`
          : ''
      }
      segments={segments}
      centerValue={`${summary.completionRate}%`}
      centerLabel="总完成度"
      loading={loading}
      empty={summary.total === 0}
      emptyTitle="暂无进行中的任务"
      emptyDescription="分配给你的任务都已完成"
      onSegmentClick={onDrill ? (seg) => onDrill(seg.id as ProgressSegment) : undefined}
    />
  );
}
