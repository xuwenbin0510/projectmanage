import { createTheme, type Theme } from '@mui/material/styles';
import { alphaOf, brandScale, palettes, type ThemeMode, type ThemePalette } from './tokens';

/**
 * MUI 主题工厂（浅色 / 深色双主题）
 * @prd P0-16
 *
 * - light：太空实验室明亮控制台 —— 白底 / 极浅灰、深色文字、品牌青蓝细线条（默认）
 * - dark ：深空暗色（保留原有视觉，未做调整）
 *
 * palette 必须使用真实色值（MUI 内部要做 contrast / alpha 计算），
 * 组件层则统一走 tokens.ts 的 CSS 变量，两者色值同源于 tokens.palettes。
 */
function buildTheme(mode: ThemeMode, p: ThemePalette): Theme {
  const isLight = mode === 'light';

  return createTheme({
    palette: {
      mode,
      background: {
        default: p.bgBase,
        paper: p.bgCard,
      },
      primary: {
        main: p.brandPrimary,
        light: isLight ? brandScale[500] : '#60A5FA',
        dark: isLight ? brandScale[800] : '#1D4ED8',
        contrastText: '#FFFFFF',
      },
      secondary: {
        main: p.statusNeutral,
        contrastText: '#FFFFFF',
      },
      success: { main: p.statusSuccess, contrastText: '#FFFFFF' },
      warning: { main: p.statusWarning, contrastText: '#FFFFFF' },
      error: { main: p.statusDanger, contrastText: '#FFFFFF' },
      info: { main: p.brandPrimary, contrastText: '#FFFFFF' },
      text: {
        primary: p.textPrimary,
        secondary: p.textSecondary,
        disabled: p.statusNeutral,
      },
      divider: p.borderSubtle,
    },
    shape: { borderRadius: 10 },
    typography: {
      fontFamily:
        '"PingFang SC","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,"Noto Sans SC",sans-serif',
      fontSize: 14,
      h1: { fontSize: 24, fontWeight: 600 },
      h2: { fontSize: 20, fontWeight: 600 },
      h3: { fontSize: 18, fontWeight: 600 },
      h4: { fontSize: 16, fontWeight: 600 },
      h5: { fontSize: 15, fontWeight: 600 },
      h6: { fontSize: 14, fontWeight: 600 },
      button: { textTransform: 'none', fontWeight: 500 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundColor: p.bgBase,
            color: p.textPrimary,
            scrollbarColor: `${p.borderSubtle} ${p.bgBase}`,
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
            backgroundColor: p.bgCard,
            border: `1px solid ${p.borderSubtle}`,
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            backgroundColor: p.bgCard,
            border: `1px solid ${p.borderSubtle}`,
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            backgroundColor: p.bgElevated,
            boxShadow: isLight ? '0 18px 48px rgba(16, 27, 34, 0.14)' : 'none',
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundColor: p.bgElevated,
            borderColor: p.borderSubtle,
          },
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            backgroundColor: p.bgElevated,
            boxShadow: isLight ? '0 10px 28px rgba(16, 27, 34, 0.12)' : 'none',
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: isLight ? p.textPrimary : p.bgElevated,
            border: `1px solid ${isLight ? p.textPrimary : p.borderSubtle}`,
            color: isLight ? '#FFFFFF' : p.textPrimary,
            fontSize: 12,
            maxWidth: 320,
          },
          arrow: { color: isLight ? p.textPrimary : p.bgElevated },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: { borderBottom: `1px solid ${p.borderSubtle}` },
          head: {
            color: p.textSecondary,
            fontWeight: 600,
            backgroundColor: isLight ? p.bgBase : p.bgCard,
            whiteSpace: 'nowrap',
          },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 8 },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: { fontWeight: 500 },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            backgroundColor: isLight ? p.bgCard : p.bgBase,
            '& fieldset': { borderColor: p.borderSubtle },
            '&:hover fieldset': { borderColor: alphaOf(p.brandPrimary, 0.55) },
            '&.Mui-focused fieldset': { borderColor: p.brandPrimary, borderWidth: 1.5 },
          },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: { textTransform: 'none', minHeight: 44, fontSize: 14 },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: { border: `1px solid ${p.borderSubtle}` },
        },
      },
    },
  });
}

/** 浅色主题（默认） */
export const lightTheme: Theme = buildTheme('light', palettes.light);

/** 深空暗色主题（保留） */
export const darkTheme: Theme = buildTheme('dark', palettes.dark);

/** 按模式取主题 */
export function createAppTheme(mode: ThemeMode): Theme {
  return mode === 'dark' ? darkTheme : lightTheme;
}

/** 兼容旧引用：默认导出浅色主题 */
export const muiTheme: Theme = lightTheme;

export default muiTheme;
