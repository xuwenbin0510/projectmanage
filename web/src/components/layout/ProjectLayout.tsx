import { useEffect } from 'react';
import { Box, Chip, Stack, Tab, Tabs, Typography } from '@mui/material';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { HealthDot, LoadingState, PageHeader, StatusChip } from '@/components/common';
import { PROJECT_TABS, ROUTES } from '@/config/routes';
import { PROJECT_TYPE_SHORT } from '@/config/enums';
import { useProjectStore } from '@/stores/projectStore';
import { useToast } from '@/hooks/useToast';
import { fmtAmount } from '@/utils/format';

/**
 * 项目详情外壳：加载项目聚合数据 + Tab 导航
 * @prd P0-04
 */
export function ProjectLayout(): JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const toast = useToast();

  const current = useProjectStore((s) => s.current);
  const loading = useProjectStore((s) => s.detailLoading);
  const fetchDetail = useProjectStore((s) => s.fetchDetail);
  const clearDetail = useProjectStore((s) => s.clearDetail);

  useEffect(() => {
    if (!id) return;
    fetchDetail(id).catch((e: unknown) => {
      toast.error(e);
      navigate(ROUTES.projects, { replace: true });
    });
    return () => clearDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const activeSeg = pathname.split('/')[3] ?? 'overview';

  if (loading && !current) return <LoadingState variant="skeleton" rows={6} />;
  if (!current) return <LoadingState variant="spinner" label="正在加载项目…" />;

  return (
    <Box>
      <PageHeader
        title={current.name}
        crumbs={[{ label: '项目', to: ROUTES.projects }, { label: current.code }]}
        subtitle={`${current.customer || '内部项目'} · 合同额 ${fmtAmount(current.contractAmount)} · 计划 ${current.planStart} ~ ${current.planEnd}`}
        badges={
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip size="small" label={PROJECT_TYPE_SHORT[current.type]} variant="outlined" />
            <StatusChip status={current.status} />
            <HealthDot health={current.health} showLabel />
          </Stack>
        }
      />

      <Tabs
        value={activeSeg}
        onChange={(_, v: string) => navigate(`${ROUTES.project(id)}/${v}`)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ mb: 2.5, borderBottom: 1, borderColor: 'divider', minHeight: 42 }}
      >
        {PROJECT_TABS.map((t) => (
          <Tab
            key={t.key}
            value={t.segment}
            sx={{ minHeight: 42 }}
            label={
              <Stack direction="row" spacing={0.75} alignItems="center">
                <span>{t.label}</span>
                {t.phase && (
                  <Typography component="span" variant="caption" sx={{ opacity: 0.6 }}>
                    {t.phase}
                  </Typography>
                )}
              </Stack>
            }
          />
        ))}
      </Tabs>

      <Outlet />
    </Box>
  );
}
