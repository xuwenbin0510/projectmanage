import { useCallback, useMemo } from 'react';
import { useSnackbar } from 'notistack';
import { messageOf } from '@/types/api';

/** 统一提示 hook：成功 / 失败（自动映射 ApiError 中文文案） */
export function useToast(): {
  success: (msg: string) => void;
  error: (e: unknown, fallback?: string) => void;
  info: (msg: string) => void;
  warning: (msg: string) => void;
} {
  const { enqueueSnackbar } = useSnackbar();

  const success = useCallback(
    (msg: string) => enqueueSnackbar(msg, { variant: 'success' }),
    [enqueueSnackbar],
  );

  const error = useCallback(
    (e: unknown, fallback = '操作失败') => {
      const msg = typeof e === 'string' ? e : messageOf(e) || fallback;
      enqueueSnackbar(msg, { variant: 'error', autoHideDuration: 5000 });
    },
    [enqueueSnackbar],
  );

  const info = useCallback((msg: string) => enqueueSnackbar(msg, { variant: 'info' }), [enqueueSnackbar]);
  const warning = useCallback((msg: string) => enqueueSnackbar(msg, { variant: 'warning' }), [enqueueSnackbar]);

  return useMemo(
    () => ({ success, error, info, warning }),
    [success, error, info, warning],
  );
}
