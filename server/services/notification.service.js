/**
 * 站内通知服务（顶栏铃铛数据底座）
 *
 * 设计要点：
 *  - 一条通知只指向一个接收人；群发由调用方循环 `notify`（或一次传多个 recipients）。
 *  - 接收人解析 `resolveRecipients` 支持两类角色：
 *      · projectRoles  —— 项目内成员角色（pm / tl ...），查 project_members；
 *      · globalRoles   —— 全局职位（admin / pmo ...），查 users.global_role + user_roles。
 *  - 防自通知：写入前由调用方在 `excludeOpenId` 剔除发起人；resolveRecipients 也会剔除。
 *  - 所有写操作包在事务里，失败整体回滚。
 */

const ids = require('../lib/ids');
const dates = require('../lib/dates');
const mappers = require('../lib/mappers');

/** 合法通知类型（写入时校验，避免脏 type 进库） */
const NOTIFICATION_TYPES = {
  REVIEW_CREATED: 'REVIEW_CREATED',
  REVIEW_DECIDED: 'REVIEW_DECIDED',
  CHANGE_CREATED: 'CHANGE_CREATED',
  CHANGE_SUBMITTED: 'CHANGE_SUBMITTED',
  CHANGE_APPLIED: 'CHANGE_APPLIED',
  CHANGE_DECIDED: 'CHANGE_DECIDED',
};

/**
 * 解析接收人 open_id 集合（去重 + 剔除 excludeOpenId）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} [opts.projectId]   项目 id（projectRoles 解析需要）
 * @param {string[]} [opts.projectRoles] 项目内成员角色
 * @param {string[]} [opts.globalRoles]  全局职位
 * @param {string} [opts.excludeOpenId]  要剔除的 open_id（通常=发起人）
 * @returns {string[]} 去重后的 open_id 列表
 */
function resolveRecipients(db, opts) {
  const o = opts || {};
  const set = {};
  const projectRoles = (o.projectRoles || []).filter(Boolean);
  const globalRoles = (o.globalRoles || []).filter(Boolean);

  /* 设计修正：跨飞书空间身份统一。导入成员存于 project_members.user_open_id 的是
     「另一套飞书应用」的 open_id，与登录用户（主应用空间）的 open_id 对不上。
     故一律经 member_user_id / role_user_id（= users.id，系统唯一身份键）桥接回
     users.open_id（主空间），保证 emit 的 open_id 与 req.user.open_id 同空间、可正确匹配。 */
  if (o.projectId && projectRoles.length) {
    const qm = projectRoles.map(function () { return '?'; }).join(',');
    const rows = db
      .prepare('SELECT DISTINCT u.open_id FROM project_members pm JOIN users u ON u.id = pm.member_user_id WHERE pm.project_id = ? AND pm.project_role IN (' + qm + ')')
      .all(o.projectId, ...projectRoles);
    rows.forEach(function (r) { if (r.open_id) set[String(r.open_id)] = true; });
  }

  if (globalRoles.length) {
    const qm = globalRoles.map(function () { return '?'; }).join(',');
    const fromUsers = db
      .prepare('SELECT DISTINCT open_id FROM users WHERE global_role IN (' + qm + ')')
      .all(...globalRoles);
    fromUsers.forEach(function (r) { if (r.open_id) set[String(r.open_id)] = true; });
    const fromExtra = db
      .prepare('SELECT DISTINCT u.open_id FROM user_roles ur JOIN users u ON u.id = ur.role_user_id WHERE ur.role_key IN (' + qm + ')')
      .all(...globalRoles);
    fromExtra.forEach(function (r) { if (r.open_id) set[String(r.open_id)] = true; });
  }

  if (o.excludeOpenId) delete set[String(o.excludeOpenId)];
  return Object.keys(set);
}

/**
 * 写入通知（批量，自动去重 + 防自通知由 resolveRecipients 负责）。
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string[]} opts.recipients 接收人 open_id 列表
 * @param {string} opts.type          NOTIFICATION_TYPES 之一
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {string} [opts.projectId]
 * @param {string} [opts.refType]
 * @param {string} [opts.refId]
 * @returns {string[]} 写入的通知 id 列表
 */
function notify(db, opts) {
  const recipients = (opts.recipients || []).filter(Boolean);
  if (!recipients.length) return [];
  const type = opts.type;
  if (!NOTIFICATION_TYPES[type]) throw new Error('[notification.service] 未知通知类型: ' + type);

  const ts = dates.nowIso();
  const ins = db.prepare(`
    INSERT INTO notifications (id, user_open_id, user_id, project_id, type, title, body, ref_type, ref_id, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);

  const tx = db.transaction(function () {
    return recipients.map(function (openId, i) {
      // genId 同毫秒可能碰撞，追加下标确保本批次内唯一
      const id = ids.genId('NTF') + '-' + i;
      ins.run(
        id,
        openId,
        mappers.resolveUserId(db, openId),
        String(opts.projectId || ''),
        type,
        String(opts.title || ''),
        String(opts.body || ''),
        String(opts.refType || ''),
        String(opts.refId || ''),
        ts,
      );
      return id;
    });
  });

  return tx();
}

/**
 * 行 → API 对象（snake_case → camelCase，对齐前端契约）。
 * @param {object} row notifications 行
 */
function toApiNotification(row) {
  return {
    id: String(row.id),
    userOpenId: String(row.user_open_id),
    projectId: String(row.project_id || ''),
    type: String(row.type),
    title: String(row.title || ''),
    body: String(row.body || ''),
    refType: String(row.ref_type || ''),
    refId: String(row.ref_id || ''),
    isRead: Number(row.is_read) === 1 ? 1 : 0,
    createdAt: String(row.created_at || ''),
  };
}

/**
 * 列表（按 created_at 倒序）。
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} userId 系统身份键 users.id
 * @param {object} [opts] { unread?: boolean, page?: number, pageSize?: number }
 * @returns {{ items: object[], total: number, unreadCount: number }}
 */
function listNotifications(db, userId, opts) {
  const o = opts || {};
  const unreadOnly = o.unread === true || o.unread === 'true' || o.unread === 1;
  const limit = Math.min(Number(o.pageSize) || 20, 100);
  const page = Math.max(Number(o.page) || 1, 1);
  const offset = (page - 1) * limit;

  // 身份设计铁律：通知读写一律锚定 users.id（user_id 列），飞书 open_id 仅作展示同步属性
  const where = ['user_id = ?'];
  const params = [userId];
  if (unreadOnly) {
    where.push('is_read = 0');
  }
  const whereSql = where.join(' AND ');

  const totalRow = db
    .prepare('SELECT COUNT(*) AS c FROM notifications WHERE ' + whereSql)
    .get(...params);
  const items = db
    .prepare('SELECT * FROM notifications WHERE ' + whereSql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(...params, limit, offset)
    .map(toApiNotification);

  const unreadRow = db
    .prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0')
    .get(userId);

  return {
    items: items,
    total: (totalRow && totalRow.c) || 0,
    unreadCount: (unreadRow && unreadRow.c) || 0,
  };
}

/**
 * 未读计数。
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} userId 系统身份键 users.id
 * @returns {number}
 */
function unreadCount(db, userId) {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0')
    .get(userId);
  return (row && row.c) || 0;
}

/**
 * 标记单条已读（仅本人可操作）。
 * @returns {boolean} 是否实际更新
 */
function markRead(db, id, userId) {
  const info = db
    .prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return info.changes > 0;
}

/**
 * 标记全部已读（仅本人）。
 * @returns {number} 更新条数
 */
function markAllRead(db, userId) {
  const info = db
    .prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0')
    .run(userId);
  return info.changes;
}

module.exports = {
  NOTIFICATION_TYPES,
  resolveRecipients,
  notify,
  toApiNotification,
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
};
