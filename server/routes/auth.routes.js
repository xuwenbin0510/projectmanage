/**
 * 认证路由（§3.5）
 *
 *  POST /api/auth/devlogin    {openId} → Session   （受 ALLOW_DEV_LOGIN 开关控制）
 *  POST /api/auth/feishu      {code}   → Session   （飞书客户端内 JSSDK 免登，v1 端点）
 *  POST /api/auth/feishu/web  {code}   → Session   （普通浏览器 Web OAuth，v2 端点）
 *  GET  /api/auth/me                   → User      （注意：**直接返回 User**，不是 {user}）
 *  POST /api/auth/logout               → null      （无状态令牌，前端清本地即可）
 *  GET  /api/appid                     → {appId}   （免鉴权，飞书 JSSDK 用）
 *
 * 令牌为 HMAC 无状态方案；角色**每次请求从 DB 重读**（见 middleware/auth.js），
 * 令牌里的 `rl` 仅作快照，不作为权限判定依据。
 */

const express = require('express');

const cfg = require('../../config');
const db = require('../../db');
const { ok, asyncHandler, AppError, ErrorCode } = require('../lib/envelope');
const { signToken } = require('../lib/token');
const { requireAuth } = require('../middleware/auth');
const { toApiUser } = require('../lib/mappers');
const { nowIso } = require('../lib/dates');
const feishu = require('../lib/feishu');

const router = express.Router();

/**
 * 按 openId 取用户行，并做「存在 + 未停用」校验。
 * @param {string} openId
 * @returns {object} users 行
 * @throws {AppError} E_NOT_FOUND / E_FORBIDDEN
 */
function requireEnabledUser(openId) {
  const row = db.prepare('SELECT * FROM users WHERE open_id = ?').get(String(openId || ''));
  if (!row) {
    throw new AppError(ErrorCode.E_NOT_FOUND, '用户不存在，请从列表中选择', { openId: String(openId || '') });
  }
  if (row.status === 'disabled') {
    throw new AppError(ErrorCode.E_FORBIDDEN, '该账号已停用', { openId: String(openId || '') });
  }
  return row;
}

/**
 * 飞书用户 upsert：按 openId 落 `users` 行，已存在则原样取回（B4 · T03-2）。
 *
 * JSSDK 免登（`POST /auth/feishu`）与浏览器 Web OAuth（`POST /auth/feishu/web`）**共用**，
 * 保证同一 openId 只落同一行、角色判定口径一致。
 *
 * @param {string} openId 飞书 open_id
 * @param {string} accessToken 用户级 access_token（用于取姓名，失败静默回退 openId）
 * @param {string} [avatarUrl] 头像 URL（v2 端点不返回时传空）
 * @returns {Promise<object>} users 行
 * @throws {AppError} E_FORBIDDEN 账号已停用
 */
async function upsertFeishuUser(openId, accessToken, avatarUrl) {
  const ts = nowIso();
  let row = db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId);

  if (!row) {
    const name = await feishu.getUserName(accessToken, openId);
    const isBootstrapAdmin = (cfg.ADMIN_OPEN_IDS || []).indexOf(openId) >= 0;
    db.prepare(
      `INSERT INTO users (open_id, employee_id, name, email, dept, avatar_url, global_role, status, created_at, updated_at)
       VALUES (?, '', ?, '', '', ?, ?, 'active', ?, ?)`,
    ).run(openId, name, String(avatarUrl || ''), isBootstrapAdmin ? 'admin' : 'member', ts, ts);
    row = db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId);
  } else if (row.status === 'disabled') {
    throw new AppError(ErrorCode.E_FORBIDDEN, '该账号已停用', { openId: openId });
  }

  return row;
}

/* ── 开发免密登录（演示账号） ─────────────────────────── */

router.post(
  '/auth/devlogin',
  asyncHandler(async function devLogin(req, res) {
    if (!cfg.ALLOW_DEV_LOGIN) {
      throw new AppError(ErrorCode.E_FORBIDDEN, '当前环境已关闭免密登录', { switch: 'ALLOW_DEV_LOGIN' });
    }
    const openId = String((req.body && req.body.openId) || '').trim();
    if (!openId) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'openId', message: 'openId 不能为空' }],
      });
    }
    const row = requireEnabledUser(openId);
    res.json(ok({ token: signToken(row), user: toApiUser(row) }, '登录成功'));
  }),
);

/* ── 飞书登录 ───────────────────────────────────────── */

router.post(
  '/auth/feishu',
  asyncHandler(async function feishuLogin(req, res) {
    const code = String((req.body && req.body.code) || '').trim();
    if (!code) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'code', message: '缺少飞书免登 code' }],
      });
    }
    if (!cfg.FEISHU_APP_ID || !cfg.FEISHU_APP_SECRET) {
      throw new AppError(ErrorCode.E_FORBIDDEN, '服务端未配置飞书应用凭证', { required: 'FEISHU_APP_ID' });
    }

    const appToken = await feishu.getAppAccessToken();
    const session = await feishu.code2session(code, appToken);
    const openId = session && session.open_id ? String(session.open_id) : '';
    if (!openId) {
      throw new AppError(ErrorCode.E_UNAUTHORIZED, '飞书免登失败，请重新进入应用');
    }

    const row = await upsertFeishuUser(openId, session.access_token, session.avatar_url);
    res.json(ok({ token: signToken(row), user: toApiUser(row) }, '登录成功'));
  }),
);

/* ── 飞书网页登录（普通浏览器，Web OAuth · B4 T03-2） ── */

router.post(
  '/auth/feishu/web',
  asyncHandler(async function feishuWebLogin(req, res) {
    const code = String((req.body && req.body.code) || '').trim();
    if (!code) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'code', message: '缺少飞书授权 code' }],
      });
    }

    /* 降级路径（偏差 D-7）：未配飞书凭证且显式开启开发登录时，
       接受哨兵码 `dev:<openId>` 走通「回调 → 换码 → 签发会话」整条链路，
       待 FEISHU_APP_SECRET / 回调域名补齐后切真连零改动。 */
    if (!cfg.FEISHU_APP_ID || !cfg.FEISHU_APP_SECRET) {
      if (cfg.ALLOW_DEV_LOGIN && /^dev:/.test(code)) {
        const devId = code.slice(4).trim() || (cfg.ADMIN_OPEN_IDS || [])[0] || 'dev';
        const devRow = requireEnabledUser(devId);
        res.json(ok({ token: signToken(devRow), user: toApiUser(devRow) }, '登录成功（开发降级）'));
        return;
      }
      throw new AppError(
        ErrorCode.E_FORBIDDEN,
        '服务端未配置飞书应用凭证（FEISHU_APP_ID / FEISHU_APP_SECRET）',
        { required: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'] },
      );
    }

    const appToken = await feishu.getAppAccessToken();
    const session = await feishu.code2sessionV2(code, appToken);
    const openId = session && session.open_id ? String(session.open_id) : '';
    if (!openId) {
      throw new AppError(ErrorCode.E_UNAUTHORIZED, '飞书授权失败，请重试');
    }

    const row = await upsertFeishuUser(openId, session.access_token, '');
    res.json(ok({ token: signToken(row), user: toApiUser(row) }, '登录成功'));
  }),
);

/* ── 当前用户 ───────────────────────────────────────── */

router.get(
  '/auth/me',
  requireAuth,
  asyncHandler(async function me(req, res) {
    res.json(ok(toApiUser(req.user)));
  }),
);

/* ── 登出（无状态令牌，服务端不维护会话） ─────────────── */

router.post(
  '/auth/logout',
  asyncHandler(async function logout(req, res) {
    // TODO(后续批次): 会话可撤销（令牌黑名单 / 版本号）不在打通范围
    res.json(ok(null, '已登出'));
  }),
);

/* ── 飞书 AppID（免鉴权，前端 JSSDK 初始化用） ────────── */

router.get(
  '/appid',
  asyncHandler(async function appId(req, res) {
    res.json(ok({ appId: cfg.FEISHU_APP_ID || '' }));
  }),
);

module.exports = router;
