/**
 * 甘特图时间轴工具（自包含，无外部依赖）
 *
 * 负责：日期区间计算、日期↔像素映射、按天吸附、状态配色。
 * 仅被 `components/projects/GanttChart.tsx` 使用。
 */
import dayjs, { type Dayjs } from 'dayjs';
import type { TaskStatus, WbsNode, WbsTreeNode } from '@/types/wbs';

/** 每个自然日的像素宽度（按周分列时，一周 ≈ 7 × DAY_WIDTH） */
export const DAY_WIDTH = 16;

/** 行高 / 任务条高度等布局常量 */
export const GANTT_ROW_H = 40;
export const GANTT_BAR_H = 22;
export const GANTT_LABEL_W = 248;
export const GANTT_HEADER_H = 40;
export const GANTT_HEADER_MONTH_H = 20;
export const GANTT_HEADER_WEEK_H = 20;

export interface GanttRange {
  /** 可见区间起点（含外扩） */
  start: Dayjs;
  /** 可见区间终点（含外扩） */
  end: Dayjs;
  /** 总天数 */
  days: number;
}

/**
 * 计算可见时间区间：取所有节点的 start/due 极值，起点外扩 3 天、终点外扩 7 天。
 * 右侧多留空白，避免最末任务条/月份标签贴边被裁。
 * 若无任何日期，则回退为「今天 ± 半月」，保证视图非空。
 */
export function computeRange(nodes: WbsNode[]): GanttRange {
  let min: Dayjs | null = null;
  let max: Dayjs | null = null;
  for (const n of nodes) {
    if (n.startDate) {
      const d = dayjs(n.startDate);
      if (!min || d.isBefore(min)) min = d;
      if (!max || d.isAfter(max)) max = d;
    }
    if (n.dueDate) {
      const d = dayjs(n.dueDate);
      if (!min || d.isBefore(min)) min = d;
      if (!max || d.isAfter(max)) max = d;
    }
  }
  const base = dayjs();
  if (!min) min = base.subtract(15, 'day');
  if (!max) max = base.add(15, 'day');
  const start = min.subtract(3, 'day');
  const end = max.add(7, 'day');
  const days = end.diff(start, 'day') + 1;
  return { start, end, days };
}

/** 日期 → 时间轴 X 像素 */
export function xOf(date: string | Dayjs | null, rangeStart: Dayjs, dayWidth = DAY_WIDTH): number {
  if (!date) return 0;
  const d = dayjs(date);
  return Math.max(0, d.diff(rangeStart, 'day') * dayWidth);
}

/** X 像素 → 吸附到「天」的日期 */
export function snapDate(rangeStart: Dayjs, x: number, dayWidth = DAY_WIDTH): Dayjs {
  const dayDelta = Math.round(x / dayWidth);
  return rangeStart.add(dayDelta, 'day');
}

/** 在给定日期上增减天数，返回 YYYY-MM-DD（空值按今天处理） */
export function shiftDate(date: string | null, days: number): string {
  const d = date ? dayjs(date) : dayjs();
  return d.add(days, 'day').format('YYYY-MM-DD');
}

/** 扁平化树（保留树序 + 层级深度），供甘特图分行渲染 */
export function flattenWithDepth(tree: WbsTreeNode[]): Array<{ node: WbsNode; depth: number }> {
  const out: Array<{ node: WbsNode; depth: number }> = [];
  const walk = (nodes: WbsTreeNode[], depth: number): void => {
    for (const n of nodes) {
      out.push({ node: n, depth });
      if (n.children?.length) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

/** wbsCode 自然序比较（与后端 sortByWbsCode / 树形视图一致） */
export function compareWbsCode(a?: string | null, b?: string | null): number {
  const pa = String(a ?? '').split('.').map((s) => Number(s) || 0);
  const pb = String(b ?? '').split('.').map((s) => Number(s) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** 甘特图状态配色：track=剩余工期底色，bar=进度填充色 */
export const GANTT_STATUS: Record<TaskStatus, { track: string; bar: string }> = {
  完成: { track: '#C0DD97', bar: '#3B6D11' },
  进行中: { track: '#B5D4F4', bar: '#185FA5' },
  待评审: { track: '#CECBF6', bar: '#534AB7' },
  待办: { track: '#E6E4DE', bar: '#888780' },
  阻塞: { track: '#F7C1C1', bar: '#A32D2D' },
};

/** 周期边界（含首尾）天数 */
export function spanDays(start: string | null, due: string | null): number {
  if (!start || !due) return 1;
  const d = dayjs(due).diff(dayjs(start), 'day') + 1;
  return Math.max(1, d);
}
