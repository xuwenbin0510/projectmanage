import { useState } from 'react';
import {
  Alert,
  Box,
  Checkbox,
  Chip,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import EditCalendarOutlinedIcon from '@mui/icons-material/EditCalendarOutlined';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { useNavigate, useParams } from 'react-router-dom';

import { ConfirmDialog, DataTable, FormDialog, SectionCard, StatusChip } from '@/components/common';
import type { Column } from '@/components/common';
import { api } from '@/api/client';
import { useProjectStore } from '@/stores/projectStore';
import { usePermission, useToast } from '@/hooks';
import type { Milestone } from '@/types/project';
import type { ChangeDraft } from '@/types/change';
import { ROUTES } from '@/config/routes';
import { isApiError, ErrorCode } from '@/types/api';
import { dayjs, fmtDate, isOverdue, DATE_FMT } from '@/utils/date';
import type { Dayjs } from 'dayjs';
import { alphaOf, toneColor, tokens } from '@/theme/tokens';

/** 改期表单态：目标里程碑 + 待提交日期 */
interface RescheduleState {
  ms: Milestone;
  date: Dayjs | null;
}

/**
 * 里程碑：基线 vs 当前，单向规则（延后必须走变更单）
 * @prd P0-05
 */
export function MilestonesPage(): JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = usePermission();

  const project = useProjectStore((s) => s.current);
  const milestones = useProjectStore((s) => s.milestones);
  const refreshMilestones = useProjectStore((s) => s.refreshMilestones);

  const [reschedule, setReschedule] = useState<RescheduleState | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [draft, setDraft] = useState<ChangeDraft | null>(null);
  const [toggleTarget, setToggleTarget] = useState<Milestone | null>(null);

  const archived = project?.status === '已结项' || project?.status === '已终止';
  const editable = can('milestone:edit') && !archived;

  /* ── 改期 ─────────────────────────────────────────
   * 原实现把 api 调用挂在 DatePicker 的 onChange 上：
   *   1) MUI X v7 每敲一个日期分段就会触发一次 onChange，中间态是 Invalid Date；
   *   2) 组件是全受控的（value 来自 store），store 未更新前输入框会立刻弹回旧值，
   *      于是"改了日期 → 界面一动不动"，看上去就是提交没反应。
   * 现改为**显式提交**：先在对话框里选好日期，点「提交改期」才打 mock 接口，
   * 成功 / 被单向约束拦截 / 其他异常三条分支都有明确反馈，不再静默吞掉。
   */

  const openReschedule = (ms: Milestone): void => {
    setReschedule({ ms, date: dayjs(ms.currentDate) });
  };

  const closeReschedule = (): void => {
    if (submitting) return;
    setReschedule(null);
  };

  /** 由里程碑与目标日期构造兜底变更单草稿（服务端未回传时使用） */
  const buildFallbackDraft = (ms: Milestone, toDate: string): ChangeDraft => ({
    projectId: ms.projectId,
    changeType: 'milestone_date',
    title: `${ms.code} ${ms.name} 里程碑日期调整`,
    targetType: 'milestone',
    targetId: ms.id,
    payload: { fromDate: ms.currentDate, toDate },
  });

  const handleSubmitReschedule = async (): Promise<void> => {
    if (!reschedule) return;
    const { ms, date } = reschedule;

    if (!date || !date.isValid()) {
      toast.error('请选择一个有效日期');
      return;
    }
    const next = date.format(DATE_FMT);
    if (next === ms.currentDate) {
      toast.info('日期未变化，无需提交');
      return;
    }

    setSubmitting(true);
    try {
      await api.updateMilestone(ms.id, { currentDate: next });
      toast.success(`「${ms.name}」计划日期已提前至 ${next}`);
      setReschedule(null);
      await refreshMilestones(id);
    } catch (e) {
      // 单向约束拦截：弹出预填好的变更单草稿，引导走 CCB
      if (isApiError(e) && e.code === ErrorCode.E_MS_NEED_CHANGE) {
        const data = e.data as { changeDraft?: ChangeDraft } | undefined;
        setReschedule(null);
        setDraft(data?.changeDraft ?? buildFallbackDraft(ms, next));
        return;
      }
      // 其余异常照常提示，绝不静默
      toast.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleDone = async (): Promise<void> => {
    if (!toggleTarget) return;
    await api.updateMilestone(toggleTarget.id, { done: !toggleTarget.done });
    toast.success(`「${toggleTarget.name}」已${toggleTarget.done ? '取消达成' : '标记达成'}`);
    setToggleTarget(null);
    await refreshMilestones(id);
  };

  const rescheduleDelta: number | null =
    reschedule && reschedule.date && reschedule.date.isValid()
      ? reschedule.date.diff(dayjs(reschedule.ms.currentDate), 'day')
      : null;

  const columns: Array<Column<Milestone>> = [
    {
      key: 'name',
      label: '里程碑',
      render: (m) => (
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: 14, fontWeight: 600 }} noWrap>
            {m.code} {m.name}
          </Typography>
          {m.lastChangeId && (
            <Typography variant="caption" color="text.secondary">
              最近由变更单 {m.lastChangeId} 调整
            </Typography>
          )}
        </Box>
      ),
    },
    {
      key: 'target',
      label: '目标 / 达成标准',
      width: 200,
      render: (m) =>
        m.target ? (
          <Tooltip title={m.target} arrow>
            <Typography
              sx={{
                fontSize: 13,
                color: 'text.secondary',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {m.target}
            </Typography>
          </Tooltip>
        ) : (
          <Typography sx={{ fontSize: 13, color: 'text.disabled' }}>—</Typography>
        ),
    },
    {
      key: 'baseline',
      label: '基线日期',
      width: 124,
      render: (m) => (
        <Tooltip title="原始基线，任何操作都不会修改" arrow>
          <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>{fmtDate(m.baselineDate)}</Typography>
        </Tooltip>
      ),
    },
    {
      key: 'current',
      label: '当前计划',
      width: 190,
      render: (m) =>
        editable && !m.done ? (
          <Tooltip title="点击改期（提前立即生效，延后走变更单）" arrow>
            <Box
              component="button"
              type="button"
              onClick={() => openReschedule(m)}
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.75,
                px: 1,
                py: 0.5,
                font: 'inherit',
                fontSize: 13,
                color: tokens.text.primary,
                bgcolor: 'transparent',
                border: `1px solid ${tokens.border.subtle}`,
                borderRadius: 1,
                cursor: 'pointer',
                transition: 'border-color .15s, background-color .15s',
                '&:hover': {
                  borderColor: tokens.brand.primary,
                  bgcolor: alphaOf(tokens.brand.primary, 0.08),
                },
              }}
            >
              <EditCalendarOutlinedIcon sx={{ fontSize: 15, color: tokens.brand.primary }} />
              {fmtDate(m.currentDate)}
            </Box>
          </Tooltip>
        ) : (
          <Typography sx={{ fontSize: 13 }}>{fmtDate(m.currentDate)}</Typography>
        ),
    },
    {
      key: 'delay',
      label: '偏差',
      width: 96,
      render: (m) => {
        if (m.delayDays === 0) return <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>准时</Typography>;
        const late = m.delayDays > 0;
        return (
          <Typography sx={{ fontSize: 13, color: late ? toneColor.danger : toneColor.success }}>
            {late ? `延期 ${m.delayDays} 天` : `提前 ${-m.delayDays} 天`}
          </Typography>
        );
      },
    },
    {
      key: 'status',
      label: '状态',
      width: 96,
      render: (m) => <StatusChip status={!m.done && isOverdue(m.currentDate) ? '已逾期' : m.status} />,
    },
    {
      key: 'done',
      label: '达成',
      width: 72,
      align: 'center',
      render: (m) => (
        <Checkbox size="small" checked={m.done} disabled={!editable} onChange={() => setToggleTarget(m)} />
      ),
    },
  ];

  return (
    <Stack spacing={2.5}>
      <Alert severity="info" variant="outlined">
        <strong>单向规则</strong>：基线日期永不修改；当前计划<strong>提前可直接改</strong>，
        <strong>延后必须提交变更单</strong>并经 CCB 审批后由系统回写，杜绝私自改期。
      </Alert>

      <SectionCard
        title="里程碑"
        subtitle={`${milestones.filter((m) => m.done).length} / ${milestones.length} 已达成 · 累计延期 ${milestones.reduce(
          (s, m) => s + Math.max(0, m.delayDays),
          0,
        )} 天`}
        flush
      >
        <DataTable<Milestone>
          columns={columns}
          rows={milestones}
          rowKey={(m) => m.id}
          emptyTitle="暂无里程碑"
          emptyDescription="新建项目时会按生命周期模板自动生成里程碑"
        />
      </SectionCard>

      {/* 改期表单：显式提交才调用接口 */}
      <FormDialog
        open={Boolean(reschedule)}
        title={reschedule ? `调整计划日期 · ${reschedule.ms.code} ${reschedule.ms.name}` : '调整计划日期'}
        submitText="提交改期"
        submitting={submitting}
        disabled={!reschedule?.date?.isValid()}
        maxWidth="xs"
        onClose={closeReschedule}
        onSubmit={() => void handleSubmitReschedule()}
      >
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            基线日期（永不修改）
          </Typography>
          <Typography sx={{ fontSize: 14 }}>{fmtDate(reschedule?.ms.baselineDate)}</Typography>
        </Stack>
        <DatePicker
          label="新的当前计划日期"
          value={reschedule?.date ?? null}
          format={DATE_FMT}
          slotProps={{ textField: { size: 'small', fullWidth: true } }}
          onChange={(v) => setReschedule((r) => (r ? { ...r, date: v } : r))}
        />
        {rescheduleDelta !== null && rescheduleDelta > 0 && (
          <Alert severity="warning" variant="outlined">
            比当前计划<strong>延后 {rescheduleDelta} 天</strong>，提交后会被单向约束拦截，
            系统将自动生成变更单草稿引导走 CCB 审批。
          </Alert>
        )}
        {rescheduleDelta !== null && rescheduleDelta < 0 && (
          <Alert severity="success" variant="outlined">
            比当前计划<strong>提前 {-rescheduleDelta} 天</strong>，提交后立即生效并写入审计日志。
          </Alert>
        )}
      </FormDialog>

      {/* 延后拦截 → 引导创建变更单 */}
      <ConfirmDialog
        open={Boolean(draft)}
        title="里程碑延后须走变更申请"
        confirmText="去创建变更单"
        onClose={() => setDraft(null)}
        onConfirm={() => {
          const payload = draft;
          setDraft(null);
          navigate(ROUTES.projectChanges(id), { state: { changeDraft: payload } });
        }}
        content={
          <Box>
            <Typography variant="body2" sx={{ mb: 1 }}>
              系统已拦截本次直接改期，并生成变更单草稿：
            </Typography>
            <Stack spacing={0.5}>
              <Chip size="small" variant="outlined" label={draft?.title ?? ''} sx={{ alignSelf: 'flex-start' }} />
              <Typography variant="body2" color="text.secondary">
                {draft?.payload.fromDate} → {draft?.payload.toDate}（里程碑日期变更强制走 CCB）
              </Typography>
            </Stack>
          </Box>
        }
      />

      <ConfirmDialog
        open={Boolean(toggleTarget)}
        title={toggleTarget?.done ? '取消达成标记？' : '标记里程碑达成？'}
        onClose={() => setToggleTarget(null)}
        onConfirm={handleToggleDone}
        content={
          toggleTarget
            ? `「${toggleTarget.code} ${toggleTarget.name}」将被${toggleTarget.done ? '取消达成' : '标记为已达成'}，操作会写入审计日志。`
            : ''
        }
      />
    </Stack>
  );
}
