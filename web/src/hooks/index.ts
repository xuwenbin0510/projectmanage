import { useCallback, useEffect, useRef, useState } from 'react';
import { useMediaQuery, useTheme } from '@mui/material';
import { useAuthStore } from '@/stores/authStore';

import { useToast } from './useToast';
export { useToast } from './useToast';
export { useDashboardOverview, DASHBOARD_DEFAULT_PAGE_SIZE } from './useDashboardOverview';
export type { UseDashboardOverviewResult } from './useDashboardOverview';
export {
  useProjectTypes,
  ensureProjectTypes,
  reloadProjectTypes,
  labelOf,
  shortOf,
  isTypeEnabled,
} from './useProjectTypes';
export type { UseProjectTypesResult } from './useProjectTypes';

/**
 * useAsync 选项
 * @param silent true 时失败不弹 toast（仅记录 error state）；默认 false（自动弹错误提示）。
 *              适用于「失败可降级为默认值」的次要数据加载。
 */
export interface UseAsyncOptions {
  silent?: boolean;
}

/**
 * 异步请求 hook：自动管理 loading / error / data。
 * 失败时自动弹 toast（messageOf 映射 ApiError 中文文案）；silent=true 可关闭。
 * 页面仍可读取 error state 渲染「加载失败 + 重试」UI。
 * @example const { data, loading, run } = useAsync(() => api.getProject(id), [id]);
 * @example const { data } = useAsync(() => api.listX(), [], true, { silent: true }); // 次要数据静默
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
  immediate = true,
  opts?: UseAsyncOptions,
): { data: T | null; loading: boolean; error: unknown; run: () => Promise<T | null> } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(immediate);
  const [error, setError] = useState<unknown>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const mounted = useRef(true);
  const toast = useToast();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (): Promise<T | null> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fnRef.current();
      if (mounted.current) setData(res);
      return res;
    } catch (e) {
      if (mounted.current) setError(e);
      // 系统性错误可见性（2026-09-07 加固）：默认弹 toast，避免 403/5xx 被伪装成「空列表」。
      // silent=true 的调用点为有意降级的次要数据，仅记录 error state。
      if (mounted.current && !optsRef.current?.silent) {
        toast.error(e, '加载失败');
      }
      return null;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (immediate) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, run };
}

/**
 * 权限判定 hook（前端镜像，仅控制按钮可见性）
 * @prd 全局 · 服务端为最终裁决方
 */
export function usePermission(): { can: (action: string) => boolean; isAdmin: boolean } {
  const can = useAuthStore((s) => s.can);
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && (Array.isArray(user.globalRoles) ? user.globalRoles.includes('admin') : user.globalRole === 'admin');
  return { can, isAdmin };
}

/** 响应式断点：移动端 375px 场景判定 */
export function useResponsive(): { isMobile: boolean; isTablet: boolean; isDesktop: boolean } {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const isTablet = useMediaQuery(theme.breakpoints.between('sm', 'lg'));
  return { isMobile, isTablet, isDesktop: !isMobile && !isTablet };
}

/** 防抖值 */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
