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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Chip, Drawer, IconButton, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import { DataTable, ErrorState, StatusChip } from '@/components/common';
import type { Column } from '@/components/common';
import { api } from '@/api/client';
import { ROUTES } from '@/config/routes';
import { fmtDate, fmtDateTime } from '@/utils/date';
import type { DashboardDeliverableRow, DashboardDeliverablesQuery } from '@/types/dashboard';

/** 每页条数（与 DistributionTaskDrawer 一致） */
const PAGE_SIZE = 8;

export interface DeliverableDetailDrawerProps {
  /** 是否打开 */
  open: boolean;
  /** 头部标题（如「待交付成果物明细」「已交付成果物明细」） */
  title: string;
  /** 交付状态过滤 + 总览筛选上下文（不含 page/pageSize，由抽屉内部追加） */
  query: DashboardDeliverablesQuery;
  /** 关闭抽屉 */
  onClose: () => void;
}

/**
 * 交付物明细抽屉（受控组件，局部拉取，关闭即丢弃）。
 */
export function DeliverableDetailDrawer({
  open,
  title,
  query,
  onClose,
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
        const res = await api.getDashboardDeliverables({ ...query, page: pageToLoad, pageSize: PAGE_SIZE });
        setRows(res.items);
        setTotal(res.total);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载失败，请重试');
      } finally {
        setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    if (!open) return;
    setPage(1);
    void load(1);
  }, [open, query, load]);

  const columns = useMemo<Array<Column<DashboardDeliverableRow>>>(
    () => [
      {
        key: 'templateKey',
        label: '模板项',
        width: 78,
        render: (r) => (
          <Typography sx={{ fontSize: 13, fontWeight: 600 }} noWrap>
            {r.templateKey || '—'}
          </Typography>
        ),
      },
      {
        key: 'name',
        label: '名称',
        render: (r) => (
          <Typography sx={{ fontSize: 13 }} noWrap>
            {r.name}
          </Typography>
        ),
      },
      {
        key: 'status',
        label: '状态',
        width: 72,
        render: (r) => <StatusChip status={r.status} />,
      },
      {
        key: 'version',
        label: '版本',
        width: 52,
        render: (r) => (
          <Typography sx={{ fontSize: 13 }} color="text.secondary" noWrap>
            v{r.version}
          </Typography>
        ),
      },
      {
        key: 'baseline',
        label: '基线',
        width: 68,
        render: (r) =>
          r.baselineFlag ? (
            <Chip
              size="small"
              label="已基线"
              sx={{ height: 20, fontSize: 11, bgcolor: 'success.main', color: '#fff', fontWeight: 700 }}
            />
          ) : (
            <Typography sx={{ fontSize: 13 }} color="text.disabled">
              —
            </Typography>
          ),
      },
      {
        key: 'projectName',
        label: '项目',
        width: 120,
        hideOnMobile: true,
        render: (r) => (
          <Typography sx={{ fontSize: 13 }} color="text.secondary" noWrap>
            {r.projectName}
          </Typography>
        ),
      },
      {
        key: 'uploaded',
        label: '交付',
        width: 110,
        hideOnMobile: true,
        render: (r) =>
          r.uploadedAt ? (
            <Box>
              <Typography sx={{ fontSize: 13 }} color="text.secondary" noWrap>
                {r.uploadedByName || '—'}
              </Typography>
              <Typography variant="caption" color="text.disabled">
                {r.status === '已交付' ? fmtDateTime(r.uploadedAt) : fmtDate(r.uploadedAt)}
              </Typography>
            </Box>
          ) : (
            <Typography sx={{ fontSize: 13 }} color="text.disabled">
              未交付
            </Typography>
          ),
      },
    ],
    [],
  );

  return (
    <Drawer anchor="right" open={open} onClose={onClose}>
      <Box
        sx={{
          width: 420,
          maxWidth: '92vw',
          p: 2.5,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}
      >
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1} sx={{ mb: 1 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap>
              {title}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              共 {total} 项交付物
              {total > PAGE_SIZE ? ` · 第 ${1 + (page - 1) * PAGE_SIZE}-${Math.min(page * PAGE_SIZE, total)} / 共 ${total} 条` : ''}
            </Typography>
          </Box>
          <IconButton onClick={onClose} size="small" aria-label="关闭" sx={{ flexShrink: 0 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        <Box sx={{ flex: 1, minHeight: 0, overflowX: 'auto' }}>
          {error ? (
            <ErrorState error={error} onRetry={() => void load(page)} />
          ) : (
            <DataTable<DashboardDeliverableRow>
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              loading={loading}
              emptyTitle="当前范围暂无该状态的交付物"
              emptyDescription="试试调整总览筛选或切换范围"
              onRowClick={(row) => navigate(ROUTES.projectDocuments(row.projectId))}
              pagination={
                total > PAGE_SIZE
                  ? {
                      page,
                      pageSize: PAGE_SIZE,
                      total,
                      onChange: (p: number) => {
                        setPage(p);
                        void load(p);
                      },
                    }
                  : undefined
              }
              dense
            />
          )}
        </Box>
      </Box>
    </Drawer>
  );
}
