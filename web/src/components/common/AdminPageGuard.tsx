/**
 * 管理后台页面守卫：
 * 当前用户不具备本页所需权限时，自动跳转到「第一个有权限的管理后台 Tab」，
 * 而不是渲染页面再因 API 403 弹出「无操作权限」。
 * （配合 AdminTabs 已隐藏无权 Tab，形成闭环：无权功能既不在 Tab 栏展示，
 *  深链/刷新进入也不会出现死页。）
 */
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { usePermission } from '@/hooks';
import { firstPermittedAdminPath } from '@/config/adminTabs';

interface Props {
  /** 本页所需的权限动作 */
  action: string;
  children: ReactNode;
}

export function AdminPageGuard({ action, children }: Props): JSX.Element {
  const { can } = usePermission();
  if (!can(action)) {
    return <Navigate to={firstPermittedAdminPath(can)} replace />;
  }
  return <>{children}</>;
}
