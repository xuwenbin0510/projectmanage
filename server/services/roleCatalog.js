'use strict';

/**
 * 角色视野维度：运行时解析器（单一真相源 = `roles` 表的 scope 列）
 *
 * 设计：
 *  - 缓存(module-level Map)在 server 启动(迁移 + 种子后)由 db.js 调用 refreshRoleCatalog(db) 预热；
 *  - 之后 canDo / 审批兜底判定走缓存，零 DB 依赖、零写死角色名；
 *  - 管理后台修改角色 scope 后须调用 refreshRoleCatalog(db) 刷新，确保运行时立即跟随（无需重启）。
 *
 * 这样：你在后台把任意角色的 scope 从 global↔project（或新增角色），下面三件事自动跟随：
 *   ① 审批链兜底池（谁有资格跨项目兜底）
 *   ② 权限判定（一个角色能不能跨项目干活）
 *   ③ 「全局角色」识别（devlogin / 管理闸门）
 */
let catalog = null; // Map<role_key, {role_key,name,scope,order_no,enabled}>

/** 从 `roles` 表重新载入缓存（启动预热 + 角色编辑后刷新） */
function refreshRoleCatalog(db) {
  const rows = db
    .prepare('SELECT role_key, name, scope, order_no, enabled FROM roles')
    .all();
  const map = new Map();
  rows.forEach(function (r) {
    map.set(r.role_key, {
      role_key: r.role_key,
      name: r.name,
      scope: r.scope,
      order_no: r.order_no,
      enabled: r.enabled,
    });
  });
  catalog = map;
  return map;
}

function getCatalog() {
  return catalog || new Map();
}

function getRole(role) {
  return catalog ? catalog.get(role) : undefined;
}

function getRoleScope(role) {
  const r = getRole(role);
  return r ? r.scope : null;
}

function isGlobalRole(role) {
  return getRoleScope(role) === 'global';
}

function isProjectRole(role) {
  return getRoleScope(role) === 'project';
}

function isEnabledRole(role) {
  const r = getRole(role);
  return !!(r && r.enabled);
}

/** 审批兜底池：所有 scope=global 且启用的角色，按 order_no 升序 */
function globalFallbacks() {
  const c = getCatalog();
  return Array.from(c.values())
    .filter(function (r) {
      return r.scope === 'global' && r.enabled;
    })
    .sort(function (a, b) {
      return a.order_no - b.order_no;
    })
    .map(function (r) {
      return r.role_key;
    });
}

/** 全部角色 key（启用与否均含；需筛启用请配合 isEnabledRole） */
function allRoleKeys() {
  return Array.from(getCatalog().keys());
}

module.exports = {
  refreshRoleCatalog,
  getCatalog,
  getRole,
  getRoleScope,
  isGlobalRole,
  isProjectRole,
  isEnabledRole,
  globalFallbacks,
  allRoleKeys,
};
