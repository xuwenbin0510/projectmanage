/**
 * 管理后台 Tab 统一定义 + 权限落地辅助
 *
 * 单一真相源：AdminTabs 组件、路由落地（/admin 索引）、各 admin 页守卫
 * 均从这里取，避免「默认 Tab 硬编码」「无权 Tab 仍展示」类问题。
 */
import { ROUTES } from './routes';

export interface AdminTabDef {
  key: string;
  label: string;
  path: string;
  /** 该 Tab 所需的权限动作；空串表示无需特定权限（恒可见） */
  action: string;
}

export const ADMIN_TABS: AdminTabDef[] = [
  { key: 'users', label: '用户与职位', path: ROUTES.adminUsers, action: 'admin:user:role' },
  { key: 'permissions', label: '权限矩阵', path: ROUTES.adminPermissions, action: 'admin:permission:config' },
  { key: 'reviewTemplates', label: '审批配置', path: ROUTES.adminReviewTemplates, action: 'admin:template' },
  { key: 'templates', label: '内置模板', path: ROUTES.adminTemplates, action: 'admin:template' },
  { key: 'roles', label: '职位管理', path: ROUTES.adminRoles, action: 'admin:user:role' },
  { key: 'audit', label: '审计日志', path: ROUTES.adminAuditLog, action: 'admin:audit:view' },
];

/**
 * 返回当前用户「第一个有权限的管理后台 Tab」路径。
 * 用于 /admin 索引落地与无自身权限时的重定向——保证永远落在能用的功能上，
 * 不会停在「无操作权限」死页。
 * 若用户对所有 admin Tab 都无权（理论上不会出现，因菜单已按权限显隐），回退工作台。
 */
export function firstPermittedAdminPath(can: (action: string) => boolean): string {
  const hit = ADMIN_TABS.find((t) => !t.action || can(t.action));
  return hit ? hit.path : ROUTES.workbench;
}
