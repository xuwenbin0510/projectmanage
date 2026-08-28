import { Box, Drawer, Paper, BottomNavigation, BottomNavigationAction } from '@mui/material';
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useUiStore } from '@/stores/uiStore';
import { useResponsive } from '@/hooks';
import { useAuthStore } from '@/stores/authStore';
import { MAIN_MENU } from '@/config/routes';
import { tokens } from '@/theme/tokens';

const MOBILE_ICONS: Record<string, JSX.Element> = {
  workbench: <DashboardOutlinedIcon />,
  projects: <FolderOutlinedIcon />,
  approvals: <FactCheckOutlinedIcon />,
  admin: <SettingsOutlinedIcon />,
};

/**
 * 主框架：侧边栏 + 顶栏 + 内容区；移动端切底部 Tab
 * @prd P0-16（375px 四件事：看项目 / 审批 / 改任务状态 / 填周报）
 */
export function AppLayout(): JSX.Element {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const drawerOpen = useUiStore((s) => s.mobileDrawerOpen);
  const setDrawer = useUiStore((s) => s.setMobileDrawer);
  const { isMobile } = useResponsive();
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // 用户全部全局职位（并集）；与 Sidebar 门禁同源，用「任一职位命中」判定。
  const userGlobalRoles =
    user?.globalRoles?.length
      ? user.globalRoles
      : user?.globalRole
        ? [user.globalRole]
        : [];
  const mobileMenu = MAIN_MENU.filter(
    (m) =>
      m.mobile &&
      (!m.roles || m.roles.some((r) => userGlobalRoles.includes(r))) &&
      (!m.permissions || m.permissions.some((a) => can(a))),
  );
  const activeMobile = mobileMenu.find((m) => pathname.startsWith(m.path.split('/').slice(0, 2).join('/')));

  return (
    <Box sx={{ display: 'flex', height: '100vh', bgcolor: tokens.bg.base }}>
      {!isMobile && <Sidebar collapsed={collapsed} />}

      <Drawer
        open={isMobile && drawerOpen}
        onClose={() => setDrawer(false)}
        PaperProps={{ sx: { bgcolor: tokens.bg.card, backgroundImage: 'none' } }}
      >
        <Sidebar collapsed={false} onNavigate={() => setDrawer(false)} />
      </Drawer>

      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Topbar isMobile={isMobile} />
        <Box
          component="main"
          sx={{
            flex: 1,
            overflow: 'auto',
            px: { xs: 1.75, md: 3 },
            py: { xs: 2, md: 2.5 },
            pb: isMobile ? 9 : 3,
          }}
        >
          <Outlet />
        </Box>

        {isMobile && (
          <Paper
            elevation={0}
            sx={{
              position: 'fixed',
              bottom: 0,
              left: 0,
              right: 0,
              zIndex: 1200,
              borderTop: `1px solid ${tokens.border.subtle}`,
              bgcolor: tokens.bg.card,
            }}
            className="safe-bottom"
          >
            <BottomNavigation
              showLabels
              value={activeMobile?.key ?? false}
              onChange={(_, key: string) => {
                const item = mobileMenu.find((m) => m.key === key);
                if (item) navigate(item.path);
              }}
              sx={{ bgcolor: 'transparent', height: 56 }}
            >
              {mobileMenu.map((m) => (
                <BottomNavigationAction
                  key={m.key}
                  value={m.key}
                  label={m.label}
                  icon={MOBILE_ICONS[m.key] ?? <FolderOutlinedIcon />}
                  sx={{ minWidth: 0, fontSize: 11 }}
                />
              ))}
            </BottomNavigation>
          </Paper>
        )}
      </Box>
    </Box>
  );
}
