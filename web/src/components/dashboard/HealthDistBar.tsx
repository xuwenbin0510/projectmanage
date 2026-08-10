/**
 * 项目健康度分布（B11 · T04）
 *
 * 单行**堆叠**横向 `BarChart`（绿 / 黄 / 红），下方图例含数量，
 * 点击图例段可下钻到项目列表（`ROUTES.projects`）。
 *
 * 配色：**风险类 → 语义三色**（D-B11-2）。健康度「绿黄红」是 PMO 通用心智，
 * 改用青蓝深浅反而降低可读性；语义三色本身低饱和，与品牌青蓝共存不冲突。
 *
 * ══════════════════════════════════════════════════════════════════
 * 🚫 SK-B11-1：本文件**禁止** import `tokens` / `alphaOf` / `colorOf`。
 * ══════════════════════════════════════════════════════════════════
 *
 * @prd B11
 */

import { Box, Stack, Typography } from '@mui/material';
import { BarChart } from '@mui/x-charts/BarChart';

import type { HealthDistribution } from '@/types/dashboard';
import type { Health } from '@/types/project';
import { useChartPalette } from '@/theme/chartPalette';
import { ChartCard, ChartLegend, CHART_BODY_HEIGHT } from './ChartCard';

export interface HealthDistBarProps {
  /** `aggregateHealth()` 的结果 */
  dist: HealthDistribution;
  /** 加载中 */
  loading?: boolean;
  /** 下钻回调：点击图例 / 色段时触发，参数为被点击的健康档 */
  onDrill?: (health: Health) => void;
}

/** 堆叠条高度（px）——单行条不需要占满绘图区，剩余空间给占比文字 */
const BAR_HEIGHT = 78;

/** 百分比（整数）；total=0 时返回 0，不产生 NaN */
function pct(v: number, total: number): number {
  if (!total) return 0;
  return Math.round((v / total) * 100);
}

/**
 * 项目健康度分布（单行堆叠条）。
 *
 * 无在办项目时走空态「暂未参与在办项目」（SK-B11-6）。
 */
export function HealthDistBar({ dist, loading = false, onDrill }: HealthDistBarProps): JSX.Element {
  const palette = useChartPalette();
  const empty = dist.total === 0;

  const rows: Array<{ key: Health; label: string; value: number; color: string }> = [
    { key: 'green', label: '健康', value: dist.green, color: palette.health.green },
    { key: 'yellow', label: '预警', value: dist.yellow, color: palette.health.yellow },
    { key: 'red', label: '风险', value: dist.red, color: palette.health.red },
  ];

  return (
    <ChartCard
      title="项目健康度分布"
      subtitle={empty ? '' : `${dist.total} 个在办项目`}
      loading={loading}
      empty={empty}
      emptyTitle="暂未参与在办项目"
      emptyDescription="加入项目后这里会显示健康度分布"
      footer={
        <ChartLegend
          items={rows.map((r) => ({
            color: r.color,
            label: r.label,
            value: r.value,
            onClick: onDrill ? () => onDrill(r.key) : undefined,
          }))}
        />
      }
    >
      <Stack sx={{ width: '100%', height: CHART_BODY_HEIGHT }} justifyContent="center" spacing={1}>
        <Box sx={{ width: '100%', height: BAR_HEIGHT }}>
          <BarChart
            dataset={[{ bucket: '在办项目', green: dist.green, yellow: dist.yellow, red: dist.red }]}
            layout="horizontal"
            height={BAR_HEIGHT}
            margin={{ top: 4, right: 8, bottom: 22, left: 8 }}
            slotProps={{ legend: { hidden: true } }}
            /* 类目间距沿用 v7 默认 0.2（条高 ≈ 绘图区 80%），
               显式传值会触发 band 轴配置的多余属性检查，故不传 */
            yAxis={[
              {
                scaleType: 'band',
                dataKey: 'bucket',
                disableLine: true,
                disableTicks: true,
                /* 单行条不需要 y 轴文字（卡片标题已说明），隐藏以让出宽度 */
                tickLabelStyle: { display: 'none' },
              },
            ]}
            xAxis={[{ min: 0, tickMinStep: 1, tickLabelStyle: { fill: palette.axis, fontSize: 11 } }]}
            series={[
              {
                dataKey: 'green',
                label: '健康',
                color: palette.health.green,
                stack: 'health',
                valueFormatter: (v) => `${v ?? 0} 个`,
              },
              {
                dataKey: 'yellow',
                label: '预警',
                color: palette.health.yellow,
                stack: 'health',
                valueFormatter: (v) => `${v ?? 0} 个`,
              },
              {
                dataKey: 'red',
                label: '风险',
                color: palette.health.red,
                stack: 'health',
                valueFormatter: (v) => `${v ?? 0} 个`,
              },
            ]}
            borderRadius={3}
          />
        </Box>

        {/* 占比明细：图表之外的纯 DOM 文本，可无障碍读取，也补足单行条的信息密度 */}
        <Stack direction="row" spacing={2} justifyContent="center" flexWrap="wrap" useFlexGap>
          {rows.map((r) => (
            <Stack
              key={r.key}
              alignItems="center"
              onClick={onDrill ? () => onDrill(r.key) : undefined}
              sx={{ cursor: onDrill ? 'pointer' : 'default', minWidth: 56 }}
            >
              <Typography sx={{ fontSize: 18, fontWeight: 700, color: r.color, lineHeight: 1.2 }}>
                {pct(r.value, dist.total)}%
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {r.label}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </Stack>
    </ChartCard>
  );
}
