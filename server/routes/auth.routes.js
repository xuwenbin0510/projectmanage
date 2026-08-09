/**
 * 认证路由（§3.5）
 *
 *  POST /api/auth/devlogin  {openId}   → Session   （受 ALLOW_DEV_LOGIN 开关控制）
 *  POST /api/auth/feishu    {code}     → Session
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

    const ts = nowIso();
    let row = db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId);
    if (!row) {
      const name = await feishu.getUserName(session.access_token, openId);
      const isBootstrapAdmin = (cfg.ADMIN_OPEN_IDS || []).indexOf(openId) >= 0;
      db.prepare(
        `INSERT INTO users (open_id, employee_id, name, email, dept, avatar_url, global_role, status, created_at, updated_at)
         VALUES (?, '', ?, '', '', ?, ?, 'active', ?, ?)`,
      ).run(openId, name, String(session.avatar_url || ''), isBootstrapAdmin ? 'admin' : 'member', ts, ts);
      row = db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId);
    } else if (row.status === 'disabled') {
      throw new AppError(ErrorCode.E_FORBIDDEN, '该账号已停用', { openId: openId });
    }

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
