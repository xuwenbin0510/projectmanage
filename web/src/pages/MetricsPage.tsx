import { Box, Stack, Typography } from '@mui/material';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';

import { PageHeader, SectionCard, StatCard } from '@/components/common';

/**
 * 度量看板（P1 二期规划占位）
 * @prd P0-13（一期仅展示占位）
 */
export function MetricsPage(): JSX.Element {
  return (
    <Stack spacing={2.5}>
      <PageHeader
        title="度量看板"
        subtitle="P1 二期能力：进度偏差、缺陷密度、评审通过率、资源负荷等多维度量（本期为占位）"
      />
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' },
        }}
      >
        <StatCard label="在管项目" value="—" tone="brand" hint="P1 接入后展示" icon={<InsightsOutlinedIcon />} />
        <StatCard label="平均进度偏差" value="—" tone="warning" hint="P1 接入后展示" icon={<InsightsOutlinedIcon />} />
        <StatCard label="评审通过率" value="—" tone="success" hint="P1 接入后展示" icon={<InsightsOutlinedIcon />} />
        <StatCard label="逾期任务数" value="—" tone="danger" hint="P1 接入后展示" icon={<InsightsOutlinedIcon />} />
      </Box>
      <SectionCard title="趋势与明细">
        <Stack alignItems="center" justifyContent="center" sx={{ py: 8, color: 'text.secondary' }}>
          <InsightsOutlinedIcon sx={{ fontSize: 40, opacity: 0.5 }} />
          <Typography variant="body2" sx={{ mt: 1 }}>
            度量看板将在 P1 阶段接入实时数据，支持按项目 / 团队 / 时间维度下钻。
          </Typography>
        </Stack>
      </SectionCard>
    </Stack>
  );
}
