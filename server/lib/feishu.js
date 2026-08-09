/**
 * 飞书开放平台调用（从旧 server.js 原样搬迁，行为不变）
 * 免登流程：code → app_access_token → oidc/access_token → 用户名
 */
const cfg = require('../../config');

const FS_API = 'https://open.feishu.cn/open-apis';

/**
 * 取应用级 access_token。
 * @returns {Promise<string>}
 * @throws {Error} 飞书返回非 0 code 时抛出
 */
async function getAppAccessToken() {
  const r = await fetch(FS_API + '/auth/v3/app_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.FEISHU_APP_ID, app_secret: cfg.FEISHU_APP_SECRET }),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error('app_access_token failed: ' + d.msg);
  return d.app_access_token;
}

/**
 * 免登 code 换用户会话。
 * @param {string} code 前端 tt.requestAuthCode 拿到的临时票据
 * @param {string} appToken 应用级 access_token
 * @returns {Promise<{access_token: string, open_id: string, user_id: string}>}
 */
async function code2session(code, appToken) {
  const r = await fetch(FS_API + '/authen/v1/oidc/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + appToken },
    body: JSON.stringify({ grant_type: 'authorization_code', code: code }),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error('code2session failed: ' + d.msg);
  return d.data;
}

/**
 * 取用户姓名；失败静默回退 open_id（登录不应因通讯录权限缺失而中断）。
 * @param {string} accessToken 用户级 access_token
 * @param {string} openId
 * @returns {Promise<string>}
 */
async function getUserName(accessToken, openId) {
  try {
    const r = await fetch(FS_API + '/contact/v3/users/' + openId + '?user_id_type=open_id', {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    const d = await r.json();
    if (d.code === 0 && d.data && d.data.user) return d.data.user.name || openId;
  } catch (e) { /* 忽略，回退 open_id */ }
  return openId;
}

module.exports = { FS_API, getAppAccessToken, code2session, getUserName };
