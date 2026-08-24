'use strict';

/**
 * 权限矩阵运行时缓存（B19 阶段一 · 判定内核）
 *
 * 设计（与 server/services/roleCatalog.js 同构）：
 *  - 缓存(module-level Map)在 server 启动(迁移 + 种子后)由 db.js 调用 loadCatalog(db) 预热；
 *  - 之后 `canDo` 走缓存，零 DB 依赖、同步读取
 *    （server/middleware/rbac.js 的 33 个 assertCan 调用点全是同步调用，canDo 绝不查 DB）；
 *  - 管理后台修改权限矩阵后须调用 invalidate() + loadCatalog(db) 刷新，确保运行时立即跟随（无需重启）。
 *
 * 防锁死（与 canDo 内 admin 短路共同构成双保险）：
 *  - `RBAC_CONFIG_SOURCE === 'constant'` 时 rolesFor 直接返回 DEFAULT_PERMISSIONS，完全不读 DB（逃生舱）；
 *  - 缓存未载入 / 为空时 rolesFor 降级返回 DEFAULT_PERMISSIONS[action]?.roles || []（兜底 + 重置基线）。
 *  两者都保证「哪怕配置写坏 / 缓存空 / DB 不可达，canDo 仍有合理默认」，配合 canDo 内 admin 短路，永不锁死。
 *
 * ⚠ 本文件**不**在模块顶层 require permissions.js，避免与 permissions.js 相互引用形成加载期循环；
 *   DEFAULT_PERMISSIONS 仅在 rolesFor 调用时惰性 require（届时所有模块均已加载完）。
 */

let ruleCache = null; // Map<action, Map<roleKey, granted(0|1)>>
let actionMeta = null; // Map<action, {action,label,group_key,group_label,order_no,enabled,builtin}>

/**
 * 读取 roles 表「存在且启用」的 role_key 集合（软忽略不存在/停用的角色）。
 * @param {import('better-sqlite3').Database} db
 * @returns {Set<string>}
 */
function loadEnabledRoles(db) {
  try {
    const rows = db.prepare("SELECT role_key FROM roles WHERE enabled = 1").all();
    const set = new Set();
    rows.forEach(function (r) {
      set.add(r.role_key);
    });
    return set;
  } catch (e) {
    // roles 表尚未建立（极端情况）时，视为「全部放行」，避免软忽略逻辑误伤
    return new Set();
  }
}

/**
 * 从 DB 重新载入缓存（启动预热 + 配置写后刷新）。
 * 载入时跳过 roles 表中不存在/停用的 role_key（软忽略），等价于「该角色无此权限」。
 * @param {import('better-sqlite3').Database} db
 * @returns {{rules: Map, actions: Map}}
 */
function loadCatalog(db) {
  const enabled = loadEnabledRoles(db);

  const ruleRows = db.prepare('SELECT action, role_key, granted FROM permission_rules').all();
  const rules = new Map();
  ruleRows.forEach(function (r) {
    // 软忽略不存在 / 停用的角色：不进入缓存，等价于「该角色无此权限」
    if (!enabled.has(r.role_key)) return;
    if (!rules.has(r.action)) rules.set(r.action, new Map());
    rules.get(r.action).set(r.role_key, r.granted);
  });

  let meta = new Map();
  try {
    const metaRows = db
      .prepare(
        'SELECT action, label, group_key, group_label, description, order_no, enabled, builtin '
        + 'FROM permission_actions ORDER BY order_no'
      )
      .all();
    metaRows.forEach(function (m) {
      meta.set(m.action, {
        action: m.action,
        label: m.label,
        group_key: m.group_key,
        group_label: m.group_label,
        description: m.description,
        order_no: m.order_no,
        enabled: m.enabled,
        builtin: m.builtin,
      });
    });
  } catch (e) {
    meta = new Map();
  }

  ruleCache = rules;
  actionMeta = meta;
  return { rules: rules, actions: meta };
}

/**
 * 返回某 action 的授权角色集合，形状固定为 `{ roles: string[] }`，
 * 以便 `canDo` 直接以 `rule.roles` 使用（与旧常量形态逐字兼容，无需改动 canDo 的 5 个判定步骤）。
 *
 *  - `RBAC_CONFIG_SOURCE === 'constant'`：直接返回 DEFAULT_PERMISSIONS，完全不读 DB（逃生舱）；
 *  - 缓存未载入 / 为空：降级返回 DEFAULT_PERMISSIONS[action]?.roles || []（兜底 + 重置基线）。
 *
 * @param {string} action 已解析的 action key（引擎别名由 canDo 负责解析，这里只认 key）
 * @returns {{roles: string[]}}
 */
function rolesFor(action) {
  if (process.env.RBAC_CONFIG_SOURCE === 'constant') {
    const { DEFAULT_PERMISSIONS } = require('../config/permissions');
    const r = DEFAULT_PERMISSIONS[action];
    return { roles: (r && r.roles) || [] };
  }
  if (!ruleCache || ruleCache.size === 0) {
    const { DEFAULT_PERMISSIONS } = require('../config/permissions');
    const r = DEFAULT_PERMISSIONS[action];
    return { roles: (r && r.roles) || [] };
  }
  const inner = ruleCache.get(action);
  if (!inner) return { roles: [] };
  const out = [];
  inner.forEach(function (granted, roleKey) {
    if (granted) out.push(roleKey);
  });
  return { roles: out };
}

/** 全部 action 元数据（只读展示用，管理后台阶段二渲染矩阵） */
function allActions() {
  return Array.from((actionMeta || new Map()).values());
}

function getActionMeta() {
  return actionMeta || new Map();
}

function getRuleCache() {
  return ruleCache;
}

/** 清空缓存（管理接口写后调用，迫使下次使用最新 DB 数据） */
function invalidate() {
  ruleCache = null;
  actionMeta = null;
}

module.exports = {
  loadCatalog,
  rolesFor,
  allActions,
  getActionMeta,
  getRuleCache,
  invalidate,
};
