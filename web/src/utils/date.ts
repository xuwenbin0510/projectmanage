import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(isoWeek);
dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

export const DATE_FMT = 'YYYY-MM-DD';
export const DATETIME_FMT = 'YYYY-MM-DD HH:mm';

/** 今天（YYYY-MM-DD） */
export function today(): string {
  return dayjs().format(DATE_FMT);
}

/** 现在（ISO 字符串） */
export function nowIso(): string {
  return dayjs().format('YYYY-MM-DDTHH:mm:ss');
}

/** 格式化日期，空值返回 '—' */
export function fmtDate(v: string | null | undefined, fmt = DATE_FMT): string {
  if (!v) return '—';
  const d = dayjs(v);
  return d.isValid() ? d.format(fmt) : '—';
}

/** 格式化日期时间 */
export function fmtDateTime(v: string | null | undefined): string {
  return fmtDate(v, DATETIME_FMT);
}

/** 短日期 MM-DD */
export function fmtShort(v: string | null | undefined): string {
  return fmtDate(v, 'MM-DD');
}

/** 相对时间（3 天前） */
export function fromNow(v: string | null | undefined): string {
  if (!v) return '—';
  const d = dayjs(v);
  return d.isValid() ? d.fromNow() : '—';
}

/** a 与 b 相差天数（b - a） */
export function diffDays(a: string, b: string): number {
  return dayjs(b).diff(dayjs(a), 'day');
}

/** 是否早于今天（逾期判定） */
export function isOverdue(due: string | null | undefined): boolean {
  if (!due) return false;
  return dayjs(due).isBefore(dayjs(), 'day');
}

/** 是否临期（默认 3 天内） */
export function isDueSoon(due: string | null | undefined, withinDays = 3): boolean {
  if (!due) return false;
  const d = dayjs(due).diff(dayjs(), 'day');
  return d >= 0 && d <= withinDays;
}

/** ISO 周编码：2026-W11 */
export function weekCode(d: dayjs.Dayjs | string = dayjs()): string {
  const day = dayjs(d);
  return `${day.isoWeekYear()}-W${String(day.isoWeek()).padStart(2, '0')}`;
}

/** 周编码 → { start, end } */
export function weekRange(code: string): { start: string; end: string } {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(code);
  if (!m) {
    const s = dayjs().startOf('isoWeek');
    return { start: s.format(DATE_FMT), end: s.add(6, 'day').format(DATE_FMT) };
  }
  const year = Number(m[1]);
  const week = Number(m[2]);
  // 以当年 1 月 4 日（必定落在第 1 周）为基准推算周一，避免 isoWeek setter 的 TS 类型限制
  const jan4 = dayjs(`${year}-01-04`);
  const week1Monday = jan4.subtract((jan4.isoWeekday() - 1 + 7) % 7, 'day');
  const start = week1Monday.add((week - 1) * 7, 'day');
  return { start: start.format(DATE_FMT), end: start.add(6, 'day').format(DATE_FMT) };
}

/** 相对当前周偏移若干周的周编码 */
export function shiftWeek(code: string, offset: number): string {
  const { start } = weekRange(code);
  return weekCode(dayjs(start).add(offset, 'week'));
}

/** 加天数 */
export function addDays(base: string, days: number): string {
  return dayjs(base).add(days, 'day').format(DATE_FMT);
}

/* ═══════════════════════════════════════════════════
 * SK-M7 · 里程碑默认日期生成的**唯一算法入口**
 *
 *   `fitMilestoneDates(planStart, planEnd, offsets)` 由向导
 *   （ProjectCreatePage）与 Mock 引擎（createProject）共用，
 *   两侧结果必须逐字一致。
 *
 *   🚫 禁止在任何地方再写 `addDays(planStart, offsetDays)` 直算里程碑日期
 *      —— 模板跨度大于计划周期时会把里程碑甩到 planEnd 之外（问题②根因）。
 *
 *   ⚠️ 本函数**永不抛异常、永不阻断创建**：空数组 / 负周期 / 全零 offset
 *      一律降级返回，极端周期只置 `stacked=true` 供 UI 做非阻塞告警。
 * ═══════════════════════════════════════════════════ */

/** 里程碑日期压缩结果（含透明化提示所需的元信息） */
export interface FitMilestoneDatesResult {
  /** 与入参 `offsets` **同索引对齐**的绝对日期数组 `YYYY-MM-DD` */
  dates: string[];
  /** 是否发生了压缩（`planDays < templateSpan`） */
  compressed: boolean;
  /** 压缩比 0~1；未压缩时恒为 1 */
  ratio: number;
  /** 计划周期天数 = `diffDays(planStart, planEnd)`，负周期按 0 处理 */
  planDays: number;
  /** 模板跨度 = `max(offsets)`；offsets 为空或全 0 时为 0 */
  templateSpan: number;
  /** 是否出现同日堆叠（周期过短，无法逐碑错开）→ 触发 P1-M12 非阻塞告警 */
  stacked: boolean;
}

/**
 * 里程碑日期等比压缩（P0-M4 · SK-M7 主函数）。
 *
 * 四道流水线，逐条对应 PRD §4.B 的边界规则：
 *
 * | 规则 | 实现 |
 * | --- | --- |
 * | 1 首碑可与 planStart 同日 | `off === 0` 不做保底，落在开工日 |
 * | 2 非首碑不可被压到 planStart | `off > 0 && d === 0 → d = 1` |
 * | 3 严格单调不减 | `d <= prev → d = prev + 1` |
 * | 4 末碑恰好 = planEnd | 等比压缩的天然性质（`templateSpan × ratio === planDays`） |
 * | 5 极端周期兜底 | `d > planDays → d = planDays` 并置 `stacked` |
 *
 * @param planStart 计划开始日 `YYYY-MM-DD`
 * @param planEnd   计划结束日 `YYYY-MM-DD`
 * @param offsets   模板相对偏移天数（可乱序，返回值与入参同索引对齐）
 */
export function fitMilestoneDatesEx(
  planStart: string,
  planEnd: string,
  offsets: number[],
): FitMilestoneDatesResult {
  /* ── 0. 防御：空集合 / 非法周期 / 零跨度一律降级返回 ── */
  if (!offsets.length) {
    return { dates: [], compressed: false, ratio: 1, planDays: 0, templateSpan: 0, stacked: false };
  }

  const planDays = Math.max(0, diffDays(planStart, planEnd)); // 负周期按 0 处理，绝不抛异常
  const safeOffsets = offsets.map((o) => Math.max(0, Number.isFinite(o) ? o : 0));
  const templateSpan = Math.max(...safeOffsets);

  if (templateSpan === 0) {
    /* 退化：全部同偏移 → 全部落在 planStart，多于 1 碑即视为堆叠 */
    return {
      dates: safeOffsets.map(() => addDays(planStart, 0)),
      compressed: false,
      ratio: 1,
      planDays,
      templateSpan: 0,
      stacked: safeOffsets.length > 1,
    };
  }

  const compressed = planDays < templateSpan;
  const ratio = compressed ? planDays / templateSpan : 1;

  /* ── 1. 按 offset 升序处理，保留原索引保证返回值与入参同序 ── */
  const order = safeOffsets
    .map((off, i) => ({ off, i }))
    .sort((a, b) => (a.off !== b.off ? a.off - b.off : a.i - b.i)); // tie-break 原索引，保证确定性

  const dayOf = new Array<number>(safeOffsets.length).fill(0);
  let prev = -1;
  let stacked = false;

  for (const { off, i } of order) {
    let d = Math.round(off * ratio);

    /* 规则 2：非首碑不允许被压到 planStart */
    if (off > 0 && d === 0) d = 1;

    /* 规则 3：严格单调不减，同日顺延 1 天 */
    if (d <= prev) d = prev + 1;

    /* 规则 3 后半 + 规则 5：顺延不得超过 planEnd，超出即封顶并标记堆叠 */
    if (d > planDays) {
      d = planDays;
      if (d <= prev) stacked = true; // 已无空间错开 → 允许同日堆叠
    }

    dayOf[i] = d;
    prev = Math.max(prev, d);
  }

  /* ── 2. 转绝对日期 ── */
  return {
    dates: dayOf.map((d) => addDays(planStart, d)),
    compressed,
    ratio,
    planDays,
    templateSpan,
    stacked,
  };
}

/**
 * 里程碑日期等比压缩（薄封装，只要日期数组）。
 * 引擎侧使用；需要压缩比 / 堆叠标志做 UI 提示时用 {@link fitMilestoneDatesEx}。
 */
export function fitMilestoneDates(planStart: string, planEnd: string, offsets: number[]): string[] {
  return fitMilestoneDatesEx(planStart, planEnd, offsets).dates;
}

export { dayjs };
