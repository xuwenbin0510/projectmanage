import { Chip } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';
import { alphaOf as alpha, colorOf, toneOf } from '@/theme/tokens';

interface StatusChipProps {
  status: string;
  /** 覆盖显示文案（默认用 status 本身） */
  label?: string;
  size?: 'small' | 'medium';
  variant?: 'soft' | 'outlined' | 'dot';
  sx?: SxProps<Theme>;
}

/**
 * 语义状态标签 —— 颜色全部来自 token 映射，禁止调用方传色值
 * @prd 全局
 */
export function StatusChip({
  status,
  label,
  size = 'small',
  variant = 'soft',
  sx = {},
}: StatusChipProps): JSX.Element {
  const color = colorOf(status);
  const tone = toneOf(status);

  if (variant === 'dot') {
    return (
      <Chip
        size={size}
        label={label ?? status}
        sx={{
          bgcolor: 'transparent',
          color: 'text.primary',
          border: 'none',
          pl: 0,
          '&::before': {
            content: '""',
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: color,
            mr: 1,
            boxShadow: `0 0 6px ${alpha(color, 0.8)}`,
          },
          ...sx,
        }}
      />
    );
  }

  return (
    <Chip
      size={size}
      label={label ?? status}
      data-tone={tone}
      sx={{
        fontWeight: 500,
        bgcolor: variant === 'soft' ? alpha(color, 0.16) : 'transparent',
        color,
        border: `1px solid ${alpha(color, variant === 'outlined' ? 0.6 : 0.32)}`,
        ...sx,
      }}
    />
  );
}
