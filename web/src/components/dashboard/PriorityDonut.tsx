/**
 * 任务优先级分布环（B14-块1）
 *
 * 与 `ProgressDonut` 同构的**薄封装**：渲染逻辑全部复用通用 `DonutChart`，
 * 本文件只负责「`PriorityDistribution` → `DonutSegment[]`」的语义映射与配色。
 *
 * 配色分层（决策 D-B11-2）：优先级表达的是「急不急」= **风险类**，
 * 因此用 `palette.health` 语义色而非品牌色阶：
 *   P0 红(health.red) / P1 黄橙(health.yellow) / P2 品牌蓝(brandMain) / P3 灰(track)
 *
 * 中心大字取 **P0 + P1 之和**（「需要马上处理的任务数」），比总数更有行动指导性。
 *
 * ══════════════════════════════════════════════════════════════════
 * 🚫 SK-B11-1：本文件**禁止** import `tokens` / `alphaOf` / `colorOf`。
 *    颜色一律经 `useChartPalette()` 取真 hex（SVG 属性不解析 CSS 变量）。
 * ══════════════════════════════════════════════════════════════════
 *
 * @prd B14
 */

import type { PriorityDistribution } from '@/types/dashboard';
import type { Priority } from '@/types/wbs';
import { useChartPalette } from '@/theme/chartPalette';
import { DonutChart, type DonutSegment } from './DonutChart';

export interface PriorityDonutProps {
  /** `aggregatePriorityDistribution()` 的结果 */
  dist: PriorityDistribution;
  /** 加载中 */
  loading?: boolean;
  /** 点击某段下钻（如跳 WBS 并带上优先级筛选）；不传则不可点 */
  onDrill?: (priority: Priority) => void;
}

/**
 * 优先级分布环。
 *
 * `dist.total === 0` 时走 `ChartCard` 空态，**不会**渲染 `NaN`。
 */
export function PriorityDonut({ dist, loading = false, onDrill }: PriorityDonutProps): JSX.Element {
  const palette = useChartPalette();

  const segments: DonutSegment[] = [
    { id: 'P0', label: 'P0 最高', value: dist.P0, color: palette.health.red },
    { id: 'P1', label: 'P1 高', value: dist.P1, color: palette.health.yellow },
    { id: 'P2', label: 'P2 中', value: dist.P2, color: palette.brandMain },
    { id: 'P3', label: 'P3 低', value: dist.P3, color: palette.track },
  ];

  /* 需要马上处理的量级 = P0 + P1；中心色随该值是否为 0 在红 / 品牌色间切换 */
  const urgent = dist.P0 + dist.P1;

  return (
    <DonutChart
      title="任务优先级分布"
      subtitle={dist.total > 0 ? `共 ${dist.total} 个未完成任务` : ''}
      segments={segments}
      centerValue={String(urgent)}
      centerLabel="P0+P1 待处理"
      centerColor={urgent > 0 ? palette.health.red : palette.brandStrong}
      loading={loading}
      empty={dist.total === 0}
      emptyTitle="暂无进行中的任务"
      emptyDescription="没有需要按优先级排期的任务"
      onSegmentClick={onDrill ? (seg) => onDrill(seg.id as Priority) : undefined}
    />
  );
}
