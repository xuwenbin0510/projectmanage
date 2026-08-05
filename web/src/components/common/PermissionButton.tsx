import type { ReactNode } from 'react';
import { Button, Tooltip } from '@mui/material';
import type { ButtonProps } from '@mui/material';
import { usePermission } from '@/hooks';

interface PermissionButtonProps extends Omit<ButtonProps, 'children' | 'action'> {
  /** 权限动作 key（config/permissions.ts） */
  action: string;
  children: ReactNode;
  /** 无权限时：hide=隐藏（默认），disable=置灰并提示 */
  fallback?: 'hide' | 'disable';
  /** 额外禁用原因（有值时按钮禁用并展示 tooltip） */
  disabledReason?: string;
}

/**
 * 权限按钮：前端仅控制可见性，服务端仍会二次校验
 * @prd 全局
 */
export function PermissionButton({
  action,
  children,
  fallback = 'hide',
  disabledReason = '',
  ...rest
}: PermissionButtonProps): JSX.Element | null {
  const { can } = usePermission();
  const allowed = can(action);

  if (!allowed && fallback === 'hide') return null;

  const disabled = rest.disabled || !allowed || Boolean(disabledReason);
  const tip = !allowed ? '当前角色无此操作权限' : disabledReason;

  const btn = (
    <span style={{ display: 'inline-flex' }}>
      <Button {...rest} disabled={disabled}>
        {children}
      </Button>
    </span>
  );

  return tip ? (
    <Tooltip title={tip} arrow>
      {btn}
    </Tooltip>
  ) : (
    btn
  );
}
