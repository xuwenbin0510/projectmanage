import type { ReactElement, ReactNode } from 'react';
import { Children, cloneElement, isValidElement } from 'react';
import {
  Autocomplete,
  Button,
  Checkbox,
  Chip,
  IconButton,
  ListItemButton,
  MenuItem,
  Radio,
  Select,
  Switch,
  Tab,
  TextField,
  ToggleButton,
  Tooltip,
} from '@mui/material';
import { usePermission } from '@/hooks';

/*
 * 权限门控容器：为何不用 PermissionButton。
 *
 * PermissionButton 渲染的实体是 MUI Button，而 Button 自带 min-width: 64px 与 padding: 6px 8px。
 * 当它被当作「权限门控容器」去包裹非按钮内容（开关 Switch / 图标按钮 IconButton / Chip / Stack）时，
 * Button 的盒子会撑破表格里的固定宽单元格；而 DataTable 的 TableCell 上设置了
 * whiteSpace: 'nowrap' + overflow: 'hidden' + textOverflow: 'ellipsis'，
 * 浏览器便会在裁切边缘画出多余的点（省略号）。
 *
 * 因此本组件改用 span（inline-flex）作为门控容器，绝不注入按钮外观，
 * 只负责「可见性 / 可用性」：由内部递归给可控子控件注入 disabled。
 *
 * 实现说明：本仓库使用的 MUI 版本把组件导出为裸的 forwardRef 对象，
 * 其 muiName / displayName 在构建后为 undefined，无法按名字识别控件。
 * 故这里改用「组件引用比对」——直接 import 真实的 MUI 控件放进 Set，按引用相等判断是否为可禁用控件，
 * 该方式不依赖组件名，构建压缩后依然可靠；并保留 muiName 与 props.disabled 作为兜底。
 *
 * @prd 全局 · 服务端仍为最终裁决方
 */

/** 可接收 disabled 的 MUI 控件（按组件引用比对，不依赖名称） */
const CONTROLLABLE = new Set<unknown>([
  Switch,
  Checkbox,
  Radio,
  Button,
  IconButton,
  ToggleButton,
  Chip,
  MenuItem,
  ListItemButton,
  Tab,
  TextField,
  Select,
  Autocomplete,
]);

/** muiName 兜底（个别控件仍带 muiName，如 Select） */
const CONTROLLABLE_NAMES = new Set([
  'Switch',
  'Checkbox',
  'Radio',
  'Button',
  'IconButton',
  'ToggleButton',
  'Chip',
  'MenuItem',
  'ListItemButton',
  'Tab',
  'TextField',
  'Select',
  'Autocomplete',
]);

interface PermissionGateProps {
  /** 权限动作 key（config/permissions.ts） */
  action: string;
  /** 无权限时：hide=隐藏，disable=置灰并提示 */
  fallback?: 'hide' | 'disable';
  /** 额外禁用原因（有值时禁用并展示 tooltip） */
  disabledReason?: string;
  /** 有权限时展示的提示文案（如「操作」）；无权限时一律展示「当前角色无此操作权限」 */
  tooltip?: string;
  children: ReactNode;
}

type GateChildProps = { disabled?: boolean; children?: ReactNode };

/** 判断某元素是否为「可禁用控件」：组件引用 / muiName / 本身带 disabled 键 */
function isControllable(type: unknown, props: GateChildProps | null | undefined): boolean {
  const muiName = (type as { muiName?: string } | undefined)?.muiName ?? '';
  return CONTROLLABLE.has(type) || CONTROLLABLE_NAMES.has(muiName) || 'disabled' in (props ?? {});
}

/**
 * 递归给子控件注入 disabled 状态。
 * - 命中可禁用控件：直接置 disabled；
 * - 否则若其有 children：透传递归（可穿透 Tooltip / Stack / Box 等容器，命中里面的 Switch / IconButton / Chip）；
 * - 非元素节点原样返回。
 *
 * 注意：disabled=false 时同样走这条路径但保持原值（disabled || props.disabled），
 * 避免「有权限时反而把原本 disabled 的控件放开」。
 */
function injectDisabled(node: ReactNode, disabled: boolean): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement(child)) return child;
    const el = child as ReactElement<GateChildProps>;
    if (isControllable(el.type, el.props)) {
      return cloneElement(el, { disabled: disabled || Boolean(el.props?.disabled) });
    }
    if (el.props && el.props.children !== undefined) {
      return cloneElement(el, {}, injectDisabled(el.props.children, disabled));
    }
    return child;
  });
}

/**
 * 权限门控容器：前端仅控制可见性与可用性，服务端仍会二次校验。
 * 与 PermissionButton 语义同源，但不会注入按钮外观，适合包裹开关 / 图标按钮 / Chip 等表格单元格内容。
 */
export function PermissionGate({
  action,
  fallback = 'disable',
  disabledReason = '',
  tooltip = '',
  children,
}: PermissionGateProps): JSX.Element | null {
  const { can } = usePermission();
  const allowed = can(action);

  if (!allowed && fallback === 'hide') return null;

  const blocked = !allowed || Boolean(disabledReason);
  const tip = !allowed ? '当前角色无此操作权限' : disabledReason || tooltip || '';

  const wrap = (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>{injectDisabled(children, blocked)}</span>
  );

  return tip ? (
    <Tooltip title={tip} arrow>
      {wrap}
    </Tooltip>
  ) : (
    wrap
  );
}
