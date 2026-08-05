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
  // 以当年 1 月 4 日（必定落在第 1 周）为锚点推算周一，避免 isoWeek setter 的 TS 类型限制
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

export { dayjs };
