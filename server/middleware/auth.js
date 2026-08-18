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
  if (user.status === 'disabled') {
    return next(new AppError(ErrorCode.E_FORBIDDEN, '账号已停用，请联系管理员'));
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
    if (roles.indexOf(req.user.global_role) < 0) {
      return next(new AppError(ErrorCode.E_FORBIDDEN, '需要以下角色之一：' + roles.join(' / ')));
    }
    next();
  };
}

/**
 * 是否管理员。
 * @param {Object} userRow users 表行
 * @returns {boolean}
 */
function isAdmin(userRow) {
  return !!userRow && userRow.global_role === 'admin';
}

module.exports = { requireAuth, optionalAuth, requireGlobalRole, resolveUser, isAdmin };
