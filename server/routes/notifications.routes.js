/**
 * 站内通知路由（顶栏铃铛）
 *
 * 全部接口需登录（`requireAuth`），数据按 `req.user.open_id` 隔离——只读写本人通知。
 * 通知由后端业务流（评审 / 变更）在 service 层写入，本文件不提供「主动发通知」端点，
 * 避免前端绕过业务规则伪造通知。
 *
 * 返回形状：
 *  - list    → `{ items: Notification[], total, unreadCount }`
 *  - read    → `{ id, isRead: 1 }`
 *  - readAll → `{ count }`
 */

const express = require('express');

const db = require('../../db');
const { ok, asyncHandler } = require('../lib/envelope');
const { requireAuth } = require('../middleware/auth');
const notificationService = require('../services/notification.service');

const router = express.Router();

/** 我的通知列表（?unread=1 仅未读；返回 items + 总未读数 unreadCount 供红点） */
router.get(
  '/notifications',
  requireAuth,
  asyncHandler(async function list(req, res) {
    const q = req.query || {};
    res.json(ok(notificationService.listNotifications(db, req.user.open_id, {
      unread: q.unread,
      page: q.page,
      pageSize: q.pageSize,
    })));
  }),
);

/** 标记单条已读 */
router.post(
  '/notifications/:id/read',
  requireAuth,
  asyncHandler(async function read(req, res) {
    const changed = notificationService.markRead(db, req.params.id, req.user.open_id);
    res.json(ok({ id: req.params.id, isRead: changed ? 1 : 0 }, changed ? '已标记已读' : '通知不存在或已读'));
  }),
);

/** 全部标已读 */
router.post(
  '/notifications/read-all',
  requireAuth,
  asyncHandler(async function readAll(req, res) {
    const count = notificationService.markAllRead(db, req.user.open_id);
    res.json(ok({ count: count }, '已全部标记已读'));
  }),
);

module.exports = router;
