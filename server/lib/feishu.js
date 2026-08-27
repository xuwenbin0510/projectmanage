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
  const userToken = d.data && d.data.access_token;
  if (!userToken) throw new Error('code2session failed: empty access_token');

  // v1 网页授权换 token 不直接返回 open_id，需用用户 access_token 再调 user_info 获取
  const infoR = await fetch(FS_API + '/authen/v1/user_info', {
    headers: { Authorization: 'Bearer ' + userToken },
  });
  const info = await infoR.json();
  if (info.code !== 0) throw new Error('feishu user_info failed: ' + info.msg);
  const u = (info.data && info.data.user) || info.data || {};
  return {
    access_token: userToken,
    open_id: u.open_id || (info.data && info.data.open_id) || '',
    union_id: u.union_id || (info.data && info.data.union_id) || '',
    user_id: u.user_id || (info.data && info.data.user_id) || '',
    name: u.name || '',
    email: u.email || '',
    avatar_url: u.avatar_url || '',
  };
}

/**
 * 飞书 Web OAuth（网页应用）授权码换用户凭证（B4 · T03-1）。
 *
 * 对应端点 `POST /authen/v2/oidc/access_token`，与 JSSDK 免登的 v1 端点**不同**：
 * v2 把 `app_access_token` 放在 body（而非 Authorization 头）。
 *
 * 前置：调用方需先 `getAppAccessToken()`；飞书开放平台须登记重定向 URL，
 * 且应用开通 `contact:user.base:readonly` 才能取到姓名（缺失不影响登录）。
 *
 * @param {string} code 浏览器授权回调带回的临时授权码
 * @param {string} appToken 应用级 access_token
 * @returns {Promise<{access_token: string, open_id: string}>}
 * @throws {Error} 飞书返回非 0 code 时抛出
 */
async function code2sessionV2(code, appToken) {
  const r = await fetch(FS_API + '/authen/v2/oidc/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: code,
      app_access_token: appToken,
    }),
  });
  const d = await r.json();
  if (!d || d.code !== 0 || !d.data) {
    throw new Error('feishu web oidc failed: ' + ((d && (d.msg || d.error)) || 'unknown'));
  }
  return { access_token: d.data.access_token, open_id: d.data.open_id };
}

/**
 * 取用户姓名与邮箱；失败静默回退 open_id（登录不应因通讯录权限缺失而中断）。
 * 邮箱需要应用开通「获取用户邮箱信息」权限；未开通时返回空字符串。
 * @param {string} accessToken 用户级 access_token
 * @param {string} openId
 * @returns {Promise<{name: string, email: string}>}
 */
async function getUserProfile(accessToken, openId, fallback) {
  // fallback：user_info 已取到的 {name,email,union_id}，通讯录查不到时用它兜底
  const f = fallback || {};
  try {
    const r = await fetch(FS_API + '/contact/v3/users/' + openId + '?user_id_type=open_id', {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    const d = await r.json();
    if (d.code === 0 && d.data && d.data.user) {
      return {
        name: d.data.user.name || f.name || openId,
        email: d.data.user.email || f.email || '',
        union_id: d.data.user.union_id || f.union_id || '',
      };
    }
  } catch (e) { /* 忽略，回退 fallback */ }
  return { name: f.name || openId, email: f.email || '', union_id: f.union_id || '' };
}

/**
 * 兼容旧接口：仅取姓名。
 * @param {string} accessToken
 * @param {string} openId
 * @returns {Promise<string>}
 */
async function getUserName(accessToken, openId) {
  const p = await getUserProfile(accessToken, openId);
  return p.name;
}

/**
 * 仅取邮箱（用于后台批量回填）。
 * @param {string} accessToken
 * @param {string} openId
 * @returns {Promise<string>}
 */
async function getUserEmail(accessToken, openId) {
  const p = await getUserProfile(accessToken, openId);
  return p.email;
}

/* ── D02 · 飞书文档链接解析 + 标题抓取（文档关联） ────── */

/** 飞书链接路径段 → drive batch_query 的 doc_type 映射 */
const FS_DOC_TYPE_BY_SEG = {
  docx: 'docx',
  doc: 'doc',
  sheets: 'sheet',
  slides: 'slide',
  base: 'bitable',
  wiki: 'wiki',
  mindnotes: 'mindnote',
};

/**
 * 解析飞书文档链接 → { docType, token }；非飞书链接返回 null。
 * 支持 open.feishu.cn / 任意租户域（xxx.feishu.cn / xxx.larksuite.com）下的
 * docx / doc / sheets / slides / base / wiki / mindnotes。
 *
 * @param {string} url
 * @returns {{docType: string, token: string}|null}
 */
function parseFeishuUrl(url) {
  const s = String(url || '').trim();
  const m = /^https?:\/\/(?:[a-z0-9-]+\.)?(?:feishu\.cn|larksuite\.com)\/([a-z]+)\/([A-Za-z0-9_-]+)/i.exec(s);
  if (!m) return null;
  const docType = FS_DOC_TYPE_BY_SEG[String(m[1]).toLowerCase()];
  if (!docType) return null;
  return { docType: docType, token: m[2] };
}

/**
 * 抓飞书文档标题（D02 · 文档关联自动填充）。
 *
 * 走 `drive/v1/metas/batch_query`（对 docx/sheet/slide/bitable/wiki 等通用）。
 * 失败静默返回 ''（创建链接不受影响，前端展示用户填的名称或链接本身）。
 * 未配置 FEISHU_APP_ID / FEISHU_APP_SECRET 时直接返回 ''（本地演示环境降级为纯链接）。
 *
 * @param {string} url 飞书文档链接
 * @returns {Promise<string>} 标题；失败/非飞书链接/未配置凭证返回 ''
 */
async function fetchDocTitle(url) {
  const p = parseFeishuUrl(url);
  if (!p) return '';
  if (!cfg.FEISHU_APP_ID || !cfg.FEISHU_APP_SECRET) return '';
  try {
    const at = await getAppAccessToken();
    /* wiki 节点走专用接口（GET，参数走 query），drive/v1/metas/batch_query 对 wiki 不生效 */
    if (p.docType === 'wiki') {
      const q = '?token=' + encodeURIComponent(p.token) + '&obj_type=wiki';
      const r = await fetch(FS_API + '/wiki/v2/spaces/get_node' + q, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + at },
      });
      const d = await r.json();
      const node = d && d.data && d.data.node;
      return (node && node.title) || '';
    }
    const r = await fetch(FS_API + '/drive/v1/metas/batch_query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + at },
      body: JSON.stringify({ request_docs: [{ doc_token: p.token, doc_type: p.docType }] }),
    });
    const d = await r.json();
    const meta = d && d.data && Array.isArray(d.data.metas) ? d.data.metas[0] : null;
    return (meta && meta.title) || '';
  } catch (e) {
    console.warn('[feishu] fetchDocTitle 失败 url=' + url + ' : ' + (e && e.message));
    return '';
  }
}

module.exports = {
  FS_API,
  getAppAccessToken,
  code2session,
  code2sessionV2,
  getUserProfile,
  getUserName,
  getUserEmail,
  parseFeishuUrl,
  fetchDocTitle,
};
