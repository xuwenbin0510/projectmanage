/**
 * 周报闭环下钻抽屉（feat/workbench-cards-fix）
 *
 * 点击「周报闭环率」快捷卡 → 右侧滑出（MUI Drawer，宽 460px），
 * 列出我参与各项目的「已提交 / 已确认 / 闭环率」，与工作台卡片数据同源。
 *
 * 行点击 → 项目周报页（下钻到具体项目）。
 *
 * 设计取舍：普通用户/PM 没有全局总览权限，因此不再跳「全局总览」
 * （旧实现会跳到无权限页且范围与卡片不一致），改为同源下钻抽屉。
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Chip, Drawer, IconButton, Stack, Typography, LinearProgress } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';

import { ErrorState, EmptyState } from '@/components/common';
import { api } from '@/api/client';
import { ROUTES } from '@/config/routes';
import type { WorkbenchReportClosure, WorkbenchReportClosureItem } from '@/types/workbench';

export interface ReportClosureDrawerProps {
  open: boolean;
  onClose: () => void;
}

function rateColor(rate: number): string {
  if (rate >= 100) return 'success.main';
  if (rate >= 60) return 'warning.main';
  return 'error.main';
}

export function ReportClosureDrawer({ open, onClose }: ReportClosureDrawerProps): JSX.Element {
  const navigate = useNavigate();
  const [data, setData] = useState<WorkbenchReportClosure | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getWorkbenchReportClosure();
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败，请重试');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const items: WorkbenchReportClosureItem[] = data?.items ?? [];

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
              周报闭环（我参与的项目）
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {data
                ? `已提交 ${data.submitted} · 已确认 ${data.confirmed} · 闭环率 ${data.closureRate}%`
                : '加载中…'}
            </Typography>
          </Box>
          <IconButton onClick={onClose} size="small" aria-label="关闭" sx={{ flexShrink: 0 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {loading ? (
            <LinearProgress sx={{ mt: 2 }} />
          ) : error ? (
            <ErrorState error={error} onRetry={() => void load()} />
          ) : items.length === 0 ? (
            <EmptyState title="我参与的项目暂无已提交/已确认周报" description="提交并确认周报后这里会显示闭环进度" />
          ) : (
            <Stack spacing={1} sx={{ mt: 0.5 }}>
              {items.map((it) => (
                <Box
                  key={it.projectId}
                  onClick={() => navigate(ROUTES.projectReports(it.projectId))}
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
