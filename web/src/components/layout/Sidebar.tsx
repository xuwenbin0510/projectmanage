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

/** 构建期注入的版本信息（vite.config.ts 的 define） */
const VERSION = __APP_VERSION__;

/** ISO(UTC) → 浏览器本地时区可读时间；解析失败则原样返回 */
function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 产品版本标签。数字来自构建期的 git tag（`vite.config.ts` 的 define），不手工维护：
 * - 正好落在发布 tag 上      → `v1.0.0`
 * - 该 tag 之后 N 个未发布提交 → `v1.0.0+3`
 * - 仓库无 tag               → `未发布`
 */
function formatVersionLabel(): string {
  if (!VERSION.version) return '未发布';
  return VERSION.commitsSinceTag > 0 ? `${VERSION.version}+${VERSION.commitsSinceTag}` : VERSION.version;
}

/** Tooltip 里的版本释义 */
function describeVersion(): string {
  if (!VERSION.version) return '仓库无发布 tag';
  return VERSION.commitsSinceTag > 0
    ? `产品版本 ${VERSION.version} 之后的第 ${VERSION.commitsSinceTag} 个提交（未发布）`
    : `产品版本 ${VERSION.version}（发布版本）`;
}

/** 左侧主导航 */
export function Sidebar({ collapsed, onNavigate }: SidebarProps): JSX.Element {
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const { pathname } = useLocation();
  const { isDark } = useThemeMode();

  // 用户全部全局职位（并集）；后端 toApiUser 已回传 globalRoles 数组合并数组，
  // 未回退到单值 globalRole 以兼容旧字段。门禁用「任一职位命中」判定。
  const userGlobalRoles =
    user?.globalRoles?.length
      ? user.globalRoles
      : user?.globalRole
        ? [user.globalRole]
        : [];
  const visible = MAIN_MENU.filter(
    (m) =>
      (!m.roles || m.roles.some((r) => userGlobalRoles.includes(r))) &&
      (!m.permissions || m.permissions.some((a) => can(a))),
  );

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
          {/* 版本徽标：产品版本（git tag 推导）+ 构建 SHA。与线上同名位置对照即可判断两边是否同一份构建 */}
          <Tooltip
            placement="top"
            arrow
            title={
              <Box component="span" sx={{ display: 'block', fontSize: 11, lineHeight: 1.7 }}>
                <Box component="span" sx={{ display: 'block' }}>
                  {describeVersion()}
                </Box>
                <Box component="span" sx={{ display: 'block', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {VERSION.fullSha}
                </Box>
                <Box component="span" sx={{ display: 'block' }}>
                  构建于 {formatBuildTime(VERSION.buildTime)}
                </Box>
                {VERSION.dirty && (
                  <Box component="span" sx={{ display: 'block' }}>
                    含未提交改动 —— 与线上同 SHA 也可能内容不同
                  </Box>
                )}
              </Box>
            }
          >
            <Box
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                mt: 0.75,
                px: 1,
                py: 0.25,
                borderRadius: 999,
                bgcolor: alpha(tokens.status.neutral, 0.1),
                border: `0.5px solid ${alpha(tokens.status.neutral, 0.22)}`,
                cursor: 'default',
                '&:hover': { bgcolor: alpha(tokens.status.neutral, 0.16) },
              }}
            >
              <Typography
                component="span"
                sx={{
                  fontSize: 10.5,
                  lineHeight: '16px',
                  fontWeight: 600,
                  letterSpacing: 0.2,
                  color: tokens.text.secondary,
                }}
              >
                {formatVersionLabel()}
              </Typography>
              <Box
                component="span"
                sx={{
                  width: 3,
                  height: 3,
                  flexShrink: 0,
                  borderRadius: '50%',
                  bgcolor: alpha(tokens.status.neutral, 0.45),
                }}
              />
              <Typography
                component="span"
                sx={{
                  fontFamily: 'monospace',
                  fontSize: 10.5,
                  lineHeight: '16px',
                  letterSpacing: 0.3,
                  color: tokens.text.secondary,
                  opacity: 0.75,
                  userSelect: 'text',
                }}
              >
                {VERSION.sha}
                {VERSION.dirty ? '+' : ''}
              </Typography>
            </Box>
          </Tooltip>
        </Box>
      )}
    </Box>
  );
}
