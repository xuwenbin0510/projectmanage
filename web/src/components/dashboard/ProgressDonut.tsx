/**
 * 我的任务进度环（B11 · T04）
 *
 * 环形图（`PieChart` + `innerRadius`），中心叠加「总完成度 %」大字。
 * 三段：`完成` / `在办(进行中+待评审)` / `未启动(待办+阻塞)`。
 *
 * 配色：**量级类 → 品牌色阶**（D-B11-2），从深到浅表达权重递减。
 *
 * ══════════════════════════════════════════════════════════════════
 * 🚫 SK-B11-1：本文件**禁止** import `tokens` / `alphaOf` / `colorOf`。
 *    图表颜色写进 SVG presentation attribute，`var()` 与 `color-mix()`
 *    都不会被解析 → 必须用 `useChartPalette()` 拿真 hex。
 * ══════════════════════════════════════════════════════════════════
 *
 * @prd B11
 */

import { Box, Typography } from '@mui/material';
import { PieChart } from '@mui/x-charts/PieChart';

import type { TaskProgressSummary } from '@/types/dashboard';
import { useChartPalette } from '@/theme/chartPalette';
import { ChartCard, ChartLegend, CHART_BODY_HEIGHT } from './ChartCard';

export interface ProgressDonutProps {
  /** `aggregateTaskProgress()` 的结果 */
  summary: TaskProgressSummary;
  /** 加载中 */
  loading?: boolean;
}

/** 环形图内外半径（px）——外径略小于绘图区高度的一半，给 tooltip 留呼吸位 */
const OUTER_RADIUS = 78;
const INNER_RADIUS = 52;

/**
 * 我的任务进度环。
 *
 * `summary.total === 0` 时走 `ChartCard` 空态「暂无进行中的任务」，
 * **不会**渲染 `NaN`（T04 完成标准 #3）。
 */
export function ProgressDonut({ summary, loading = false }: ProgressDonutProps): JSX.Element {
  const palette = useChartPalette();

  /* 品牌色阶：完成(最深) → 在办 → 未启动(最浅)，同一色系表达量级 */
  const segments = [
    { id: 'done', label: '已完成', value: summary.done, color: palette.brand[0] },
    { id: 'active', label: '在办', value: summary.active, color: palette.brand[1] },
    { id: 'pending', label: '未启动', value: summary.pending, color: palette.brand[2] },
  ];

  /* 值为 0 的段不进 series，避免 tooltip 出现「已完成 0」这类空扇区 */
  const data = segments.filter((s) => s.value > 0);

  return (
    <ChartCard
      title="我的任务进度"
      subtitle={summary.total > 0 ? `共 ${summary.total} 个未完成任务` : ''}
      loading={loading}
      empty={summary.total === 0}
      emptyTitle="暂无进行中的任务"
      emptyDescription="分配给你的任务都已完成"
      footer={<ChartLegend items={segments.map((s) => ({ color: s.color, label: s.label, value: s.value }))} />}
    >
      <Box sx={{ position: 'relative', width: '100%', height: CHART_BODY_HEIGHT }}>
        <PieChart
          height={CHART_BODY_HEIGHT}
          margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
          slotProps={{ legend: { hidden: true } }}
          series={[
            {
              data,
              innerRadius: INNER_RADIUS,
              outerRadius: OUTER_RADIUS,
              paddingAngle: data.length > 1 ? 2 : 0,
              cornerRadius: 3,
              startAngle: -90,
              endAngle: 270,
              highlightScope: { faded: 'global', highlighted: 'item' },
              valueFormatter: (v) => `${v.value} 个`,
            },
          ]}
        />

        {/* 中心「总完成度 %」：DOM 叠加而非 SVG text，避免半径变化时错位 */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <Typography sx={{ fontSize: 26, fontWeight: 700, lineHeight: 1.1, color: palette.brandStrong }}>
            {summary.completionRate}%
          </Typography>
          <Typography variant="caption" color="text.secondary">
            总完成度
          </Typography>
        </Box>
      </Box>
    </ChartCard>
  );
}
