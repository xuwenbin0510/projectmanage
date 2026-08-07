/**
 * 设计 Token · 单一真源
 * @prd P0-16
 *
 * 组件层禁止硬编码色值，一律引用本文件（或经由 muiTheme / tailwind 派生）。
 * Tailwind（tailwind.config.ts）与 MUI（muiTheme.ts）共读同一份 token。
 *
 * ── 双主题实现要点 ─────────────────────────────────
 * `tokens` 暴露的 12 个语义 token **全部指向 CSS 变量**（styles/index.css 中按
 * `:root` / `:root[data-theme='dark']` 两套值定义），因此组件在 `sx` 里静态读取
 * token 即可随主题实时切换，无需重渲染、无需 context。
 * 真实色值集中在下方 `palettes`，由 muiTheme 与 CSS 变量共同消费。
 */

export type ThemeMode = 'light' | 'dark';

/* ── 品牌色阶（logo 实测像素推导） ──────────────────
 * 基准：logo 主色 #6DA8AE（hsl 185,28%,55%）
 * 亮色 #77C1C4（hsl 182,39%,61%）、极浅青 #DAF3F7 同为 logo 实测值。
 *
 * ⚠ 对比度约束：#6DA8AE 上放白字仅 2.67:1，不达 WCAG AA(4.5:1)。
 *   - 展示色（logo 区 / 装饰线条 / 图表 / chip / 选中浅底）→ brand[400] / brand[500]
 *   - 交互功能色（primary 按钮 / 链接 / focus 边框）→ brand[700] = #2E7D87（白字 4.77:1 ✅）
 */
export const brandScale = {
  50: '#F2FBFC',
  100: '#DAF3F7',
  200: '#BEE4EA',
  300: '#9BD3D9',
  400: '#77C1C4',
  500: '#6DA8AE',
  600: '#4E9097',
  700: '#2E7D87',
  800: '#24626B',
  900: '#17464F',
} as const;

/** 品牌展示色（可安全用于装饰，不用于承载白字的交互控件） */
export const BRAND_DISPLAY: string = brandScale[500];
/** 品牌交互色（primary 按钮 / 链接 / focus，白字 4.77:1 达 AA） */
export const BRAND_INTERACTIVE: string = brandScale[700];

/* ── 双主题真实色值 ─────────────────────────────── */

export interface ThemePalette {
  /** 页面背景 */
  bgBase: string;
  /** 卡片 / 面板 */
  bgCard: string;
  /** 悬浮层 / Dialog / Drawer */
  bgElevated: string;
  /** 分隔线 / 描边 */
  borderSubtle: string;
  /** 主文字 */
  textPrimary: string;
  /** 次要文字 / 占位 */
  textSecondary: string;
  /** 主色：按钮 / 链接 / 当前阶段（交互色，必须满足 AA） */
  brandPrimary: string;
  /** 品牌展示色：logo / 装饰线条 / 图表（不承载白字） */
  brandAccent: string;
  /** 警示：门待检、里程碑临期、黄灯 */
  statusWarning: string;
  /** 危险：逾期、否决、红灯、拦截 */
  statusDanger: string;
  /** 成功：已通过、已达成、绿灯 */
  statusSuccess: string;
  /** 未开始 / 禁用 */
  statusNeutral: string;
}

/**
 * 浅色主题（默认）——「太空实验室明亮控制台」
 * 白底 / 极浅灰背景 + 深色文字 + 品牌青蓝细线条，参考 logo 极简白底留白风格。
 */
const lightPalette: ThemePalette = {
  bgBase: '#F5F7FA',
  bgCard: '#FFFFFF',
  bgElevated: '#FFFFFF',
  borderSubtle: '#DCE5E9',
  textPrimary: '#101B22',
  textSecondary: '#5A6B75',
  brandPrimary: BRAND_INTERACTIVE,
  brandAccent: BRAND_DISPLAY,
  statusWarning: '#B45309',
  statusDanger: '#DC2626',
  statusSuccess: '#047857',
  statusNeutral: '#546174',
};

/** 深空暗色主题（保持原样，不做任何视觉调整） */
const darkPalette: ThemePalette = {
  bgBase: '#0B1020',
  bgCard: '#141A2E',
  bgElevated: '#1B2340',
  borderSubtle: '#243056',
  textPrimary: '#E6EAF5',
  textSecondary: '#8B96B8',
  brandPrimary: '#3B82F6',
  brandAccent: '#60A5FA',
  statusWarning: '#F59E0B',
  statusDanger: '#EF4444',
  statusSuccess: '#10B981',
  statusNeutral: '#64748B',
};

export const palettes: Record<ThemeMode, ThemePalette> = {
  light: lightPalette,
  dark: darkPalette,
};

/** token key → CSS 变量名（styles/index.css 与本表一一对应） */
export const CSS_VAR_NAME: Record<keyof ThemePalette, string> = {
  bgBase: '--space-bg',
  bgCard: '--space-card',
  bgElevated: '--space-elevated',
  borderSubtle: '--space-border',
  textPrimary: '--space-text',
  textSecondary: '--space-muted',
  brandPrimary: '--brand-primary',
  brandAccent: '--brand-accent',
  statusWarning: '--status-warning',
  statusDanger: '--status-danger',
  statusSuccess: '--status-success',
  statusNeutral: '--status-neutral',
};

/* ── 语义 Token（组件层唯一取色入口，12 个） ──────── */

export const tokens = {
  bg: {
    /** 页面背景 */
    base: 'var(--space-bg)',
    /** 卡片 / 面板 */
    card: 'var(--space-card)',
    /** 悬浮层 / Dialog / Drawer */
    elevated: 'var(--space-elevated)',
  },
  border: {
    /** 分隔线 / 描边 */
    subtle: 'var(--space-border)',
  },
  text: {
    /** 主文字 */
    primary: 'var(--space-text)',
    /** 次要文字 / 占位 */
    secondary: 'var(--space-muted)',
  },
  brand: {
    /** 主色 / 主按钮 / 当前阶段（交互色） */
    primary: 'var(--brand-primary)',
    /** 品牌展示色 / 装饰线条（不承载白字） */
    accent: 'var(--brand-accent)',
  },
  status: {
    /** 警示：门待检、里程碑临期、黄灯 */
    warning: 'var(--status-warning)',
    /** 危险：逾期、否决、红灯、拦截 */
    danger: 'var(--status-danger)',
    /** 成功：已通过、已达成、绿灯 */
    success: 'var(--status-success)',
    /** 未开始 / 禁用 */
    neutral: 'var(--status-neutral)',
  },
} as const;

/* ── 透明度工具 ───────────────────────────────────
 * MUI 的 alpha() 无法处理 `var(--x)`，统一改用本函数：
 * CSS 变量 → color-mix()，hex/rgb → rgba()。
 */

function hexToRgb(hex: string): [number, number, number] | null {
  let h = hex.replace('#', '').trim();
  if (h.length === 3 || h.length === 4) {
    h = h
      .slice(0, 3)
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * 给任意 token / 色值叠加透明度。
 * @param color   `var(--x)`、`#RRGGBB`、`rgb()/rgba()` 均可
 * @param opacity 0 ~ 1
 */
export function alphaOf(color: string, opacity: number): string {
  const o = Math.max(0, Math.min(1, opacity));
  if (!color) return 'transparent';
  if (color.startsWith('var(') || color.startsWith('color-mix(')) {
    return `color-mix(in srgb, ${color} ${Number((o * 100).toFixed(2))}%, transparent)`;
  }
  if (color.startsWith('#')) {
    const rgb = hexToRgb(color);
    if (rgb) return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${o})`;
  }
  if (color.startsWith('rgb')) {
    const nums = color.match(/[\d.]+/g);
    if (nums && nums.length >= 3) return `rgba(${nums[0]}, ${nums[1]}, ${nums[2]}, ${o})`;
  }
  return color;
}

/** 语义状态色键 */
export type SemanticTone = 'success' | 'warning' | 'danger' | 'neutral' | 'brand';

/** 语义色 → 具体色值（唯一映射入口） */
export const toneColor: Record<SemanticTone, string> = {
  success: tokens.status.success,
  warning: tokens.status.warning,
  danger: tokens.status.danger,
  neutral: tokens.status.neutral,
  brand: tokens.brand.primary,
};

/**
 * 状态文案 → 语义色 固定映射（架构 7.4）
 * 已通过|已达成|完成|green → success
 * 待检查|进行中|临期|yellow → warning
 * 不通过|逾期|已驳回|red → danger
 * 未开始|草稿 → neutral
 */
const TONE_MAP: Record<string, SemanticTone> = {
  // success
  已通过: 'success',
  有条件通过: 'success',
  已达成: 'success',
  完成: 'success',
  已完成: 'success',
  已批准: 'success',
  已实施: 'success',
  已提交: 'success',
  green: 'success',
  approved: 'success',
  // warning
  待检查: 'warning',
  进行中: 'warning',
  审批中: 'warning',
  待评审: 'warning',
  临期: 'warning',
  挂起: 'warning',
  current: 'warning',
  yellow: 'warning',
  // danger
  不通过: 'danger',
  逾期: 'danger',
  已逾期: 'danger',
  已驳回: 'danger',
  已终止: 'danger',
  阻塞: 'danger',
  rejected: 'danger',
  red: 'danger',
  // neutral
  未开始: 'neutral',
  草稿: 'neutral',
  待办: 'neutral',
  已撤回: 'neutral',
  已结项: 'neutral',
  pending: 'neutral',
  skipped: 'neutral',
};

/** 由任意状态字符串解析出语义色调；未知值回落 neutral */
export function toneOf(status: string | null | undefined): SemanticTone {
  if (!status) return 'neutral';
  return TONE_MAP[status] ?? 'neutral';
}

/** 由状态字符串直接取色值 */
export function colorOf(status: string | null | undefined): string {
  return toneColor[toneOf(status)];
}

/**
 * R4-P0-5 进度条语义色映射（决策 E：进行中=brand 青，与 StatusChip 的 warning 解耦）：
 * 待办=neutral / 进行中=brand / 待评审=warning / 完成=success / 阻塞=danger
 */
export function progressToneOf(status: string | null | undefined): SemanticTone {
  if (status === '进行中') return 'brand';
  return toneOf(status);
}
