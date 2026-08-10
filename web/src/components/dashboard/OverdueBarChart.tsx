/**
 * 逾期任务分布柱状图（B11 · T04）
 *
 * 横向 `BarChart`，按项目分组，两个序列：「已逾期」/「临期 ≤3 天」。
 *
 * 配色：**风险类 → 语义三色**（设计 §1.4 第 91 行「逾期序列着色」）。
 * 一张图内只用一套色系：本图全部取自 `palette.health`，不混品牌色阶。
 *
 * ══════════════════════════════════════════════════════════════════
 * 🚫 SK-B11-1：本文件**禁止** import `tokens` / `alphaOf` / `colorOf`。
 * ══════════════════════════════════════════════════════════════════
 *
 * @prd B11
 */

import { Box } from '@mui/material';
import { BarChart } from '@mui/x-charts/BarChart';

import type { OverdueByProject } from '@/types/dashboard';
import { useChartPalette } from '@/theme/chartPalette';
import { ChartCard, ChartLegend, CHART_BODY_HEIGHT } from './ChartCard';

export interface OverdueBarChartProps {
  /** `aggregateOverdue()` 的结果（已按逾期数降序，且只含有逾期/临期的项目） */
  rows: OverdueByProject[];
  /** 加载中 */
  loading?: boolean;
  /**
   * 最多展示的项目数（超出截断，避免柱子被压扁到不可读）。
   *
   * B12：默认由 5 → **8**。工作台（B11）只看「我的」项目，5 条够用；
   * 全局总览横跨全公司，5 条会把风险项目挡在外面（SK-B12-8）。
   */
  maxRows?: number;
}

/** 项目名过长时截断，保证 y 轴标签不撑爆绘图区 */
function shortName(name: string, max = 8): string {
  const n = String(name || '');
  return n.length > max ? `${n.slice(0, max)}…` : n;
}

/**
 * 逾期任务分布（按项目）。
 *
 * 无逾期 / 无临期时走正向空态「太好了，没有逾期任务 🎉」，
 * **不画空坐标轴**（SK-B11-6）。
 */
export function OverdueBarChart({
  rows,
  loading = false,
  maxRows = 8,
}: OverdueBarChartProps): JSX.Element {
  const palette = useChartPalette();

  const list = (Array.isArray(rows) ? rows : []).slice(0, Math.max(1, maxRows));
  const empty = list.length === 0;

  const totalOverdue = list.reduce((s, r) => s + r.overdue, 0);
  const totalSoon = list.reduce((s, r) => s + r.dueSoon, 0);

  const dataset = list.map((r) => ({
    project: shortName(r.projectName),
    fullName: r.projectName,
    overdue: r.overdue,
    dueSoon: r.dueSoon,
  }));

  return (
    <ChartCard
      title="逾期 / 临期任务"
      subtitle={empty ? '' : `${list.length} 个项目 · 逾期 ${totalOverdue} · 临期 ${totalSoon}`}
      loading={loading}
      empty={empty}
      emptyTitle="太好了，没有逾期任务 🎉"
      emptyDescription="所有任务都在计划节奏内"
      footer={
        <ChartLegend
          items={[
            { color: palette.health.red, label: '已逾期', value: totalOverdue },
            { color: palette.health.yellow, label: '临期 ≤3 天', value: totalSoon },
          ]}
        />
      }
    >
      <Box sx={{ width: '100%', height: CHART_BODY_HEIGHT }}>
        <BarChart
          dataset={dataset}
          layout="horizontal"
          height={CHART_BODY_HEIGHT}
          margin={{ top: 8, right: 16, bottom: 24, left: 76 }}
          grid={{ vertical: true }}
          slotProps={{ legend: { hidden: true } }}
          /* 类目/柱间距沿用 x-charts v7 默认值（0.2 / 0.1）：
             其 TS 类型只在窄化后的 band 轴配置上暴露，显式传值会触发
             `AxisConfig<keyof AxisScaleConfig>` 的多余属性检查，得不偿失 */
          yAxis={[
            {
              scaleType: 'band',
              dataKey: 'project',
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
              dataKey: 'overdue',
              label: '已逾期',
              color: palette.health.red,
              valueFormatter: (v) => `${v ?? 0} 个`,
            },
            {
              dataKey: 'dueSoon',
              label: '临期 ≤3 天',
              color: palette.health.yellow,
              valueFormatter: (v) => `${v ?? 0} 个`,
            },
          ]}
          borderRadius={3}
        />
      </Box>
    </ChartCard>
  );
}
