import type { ReactNode } from 'react';
import { Alert, Box, Button, CircularProgress, Skeleton, Stack, Typography } from '@mui/material';
import { messageOf } from '@/types/api';

/* ── 空态 ─────────────────────────────────────────── */

interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  dense?: boolean;
}

/** 统一空态 */
export function EmptyState({
  title = '暂无数据',
  description = '',
  icon,
  action,
  dense = false,
}: EmptyStateProps): JSX.Element {
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={1.5}
      sx={{ py: dense ? 4 : 8, px: 2, textAlign: 'center', color: 'text.secondary' }}
    >
      {icon ?? (
        <Box
          sx={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            border: '1px dashed',
            borderColor: 'divider',
            display: 'grid',
            placeItems: 'center',
            fontSize: 24,
          }}
        >
          ✧
        </Box>
      )}
      <Typography variant="subtitle1" color="text.primary">
        {title}
      </Typography>
      {description && (
        <Typography variant="body2" sx={{ maxWidth: 420 }}>
          {description}
        </Typography>
      )}
      {action}
    </Stack>
  );
}

/* ── 加载态 ───────────────────────────────────────── */

interface LoadingStateProps {
  variant?: 'spinner' | 'skeleton' | 'card';
  rows?: number;
  height?: number;
  label?: string;
}

/** 统一加载态 */
export function LoadingState({
  variant = 'spinner',
  rows = 4,
  height = 56,
  label = '加载中…',
}: LoadingStateProps): JSX.Element {
  if (variant === 'skeleton') {
    return (
      <Stack spacing={1.25} sx={{ py: 1 }}>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} variant="rounded" height={height} animation="wave" />
        ))}
      </Stack>
    );
  }
  if (variant === 'card') {
    return (
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' } }}>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} variant="rounded" height={160} animation="wave" />
        ))}
      </Box>
    );
  }
  return (
    <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ py: 6, color: 'text.secondary' }}>
      <CircularProgress size={28} />
      <Typography variant="body2">{label}</Typography>
    </Stack>
  );
}

/* ── 错误态 ───────────────────────────────────────── */

interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
}

/** 统一错误态（自动映射 ApiError 中文文案） */
export function ErrorState({ error, onRetry }: ErrorStateProps): JSX.Element {
  return (
    <Alert
      severity="error"
      sx={{ my: 2 }}
      action={
        onRetry ? (
          <Button color="inherit" size="small" onClick={onRetry}>
            重试
          </Button>
        ) : undefined
      }
    >
      {messageOf(error)}
    </Alert>
  );
}
