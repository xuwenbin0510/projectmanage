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
const { verifyPassword, hashPassword } = require('../lib/password');

/**
 * E1.5：取用户「主职位（users.global_role）+ 额外职位（user_roles）」合并去重后的全局职位数组，
 * 经 `toApiUser` 输出 `globalRoles` 合并数组（前端 RBAC 门禁/判权据此数组判定）。
 * ⚠ 此前 auth 各端点只传 `toApiUser(row)` 而漏传 extraRoles，导致 user_roles 里的
 *   admin/cto/pmo 等额外职位被丢弃，合并数组仅剩主职位 → 多职位用户门禁/判权失效。
 * @param {object} row users 表行（含 open_id / global_role）
 * @returns {object|null}
 */
function toApiUserWithRoles(row) {
  if (!row) return toApiUser(row);
  let extra = [];
  try {
  extra = db
    .prepare('SELECT role_key FROM user_roles WHERE role_user_id = ?')
    .all(row.id)
      .map(function (r) { return String(r.role_key); });
  } catch (e) {
    // user_roles 表尚未创建（迁移前）时安全降级为仅主职位
  }
  return toApiUser(row, extra);
}

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
 * 登录时同步拉取飞书邮箱（需应用开通「获取用户邮箱信息」权限），写回 users.email。
 *
 * @param {string} openId 飞书 open_id
 * @param {string} accessToken 用户级 access_token（用于取姓名/邮箱，失败静默回退 openId）
 * @param {string} [avatarUrl] 头像 URL（v2 端点不返回时传空）
 * @returns {Promise<object>} users 行
 * @throws {AppError} E_FORBIDDEN 账号已停用
 */
async function upsertFeishuUser(openId, accessToken, avatarUrl, session) {
  const ts = nowIso();
  const unionId = (session && session.union_id) || '';
  const feishuEmail = (session && session.email) || '';

  // 优先认回已有账号：email（已开权限、最稳）> union_id（跨应用不变）> open_id
  let row = null;
  if (feishuEmail) row = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(feishuEmail.toLowerCase());
  if (!row && unionId) row = db.prepare('SELECT * FROM users WHERE union_id = ?').get(unionId);
  if (!row) row = db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId);

  // 姓名兜底（仅当 email/union_id/open_id 全 miss 时）：TRIM + 忽略大小写，且全表该姓名唯一才认回。
  // 防重名误绑：命中 ≥2 条视为不可靠，不当做认回（走下方新建分支，由管理员在用户管理合并）。
  const feishuName = (session && session.name) || '';
  if (!row && feishuName) {
    const matches = db
      .prepare('SELECT * FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))')
      .all(feishuName);
    if (matches.length === 1) row = matches[0];
    else if (matches.length > 1) {
      console.warn('[feishu] 姓名「' + feishuName + '」命中 ' + matches.length + ' 条，放弃姓名认回以防误绑');
    }
  }

  // 用 user_access_token 拉通讯录资料（name/email/union_id 兜底，user_info 已有则直接用）
  let profile = { name: '', email: '', union_id: '' };
  try {
    profile = await feishu.getUserProfile(accessToken, openId, { name: session && session.name, email: feishuEmail, union_id: unionId });
  } catch (e) {
    console.warn('[feishu] getUserProfile 失败（通讯录权限或 open_id cross-app），用 user_info 兜底:', e && e.message);
  }
  const name = (session && session.name) || profile.name || '';
  const email = feishuEmail || profile.email || '';
  const resolvedUnionId = unionId || profile.union_id || '';

  if (!row) {
    // 授权闸门：飞书 OAuth 仅认回「已存在」的账号（email / union_id / open_id / 唯一姓名），
    // 未授权（全新人员）严格拒绝，**不自动建号**，避免非授权人员静默拿到账号。
    // 管理员预授权 = 预建账号并置 pending，随后在 AdminUsersPage「授权」翻为 active。
    throw new AppError(
      ErrorCode.E_FORBIDDEN,
      '您尚未被授权使用本系统，请联系管理员开通（邮箱：' + feishuEmail + '）',
      { email: feishuEmail },
    );
  }

  // 已认回账号：按 status 闸门放行 / 拒绝（与密码登录口径一致）
  if (row.status === 'pending') {
    throw new AppError(
      ErrorCode.E_FORBIDDEN,
      '该账号已预授权，正等待管理员启用，请稍后或联系管理员',
      { openId: openId },
    );
  }
  if (row.status === 'disabled') {
    throw new AppError(ErrorCode.E_FORBIDDEN, '该账号已停用', { openId: openId });
  }

  // active：写回新 open_id / union_id 并补全姓名邮箱
  const nextOpenId = openId;
  const nextUnionId = resolvedUnionId || row.union_id;
  const nextName = name && name !== row.name ? name : row.name;
  const nextEmail = email && !row.email ? email : row.email;
  if (nextOpenId !== row.open_id || nextUnionId !== row.union_id || nextName !== row.name || nextEmail !== row.email) {
    db.prepare(
      'UPDATE users SET open_id = ?, union_id = ?, name = ?, email = ?, updated_at = ? WHERE id = ?',
    ).run(nextOpenId, nextUnionId, nextName, nextEmail, ts, row.id);
    row = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
  }

  return row;
}

/* ── 邮箱密码登录（主登录方式） ─────────────────────────── */

router.post(
  '/auth/login',
  asyncHandler(async function login(req, res) {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');

    if (!email) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'email', message: '请输入邮箱' }],
      });
    }
    if (!password) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'password', message: '请输入密码' }],
      });
    }

    const row = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);
    if (!row) {
      throw new AppError(ErrorCode.E_UNAUTHORIZED, '邮箱或密码错误');
    }
    if (row.status !== 'active') {
      // 与飞书登录口径一致：pending（待管理员授权）/ disabled（已停用）均拒绝密码登录
      throw new AppError(
        ErrorCode.E_FORBIDDEN,
        row.status === 'pending' ? '该账号待管理员授权，暂不可登录' : '该账号已停用',
      );
    }

    const okPwd = await verifyPassword(password, row.password_hash);
    if (!okPwd) {
      throw new AppError(ErrorCode.E_UNAUTHORIZED, '邮箱或密码错误');
    }

    res.json(
      ok(
        {
          token: signToken(row),
          user: toApiUserWithRoles(row),
          mustChangePwd: row.must_change_pwd === 1,
        },
        '登录成功',
      ),
    );
  }),
);

/* ── 修改密码（首次登录强制改密 / 主动修改） ─────────── */

router.post(
  '/auth/change-password',
  requireAuth,
  asyncHandler(async function changePassword(req, res) {
    const me = req.user && req.user.open_id;
    const oldPassword = String((req.body && req.body.oldPassword) || '');
    const newPassword = String((req.body && req.body.newPassword) || '');

    if (!me) {
      throw new AppError(ErrorCode.E_UNAUTHORIZED, '请先登录');
    }
    if (!newPassword || newPassword.length < 6) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'newPassword', message: '新密码至少 6 位' }],
      });
    }

    const row = db.prepare('SELECT * FROM users WHERE open_id = ?').get(me);
    if (!row) {
      throw new AppError(ErrorCode.E_NOT_FOUND, '用户不存在');
    }

    // 首次登录强制改密（must_change_pwd=1）或尚未设置密码时跳过旧密码校验；
    // 其余主动改密场景仍校验旧密码，防止他人冒用令牌改密。
    if (row.password_hash && row.must_change_pwd !== 1) {
      const okOld = await verifyPassword(oldPassword, row.password_hash);
      if (!okOld) {
        throw new AppError(ErrorCode.E_VALIDATION, undefined, {
          fields: [{ field: 'oldPassword', message: '原密码错误' }],
        });
      }
    }

    const hashed = await hashPassword(newPassword);
    const ts = nowIso();
    db.prepare(
      'UPDATE users SET password_hash = ?, must_change_pwd = 0, updated_at = ? WHERE open_id = ?'
    ).run(hashed, ts, me);

    res.json(ok(null, '密码已更新'));
  }),
);

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

    const row = await upsertFeishuUser(openId, session.access_token, session.avatar_url, session);
    res.json(ok({ token: signToken(row), user: toApiUserWithRoles(row) }, '登录成功'));
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
        res.json(ok({ token: signToken(devRow), user: toApiUserWithRoles(devRow) }, '登录成功（开发降级）'));
        return;
      }
      throw new AppError(
        ErrorCode.E_FORBIDDEN,
        '服务端未配置飞书应用凭证（FEISHU_APP_ID / FEISHU_APP_SECRET）',
        { required: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'] },
      );
    }

    const appToken = await feishu.getAppAccessToken();
    let session;
    try {
      session = await feishu.code2session(code, appToken);
    } catch (e) {
      console.error('[feishu-web] code2session failed:', e && e.message);
      throw new AppError(ErrorCode.E_UNAUTHORIZED, '飞书授权失败：' + (e && e.message ? e.message : '未知错误'));
    }
    const openId = session && session.open_id ? String(session.open_id) : '';
    if (!openId) {
      console.error('[feishu-web] code2session returned empty open_id, data=', JSON.stringify(session));
      throw new AppError(ErrorCode.E_UNAUTHORIZED, '飞书授权失败：未获取到用户标识，请重试');
    }

    const row = await upsertFeishuUser(openId, session.access_token, '', session);
    res.json(ok({ token: signToken(row), user: toApiUserWithRoles(row) }, '登录成功'));
  }),
);

/* ── 当前用户 ───────────────────────────────────────── */

router.get(
  '/auth/me',
  requireAuth,
  asyncHandler(async function me(req, res) {
    res.json(ok(toApiUserWithRoles(req.user)));
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
