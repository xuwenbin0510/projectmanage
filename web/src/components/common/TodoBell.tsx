import { useState, type MouseEvent } from 'react';
import {
  Badge,
  Box,
  Button,
  CircularProgress,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Menu,
  Tooltip,
  Typography,
} from '@mui/material';
import NotificationsIcon from '@mui/icons-material/Notifications';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import { useNavigate } from 'react-router-dom';

import { useNotifications, notificationTargetRoute } from '@/api/notifications';
import { NOTIFICATION_TYPE_LABEL, type NotificationItem } from '@/types/notification';
import { tokens } from '@/theme/tokens';

/**
 * 站内通知铃铛（顶栏）
 *
 * - 徽标数字 = 当前用户未读通知数（红点）。
 * - 下拉按时间倒序列出通知；点击条目 → 标记已读并跳转到关联业务页
 *   （评审 → 项目评审 tab，变更 → 项目变更 tab，无 projectId 兜底审批中心）。
 * - 提供「全部已读」一键清空未读。
 */
function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function TodoBell(): JSX.Element {
  const { items, unreadCount, loading, error, reload, markRead, markAllRead } = useNotifications();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const navigate = useNavigate();
  const open = Boolean(anchor);

  const handleOpen = (e: MouseEvent<HTMLElement>): void => {
    setAnchor(e.currentTarget);
    void reload();
  };
  const handleClose = (): void => setAnchor(null);
  const go = (n: NotificationItem): void => {
    void markRead(n.id);
    navigate(notificationTargetRoute(n));
    handleClose();
  };

  return (
    <>
      <Tooltip title="通知" arrow>
        <IconButton
          size="small"
          onClick={handleOpen}
          aria-label="通知"
          sx={{ color: tokens.text.secondary, '&:hover': { color: tokens.brand.primary } }}
        >
          <Badge badgeContent={unreadCount} color="error" max={99} overlap="circular">
            <NotificationsIcon sx={{ fontSize: 19 }} />
          </Badge>
        </IconButton>
      </Tooltip>

      <Menu
        anchorEl={anchor}
        open={open}
        onClose={handleClose}
        slotProps={{ paper: { sx: { width: 380, maxHeight: 560 } } }}
      >
        <Box sx={{ px: 2, py: 1.25, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography sx={{ fontWeight: 600 }}>通知</Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {loading ? (
              <CircularProgress size={14} />
            ) : (
              <Typography variant="caption" color="text.secondary">
                {unreadCount} 条未读
              </Typography>
            )}
            {unreadCount > 0 && (
              <Button
                size="small"
                startIcon={<DoneAllIcon sx={{ fontSize: 15 }} />}
                onClick={() => void markAllRead()}
                sx={{ minWidth: 0, textTransform: 'none' }}
              >
                全部已读
              </Button>
            )}
          </Box>
        </Box>
        <Divider />

        {error && (
          <Box sx={{ p: 2 }}>
            <Typography variant="caption" color="error">
              {error}
            </Typography>
          </Box>
        )}

        {!loading && items.length === 0 && !error && (
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              暂无通知 🎉
            </Typography>
          </Box>
        )}

        <List dense sx={{ py: 0 }}>
          {items.map((n) => (
            <ListItemButton key={n.id} onClick={() => go(n)} alignItems="flex-start">
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: n.isRead ? 'transparent' : tokens.brand.primary,
                  mt: 0.8,
                  mr: 1,
                  flexShrink: 0,
                }}
              />
              <ListItemText
                primary={n.title}
                secondary={`${NOTIFICATION_TYPE_LABEL[n.type]}${n.body ? ' · ' + n.body : ''}`}
                primaryTypographyProps={{ variant: 'body2', noWrap: true, fontWeight: n.isRead ? 400 : 600 }}
                secondaryTypographyProps={{ variant: 'caption', noWrap: true }}
              />
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ ml: 1, whiteSpace: 'nowrap', flexShrink: 0 }}
              >
                {relTime(n.createdAt)}
              </Typography>
            </ListItemButton>
          ))}
        </List>
      </Menu>
    </>
  );
}
