/**
 * 管理后台二级导航（阶段一 · 统一入口）
 *
 * 管理后台各页顶部共用：用户与角色 / 权限矩阵 / 内置模板 / 审计日志。
 * 审批流配置（阶段二）与模板管理深化（阶段三）后续在此扩展 Tab。
 */
import { useNavigate } from 'react-router-dom';
import { Box, Tab, Tabs } from '@mui/material';
import { ROUTES } from '@/config/routes';
import { useLocation } from 'react-router-dom';

const ADMIN_TABS = [
  { key: 'users', label: '用户与角色', path: ROUTES.adminUsers },
  { key: 'permissions', label: '权限矩阵', path: ROUTES.adminPermissions },
  { key: 'templates', label: '内置模板', path: ROUTES.adminTemplates },
  { key: 'audit', label: '审计日志', path: ROUTES.adminAuditLog },
];

/** 根据当前路径定位激活 Tab（前缀匹配） */
function activeOf(pathname: string): string | false {
  for (const t of ADMIN_TABS) {
    if (pathname.startsWith(t.path)) return t.key;
  }
  return false;
}

export function AdminTabs(): JSX.Element {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const value = activeOf(pathname);

  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2.5 }}>
      <Tabs
        value={value}
        onChange={(_, key: string) => {
          const t = ADMIN_TABS.find((x) => x.key === key);
          if (t) navigate(t.path);
        }}
        variant="scrollable"
        scrollButtons="auto"
      >
        {ADMIN_TABS.map((t) => (
          <Tab key={t.key} value={t.key} label={t.label} sx={{ minWidth: 110 }} />
        ))}
      </Tabs>
    </Box>
  );
}
