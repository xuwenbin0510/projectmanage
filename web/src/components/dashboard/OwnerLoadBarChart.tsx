/**
 * 负责人负荷横向柱状图（B12 · T04 · P1-2）
 *
 * 每个负责人一行，两个序列：
 *  - **在办**（叶子任务且 `status !== '完成'`）→ 品牌色 `palette.brand[1]`（量级）
 *  - **逾期**（在办中 `diffDays(today, dueDate) < 0`）→ `palette.health.red`（风险）
 *
 * ⚠ 口径提示（决策 ③）：「负荷 = 在办任务数 + 逾期数」中的逾期是**在办的子集**，
 *   因此两序列采用**分组柱**而非堆叠柱，否则会把同一批任务数得两遍。
 *   副标题显式标注该口径，避免被判「数据对不上」。
 *
 * 排序由服务端 `portfolioAgg.aggregateOwnerLoad` 给定（SK-B12-10）：
 *   逾期 ↓ → 在办 ↓ → 姓名 ↑，未分配恒最后。本组件**不再重排**，只截断 Top N。
 *
 * ══════════════════════════════════════════════════════════════════
 * 🚫 SK-B11-1 / SK-B12-1：本文件**禁止** import `tokens` / `alphaOf` / `colorOf`。
 * ══════════════════════════════════════════════════════════════════
 *
 * @prd B12
 */

import { Box } from '@mui/material';
import { BarChart } from '@mui/x-charts/BarChart';

import type { OwnerLoadRow } from '@/types/dashboard';
import { useChartPalette } from '@/theme/chartPalette';
import { ChartCard, ChartLegend, CHART_BODY_HEIGHT } from './ChartCard';

export interface OwnerLoadBarChartProps {
  /** 服务端 `ownerLoad`（已按 SK-B12-10 排好序） */
  rows: OwnerLoadRow[];
  /** 加载中 */
  loading?: boolean;
  /** 最多展示的负责人数（超出截断，避免柱子被压扁到不可读） */
  maxRows?: number;
  /** 点击柱子下钻（打开 `OwnerLoadDrawer`）；不传则不可点 */
  onDrill?: (row: OwnerLoadRow) => void;
}

/** 姓名过长时截断，保证 y 轴标签不撑爆绘图区 */
function shortName(name: string, max = 6): string {
  const n = String(name || '');
  return n.length > max ? `${n.slice(0, max)}…` : n;
}

/**
 * 负责人负荷（按人聚合的在办 / 逾期任务数）。
 *
 * 范围内没有在办任务时走正向空态，**不画空坐标轴**（SK-B11-6）。
 */
export function OwnerLoadBarChart({
  rows,
  loading = false,
  maxRows = 8,
  onDrill,
}: OwnerLoadBarChartProps): JSX.Element {
  const palette = useChartPalette();

  const list = (Array.isArray(rows) ? rows : []).slice(0, Math.max(1, maxRows));
  const empty = list.length === 0;

  const totalActive = list.reduce((s, r) => s + r.activeTasks, 0);
  const totalOverdue = list.reduce((s, r) => s + r.overdueTasks, 0);

  const dataset = list.map((r) => ({
    owner: shortName(r.ownerName),
    fullName: r.ownerName,
    activeTasks: r.activeTasks,
    overdueTasks: r.overdueTasks,
  }));

  return (
    <ChartCard
      title="任务负责人负荷"
      subtitle={
        empty
          ? ''
          : `Top ${list.length} · 在办 ${totalActive} · 其中逾期 ${totalOverdue}`
      }
      loading={loading}
      empty={empty}
      emptyTitle="暂无在办任务"
      emptyDescription="当前统计范围内没有未完成的任务"
      footer={
        <ChartLegend
          items={[
            { color: palette.brand[1], label: '在办', value: totalActive },
            { color: palette.health.red, label: '其中逾期', value: totalOverdue },
          ]}
        />
      }
    >
      <Box sx={{ width: '100%', height: CHART_BODY_HEIGHT, cursor: onDrill ? 'pointer' : 'default' }}>
        <BarChart
          dataset={dataset}
          layout="horizontal"
          height={CHART_BODY_HEIGHT}
          margin={{ top: 8, right: 16, bottom: 24, left: 68 }}
          grid={{ vertical: true }}
          slotProps={{ legend: { hidden: true } }}
          onItemClick={
            onDrill
              ? (_event, identifier) => {
                  const row = list[identifier.dataIndex];
                  if (row) onDrill(row);
                }
              : undefined
          }
          /* 类目/柱间距沿用 x-charts v7 默认值（0.2 / 0.1）：
             其 TS 类型只在窄化后的 band 轴配置上暴露，显式传值会触发
             `AxisConfig<keyof AxisScaleConfig>` 的多余属性检查，得不偿失 */
          yAxis={[
            {
              scaleType: 'band',
              dataKey: 'owner',
              tickLabelStyle: { fill: palette.axis, fontSize: 11 },
            },
          ]}
          xAxis={[
            {
              min: 0,
              tickMinStep: 1,
              tickLabelStyle: { fill: palette.axis, fontSize: 11 },
            },
          ]}
          series={[
            {
              dataKey: 'activeTasks',
              label: '在办',
              color: palette.brand[1],
              valueFormatter: (v) => `${v ?? 0} 个`,
            },
            {
              dataKey: 'overdueTasks',
              label: '其中逾期',
              color: palette.health.red,
              valueFormatter: (v) => `${v ?? 0} 个`,
            },
          ]}
          borderRadius={3}
        />
      </Box>
    </ChartCard>
  );
}
