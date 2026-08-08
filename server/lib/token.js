/**
 * 会话令牌：HMAC-SHA256 签名的无状态 Bearer token
 *
 * 结构：`base64url(payload).base64url(hmac)`
 * payload = `{ uid, oid, nm, rl, exp }`
 *
 * ⚠ `rl`（角色）只是历史遗留的展示快照，**鉴权时一律以数据库 users.global_role 为准**
 *   （见 server/middleware/auth.js）—— 否则改角色后旧 token 仍带旧权限。
 * ⚠ 与旧版 server.js 的 token 结构完全兼容，升级后老 token 不会集体失效。
 */
const crypto = require('crypto');
const cfg = require('../../config');

/** 令牌有效期（毫秒）：7 天 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 计算签名。
 * @param {string} payload base64url 编码的载荷
 * @returns {string}
 */
function sign(payload) {
  return crypto.createHmac('sha256', cfg.SESSION_SECRET).update(payload).digest('base64url');
}

/**
 * 签发令牌。
 * @param {{id: number, open_id: string, name: string, global_role: string}} userRow users 表行
 * @returns {string}
 */
function signToken(userRow) {
  const payload = Buffer.from(
    JSON.stringify({
      uid: userRow.id,
      oid: userRow.open_id,
      nm: userRow.name,
      rl: userRow.global_role,
      exp: Date.now() + TTL_MS,
    })
  ).toString('base64url');
  return payload + '.' + sign(payload);
}

/**
 * 校验并解析令牌；无效 / 过期返回 null。
 * @param {string} token
 * @returns {{uid: number, oid: string, nm: string, rl: string, exp: number}|null}
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const idx = token.indexOf('.');
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);

  const expect = sign(payload);
  // 定长比较，避免时序侧信道
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;

  let p;
  try {
    p = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch (e) {
    return null;
  }
  if (!p || !p.exp || p.exp < Date.now()) return null;
  return p;
}

/**
 * 从请求头中提取 Bearer token。
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function bearerOf(req) {
  const h = (req.headers && req.headers['authorization']) || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

module.exports = { signToken, verifyToken, bearerOf, TTL_MS };
