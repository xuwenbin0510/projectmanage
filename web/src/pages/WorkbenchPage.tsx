import { useCallback, useMemo, useState, useRef } from 'react';
import type { ReactNode } from 'react';
import {
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import EditNoteOutlinedIcon from '@mui/icons-material/EditNoteOutlined';
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import AssignmentLateOutlinedIcon from '@mui/icons-material/AssignmentLateOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';

import {
  EmptyState,
  ErrorState,
  HealthDot,
  LoadingState,
  PageHeader,
  ProgressBar,
  SectionCard,
  StatCard,
  StatusChip,
} from '@/components/common';
import { ReviewStepper } from '@/components/review/ReviewStepper';
import {
  HealthDistBar,
  MyTasksDrawer,
  ProgressDonut,
  PriorityDonut,
  OverdueTaskDrawer,
  DeliverableDetailDrawer,
  ReportClosureDrawer,
  GateDetailDrawer,
  TaskTimeRow,
} from '@/components/dashboard';
import { api } from '@/api/client';
import { useAsync } from '@/hooks';
import { ROUTES } from '@/config/routes';
import { PROJECT_TYPE_SHORT } from '@/config/enums';
import type { ProgressSegment } from '@/types/dashboard';
import type { Priority, WbsNode } from '@/types/wbs';
import { buildDashboard, sortByPriority } from '@/utils/dashboardAgg';
import { fmtDate, isOverdue, today, diffDays } from '@/utils/date';
import { alphaOf as alpha, tokens } from '@/theme/tokens';

/**
 * 我的工作台布局：
 *   ┌ 数据总览（顶部一条连续 KPI 带，按主题重排顺序：任务类 → 周报类 → 审批类）
 *   ├ 【我的任务】  任务进度环 / 优先级环 → 时间轴(逾期/临期/计划周期内) → 我的项目 + 项目健康度
 *   ├ 【周报】      待我确认周报 / 周报提醒
 *   └ 【审批与决议】待我审批(列表) / 门控待办
 *
 * 顶部 8 个小面板保持一条连续「数据总览」带、只重排顺序；下面的大面板才按三大主题分组呈现。
 *
 * B11 增量：图表区由 `buildDashboard(data)` 纯前端聚合（不新增后端接口）。
 *
 * @prd P0-13 / B11
 */

/** 比率着色（与全局总览 MetricsPage 同源口径：≥100 成功 / ≥60 警告 / 否则危险） */
function rateTone(rate?: number): 'success' | 'warning' | 'danger' {
  const r = rate ?? 0;
  if (r >= 100) return 'success';
  if (r >= 60) return 'warning';
  return 'danger';
}

/** 业务主题分隔标题（下面的“大面板”按同一主题分组，跨主题用分隔线切） */
function SectionTitle({
  icon,
  children,
}: {
  icon?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2.5, mb: 1.5 }}>
      {icon && (
        <Box sx={{ color: tokens.brand.primary, display: 'grid', placeItems: 'center' }}>{icon}</Box>
      )}
      <Typography variant="h6" sx={{ fontSize: 16, fontWeight: 700 }}>
        {children}
      </Typography>
      <Box sx={{ flex: 1, height: 1, bgcolor: tokens.border.subtle, ml: 1 }} />
    </Stack>
  );
}

export function WorkbenchPage(): JSX.Element {
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.user);
  /* B13：逾期/临期下探抽屉的本地状态（受控组件，props 自包含）；B15 追加 mode */
  const [ovDrawer, setOvDrawer] = useState<{
    open: boolean;
    mode: 'project' | 'all';
    projectId: string;
    projectName: string;
  }>({ open: false, mode: 'project', projectId: '', projectName: '' });

  /* B15：我的任务明细抽屉的本地状态（三入口共用，打开时带初始筛选） */
  const [myTasksDrawer, setMyTasksDrawer] = useState<{
    open: boolean;
    progress?: ProgressSegment;
    priority?: Priority;
  }>({ open: false });
  /* Q1：周报提醒命中任务展开态（projectId → 是否展开全部） */
  const [reminderExpanded, setReminderExpanded] = useState<Record<string, boolean>>({});
  /* 我的任务明细抽屉的当前数据源（默认合并已完成；按筛选下探时替换为对应子集） */
  const [drawerTasks, setDrawerTasks] = useState<WbsNode[]>([]);

  /* 工作台快捷卡：交付物明细抽屉 */
  const [deliverableDrawerOpen, setDeliverableDrawerOpen] = useState(false);
  /* 工作台快捷卡：周报闭环下钻抽屉（feat/workbench-cards-fix，不再跳全局总览） */
  const [closureDrawerOpen, setClosureDrawerOpen] = useState(false);
  /* D-修复：待决议质量门下钻抽屉（不再跳数据总览，改看与我相关的待决议门列表） */
  const [gateDrawer, setGateDrawer] = useState<{ open: boolean; title: string }>({
    open: false,
    title: '待决议质量门明细',
  });

  /* D11-修复：多份待填周报时，点击指标卡滚动到「周报提醒」区块逐项目填写 */
  const reportRemindersRef = useRef<HTMLDivElement>(null);

  const fetcher = useCallback(() => api.getWorkbench(), []);
  const { data, loading, error, run } = useAsync(fetcher, []);

  /* B11：仪表盘聚合。必须在任何早退之前调用，保证 Hooks 顺序稳定 */
  const dashboard = useMemo(() => buildDashboard(data), [data]);

  /* D10：门控待办（我有决议权限的未决议门） */
  const gateTodos = data?.gateTodos ?? [];

  /**
   * B14-块1：「我的任务」按**优先级升序（P0 置顶）**、同级按截止日升序。
   * 排序口径唯一实现 `dashboardAgg#comparePriority`（`sortByPriority` 不改原数组），
   * 必须在早退之前调用以保证 Hooks 顺序稳定。
   */
  const sortedTasks = useMemo(() => sortByPriority(data?.myTasks ?? []), [data]);

  /* Q4：已完成任务（供进度环「已完成」段下钻，与 sortedTasks 合并入抽屉） */
  const completedTasks = useMemo(() => data?.completedTasks ?? [], [data]);
  const allMyTasks = useMemo(() => [...sortedTasks, ...completedTasks], [sortedTasks, completedTasks]);

  /* 时间轴三栏的数据源（均取我名下未完成叶子，按截止日单一真源切分，三栏零重叠） */
  const overdueTasks = useMemo(
    () =>
      (data?.myTasks ?? [])
        .filter((t) => !!t.dueDate && isOverdue(t.dueDate))
        .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')),
    [data],
  );
  const soonTasks = useMemo(
    () =>
      (data?.myTasks ?? [])
        .filter((t) => !!t.dueDate && !isOverdue(t.dueDate) && diffDays(today(), t.dueDate) <= 3)
        .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')),
    [data],
  );
  /* Q2：计划周期内的任务（干净边界：距今天截止日 d，4 ≤ d ≤ 14；与临期 0–3 天、逾期 <0 零重叠） */
  const cycleTasks = useMemo(() => {
    const list = data?.myCycleTasks ?? [];
    return list
      .filter((t) => !!t.dueDate)
      .map((t) => ({ t, d: diffDays(today(), t.dueDate) }))
      .filter(({ d }) => d >= 4 && d <= 14)
      .sort((a, b) => a.d - b.d)
      .map(({ t }) => t);
  }, [data]);

  /** B13：打开逾期/临期任务下探抽屉（projectName 从本地 dashboard.overdue 解析；B15 补 mode） */
  const openOverdue = (projectId: string): void => {
    const name = dashboard.overdue.find((o) => o.projectId === projectId)?.projectName ?? '';
    setOvDrawer({ open: true, mode: 'project', projectId, projectName: name });
  };

  /** B15：逾期任务 StatCard → 全局逾期抽屉（项目清单 = dashboard.overdue） */
  const openGlobalOverdue = (): void => {
    setOvDrawer({ open: true, mode: 'all', projectId: '', projectName: '' });
  };

  /** B15：打开我的任务明细抽屉（opts 为空 = 查看全部；可带进度段 / 优先级初始筛选） */
  const openMyTasks = (
    opts: { progress?: ProgressSegment; priority?: Priority } = {},
    tasksOverride?: WbsNode[],
  ): void => {
    setDrawerTasks(tasksOverride ?? allMyTasks);
    setMyTasksDrawer({ open: true, progress: opts.progress, priority: opts.priority });
  };

  if (loading && !data) return <LoadingState variant="card" rows={3} />;
  if (error && !data) return <ErrorState error={error} onRetry={() => void run()} />;
  if (!data) return <EmptyState title="暂无工作台数据" />;

  const { stats, myProjects, myApprovals, reportReminders } = data;
  const deliverableRate =
    data.deliverables && data.deliverables.total
      ? Math.round((data.deliverables.delivered / data.deliverables.total) * 100)
      : 0;
  const missing = reportReminders.filter((r) => !r.filled);

  return (
    <Box>
      <PageHeader
        title="我的工作台"
        subtitle={`${today()} · 一屏看清：谁在等我、我该做什么、哪些要逾期`}
        actions={
          <Button variant="outlined" size="small" onClick={() => void run()}>
            刷新
          </Button>
        }
      />

      {/* ══ 数据总览：顶部一条连续的 8 个小面板，按主题重排顺序（任务类 → 周报类 → 审批类） ══ */}
      <SectionTitle icon={<Inventory2OutlinedIcon fontSize="small" />}>数据总览</SectionTitle>
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' },
          mb: 2.5,
        }}
      >
        {/* —— 任务类 —— */}
        <StatCard
          label="我参与的项目"
          value={myProjects.length}
          unit="个"
          tone="brand"
          hint="点击查看全部项目"
          icon={<FolderOutlinedIcon fontSize="small" />}
          onClick={() => navigate(ROUTES.projects)}
        />
        <StatCard
          label="逾期任务"
          value={stats.overdueTasks}
          unit="个"
          tone={stats.overdueTasks > 0 ? 'danger' : 'success'}
          hint="点击查看全部逾期任务"
          icon={<ReportProblemOutlinedIcon fontSize="small" />}
          onClick={openGlobalOverdue}
        />
        <StatCard
          label="已完成任务"
          value={completedTasks.length}
          unit="个"
          tone="success"
          hint="本期已完成的任务"
          icon={<CheckCircleOutlinedIcon fontSize="small" />}
          onClick={() => openMyTasks({}, completedTasks)}
        />
        {/* 交付物已交付率：大数字 + 细分 + 堆叠条 */}
        <Paper
          variant="outlined"
          onClick={() => setDeliverableDrawerOpen(true)}
          sx={{
            p: 2.25,
            cursor: 'pointer',
            transition: 'border-color .18s, transform .18s',
            '&:hover': { borderColor: alpha(tokens.brand.primary, 0.65), transform: 'translateY(-2px)' },
          }}
        >
          <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary">
                交付物已交付率
              </Typography>
              <Stack direction="row" alignItems="baseline" spacing={0.5} sx={{ mt: 0.5 }}>
                <Typography
                  sx={{ fontSize: 30, fontWeight: 600, lineHeight: 1.1, color: tokens.status.success }}
                >
                  {deliverableRate}
                </Typography>
                <Typography variant="body2" color="text.secondary">%</Typography>
              </Stack>
            </Box>
            <Box
              sx={{
                width: 38, height: 38, borderRadius: 1.5, display: 'grid', placeItems: 'center',
                bgcolor: alpha(tokens.status.success, 0.14), color: tokens.status.success,
              }}
            >
              <Inventory2OutlinedIcon fontSize="small" />
            </Box>
          </Stack>

          {(() => {
            const total = data.deliverables?.total ?? 0;
            const delivered = data.deliverables?.delivered ?? 0;
            const pending = data.deliverables?.pending ?? 0;
            const baseRate = total ? Math.round((delivered / total) * 100) : 0;
            return (
              <Box sx={{ mt: 1 }}>
                {/* 堆叠条：已交付绿 / 待交付红 */}
                <Box
                  sx={{
                    display: 'flex', height: 8, borderRadius: 1.5, overflow: 'hidden',
                    bgcolor: alpha(tokens.status.danger, 0.18),
                  }}
                >
                  <Box sx={{ width: `${baseRate}%`, bgcolor: tokens.status.success, transition: 'width .3s' }} />
                </Box>
                <Stack direction="row" spacing={1.5} sx={{ mt: 1, flexWrap: 'wrap' }}>
                  <Typography variant="caption" sx={{ color: tokens.status.success, fontWeight: 600 }}>
                    已交付 {delivered}
                  </Typography>
                  <Typography variant="caption" sx={{ color: tokens.status.danger, fontWeight: 600 }}>
                    待交付 {pending}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    需交付 {total}
                  </Typography>
                </Stack>
              </Box>
            );
          })()}
        </Paper>

        {/* —— 周报类 —— */}
        <StatCard
          label="本周待填周报"
          value={stats.missingReports}
          unit="份"
          tone={stats.missingReports > 0 ? 'warning' : 'success'}
          hint={missing.length > 0 ? (missing.length > 1 ? `还有 ${missing.length} 份待填，点击查看` : '点击前往填写') : '本周周报已全部填写'}
          icon={<EditNoteOutlinedIcon fontSize="small" />}
          onClick={() => {
            if (missing.length === 1) {
              navigate(ROUTES.projectReports(missing[0].projectId));
            } else if (missing.length > 1) {
              /* 多份待填：跳到「周报提醒」区块，每行各自「去填写」覆盖全部项目 */
              reportRemindersRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }}
        />
        <StatCard
          label="周报闭环率"
          value={data.reportClosure?.closureRate ?? 0}
          unit="%"
          tone={rateTone(data.reportClosure?.closureRate)}
          hint={`待确认 ${data.reportClosure?.submitted ?? 0} · 已确认 ${data.reportClosure?.confirmed ?? 0}`}
          icon={<AssignmentLateOutlinedIcon fontSize="small" />}
          onClick={() => setClosureDrawerOpen(true)}
        />

        {/* —— 审批决议类 —— */}
        <StatCard
          label="待我审批"
          value={stats.pendingApprovals}
          unit="项"
          tone={stats.pendingApprovals > 0 ? 'warning' : 'success'}
          hint="点击进入审批中心"
          icon={<FactCheckOutlinedIcon fontSize="small" />}
          onClick={() => navigate(ROUTES.approvals)}
        />
        {/* D11：待决议质量门（= gateTodos.length，点击下钻待决议门列表，不再跳数据总览） */}
        <StatCard
          label="待决议质量门"
          value={stats.pendingGates}
          unit="道"
          tone={stats.pendingGates > 0 ? 'warning' : 'success'}
          hint="点击查看待决议门"
          icon={<VerifiedOutlinedIcon fontSize="small" />}
          onClick={() => setGateDrawer({ open: true, title: '待决议质量门明细' })}
        />
      </Box>

      {/* ══ 模块一：我的任务（大面板按主题分组） ══ */}
      <SectionTitle icon={<FolderOutlinedIcon fontSize="small" />}>我的任务</SectionTitle>

      {/* 图表：任务进度 / 优先级（纯前端聚合） */}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' },
          alignItems: 'stretch',
          mb: 2.5,
        }}
      >
        <ProgressDonut
          summary={dashboard.progress}
          loading={loading}
          onDrill={(seg) => openMyTasks({ progress: seg }, allMyTasks)}
        />
        {/* B14-块1：优先级分布环，点段下钻我的任务明细（B15：带优先级筛选） */}
        <PriorityDonut
          dist={dashboard.priority}
          loading={loading}
          onDrill={(pri) => openMyTasks({ priority: pri }, allMyTasks)}
        />
      </Box>

      {/* 时间轴：逾期 / 临期 / 计划周期内（三栏同格式并列） */}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' },
          mb: 2.5,
        }}
      >
        {/* 逾期任务（d < 0） */}
        <SectionCard
          title="逾期任务"
          subtitle={`${overdueTasks.length} 个 · 已超截止日`}
          actions={
            overdueTasks.length > 0 ? (
              <Button size="small" onClick={openGlobalOverdue}>
                查看全部
              </Button>
            ) : undefined
          }
        >
          {overdueTasks.length === 0 ? (
            <EmptyState title="没有逾期任务" dense />
          ) : (
            <Stack spacing={1}>
              {overdueTasks.slice(0, 8).map((t) => (
                <TaskTimeRow
                  key={t.id}
                  task={t}
                  hint={`截止 ${fmtDate(t.dueDate)} · 已逾期 ${-diffDays(today(), t.dueDate)} 天`}
                  onClick={() => navigate(ROUTES.projectWbs(t.projectId) + '?taskId=' + t.id)}
                />
              ))}
            </Stack>
          )}
        </SectionCard>

        {/* 临期任务（0 ≤ d ≤ 3） */}
        <SectionCard
          title="临期任务"
          subtitle={`${soonTasks.length} 个 · 3 天内到期`}
          actions={
            soonTasks.length > 0 ? (
              <Button size="small" onClick={() => openMyTasks({}, soonTasks)}>
                查看全部
              </Button>
            ) : undefined
          }
        >
          {soonTasks.length === 0 ? (
            <EmptyState title="未来 3 天没有临期任务" dense />
          ) : (
            <Stack spacing={1}>
              {soonTasks.slice(0, 8).map((t) => (
                <TaskTimeRow
                  key={t.id}
                  task={t}
                  hint={`截止 ${fmtDate(t.dueDate)} · 临期 · 还有 ${diffDays(today(), t.dueDate)} 天`}
                  onClick={() => navigate(ROUTES.projectWbs(t.projectId) + '?taskId=' + t.id)}
                />
              ))}
            </Stack>
          )}
        </SectionCard>

        {/* 计划周期内的任务（4 ≤ d ≤ 14） */}
        <SectionCard
          title="计划周期内的任务"
          subtitle={`${cycleTasks.length} 个 · 未来 4–14 天到期`}
          actions={
            cycleTasks.length > 0 ? (
              <Button size="small" onClick={() => openMyTasks({}, cycleTasks)}>
                查看全部
              </Button>
            ) : undefined
          }
        >
          {cycleTasks.length === 0 ? (
            <EmptyState title="未来两周内没有即将到期的任务" dense />
          ) : (
            <Stack spacing={1}>
              {cycleTasks.slice(0, 8).map((t) => {
                const d = diffDays(today(), t.dueDate);
                return (
                  <TaskTimeRow
                    key={t.id}
                    task={t}
                    hint={`截止 ${fmtDate(t.dueDate)} · 还有 ${d} 天`}
                    onClick={() => navigate(ROUTES.projectWbs(t.projectId) + '?taskId=' + t.id)}
                  />
                );
              })}
            </Stack>
          )}
        </SectionCard>
      </Box>

      {/* 我的项目 + 项目健康度（项目维度，并排） */}
      <Box
        sx={{
          display: 'grid',
          gap: 2.5,
          gridTemplateColumns: { xs: '1fr', lg: '1.35fr 1fr' },
          mb: 2.5,
        }}
      >
        {/* ── 我的项目 ── */}
        <SectionCard
          title="我的项目"
          subtitle={`${myProjects.length} 个在办`}
          actions={
            <Button size="small" onClick={() => navigate(ROUTES.projects)}>
              全部项目
            </Button>
          }
        >
          {myProjects.length === 0 ? (
            <EmptyState title="暂未参与任何在办项目" dense />
          ) : (
            <Stack spacing={1.25}>
              {myProjects.map((p) => (
                <Paper
                  key={p.id}
                  variant="outlined"
                  onClick={() => navigate(ROUTES.projectOverview(p.id))}
                  sx={{ p: 1.5, cursor: 'pointer', '&:hover': { borderColor: alpha(tokens.brand.primary, 0.6) } }}
                >
                  <Stack direction="row" justifyContent="space-between" spacing={1} alignItems="center">
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                      <HealthDot health={p.health} />
                      <Typography sx={{ fontSize: 14, fontWeight: 600 }} noWrap>
                        {p.name}
                      </Typography>
                      <Chip size="small" label={PROJECT_TYPE_SHORT[p.type]} variant="outlined" sx={{ height: 20 }} />
                    </Stack>
                    <StatusChip status={p.status} />
                  </Stack>
                  <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 1 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ minWidth: 0 }} noWrap>
                      {p.nextMilestoneCode ? `${p.nextMilestoneCode} ${p.nextMilestoneName}` : '里程碑已全部达成'}
                      {` · 已过 ${p.gatePassed}/${p.gateTotal} 道门`}
                    </Typography>
                    <ProgressBar value={p.progress} tone={p.health === 'red' ? 'danger' : 'brand'} />
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}
        </SectionCard>

        {/* ── 项目健康度（紧贴我的项目） ── */}
        <SectionCard title="项目健康度" subtitle={`${myProjects.length} 个项目的健康分布`}>
          <HealthDistBar dist={dashboard.health} loading={loading} onDrill={() => navigate(ROUTES.projects)} />
        </SectionCard>
      </Box>

      {/* ══ 模块二：周报 ══ */}
      <SectionTitle icon={<EditNoteOutlinedIcon fontSize="small" />}>周报</SectionTitle>

      {/* 面板：待我确认周报 / 周报提醒 */}
      <Box
        sx={{
          display: 'grid',
          gap: 2.5,
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' },
          mb: 2.5,
        }}
      >
        {/* ── 待我确认周报（D11：我是确认人的已提交周报，点击进项目周报确认） ── */}
        <SectionCard
          title="待我确认周报"
          subtitle={`${(data?.reportConfirmations ?? []).length} 份待确认`}
        >
          {(data?.reportConfirmations ?? []).length === 0 ? (
            <EmptyState title="没有待我确认的周报" description="已提交的周报都已确认完毕" dense />
          ) : (
            <Stack spacing={1}>
              {(data?.reportConfirmations ?? []).slice(0, 5).map((c) => (
                <Paper
                  key={c.id}
                  variant="outlined"
                  onClick={() => navigate(ROUTES.projectReports(c.projectId))}
                  sx={{
                    p: 1.5,
                    cursor: 'pointer',
                    '&:hover': { borderColor: alpha(tokens.brand.primary, 0.6) },
                  }}
                >
                  <Stack direction="row" justifyContent="space-between" spacing={1} alignItems="flex-start">
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ fontSize: 14, fontWeight: 600 }} noWrap>
                        {c.projectName}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {c.week} · 报告人 {c.authorName}
                      </Typography>
                    </Box>
                    <Chip
                      size="small"
                      label="待确认"
                      sx={{ height: 20, fontSize: 11, bgcolor: 'warning.main', color: '#fff', fontWeight: 700 }}
                    />
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}
        </SectionCard>

        {/* ── 周报提醒 ── */}
        <Box ref={reportRemindersRef}>
          <SectionCard title="周报提醒" subtitle={reportReminders[0]?.week ?? ''}>
            {reportReminders.length === 0 ? (
              <EmptyState title="暂无需要填报的项目" dense />
            ) : (
              <Stack spacing={1}>
                {reportReminders.map((r) => (
                  <Box key={r.projectId}>
                    <Stack
                      direction="row"
                      alignItems="center"
                      justifyContent="space-between"
                      spacing={1}
                      sx={{
                        px: 1.5,
                        py: 1.25,
                        borderRadius: 1.5,
                        border: `1px solid ${
                          r.state === '待填'
                            ? alpha(tokens.status.warning, 0.5)
                            : r.state === '待确认'
                              ? alpha(tokens.brand.primary, 0.5)
                              : tokens.border.subtle
                        }`,
                        bgcolor:
                          r.state === '待填'
                            ? alpha(tokens.status.warning, 0.08)
                            : r.state === '待确认'
                              ? alpha(tokens.brand.primary, 0.08)
                              : 'transparent',
                      }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Stack direction="row" spacing={0.75} alignItems="center">
                          {r.state === '待填' && (
                            <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: tokens.status.danger, flexShrink: 0 }} />
                          )}
                          {r.state === '待确认' && (
                            <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: tokens.brand.primary, flexShrink: 0 }} />
                          )}
                          {r.state === '待他人确认' && (
                            <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: tokens.text.secondary, flexShrink: 0 }} />
                          )}
                          {r.state === '已确认' && (
                            <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: tokens.status.success, flexShrink: 0 }} />
                          )}
                          <Typography sx={{ fontSize: 13.5 }} noWrap>
                            {r.projectName}
                          </Typography>
                        </Stack>
                        <Typography variant="caption" color="text.secondary">
                          {r.weekStart} ~ {r.weekEnd}
                        </Typography>
                      </Box>
                      <Button
                        size="small"
                        variant={r.state === '待填' || r.state === '待确认' ? 'contained' : 'text'}
                        disabled={r.state === '待他人确认' || r.state === '已确认'}
                        onClick={() => {
                          if (r.state === '待填' || r.state === '待确认') navigate(ROUTES.projectReports(r.projectId));
                        }}
                      >
                        {r.state === '待填' ? '去填写' : r.state === '待确认' ? '去确认' : r.state}
                      </Button>
                    </Stack>
                    {/* Q1：命中任务下钻（本周计划窗口内、我名下未完成的任务） */}
                    {r.tasks && r.tasks.length > 0 && (
                      <Box sx={{ px: 1.5, pb: 1 }}>
                        {(reminderExpanded[r.projectId] ? r.tasks : r.tasks.slice(0, 3)).map((t) => {
                          const od = isOverdue(t.dueDate);
                          const soon = !od && diffDays(today(), t.dueDate) <= 3 && !!t.dueDate;
                          return (
                            <Stack
                              key={t.id}
                              direction="row"
                              spacing={1}
                              justifyContent="space-between"
                              alignItems="center"
                              sx={{ py: 0.75, pl: 1, borderTop: `1px dashed ${tokens.border.subtle}` }}
                            >
                              <Box sx={{ minWidth: 0 }}>
                                <Typography sx={{ fontSize: 12.5 }} noWrap>
                                  {t.wbsCode} {t.name}
                                </Typography>
                                <Typography
                                  variant="caption"
                                  color={od ? 'error.main' : soon ? 'warning.main' : 'text.secondary'}
                                >
                                  {t.dueDate ? `截止 ${fmtDate(t.dueDate)}${od ? ' · 已逾期' : soon ? ' · 临期' : ''}` : '无计划日期'}
                                </Typography>
                              </Box>
                              <ProgressBar value={t.progress} tone={od ? 'danger' : 'brand'} sx={{ width: 76, flexShrink: 0 }} />
                            </Stack>
                          );
                        })}
                        {r.tasks.length > 3 && (
                          <Button
                            size="small"
                            sx={{ mt: 0.5 }}
                            onClick={() => setReminderExpanded((e) => ({ ...e, [r.projectId]: !e[r.projectId] }))}
                          >
                            {reminderExpanded[r.projectId] ? '收起' : `展开全部 ${r.tasks.length} 条`}
                          </Button>
                        )}
                      </Box>
                    )}
                  </Box>
                ))}
                {missing.length > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    还有 {missing.length} 个项目本周未提交周报。
                  </Typography>
                )}
              </Stack>
            )}
          </SectionCard>
        </Box>
      </Box>

      {/* ══ 模块三：审批与决议 ══ */}
      <SectionTitle icon={<FactCheckOutlinedIcon fontSize="small" />}>审批与决议</SectionTitle>

      {/* 面板：待我审批(列表) / 门控待办 */}
      <Box
        sx={{
          display: 'grid',
          gap: 2.5,
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' },
        }}
      >
        {/* ── 待我审批（列表） ── */}
        <SectionCard
          title="待我审批"
          subtitle={`${myApprovals.length} 条`}
          actions={
            myApprovals.length > 0 ? (
              <Button size="small" onClick={() => navigate(ROUTES.approvals)}>
                全部处理
              </Button>
            ) : undefined
          }
        >
          {myApprovals.length === 0 ? (
            <EmptyState title="没有待办审批" description="所有流程都已处理完毕" dense />
          ) : (
            <Stack spacing={1.25}>
              {myApprovals.slice(0, 5).map((r) => (
                <Paper
                  key={r.id}
                  variant="outlined"
                  onClick={() => navigate(ROUTES.approvals)}
                  sx={{
                    p: 1.5,
                    cursor: 'pointer',
                    '&:hover': { borderColor: alpha(tokens.brand.primary, 0.6) },
                  }}
                >
                  <Stack direction="row" justifyContent="space-between" spacing={1} alignItems="flex-start">
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ fontSize: 14, fontWeight: 600 }} noWrap>
                        {r.title}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {r.projectName} · 发起人 {r.initiatorName}
                      </Typography>
                    </Box>
                    <StatusChip status={r.status} />
                  </Stack>
                  <Box sx={{ mt: 1 }}>
                    <ReviewStepper review={r} dense />
                  </Box>
                </Paper>
              ))}
            </Stack>
          )}
        </SectionCard>

        {/* ── 门控待办（D10：我有决议权限的未决议门，点击下钻列表 / 单条跳项目概览） ── */}
        <SectionCard
          title="门控待办"
          subtitle={`${gateTodos.length} 道门待决议`}
          actions={
            gateTodos.length > 0 ? (
              <Button size="small" onClick={() => setGateDrawer({ open: true, title: '待决议质量门明细' })}>
                查看全部
              </Button>
            ) : undefined
          }
        >
          {gateTodos.length === 0 ? (
            <EmptyState title="没有待决议的质量门" description="有门里程碑到达决议时机时会出现在这里" dense />
          ) : (
            <Stack spacing={1}>
              {gateTodos.slice(0, 5).map((g) => (
                <Paper
                  key={g.gateId}
                  variant="outlined"
                  onClick={() => navigate(ROUTES.projectOverview(g.projectId))}
                  sx={{
                    p: 1.5,
                    cursor: 'pointer',
                    '&:hover': { borderColor: alpha(tokens.brand.primary, 0.6) },
                  }}
                >
                  <Stack direction="row" justifyContent="space-between" spacing={1} alignItems="flex-start">
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ fontSize: 14, fontWeight: 600 }} noWrap>
                        {g.gateCode} {g.gateName}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {g.projectName} · {g.milestoneCode} {g.milestoneName}
                      </Typography>
                    </Box>
                    <Chip size="small" label={`责任 ${g.ownerRole.toUpperCase()}`} variant="outlined" sx={{ height: 20, fontSize: 11 }} />
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}
        </SectionCard>
      </Box>

      <OverdueTaskDrawer
        open={ovDrawer.open}
        mode={ovDrawer.mode}
        projectId={ovDrawer.projectId}
        projectName={ovDrawer.projectName}
        projects={dashboard.overdue}
        currentUserId={me?.openId}
        /* D09：工作台入口固定「我的叶子任务」口径（与逾期 StatCard 数字一致） */
        scopeMineOnly
        onClose={() => setOvDrawer((s) => ({ ...s, open: false }))}
      />
      <MyTasksDrawer
        open={myTasksDrawer.open}
        tasks={drawerTasks.length ? drawerTasks : allMyTasks}
        initialProgress={myTasksDrawer.progress}
        initialPriority={myTasksDrawer.priority}
        onClose={() => setMyTasksDrawer((s) => ({ ...s, open: false }))}
      />
      <DeliverableDetailDrawer
        open={deliverableDrawerOpen}
        title="交付物明细（我参与的项目）"
        query={{}}
        projectIds={(data?.myProjects ?? []).map((p) => p.id)}
        onClose={() => setDeliverableDrawerOpen(false)}
      />
      <ReportClosureDrawer
        open={closureDrawerOpen}
        onClose={() => setClosureDrawerOpen(false)}
      />
      <GateDetailDrawer
        open={gateDrawer.open}
        title={gateDrawer.title}
        query={{ gateStatus: '待检查' }}
        onClose={() => setGateDrawer((s) => ({ ...s, open: false }))}
      />
    </Box>
  );
}
