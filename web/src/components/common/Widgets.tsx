import type { ReactNode } from 'react';
import { Avatar, Box, LinearProgress, Paper, Stack, Tooltip, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';
import { alphaOf as alpha, tokens, toneColor } from '@/theme/tokens';
import type { SemanticTone } from '@/theme/tokens';

/* ── 统计卡片 ─────────────────────────────────────── */

interface StatCardProps {
  label: string;
  value: number | string;
  unit?: string;
  tone?: SemanticTone;
  hint?: string;
  icon?: ReactNode;
  onClick?: () => void;
}

/** 工作台统计卡片 */
export function StatCard({
  label,
  value,
  unit = '',
  tone = 'brand',
  hint = '',
  icon,
  onClick,
}: StatCardProps): JSX.Element {
  const color = toneColor[tone];
  return (
    <Paper
      variant="outlined"
      onClick={onClick}
      sx={{
        p: 2.25,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color .18s, transform .18s',
        '&:hover': onClick ? { borderColor: alpha(color, 0.65), transform: 'translateY(-2px)' } : {},
      }}
    >
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary">
            {label}
          </Typography>
          <Stack direction="row" alignItems="baseline" spacing={0.5} sx={{ mt: 0.5 }}>
            <Typography sx={{ fontSize: 30, fontWeight: 600, lineHeight: 1.1, color }}>{value}</Typography>
            {unit && (
              <Typography variant="body2" color="text.secondary">
                {unit}
              </Typography>
            )}
          </Stack>
          {hint && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
              {hint}
            </Typography>
          )}
        </Box>
        {icon && (
          <Box
            sx={{
              width: 38,
              height: 38,
              borderRadius: 1.5,
              display: 'grid',
              placeItems: 'center',
              bgcolor: alpha(color, 0.14),
              color,
              flexShrink: 0,
            }}
          >
            {icon}
          </Box>
        )}
      </Stack>
    </Paper>
  );
}

/* ── 进度条 ───────────────────────────────────────── */

interface ProgressBarProps {
  value: number;
  tone?: SemanticTone;
  showLabel?: boolean;
  height?: number;
  sx?: SxProps<Theme>;
}

/** 带数值的进度条 */
export function ProgressBar({
  value,
  tone = 'brand',
  showLabel = true,
  height = 6,
  sx = {},
}: ProgressBarProps): JSX.Element {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const color = toneColor[tone];
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 90, ...sx }}>
      <LinearProgress
        variant="determinate"
        value={v}
        sx={{
          flex: 1,
          height,
          borderRadius: height,
          bgcolor: alpha(tokens.text.secondary, 0.18),
          '& .MuiLinearProgress-bar': { bgcolor: color, borderRadius: height },
        }}
      />
      {showLabel && (
        <Typography variant="caption" color="text.secondary" sx={{ width: 34, textAlign: 'right' }}>
          {v}%
        </Typography>
      )}
    </Stack>
  );
}

/* ── 用户头像 ─────────────────────────────────────── */

interface UserAvatarProps {
  name: string;
  size?: number;
  tooltip?: string;
}

/** 姓名首字头像（无图时使用） */
export function UserAvatar({ name, size = 28, tooltip }: UserAvatarProps): JSX.Element {
  const initial = name ? name.slice(-2) : '?';
  const hash = Array.from(name || '?').reduce((s, c) => s + c.charCodeAt(0), 0);
  const palette = [tokens.brand.primary, tokens.status.success, tokens.status.warning, tokens.status.neutral];
  const color = palette[hash % palette.length];
  return (
    <Tooltip title={tooltip ?? name} arrow>
      <Avatar
        sx={{
          width: size,
          height: size,
          fontSize: size * 0.4,
          bgcolor: alpha(color, 0.2),
          color,
          border: `1px solid ${alpha(color, 0.4)}`,
        }}
      >
        {initial}
      </Avatar>
    </Tooltip>
  );
}

/* ── 键值行 ───────────────────────────────────────── */

interface FieldRowProps {
  label: string;
  children: ReactNode;
  labelWidth?: number;
}

/** 详情页键值展示行 */
export function FieldRow({ label, children, labelWidth = 96 }: FieldRowProps): JSX.Element {
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start">
      <Typography variant="body2" color="text.secondary" sx={{ width: labelWidth, flexShrink: 0 }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1, minWidth: 0, fontSize: 14 }}>{children}</Box>
    </Stack>
  );
}
