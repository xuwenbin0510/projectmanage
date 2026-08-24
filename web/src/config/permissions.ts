/**
 * 前端权限镜像（P0-10）
 * ⚠ 只用于按钮显隐，**永远不能作为安全边界**；任何 action 服务端必须再判一次。
 *
 * 做法 A：每个 action 只列「允许的角色」(roles:[])，跨项目 vs 仅项目内由角色 scope
 * 在运行时自动判定（mock 模式读 roles-catalog，真实模式读后端 roles 表）。
 */
import type { RoleKey } from '@/types/project';
import { isGlobalRole, isProjectRole } from './roles-catalog';

export interface PermRule {
  /** 允许的角色（不区分 global/project，由 scope 决定跨项目效力） */
  roles: RoleKey[];
}

/**
 * 运行时注入的权限矩阵（B19 阶段二）。
 * 登录后由后端 `/api/admin/permissions` 拉取的「当前生效矩阵」注入到这里，
 * `canDo` 优先读它；未注入时回落编译期 PERMISSIONS 常量（向后兼容 + 逃生舱）。
 * 形如：{ [action]: { [roleKey]: boolean } }（仅含启用角色 + 启用 action）。
 */
let injectedMatrix: Record<string, Record<string, boolean>> | null = null;

/** 登录成功 / 拉取矩阵后注入（服务端为权威源，与后端 canDo 一致） */
export function hydratePermissions(matrix: Record<string, Record<string, boolean>>): void {
  injectedMatrix = matrix && typeof matrix === 'object' ? matrix : null;
}

/** 登出 / 会话失效时回落编译期常量 */
export function resetPermissions(): void {
  injectedMatrix = null;
}

/** 取某 action 的授权角色集合（注入优先，常量兜底） */
function rolesFor(action: string): RoleKey[] {
  if (injectedMatrix && Object.prototype.hasOwnProperty.call(injectedMatrix, action)) {
    const row = injectedMatrix[action] || {};
    return (Object.keys(row) as RoleKey[]).filter((r) => row[r]);
  }
  const rule = PERMISSIONS[action];
  return rule ? (rule.roles as RoleKey[]) : [];
}

/** 权限矩阵：action → 允许的角色（编译期默认；运行时由 hydratePermissions 覆盖） */
export const PERMISSIONS: Record<string, PermRule> = {
  // 项目
  'project:create': { roles: ['admin', 'pmo', 'pm'] },
  'project:edit': { roles: ['admin', 'pmo', 'pm'] },
  'project:delete': { roles: ['admin'] },
  'project:transition': { roles: ['admin', 'pmo', 'pm'] },
  'project:close': { roles: ['admin', 'pmo', 'pm'] },
  'project:member:assign': { roles: ['admin', 'pmo', 'pm'] },
  // 质量门（挂在里程碑上 · 决策 D-A）
  'gate:decide': { roles: ['admin', 'pmo', 'qa', 'tl'] },
  'gate:item:check': { roles: ['admin', 'pmo', 'qa', 'tl', 'cm'] },
  'gate:item:add': { roles: ['admin', 'pmo', 'pm', 'qa'] },
  // 里程碑（本轮启用增删改与状态覆盖）
  'milestone:create': { roles: ['admin', 'pmo', 'pm'] },
  'milestone:edit': { roles: ['admin', 'pmo', 'pm'] },
  'milestone:delete': { roles: ['admin', 'pm'] },
  // WBS / 看板
  'wbs:edit': { roles: ['admin', 'pmo', 'pm', 'tl'] },
  'wbs:delete': { roles: ['admin', 'pm', 'tl'] },
  'task:status': { roles: ['admin', 'pmo', 'pm', 'tl', 'member', 'qa', 'po', 'cm'] },
  'board:config': { roles: ['admin', 'pmo', 'pm', 'tl'] },
  // 周报
  'report:write': { roles: ['admin', 'pmo', 'pm', 'tl', 'member', 'qa', 'po', 'cm'] },
  // 评审
  'review:start': { roles: ['admin', 'pmo', 'pm', 'tl'] },
  'review:decide': { roles: ['admin', 'pmo', 'management', 'tl', 'pm', 'po'] },
  'review:proxy': { roles: ['admin', 'pm'] },
  // 变更
  'change:create': { roles: ['admin', 'pmo', 'pm', 'tl'] },
  'change:submit': { roles: ['admin', 'pmo', 'pm'] },
  // 全局仪表盘（B12）：仅管理三角色可看「公司全量」范围（scope=global 才跨项目生效）
  'dashboard:global': { roles: ['admin', 'pmo', 'management'] },
  // 管理后台
  'admin:user:role': { roles: ['admin'] },
  'admin:audit:view': { roles: ['admin', 'pmo'] },
  'admin:template': { roles: ['admin', 'pmo'] },
  // 任务附件（C01）：上传面向所有项目参与者，删除仅管理员 / 项目负责人
  'document:upload': { roles: ['admin', 'pmo', 'pm', 'tl', 'member', 'qa', 'po', 'cm'] },
  'document:delete': { roles: ['admin', 'pm'] },
};

/** 全部 action 列表（自检用） */
export const ALL_ACTIONS = Object.keys(PERMISSIONS);

/**
 * 判定用户是否具备某 action（前端显隐用，与后端逐一一致）
 * @param globalRoles 用户全部全局职位（数组，取并集）；也兼容单个字符串
 * @param action     权限动作
 * @param projectRoles 用户在当前项目中的角色集合
 */
export function canDo(
  globalRoles: string | string[] | undefined,
  action: string,
  projectRoles: string[] = [],
): boolean {
  if (!globalRoles) return false;
  const list = Array.isArray(globalRoles) ? globalRoles : [globalRoles];
  if (!list.length) return false;
  if (list.includes('admin')) return true;
  const ruleRoles = rolesFor(action);
  if (!ruleRoles.length) return false;
  // 全局职位：仅 scope=global 的角色跨项目生效
  if (list.some((g) => isGlobalRole(g) && ruleRoles.includes(g as RoleKey))) return true;
  // 项目角色：命中即项目内生效（scope=project 的角色仅在本项目内）
  return projectRoles.some((r) => isProjectRole(r) && ruleRoles.includes(r as RoleKey));
}
