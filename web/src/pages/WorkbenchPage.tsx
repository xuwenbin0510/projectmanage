import { useCallback, useState } from 'react';
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
import { api } from '@/api/client';
import { useAsync, useToast } from '@/hooks';
import { ROUTES } from '@/config/routes';
import { PROJECT_TYPE_SHORT, TASK_STATUSES } from '@/config/enums';
import type { TaskStatus } from '@/types/wbs';
import { fmtDate, isOverdue, today, diffDays } from '@/utils/date';
import { alphaOf as alpha, tokens, colorOf } from '@/theme/tokens';

/**
 * 我的工作台：待办审批 / 我的任务 / 我的项目 / 周报提醒
 * @prd P0-13
 */
export function WorkbenchPage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const [busyTask, setBusyTask] = useState<string>('');

  const fetcher = useCallback(() => api.getWorkbench(), []);
  const { data, loading, error, run } = useAsync(fetcher, []);

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
          hint="以任务计划完成日为准"
          icon={<ReportProblemOutlinedIcon fontSize="small" />}
        />
        <StatCard
          label="本周待填周报"
          value={stats.missingReports}
          unit="份"
          tone={stats.missingReports > 0 ? 'warning' : 'success'}
          hint="周五 18:00 前提交"
          icon={<EditNoteOutlinedIcon fontSize="small" />}
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

        {/* ── 我的任务 ── */}
        <SectionCard title="我的任务" subtitle={`${myTasks.length} 个未完成`}>
          {myTasks.length === 0 ? (
            <EmptyState title="没有分配给我的未完成任务" dense />
          ) : (
            <Stack spacing={1}>
              {myTasks.slice(0, 8).map((t) => {
                const overdue = isOverdue(t.dueDate);
                const soon = !overdue && diffDays(today(), t.dueDate) <= 3;
                return (
                  <Stack
                    key={t.id}
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    alignItems={{ xs: 'stretch', sm: 'center' }}
                    justifyContent="space-between"
                    sx={{
                      px: 1.5,
                      py: 1.25,
                      borderRadius: 1.5,
                      border: `1px solid ${
                        overdue ? alpha(tokens.status.danger, 0.5) : tokens.border.subtle
                      }`,
                    }}
                  >
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography sx={{ fontSize: 13.5 }} noWrap>
                        {t.wbsCode} {t.name}
                      </Typography>
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
    </Box>
  );
}
