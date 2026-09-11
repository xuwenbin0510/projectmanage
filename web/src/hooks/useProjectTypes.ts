import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { api } from '@/api/client';
import type { ProjectTypeEntity } from '@/types/project';

/**
 * 项目类型目录（运行时表驱动）。
 *
 * **唯一真相源 = 后端 `project_types` 表**，经 `GET /api/meta/project-types` 下发（**含已停用**）。
 * 本模块以**模块级缓存 + 首次拉取**的方式全站复用，替代已删除的
 * `PROJECT_TYPE_LABEL / PROJECT_TYPE_SHORT / PROJECT_TYPES` 静态常量，杜绝前后端漂移。
 *
 * 关键约定（设计 §7-5 / R5）：
 * - `labelOf / shortOf` 对**未知 code 必须优雅回落为 code 原文** —— 新类型绝不能渲染成空白或 undefined；
 * - `types` 含停用类型（历史项目标签仍可解析）；`enabledTypes` 才用于建项下拉 / 可选项；
 * - 缓存命中后不再请求；`reload()` 用于后台增改类型后刷新。
 */

/* ── 模块级缓存（跨组件共享，避免每个组件各拉一次） ── */

/** 全部类型（含已停用，按 `orderNo` 升序） */
let cache: ProjectTypeEntity[] = [];
/** 是否已完成过至少一次成功拉取（决定是否跳过首次请求） */
let loaded = false;
/** 进行中的请求（并发去重） */
let inflight: Promise<ProjectTypeEntity[]> | null = null;
/** 订阅者（`useSyncExternalStore` 触发重渲染） */
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 拉取并写入缓存；失败时保持原缓存不动（标签回落 code 原文），由调用方决定是否提示 */
async function fetchProjectTypes(): Promise<ProjectTypeEntity[]> {
  const list = await api.listProjectTypes();
  cache = [...(list ?? [])].sort((a, b) => (a.orderNo ?? 0) - (b.orderNo ?? 0));
  loaded = true;
  emit();
  return cache;
}

/**
 * 确保类型目录已加载（幂等；命中缓存直接返回）。
 * ⚠️ 只应在 `useEffect` 等副作用中调用，不得在渲染期调用。
 */
export function ensureProjectTypes(): Promise<ProjectTypeEntity[]> {
  if (loaded) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetchProjectTypes().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** 强制重新拉取（后台增改类型后调用，全站标签同步刷新） */
export function reloadProjectTypes(): Promise<ProjectTypeEntity[]> {
  inflight = fetchProjectTypes().finally(() => {
    inflight = null;
  });
  return inflight;
}

/* ── 非组件上下文的标签解析（读模块缓存；未加载时回落 code 原文） ── */

/** 类型全名（如「基建类」）；未知 code 回落 code 原文 */
export function labelOf(code: string): string {
  return cache.find((t) => t.code === code)?.name ?? code;
}

/**
 * 类型短标签。表驱动后不再有独立的短名，取 `name`；
 * 未知 code 同样回落 code 原文（保证不渲染空白）。
 */
export function shortOf(code: string): string {
  return cache.find((t) => t.code === code)?.name ?? code;
}

/** 该 code 是否处于启用态（未知 code → false） */
export function isTypeEnabled(code: string): boolean {
  return cache.some((t) => t.code === code && t.enabled);
}

/* ── Hook ─────────────────────────────────────────── */

export interface UseProjectTypesResult {
  /** 全部类型（含已停用，按 `orderNo` 升序） */
  types: ProjectTypeEntity[];
  /** 启用中类型（建项下拉 / 可选项数据源） */
  enabledTypes: ProjectTypeEntity[];
  /** 首次加载中（供骨架屏 / 禁用态判断） */
  loading: boolean;
  /** 类型全名；未知 code 回落 code 原文 */
  labelOf: (code: string) => string;
  /** 类型短标签；未知 code 回落 code 原文 */
  shortOf: (code: string) => string;
  /** 该 code 是否为有效类型 */
  hasType: (code: string) => boolean;
  /** 该 code 是否启用 */
  isEnabled: (code: string) => boolean;
  /** 强制刷新（后台增改后调用） */
  reload: () => Promise<void>;
}

/**
 * 订阅运行时类型目录。
 *
 * @example
 * const { types, enabledTypes, labelOf } = useProjectTypes();
 * types.map((t) => <MenuItem value={t.code}>{t.name}</MenuItem>)
 */
export function useProjectTypes(): UseProjectTypesResult {
  const types = useSyncExternalStore(subscribe, () => cache, () => cache);
  const [loading, setLoading] = useState<boolean>(!loaded);

  useEffect(() => {
    if (loaded) {
      setLoading(false);
      return;
    }
    let alive = true;
    ensureProjectTypes()
      .catch(() => {
        /* 静默：标签回落 code 原文，避免次要数据失败弹错 */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      await reloadProjectTypes();
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    types,
    enabledTypes: types.filter((t) => t.enabled),
    loading,
    labelOf,
    shortOf,
    hasType: (code: string) => types.some((t) => t.code === code),
    isEnabled: (code: string) => types.some((t) => t.code === code && t.enabled),
    reload,
  };
}
