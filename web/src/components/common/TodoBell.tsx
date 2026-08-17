import { useState, type MouseEvent } from 'react';
import {
  Alert,
  Badge,
  Box,
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
import { useNavigate } from 'react-router-dom';

import { useTodos } from '@/hooks/useTodos';
import { PriorityChip } from '@/components/common';
import { TODO_GROUP_MAX, TODO_TYPE_COLOR } from '@/config/enums';
import { tokens } from '@/theme/tokens';
import { ROUTES } from '@/config/routes';

/**
 * 统一待办中心铃铛（B14-块3）
 *
 * - 纯前端并发聚合六源（`useTodos`），零后端新增。
 * - 徽标数字 = 所有分组条目数之和；下拉按 `TODO_TYPE_ORDER` 分组展示，每组最多 `TODO_GROUP_MAX` 条。
 * - 点击条目 `navigate` 到 `targetRoute`（直接跳到可处理掉该待办的页面）。
 */
export function TodoBell(): JSX.Element {
  const { total, groups, loading, error, reload } = useTodos();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const navigate = useNavigate();
  const open = Boolean(anchor);

  const handleOpen = (e: MouseEvent<HTMLElement>): void => {
    setAnchor(e.currentTarget);
    reload();
  };
  const handleClose = (): void => setAnchor(null);
  const go = (route: string): void => {
    navigate(route);
    handleClose();
  };

  return (
    <>
      <Tooltip title="统一待办中心" arrow>
        <IconButton
          size="small"
          onClick={handleOpen}
          aria-label="统一待办中心"
          sx={{ color: tokens.text.secondary, '&:hover': { color: tokens.brand.primary } }}
        >
          <Badge badgeContent={total} color="error" max={99} overlap="circular">
            <NotificationsIcon sx={{ fontSize: 19 }} />
          </Badge>
        </IconButton>
      </Tooltip>

      <Menu
        anchorEl={anchor}
        open={open}
        onClose={handleClose}
        slotProps={{ paper: { sx: { width: 360, maxHeight: 540 } } }}
      >
        <Box sx={{ px: 2, py: 1.25, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography sx={{ fontWeight: 600 }}>待办中心</Typography>
          {loading ? <CircularProgress size={14} /> : <Typography variant="caption" color="text.secondary">{total} 项</Typography>}
        </Box>
        <Divider />

        {error && (
          <Alert severity="warning" variant="outlined" sx={{ m: 1, fontSize: 12 }}>
            {error}
          </Alert>
        )}

        {!loading && total === 0 && (
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              暂无待办 🎉
            </Typography>
          </Box>
        )}

        {groups.map((g) => (
          <Box key={g.type}>
            <Box sx={{ px: 2, pt: 1.25, pb: 0.5, display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: `${TODO_TYPE_COLOR[g.type]}.main` }} />
              <Typography variant="subtitle2">{g.label}</Typography>
              <Typography variant="caption" color="text.secondary">
                （{g.items.length}）
              </Typography>
            </Box>
            <List dense sx={{ py: 0 }}>
              {g.items.slice(0, TODO_GROUP_MAX).map((it) => (
                <ListItemButton key={it.id} onClick={() => go(it.targetRoute)}>
                  <ListItemText
                    primary={it.title}
                    primaryTypographyProps={{ variant: 'body2', noWrap: true, sx: { fontWeight: 500 } }}
                    secondary={it.subtitle}
                    secondaryTypographyProps={{ variant: 'caption', noWrap: true }}
                  />
                  {it.priority && <PriorityChip priority={it.priority} variant="short" />}
                </ListItemButton>
              ))}
              {g.items.length > TODO_GROUP_MAX && (
                <ListItemButton onClick={() => go(ROUTES.workbench)}>
                  <ListItemText
                    primary={`还有 ${g.items.length - TODO_GROUP_MAX} 条…`}
                    primaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                  />
                </ListItemButton>
              )}
            </List>
            <Divider />
          </Box>
        ))}
      </Menu>
    </>
  );
}
