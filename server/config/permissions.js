/**
 * 权限矩阵（服务端判定内核 · P0-10 · B19 可配置化）
 *
 * @sync-with web/src/config/permissions.ts
 *
 * ⚠ 主理人决策 Q2：本批次（B3）采用**手工双写**保持两端一致，不引入跨端共享 json。
 *   任何一侧改动，另一侧必须同步；`scripts/smoke_b3.mjs` 会断言两端 action key 集合完全相等。
 *
 * ⚠ 前端 `PERMISSIONS` 只用于按钮显隐，**不是安全边界**；真正的把关在 `server/middleware/rbac.js` + 本文件 `canDo`。
 *
 * ⚠（B19）服务端「权限矩阵」的**唯一权威源已下沉为数据库 `permission_rules` 表**，
 *   `canDo` 在运行时读取进程内缓存（见 `server/services/permissionCatalog.js`），零 DB 依赖、零写死。
 *   `DEFAULT_PERMISSIONS`（本文件）承担三重角色：
 *     ① 数据库 `permission_rules` 的**出生种子源**（迁移 v18 唯一写入源）；
 *     ② 缓存未载入 / `RBAC_CONFIG_SOURCE=constant` 逃生舱下的**降级兜底**；
 *     ③ 管理后台「恢复默认」的**重置基线**。
 *   它**不再是判定数据源**——改权限请改数据库，不要改这个常量。
 */

const { isGlobalRole } = require('../services/roleCatalog');
const permissionCatalog = require('../services/permissionCatalog');

/**
 * 权限矩阵**默认源**（种子源 + 降级兜底 + 重置基线，**非运行时判定数据源**）。
 *
 * 合并 global + project 的单一清单（action → 允许的角色）。
 * 跨项目 vs 仅项目内，由角色 scope 在运行时自动判定（见 canDo）：
 *   - 角色 scope=global → 跨项目生效
 *   - 角色 scope=project → 仅在其所在项目内生效
 * 因此本清单只需列「允许的角色」，不再区分维度。
 *
 * ⚠ 本常量只用于：
 *   ① 数据库 `permission_rules` 的出生种子（迁移 v18 唯一写入源）；
 *   ② 缓存未载入 / `RBAC_CONFIG_SOURCE=constant` 逃生舱下的降级兜底；
 *   ③ 管理后台「恢复默认」重置基线。
 * 运行时 `canDo` 读的是 DB 驱动的 `permissionCatalog.rolesFor()`，不是这里。
 *
 * @type {Object<string, {roles: string[]}>}
 */
const DEFAULT_PERMISSIONS = {
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
  // 里程碑
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
  // 全局仪表盘（B12）：仅管理三角色可看「公司全量」范围
  'dashboard:global': { roles: ['admin', 'pmo', 'management'] },
  // 管理后台
  'admin:user:role': { roles: ['admin'] },
  'admin:audit:view': { roles: ['admin', 'pmo'] },
  'admin:template': { roles: ['admin', 'pmo'] },
  // 任务附件（C01）：上传面向所有项目参与者，删除仅管理员 / 项目负责人
  'document:upload': { roles: ['admin', 'pmo', 'pm', 'tl', 'member', 'qa', 'po', 'cm'] },
  'document:delete': { roles: ['admin', 'pm'] },
};

/** 全部 action 列表（自检 / smoke 断言用） */
const ALL_ACTIONS = Object.keys(DEFAULT_PERMISSIONS);

/**
 * 引擎内部动作别名 → `PERMISSIONS` 的 action key。
 * 与前端 Mock 引擎的 `ACTION_KEY` 逐条一致，保证「同一个动作两端判同一条规则」。
 * @type {Object<string, string>}
 */
const ACTION_KEY = {
  'project.create': 'project:create',
  'project.edit': 'project:edit',
  'project.transition': 'project:transition',
  'member.manage': 'project:member:assign',
  'gate.check': 'gate:item:check',
  'gate.decide': 'gate:decide',
  'milestone.edit': 'milestone:edit',
  'wbs.edit': 'wbs:edit',
  'task.move': 'task:status',
  'board.config': 'board:config',
  'report.write': 'report:write',
  'review.create': 'review:start',
  'change.create': 'change:create',
  'change.apply': 'change:submit',
  'user.manage': 'admin:user:role',
};

/**
 * 判定用户是否具备某 action。
 * 逻辑与前端 `canDo` 逐字一致：admin 全通过；命中任一全局角色或任一项目角色即通过。
 *
 * **E1.5 多职位并集**：`globalRoles` 支持「用户全部全局职位」的数组
 *   （主职位 `users.global_role` + 额外职位 `user_roles` 合并去重）。
 *   任一全局职位命中规则即通过；为向后兼容，也接受单个字符串（自动包装为数组）。
 *
 * @param {string|string[]} globalRoles 用户全局职位（单值或数组；数组取并集）
 * @param {string} action 权限动作（已解析的 action key，或引擎别名）
 * @param {string[]} [projectRoles] 用户在目标项目中的角色集合
 * @returns {boolean}
 */
function canDo(globalRoles, action, projectRoles) {
  if (!globalRoles) return false;
  const list = Array.isArray(globalRoles) ? globalRoles : [globalRoles];
  if (!list.length) return false;
  // admin 全通过（任一全局职位为 admin 即通过）
  if (list.indexOf('admin') >= 0) return true;
  const key = ACTION_KEY[action] || action;
  // 第④步：数据源从写死常量切到「进程内权限矩阵缓存」（由 permissionCatalog 预热，零 DB 依赖）。
  // rule 形状保持 {roles: string[]}，其余 5 步（admin 短路 / scope / 项目内）逐字不变。
  const rule = permissionCatalog.rolesFor(key);
  if (!rule) return false;
  // 跨项目效力：仅真正 scope=global 的角色（由 roles 表决定，非写死）享有跨项目权力
  const cross = list.some(function (g) {
    return isGlobalRole(g) && rule.roles.indexOf(g) >= 0;
  });
  if (cross) return true;
  // 项目内效力：项目成员角色命中即可（项目成员天然是 project scope）
  const roles = projectRoles || [];
  return roles.some(function (r) {
    return rule.roles.indexOf(r) >= 0;
  });
}

module.exports = { DEFAULT_PERMISSIONS, ALL_ACTIONS, ACTION_KEY, canDo };
