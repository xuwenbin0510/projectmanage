import { useCallback, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import EditNoteOutlinedIcon from '@mui/icons-material/EditNoteOutlined';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';

import {
  EmptyState,
  ErrorState,
  HealthDot,
  LoadingState,
  PageHeader,
  PriorityChip,
  ProgressBar,
  SectionCard,
  StatCard,
  StatusChip,
} from '@/components/common';
import { ReviewStepper } from '@/components/review/ReviewStepper';
import {
  HealthDistBar,
  MyTasksDrawer,
  OverdueBarChart,
  PriorityDonut,
  ProgressDonut,
  OverdueTaskDrawer,
} from '@/components/dashboard';
import { api } from '@/api/client';
import { useAsync, useToast } from '@/hooks';
import { ROUTES } from '@/config/routes';
import { PROJECT_TYPE_SHORT, TASK_STATUSES } from '@/config/enums';
import type { ProgressSegment } from '@/types/dashboard';
import type { Priority, TaskStatus } from '@/types/wbs';
import { buildDashboard, sortByPriority } from '@/utils/dashboardAgg';
import { fmtDate, isOverdue, today, diffDays } from '@/utils/date';
import { alphaOf as alpha, tokens, colorOf } from '@/theme/tokens';

/**
 * 我的工作台：仪表盘三图 + 待办审批 / 我的任务 / 我的项目 / 周报提醒
 *
 * B11 增量：在 3 张 `StatCard` 与既有 4 区块之间插入「图表区」，
 * 数据由 `buildDashboard(data)` **纯前端聚合**（§1.3，不新增后端接口）。
 * 既有 4 区块与全部交互零改动。
 *
 * @prd P0-13 / B11
 */
export function WorkbenchPage(): JSX.Element {
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.user);
  const toast = useToast();
  const [busyTask, setBusyTask] = useState<string>('');

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
  const openMyTasks = (opts: { progress?: ProgressSegment; priority?: Priority } = {}): void => {
    setMyTasksDrawer({ open: true, progress: opts.progress, priority: opts.priority });
  };

  /** 直接在工作台改任务状态（移动端四件事之一，走 moveTask 以保留 WIP 拦截） */
  const handleStatus = async (nodeId: string, status: TaskStatus, order: number): Promise<void> => {
    setBusyTask(nodeId);
    try {
      await api.moveTask(nodeId, status, order);
      toast.success('任务状态已更新');
      await run();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusyTask('');
    }
  };

  if (loading && !data) return <LoadingState variant="card" rows={3} />;
  if (error && !data) return <ErrorState error={error} onRetry={() => void run()} />;
  if (!data) return <EmptyState title="暂无工作台数据" />;

  const { stats, myProjects, myTasks, myApprovals, reportReminders } = data;
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

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' },
          mb: 2.5,
        }}
      >
        <StatCard
          label="待我审批"
          value={stats.pendingApprovals}
          unit="项"
          tone={stats.pendingApprovals > 0 ? 'warning' : 'success'}
          hint="点击进入审批中心"
          icon={<FactCheckOutlinedIcon fontSize="small" />}
          onClick={() => navigate(ROUTES.approvals)}
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
          label="本周待填周报"
          value={stats.missingReports}
          unit="份"
          tone={stats.missingReports > 0 ? 'warning' : 'success'}
          hint={missing.length > 0 ? '点击前往填写' : '本周周报已全部填写'}
          icon={<EditNoteOutlinedIcon fontSize="small" />}
          onClick={() => {
            if (missing.length > 0) navigate(ROUTES.projectReports(missing[0].projectId));
          }}
        />
      </Box>

      {/* ══ B11 · 仪表盘图表区（B14 追加优先级环 → 四图，栅格 xs:1 / md:2 / xl:4） ══ */}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: {
            xs: '1fr',
            md: 'repeat(2, 1fr)',
            xl: 'repeat(4, 1fr)',
          },
          alignItems: 'stretch',
          mb: 2.5,
        }}
      >
        <ProgressDonut
          summary={dashboard.progress}
          loading={loading}
          onDrill={(seg) => openMyTasks({ progress: seg })}
        />
        {/* B14-块1：优先级分布环，点段下钻我的任务明细（B15：带优先级筛选） */}
        <PriorityDonut
          dist={dashboard.priority}
          loading={loading}
          onDrill={(pri) => openMyTasks({ priority: pri })}
        />
        <OverdueBarChart rows={dashboard.overdue} loading={loading} onDrill={openOverdue} />
        <HealthDistBar
          dist={dashboard.health}
          loading={loading}
          onDrill={() => navigate(ROUTES.projects)}
        />
      </Box>

      <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', lg: '1.35fr 1fr' } }}>
        {/* ── 我的待办审批 ── */}
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

        {/* ── 周报提醒 ── */}
        <SectionCard title="周报提醒" subtitle={reportReminders[0]?.week ?? ''}>
          {reportReminders.length === 0 ? (
            <EmptyState title="暂无需要填报的项目" dense />
          ) : (
            <Stack spacing={1}>
              {reportReminders.map((r) => (
                <Stack
                  key={r.projectId}
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  spacing={1}
                  sx={{
                    px: 1.5,
                    py: 1.25,
                    borderRadius: 1.5,
                    border: `1px solid ${r.filled ? tokens.border.subtle : alpha(tokens.status.warning, 0.5)}`,
                    bgcolor: r.filled ? 'transparent' : alpha(tokens.status.warning, 0.08),
                  }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      {!r.filled && (
                        <Box
                          sx={{
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            bgcolor: tokens.status.danger,
                            flexShrink: 0,
                          }}
                        />
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
                    variant={r.filled ? 'text' : 'contained'}
                    onClick={() => navigate(ROUTES.projectReports(r.projectId))}
                  >
                    {r.filled ? '已填写' : '去填写'}
                  </Button>
                </Stack>
              ))}
              {missing.length > 0 && (
                <Typography variant="caption" color="text.secondary">
                  还有 {missing.length} 个项目本周未提交周报。
                </Typography>
              )}
            </Stack>
          )}
        </SectionCard>

        {/* ── 门控待办（D10：我有决议权限的未决议门，点击跳项目概览门区） ── */}
        <SectionCard title="门控待办" subtitle={`${gateTodos.length} 道门待决议`}>
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

        {/* ── 我的任务（B14-块1：P0 置顶排序 + 行内优先级色标；B15：查看全部入口） ── */}
        <SectionCard
          title="我的任务"
          subtitle={`${myTasks.length} 个未完成 · 按优先级排序`}
          actions={
            myTasks.length > 0 ? (
              <Button size="small" onClick={() => openMyTasks({})}>
                查看全部
              </Button>
            ) : undefined
          }
        >
          {myTasks.length === 0 ? (
            <EmptyState title="没有分配给我的未完成任务" dense />
          ) : (
            <Stack spacing={1}>
              {sortedTasks.slice(0, 8).map((t) => {
                const overdue = isOverdue(t.dueDate);
                const soon = !overdue && diffDays(today(), t.dueDate) <= 3;
                return (
                  <Stack
                    key={t.id}
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    alignItems={{ xs: 'stretch', sm: 'center' }}
                    justifyContent="space-between"
                    /* B16：整行可点击下探 → 该项目 WBS 页（详情/编辑），与 B15 抽屉行行为一致；
                       点状态下拉不触发跳转（Select 上已 stopPropagation） */
                    onClick={() => navigate(ROUTES.projectWbs(t.projectId))}
                    sx={{
                      px: 1.5,
                      py: 1.25,
                      borderRadius: 1.5,
                      cursor: 'pointer',
                      border: `1px solid ${
                        overdue ? alpha(tokens.status.danger, 0.5) : tokens.border.subtle
                      }`,
                      '&:hover': {
                        borderColor: overdue ? alpha(tokens.status.danger, 0.85) : alpha(tokens.brand.primary, 0.6),
                      },
                    }}
                  >
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                        {/* B14-块1：优先级色标（P0 红 / P1 橙 / P2 蓝 / P3 灰） */}
                        <PriorityChip priority={t.priority} />
                        <Typography sx={{ fontSize: 13.5 }} noWrap>
                          {t.wbsCode} {t.name}
                        </Typography>
                      </Stack>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
                        <Typography
                          variant="caption"
                          sx={{ color: overdue ? tokens.status.danger : soon ? tokens.status.warning : 'text.secondary' }}
                        >
                          截止 {fmtDate(t.dueDate)}
                          {overdue ? ' · 已逾期' : soon ? ' · 临期' : ''}
                        </Typography>
                        <ProgressBar value={t.progress} tone={overdue ? 'danger' : 'brand'} sx={{ maxWidth: 130 }} />
                      </Stack>
                    </Box>
                    <Select
                      size="small"
                      value={t.status}
                      disabled={busyTask === t.id}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => void handleStatus(t.id, e.target.value as TaskStatus, t.boardOrder)}
                      sx={{ minWidth: 108, fontSize: 13 }}
                    >
                      {TASK_STATUSES.map((s) => (
                        <MenuItem key={s} value={s} sx={{ fontSize: 13 }}>
                          <Box component="span" sx={{ color: colorOf(s) }}>
                            {s}
                          </Box>
                        </MenuItem>
                      ))}
                    </Select>
                  </Stack>
                );
              })}
            </Stack>
          )}
        </SectionCard>

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
        tasks={sortedTasks}
        initialProgress={myTasksDrawer.progress}
        initialPriority={myTasksDrawer.priority}
        onClose={() => setMyTasksDrawer((s) => ({ ...s, open: false }))}
      />
    </Box>
  );
}
