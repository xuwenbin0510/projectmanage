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
  // 质量门（挂在里程碑上 · 决策 D-A）
  'gate:decide': { global: ['admin', 'pmo', 'qa', 'tl'], project: ['qa', 'tl', 'pmo'] },
  'gate:item:check': { global: ['admin', 'pmo', 'qa', 'tl', 'cm'], project: ['qa', 'tl', 'cm', 'pmo'] },
  'gate:item:add': { global: ['admin', 'pmo'], project: ['pm', 'qa'] },
  // 里程碑（本轮启用增删改与状态覆盖）
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
  // 全局仪表盘（B12）：仅管理三角色可看「公司全量」范围
  'dashboard:global': { global: ['admin', 'pmo', 'management'], project: [] },
  // 管理后台
  'admin:user:role': { global: ['admin'], project: [] },
  'admin:audit:view': { global: ['admin', 'pmo'], project: [] },
  'admin:template': { global: ['admin', 'pmo'], project: [] },
  // 任务附件（C01）：上传面向所有项目参与者，删除仅管理员 / 项目负责人
  'document:upload': { global: ['admin', 'pmo', 'pm', 'tl', 'member', 'qa', 'po', 'cm'], project: [] },
  'document:delete': { global: ['admin'], project: ['pm'] },
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
  const rule = PERMISSIONS[action];
  if (!rule) return false;
  if (list.some((g) => rule.global.includes(g as GlobalRole))) return true;
  return projectRoles.some((r) => rule.project.includes(r as ProjectRole));
}
