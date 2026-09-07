/**
 * 里程碑到期下探抽屉（全局总览 · 「质量与交付 → 里程碑到期分布」面板点击）。
 *
 * 与 `ReportClosureListDrawer` 心智一致：右侧滑出（MUI Drawer，宽 460px），
 * 按「已过期 / 未来 30 天」分桶列出里程碑明细，行点击跳该项目里程碑页。
 *
 * 不额外发请求——数据直接来自全局总览 `overview.milestones.items`
 * （服务端已按计划日期升序、至多 20 条），由 `items` prop 注入，关闭即丢弃。
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Chip, Drawer, IconButton, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import EventOutlinedIcon from '@mui/icons-material/EventOutlined';

import { EmptyState } from '@/components/common';
import { ROUTES } from '@/config/routes';

/** 单条里程碑明细（与 DashboardOverview `milestones.items` 元素一致） */
export interface MilestoneDueItem {
  projectId: string;
  projectName: string;
  /** 里程碑名 */
  name: string;
  /** 计划日期 YYYY-MM-DD */
  plannedDate: string;
  /** 是否已过期 */
  overdue: boolean;
}

export interface MilestoneDueDrawerProps {
  open: boolean;
  /** 桶过滤：overdue = 已过期；upcoming = 未来 30 天；'' = 全部（防御兜底） */
  bucket: 'overdue' | 'upcoming' | '';
  /** 明细（来自 overview.milestones.items，服务端已按计划日期升序） */
  items: MilestoneDueItem[];
  /** 关闭抽屉（遮罩 / × / ESC / 行点击跳转前） */
  onClose: () => void;
}

export function MilestoneDueDrawer({ open, bucket, items, onClose }: MilestoneDueDrawerProps): JSX.Element {
  const navigate = useNavigate();
  /* 数据由 props 注入，仅需本地渲染开关（避免 effect 依赖 items 引用漂移） */
  const [render, setRender] = useState(false);

  useEffect(() => {
    if (open) setRender(true);
  }, [open]);

  const list = (items ?? []).filter((it) => (bucket ? (bucket === 'overdue' ? it.overdue : !it.overdue) : true));
  const bucketLabel = bucket === 'overdue' ? '已过期' : bucket === 'upcoming' ? '未来 30 天到期' : '全部';

  const onRowClick = useCallback(
    (projectId: string) => {
      onClose();
      navigate(ROUTES.projectMilestones(projectId));
    },
    [navigate, onClose],
  );

  return (
    <Drawer anchor="right" open={open} onClose={onClose}>
      <Box
        sx={{
          width: 460,
          maxWidth: '94vw',
          p: 2.5,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}
      >
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1} sx={{ mb: 1 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap>
              里程碑到期（近 30 天 · {bucketLabel}）
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {render ? `${list.length} 个 · 按计划日期升序 · 点击行进入项目里程碑` : '加载中…'}
            </Typography>
          </Box>
          <IconButton onClick={onClose} size="small" aria-label="关闭" sx={{ flexShrink: 0 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {render && list.length === 0 ? (
            <EmptyState title={`暂无${bucketLabel}的里程碑`} description="近 30 天窗口内没有未完成且到期的里程碑" />
          ) : (
            <Stack spacing={1} sx={{ mt: 0.5 }}>
              {list.map((it, i) => (
                <Box
                  /* 列表无稳定 id（同名里程碑可能重复），渲染期用桶+序号即可 */
                  key={`${it.projectId}-${it.name}-${i}`}
                  onClick={() => onRowClick(it.projectId)}
                  sx={{
                    p: 1.5,
                    borderRadius: 1.5,
                    border: '1px solid',
                    borderColor: 'divider',
                    cursor: 'pointer',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                    <Typography sx={{ fontSize: 13, fontWeight: 600, minWidth: 0 }} noWrap>
                      {it.name}
                    </Typography>
                    <Chip
                      size="small"
                      label={it.overdue ? '已过期' : '即将到期'}
                      sx={{
                        height: 20,
                        fontSize: 11,
                        fontWeight: 700,
                        flexShrink: 0,
                        bgcolor: it.overdue ? 'error.main' : 'warning.main',
                        color: '#fff',
                      }}
                    />
                  </Stack>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
                    <EventOutlinedIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {it.projectName} · 计划 {it.plannedDate}
                    </Typography>
                  </Stack>
                </Box>
              ))}
            </Stack>
          )}
        </Box>
      </Box>
    </Drawer>
  );
}
