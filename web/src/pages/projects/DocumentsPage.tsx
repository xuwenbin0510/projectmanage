import { useEffect, useState } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';

import { DataTable, PageHeader, SectionCard, StatusChip } from '@/components/common';
import type { Column } from '@/components/common';
import { EmptyState, LoadingState } from '@/components/common';
import type { ProjectDocument } from '@/types/audit';
import { useParams } from 'react-router-dom';
import { api } from '@/api/client';
import { useToast } from '@/hooks';
import { fmtDate } from '@/utils/date';

/**
 * 文档清单（P1 二期规划占位）
 * @prd P0-06（一期仅展示占位）
 */
export function DocumentsPage(): JSX.Element {
  const { id = '' } = useParams();
  const toast = useToast();
  const [rows, setRows] = useState<ProjectDocument[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api
      .listDocuments(id)
      .then(setRows)
      .catch((e: unknown) => toast.error(e))
      .finally(() => setLoading(false));
  }, [id, toast]);

  const columns: Array<Column<ProjectDocument>> = [
    {
      key: 'name',
      label: '文档',
      render: (d) => (
        <Stack direction="row" spacing={1} alignItems="center">
          <DescriptionOutlinedIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
          <Box>
            <Typography sx={{ fontSize: 14, fontWeight: 500 }}>{d.name}</Typography>
            <Typography variant="caption" color="text.secondary">
              {d.templateKey} · v{d.version}
            </Typography>
          </Box>
        </Stack>
      ),
    },
    { key: 'status', label: '状态', width: 110, render: (d) => <StatusChip status={d.status} /> },
    {
      key: 'baselineFlag',
      label: '基线',
      width: 80,
      align: 'center',
      render: (d) => (d.baselineFlag ? <StatusChip status="已批准" label="基线" /> : <Typography variant="caption" color="text.secondary">—</Typography>),
    },
    { key: 'owner', label: '责任人', width: 110 },
    {
      key: 'url',
      label: '链接',
      width: 120,
      render: (d) =>
        d.url ? (
          <Typography
            component="a"
            href={d.url}
            target="_blank"
            rel="noreferrer"
            sx={{ fontSize: 13, color: 'primary.main' }}
          >
            查看
          </Typography>
        ) : (
          <Typography variant="caption" color="text.secondary">
            —
          </Typography>
        ),
    },
  ];

  return (
    <Stack spacing={2.5}>
      <PageHeader title="文档清单" subtitle="P1 二期能力：按阶段模板自动派生交付物清单与基线管控（本期为占位）" />
      <SectionCard flush>
        {loading ? (
          <LoadingState variant="skeleton" rows={4} height={48} />
        ) : rows.length === 0 ? (
          <EmptyState title="暂无文档" description="P1 阶段将按生命周期模板自动派生交付物" />
        ) : (
          <Box sx={{ p: 1 }}>
            <DataTable<ProjectDocument> columns={columns} rows={rows} rowKey={(d) => d.id} />
          </Box>
        )}
      </SectionCard>
    </Stack>
  );
}
