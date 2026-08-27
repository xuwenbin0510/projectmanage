import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/api/client';
import type { NotificationItem, NotificationListResult } from '@/types/notification';
import { ROUTES } from '@/config/routes';

/**
 * 站内通知 Hook（顶栏铃铛数据底座）。
 *
 * 复用 `GET /notifications` 单一端点（返回 items + 总未读数 unreadCount），
 * 红点直接取 unreadCount；标记已读走 `POST /notifications/:id/read` 与 `/read-all`，
 * 本地乐观更新未读数，避免整列重拉。
 */
export function useNotifications() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res: NotificationListResult = await api.listNotifications({ pageSize: 30 });
      setItems(res.items || []);
      setUnreadCount(res.unreadCount || 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载通知失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const markRead = useCallback(
    async (id: string) => {
      try {
        await api.markNotificationRead(id);
        setItems((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: 1 } : n)));
        setUnreadCount((c) => (c > 0 ? c - 1 : 0));
      } catch {
        /* 静默：标记失败不影响阅读 */
      }
    },
    [],
  );

  const markAllRead = useCallback(async () => {
    try {
      await api.markAllNotificationsRead();
      setItems((prev) => prev.map((n) => ({ ...n, isRead: 1 })));
      setUnreadCount(0);
    } catch {
      /* 静默 */
    }
  }, []);

  return { items, unreadCount, loading, error, reload, markRead, markAllRead };
}

/**
 * 通知 → 跳转路由（评审 / 变更跳项目对应 tab；无 projectId 兜底审批中心）。
 */
export function notificationTargetRoute(n: NotificationItem): string {
  if (n.projectId) {
    if (n.refType === 'change') return ROUTES.projectChanges(n.projectId);
    return ROUTES.projectReviews(n.projectId);
  }
  return ROUTES.approvals;
}
