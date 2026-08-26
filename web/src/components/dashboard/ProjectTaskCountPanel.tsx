/**
 * 各项目任务量（全局总览·「项目健康」第 4 子面板）
 * 可视化：矩形树图（treemap）—— 每项目一个色块，面积 ∝ 任务总数（越大任务越多），
 * 颜色按任务数由浅青到深青（数量越多越深，与面积同向），逾期任务数以红色角标提示。悬浮高亮、点击下钻到项目。
 * 纯 CSS 自包含实现（squarified 算法），无第三方依赖。
 */
import { Box, Typography, CircularProgress } from '@mui/material';
import type { ProjectTaskStat } from '@/types/dashboard';

interface Rect { x: number; y: number; w: number; h: number; }

/** squarified treemap：把面积序列铺满矩形，最小化长宽比，面积守恒、无重叠。 */
function worstRatio(row: number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = sum * sum;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

function squarify(areas: number[], rect: Rect): Rect[] {
  const out: Rect[] = [];
  const helper = (rest: number[], r: Rect): void => {
    if (rest.length === 0) return;
    const side = Math.min(r.w, r.h);
    let i = 1;
    while (i < rest.length && worstRatio(rest.slice(0, i), side) >= worstRatio(rest.slice(0, i + 1), side)) {
      i++;
    }
    const row = rest.slice(0, i);
    const rowArea = row.reduce((a, b) => a + b, 0);
    if (r.w >= r.h) {
      const colW = rowArea / r.h;
      let y = r.y;
      for (const a of row) {
        const hh = a / colW;
        out.push({ x: r.x, y, w: colW, h: hh });
        y += hh;
      }
      helper(rest.slice(i), { x: r.x + colW, y: r.y, w: r.w - colW, h: r.h });
    } else {
      const stripH = rowArea / r.w;
      let x = r.x;
      for (const a of row) {
        const ww = a / stripH;
        out.push({ x, y: r.y, w: ww, h: stripH });
        x += ww;
      }
      helper(rest.slice(i), { x: r.x, y: r.y + stripH, w: r.w, h: r.h - stripH });
    }
  };
  helper(areas, rect);
  return out;
}

/** 颜色工具：连续插值 + 亮度判定文字色 */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}
function lerpColor(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return `rgb(${lerp(r1, r2, t)}, ${lerp(g1, g2, t)}, ${lerp(b1, b2, t)})`;
}
function luminance(rgbStr: string): number {
  const m = rgbStr.match(/\d+/g)!.map(Number);
  const f = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
}
/** 任务数 → 连续青蓝渐变（少→多：浅→深），与面积同向，无硬色带 */
function colorForCount(total: number, maxTotal: number): { bg: string; fg: string } {
  const ratio = maxTotal > 0 ? total / maxTotal : 0; // 0..1，最大项目=1
  const bg = lerpColor('#EAF6F9', '#2E7D87', Math.sqrt(ratio)); // sqrt 拉开中段层次
  const fg = luminance(bg) > 0.5 ? '#0A0E12' : '#FFFFFF';
  return { bg, fg };
}

export interface ProjectTaskCountPanelProps {
  items: ProjectTaskStat[];
  loading?: boolean;
  onSelect?: (projectId: string) => void;
}

export function ProjectTaskCountPanel({ items, loading = false, onSelect }: ProjectTaskCountPanelProps): JSX.Element {
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <CircularProgress size={28} />
      </Box>
    );
  }
  const data = (items ?? []).filter((it) => it.total > 0).sort((a, b) => b.total - a.total);
  if (data.length === 0) {
    return (
      <Box sx={{ py: 2 }}>
        <Typography variant="body2" color="text.secondary">
          暂无任务数据
        </Typography>
      </Box>
    );
  }

  const total = data.reduce((s, it) => s + it.total, 0);
  const areas = data.map((it) => (it.total / total) * 10000);
  const rects = squarify(areas, { x: 0, y: 0, w: 100, h: 100 });
  const GAP = 0.6;
  const maxTotal = data.length ? data[0].total : 0;

  return (
    <Box sx={{ position: 'relative', width: '100%', height: 216, overflow: 'hidden' }}>
      {data.map((it, idx) => {
        const r = rects[idx];
        const c = colorForCount(it.total, maxTotal);
        const w = Math.max(r.w - GAP * 2, 0);
        const h = Math.max(r.h - GAP * 2, 0);
        /* 仅面积大（任务多）的色块显示名称，避免小色块长名溢出被切；小色块只显数量，完整信息见悬浮 */
        const showName = w * h >= 1000 && w >= 16;
        const showNum = w >= 7 && h >= 10;
        return (
          <Box
            key={it.projectId}
            title={`${it.projectName} · 任务${it.total} · 完成${it.done}(${it.completionRate}%) · 逾期${it.overdue}`}
            onClick={() => onSelect && onSelect(it.projectId)}
            sx={{
              position: 'absolute',
              left: `${r.x + GAP}%`,
              top: `${r.y + GAP}%`,
              width: `${w}%`,
              height: `${h}%`,
              background: c.bg,
              color: c.fg,
              borderRadius: 0,
              p: showName ? 0.75 : 0.25,
              cursor: onSelect ? 'pointer' : 'default',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: showName ? 'space-between' : 'center',
              alignItems: showName ? 'stretch' : 'center',
              boxSizing: 'border-box',
              transition: 'filter .12s, outline-color .12s',
              outline: '1.5px solid transparent',
              outlineOffset: -1.5,
              '&:hover': onSelect
                ? { filter: 'brightness(1.07)', outline: '1.5px solid #6DA8AE', zIndex: 2 }
                : {},
            }}
          >
            {showName && (
              <Typography
                variant="caption"
                sx={{
                  fontWeight: 700,
                  lineHeight: 1.15,
                  display: 'block',
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {it.projectName}
              </Typography>
            )}
            {showNum && (
              <Box sx={{ textAlign: showName ? 'left' : 'center', lineHeight: 1 }}>
                <Typography variant="h6" sx={{ fontWeight: 800, lineHeight: 1, fontSize: showName ? '1.05rem' : '0.95rem' }}>
                  {it.total}
                </Typography>
                {showName && (
                  <Typography variant="caption" sx={{ opacity: 0.85 }}>
                    完成{it.completionRate}%
                  </Typography>
                )}
              </Box>
            )}
            {it.overdue > 0 && (
              <Box
                sx={{
                  position: 'absolute',
                  top: 3,
                  right: 3,
                  minWidth: 14,
                  height: 14,
                  px: 0.4,
                  borderRadius: 2,
                  background: '#D64550',
                  color: '#fff',
                  fontSize: 9,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {it.overdue}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
