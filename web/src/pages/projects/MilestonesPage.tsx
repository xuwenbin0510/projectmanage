import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import EditCalendarOutlinedIcon from '@mui/icons-material/EditCalendarOutlined';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { useNavigate, useParams } from 'react-router-dom';

import { ConfirmDialog, DataTable, FormDialog, SectionCard, StatusChip, ProgressBar } from '@/components/common';
import type { Column } from '@/components/common';
import { api } from '@/api/client';
import { milestoneStartFrom } from '@/api/mock/rules';
import { useProjectStore } from '@/stores/projectStore';
import { usePermission, useToast } from '@/hooks';
import type { MilestoneWithGate, MilestoneOverride } from '@/types/project';
import type { ChangeDraft } from '@/types/change';
import { milestoneTaskDetail, type MilestoneTaskDetail } from '@/utils/wbs';
import { ROUTES } from '@/config/routes';
import { MILESTONE_OVERRIDES } from '@/config/enums';
import { isApiError, ErrorCode } from '@/types/api';
import { dayjs, fmtDate, DATE_FMT, diffDays, today } from '@/utils/date';
import { fmtDays } from '@/utils/format';
import type { Dayjs } from 'dayjs';
import { alphaOf, tokens, toneColor } from '@/theme/tokens';

/** 改期表单态：目标里程碑 + 待提交日期 */
interface RescheduleState {
  ms: MilestoneWithGate;
  date: Dayjs | null;
}

/** 新建里程碑表单态 */
interface CreateState {
  name: string;
  date: string;
  target: string;
}

/** 编辑里程碑表单态（P0-M6 / P0-M7 · 两段式提交） */
interface EditState {
  ms: MilestoneWithGate;
  name: string;
  target: string;
  date: string;
}

/**
 * 里程碑：基线 vs 当前，单向规则（延后必须走变更单）
 * 自由增删改（Q-2）：里程碑可自由编辑与删除，不再按「必备」锁删（R3-1）。
 * 状态为引擎派生值（SK-2），页面只触发「达成 / 人工覆盖 / 改期」三类写入。
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
  const [toggleTarget, setToggleTarget] = useState<MilestoneWithGate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MilestoneWithGate | null>(null);
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [createForm, setCreateForm] = useState<CreateState>({ name: '', date: '', target: '' });
  const [overrideOpen, setOverrideOpen] = useState<boolean>(false);
  const [overrideTarget, setOverrideTarget] = useState<MilestoneWithGate | null>(null);
  const [overrideValue, setOverrideValue] = useState<string>('');
  /** 钻取：查看某里程碑下关联的 WBS 任务（与引擎计数同源，P0-M9） */
  const [drill, setDrill] = useState<{ ms: MilestoneWithGate; detail: MilestoneTaskDetail } | null>(null);
  /** 编辑：名称 / 目标 / 计划日期 资料编辑（P0-M6） */
  const [edit, setEdit] = useState<EditState | null>(null);

  const archived = project?.status === '已结项' || project?.status === '已终止';
  const editable = can('milestone:edit') && !archived;

  // 用户反馈④：进入里程碑页即挂载刷新，避免从 WBS 页绑定任务后计数停留在旧值
  useEffect(() => {
    if (id) void refreshMilestones(id);
  }, [id, refreshMilestones]);

  /* ── 改期 ─────────────────────────────────────────
   * 显式提交：先在对话框里选好日期，点「提交改期」才打接口，
   * 成功 / 被单向约束拦截 / 其他异常三条分支都有明确反馈，不再静默吞掉。
   */
  const openReschedule = (ms: MilestoneWithGate): void => {
    setReschedule({ ms, date: dayjs(ms.currentDate) });
  };

  const closeReschedule = (): void => {
    if (submitting) return;
    setReschedule(null);
  };

  /** 由里程碑与目标日期构造兜底变更单草稿（服务端未回传时使用） */
  const buildFallbackDraft = (ms: MilestoneWithGate, toDate: string): ChangeDraft => ({
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

  /* ── 编辑里程碑资料（P0-M6 / P0-M7）：两段式提交，文本先于日期落库 ── */
  const openEdit = (m: MilestoneWithGate): void => {
    setEdit({ ms: m, name: m.name, target: m.target, date: m.currentDate });
  };

  const handleEditSubmit = async (): Promise<void> => {
    if (!edit) return;
    const { ms } = edit;
    const name = edit.name.trim();
    if (!name) {
      toast.warning('里程碑名称不能为空');
      return;
    }

    const textDirty = name !== ms.name || edit.target !== ms.target;
    const dateDirty = Boolean(edit.date) && edit.date !== ms.currentDate;
    if (!textDirty && !dateDirty) {
      toast.info('没有需要保存的修改');
      return;
    }

    setSubmitting(true);
    let textSaved = false;
    try {
      /* 段 1：文本字段先落库（引擎分支②③，永不被单向日期规则拦截） */
      if (textDirty) await api.updateMilestone(ms.id, { name, target: edit.target });
      textSaved = textDirty;

      /* 段 2：日期单独提交（引擎分支①，延后可能被 E_MS_NEED_CHANGE 拦截） */
      if (dateDirty) await api.updateMilestone(ms.id, { currentDate: edit.date });

      toast.success(`「${ms.code} ${name}」已更新`);
      setEdit(null);
      await refreshMilestones(id);
    } catch (e) {
      if (isApiError(e) && e.code === ErrorCode.E_MS_NEED_CHANGE) {
        const data = e.data as { changeDraft?: ChangeDraft } | undefined;
        toast.warning(textSaved ? '名称与目标已保存；日期延后需提交变更单' : '日期延后需提交变更单');
        setEdit(null);
        await refreshMilestones(id); // ★ 必须先刷新，保证重开编辑框看到已保存的新值
        setDraft(data?.changeDraft ?? buildFallbackDraft(ms, edit.date));
        return;
      }
      toast.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  /* ── 达成 / 取消达成（替代原 done 双轨命名，Q-2 / C-G4） ── */
  const handleAchieve = async (m: MilestoneWithGate): Promise<void> => {
    try {
      await api.updateMilestone(m.id, { achieved: !m.done });
      toast.success(`「${m.code} ${m.name}」已${m.done ? '取消达成' : '标记达成'}`);
      await refreshMilestones(id);
    } catch (e) {
      // R3-11：引擎不再抛 E_GATE_NOT_PASSED（门控拦截已下沉到引擎内部），死分支已清理
      toast.error(e);
    }
  };

  /* ── 删除（Q-2 / R3-1：里程碑可自由删除，不再按「必备」锁删） ── */
  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    try {
      await api.deleteMilestone(deleteTarget.id);
      toast.success(`「${deleteTarget.code} ${deleteTarget.name}」已删除`);
      setDeleteTarget(null);
      await refreshMilestones(id);
    } catch (e) {
      // R3-11：引擎不再抛 E_MS_REQUIRED_LOCKED，死分支已清理
      toast.error(e);
      setDeleteTarget(null);
    }
  };

  /* ── 新建（Q-2：服务端按 M{max+1} 生成编号，required=false，无门） ── */
  const openCreate = (): void => {
    setCreateForm({ name: '', date: project?.planStart ?? dayjs().format(DATE_FMT), target: '' });
    setCreateOpen(true);
  };

  const handleCreate = async (): Promise<void> => {
    if (!createForm.name.trim()) {
      toast.warning('请填写里程碑名称');
      return;
    }
    if (!createForm.date) {
      toast.warning('请选择计划日期');
      return;
    }
    setSubmitting(true);
    try {
      await api.createMilestone(id, {
        name: createForm.name.trim(),
        date: createForm.date,
        target: createForm.target.trim(),
      });
      toast.success('里程碑已创建');
      setCreateOpen(false);
      await refreshMilestones(id);
    } catch (e) {
      toast.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  /* ── 人工覆盖状态（SK-7b：类型层已排除「已达成」，不允许绕过门控达成） ── */
  const openOverride = (m: MilestoneWithGate): void => {
    setOverrideTarget(m);
    setOverrideValue(m.statusOverride ?? '');
    setOverrideOpen(true);
  };

  /* ── 钻取关联任务（P0-M9）：打开对话框列出该里程碑绑定的 WBS 任务 ── */
  const openDrill = async (ms: MilestoneWithGate): Promise<void> => {
    if (ms.taskStats.total === 0) return;
    try {
      const nodes = await api.listWbs(ms.projectId);
      // 与引擎计数严格同源（SK-M5）：同一函数 milestoneTaskDetail，基于同一份 WbsNode[]
      setDrill({ ms, detail: milestoneTaskDetail(nodes, ms.id) });
    } catch (e) {
      toast.error(e);
    }
  };

  const handleOverride = async (): Promise<void> => {
    if (!overrideTarget) return;
    setSubmitting(true);
    try {
      await api.updateMilestone(overrideTarget.id, {
        statusOverride: overrideValue ? (overrideValue as MilestoneOverride) : null,
      });
      toast.success(overrideValue ? '已人工覆盖状态' : '已撤销覆盖');
      setOverrideOpen(false);
      await refreshMilestones(id);
    } catch (e) {
      toast.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const rescheduleDelta: number | null =
    reschedule && reschedule.date && reschedule.date.isValid()
      ? reschedule.date.diff(dayjs(reschedule.ms.currentDate), 'day')
      : null;

  const columns: Array<Column<MilestoneWithGate>> = [
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
      key: 'current',
      label: '计划日期（到期）',
      width: 200,
      render: (m) => {
        /* P1-M14：运行期越界标红（日期 > planEnd）。YYYY-MM-DD 定长字符串，字典序即可比较 */
        const outOfRange = Boolean(project?.planEnd) && m.currentDate > project!.planEnd;
        const rangeTip = outOfRange ? `已超出项目计划结束日 ${project!.planEnd}` : undefined;
        /* R3-10：currentDate !== baselineDate → 追加「已变更」弱标记 + tooltip（含变更单号） */
        const changed = m.currentDate !== m.baselineDate;
        const changedTip = changed
          ? `基线 ${m.baselineDate} → 计划 ${m.currentDate}（变更单 ${m.lastChangeId ?? '—'}）`
          : undefined;
        const dateTip = outOfRange ? rangeTip : changedTip;
        const dateNode = (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Typography sx={{ fontSize: 13, color: outOfRange ? toneColor.danger : undefined }}>
              {fmtDate(m.currentDate)}
            </Typography>
            {changed && (
              <Chip size="small" label="已变更" variant="outlined" sx={{ height: 16, fontSize: 10 }} />
            )}
          </Stack>
        );
        return editable && !m.done ? (
          <Tooltip title={dateTip ?? '点击改期（提前直接生效，延后走变更单）'} arrow>
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
                color: outOfRange ? toneColor.danger : tokens.text.primary,
                bgcolor: 'transparent',
                border: `1px solid ${outOfRange ? toneColor.danger : tokens.border.subtle}`,
                borderRadius: 1,
                cursor: 'pointer',
                transition: 'border-color .15s, background-color .15s',
                '&:hover': {
                  borderColor: toneColor.danger,
                  bgcolor: alphaOf(toneColor.danger, 0.08),
                },
              }}
            >
              <EditCalendarOutlinedIcon sx={{ fontSize: 15, color: outOfRange ? toneColor.danger : tokens.brand.primary }} />
              {dateNode}
            </Box>
          </Tooltip>
        ) : (
          <Tooltip title={dateTip} arrow>
            <span>{dateNode}</span>
          </Tooltip>
        );
      },
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
      width: 120,
      render: (m) => {
        /* R4-P1-2（决策 B）：进行中且非人工覆盖时，标注来源（纯展示，零契约变更）
         * 时间驱动 = taskStats.progress === 0 且 startFrom <= today；任务驱动 = progress > 0 */
        const showDriven = m.status === '进行中' && !m.statusOverride;
        const startFrom = milestoneStartFrom(milestones, m, project?.planStart ?? '');
        const timeDriven = showDriven && m.taskStats.progress === 0 && diffDays(startFrom, today()) >= 0;
        return (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <StatusChip status={m.status} />
            {showDriven && (
              <Tooltip
                title={
                  timeDriven
                    ? `已到计划起算日 ${startFrom}，按时间轴自动进入进行中；如需调整可人工覆盖状态`
                    : `关联任务推进中（完成度 ${m.taskStats.progress}%），按任务完成度进入进行中；如需调整可人工覆盖状态`
                }
                arrow
              >
                <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                  {timeDriven ? '时间驱动' : '任务驱动'}
                </Typography>
              </Tooltip>
            )}
          </Stack>
        );
      },
    },
    {
      key: 'achieved',
      label: '达成',
      width: 72,
      align: 'center',
      render: (m) => (
        <Checkbox
          size="small"
          checked={m.done}
          disabled={!editable}
          onChange={() => void handleAchieve(m)}
        />
      ),
    },
    {
      key: 'tasks',
      label: '关联任务',
      width: 170,
      render: (m) =>
        m.taskStats.total === 0 ? (
          <Typography variant="caption" color="text.disabled">
            未关联
          </Typography>
        ) : (
          <Box>
            <Box
              component="button"
              type="button"
              onClick={() => void openDrill(m)}
              title="点击查看关联任务"
              sx={{
                display: 'inline-flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 0.25,
                minWidth: 116,
                font: 'inherit',
                cursor: 'pointer',
                bgcolor: 'transparent',
                border: 'none',
                p: 0.25,
                textAlign: 'left',
                borderRadius: 1,
                '&:hover': { bgcolor: alphaOf(tokens.brand.primary, 0.08) },
              }}
            >
              <ProgressBar value={m.taskStats.progress} height={5} showLabel={false} />
              <Typography variant="caption" color="text.secondary">
                {m.taskStats.done}/{m.taskStats.total} 完成 · {m.taskStats.progress}%
              </Typography>
            </Box>
            {/* R4-P1-1（决策 D3）：关联叶子全部 100% 且未达成时，提示 + 一键标记达成（走既有 handleAchieve，审计留痕） */}
            {m.taskStats.progress === 100 && !m.done && editable && (
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5, flexWrap: 'wrap' }}>
                <Typography variant="caption" color="text.secondary">
                  关联任务已全部完成
                </Typography>
                <Button size="small" variant="outlined" onClick={() => void handleAchieve(m)}>
                  标记达成
                </Button>
              </Stack>
            )}
          </Box>
        ),
    },
    {
      key: 'actions',
      label: '操作',
      width: 128,
      align: 'center',
      render: (m) => (
        <Stack direction="row" spacing={0.25} justifyContent="center">
          <Tooltip title="编辑里程碑" arrow>
            <span>
              <IconButton size="small" disabled={!editable} onClick={() => openEdit(m)}>
                <EditOutlinedIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="人工覆盖状态" arrow>
            <IconButton size="small" onClick={() => openOverride(m)}>
              <FlagOutlinedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="删除里程碑" arrow>
            <span>
              <IconButton
                size="small"
                color="error"
                disabled={!editable}
                onClick={() => setDeleteTarget(m)}
              >
                <DeleteOutlineIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      ),
    },
  ];

  return (
    <Stack spacing={2.5}>
      <Alert severity="info" variant="outlined">
        <strong>计划日期（到期）</strong>为当前生效计划，<strong>提前可直接改</strong>，
        <strong>延后须走变更单</strong>；基线日期仅用于审计对比。
        里程碑状态由引擎派生，达成可由手动标记触发；任务全部完成不会自动达成里程碑，需人工确认；里程碑可自由编辑与删除。
      </Alert>

      <SectionCard
        title="里程碑"
        subtitle={`${milestones.filter((m) => m.done).length} / ${milestones.length} 已达成 · 累计延期 ${milestones.reduce(
          (s, m) => s + Math.max(0, m.delayDays),
          0,
        )} 天`}
        actions={
          editable ? (
            <IconButton size="small" color="primary" onClick={openCreate} aria-label="新建里程碑">
              <AddIcon />
            </IconButton>
          ) : undefined
        }
        flush
      >
        <DataTable<MilestoneWithGate>
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
            基线日期（创建时原始日期，仅作对比，不是到期日）
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

      {/* 新建里程碑 */}
      <FormDialog
        open={createOpen}
        title="新建里程碑"
        submitText="创建"
        submitting={submitting}
        disabled={!createForm.name.trim() || !createForm.date}
        maxWidth="xs"
        onClose={() => setCreateOpen(false)}
        onSubmit={() => void handleCreate()}
      >
        <TextField
          label="名称"
          required
          value={createForm.name}
          onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
          fullWidth
        />
        <DatePicker
          label="计划日期（同时作为基线）"
          value={createForm.date ? dayjs(createForm.date) : null}
          format={DATE_FMT}
          slotProps={{ textField: { size: 'small', fullWidth: true } }}
          onChange={(v) => setCreateForm((f) => ({ ...f, date: v && v.isValid() ? v.format(DATE_FMT) : '' }))}
        />
        <TextField
          label="目标 / 达成标准"
          value={createForm.target}
          onChange={(e) => setCreateForm((f) => ({ ...f, target: e.target.value }))}
          fullWidth
          multiline
          minRows={2}
          helperText="可留空，创建后再补"
        />
      </FormDialog>

      {/* 人工覆盖状态 */}
      <FormDialog
        open={overrideOpen}
        title={overrideTarget ? `人工覆盖状态 · ${overrideTarget.code} ${overrideTarget.name}` : '人工覆盖状态'}
        submitText="保存覆盖"
        submitting={submitting}
        maxWidth="xs"
        onClose={() => setOverrideOpen(false)}
        onSubmit={() => void handleOverride()}
      >
        <Select
          value={overrideValue}
          onChange={(e) => setOverrideValue(e.target.value)}
          fullWidth
        >
          <MenuItem value="">（撤销覆盖，恢复引擎派生）</MenuItem>
          {MILESTONE_OVERRIDES.map((o) => (
            <MenuItem key={o} value={o}>
              {o}
            </MenuItem>
          ))}
        </Select>
        <Typography variant="caption" color="text.secondary">
          覆盖仅可设为「未开始 / 进行中 / 已逾期」，不允许绕过门控达成；改期后会自动失效（SK-7）。
        </Typography>
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

      {/* 删除确认 */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除里程碑"
        danger
        confirmText="删除"
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        content={
          deleteTarget
            ? `确定删除「${deleteTarget.code} ${deleteTarget.name}」？关联 WBS 节点会解绑（不删除任务）。该操作不可撤销。`
            : ''
        }
      />

      {/* 编辑里程碑资料（两段式提交：名称/目标先落库，日期后提交） */}
      <FormDialog
        open={Boolean(edit)}
        title={edit ? `编辑里程碑 · ${edit.ms.code} ${edit.ms.name}` : '编辑里程碑'}
        submitText="保存"
        submitting={submitting}
        disabled={!edit?.name.trim()}
        maxWidth="sm"
        onClose={() => setEdit(null)}
        onSubmit={() => void handleEditSubmit()}
      >
        <TextField
          label="名称"
          required
          value={edit?.name ?? ''}
          onChange={(e) => setEdit((s) => (s ? { ...s, name: e.target.value } : s))}
          disabled={submitting}
          fullWidth
        />
        <TextField
          label="目标 / 达成标准"
          value={edit?.target ?? ''}
          onChange={(e) => setEdit((s) => (s ? { ...s, target: e.target.value } : s))}
          disabled={submitting}
          fullWidth
          multiline
          minRows={3}
        />
        <DatePicker
          label="当前计划日期"
          value={edit?.date ? dayjs(edit.date) : null}
          format={DATE_FMT}
          slotProps={{ textField: { size: 'small', fullWidth: true, disabled: submitting } }}
          onChange={(v) => setEdit((s) => (s ? { ...s, date: v && v.isValid() ? v.format(DATE_FMT) : '' } : s))}
        />
        {edit && (
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.secondary">
              基线日期（创建时原始日期，仅作对比，不是到期日）：{fmtDate(edit.ms.baselineDate)}
            </Typography>
          </Stack>
        )}
      </FormDialog>

      {/* 钻取：某里程碑下关联的 WBS 任务（与列表计数同源，P0-M9 / P0-M10） */}
      <FormDialog
        open={Boolean(drill)}
        title={drill ? `关联任务 · ${drill.ms.code} ${drill.ms.name}` : '关联任务'}
        submitText="关闭"
        maxWidth="sm"
        onClose={() => setDrill(null)}
        onSubmit={() => setDrill(null)}
      >
        {drill && (
          <Stack spacing={1}>
            <Alert severity="info" variant="outlined" sx={{ py: 0.5 }}>
              共 <strong>{drill.detail.nodes.length}</strong> 条关联任务；
              完成度按<strong>叶子任务工时加权</strong>计算，汇总节点不计入权重。
            </Alert>
            {drill.detail.nodes.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                该里程碑暂无关联任务
              </Typography>
            )}
            {drill.detail.nodes.map((n) => {
              const isRollup = drill.detail.rollupIds.has(n.id);
              return (
                <Box
                  key={n.id}
                  sx={{ p: 1, border: `1px solid ${tokens.border.subtle}`, borderRadius: 1, ml: (n.level - 1) * 2 }}
                >
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography sx={{ fontSize: 13, fontWeight: 500 }}>
                        {n.wbsCode} {n.name}
                      </Typography>
                      {isRollup && (
                        <Chip size="small" label="汇总" sx={{ height: 18, fontSize: 10 }} />
                      )}
                    </Stack>
                    <Chip size="small" label={n.status} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    负责人：{n.ownerName || '未指派'} · 截止：
                    {n.dueDate ? fmtDate(n.dueDate) : '—'}
                    {!isRollup && ` · 工时：${fmtDays(n.estimateDays)}`}
                  </Typography>
                </Box>
              );
            })}
          </Stack>
        )}
      </FormDialog>
    </Stack>
  );
}
