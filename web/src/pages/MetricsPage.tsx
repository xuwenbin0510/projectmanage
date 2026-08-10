/**
 * 全局总览（B12 · T05）
 *
 * 复用 `/metrics` 路由：顶部 4 张指标卡 + 筛选栏（分类 / 状态 / 健康度 /
 * 关键字 / 范围开关）+ 图表区（状态环 DonutChart / 健康 HealthDistBar /
 * 逾期 OverdueBarChart / 负责人负荷 OwnerLoadBarChart）+ 项目明细表（DataTable），
 * 行点击钻取到 B11 单项目仪表盘，健康/状态色段下钻到同页筛选，负责人行
 * 下钻到 OwnerLoadDrawer（P1-6）。
 *
 * 全部数据由 `useDashboardOverview` 一次性从 `GET /api/dashboard/overview`
 * 拉取（服务端聚合，前端只展示），避免 B11 式前端聚合在多项目量级下漂移。
 *
 * ⚠ 范围（scope）语义（SK-B12-7）：
 *  - `canSeeAll`（admin / pmo / management）：可切「公司全量 all」↔「我参与的 mine」；
 *  - 其余角色：scope 恒为 `mine`（服务端强制降级，P1-9 不报错），前端用 `onlyMine`
 *    在「我参与的」与「我负责的（PM）」之间细分。
 *
 * @prd B12
 */

import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  FormControlLabel,
  InputAdornment,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import RefreshIcon from '@mui/icons-material/Refresh';
import BusinessOutlinedIcon from '@mui/icons-material/BusinessOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import AssignmentLateOutlinedIcon from '@mui/icons-material/AssignmentLateOutlined';

import {
  DataTable,
  ErrorState,
  HealthDot,
  PageHeader,
  ProgressBar,
  SectionCard,
  StatCard,
  StatusChip,
} from '@/components/common';
import type { Column } from '@/components/common';
import {
  DonutChart,
  HealthDistBar,
  OverdueBarChart,
  OwnerLoadBarChart,
  OwnerLoadDrawer,
} from '@/components/dashboard';
import type { DonutSegment } from '@/components/dashboard';
import { useDashboardOverview, useDebounced } from '@/hooks';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '@/config/routes';
import { PROJECT_TYPE_SHORT, PROJECT_TYPES, HEALTH_LABEL } from '@/config/enums';
import { fmtDate } from '@/utils/date';
import type { Health, ProjectListItem, ProjectStatus, ProjectType } from '@/types/project';
import type { OwnerLoadRow, StatusDonutSegment } from '@/types/dashboard';
import type { SemanticTone } from '@/theme/tokens';

/** 决策 ⑥：统计基线恒为「在管三态」，其余状态入参会被服务端丢弃（避免误导） */
const MANAGED_STATUSES: ProjectStatus[] = ['已批准', '进行中', '挂起'];
const HEALTH_OPTIONS: Health[] = ['green', 'yellow', 'red'];

/** 周报填报率阈值色调：100% 成功 / ≥60% 警示 / 其余危险 */
function rateTone(rate?: number): SemanticTone {
  const r = rate ?? 0;
  if (r >= 100) return 'success';
  if (r >= 60) return 'warning';
  return 'danger';
}

/* ── 项目明细表列（模块级常量，避免每次渲染重建） ───────────── */
const projectColumns: Array<Column<ProjectListItem>> = [
  {
    key: 'name',
    label: '项目',
    render: (r) => (
      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
        <HealthDot health={r.health} />
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: 14, fontWeight: 600 }} noWrap>
            {r.name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {r.code} · {r.customer || '内部'}
          </Typography>
        </Box>
      </Stack>
    ),
  },
  {
    key: 'type',
    label: '分类',
    width: 78,
    render: (r) => (
      <Typography sx={{ fontSize: 13 }} variant="caption">
        {PROJECT_TYPE_SHORT[r.type]}
      </Typography>
    ),
  },
  { key: 'status', label: '状态', width: 92, render: (r) => <StatusChip status={r.status} /> },
  {
    key: 'nextMilestone',
    label: '下一里程碑 / 门',
    width: 190,
    hideOnMobile: true,
    render: (r) => (
      <Box>
        <Typography sx={{ fontSize: 13 }} noWrap>
          {r.nextMilestoneCode ? `${r.nextMilestoneCode} ${r.nextMilestoneName}` : '全部里程碑已达成'}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          已过 {r.gatePassed}/{r.gateTotal} 道门
          {r.currentGateCode ? ` · ${r.currentGateCode} ${r.currentGateStatus}` : ''}
        </Typography>
      </Box>
    ),
  },
  {
    key: 'progress',
    label: '进度',
    width: 140,
    hideOnMobile: true,
    render: (r) => <ProgressBar value={r.progress} tone={r.health === 'red' ? 'danger' : 'brand'} />,
  },
  {
    key: 'milestone',
    label: '里程碑',
    width: 130,
    hideOnMobile: true,
    render: (r) => (
      <Box>
        <Typography sx={{ fontSize: 13 }}>
          {r.milestoneDone} / {r.milestoneTotal}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          下一个 {fmtDate(r.nextMilestoneDate)}
        </Typography>
      </Box>
    ),
  },
  { key: 'pmName', label: 'PM', width: 84, hideOnMobile: true },
];

/**
 * 全局总览页（多项目组合视图）。
 *
 * ```tsx
 * <MetricsPage />
 * ```
 */
export function MetricsPage(): JSX.Element {
  const navigate = useNavigate();
  const {
    data,
    loading,
    error,
    query,
    scope,
    canSeeAll,
    refreshedAt,
    setQuery,
    setScope,
    refresh,
  } = useDashboardOverview();

  const [keyword, setKeyword] = useState<string>(query.keyword ?? '');
  const debounced = useDebounced(keyword, 300);
  useEffect(() => {
    setQuery({ keyword: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const [drawerRow, setDrawerRow] = useState<OwnerLoadRow | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const openOwner = (row: OwnerLoadRow): void => {
    setDrawerRow(row);
    setDrawerOpen(true);
  };

  const stats = data?.stats;
  const projects = data?.projects;

  /* 状态环：在管三态计数 → DonutChart 段（颜色按品牌色阶自动轮转） */
  const statusSegments: DonutSegment[] = (data?.statusDonut.segments ?? []).map((s: StatusDonutSegment) => ({
    id: s.status,
    label: s.status,
    value: s.value,
  }));

  const scopeLabel = canSeeAll
    ? scope === 'all'
      ? '公司全量'
      : '我参与的'
    : query.onlyMine
      ? '我负责的（PM）'
      : '我参与的';

  return (
    <Box>
      <PageHeader
        title="全局总览"
        subtitle={`${scopeLabel} · ${refreshedAt ? `更新于 ${refreshedAt}` : '加载中…'}`}
        actions={
          <Button
            variant="outlined"
            size="small"
            startIcon={<RefreshIcon />}
            onClick={refresh}
            disabled={loading}
          >
            刷新
          </Button>
        }
      />

      {/* ══ 筛选栏 ══ */}
      <SectionCard sx={{ mb: 2 }}>
        <Stack direction="row" spacing={1.25} flexWrap="wrap" useFlexGap alignItems="center">
          <TextField
            size="small"
            placeholder="搜索项目名 / 编号 / 客户"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            sx={{ minWidth: 240, flex: '1 1 240px' }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
          <TextField
            size="small"
            select
            label="分类"
            value={query.type ?? ''}
            onChange={(e) => setQuery({ type: e.target.value as ProjectType | '' })}
            sx={{ minWidth: 132 }}
          >
            <MenuItem value="">全部分类</MenuItem>
            {PROJECT_TYPES.map((t) => (
              <MenuItem key={t} value={t}>
                {PROJECT_TYPE_SHORT[t]}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="状态"
            value={query.status ?? ''}
            onChange={(e) => setQuery({ status: e.target.value as ProjectStatus | '' })}
            sx={{ minWidth: 132 }}
          >
            <MenuItem value="">在管三态</MenuItem>
            {MANAGED_STATUSES.map((s) => (
              <MenuItem key={s} value={s}>
                {s}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="健康度"
            value={query.health ?? ''}
            onChange={(e) => setQuery({ health: e.target.value as Health | '' })}
            sx={{ minWidth: 124 }}
          >
            <MenuItem value="">全部</MenuItem>
            {HEALTH_OPTIONS.map((h) => (
              <MenuItem key={h} value={h}>
                {HEALTH_LABEL[h]}
              </MenuItem>
            ))}
          </TextField>

          {canSeeAll ? (
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={scope === 'all'}
                  onChange={(e) => setScope(e.target.checked ? 'all' : 'mine')}
                />
              }
              label={<Typography sx={{ fontSize: 13 }}>公司全量</Typography>}
            />
          ) : (
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={Boolean(query.onlyMine)}
                  onChange={(e) => setQuery({ onlyMine: e.target.checked })}
                />
              }
              label={<Typography sx={{ fontSize: 13 }}>只看我负责的</Typography>}
            />
          )}
        </Stack>
      </SectionCard>

      {/* ══ 顶部四张指标卡 ══ */}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' },
          mb: 2.5,
        }}
      >
        <StatCard
          label="在管项目"
          value={stats?.managedProjects ?? 0}
          unit="个"
          tone="brand"
          hint={scopeLabel}
          icon={<BusinessOutlinedIcon fontSize="small" />}
        />
        <StatCard
          label="红灯项目"
          value={stats?.redProjects ?? 0}
          unit="个"
          tone={(stats?.redProjects ?? 0) > 0 ? 'danger' : 'success'}
          hint="健康度 = 红"
          icon={<ErrorOutlineIcon fontSize="small" />}
        />
        <StatCard
          label="逾期任务"
          value={stats?.overdueTasks ?? 0}
          unit="个"
          tone={(stats?.overdueTasks ?? 0) > 0 ? 'danger' : 'success'}
          hint="范围内未完成且超期"
          icon={<ReportProblemOutlinedIcon fontSize="small" />}
        />
        <StatCard
          label="本周周报填报率"
          value={stats?.reportFillRate ?? 0}
          unit="%"
          tone={rateTone(stats?.reportFillRate)}
          hint={`已填 ${stats?.reportFilled ?? 0} / 应填 ${stats?.reportDue ?? 0}`}
          icon={<AssignmentLateOutlinedIcon fontSize="small" />}
        />
      </Box>

      {/* ══ 图表区（4 张等高图表，md+ 两列 2×2） ══ */}
      <Box
        sx={{
          display: 'grid',
          gap: 2.5,
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' },
          mb: 2.5,
        }}
      >
        <DonutChart
          title="项目状态分布"
          subtitle="口径：在管三态（已批准 / 进行中 / 挂起）"
          segments={statusSegments}
          centerValue={String(stats?.managedProjects ?? 0)}
          centerLabel="在管项目"
          loading={loading}
          empty={(data?.statusDonut.total ?? 0) === 0}
          emptyTitle="暂无在管项目"
          emptyDescription="切换范围或调整筛选条件试试"
          onSegmentClick={(seg) => {
            const st = seg.id as ProjectStatus;
            setQuery({ status: query.status === st ? '' : st });
          }}
        />
        <HealthDistBar
          dist={data?.health ?? { green: 0, yellow: 0, red: 0, total: 0 }}
          loading={loading}
          onDrill={(h) => setQuery({ health: query.health === h ? '' : h })}
        />
        <OverdueBarChart rows={data?.overdue ?? []} loading={loading} />
        <OwnerLoadBarChart rows={data?.ownerLoad ?? []} loading={loading} onDrill={openOwner} />
      </Box>

      {/* ══ 项目明细表（整行下钻到单项目仪表盘） ══ */}
      <SectionCard flush>
        {error ? (
          <ErrorState error={error} onRetry={refresh} />
        ) : (
          <DataTable<ProjectListItem>
            columns={projectColumns}
            rows={projects?.items ?? []}
            rowKey={(r) => r.id}
            loading={loading}
            emptyTitle="没有符合条件的项目"
            emptyDescription="调整筛选条件，或切换到「我参与的」范围"
            onRowClick={(r) => navigate(ROUTES.projectOverview(r.id))}
            pagination={{
              page: query.page ?? 1,
              pageSize: query.pageSize ?? 20,
              total: projects?.total ?? 0,
              onChange: (page, pageSize) => setQuery({ page, pageSize }),
            }}
          />
        )}
      </SectionCard>

      <OwnerLoadDrawer open={drawerOpen} row={drawerRow} onClose={() => setDrawerOpen(false)} />
    </Box>
  );
}
