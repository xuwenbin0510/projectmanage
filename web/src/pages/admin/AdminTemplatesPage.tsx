import { useEffect, useState } from 'react';
import { Box, Chip, Stack, Typography } from '@mui/material';

import { DataTable, EmptyState, LoadingState, PageHeader, SectionCard, StatusChip } from '@/components/common';
import type { Column } from '@/components/common';
import { AdminTabs } from './AdminTabs';
import type { LifecycleTemplate, ProjectType } from '@/types/project';
import { api } from '@/api/client';
import { useToast } from '@/hooks';
import { PROJECT_TYPE_LABEL } from '@/config/enums';

/**
 * 管理后台 · 生命周期模板（P0-16 管理后台）
 * @prd P0-16
 */
export function AdminTemplatesPage(): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<LifecycleTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .listTemplates()
      .then(setRows)
      .catch((e: unknown) => toast.error(e))
      .finally(() => setLoading(false));
  }, [toast]);

  const columns: Array<Column<LifecycleTemplate>> = [
    { key: 'name', label: '模板名称', render: (t) => <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{t.name}</Typography> },
    {
      key: 'type',
      label: '适用分类',
      width: 110,
      render: (t) => <Chip size="small" variant="outlined" label={PROJECT_TYPE_LABEL[t.projectType as ProjectType]} />,
    },
    { key: 'version', label: '版本', width: 80, render: (t) => <Typography variant="caption">v{t.version}</Typography> },
    { key: 'milestones', label: '里程碑数', width: 100, align: 'center', render: (t) => <Typography variant="caption">{t.definition.milestones.length}</Typography> },
    {
      key: 'gates',
      label: '质量门数',
      width: 100,
      align: 'center',
      render: (t) => (
        <Typography variant="caption">{t.definition.milestones.filter((m) => m.gate).length}</Typography>
      ),
    },
    { key: 'docs', label: '交付物数', width: 100, align: 'center', render: (t) => <Typography variant="caption">{t.definition.docs.length}</Typography> },
    { key: 'isActive', label: '状态', width: 100, render: (t) => <StatusChip status={t.isActive ? '已批准' : '草稿'} label={t.isActive ? '启用' : '停用'} /> },
  ];

  return (
    <Stack spacing={2.5}>
      <AdminTabs />
      <PageHeader title="生命周期模板" subtitle="A / B / C 三类项目各自的生命周期定义：里程碑、质量门与交付物（只读预览）" />
      <SectionCard flush>
        {loading ? (
          <LoadingState variant="skeleton" rows={4} height={48} />
        ) : rows.length === 0 ? (
          <EmptyState title="暂无模板" description="生命周期模板由系统初始化生成" />
        ) : (
          <Box sx={{ p: 1 }}>
            <DataTable<LifecycleTemplate> columns={columns} rows={rows} rowKey={(t) => t.id} />
          </Box>
        )}
      </SectionCard>
    </Stack>
  );
}
