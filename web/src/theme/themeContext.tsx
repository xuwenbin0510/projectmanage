import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { CssBaseline } from '@mui/material';
import { ThemeProvider as MuiThemeProvider } from '@mui/material/styles';

import { createAppTheme } from './muiTheme';
import { palettes, type ThemeMode } from './tokens';

/**
 * 主题模式上下文（浅色 / 深色）
 * @prd P0-16
 *
 * - 默认 **浅色**（'light'）
 * - 选择持久化到 localStorage，刷新后保持
 * - 切换时同步：<html data-theme> → CSS 变量（tokens.ts 全量指向 var()）
 *                MUI ThemeProvider → palette 真实色值
 *                <meta name="theme-color"> → 移动端状态栏
 */

const STORAGE_KEY = 'pm_theme_mode';

/** 产品默认主题：浅色 */
export const DEFAULT_THEME_MODE: ThemeMode = 'light';

function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'light' || v === 'dark';
}

/** 读取已持久化的主题模式；无有效值时回落到默认浅色 */
export function readStoredThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return DEFAULT_THEME_MODE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isThemeMode(raw) ? raw : DEFAULT_THEME_MODE;
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

/** 把主题模式写到 <html> 上，驱动 CSS 变量与浏览器配色 */
export function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', mode);
  root.style.colorScheme = mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', palettes[mode].bgBase);
}

export interface ThemeModeContextValue {
  /** 当前主题模式 */
  mode: ThemeMode;
  /** 是否深色 */
  isDark: boolean;
  /** 指定主题模式 */
  setMode: (mode: ThemeMode) => void;
  /** 在浅色 / 深色之间切换 */
  toggleMode: () => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null);

/** 读取主题模式与切换方法；必须在 AppThemeProvider 内使用 */
export function useThemeMode(): ThemeModeContextValue {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) {
    throw new Error('useThemeMode 必须在 <AppThemeProvider> 内使用');
  }
  return ctx;
}

interface AppThemeProviderProps {
  children: ReactNode;
}

/** 应用主题容器：按 mode 提供 MUI 主题 + 同步 CSS 变量 */
export function AppThemeProvider({ children }: AppThemeProviderProps): JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredThemeMode());

  useEffect(() => {
    applyThemeMode(mode);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* 隐私模式下 localStorage 不可写，忽略即可 */
    }
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
  }, []);

  const toggleMode = useCallback(() => {
    setModeState((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const theme = useMemo(() => createAppTheme(mode), [mode]);

  const value = useMemo<ThemeModeContextValue>(
    () => ({ mode, isDark: mode === 'dark', setMode, toggleMode }),
    [mode, setMode, toggleMode],
  );

  return (
    <ThemeModeContext.Provider value={value}>
      <MuiThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </MuiThemeProvider>
    </ThemeModeContext.Provider>
  );
}
