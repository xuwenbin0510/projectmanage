/**
 * 交付物明细抽屉（第二批 · 全局总览「质量与交付」下探）
 *
 * 点击「交付物状态分布」图某段 / 交付物指标卡 → 右侧滑出（MUI Drawer，宽 420px），
 * 局部拉取该段交付物明细（7 列 DataTable，服务端分页）。
 *
 * 数据策略（对齐 DistributionTaskDrawer）：打开时 `api.getDashboardDeliverables({...query, page, pageSize})`，
 * 不写全局 store，关闭即丢弃；query 变化（重新点段）自动重新拉取。
 *
 * 行点击 → 项目文档页。
 *
 * @prd 第二批
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Chip, Drawer, IconButton, Paper, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';

import { ErrorState } from '@/components/common';
import { api } from '@/api/client';
import { ROUTES } from '@/config/routes';
import { fmtDate, fmtDateTime } from '@/utils/date';
import { alphaOf as alpha, tokens } from '@/theme/tokens';
import type { DashboardDeliverableRow, DashboardDeliverablesQuery } from '@/types/dashboard';

/** 每页条数（与 DistributionTaskDrawer 一致） */
const PAGE_SIZE = 8;

/** 交付状态 → 语义色（已交付=绿 / 待交付=红 / 其它=中性），与卡片堆叠条颜色一致 */
function deliverableStatusTone(status: string): { color: string; bg: string } {
  if (status === '已交付') return { color: '#1f9d55', bg: 'rgba(31,157,85,0.12)' };
  if (status === '待交付') return { color: '#d4351d', bg: 'rgba(212,53,29,0.12)' };
  return { color: '#6b7280', bg: 'rgba(107,114,128,0.12)' };
}

export interface DeliverableDetailDrawerProps {
  /** 是否打开 */
  open: boolean;
  /** 头部标题（如「待交付成果物明细」「已交付成果物明细」） */
  title: string;
  /** 交付状态过滤 + 总览筛选上下文（不含 page/pageSize，由抽屉内部追加） */
  query: DashboardDeliverablesQuery;
  /** 关闭抽屉 */
  onClose: () => void;
  /**
   * 工作台模式：传入「我参与项目」id 列表时，走 getWorkbenchDeliverables（与工作台卡片同源，
   * 不限在管三态）；不传则保持全局总览行为（getDashboardDeliverables）。feat/workbench-cards-fix。
   */
  projectIds?: string[];
}

/**
 * 交付物明细抽屉（受控组件，局部拉取，关闭即丢弃）。
 */
export function DeliverableDetailDrawer({
  open,
  title,
  query,
  onClose,
  projectIds,
}: DeliverableDetailDrawerProps): JSX.Element {
  const navigate = useNavigate();

  const [rows, setRows] = useState<DashboardDeliverableRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (pageToLoad: number): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const res = projectIds && projectIds.length
          ? await api.getWorkbenchDeliverables({ ...query, page: pageToLoad, pageSize: PAGE_SIZE })
          : await api.getDashboardDeliverables({ ...query, page: pageToLoad, pageSize: PAGE_SIZE });
        setRows(res.items);
        setTotal(res.total);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载失败，请重试');
      } finally {
        setLoading(false);
      }
    },
    [query, projectIds],
  );

  useEffect(() => {
    if (!open) return;
    setPage(1);
    void load(1);
  }, [open, query, load]);

  return (
    <Drawer anchor="right" open={open} onClose={onClose}>
      <Box
        sx={{
          width: 440,
          maxWidth: '94vw',
          p: 2.5,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}
      >
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1} sx={{ mb: 1.5 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap>
              {title}
            </Typography>
            <Stack direction="row" spacing={1.5} sx={{ mt: 0.5, flexWrap: 'wrap' }}>
              <Typography variant="caption" sx={{ color: tokens.status.success, fontWeight: 600 }}>
                已交付 {rows.reduce((a, r) => a + (r.status === '已交付' ? 1 : 0), 0)}
              </Typography>
              <Typography variant="caption" sx={{ color: tokens.status.danger, fontWeight: 600 }}>
                待交付 {rows.reduce((a, r) => a + (r.status === '待交付' ? 1 : 0), 0)}
              </Typography>
              <Typography variant="caption" color="  text.secondary">
                共 {total} 项
                {total > PAGE_SIZE ? ` · 第 ${1 + (page - 1) * PAGE_SIZE}-${Math.min(page * PAGE_SIZE, total)} / 共 ${total} 条` : ''}
              </Typography>
            </Stack>
          </Box>
          <IconButton onClick={onClose} size="small" aria-label="关闭" sx={{ flexShrink: 0 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {error ? (
            <ErrorState error={error} onRetry={() => void load(page)} />
          ) : (
            <Stack spacing={1.25}>
              {rows.map((r) => {
                const tone = deliverableStatusTone(r.status);
                const Icon = r.status === '已交付' ? CheckCircleOutlineIcon : HourglassEmptyIcon;
                return (
                  <Paper
                    key={r.id}
                    variant="outlined"
                    onClick={() => navigate(ROUTES.projectDocuments(r.projectId))}
                    sx={{
                      p: 1.5,
                      cursor: 'pointer',
                      borderColor: alpha(tone.color, 0.35),
                      '&:hover': { borderColor: tone.color, transform: 'translateY(-1px)', transition: 'all .15s' },
                    }}
                  >
                    <Stack direction="row" spacing={1.25} alignItems="flex-start">
                      <Box
                        sx={{
                          width: 34, height: 34, borderRadius: 1.5, display: 'grid', placeItems: 'center',
                          bgcolor: tone.bg, color: tone.color, flexShrink: 0,
                        }}
                      >
                        <Icon fontSize="small" />
                      </Box>
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                          <Typography sx={{ fontSize: 14, fontWeight: 600 }} noWrap>
                            {r.name}
                          </Typography>
                          {r.baselineFlag && (
                            <Chip
                              size="small"
                              label="已基线"
                              sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(31,157,85,0.14)', color: '#1f9d55', fontWeight: 700 }}
                            />
                          )}
                        </Stack>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }} noWrap>
                          {r.projectName}
                        </Typography>
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.75, flexWrap: 'wrap' }}>
                          <Chip
                            size="small"
                            label={r.status}
                            sx={{ height: 20, fontSize: 11, bgcolor: tone.bg, color: tone.color, fontWeight: 700, border: `1px solid ${alpha(tone.color, 0.4)}` }}
                          />
                          {r.uploadedAt ? (
                            <Typography variant="caption" color="text.secondary" noWrap>
                              {r.uploadedByName || '—'} · {r.status === '已交付' ? fmtDateTime(r.uploadedAt) : fmtDate(r.uploadedAt)}
                            </Typography>
                          ) : (
                            <Typography variant="caption" color="text.disabled">
                              未交付
                            </Typography>
                          )}
                        </Stack>
                      </Box>
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>
          )}
          {!error && total > PAGE_SIZE && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1.5 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <IconButton
                  size="small"
                  disabled={page <= 1}
                  onClick={() => { const p = page - 1; setPage(p); void load(p); }}
                >
                  ‹
                </IconButton>
                <Typography variant="caption" color="text.secondary">
                  {page} / {Math.ceil(total / PAGE_SIZE)}
                </Typography>
                <IconButton
                  size="small"
                  disabled={page >= Math.ceil(total / PAGE_SIZE)}
                  onClick={() => { const p = page + 1; setPage(p); void load(p); }}
                >
                  ›
                </IconButton>
              </Stack>
            </Box>
          )}
        </Box>
      </Box>
    </Drawer>
  );
}
