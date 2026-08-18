/**
 * 任务优先级标签（B14-块1）
 *
 * 复用 `StatusChip` 的取色链路（`theme/tokens#TONE_MAP` 已登记 `P0..P3`），
 * 因此 **零重复配色**：P0 红(danger) / P1 橙(warning) / P2 蓝(brand) / P3 灰(neutral)。
 *
 * 文案与提示语来自 `config/enums#PRIORITY_OPTIONS`（单一真源 · SK-B14-1），
 * 组件不硬编码任何 `['P0','P1',...]` 字面量。
 */
import { Tooltip } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';

import { StatusChip } from './StatusChip';
import { PRIORITY_OPTIONS, normalizePriority } from '@/config/enums';

export interface PriorityChipProps {
  /** 优先级；脏值 / 缺失自动兜底 `P2` */
  priority: unknown;
  size?: 'small' | 'medium';
  /** `short` 只显示 `P0`（表格内省空间）；`full` 显示 `P0 最高` */
  variant?: 'short' | 'full';
  /** 是否包 Tooltip 展示含义（默认 true） */
  withTooltip?: boolean;
  sx?: SxProps<Theme>;
}

/**
 * 优先级色标 Chip。
 *
 * @example
 * <PriorityChip priority={node.priority} />          // 表格内：P0 + 红色
 * <PriorityChip priority="P1" variant="full" />      // 详情内：P1 高 + 橙色
 */
export function PriorityChip({
  priority,
  size = 'small',
  variant = 'short',
  withTooltip = true,
  sx = {},
}: PriorityChipProps): JSX.Element {
  const value = normalizePriority(priority);
  const option = PRIORITY_OPTIONS.find((o) => o.value === value) ?? PRIORITY_OPTIONS[2];
  const label = variant === 'full' ? option.label : value;

  const chip = <StatusChip status={value} label={label} size={size} sx={{ fontWeight: 600, ...sx }} />;

  if (!withTooltip) return chip;
  return (
    <Tooltip title={`${option.label} · ${option.hint}`} arrow>
      <span style={{ display: 'inline-flex' }}>{chip}</span>
    </Tooltip>
  );
}
