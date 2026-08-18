/**
 * 通用环形图（B12 · T04）
 *
 * 由 B11 的 `ProgressDonut` 泛化而来：把「环 + 中心大字 + 图例 + 空态」
 * 抽成与业务无关的壳子，`ProgressDonut`（我的任务进度）与 B12 的
 * 「项目状态分布环」共用同一份渲染逻辑，避免两份几乎一样的 PieChart。
 *
 * 语义约定（与 B11 保持逐字一致，保证工作台视觉零变化）：
 *  - **图例**渲染 `segments` 全量（含 0 值段，便于用户知道该维度存在但为空）；
 *  - **环体**只渲染 `value > 0` 的段（避免 tooltip 出现「XX 0」的空扇区）；
 *  - `empty` 不传时按 `sum(values) === 0` 自动判空，走 `ChartCard` 空态。
 *
 * ══════════════════════════════════════════════════════════════════
 * 🚫 SK-B11-1 / SK-B12-1：本文件**禁止** import `tokens` / `alphaOf` / `colorOf`。
 *    图表颜色写进 SVG presentation attribute，`var()` 与 `color-mix()`
 *    都不会被解析 → 必须用 `useChartPalette()` 拿真 hex。
 * ══════════════════════════════════════════════════════════════════
 *
 * @prd B12
 */

import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';
import { PieChart } from '@mui/x-charts/PieChart';

import { useChartPalette } from '@/theme/chartPalette';
import { ChartCard, ChartLegend, CHART_BODY_HEIGHT } from './ChartCard';

/** 环形图单段 */
export interface DonutSegment {
  /** 段唯一标识（用于 React key 与下钻回调识别） */
  id: string;
  /** 图例文案 */
  label: string;
  /** 数值（0 值段进图例不进环体） */
  value: number;
  /**
   * 段颜色（真 hex）。不传时按品牌色阶 `palette.brand` 依次自动分配，
   * 保证「量级类图表用一套品牌色系」（D-B11-2）。
   */
  color?: string;
}

export interface DonutChartProps {
  /** 卡片标题 */
  title: string;
  /** 副标题（放口径说明或总数） */
  subtitle?: string;
  /** 环形分段数据 */
  segments: DonutSegment[];
  /** 中心大字（如 `62%` 或 `18`） */
  centerValue: string;
  /** 中心小字（如「总完成度」） */
  centerLabel?: string;
  /** 中心大字颜色（真 hex）；缺省取 `palette.brandStrong` */
  centerColor?: string;
  /** 加载中 */
  loading?: boolean;
  /** 是否空数据；不传时按各段之和是否为 0 自动判定 */
  empty?: boolean;
  /** 空态主文案 */
  emptyTitle?: string;
  /** 空态副文案 */
  emptyDescription?: string;
  /** 卡片右上角操作区 */
  actions?: ReactNode;
  /** tooltip 数值单位（默认「个」） */
  unit?: string;
  /** 点击环上某段（或对应图例）下钻；不传则不可点 */
  onSegmentClick?: (segment: DonutSegment) => void;
  /** 是否渲染底部图例（默认 true） */
  showLegend?: boolean;
}

/** 环形图内外半径（px）——外径略小于绘图区高度的一半，给 tooltip 留呼吸位 */
const OUTER_RADIUS = 78;
const INNER_RADIUS = 52;

/**
 * 通用环形图。
 *
 * ```tsx
 * <DonutChart
 *   title="项目状态分布"
 *   segments={[{ id: '进行中', label: '进行中', value: 12 }]}
 *   centerValue="12"
 *   centerLabel="在管项目"
 * />
 * ```
 */
export function DonutChart({
  title,
  subtitle = '',
  segments,
  centerValue,
  centerLabel = '',
  centerColor,
  loading = false,
  empty,
  emptyTitle = '暂无数据',
  emptyDescription = '',
  actions,
  unit = '个',
  onSegmentClick,
  showLegend = true,
}: DonutChartProps): JSX.Element {
  const palette = useChartPalette();

  /* 补齐颜色：未显式指定的段按品牌色阶轮转取色（真 hex，可直接进 SVG） */
  const list: Required<DonutSegment>[] = (Array.isArray(segments) ? segments : []).map((s, i) => ({
    id: String(s.id),
    label: String(s.label),
    value: Number.isFinite(s.value) ? s.value : 0,
    color: s.color || palette.brand[i % palette.brand.length],
  }));

  const total = list.reduce((n, s) => n + s.value, 0);
  const isEmpty = typeof empty === 'boolean' ? empty : total === 0;

  /* 值为 0 的段不进 series，避免 tooltip 出现「XX 0」这类空扇区 */
  const data = list.filter((s) => s.value > 0);

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      actions={actions}
      loading={loading}
      empty={isEmpty}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      footer={
        showLegend ? (
          <ChartLegend
            items={list.map((s) => ({
              color: s.color,
              label: s.label,
              value: s.value,
              onClick: onSegmentClick ? () => onSegmentClick(s) : undefined,
            }))}
          />
        ) : null
      }
    >
      <Box
        sx={{
          position: 'relative',
          width: '100%',
          height: CHART_BODY_HEIGHT,
          cursor: onSegmentClick ? 'pointer' : 'default',
        }}
      >
        <PieChart
          height={CHART_BODY_HEIGHT}
          margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
          slotProps={{ legend: { hidden: true } }}
          onItemClick={
            onSegmentClick
              ? (_event, identifier) => {
                  const seg = data[identifier.dataIndex];
                  if (seg) onSegmentClick(seg);
                }
              : undefined
          }
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
              valueFormatter: (v) => `${v.value} ${unit}`,
            },
          ]}
        />

        {/* 中心大字：DOM 叠加而非 SVG text，避免半径变化时错位 */}
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
          <Typography
            sx={{ fontSize: 26, fontWeight: 700, lineHeight: 1.1, color: centerColor || palette.brandStrong }}
          >
            {centerValue}
          </Typography>
          {centerLabel ? (
            <Typography variant="caption" color="text.secondary">
              {centerLabel}
            </Typography>
          ) : null}
        </Box>
      </Box>
    </ChartCard>
  );
}
