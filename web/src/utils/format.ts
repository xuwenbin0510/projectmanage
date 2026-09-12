/** 通用格式化与小工具 */

/** 万元金额展示 */
export function fmtAmount(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 万元`;
}

/** 人日展示 */
export function fmtDays(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${Number(v.toFixed(1))} 人日`;
}

/** 百分比展示 */
export function fmtPercent(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${Math.round(v)}%`;
}

/** 空值兜底 */
export function orDash(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

/** 截断长文本 */
export function truncate(v: string, max = 40): string {
  if (!v) return '';
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

/** 生成前缀 ID（前端 mock 用；真实 ID 由服务端生成） */
let seqCounter = 0;
export function genId(prefix: string): string {
  seqCounter += 1;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}${Date.now().toString(36)}${seqCounter.toString(36)}${rand}`.toUpperCase();
}

/** 生成请求 ID（X-Request-Id） */
export function genRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 生成幂等键（「提交」类写操作的并发防重，如周报提交）。
 *
 * 仅由客户端生成、随请求体下发，同一「表单打开」会话内复用同一个键：
 * 按钮双击 / 请求重试 / 并发竞态 → 服务端判重后返回既有记录，不会产生重复数据。
 *
 * ⚠️ 不用裸 `crypto.randomUUID()`：线上以 `http://<IP>:3000` 访问属**非安全上下文**，
 *    该 API 直接不可用。这里优先用它（有则更优），否则回退到全上下文可用的
 *    `crypto.getRandomValues`（128 位随机）+ 时间戳，最后兜底 Math.random。
 */
export function genIdemKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* 非安全上下文 / 旧浏览器：走下面的回退 */
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${Date.now().toString(36)}-${hex}`;
}

/** 深拷贝（结构化数据，mock 引擎写入前隔离引用） */
export function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 数组按 key 分组 */
export function groupBy<T, K extends string>(list: T[], keyFn: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of list) {
    const k = keyFn(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}

/** 数字安全解析 */
export function toNumber(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
