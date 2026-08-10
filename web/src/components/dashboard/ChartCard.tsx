/**
 * 图表统一外壳（B11 · T04）
 *
 * 职责：把「标题 / 副标题 / 固定高度 / 加载态 / 空态 / 图表本体」收敛到一处，
 * 保证三张图**等高、同间距、同空态范式**，避免各画各的（SK-B11-6）。
 *
 * 🚫 本文件属图表层：**禁止** import `tokens` / `alphaOf`（SK-B11-1）。
 *    外壳只用 MUI 主题语义色（`text.secondary` 等 CSS 变量在 DOM 上没问题，
 *    出问题的只有写进 SVG 属性的颜色）—— 但为免误用，本文件一律不碰颜色常量。
 *
 * @prd B11
 */

import type { ReactNode } from 'react';
import { Box, Skeleton, Stack, Typography } from '@mui/material';

import { EmptyState, SectionCard } from '@/components/common';

/** 三图统一的绘图区高度（px）。改这里 = 三图同时改，保证等高 */
export const CHART_BODY_HEIGHT = 216;

export interface ChartCardProps {
  /** 卡片标题 */
  title: string;
  /** 副标题（通常放口径说明或总数） */
  subtitle?: string;
  /** 右上角操作区（如「查看全部」） */
  actions?: ReactNode;
  /** 加载中：渲染骨架而非图表 */
  loading?: boolean;
  /**
   * 是否空数据。为 `true` 时渲染 `EmptyState`（正向文案由 `emptyTitle` 决定），
   * **不渲染空坐标轴**（SK-B11-6）。
   */
  empty?: boolean;
  /** 空态主文案 */
  emptyTitle?: string;
  /** 空态副文案 */
  emptyDescription?: string;
  /** 图表本体 */
  children: ReactNode;
  /** 图表下方的图例 / 说明区（空态时不渲染） */
  footer?: ReactNode;
}

/**
 * 图表卡片：`SectionCard` + 固定高度绘图区 + 载/空/正常三态。
 *
 * ```tsx
 * <ChartCard title="我的任务进度" empty={summary.total === 0} emptyTitle="暂无进行中的任务">
 *   <PieChart ... />
 * </ChartCard>
 * ```
 */
export function ChartCard({
  title,
  subtitle = '',
  actions,
  loading = false,
  empty = false,
  emptyTitle = '暂无数据',
  emptyDescription = '',
  children,
  footer,
}: ChartCardProps): JSX.Element {
  return (
    <SectionCard
      title={title}
      subtitle={subtitle}
      actions={actions}
      sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <Stack sx={{ height: '100%' }} spacing={1}>
        <Box
          sx={{
            height: CHART_BODY_HEIGHT,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            minWidth: 0,
          }}
        >
          {loading ? (
            <Skeleton variant="rounded" width="100%" height={CHART_BODY_HEIGHT - 16} />
          ) : empty ? (
            <EmptyState title={emptyTitle} description={emptyDescription} dense />
          ) : (
            children
          )}
        </Box>

        {!loading && !empty && footer ? <Box sx={{ pt: 0.5 }}>{footer}</Box> : null}
      </Stack>
    </SectionCard>
  );
}

export interface ChartLegendItem {
  /** 图例色块（真 hex，来自 `useChartPalette()`） */
  color: string;
  /** 图例文案 */
  label: string;
  /** 数量 */
  value: number;
  /** 点击下钻；不传则不可点 */
  onClick?: () => void;
}

/**
 * 图表图例（三图共用，保证图例视觉一致）。
 *
 * 色块用 `bgcolor` 走 DOM 样式（不是 SVG 属性），传入真 hex 天然安全。
 */
export function ChartLegend({ items }: { items: ChartLegendItem[] }): JSX.Element {
  return (
    <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap justifyContent="center">
      {items.map((it) => (
        <Stack
          key={it.label}
          direction="row"
          spacing={0.75}
          alignItems="center"
          onClick={it.onClick}
          sx={{
            cursor: it.onClick ? 'pointer' : 'default',
            borderRadius: 1,
            px: 0.5,
            transition: 'opacity .15s',
            '&:hover': it.onClick ? { opacity: 0.7 } : {},
          }}
        >
          <Box sx={{ width: 9, height: 9, borderRadius: '2px', bgcolor: it.color, flexShrink: 0 }} />
          <Typography variant="caption" color="text.secondary">
            {it.label} {it.value}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}
