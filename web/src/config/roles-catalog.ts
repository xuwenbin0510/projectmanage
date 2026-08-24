/**
 * 前端角色目录（与 server/config/roles-catalog.js 逐字同源）
 *
 * ⚠ 单一真相源说明：
 *  - 真实运行时（连后端）以 `roles` 表的 scope 为准，后端权限/canDo/审批兜底全部读表；
 *  - 本文件仅在 **mock 模式（无后端 DB）** 时作为角色 → scope 的来源；
 *  - 新增/修改角色请同时改 `server/config/roles-catalog.js` 与本文件，保持两份一致。
 *
 * 字段：role_key / name / scope('global'|'project') / order_no / enabled
 */
export type RoleScope = 'global' | 'project';

export interface RoleDef {
  role_key: string;
  name: string;
  scope: RoleScope;
  order_no: number;
  enabled: boolean;
}

export const ROLE_CATALOG: RoleDef[] = [
  { role_key: 'admin', name: '系统管理员', scope: 'global', order_no: 1, enabled: true },
  { role_key: 'cpo', name: '产品总监', scope: 'global', order_no: 2, enabled: true },
  { role_key: 'cto', name: '技术总监', scope: 'global', order_no: 3, enabled: true },
  { role_key: 'management', name: '公司管理层', scope: 'global', order_no: 4, enabled: true },
  { role_key: 'pmo', name: 'PMO', scope: 'global', order_no: 5, enabled: true },
  { role_key: 'cm', name: '配置管理员', scope: 'project', order_no: 6, enabled: true },
  { role_key: 'dev', name: '研发工程师', scope: 'project', order_no: 7, enabled: true },
  { role_key: 'member', name: '普通成员', scope: 'project', order_no: 8, enabled: true },
  { role_key: 'ops', name: '运维工程师', scope: 'project', order_no: 9, enabled: true },
  { role_key: 'pm', name: '项目经理', scope: 'project', order_no: 10, enabled: true },
  { role_key: 'po', name: '产品负责人', scope: 'project', order_no: 11, enabled: true },
  { role_key: 'qa', name: '质量负责人', scope: 'project', order_no: 12, enabled: true },
  { role_key: 'sale', name: '商务', scope: 'project', order_no: 13, enabled: true },
  { role_key: 'tl', name: '技术负责人', scope: 'project', order_no: 14, enabled: true },
  { role_key: 'ued', name: '体验设计师', scope: 'project', order_no: 15, enabled: true },
];

/** 角色 key → RoleDef 索引（mock 模式只读 catalog，不读 DB） */
export const ROLE_INDEX: Record<string, RoleDef> = ROLE_CATALOG.reduce(
  (acc, r) => {
    acc[r.role_key] = r;
    return acc;
  },
  {} as Record<string, RoleDef>,
);

export function getRoleScope(role: string): RoleScope | null {
  const r = ROLE_INDEX[role];
  return r ? r.scope : null;
}

export function isGlobalRole(role: string): boolean {
  return getRoleScope(role) === 'global';
}

export function isProjectRole(role: string): boolean {
  return getRoleScope(role) === 'project';
}

export function isEnabledRole(role: string): boolean {
  const r = ROLE_INDEX[role];
  return !!(r && r.enabled);
}

/** 全部启用角色 key（按 order_no 升序） */
export function allRoleKeys(): string[] {
  return ROLE_CATALOG.filter((r) => r.enabled)
    .slice()
    .sort((a, b) => a.order_no - b.order_no)
    .map((r) => r.role_key);
}

/** 全部项目视角角色（mock 模式的项目成员角色白名单） */
export function projectRoleKeys(): string[] {
  return ROLE_CATALOG.filter((r) => r.enabled && r.scope === 'project')
    .slice()
    .sort((a, b) => a.order_no - b.order_no)
    .map((r) => r.role_key);
}
