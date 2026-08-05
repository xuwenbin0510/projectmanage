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
