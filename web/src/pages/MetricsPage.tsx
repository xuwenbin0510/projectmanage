/**
 * 全局总览（B12 · T05）
 *
 * 复用 `/metrics` 路由：顶部 8 张指标卡 + 筛选栏（分类 / 状态 / 健康度 /
 * 关键字 / 负责人 / 范围开关）+ 图表区（任务执行：任务进度环 / 优先级 / 状态 /
 * 逾期时长；项目健康：状态环 / 健康度 / 负责人负荷 / 各项目任务量；质量与交付：质量门 / 交付物）
 * + 任务时间轴（逾期 / 临期 / 计划周期内 三栏，任务级），
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

import { useEffect, useRef, useState, type RefObject } from 'react';
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
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import EventOutlinedIcon from '@mui/icons-material/EventOutlined';

import {
  EmptyState,
  PageHeader,
  SectionCard,
  StatCard,
} from '@/components/common';
import {
  CategoryBarChart,
  DeliverableDetailDrawer,
  DistributionTaskDrawer,
  DonutChart,
  GateDetailDrawer,
  HealthDonut,
  OwnerLoadBarChart,
  OwnerLoadDrawer,
  ProgressDonut,
  ProjectTaskCountPanel,
  ProjectCompletionRank,
  ReportClosureListDrawer,
  TaskTimeRow,
  WeeklyProgressPanel,
} from '@/components/dashboard';
import type { CategoryBarRow, DonutSegment } from '@/components/dashboard';
import type {
  DashboardDeliverablesQuery,
  DashboardGatesQuery,
  ReportClosureItem,
} from '@/types/dashboard';
import { useDashboardOverview, useDebounced } from '@/hooks';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '@/config/routes';
import {
  HEALTH_LABEL,
  PRIORITIES,
  PRIORITY_OPTIONS,
  PROJECT_TYPE_SHORT,
  PROJECT_TYPES,
  TASK_STATUSES,
} from '@/config/enums';
import { diffDays, fmtDate, today } from '@/utils/date';
import { hexAlpha, useChartPalette } from '@/theme/chartPalette';
import type { Health, ProjectStatus, ProjectType } from '@/types/project';
import type { DashboardTasksQuery, OverdueBucket, OwnerLoadRow, ProgressSegment, StatusDonutSegment } from '@/types/dashboard';
import type { Priority, TaskStatus, WbsNode } from '@/types/wbs';
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

/** B18：逾期时长图 key（days1to7/days8to30/daysOver30）→ 接口档位 / 抽屉标题 */
const DURATION_KEY_TO_BUCKET: Record<string, OverdueBucket> = {
  days1to7: '1to7',
  days8to30: '8to30',
  daysOver30: 'over30',
};
const DURATION_TITLE: Record<string, string> = {
  days1to7: '逾期 1–7 天任务明细',
  days8to30: '逾期 8–30 天任务明细',
  daysOver30: '逾期 >30 天任务明细',
};


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

  /* B18：分布图点档下钻抽屉（受控组件，query 存 state 保证身份稳定） */
  const [distDrawer, setDistDrawer] = useState<{
    open: boolean;
    title: string;
    query: DashboardTasksQuery;
  }>({ open: false, title: '', query: {} });

  const openDist = (
    title: string,
    dim: Partial<Pick<DashboardTasksQuery, 'priority' | 'taskStatus' | 'overdueBucket'>>,
  ): void => {
    const base: DashboardTasksQuery = {
      scope,                              // 有效 scope（服务端降级后）
      type: query.type ?? '',
      status: query.status ?? '',
      health: query.health ?? '',
      keyword: query.keyword ?? '',
      onlyMine: query.onlyMine ?? false,
    };
    setDistDrawer({ open: true, title, query: { ...base, ...dim } });
  };

  /* ② 任务进度环三段下探（已完成 / 在办=进行中+待评审 / 未启动=待办+阻塞） */
  const openProgressDrill = (segment: ProgressSegment): void => {
    const map: Record<ProgressSegment, { title: string; taskStatus: TaskStatus[] }> = {
      done: { title: '已完成任务', taskStatus: ['完成'] },
      active: { title: '在办任务（进行中 / 待评审）', taskStatus: ['进行中', '待评审'] },
      pending: { title: '未启动任务（待办 / 阻塞）', taskStatus: ['待办', '阻塞'] },
    };
    const m = map[segment];
    openDist(m.title, { taskStatus: m.taskStatus });
  };

  /* 第二批：质量与交付下探抽屉（门控 / 交付物，受控组件，query 存 state 保证身份稳定） */
  const [gateDrawer, setGateDrawer] = useState<{
    open: boolean;
    title: string;
    query: DashboardGatesQuery;
  }>({ open: false, title: '', query: {} });

  /** 段 id（gateSegments）→ 门状态白名单值；打开门控明细抽屉 */
  const openGate = (segId: string): void => {
    const map: Record<string, DashboardGatesQuery['gateStatus']> = {
      passed: '已通过',
      conditional: '有条件通过',
      failed: '不通过',
      pendingCheck: '待检查',
      notStarted: '未开始',
    };
    const gateStatus = map[segId];
    setGateDrawer({
      open: true,
      title: gateStatus ? `「${gateStatus}」质量门明细` : '质量门明细',
      query: {
        scope,
        type: query.type ?? '',
        status: query.status ?? '',
        health: query.health ?? '',
        keyword: query.keyword ?? '',
        ownerOpenId: query.ownerOpenId ?? '',
        onlyMine: query.onlyMine ?? false,
        gateStatus,
      },
    });
  };

  const [delivDrawer, setDelivDrawer] = useState<{
    open: boolean;
    title: string;
    query: DashboardDeliverablesQuery;
  }>({ open: false, title: '', query: {} });

  /** 段 id（deliverableSegments）→ 交付状态；打开交付物明细抽屉 */
  const openDeliverables = (segId: string): void => {
    const docStatus = segId === 'delivered' ? '已交付' : segId === 'pending' ? '待交付' : undefined;
    setDelivDrawer({
      open: true,
      title: docStatus ? `「${docStatus}」成果物明细` : '交付物明细',
      query: {
        scope,
        type: query.type ?? '',
        status: query.status ?? '',
        health: query.health ?? '',
        keyword: query.keyword ?? '',
        ownerOpenId: query.ownerOpenId ?? '',
        onlyMine: query.onlyMine ?? false,
        docStatus,
      },
    });
  };

  /* B12：周报闭环率卡片下钻抽屉（数据来自 overview.reportClosureItems，无需额外请求） */
  const [closureOpen, setClosureOpen] = useState(false);

  /* B12：任务时间轴「查看全部」→ 复用 DistributionTaskDrawer（dueWindow 维度下钻） */
  const openTimelineAll = (dueWindow: 'overdue' | 'dueSoon' | 'cycle', title: string): void => {
    setDistDrawer({
      open: true,
      title,
      query: {
        scope,
        type: query.type ?? '',
        status: query.status ?? '',
        health: query.health ?? '',
        keyword: query.keyword ?? '',
        onlyMine: query.onlyMine ?? false,
        dueWindow,
      },
    });
  };

  /* 分组锚点 ref（指标卡下钻滚动目标） */
  const tasksRef = useRef<HTMLDivElement | null>(null);

  /* B12：任务时间轴单栏渲染（逾期 / 临期 / 计划周期内 三栏同格式，复用共享 TaskTimeRow） */
  const renderTimelineColumn = (
    title: string,
    subtitle: string,
    rows: WbsNode[],
    hintFn: (t: WbsNode) => string,
    dueWindow: 'overdue' | 'dueSoon' | 'cycle',
    allTitle: string,
    emptyTitle: string,
  ): JSX.Element => (
    <SectionCard
      title={title}
      subtitle={subtitle}
      actions={
        rows.length > 0 ? (
          <Button size="small" onClick={() => openTimelineAll(dueWindow, allTitle)}>
            查看全部
          </Button>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <EmptyState title={emptyTitle} dense />
      ) : (
        <Stack spacing={0.75}>
          {rows.slice(0, 6).map((t) => (
            <TaskTimeRow
              key={t.id}
              task={t}
              hint={hintFn(t)}
              onClick={() => navigate(ROUTES.projectWbs(t.projectId) + '?taskId=' + t.id)}
            />
          ))}
        </Stack>
      )}
    </SectionCard>
  );

  const timeline = data?.taskTimeline;
  const EMPTY_TITLE: Record<string, string> = {
    overdue: '没有逾期任务',
    dueSoon: '未来 3 天没有临期任务',
    cycle: '未来两周内没有即将到期的任务',
  };
  const qualityRef = useRef<HTMLDivElement | null>(null);
  const weeklyRef = useRef<HTMLDivElement | null>(null);
  const scrollToRef = (ref: RefObject<HTMLDivElement | null>): void => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const stats = data?.stats;

  /* 状态环：在管三态计数 → DonutChart 段（颜色按品牌色阶自动轮转） */
  const statusSegments: DonutSegment[] = (data?.statusDonut.segments ?? []).map((s: StatusDonutSegment) => ({
    id: s.status,
    label: s.status,
    value: s.value,
  }));

  /* B17：新增 3 张分布图的 rows（局部取色，真 hex + hexAlpha 预乘半透明） */
  const palette = useChartPalette();

  /* 优先级 4 档：P0 红 / P1 黄 / P2 品牌蓝 / P3 灰（同 B14 工作台优先级环） */
  const priorityRows: CategoryBarRow[] = PRIORITIES.map((p) => ({
    key: p,
    label: PRIORITY_OPTIONS.find((o) => o.value === p)?.label ?? p, // 'P0 最高' 等
    value: data?.priorityDist[p] ?? 0,
    color:
      p === 'P0'
        ? palette.health.red
        : p === 'P1'
          ? palette.health.yellow
          : p === 'P2'
            ? palette.brandMain
            : palette.track,
  }));

  /* 状态 5 档：待办灰 / 进行中品牌蓝 / 待评审黄 / 阻塞红 / 完成绿（主理人拍板 #4） */
  const statusRows: CategoryBarRow[] = TASK_STATUSES.map((s) => ({
    key: s,
    label: s,
    value: data?.statusDist[s] ?? 0,
    color:
      s === '待办'
        ? palette.track
        : s === '进行中'
          ? palette.brand[1]
          : s === '待评审'
            ? palette.health.yellow
            : s === '阻塞'
              ? palette.health.red
              : palette.health.green, // 完成
  }));

  /* 逾期时长 3 段：红系递进（浅 → 中 → 深） */
  const durationRows: CategoryBarRow[] = [
    { key: 'days1to7', label: '逾期 1–7 天', value: data?.overdueDuration.days1to7 ?? 0, color: hexAlpha(palette.health.red, 0.5) },
    { key: 'days8to30', label: '逾期 8–30 天', value: data?.overdueDuration.days8to30 ?? 0, color: hexAlpha(palette.health.red, 0.75) },
    { key: 'daysOver30', label: '逾期 >30 天', value: data?.overdueDuration.daysOver30 ?? 0, color: palette.health.red },
  ];

  /* D11：质量门状态分布段（已通过/有条件通过/不通过/待检查/未开始） */
  const gateSegments: DonutSegment[] = [
    { id: 'passed', label: '已通过', value: data?.gates?.passed ?? 0, color: palette.health.green },
    { id: 'conditional', label: '有条件通过', value: data?.gates?.conditional ?? 0, color: palette.brandMain },
    { id: 'failed', label: '不通过', value: data?.gates?.failed ?? 0, color: palette.health.red },
    { id: 'pendingCheck', label: '待检查', value: data?.gates?.pendingCheck ?? 0, color: palette.health.yellow },
    { id: 'notStarted', label: '未开始', value: data?.gates?.notStarted ?? 0, color: palette.track },
  ];
  const gatePassRate = (data?.gates?.total ?? 0)
    ? Math.round(((data?.gates?.passed ?? 0) / (data?.gates?.total ?? 0)) * 100)
    : 0;

  /* 第一批：交付物已交付率（卡片 + 图中心值共用；分母为全量，手动记录恒已交付影响 <4%） */
  const deliveredRate = (data?.deliverables?.total ?? 0)
    ? Math.round(((data?.deliverables?.delivered ?? 0) / (data?.deliverables?.total ?? 0)) * 100)
    : 0;

  /* D11：交付物状态分布段（已交付/待交付），中心值=已基线覆盖率 */
  const deliverableSegments: DonutSegment[] = [
    { id: 'delivered', label: '已交付', value: data?.deliverables?.delivered ?? 0, color: palette.health.green },
    { id: 'pending', label: '待交付', value: data?.deliverables?.pending ?? 0, color: palette.health.yellow },
  ];

  const scopeLabel = canSeeAll
    ? scope === 'all'
      ? '公司全量'
      : '我参与的'
    : query.onlyMine
      ? '我负责的（PM）'
      : '我参与的';

  return (
    /* 第二批：高分辨率自适应 —— 内容区限宽 1600 居中（4K/宽屏不再全宽拉伸） */
    <Box sx={{ maxWidth: 1600, mx: 'auto', px: { xs: 2, md: 3 } }}>
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
          {/* D01.5：任务负责人筛选（选项 = 范围内项目真叶子任务负责人去重，服务端 ownerOptions） */}
          <TextField
            size="small"
            select
            label="任务负责人"
            value={query.ownerOpenId ?? ''}
            onChange={(e) => setQuery({ ownerOpenId: e.target.value || undefined })}
            sx={{ minWidth: 124 }}
          >
            <MenuItem value="">全部</MenuItem>
            {(data?.ownerOptions ?? []).map((o) => (
              <MenuItem key={o.openId} value={o.openId}>
                {o.name}
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
              label={<Typography sx={{ fontSize: 13 }}>只看我负责的（PM）</Typography>}
            />
          )}
        </Stack>
      </SectionCard>

      {/* ══ 顶部指标卡（第三批 8 张 4×2 布局：在管/红灯/逾期/周报填报率/待决议门/里程碑到期/交付物交付率/周报闭环率） ══ */}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)', lg: 'repeat(4, 1fr)', xl: 'repeat(4, 1fr)' },
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
          onClick={() => setQuery({ health: 'red' })}
          icon={<ErrorOutlineIcon fontSize="small" />}
        />
        <StatCard
          label="逾期任务"
          value={stats?.overdueTasks ?? 0}
          unit="个"
          tone={(stats?.overdueTasks ?? 0) > 0 ? 'danger' : 'success'}
          hint="范围内未完成且超期"
          onClick={() => scrollToRef(tasksRef)}
          icon={<ReportProblemOutlinedIcon fontSize="small" />}
        />
        <StatCard
          label="本周周报填报率"
          value={stats?.reportFillRate ?? 0}
          unit="%"
          tone={rateTone(stats?.reportFillRate)}
          hint={`已填 ${stats?.reportFilled ?? 0} / 应填 ${stats?.reportDue ?? 0}`}
          onClick={() => scrollToRef(weeklyRef)}
          icon={<AssignmentLateOutlinedIcon fontSize="small" />}
        />
        {/* D11：待决议质量门（未开始 + 待检查）；第一批 hint 加「不通过」红灯，failed>0 时升 danger；第二批点击下探门明细 */}
        <StatCard
          label="待决议质量门"
          value={data?.gates?.pending ?? 0}
          unit="道"
          tone={(data?.gates?.failed ?? 0) > 0 ? 'danger' : (data?.gates?.pending ?? 0) > 0 ? 'warning' : 'success'}
          hint={`已过 ${data?.gates?.passed ?? 0}/${data?.gates?.total ?? 0} · 不通过 ${data?.gates?.failed ?? 0}`}
          onClick={() => openGate('')}
          icon={<VerifiedOutlinedIcon fontSize="small" />}
        />
        {/* 3rd batch near-30d milestone card click sorts nextMilestone + scrolls to table */}
        <StatCard
          label="近30天到期里程碑"
          value={data?.milestones?.total ?? 0}
          unit="个"
          tone={(data?.milestones?.overdue ?? 0) > 0 ? 'danger' : (data?.milestones?.total ?? 0) > 0 ? 'warning' : 'success'}
          hint={`已过期 ${data?.milestones?.overdue ?? 0} · 未来30天 ${data?.milestones?.upcoming ?? 0}`}
          icon={<EventOutlinedIcon fontSize="small" />}
        />
        {/* deliverable rate card 第二批点击下探交付物明细 */}
        <StatCard
          label="交付物已交付率"
          value={deliveredRate}
          unit="%"
          tone={rateTone(deliveredRate)}
          hint={`待交付 ${data?.deliverables?.pending ?? 0} · 已基线 ${data?.deliverables?.baselined ?? 0}`}
          onClick={() => openDeliverables('')}
          icon={<Inventory2OutlinedIcon fontSize="small" />}
        />
        {/* 第三批：周报闭环率（与「周报填报率」闭环：填报 + 确认） */}
        <StatCard
          label="周报闭环率"
          value={stats?.reportClosureRate ?? 0}
          unit="%"
          tone={rateTone(stats?.reportClosureRate)}
          hint={`待确认 ${stats?.pendingReportConfirm ?? 0} · 已确认 ${stats?.reportClosureConfirmed ?? 0}`}
          onClick={() => setClosureOpen(true)}
          icon={<AssignmentLateOutlinedIcon fontSize="small" />}
        />
      </Box>

      {/* ══ 图表区：按主题分组（项目健康 / 任务执行 / 质量与交付） ══ */}

      {/* ① 项目健康 */}
      <SectionCard title="项目健康" subtitle="状态 · 健康度 · 负责人负荷 · 各项目任务量 · 完成率排行" sx={{ mb: 2.5 }}>
        <Box
          sx={{
            display: 'grid',
            gap: 2.5,
            gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)', xl: 'repeat(4, 1fr)' },
            alignItems: 'stretch',
          }}
        >
          {/* ① 项目状态分布 */}
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
          {/* ② 项目健康度分布 */}
          <HealthDonut
            dist={data?.health ?? { green: 0, yellow: 0, red: 0, total: 0 }}
            loading={loading}
            onDrill={(h) => setQuery({ health: query.health === h ? '' : h })}
          />
          {/* ④ 负责人负荷 */}
          <OwnerLoadBarChart rows={data?.ownerLoad ?? []} loading={loading} onDrill={openOwner} />
          {/* ⑤ 各项目任务量（横向条形对比，作为①「项目健康」第 4 子面板，与三图并列） */}
          <SectionCard
            title="各项目任务量"
            subtitle="面积=任务数，颜色越深任务越多 · 红角标=逾期"
            sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
          >
            <ProjectTaskCountPanel
              items={data?.projectTaskStats ?? []}
              loading={loading}
              onSelect={(pid) => navigate(ROUTES.projectOverview(pid))}
            />
          </SectionCard>
          {/* ⑥ 项目完成率排行（按完成率升序，最低的排最前、最该关注） */}
          <SectionCard
            title="项目完成率排行"
            subtitle="按完成率升序，越低越该关注 · 红=落后"
            sx={{ gridColumn: '1 / -1', height: '100%', display: 'flex', flexDirection: 'column' }}
          >
            <ProjectCompletionRank
              items={data?.projectTaskStats ?? []}
              loading={loading}
              onSelect={(pid) => navigate(ROUTES.projectOverview(pid))}
            />
          </SectionCard>
        </Box>
      </SectionCard>

      {/* ② 任务执行 */}
      <Box ref={tasksRef}>
        <SectionCard title="任务执行" subtitle="任务进度 · 优先级 · 状态 · 时长" sx={{ mb: 2.5 }}>
          <Box
            sx={{
              display: 'grid',
              gap: 2.5,
              gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)', xl: 'repeat(3, 1fr)' },
            }}
          >
            {/* ① 任务进度环（B12 新增，对齐工作台「我的任务」进度环） */}
            <ProgressDonut
              title="任务进度"
              emptyDescription="当前范围内暂无任务"
              summary={
                data?.taskProgress ?? { total: 0, done: 0, active: 0, pending: 0, completionRate: 0 }
              }
              loading={loading}
              onDrill={openProgressDrill}
            />
            {/* ⑤ 任务优先级分布 */}
            <CategoryBarChart
              title="任务优先级分布"
              subtitle={`共 ${data?.priorityDist.total ?? 0} 个未完成任务`}
              rows={priorityRows}
              loading={loading}
              emptyTitle="暂无进行中的任务"
              emptyDescription="没有需要按优先级排期的任务"
              onDrill={(key) => openDist(`${key} 任务明细`, { priority: key as Priority })}
            />
            {/* ⑥ 任务状态分布 */}
            <CategoryBarChart
              title="任务状态分布"
              subtitle={`共 ${data?.statusDist.total ?? 0} 个任务（含已完成）`}
              rows={statusRows}
              loading={loading}
              emptyTitle="当前范围暂无任务"
              onDrill={(key) => openDist(`${key}任务明细`, { taskStatus: key as TaskStatus })}
            />
            {/* ⑦ 逾期时长分段 */}
            <CategoryBarChart
              title="逾期时长分段"
              subtitle={`共 ${data?.overdueDuration.total ?? 0} 个逾期任务`}
              rows={durationRows}
              loading={loading}
              emptyTitle="太好了，没有逾期任务 🎉"
              emptyDescription="所有任务都在计划节奏内"
              onDrill={(key) =>
                openDist(DURATION_TITLE[key] ?? `${key} 任务明细`, {
                  overdueBucket: DURATION_KEY_TO_BUCKET[key],
                })
              }
            />
          </Box>
        </SectionCard>

        {/* ②-2 任务时间轴（B12 新增 · 任务级三栏，对齐工作台「时间轴」） */}
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' },
            mb: 2.5,
          }}
        >
          {renderTimelineColumn(
            '逾期任务',
            `${timeline?.overdue.length ?? 0} 个 · 已超截止日`,
            timeline?.overdue ?? [],
            (t) => `项目 ${t.projectName} · 截止 ${fmtDate(t.dueDate)} · 已逾期 ${-diffDays(today(), t.dueDate)} 天`,
            'overdue',
            '逾期任务明细',
            EMPTY_TITLE.overdue,
          )}
          {renderTimelineColumn(
            '临期任务',
            `${timeline?.dueSoon.length ?? 0} 个 · 3 天内到期`,
            timeline?.dueSoon ?? [],
            (t) => `项目 ${t.projectName} · 截止 ${fmtDate(t.dueDate)} · 临期 · 还有 ${diffDays(today(), t.dueDate)} 天`,
            'dueSoon',
            '临期任务明细',
            EMPTY_TITLE.dueSoon,
          )}
          {renderTimelineColumn(
            '计划周期内的任务',
            `${timeline?.cycle.length ?? 0} 个 · 未来 4–14 天到期`,
            timeline?.cycle ?? [],
            (t) => `项目 ${t.projectName} · 截止 ${fmtDate(t.dueDate)} · 还有 ${diffDays(today(), t.dueDate)} 天`,
            'cycle',
            '计划周期内任务明细',
            EMPTY_TITLE.cycle,
          )}
        </Box>
      </Box>

      {/* ③ 质量与交付 */}
      <Box ref={qualityRef}>
        <SectionCard title="质量与交付" subtitle="质量门 · 交付物" sx={{ mb: 2.5 }}>
          <Box
            sx={{
              display: 'grid',
              gap: 2.5,
              gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)', xl: 'repeat(3, 1fr)' },
            }}
          >
            {/* ⑧ 质量门状态分布（第二批：点段下探门控明细抽屉） */}
            <DonutChart
              title="质量门状态分布"
              subtitle={`${data?.gates?.passed ?? 0}/${data?.gates?.total ?? 0} 已过 · ${data?.gates?.pending ?? 0} 待决议`}
              segments={gateSegments}
              centerValue={`${gatePassRate}%`}
              centerLabel="门通过率"
              loading={loading}
              empty={(data?.gates?.total ?? 0) === 0}
              emptyTitle="暂无质量门"
              emptyDescription="范围内项目尚未配置质量门"
              onSegmentClick={(seg) => openGate(seg.id)}
            />
            {/* ⑨ 交付物状态分布（第一批中心值换已交付率，基线保留副标题；第二批：点段下探交付物明细） */}
            <DonutChart
              title="交付物状态分布"
              subtitle={`已交付 ${data?.deliverables?.delivered ?? 0}/${data?.deliverables?.total ?? 0} · 待交付 ${data?.deliverables?.pending ?? 0} · 已基线 ${data?.deliverables?.baselined ?? 0}`}
              segments={deliverableSegments}
              centerValue={`${deliveredRate}%`}
              centerLabel="已交付率"
              loading={loading}
              empty={(data?.deliverables?.total ?? 0) === 0}
              emptyTitle="暂无交付物"
              emptyDescription="范围内项目尚未登记交付物"
              onSegmentClick={(seg) => openDeliverables(seg.id)}
            />
          </Box>
        </SectionCard>
      </Box>

      {/* ══ D01 · 上周工作进展面板（周报动态 / 任务进展 / 达成里程碑，周例会场景） ══ */}
      <Box ref={weeklyRef}>
        <WeeklyProgressPanel data={data?.weeklyProgress} loading={loading} />
      </Box>

      <OwnerLoadDrawer open={drawerOpen} row={drawerRow} onClose={() => setDrawerOpen(false)} />
      {/* B18：分布图点档下探任务明细抽屉（受控组件，query 存 state 保证身份稳定） */}
      <DistributionTaskDrawer
        open={distDrawer.open}
        title={distDrawer.title}
        query={distDrawer.query}
        onClose={() => setDistDrawer((s) => ({ ...s, open: false }))}
      />
      {/* 第二批：质量与交付下探抽屉（门控 / 交付物明细） */}
      <GateDetailDrawer
        open={gateDrawer.open}
        title={gateDrawer.title}
        query={gateDrawer.query}
        onClose={() => setGateDrawer((s) => ({ ...s, open: false }))}
      />
      <DeliverableDetailDrawer
        open={delivDrawer.open}
        title={delivDrawer.title}
        query={delivDrawer.query}
        onClose={() => setDelivDrawer((s) => ({ ...s, open: false }))}
      />
      {/* B12：周报闭环率下钻（逐项目明细，数据来自 overview.reportClosureItems） */}
      <ReportClosureListDrawer
        open={closureOpen}
        items={data?.reportClosureItems ?? []}
        onClose={() => setClosureOpen(false)}
      />
    </Box>
  );
}
