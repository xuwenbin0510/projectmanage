/**
 * 周报闭环下钻抽屉（B12 全局总览 · 「周报闭环率」卡片点击）。
 *
 * 与工作台 `ReportClosureDrawer` 心智一致：右侧滑出（MUI Drawer，宽 460px），
 * 逐项目列出「已提交 / 已确认 / 闭环率」，行点击跳项目周报页。
 *
 * 差异：本抽屉**不额外发请求**——数据直接来自全局总览 `overview.reportClosureItems`
 * （服务端 `countReportClosureItems` 已聚合），由 `items` prop 注入，关闭即丢弃。
 * 适合「公司全量」视角下查看所有项目的周报闭环进度。
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Chip, Drawer, IconButton, LinearProgress, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';

import { EmptyState } from '@/components/common';
import { ROUTES } from '@/config/routes';
import type { ReportClosureItem } from '@/types/dashboard';

export interface ReportClosureListDrawerProps {
  open: boolean;
  /** 逐项目闭环明细（来自 overview.reportClosureItems） */
  items: ReportClosureItem[];
  /** 关闭抽屉（遮罩 / × / ESC） */
  onClose: () => void;
}

function rateColor(rate: number): string {
  if (rate >= 100) return 'success.main';
  if (rate >= 60) return 'warning.main';
  return 'error.main';
}

export function ReportClosureListDrawer({ open, items, onClose }: ReportClosureListDrawerProps): JSX.Element {
  const navigate = useNavigate();
  /* 数据由 props 注入，仅需本地整理派生态（避免 effect 依赖 items 引用漂移） */
  const [render, setRender] = useState(false);

  useEffect(() => {
    if (open) setRender(true);
  }, [open]);

  const list = items ?? [];
  const submitted = list.reduce((n, it) => n + it.submitted, 0);
  const confirmed = list.reduce((n, it) => n + it.confirmed, 0);
  const rate = submitted + confirmed ? Math.round((confirmed / (submitted + confirmed)) * 100) : 0;

  const onRowClick = useCallback(
    (projectId: string) => {
      onClose();
      navigate(ROUTES.projectReports(projectId));
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
              周报闭环（逐项目）
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {render
                ? `已提交 ${submitted} · 已确认 ${confirmed} · 闭环率 ${rate}%`
                : '加载中…'}
            </Typography>
          </Box>
          <IconButton onClick={onClose} size="small" aria-label="关闭" sx={{ flexShrink: 0 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {list.length === 0 ? (
            <EmptyState title="当前范围暂无已提交/已确认周报" description="提交并确认周报后这里会显示闭环进度" />
          ) : (
            <Stack spacing={1} sx={{ mt: 0.5 }}>
              {list.map((it) => (
                <Box
                  key={it.projectId}
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
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography sx={{ fontSize: 13, fontWeight: 600 }} noWrap>
                      {it.projectName}
                    </Typography>
                    <Chip
                      size="small"
                      label={`${it.rate}%`}
                      sx={{
                        height: 20,
                        fontSize: 11,
                        fontWeight: 700,
                        bgcolor: rateColor(it.rate),
                        color: '#fff',
                      }}
                    />
                  </Stack>
                  <Stack direction="row" spacing={2} sx={{ mt: 0.5 }} alignItems="center">
                    <Typography variant="caption" color="text.secondary">
                      已提交 {it.submitted} · 已确认 {it.confirmed}
                    </Typography>
                    <Box sx={{ flex: 1, maxWidth: 160 }}>
                      <LinearProgress
                        variant="determinate"
                        value={it.rate}
                        color={it.rate >= 100 ? 'success' : it.rate >= 60 ? 'warning' : 'error'}
                        sx={{ height: 6, borderRadius: 3 }}
                      />
                    </Box>
                    <CheckCircleOutlineIcon fontSize="small" sx={{ color: 'text.disabled' }} />
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
