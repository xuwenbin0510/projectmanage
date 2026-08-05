import type { Config } from 'tailwindcss';

/**
 * Tailwind 配置
 * - preflight: false —— 避免覆盖 MUI 基础样式（架构 D8）
 * - important: '#root' —— 提升原子类优先级，与 MUI emotion 共存不打架
 * - 颜色统一指向 styles/index.css 的 CSS 变量（与 src/theme/tokens.ts 同源），
 *   因此 Tailwind 原子类同样随浅色 / 深色主题自动切换。
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  corePlugins: {
    preflight: false,
  },
  important: '#root',
  theme: {
    extend: {
      colors: {
        'space-bg': 'var(--space-bg)',
        'space-card': 'var(--space-card)',
        'space-elevated': 'var(--space-elevated)',
        'space-border': 'var(--space-border)',
        'space-text': 'var(--space-text)',
        'space-muted': 'var(--space-muted)',
        brand: 'var(--brand-primary)',
        'brand-accent': 'var(--brand-accent)',
        warn: 'var(--status-warning)',
        danger: 'var(--status-danger)',
        ok: 'var(--status-success)',
        neutral2: 'var(--status-neutral)',
      },
      screens: {
        xs: '375px',
      },
    },
  },
  plugins: [],
};

export default config;
