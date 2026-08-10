/**
 * 图表取色**唯一入口**（B11 · SK-B11-1）
 *
 * ══════════════════════════════════════════════════════════════════
 * 🚫 硬禁令：图表层（`components/dashboard/**`）**禁止** import
 *    `tokens` / `alphaOf` / `toneColor` / `colorOf`（`@/theme/tokens`）。
 *
 *    原因：`tokens.*` 全部是 `var(--brand-primary)` 形式的 CSS 自定义属性，
 *    `alphaOf()` 返回 `color-mix(...)`。图表库（@mui/x-charts）把颜色写进
 *    **SVG presentation attribute**（`fill="..."` / `stroke="..."`），而
 *    **SVG 属性既不解析 CSS 变量，也不解析 color-mix()** → 图表会渲染成
 *    黑色或完全不可见。
 *
 *    本文件是**唯一**允许触碰真色值的图表侧文件：从 `brandScale`
 *    （真 hex 色阶）与 `palettes[mode]`（真 hex 语义色）取值，
 *    导出的每一个色值都是 `#RRGGBB` 或 `#RRGGBBAA`。
 *
 *    需要半透明时在本文件内预先算好 8 位 hex，**不要在组件里调 alphaOf**。
 * ══════════════════════════════════════════════════════════════════
 *
 * 配色分层规则（决策 D-B11-2 · 一张图内只用一套色系，同页面两套可并存）：
 *   · **量级类**（进度 / 任务数 / 工时 —— 「多少」）→ `brand` 品牌色阶
 *   · **风险类**（健康度 / 逾期告警 —— 「好坏」）→ `health` 语义三色
 *
 * @prd B11
 */

import { brandScale, palettes, type ThemeMode } from './tokens';
import { useThemeMode } from './themeContext';

/** 健康度 / 风险语义三色（真 hex） */
export interface ChartHealthColors {
  /** 绿：健康 / 正常 */
  green: string;
  /** 黄：预警 / 临期 */
  yellow: string;
  /** 红：风险 / 已逾期 */
  red: string;
}

/** 图表色板（全部真 hex，可直接写进 SVG 属性） */
export interface ChartPalette {
  /**
   * 品牌色阶（量级类图表用），由深到浅 4 档：
   * `[700, 500, 300, 100]`。序列越靠前语义权重越高（如「完成」用最深）。
   */
  brand: string[];
  /** 品牌主展示色（单序列柱状 / 折线的默认色） */
  brandMain: string;
  /** 品牌交互色（强调、hover、中心大字） */
  brandStrong: string;
  /** 健康 / 风险语义三色 */
  health: ChartHealthColors;
  /** 坐标轴线与刻度文字 */
  axis: string;
  /** 网格线（已预乘透明度的 8 位 hex） */
  grid: string;
  /** 图表内文字（主） */
  text: string;
  /** 图表内文字（次） */
  textMuted: string;
  /** Tooltip / 图例底色 */
  tooltipBg: string;
  /** Tooltip 描边 */
  tooltipBorder: string;
  /** 空数据 / 占位环的底色 */
  track: string;
}

/* ── 深色分支的品牌色阶 ──────────────────────────────
 * 说明：深色主题**不是本期视觉目标**（用户明确以浅色为主），
 * 这里给一组够用的青蓝浅档，只保证切到 dark 时图表不黑屏、不刺眼。
 */
const DARK_BRAND_SCALE: string[] = ['#9BD3D9', '#77C1C4', '#4E9097', '#2E7D87'];

/** 浅色品牌色阶：700 / 500 / 300 / 100（全部来自 brandScale 真 hex） */
const LIGHT_BRAND_SCALE: string[] = [
  brandScale[700], // #2E7D87
  brandScale[500], // #6DA8AE
  brandScale[300], // #9BD3D9
  brandScale[100], // #DAF3F7
];

/**
 * 把 `#RRGGBB` 叠加透明度，返回 `#RRGGBBAA`。
 *
 * 为什么不用 `alphaOf`：`alphaOf` 对 CSS 变量返回 `color-mix()`，SVG 属性不认；
 * 且 8 位 hex 在 SVG `fill` 上被所有现代浏览器原生支持。
 *
 * @param hex     `#RRGGBB`（非法输入原样返回，绝不抛异常）
 * @param opacity 0 ~ 1
 */
export function hexAlpha(hex: string, opacity: number): string {
  const o = Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 1));
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const a = Math.round(o * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
}

/**
 * 按主题模式取图表色板（纯函数，无 React 依赖，可被脚本直接 import 做色值校验）。
 *
 * @param mode 主题模式，缺省 `light`
 */
export function getChartPalette(mode: ThemeMode = 'light'): ChartPalette {
  const p = palettes[mode] ?? palettes.light;
  const brand = mode === 'dark' ? DARK_BRAND_SCALE.slice() : LIGHT_BRAND_SCALE.slice();

  return {
    brand,
    brandMain: brand[1],
    brandStrong: brand[0],
    health: {
      green: p.statusSuccess,
      yellow: p.statusWarning,
      red: p.statusDanger,
    },
    axis: p.textSecondary,
    grid: hexAlpha(p.textSecondary, 0.18),
    text: p.textPrimary,
    textMuted: p.textSecondary,
    tooltipBg: p.bgElevated,
    tooltipBorder: p.borderSubtle,
    track: hexAlpha(p.textSecondary, 0.12),
  };
}

/**
 * 图表色板 hook：组件层唯一取色方式。
 *
 * ```tsx
 * const palette = useChartPalette();
 * <PieChart series={[{ data: [{ value: 1, color: palette.brand[0] }] }]} />
 * ```
 */
export function useChartPalette(): ChartPalette {
  const { mode } = useThemeMode();
  return getChartPalette(mode);
}
