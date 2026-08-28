/**
 * 管理后台二级导航（阶段一 · 统一入口）
 *
 * 管理后台各页顶部共用：用户与职位 / 权限矩阵 / 内置模板 / 审计日志。
 * 审批流配置（阶段二）与模板管理深化（阶段三）后续在此扩展 Tab。
 */
import { useNavigate } from 'react-router-dom';
import { Box, Tab, Tabs } from '@mui/material';
import { ROUTES } from '@/config/routes';
import { useLocation } from 'react-router-dom';
import { usePermission } from '@/hooks';

const ADMIN_TABS = [
  { key: 'users', label: '用户与职位', path: ROUTES.adminUsers, action: 'admin:user:role' },
  { key: 'permissions', label: '权限矩阵', path: ROUTES.adminPermissions, action: 'admin:permission:config' },
  { key: 'reviewTemplates', label: '审批配置', path: ROUTES.adminReviewTemplates, action: 'admin:template' },
  { key: 'templates', label: '内置模板', path: ROUTES.adminTemplates, action: 'admin:template' },
  { key: 'roles', label: '职位管理', path: ROUTES.adminRoles, action: 'admin:user:role' },
  { key: 'audit', label: '审计日志', path: ROUTES.adminAuditLog, action: 'admin:audit:view' },
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
  const { can } = usePermission();
  const visible = ADMIN_TABS.filter((t) => !t.action || can(t.action));
  const value = activeOf(pathname);

  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2.5 }}>
      <Tabs
        value={value}
        onChange={(_, key: string) => {
          const t = visible.find((x) => x.key === key);
          if (t) navigate(t.path);
        }}
        variant="scrollable"
        scrollButtons="auto"
      >
        {visible.map((t) => (
          <Tab key={t.key} value={t.key} label={t.label} sx={{ minWidth: 110 }} />
        ))}
      </Tabs>
    </Box>
  );
}
