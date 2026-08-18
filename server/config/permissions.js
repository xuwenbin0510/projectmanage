/**
 * 权限矩阵（服务端权威源 · P0-10）
 *
 * @sync-with web/src/config/permissions.ts
 *
 * ⚠ 主理人决策 Q2：本批次（B3）采用**手工双写**保持两端一致，不引入跨端共享 json。
 *   任何一侧改动，另一侧必须同步；`scripts/smoke_b3.mjs` 会断言两端 action key 集合完全相等。
 *
 * ⚠ 前端 `PERMISSIONS` 只用于按钮显隐，**不是安全边界**；
 *   真正的把关在这里 + `server/middleware/rbac.js`。
 */

/**
 * action → 允许的角色。
 * - `global`：满足任一全局角色即可
 * - `project`：或满足任一项目级角色
 * @type {Object<string, {global: string[], project: string[]}>}
 */
const PERMISSIONS = {
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

/** 全部 action 列表（自检 / smoke 断言用） */
const ALL_ACTIONS = Object.keys(PERMISSIONS);

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
 * 逻辑与前端 `canDo` 逐字一致：admin 全通过；命中全局角色或项目角色即通过。
 *
 * @param {string} globalRole 用户全局角色
 * @param {string} action 权限动作（已解析的 action key，或引擎别名）
 * @param {string[]} [projectRoles] 用户在目标项目中的角色集合
 * @returns {boolean}
 */
function canDo(globalRole, action, projectRoles) {
  if (!globalRole) return false;
  if (globalRole === 'admin') return true;
  const key = ACTION_KEY[action] || action;
  const rule = PERMISSIONS[key];
  if (!rule) return false;
  if (rule.global.indexOf(globalRole) >= 0) return true;
  const roles = projectRoles || [];
  return roles.some(function (r) {
    return rule.project.indexOf(r) >= 0;
  });
}

module.exports = { PERMISSIONS, ALL_ACTIONS, ACTION_KEY, canDo };
