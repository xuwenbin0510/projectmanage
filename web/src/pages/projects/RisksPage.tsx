import { useEffect, useState } from 'react';
import { Box, Stack, Typography } from '@mui/material';

import { DataTable, PageHeader, SectionCard, StatusChip } from '@/components/common';
import type { Column } from '@/components/common';
import { EmptyState, LoadingState } from '@/components/common';
import type { Risk } from '@/types/audit';
import { useParams } from 'react-router-dom';
import { api } from '@/api/client';
import { useToast } from '@/hooks';
import { fmtDate } from '@/utils/date';

/**
 * 风险登记册（P1 二期规划占位）
 * @prd P0-06（一期仅展示占位）
 */
export function RisksPage(): JSX.Element {
  const { id = '' } = useParams();
  const toast = useToast();
  const [rows, setRows] = useState<Risk[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api
      .listRisks(id)
      .then(setRows)
      .catch((e: unknown) => toast.error(e))
      .finally(() => setLoading(false));
  }, [id, toast]);

  const columns: Array<Column<Risk>> = [
    { key: 'code', label: '编号', width: 90 },
    { key: 'description', label: '风险描述', render: (r) => <Typography sx={{ fontSize: 14 }}>{r.description}</Typography> },
    { key: 'category', label: '类别', width: 110 },
    {
      key: 'riskValue',
      label: '风险值',
      width: 90,
      align: 'right',
      render: (r) => <Typography sx={{ fontSize: 13 }}>{r.probability * r.impact}</Typography>,
    },
    { key: 'owner', label: '责任人', width: 96 },
    { key: 'status', label: '状态', width: 96, render: (r) => <StatusChip status={r.status} /> },
    { key: 'reviewDate', label: '复评日', width: 110, render: (r) => <Typography sx={{ fontSize: 13 }}>{fmtDate(r.reviewDate)}</Typography> },
  ];

  return (
    <Stack spacing={2.5}>
      <PageHeader title="风险登记册" subtitle="P1 二期能力：风险登记、概率/影响矩阵与应对跟踪（本期为占位）" />
      <SectionCard flush>
        {loading ? (
          <LoadingState variant="skeleton" rows={4} height={48} />
        ) : rows.length === 0 ? (
          <EmptyState title="暂无风险记录" description="P1 阶段将接入风险登记与矩阵视图" />
        ) : (
          <Box sx={{ p: 1 }}>
            <DataTable<Risk> columns={columns} rows={rows} rowKey={(r) => r.id} />
          </Box>
        )}
      </SectionCard>
    </Stack>
  );
}
