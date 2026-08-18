/**
 * 分布图点档下钻任务明细抽屉（B18 · T03 · 新建）
 *
 * 点击「任务优先级分布 / 任务状态分布 / 逾期时长分段」某档（柱体或 footer 图例）
 * → 右侧滑出（MUI Drawer，宽 420px），局部拉取该档任务明细（7 列 DataTable）。
 *
 * 数据策略（决策 #3，局部拉取模式，同 OverdueTaskDrawer）：
 * - 打开时 `api.getDashboardTasks({ ...query, page, pageSize: PAGE_SIZE })` 拉取，
 *   不写入任何全局 store，关闭即丢弃；query 变化（重新点档位）自动重新拉取。
 * - 服务端分页：翻页 `load(page)` 重新局部拉取。
 *
 * 口径红线（与 dashboardAgg / utils/date 逐字一致）：
 * - 优先级归一走 `normalizePriority`（脏值兜底 P2，与服务端 normalizePriorityValue 一致）。
 * - 逾期/截止日着色走 `utils/date` 的 `isOverdue` / `fmtDate`（禁止组件内 new Date()）。
 * - 项目名缺失回落 `UNNAMED_PROJECT`；负责人缺失回落「未分配」。
 *
 * 骨架复用 `MyTasksDrawer` / `OverdueTaskDrawer`：`<Drawer anchor="right" width:420 maxWidth:'92vw'>`、
 * 关闭 `IconButton`（遮罩 / × / ESC），内部 `DataTable` 渲染，`PAGE_SIZE = 8`。
 *
 * @prd B18
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Drawer, IconButton, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import { DataTable, ErrorState, PriorityChip, ProgressBar, StatusChip } from '@/components/common';
import type { Column } from '@/components/common';
import { api } from '@/api/client';
import { ROUTES } from '@/config/routes';
import { normalizePriority } from '@/config/enums';
import { UNNAMED_PROJECT } from '@/utils/dashboardAgg';
import { fmtDate, isOverdue } from '@/utils/date';
import type { DashboardTaskRow, DashboardTasksQuery } from '@/types/dashboard';

/** 每页任务数（与 MyTasksDrawer / OverdueTaskDrawer 保持一致） */
const PAGE_SIZE = 8;

export interface DistributionTaskDrawerProps {
  /** 是否打开 */
  open: boolean;
  /** 头部标题（如「P0 任务明细」「进行中任务明细」「逾期 8–30 天任务明细」） */
  title: string;
  /** 维度参数 + 总览筛选上下文（不含 page/pageSize，由抽屉内部追加） */
  query: DashboardTasksQuery;
  /** 关闭抽屉（遮罩 / × / ESC） */
  onClose: () => void;
}

/**
 * 分布图点档下钻任务明细抽屉（受控组件，局部拉取，关闭即丢弃）。
 */
export function DistributionTaskDrawer({
  open,
  title,
  query,
  onClose,
}: DistributionTaskDrawerProps): JSX.Element {
  const navigate = useNavigate();

  const [rows, setRows] = useState<DashboardTaskRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (pageToLoad: number): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.getDashboardTasks({ ...query, page: pageToLoad, pageSize: PAGE_SIZE });
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

  /* 打开时复位到第 1 页并拉取；query 变化（重新点档位）也重新拉取 */
  useEffect(() => {
    if (!open) return;
    setPage(1);
    void load(1);
  }, [open, query, load]);

  /* 列定义（7 列，顺序 = 优先级 / 任务 / 项目名 / 负责人 / 截止日 / 状态 / 进度） */
  const columns = useMemo<Array<Column<DashboardTaskRow>>>(
    () => [
      {
        key: 'priority',
        label: '优先级',
        width: 62,
        render: (r) => <PriorityChip priority={normalizePriority(r.priority)} />,
      },
      {
        key: 'name',
        label: '任务',
        render: (r) => (
          <Typography sx={{ fontSize: 13, fontWeight: 600 }} noWrap>
            {r.wbsCode ? `${r.wbsCode} ` : ''}
            {r.name}
          </Typography>
        ),
      },
      {
        key: 'projectName',
        label: '项目名',
        width: 110,
        hideOnMobile: true,
        render: (r) => (
          <Typography sx={{ fontSize: 13 }} color="text.secondary" noWrap>
            {r.projectName || UNNAMED_PROJECT}
          </Typography>
        ),
      },
      {
        key: 'ownerName',
        label: '负责人',
        width: 66,
        render: (r) => (
          <Typography sx={{ fontSize: 13 }} color="text.secondary" noWrap>
            {r.ownerName || '未分配'}
          </Typography>
        ),
      },
      {
        key: 'dueDate',
        label: '截止日',
        width: 96,
        render: (r) => (
          <Typography
            sx={{ fontSize: 13, color: isOverdue(r.dueDate) ? 'error.main' : 'text.secondary' }}
            noWrap
          >
            {fmtDate(r.dueDate)}
            {isOverdue(r.dueDate) ? ' · 已逾期' : ''}
          </Typography>
        ),
      },
      {
        key: 'status',
        label: '状态',
        width: 70,
        render: (r) => <StatusChip status={r.status} />,
      },
      {
        key: 'progress',
        label: '进度',
        width: 88,
        render: (r) => (
          <ProgressBar value={r.progress} tone={isOverdue(r.dueDate) ? 'danger' : 'brand'} />
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
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="flex-start"
          spacing={1}
          sx={{ mb: 1 }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap>
              {title}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              共 {total} 个任务
              {total > PAGE_SIZE
                ? ` · 第 ${1 + (page - 1) * PAGE_SIZE}-${Math.min(page * PAGE_SIZE, total)} / 共 ${total} 条`
                : ''}
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
            <DataTable<DashboardTaskRow>
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              loading={loading}
              emptyTitle={
                query.overdueBucket ? '太好了，没有该档逾期任务 🎉' : '当前范围暂无该档任务'
              }
              emptyDescription="试试调整总览筛选或切换范围"
              onRowClick={(row) => navigate(ROUTES.projectWbs(row.projectId))}
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
