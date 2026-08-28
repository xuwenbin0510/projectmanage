/**
 * 鉴权中间件
 *
 * 设计要点：
 *  - token 只用来确认「你是谁」（open_id），**角色一律回库查**，
 *    这样管理员改角色后立即生效，不必等旧 token 过期。
 *  - 用户被停用（status = 'disabled'）→ 403，而不是 401，避免前端反复跳登录页。
 *  - 挂载到 `req.user`，形态是 users 表行（snake_case），
 *    对外输出前必须经 mappers.toApiUser 转 camelCase。
 */
const db = require('../../db');
const { verifyToken, bearerOf } = require('../lib/token');
const { AppError, ErrorCode } = require('../lib/errors');

const selectByOpenId = db.prepare('SELECT * FROM users WHERE open_id = ?');
// 设计铁律：额外职位一律按系统身份键 users.id（列 role_user_id）解析，飞书 open_id 仅作同步属性
const selectExtraRoles = db.prepare('SELECT role_key FROM user_roles WHERE role_user_id = ?');

/**
 * 取用户全部全局职位（主职位 `users.global_role` + 额外职位 `user_roles` 合并去重）。
 * E1.5：权限判定按职位并集，任一命中即通过。
 * @param {Object} userRow users 表行
 * @returns {string[]}
 */
function resolveGlobalRoles(userRow) {
  if (!userRow) return [];
  const set = {};
  if (userRow.global_role) set[String(userRow.global_role)] = true;
  try {
    const extra = selectExtraRoles.all(userRow.id);
    extra.forEach(function (r) { if (r.role_key) set[String(r.role_key)] = true; });
  } catch (e) {
    // user_roles 表尚未创建（迁移前）时安全降级为仅主职位
  }
  return Object.keys(set);
}

/**
 * 是否管理员（任一全局职位为 admin 即视为管理员，E1.5 并集语义）。
 * @param {Object} userRow users 表行
 * @returns {boolean}
 */
function isAdmin(userRow) {
  return resolveGlobalRoles(userRow).indexOf('admin') >= 0;
}

/**
 * 解析当前请求的用户；解析不出来返回 null（不抛错）。
 * @param {import('express').Request} req
 * @returns {Object|null} users 表行
 */
function resolveUser(req) {
  const token = bearerOf(req);
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || !payload.oid) return null;
  return selectByOpenId.get(payload.oid) || null;
}

/**
 * 强制登录。成功后 `req.user` = users 表行。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 */
function requireAuth(req, res, next) {
  const user = resolveUser(req);
  if (!user) return next(new AppError(ErrorCode.E_UNAUTHORIZED));
  if (user.status !== 'active') {
    // 纵深防御：pending（待授权）/ disabled（已停用）一律拒绝，与登录闸门口径一致（pending 本不会拿到 token）
    return next(new AppError(ErrorCode.E_FORBIDDEN, user.status === 'pending' ? '账号待管理员授权，请联系管理员' : '账号已停用，请联系管理员'));
  }
  req.user = user;
  next();
}

/**
 * 可选登录：能解析就挂 `req.user`，解析不出来也放行。
 * 用于 `/api/auth/appid` 这类公开接口。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 */
function optionalAuth(req, res, next) {
  const user = resolveUser(req);
  if (user && user.status !== 'disabled') req.user = user;
  next();
}

/**
 * 全局角色白名单校验（须先经 requireAuth）。
 * @param {...string} roles 允许的 global_role
 * @returns {Function} express 中间件
 */
function requireGlobalRole() {
  const roles = Array.prototype.slice.call(arguments);
  return function guard(req, res, next) {
    if (!req.user) return next(new AppError(ErrorCode.E_UNAUTHORIZED));
    // E1.5：用户的全部全局职位取并集，命中任一允许职位即通过
    const myRoles = resolveGlobalRoles(req.user);
    if (!myRoles.some(function (r) { return roles.indexOf(r) >= 0; })) {
      return next(new AppError(ErrorCode.E_FORBIDDEN, '需要以下角色之一：' + roles.join(' / ')));
    }
    next();
  };
}

/**
 * 是否管理员：`isAdmin` 已在上方基于 `resolveGlobalRoles`（主职位 + 额外职位并集）定义，
 * 此处旧定义（仅认主职位 global_role）已移除，避免重复定义覆盖正确实现。
 */

module.exports = { requireAuth, optionalAuth, requireGlobalRole, resolveUser, isAdmin, resolveGlobalRoles };
