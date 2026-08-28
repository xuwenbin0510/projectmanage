import { useState } from 'react';
import {
  Box,
  Chip,
  Divider,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import LogoutIcon from '@mui/icons-material/Logout';
import LockResetIcon from '@mui/icons-material/LockReset';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import { useNavigate } from 'react-router-dom';
import { UserAvatar, TodoBell } from '@/components/common';
import { useAuthStore } from '@/stores/authStore';
import { useUiStore } from '@/stores/uiStore';
import { useToast } from '@/hooks/useToast';
import { GLOBAL_ROLE_LABEL } from '@/config/enums';
import { ROUTES } from '@/config/routes';
import { api, USE_MOCK } from '@/api/client';
import { tokens } from '@/theme/tokens';
import { useThemeMode } from '@/theme/themeContext';
import { ChangePasswordDialog } from '@/components/ChangePasswordDialog';

interface TopbarProps {
  isMobile: boolean;
}

/** 顶部栏：折叠按钮 + 当前用户 + 演示数据复位 */
export function Topbar({ isMobile }: TopbarProps): JSX.Element {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setMobileDrawer = useUiStore((s) => s.setMobileDrawer);
  const { isDark, toggleMode } = useThemeMode();
  // 主职位展示：优先取合并后的 globalRoles 首项，回落单值 globalRole（与门禁/判权同源）。
  const primaryRole = user?.globalRoles?.length
    ? user.globalRoles[0]
    : user?.globalRole;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pwdOpen, setPwdOpen] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  const handleLogout = async (): Promise<void> => {
    setAnchor(null);
    await logout();
    navigate(ROUTES.login, { replace: true });
  };

  const handleReset = async (): Promise<void> => {
    setAnchor(null);
    try {
      await api.resetDemoData();
      toast.success('演示数据已复位，正在刷新…');
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      sx={{
        height: 56,
        px: { xs: 1.5, md: 2.5 },
        flexShrink: 0,
        borderBottom: `1px solid ${tokens.border.subtle}`,
        bgcolor: tokens.bg.card,
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1}>
        <IconButton size="small" onClick={() => (isMobile ? setMobileDrawer(true) : toggleSidebar())}>
          <MenuIcon fontSize="small" />
        </IconButton>
        {isMobile && (
          <Stack direction="row" spacing={1} alignItems="center">
            <Box
              component="img"
              src="/logo_dark.png"
              alt="logo"
              sx={{ height: 24, width: 'auto', display: 'block', objectFit: 'contain' }}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
            <Typography sx={{ fontWeight: 600, fontSize: 15 }}>项目管理系统</Typography>
          </Stack>
        )}
      </Stack>

      <Stack direction="row" alignItems="center" spacing={1.5}>
        <TodoBell />
        {USE_MOCK && (
          <Tooltip title="当前为 Mock 演示数据，所有写操作仅存于本地会话" arrow>
            <Chip size="small" label="DEMO" color="warning" variant="outlined" sx={{ height: 22, fontSize: 11 }} />
          </Tooltip>
        )}
        <Tooltip title={isDark ? '切换到浅色主题' : '切换到深色主题'} arrow>
          <IconButton
            size="small"
            onClick={toggleMode}
            aria-label={isDark ? '切换到浅色主题' : '切换到深色主题'}
            sx={{ color: tokens.text.secondary, '&:hover': { color: tokens.brand.primary } }}
          >
            {isDark ? (
              <LightModeOutlinedIcon sx={{ fontSize: 19 }} />
            ) : (
              <DarkModeOutlinedIcon sx={{ fontSize: 19 }} />
            )}
          </IconButton>
        </Tooltip>
        <Box
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ display: 'flex', alignItems: 'center', gap: 1, cursor: 'pointer' }}
        >
          <UserAvatar name={user?.name ?? '未登录'} size={30} />
          {!isMobile && (
            <Box sx={{ lineHeight: 1.2 }}>
              <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{user?.name ?? '未登录'}</Typography>
              <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                {user ? GLOBAL_ROLE_LABEL[primaryRole ?? ''] : ''}
              </Typography>
            </Box>
          )}
        </Box>
      </Stack>

      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        <Box sx={{ px: 2, py: 1 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{user?.name}</Typography>
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
            {user?.dept} · {user ? GLOBAL_ROLE_LABEL[primaryRole ?? ''] : ''}
          </Typography>
        </Box>
        <Divider />
        <MenuItem onClick={() => { setAnchor(null); setPwdOpen(true); }}>
          <ListItemIcon>
            <LockResetIcon fontSize="small" />
          </ListItemIcon>
          修改密码
        </MenuItem>
        {USE_MOCK && (
          <MenuItem onClick={handleReset}>
            <ListItemIcon>
              <RestartAltIcon fontSize="small" />
            </ListItemIcon>
            复位演示数据
          </MenuItem>
        )}
        <MenuItem onClick={handleLogout}>
          <ListItemIcon>
            <LogoutIcon fontSize="small" />
          </ListItemIcon>
          退出登录
        </MenuItem>
      </Menu>

      <ChangePasswordDialog open={pwdOpen} onClose={() => setPwdOpen(false)} />
    </Stack>
  );
}
