/**
 * 全局总览取数 hook（B12 · T05）
 *
 * 封装 `GET /api/dashboard/overview` 的：
 *  - 受控查询参数（scope / 筛选 / 排序 / 分页）
 *  - loading / error / data 三态
 *  - 刷新时间戳（P1-7「更新于 …」）
 *  - 竞态防护：慢请求回来时若已有更新的请求发出，结果直接丢弃
 *
 * ── 范围（scope）语义（SK-B12-7）────────────────────
 *  - `canSeeAll`（有 `dashboard:global`：admin / pmo / management）：
 *    可在「公司全量 = all」与「我参与的 = mine」之间切换；
 *  - 其余角色：**前端默认就传 mine**，且即便手工传 all，服务端也会强制降级，
 *    页面以 `data.scope`（服务端实际生效值）为准显示，不会出现「以为在看全公司」。
 *  - `mine` 范围内再用 `onlyMine` 细分：false = 我参与的，true = 我负责的（我是 PM）。
 *
 * ⚠ 本 hook 不做任何聚合：所有指标都由服务端一次性算好（C1），
 *   前端只负责展示与下钻，避免 B11 的前端聚合口径在多项目量级下漂移。
 *
 * @prd B12
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/api/client';
import { useAuthStore } from '@/stores/authStore';
import type {
  DashboardOverview,
  DashboardOverviewQuery,
  DashboardScope,
} from '@/types/dashboard';
import { fmtDateTime } from '@/utils/date';

/** 明细表默认页大小（与 `server/services/dashboard.service.js#DEFAULT_PAGE_SIZE` 一致） */
export const DASHBOARD_DEFAULT_PAGE_SIZE = 20;

export interface UseDashboardOverviewResult {
  /** 服务端聚合结果；首次加载完成前为 null */
  data: DashboardOverview | null;
  loading: boolean;
  error: unknown;
  /** 当前请求参数（受控） */
  query: DashboardOverviewQuery;
  /** 实际生效范围：优先取服务端返回值（可能被降级），无数据时取本地意图 */
  scope: DashboardScope;
  /** 前端权限镜像：是否允许切到「公司全量」（服务端为最终裁决方） */
  canSeeAll: boolean;
  /** 最近一次成功取数的时间（已格式化，空串表示尚未成功过） */
  refreshedAt: string;
  /** 局部更新查询参数；除翻页外一律回到第 1 页 */
  setQuery: (patch: Partial<DashboardOverviewQuery>) => void;
  /** 切换统计范围（无权限时调用无效果，避免制造必然被降级的请求） */
  setScope: (next: DashboardScope) => void;
  /** 手动刷新（参数不变，重新取数） */
  refresh: () => void;
}

/**
 * 全局总览数据源。
 *
 * ```tsx
 * const { data, loading, setQuery, refresh } = useDashboardOverview();
 * ```
 */
export function useDashboardOverview(): UseDashboardOverviewResult {
  const can = useAuthStore((s) => s.can);
  const canSeeAll = can('dashboard:global');

  const [query, setQueryState] = useState<DashboardOverviewQuery>(() => ({
    scope: canSeeAll ? 'all' : 'mine',
    type: '',
    status: '',
    health: '',
    keyword: '',
    onlyMine: false,
    page: 1,
    pageSize: DASHBOARD_DEFAULT_PAGE_SIZE,
    sort: 'health',
  }));

  const [data, setData] = useState<DashboardOverview | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);
  const [refreshedAt, setRefreshedAt] = useState<string>('');
  const [reloadToken, setReloadToken] = useState<number>(0);

  const mounted = useRef(true);
  /** 请求序号：只接受最新一次请求的结果，杜绝快速切筛选时的旧数据覆盖 */
  const seq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /* 用序列化后的 query 做依赖，避免每次渲染新建对象导致的无限取数 */
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    const ticket = seq.current + 1;
    seq.current = ticket;

    setLoading(true);
    setError(null);

    api
      .getDashboardOverview(query)
      .then((res) => {
        if (!mounted.current || ticket !== seq.current) return;
        setData(res);
        setRefreshedAt(fmtDateTime(res.generatedAt));
      })
      .catch((e: unknown) => {
        if (!mounted.current || ticket !== seq.current) return;
        setError(e);
      })
      .finally(() => {
        if (!mounted.current || ticket !== seq.current) return;
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, reloadToken]);

  const setQuery = useCallback((patch: Partial<DashboardOverviewQuery>): void => {
    setQueryState((prev) => {
      /* 只有显式翻页 / 改页大小时才保留页码，其余筛选变化一律回第 1 页，
         否则「第 5 页 + 换筛选」会命中空页，用户会以为没数据 */
      const keepPage = patch.page !== undefined || patch.pageSize !== undefined;
      return {
        ...prev,
        ...patch,
        page: keepPage ? (patch.page ?? prev.page ?? 1) : 1,
      };
    });
  }, []);

  const setScope = useCallback(
    (next: DashboardScope): void => {
      if (!canSeeAll && next === 'all') return; // 必然被服务端降级，不发这次请求
      setQueryState((prev) => ({ ...prev, scope: next, page: 1 }));
    },
    [canSeeAll],
  );

  const refresh = useCallback((): void => {
    setReloadToken((n) => n + 1);
  }, []);

  const scope: DashboardScope = useMemo(
    () => data?.scope ?? (canSeeAll ? (query.scope ?? 'all') : 'mine'),
    [data, canSeeAll, query.scope],
  );

  return {
    data,
    loading,
    error,
    query,
    scope,
    canSeeAll,
    refreshedAt,
    setQuery,
    setScope,
    refresh,
  };
}
