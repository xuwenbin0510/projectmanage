import {
  Box,
  Chip,
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { NavLink, useLocation } from 'react-router-dom';
import { MAIN_MENU } from '@/config/routes';
import type { MenuItem } from '@/config/routes';
import { useAuthStore } from '@/stores/authStore';
import { alphaOf as alpha, tokens } from '@/theme/tokens';
import { USE_MOCK } from '@/api/client';
import { useThemeMode } from '@/theme/themeContext';

const ICONS: Record<MenuItem['icon'], JSX.Element> = {
  workbench: <DashboardOutlinedIcon fontSize="small" />,
  projects: <FolderOutlinedIcon fontSize="small" />,
  approvals: <FactCheckOutlinedIcon fontSize="small" />,
  metrics: <InsightsOutlinedIcon fontSize="small" />,
  admin: <SettingsOutlinedIcon fontSize="small" />,
};

interface SidebarProps {
  collapsed: boolean;
  onNavigate?: () => void;
}

/** 左侧主导航 */
export function Sidebar({ collapsed, onNavigate }: SidebarProps): JSX.Element {
  const user = useAuthStore((s) => s.user);
  const { pathname } = useLocation();
  const { isDark } = useThemeMode();

  const visible = MAIN_MENU.filter((m) => !m.roles || (user && m.roles.includes(user.globalRole)));

  return (
    <Box
      sx={{
        width: collapsed ? 68 : 216,
        flexShrink: 0,
        height: '100%',
        borderRight: `1px solid ${tokens.border.subtle}`,
        bgcolor: tokens.bg.card,
        display: 'flex',
        flexDirection: 'column',
        transition: 'width .2s ease',
        overflow: 'hidden',
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ px: 2.25, height: 56, flexShrink: 0, justifyContent: collapsed ? 'center' : 'flex-start' }}>
        <Box
          component="img"
          src={isDark ? '/logo_dark.png' : '/logo_light.png'}
          alt="logo"
          sx={{ height: 28, width: 'auto', display: 'block', objectFit: 'contain' }}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
        {!collapsed && (
          <Typography sx={{ fontWeight: 600, fontSize: 15, whiteSpace: 'nowrap' }}>项目管理系统</Typography>
        )}
      </Stack>
      <Divider />

      <List sx={{ px: 1, py: 1.5, flex: 1 }}>
        {visible.map((m) => {
          const active = pathname.startsWith(m.path.split('/').slice(0, 2).join('/'));
          const btn = (
            <ListItemButton
              key={m.key}
              component={NavLink}
              to={m.path}
              onClick={onNavigate}
              sx={{
                position: 'relative',
                borderRadius: 1.5,
                mb: 0.75,
                minHeight: 44,
                justifyContent: collapsed ? 'center' : 'flex-start',
                px: collapsed ? 0 : 1.5,
                color: active ? tokens.brand.primary : tokens.text.secondary,
                bgcolor: active ? alpha(tokens.brand.primary, 0.14) : 'transparent',
                boxShadow: active ? `inset 3px 0 0 ${tokens.brand.primary}` : 'none',
                transition: 'background-color .2s ease, box-shadow .2s ease',
                '&:hover': { bgcolor: alpha(tokens.brand.primary, 0.1), color: tokens.text.primary },
              }}
            >
              <ListItemIcon sx={{ minWidth: collapsed ? 0 : 34, color: 'inherit' }}>{ICONS[m.icon]}</ListItemIcon>
              {!collapsed && (
                <ListItemText
                  primary={m.label}
                  primaryTypographyProps={{ fontSize: 14, fontWeight: active ? 600 : 400 }}
                />
              )}
              {!collapsed && m.phase && (
                <Chip
                  size="small"
                  label={m.phase}
                  sx={{ height: 18, fontSize: 10, bgcolor: alpha(tokens.status.neutral, 0.2) }}
                />
              )}
            </ListItemButton>
          );
          return collapsed ? (
            <Tooltip key={m.key} title={m.label} placement="right" arrow>
              <span>{btn}</span>
            </Tooltip>
          ) : (
            btn
          );
        })}
      </List>

      {!collapsed && (
        <Box sx={{ px: 2, py: 1.5, borderTop: `1px solid ${tokens.border.subtle}` }}>
          <Typography variant="caption" color="text.secondary">
            {USE_MOCK ? 'S1 静态原型 · Mock 数据' : '已连接服务 · 数据持久化'}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
