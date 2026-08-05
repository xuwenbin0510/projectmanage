/**
 * 前端权限镜像（P0-10）
 * ⚠ 只用于按钮显隐，**永远不能作为安全边界**；任何 action 服务端必须再判一次。
 */
import type { GlobalRole, ProjectRole } from '@/types/project';

export interface PermRule {
  /** 满足任一全局角色即可 */
  global: GlobalRole[];
  /** 或满足任一项目级角色 */
  project: ProjectRole[];
}

/** 权限矩阵：action → 允许的角色 */
export const PERMISSIONS: Record<string, PermRule> = {
  // 项目
  'project:create': { global: ['admin', 'pmo', 'pm'], project: [] },
  'project:edit': { global: ['admin', 'pmo'], project: ['pm'] },
  'project:delete': { global: ['admin'], project: [] },
  'project:transition': { global: ['admin', 'pmo'], project: ['pm'] },
  'project:close': { global: ['admin', 'pmo'], project: ['pm'] },
  'project:member:assign': { global: ['admin', 'pmo'], project: ['pm'] },
  // 阶段 / 质量门
  'stage:advance': { global: ['admin', 'pmo'], project: ['pm'] },
  'gate:decide': { global: ['admin', 'pmo', 'qa', 'tl'], project: ['qa', 'tl', 'pmo'] },
  'gate:item:check': { global: ['admin', 'pmo', 'qa', 'tl', 'cm'], project: ['qa', 'tl', 'cm', 'pmo'] },
  'gate:item:add': { global: ['admin', 'pmo'], project: ['pm', 'qa'] },
  // 里程碑
  'milestone:create': { global: ['admin', 'pmo'], project: ['pm'] },
  'milestone:edit': { global: ['admin', 'pmo'], project: ['pm'] },
  'milestone:delete': { global: ['admin'], project: ['pm'] },
  // WBS / 看板
  'wbs:edit': { global: ['admin', 'pmo'], project: ['pm', 'tl'] },
  'wbs:delete': { global: ['admin'], project: ['pm', 'tl'] },
  'task:status': { global: ['admin', 'pmo', 'pm', 'tl', 'member', 'qa', 'po', 'cm'], project: [] },
  'board:config': { global: ['admin', 'pmo'], project: ['pm', 'tl'] },
  // 周报
  'report:write': { global: ['admin', 'pmo', 'pm', 'tl', 'member', 'qa', 'po', 'cm'], project: [] },
  // 评审
  'review:start': { global: ['admin', 'pmo'], project: ['pm', 'tl'] },
  'review:decide': { global: ['admin', 'pmo', 'management', 'tl'], project: ['pm', 'tl', 'po', 'pmo'] },
  'review:proxy': { global: ['admin'], project: ['pm'] },
  // 变更
  'change:create': { global: ['admin', 'pmo'], project: ['pm', 'tl'] },
  'change:submit': { global: ['admin', 'pmo'], project: ['pm'] },
  // 管理后台
  'admin:user:role': { global: ['admin'], project: [] },
  'admin:audit:view': { global: ['admin', 'pmo'], project: [] },
  'admin:template': { global: ['admin', 'pmo'], project: [] },
};

/** 全部 action 列表（自检用） */
export const ALL_ACTIONS = Object.keys(PERMISSIONS);

/**
 * 判定用户是否具备某 action（前端显隐用）
 * @param globalRole 用户全局角色
 * @param action     权限动作
 * @param projectRoles 用户在当前项目中的角色集合
 */
export function canDo(
  globalRole: GlobalRole | undefined,
  action: string,
  projectRoles: ProjectRole[] = [],
): boolean {
  if (!globalRole) return false;
  if (globalRole === 'admin') return true;
  const rule = PERMISSIONS[action];
  if (!rule) return false;
  if (rule.global.includes(globalRole)) return true;
  return projectRoles.some((r) => rule.project.includes(r));
}
