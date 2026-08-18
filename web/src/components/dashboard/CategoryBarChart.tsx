/**
 * 通用横向条形图（B17 · T02）
 *
 * 供「任务优先级分布 / 任务状态分布 / 逾期时长分段」三张图复用：
 * 单档一色、无下钻（P0-5 只展示），tooltip 显示「N 个 · P%」，
 * footer 图例展示各档数量（0 值档也显示，`ChartLegend` 默认行为）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 🚫 SK-B11-1 / SK-B12-1：本文件**禁止** import `tokens` / `alphaOf` / `colorOf`。
 *    颜色全部由调用方传入真 hex（半透明用 `hexAlpha` 预乘），
 *    组件内只调 `useChartPalette()` 取 `palette.axis`。
 * ══════════════════════════════════════════════════════════════════
 *
 * @prd B17
 */

import { Box } from '@mui/material';
import { BarChart } from '@mui/x-charts/BarChart';

import { useChartPalette } from '@/theme/chartPalette';
import { ChartCard, ChartLegend, CHART_BODY_HEIGHT } from './ChartCard';

/** 单档（调用方已定 label / 颜色，组件不感知业务） */
export interface CategoryBarRow {
  /** 唯一标识（React key / series 索引对齐） */
  key: string;
  /** y 轴刻度 + 图例文案（如「P0 最高」「待办」「逾期 1–7 天」） */
  label: string;
  value: number;
  /** 真 hex（调用方经 useChartPalette 取色；半透明用 hexAlpha 预乘） */
  color: string;
}

export interface CategoryBarChartProps {
  title: string;
  subtitle?: string;
  rows: CategoryBarRow[];
  loading?: boolean;
  /** 空态；不传时按 sum(rows[].value) === 0 自动判定（与 DonutChart 一致） */
  empty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  /** tooltip / 图例单位（默认「个」） */
  unit?: string;
  /**
   * 点击某档柱体或 footer 图例触发，参数 = 该档 key（如 'P0' / '进行中' / '8to30'）。
   * 0 值档也可点（图例点击，打开空态抽屉）；**不传则不可点（原行为）**。
   */
  onDrill?: (key: string) => void;
}

/**
 * 通用横向条形图（掩码多 series 逐档着色）。
 *
 * x-charts 的 `BarSeriesType.color` 只接受单一颜色，无法按数据项逐档着色，
 * 故每档一个 series、`data` 仅对应档位索引有值、其余 `null`（PRD P0-5 拍板）：
 * 每个类目只有它自己的 series 有值 → 一根单色柱，逐档颜色独立。
 *
 * 空态 / 加载由 `ChartCard` 分支处理，空态不画坐标轴（SK-B11-6）。
 */
export function CategoryBarChart({
  title,
  subtitle = '',
  rows,
  loading = false,
  empty,
  emptyTitle = '暂无数据',
  emptyDescription = '',
  unit = '个',
  onDrill,
}: CategoryBarChartProps): JSX.Element {
  const palette = useChartPalette();

  const list = (Array.isArray(rows) ? rows : []).map((r) => ({
    key: String(r.key),
    label: String(r.label),
    value: Number.isFinite(r.value) ? r.value : 0,
    color: String(r.color || ''),
  }));

  const total = list.reduce((s, r) => s + r.value, 0);
  const isEmpty = typeof empty === 'boolean' ? empty : total === 0;
  const pct = (v: number): number => (total ? Math.round((v / total) * 100) : 0);

  const dataset = list.map((r) => ({ category: r.label }));

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      loading={loading}
      empty={isEmpty}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      footer={
        <ChartLegend
          items={list.map((r) => ({
            color: r.color,
            label: r.label,
            value: r.value,
            onClick: onDrill ? () => onDrill(r.key) : undefined,
          }))}
        />
      }
    >
      <Box sx={{ width: '100%', height: CHART_BODY_HEIGHT, cursor: onDrill ? 'pointer' : 'default' }}>
        <BarChart
          dataset={dataset}
          layout="horizontal"
          height={CHART_BODY_HEIGHT}
          margin={{ top: 8, right: 16, bottom: 24, left: 76 }}
          grid={{ vertical: true }}
          slotProps={{ legend: { hidden: true } }}
          onItemClick={
            onDrill
              ? (_event, identifier) => {
                  const r = list[identifier.dataIndex];
                  if (r) onDrill(r.key);
                }
              : undefined
          }
          /* 类目/柱间距沿用 x-charts v7 默认值（0.2 / 0.1）：
             其 TS 类型只在窄化后的 band 轴配置上暴露，显式传值会触发
             `AxisConfig<keyof AxisScaleConfig>` 的多余属性检查（参考 OverdueBarChart） */
          yAxis={[
            {
              scaleType: 'band',
              dataKey: 'category',
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
          series={list.map((r, i) => ({
            /* 掩码：仅第 i 档有值，其余 null → 每个类目只有自己的单色柱 */
            data: list.map((_, j) => (j === i ? r.value : null)),
            label: r.label,
            color: r.color,
            valueFormatter: (v) => (v == null ? '' : `${v} ${unit} · ${pct(v)}%`),
          }))}
          borderRadius={3}
        />
      </Box>
    </ChartCard>
  );
}
