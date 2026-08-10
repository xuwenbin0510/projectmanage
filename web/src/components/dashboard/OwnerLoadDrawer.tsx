/**
 * 负责人跨项目负荷下钻抽屉（B12 · T05 · P1-6）
 *
 * 点击「负责人负荷」柱状图的某一行（或图例）后打开，展示该负责人在
 * 各项目下的任务分布（在办 / 逾期）。数据直接消费 `OwnerLoadRow.projects`
 * （服务端聚合时已一并算出），抽屉**不再发请求**（决策 ③ 聚合零成本，
 * P1-6 的初衷即避免二次请求）。
 *
 * 取色：抽屉内为纯 DOM 表格，健康/逾期用 MUI 主题色（`error.main`）即可，
 * 不触碰 SVG，无需走 `useChartPalette()`。
 *
 * @prd B12
 */

import { Box, Drawer, IconButton, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import { DataTable } from '@/components/common';
import type { Column } from '@/components/common';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '@/config/routes';
import type { OwnerLoadRow, OwnerLoadProjectRow } from '@/types/dashboard';

export interface OwnerLoadDrawerProps {
  /** 是否打开 */
  open: boolean;
  /** 当前下钻的负责人；关闭态/初始态为 null */
  row: OwnerLoadRow | null;
  /** 关闭抽屉 */
  onClose: () => void;
}

const columns: Array<Column<OwnerLoadProjectRow>> = [
  {
    key: 'projectName',
    label: '项目',
    render: (r) => (
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600 }} noWrap>
          {r.projectName}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {r.projectId}
        </Typography>
      </Box>
    ),
  },
  {
    key: 'activeTasks',
    label: '在办',
    width: 88,
    align: 'right',
    render: (r) => (
      <Typography sx={{ fontSize: 13 }} color="text.primary">
        {r.activeTasks}
      </Typography>
    ),
  },
  {
    key: 'overdueTasks',
    label: '其中逾期',
    width: 96,
    align: 'right',
    render: (r) => (
      <Typography sx={{ fontSize: 13 }} color={r.overdueTasks > 0 ? 'error.main' : 'text.secondary'}>
        {r.overdueTasks}
      </Typography>
    ),
  },
];

/**
 * 负责人跨项目负荷详情抽屉。
 *
 * 数据来自 `row.projects`（服务端聚合已带出），点击某行可钻取到该项目概览。
 */
export function OwnerLoadDrawer({ open, row, onClose }: OwnerLoadDrawerProps): JSX.Element {
  const navigate = useNavigate();
  const projects: OwnerLoadProjectRow[] = row?.projects ?? [];

  return (
    <Drawer anchor="right" open={open} onClose={onClose}>
      <Box sx={{ width: 420, maxWidth: '92vw', p: 2.5, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1} sx={{ mb: 1.5 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap>
              {row?.ownerName ?? '负责人'} · 跨项目负荷
            </Typography>
            {row && (
              <Typography variant="caption" color="text.secondary">
                在办 {row.activeTasks} · 其中逾期 {row.overdueTasks} · 涉及 {row.projectCount} 个项目
              </Typography>
            )}
          </Box>
          <IconButton onClick={onClose} size="small" aria-label="关闭" sx={{ flexShrink: 0 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        <DataTable<OwnerLoadProjectRow>
          columns={columns}
          rows={projects}
          rowKey={(r) => r.projectId}
          loading={false}
          emptyTitle="该负责人当前无在办任务"
          emptyDescription="所有任务均已完成"
          dense
          onRowClick={(r) => {
            onClose();
            navigate(ROUTES.projectOverview(r.projectId));
          }}
        />
      </Box>
    </Drawer>
  );
}
