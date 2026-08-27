/** 站内通知（顶栏铃铛）前端契约，对齐 server/services/notification.service.js#toApiNotification */

export type NotificationType =
  | 'REVIEW_CREATED'
  | 'REVIEW_DECIDED'
  | 'CHANGE_CREATED'
  | 'CHANGE_SUBMITTED'
  | 'CHANGE_APPLIED'
  | 'CHANGE_DECIDED';

export interface NotificationItem {
  id: string;
  userOpenId: string;
  projectId: string;
  type: NotificationType;
  title: string;
  body: string;
  refType: string;
  refId: string;
  /** 0 = 未读，1 = 已读 */
  isRead: number;
  createdAt: string;
}

export interface NotificationListResult {
  items: NotificationItem[];
  total: number;
  unreadCount: number;
}

/** 通知类型 → 中文标签（下拉分组 / 角标用） */
export const NOTIFICATION_TYPE_LABEL: Record<NotificationType, string> = {
  REVIEW_CREATED: '评审待办',
  REVIEW_DECIDED: '评审结论',
  CHANGE_CREATED: '变更创建',
  CHANGE_SUBMITTED: '变更待审',
  CHANGE_APPLIED: '变更实施',
  CHANGE_DECIDED: '变更结论',
};
