/**
 * 健康分布环形图（B17 · T02）
 *
 * 薄封装 `DonutChart`：把「健康分布」映射为红黄绿三段环形图，
 * 中心值 = 需关注项目数（red + yellow），中心色三态，
 * 副标题 = 「{total} 个在办项目」，下钻透传 `onDrill(health)`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 🚫 SK-B11-1 / SK-B12-1：本文件**禁止** import `tokens` / `alphaOf` / `colorOf`。
 *    颜色一律经 `useChartPalette()` 取真 hex（可直接进 SVG）。
 * ══════════════════════════════════════════════════════════════════
 *
 * @prd B17
 */

import { useChartPalette } from '@/theme/chartPalette';
import type { HealthDistribution } from '@/types/dashboard';
import type { Health } from '@/types/project';
import { DonutChart } from './DonutChart';
import type { DonutSegment } from './DonutChart';

export interface HealthDonutProps {
  /** aggregateHealth() 的结果 */
  dist: HealthDistribution;
  loading?: boolean;
  /** 下钻回调：点击环段 / 图例时触发，参数为被点击健康档（B12 行为不变） */
  onDrill?: (health: Health) => void;
}

/**
 * 健康分布环形图（纯薄封装，无自有 state）。
 *
 * 中心值 = red + yellow（需关注项目），中心色三态：
 * 有红 → health.red；仅黄 → health.yellow；全绿 → brandStrong。
 * 空态（总览口径）：`dist.total === 0` → 「当前范围暂无在办项目」。
 */
export function HealthDonut({
  dist,
  loading = false,
  onDrill,
}: HealthDonutProps): JSX.Element {
  const palette = useChartPalette();

  const d = dist ?? { green: 0, yellow: 0, red: 0, total: 0 };

  const segments: DonutSegment[] = [
    { id: 'green', label: '正常', value: d.green, color: palette.health.green },
    { id: 'yellow', label: '预警', value: d.yellow, color: palette.health.yellow },
    { id: 'red', label: '风险', value: d.red, color: palette.health.red },
  ];

  const needsAttention = d.red + d.yellow;
  const centerColor =
    d.red > 0 ? palette.health.red : d.yellow > 0 ? palette.health.yellow : palette.brandStrong;

  return (
    <DonutChart
      title="项目健康度分布"
      subtitle={d.total > 0 ? `${d.total} 个在办项目` : ''}
      segments={segments}
      centerValue={String(needsAttention)}
      centerLabel="需关注项目"
      centerColor={centerColor}
      loading={loading}
      empty={d.total === 0}
      emptyTitle="当前范围暂无在办项目"
      emptyDescription="切换范围或调整筛选条件试试"
      onSegmentClick={onDrill ? (seg) => onDrill(seg.id as Health) : undefined}
    />
  );
}
