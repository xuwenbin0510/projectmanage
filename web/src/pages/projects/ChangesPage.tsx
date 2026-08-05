import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { useLocation, useParams } from 'react-router-dom';

import {
  EmptyState,
  FormDialog,
  LoadingState,
  PageHeader,
  PermissionButton,
  SectionCard,
  StatusChip,
} from '@/components/common';
import type { Change, ChangeDraft, ChangeType, RouteResult } from '@/types/change';
import type { ChangePayloadInput } from '@/api/contract';
import { api } from '@/api/client';
import { useProjectStore } from '@/stores/projectStore';
import { useFlowStore } from '@/stores/flowStore';
import { useToast } from '@/hooks';
import { CHANGE_ROUTE_LABEL, CHANGE_TYPE_LABEL, CCB_EFFORT_THRESHOLD } from '@/config/enums';
import { DATE_FMT, dayjs } from '@/utils/date';
import { tokens } from '@/theme/tokens';

const CHANGE_TYPES: ChangeType[] = ['milestone_date', 'requirement_baseline', 'scope', 'other'];
const TARGET_TYPES = [
  { value: '', label: '（不指定）' },
  { value: 'milestone', label: '里程碑' },
  { value: 'requirement', label: '需求' },
  { value: 'scope', label: '范围' },
] as const;

interface DraftState {
  changeType: ChangeType;
  title: string;
  content: string;
  impactAnalysis: string;
  effortDays: number;
  targetType: '' | 'milestone' | 'requirement' | 'scope';
  targetId: string;
  fromDate: string;
  toDate: string;
}

const EMPTY: DraftState = {
  changeType: 'scope',
  title: '',
  content: '',
  impactAnalysis: '',
  effortDays: 1,
  targetType: '',
  targetId: '',
  fromDate: '',
  toDate: '',
};

/**
 * 变更控制：新建 / 路由预判（PM 自批 or CCB）/ 提交 / 实施
 * @prd P0-14 P0-15
 */
export function ChangesPage(): JSX.Element {
  const { id = '' } = useParams();
  const location = useLocation();
  const toast = useToast();
  const project = useProjectStore((s) => s.current);

  const changes = useFlowStore((s) => s.changes);
  const loading = useFlowStore((s) => s.loading);
  const fetchChanges = useFlowStore((s) => s.fetchChanges);
  const createChange = useFlowStore((s) => s.createChange);
  const submitChange = useFlowStore((s) => s.submitChange);
  const applyChange = useFlowStore((s) => s.applyChange);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<DraftState>(EMPTY);
  const [route, setRoute] = useState<RouteResult | null>(null);

  useEffect(() => {
    void fetchChanges(id).catch((e: unknown) => toast.error(e));
  }, [id, fetchChanges, toast]);

  // 接收里程碑延后回传的变更单草稿，自动预填
  useEffect(() => {
    const draft = (location.state as { changeDraft?: ChangeDraft } | null)?.changeDraft;
    if (draft) {
      setForm({
        ...EMPTY,
        changeType: draft.changeType,
        title: draft.title,
        targetType: 'milestone',
        targetId: draft.targetId,
        fromDate: draft.payload.fromDate,
        toDate: draft.payload.toDate,
        effortDays: Math.max(1, Math.abs(
          dayjs(draft.payload.toDate).diff(dayjs(draft.payload.fromDate), 'day'),
        )),
      });
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  /** 实时路由预判：≥3 人日或指定范围走 CCB */
  useEffect(() => {
    let cancelled = false;
    if (!form.changeType) {
      setRoute(null);
      return;
    }
    api
      .routeChange({
        changeType: form.changeType,
        effortDays: Number(form.effortDays) || 0,
        targetType: form.targetType,
      })
      .then((r) => {
        if (!cancelled) setRoute(r);
      })
      .catch(() => {
        if (!cancelled) setRoute(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.changeType, form.effortDays, form.targetType]);

  const archived = project?.status === '已结项' || project?.status === '已终止';

  const openCreate = (): void => {
    setForm(EMPTY);
    setRoute(null);
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    if (!form.title.trim()) {
      toast.warning('请填写变更标题');
      return;
    }
    const payload: ChangePayloadInput = {
      projectId: id,
      changeType: form.changeType,
      title: form.title.trim(),
      content: form.content.trim(),
      impactAnalysis: form.impactAnalysis.trim(),
      effortDays: Number(form.effortDays) || 0,
      targetType: form.targetType,
      targetId: form.targetId,
      payload:
        form.changeType === 'milestone_date'
          ? { fromDate: form.fromDate, toDate: form.toDate }
          : undefined,
    };
    try {
      await createChange(payload);
      toast.success('变更单已创建');
      setOpen(false);
      await fetchChanges(id);
    } catch (e) {
      toast.error(e);
    }
  };

  const runSubmit = async (cid: string): Promise<void> => {
    try {
      await submitChange(cid);
      toast.success('变更已提交审批');
      await fetchChanges(id);
    } catch (e) {
      toast.error(e);
    }
  };

  const runApply = async (cid: string): Promise<void> => {
    try {
      await applyChange(cid);
      toast.success('变更已实施');
      await fetchChanges(id);
    } catch (e) {
      toast.error(e);
    }
  };

  const predictedRoute = useMemo(
    () => route?.route ?? (form.effortDays >= CCB_EFFORT_THRESHOLD ? 'ccb' : 'pm_only'),
    [route, form.effortDays],
  );

  return (
    <Stack spacing={2.5}>
      <PageHeader
        title="变更控制"
        subtitle="范围 / 里程碑 / 需求基线变更；系统按工作量与影响自动判定 PM 自批或 CCB 评审"
        actions={
          <PermissionButton
            action="change:create"
            disabledReason={archived ? '项目已归档' : ''}
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            onClick={openCreate}
          >
            新建变更
          </PermissionButton>
        }
      />

      {loading && changes.length === 0 ? (
        <LoadingState variant="skeleton" rows={4} height={80} />
      ) : changes.length === 0 ? (
        <SectionCard>
          <EmptyState title="暂无变更单" description="涉及里程碑延后、范围或需求基线调整时提交变更申请" />
        </SectionCard>
      ) : (
        <Stack spacing={1.5}>
          {changes.map((c: Change) => (
            <Paper key={c.id} variant="outlined" sx={{ p: 2 }}>
              <Stack
                direction={{ xs: 'column', md: 'row' }}
                justifyContent="space-between"
                spacing={1.5}
                alignItems={{ xs: 'flex-start', md: 'center' }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography sx={{ fontSize: 15, fontWeight: 600 }}>{c.title}</Typography>
                    <Chip size="small" variant="outlined" label={CHANGE_TYPE_LABEL[c.changeType]} sx={{ height: 20 }} />
                    <Chip size="small" label={CHANGE_ROUTE_LABEL[c.route]} sx={{ height: 20 }} />
                    <StatusChip status={c.status} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    编号 {c.code} · 工作量 {c.effortDays} 人日 · 发起人 {c.createdByName} · {c.createdAt.slice(0, 10)}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1} flexShrink={0}>
                  {c.status === '草稿' && (
                    <PermissionButton action="change:submit" size="small" variant="outlined" onClick={() => void runSubmit(c.id)}>
                      提交
                    </PermissionButton>
                  )}
                  {c.status === '已批准' && (
                    <PermissionButton action="change:submit" size="small" variant="contained" onClick={() => void runApply(c.id)}>
                      实施
                    </PermissionButton>
                  )}
                </Stack>
              </Stack>
              {c.content && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  {c.content}
                </Typography>
              )}
            </Paper>
          ))}
        </Stack>
      )}

      <FormDialog
        open={open}
        title="新建变更单"
        submitText="创建"
        maxWidth="sm"
        onClose={() => setOpen(false)}
        onSubmit={() => void handleSubmit()}
      >
        <Alert severity="info" variant="outlined" sx={{ mb: 0.5 }}>
          预计审批路径：<strong>{CHANGE_ROUTE_LABEL[predictedRoute]}</strong>
          {predictedRoute === 'ccb' ? '（工作量 ≥ ' + CCB_EFFORT_THRESHOLD + ' 人日或涉及范围/基线）' : '（PM 自批）'}
        </Alert>
        <TextField
          select
          label="变更类型"
          value={form.changeType}
          onChange={(e) => setForm({ ...form, changeType: e.target.value as ChangeType })}
          fullWidth
        >
          {CHANGE_TYPES.map((t) => (
            <MenuItem key={t} value={t}>
              {CHANGE_TYPE_LABEL[t]}
            </MenuItem>
          ))}
        </TextField>
        <TextField label="变更标题" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} fullWidth required />
        <TextField
          label="变更内容"
          value={form.content}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
          fullWidth
          multiline
          minRows={2}
        />
        <TextField
          label="影响分析"
          value={form.impactAnalysis}
          onChange={(e) => setForm({ ...form, impactAnalysis: e.target.value })}
          fullWidth
          multiline
          minRows={2}
        />
        <TextField
          label="工作量（人日）"
          type="number"
          value={form.effortDays}
          onChange={(e) => setForm({ ...form, effortDays: Number(e.target.value) })}
          fullWidth
          InputProps={{ inputProps: { min: 0 } }}
          helperText={`≥ ${CCB_EFFORT_THRESHOLD} 人日走 CCB 评审`}
        />
        <TextField
          select
          label="影响对象"
          value={form.targetType}
          onChange={(e) => setForm({ ...form, targetType: e.target.value as DraftState['targetType'] })}
          fullWidth
        >
          {TARGET_TYPES.map((t) => (
            <MenuItem key={t.value} value={t.value}>
              {t.label}
            </MenuItem>
          ))}
        </TextField>
        {form.targetType && (
          <TextField
            label="对象 ID"
            value={form.targetId}
            onChange={(e) => setForm({ ...form, targetId: e.target.value })}
            fullWidth
            placeholder="如里程碑 / 需求编号"
          />
        )}
        {form.changeType === 'milestone_date' && (
          <Stack direction="row" spacing={1.5}>
            <DatePicker
              label="原日期"
              value={form.fromDate ? dayjs(form.fromDate) : null}
              format={DATE_FMT}
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
              onChange={(v) => setForm({ ...form, fromDate: v ? v.format(DATE_FMT) : '' })}
            />
            <DatePicker
              label="新日期"
              value={form.toDate ? dayjs(form.toDate) : null}
              format={DATE_FMT}
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
              onChange={(v) => setForm({ ...form, toDate: v ? v.format(DATE_FMT) : '' })}
            />
          </Stack>
        )}
      </FormDialog>
    </Stack>
  );
}
