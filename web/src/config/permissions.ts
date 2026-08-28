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

/**
 * 权限矩阵：action → 允许的角色（编译期默认；运行时由 hydratePermissions 覆盖）。
 *
 * ⚠ 必须与 `server/config/permissions.js` 的 `DEFAULT_PERMISSIONS` **逐 key 逐角色**一致：
 *   - 后端 `canDo` 运行时读 DB 驱动的 `permissionCatalog`（种子即 DEFAULT_PERMISSIONS）；
 *   - 本常量仅作前端按钮显隐 + 未注入矩阵时的降级兜底；
 *   - 一致性由 `scripts/check_permissions_sync.mjs` 离线校验（手动执行，不接入主流程）。
 * 任何一侧改动另一侧必须同步（含新增的 v25 三个后台配置 action）。
 */
export const PERMISSIONS: Record<string, PermRule> = {
  // 项目
  'project:create': { roles: ['admin', 'cpo', 'cto', 'management', 'pm', 'pmo', 'po', 'sale', 'tl'] },
  'project:edit': { roles: ['admin', 'cpo', 'cto', 'management', 'pm', 'pmo', 'po', 'sale', 'tl'] },
  'project:delete': { roles: ['admin'] },
  'project:transition': { roles: ['admin', 'cpo', 'cto', 'management', 'pm', 'pmo', 'po', 'sale', 'tl'] },
  'project:close': { roles: ['admin', 'cpo', 'cto', 'management', 'pmo', 'sale'] },
  'project:member:assign': { roles: ['admin', 'cpo', 'cto', 'management', 'pm', 'pmo', 'po', 'sale'] },
  // 质量门（挂在里程碑上 · 决策 D-A）
  'gate:decide': { roles: ['admin', 'cpo', 'cto', 'management', 'pmo', 'qa'] },
  'gate:item:check': { roles: ['admin', 'cm', 'cpo', 'cto', 'management', 'pmo', 'po', 'qa', 'tl'] },
  'gate:item:add': { roles: ['admin', 'cpo', 'cto', 'management', 'pm', 'pmo', 'po', 'qa', 'sale', 'tl'] },
  // 里程碑
  'milestone:create': { roles: ['admin', 'cpo', 'cto', 'management', 'pm', 'pmo', 'po', 'sale'] },
  'milestone:edit': { roles: ['admin', 'cpo', 'cto', 'management', 'pm', 'pmo', 'po', 'sale'] },
  'milestone:delete': { roles: ['admin', 'cpo', 'cto', 'management', 'pm', 'pmo', 'po', 'sale'] },
  // WBS / 看板
  'wbs:edit': { roles: ['admin', 'cm', 'cpo', 'cto', 'dev', 'management', 'member', 'ops', 'pm', 'pmo', 'po', 'qa', 'sale', 'tl', 'ued'] },
  'wbs:delete': { roles: ['admin', 'cm', 'cpo', 'cto', 'dev', 'management', 'member', 'ops', 'pm', 'pmo', 'po', 'qa', 'sale', 'tl', 'ued'] },
  'task:status': { roles: ['admin', 'cm', 'cpo', 'cto', 'dev', 'management', 'member', 'ops', 'pm', 'pmo', 'po', 'qa', 'sale', 'tl', 'ued'] },
  'board:config': { roles: ['admin', 'management', 'pm', 'pmo', 'tl'] },
  // 周报
  'report:write': { roles: ['admin', 'cm', 'cpo', 'cto', 'dev', 'management', 'member', 'ops', 'pm', 'pmo', 'po', 'qa', 'sale', 'tl', 'ued'] },
  // 评审
  'review:start': { roles: ['admin', 'cpo', 'cto', 'dev', 'management', 'member', 'ops', 'pm', 'pmo', 'po', 'sale', 'tl', 'ued'] },
  'review:decide': { roles: ['admin', 'cpo', 'cto', 'management', 'pm', 'pmo', 'po', 'sale', 'tl'] },
  'review:proxy': { roles: ['admin', 'management', 'pm'] },
  // 变更
  'change:create': { roles: ['admin', 'cpo', 'cto', 'management', 'member', 'pm', 'pmo', 'po', 'sale', 'tl'] },
  'change:submit': { roles: ['admin', 'cpo', 'cto', 'management', 'member', 'pm', 'pmo', 'po', 'sale', 'tl'] },
  // 全局仪表盘（B12）：仅管理三角色可看「公司全量」范围（scope=global 才跨项目生效）
  'dashboard:global': { roles: ['admin', 'cho', 'cpo', 'cto', 'management', 'pmo'] },
  // 管理后台
  'admin:user:role': { roles: ['admin', 'cho'] },
  'admin:audit:view': { roles: ['admin', 'cho', 'cpo', 'cto', 'management', 'pmo'] },
  'admin:template': { roles: ['admin', 'management', 'pmo'] },
  // 后台配置类（v25 新增，默认仅 admin，可在权限矩阵页放开）
  'admin:permission:config': { roles: ['admin'] },
  'admin:feishu:import': { roles: ['admin'] },
  // 工作日志管理（删除 / 编辑他人草稿，v25 新增，默认仅 admin）
  'report:manage': { roles: ['admin'] },
  // 任务附件（C01）：上传面向所有项目参与者，删除仅管理员 / 项目负责人
  'document:upload': { roles: ['admin', 'cm', 'cpo', 'cto', 'dev', 'management', 'member', 'ops', 'pm', 'pmo', 'po', 'qa', 'sale', 'tl', 'ued'] },
  'document:delete': { roles: ['admin', 'cpo', 'cto', 'management'] },
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
