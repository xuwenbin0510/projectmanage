import type { ApiClient } from './contract';
import { mockClient } from './mock';
import { httpClient, setToken, getToken } from './http';

/**
 * API 客户端唯一出口。
 *
 * `VITE_USE_MOCK=true`  → 内存 Mock 引擎（S1 演示态，可读写、可重置）
 * `VITE_USE_MOCK=false` → 真实 HTTP 后端
 *
 * 两套实现签名完全一致，**页面代码零改动切换**。
 */
export const USE_MOCK: boolean = String(import.meta.env.VITE_USE_MOCK ?? 'true') === 'true';

export const api: ApiClient = USE_MOCK ? mockClient : httpClient;

export { setToken, getToken };
export type { ApiClient };
export * from './contract';
