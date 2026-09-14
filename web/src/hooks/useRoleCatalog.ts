import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { api } from '@/api/client';
import { GLOBAL_ROLE_LABEL } from '@/config/enums';
import type { Role } from '@/types/project';

/**
 * 角色目录（运行时表驱动）。
 *
 * **唯一真相源 = 后端 `roles` 表**，经 `GET /api/meta/roles` 下发（登录可读）。
 * 本模块以**模块级缓存 + 首次拉取**的方式全站复用，用于把角色 key 渲染成中文名，
 * 替代各处 `ownerRole.toUpperCase()` 直接显示英文简称（如 `QA` / `TL`）的做法。
 *
 * 关键约定：
 * - `nameOf(key)` 对**未知 key 必须优雅回落**：`roles` 表名称 → 内置中文名 → key 原文，
 *   绝不渲染空白或 undefined；
 * - 该接口**刻意只下发已启用角色**（`WHERE enabled = 1`，下拉不该出现停用项），
 *   故缓存不含停用角色；若历史质量门 / 检查项仍引用某个**已停用**角色，
 *   会回落到内置中文名（可能是该角色的旧名）——仍为中文，不会露出英文 key。
 *   需要「停用角色也显示 roles 表当前名」时，须另开只读接口，勿改本接口（会污染下拉）；
 * - 缓存命中后不再请求；`reload()` 用于后台增改角色后刷新（无需刷新页面）。
 *
 * 与 `useProjectTypes` 同构：模块级缓存 + `useSyncExternalStore` 订阅。
 */

/* ── 模块级缓存（跨组件共享，避免每个组件各拉一次） ── */

/** 全部角色（含已停用，按 `orderNo` 升序） */
let cache: Role[] = [];
/** 是否已完成过至少一次成功拉取（决定是否跳过首次请求） */
let loaded = false;
/** 进行中的请求（并发去重） */
let inflight: Promise<Role[]> | null = null;
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

async function fetchRoleCatalog(): Promise<Role[]> {
  const list = await api.listSelectableRoles();
  cache = [...(list ?? [])].sort((a, b) => (a.orderNo ?? 0) - (b.orderNo ?? 0));
  loaded = true;
  emit();
  return cache;
}

/**
 * 确保角色目录已加载（幂等；命中缓存直接返回）。
 * ⚠️ 只应在 `useEffect` 等副作用中调用，不得在渲染期调用。
 */
export function ensureRoleCatalog(): Promise<Role[]> {
  if (loaded) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetchRoleCatalog().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** 强制重新拉取（后台增改角色后调用，全站角色名同步刷新） */
export function reloadRoleCatalog(): Promise<Role[]> {
  inflight = fetchRoleCatalog().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * 角色 key → 纯中文名（非组件上下文可用，读模块缓存）。
 *
 * 优先级：`roles` 表名称（职位管理里改过的名字） → 内置中文名 → key 原文。
 * 空串 / null / undefined → 空串。
 */
export function roleNameOf(key: string | undefined | null): string {
  const k = String(key ?? '').trim();
  if (!k) return '';
  return cache.find((r) => r.roleKey === k)?.name ?? GLOBAL_ROLE_LABEL[k] ?? k;
}

/* ── Hook ─────────────────────────────────────────── */

export interface UseRoleCatalogResult {
  /** 全部角色（含已停用，按 `orderNo` 升序） */
  roles: Role[];
  /** 启用中角色（下拉 / 可选项数据源） */
  enabledRoles: Role[];
  /** 首次加载中（供骨架屏 / 禁用态判断） */
  loading: boolean;
  /** 角色 key → 纯中文名；未知 key 回落内置中文名 / key 原文 */
  nameOf: (key: string | undefined | null) => string;
  /** 强制刷新（后台增改角色后调用） */
  reload: () => Promise<void>;
}

/**
 * 订阅运行时角色目录。
 *
 * @example
 * const { nameOf } = useRoleCatalog();
 * <Typography>责任角色 {nameOf(item.ownerRole)}</Typography>
 */
export function useRoleCatalog(): UseRoleCatalogResult {
  const roles = useSyncExternalStore(subscribe, () => cache, () => cache);
  const [loading, setLoading] = useState<boolean>(!loaded);

  useEffect(() => {
    if (loaded) {
      setLoading(false);
      return;
    }
    let alive = true;
    ensureRoleCatalog()
      .catch(() => {
        /* 静默：角色名回落内置中文名，避免次要数据失败弹错 */
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
      await reloadRoleCatalog();
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    roles,
    enabledRoles: roles.filter((r) => r.enabled),
    loading,
    /* `roleNameOf` 读模块缓存，函数引用稳定，无需 useCallback 包装 */
    nameOf: roleNameOf,
    reload,
  };
}
