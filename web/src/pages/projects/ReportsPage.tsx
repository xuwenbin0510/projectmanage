import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useParams } from 'react-router-dom';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import {
  DataTable,
  EmptyState,
  FormDialog,
  LoadingState,
  PageHeader,
  PermissionButton,
  ProgressBar,
  SectionCard,
  StatusChip,
  UserAvatar,
} from '@/components/common';
import type { Column } from '@/components/common';
import type { Report } from '@/types/report';
import type { ReportPayload } from '@/api/contract';
import { useProjectStore } from '@/stores/projectStore';
import { useWbsStore } from '@/stores/wbsStore';
import { useFlowStore } from '@/stores/flowStore';
import { useToast } from '@/hooks';
import { REPORT_SECTION_TITLE } from '@/config/enums';
import { dayjs, weekCode, shiftWeek, fmtDate } from '@/utils/date';
import { tokens } from '@/theme/tokens';

interface TaskProgress {
  progressAfter: number;
  selected: boolean;
}

const schema = z.object({
  week: z.string().min(1, '请选择周次'),
  doneNote: z.string().default(''),
  resourceNote: z.string().default(''),
  planItems: z.array(z.string()).default([]),
  risks: z
    .array(
      z.object({
        description: z.string().min(1, '请填写风险描述'),
        owner: z.string().min(1, '必填责任人'),
        dueDate: z.string().min(1, '必填截止日'),
      }),
    )
    .default([]),
});

type FormValues = z.infer<typeof schema>;

function buildWeekOptions(current: string): string[] {
  return [0, -1, -2, -3, -4].map((o) => shiftWeek(current, o));
}

/**
 * 结构化周报：① 完成 ② 计划 ③ 风险 ④ 协调资源（P0-08）
 * @prd P0-08
 */
export function ReportsPage(): JSX.Element {
  const { id = '' } = useParams();
  const toast = useToast();
  const project = useProjectStore((s) => s.current);
  const members = useProjectStore((s) => s.members);

  const reports = useFlowStore((s) => s.reports);
  const loading = useFlowStore((s) => s.loading);
  const fetchReports = useFlowStore((s) => s.fetchReports);
  const saveReport = useFlowStore((s) => s.saveReport);
  const submitReport = useFlowStore((s) => s.submitReport);

  const nodes = useWbsStore((s) => s.nodes);
  const fetchWbs = useWbsStore((s) => s.fetchWbs);

  const [open, setOpen] = useState(false);
  const [taskMap, setTaskMap] = useState<Record<string, TaskProgress>>({});

  const leaves = useMemo(() => {
    const parentIds = new Set(nodes.map((n) => n.parentId).filter(Boolean) as string[]);
    return nodes.filter((n) => !parentIds.has(n.id));
  }, [nodes]);

  const weekOptions = useMemo(() => buildWeekOptions(weekCode(dayjs())), []);

  // 改动 B：一人可担任多个角色 → db.members 一人多行，责任人下拉按 userOpenId 去重，避免重复 key / 重复 value
  const ownerOptions = useMemo(
    () => Array.from(new Map(members.map((m) => [m.userOpenId, m])).values()),
    [members],
  );

  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { week: weekOptions[0], doneNote: '', resourceNote: '', planItems: [''], risks: [] },
  });

  // planItems 为基础字符串数组，直接用本地状态管理（避免原始数组进入 useFieldArray 的类型约束）
  const [planItems, setPlanItems] = useState<string[]>(['']);
  const risks = useFieldArray<FormValues, 'risks'>({ control, name: 'risks' });

  useEffect(() => {
    void fetchReports(id).catch((e: unknown) => toast.error(e));
    if (project?.type) void fetchWbs(id, project.type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const archived = project?.status === '已结项' || project?.status === '已终止';

  const openCreate = (): void => {
    reset({ week: weekOptions[0], doneNote: '', resourceNote: '', planItems: [''], risks: [] });
    setPlanItems(['']);
    setTaskMap(
      Object.fromEntries(leaves.map((n) => [n.id, { progressAfter: n.progress, selected: false }])),
    );
    setOpen(true);
  };

  const assemble = (values: FormValues): ReportPayload => ({
    projectId: id,
    week: values.week,
    doneNote: values.doneNote,
    planItems: planItems.map((p) => p.trim()).filter(Boolean),
    resourceNote: values.resourceNote,
    tasks: leaves.map((n) => ({
      nodeId: n.id,
      progressAfter: taskMap[n.id]?.progressAfter ?? n.progress,
      selected: taskMap[n.id]?.selected ?? false,
    })),
    risks: values.risks,
  });

  const doSave = async (values: FormValues, submit: boolean): Promise<void> => {
    const payload = assemble(values);
    try {
      if (submit) await submitReport(payload);
      else await saveReport(payload);
      toast.success(submit ? '周报已提交' : '周报已存草稿');
      setOpen(false);
      await fetchReports(id);
    } catch (e) {
      toast.error(e);
    }
  };

  const columns: Array<Column<Report>> = [
    { key: 'week', label: '周次', width: 110, render: (r) => <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{r.week}</Typography> },
    { key: 'status', label: '状态', width: 90, render: (r) => <StatusChip status={r.status} /> },
    { key: 'author', label: '填报人', width: 100, render: (r) => <Stack direction="row" spacing={0.75} alignItems="center"><UserAvatar name={r.authorName} size={22} /><Typography variant="caption">{r.authorName}</Typography></Stack> },
    { key: 'doneNote', label: '完成摘要', render: (r) => <Typography variant="caption" color="text.secondary" noWrap>{r.doneNote || '—'}</Typography> },
    { key: 'tasks', label: '关联任务', width: 90, align: 'center', render: (r) => <Chip size="small" label={r.tasks.length} sx={{ height: 20 }} /> },
    { key: 'risks', label: '风险项', width: 80, align: 'center', render: (r) => <Chip size="small" label={r.risks.length} color={r.risks.length ? 'warning' : 'default'} sx={{ height: 20 }} /> },
    { key: 'submittedAt', label: '提交时间', width: 150, render: (r) => <Typography variant="caption" color="text.secondary">{r.submittedAt ? fmtDate(r.submittedAt) : '—'}</Typography> },
  ];

  return (
    <Stack spacing={2.5}>
      <PageHeader
        title="周报"
        subtitle="结构化周报：对照计划的完成情况 + 下周计划 + 风险问题 + 需协调资源"
        actions={
          <PermissionButton
            action="report:write"
            disabledReason={archived ? '项目已归档' : ''}
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            onClick={openCreate}
          >
            新建周报
          </PermissionButton>
        }
      />

      <SectionCard flush>
        {loading && reports.length === 0 ? (
          <LoadingState variant="skeleton" rows={4} height={48} />
        ) : reports.length === 0 ? (
          <EmptyState title="暂无周报" description="点击右上角「新建周报」填报本周进展" />
        ) : (
          <DataTable<Report> columns={columns} rows={reports} rowKey={(r) => r.id} />
        )}
      </SectionCard>

      <FormDialog
        open={open}
        title={`新建周报 · ${project?.name ?? ''}`}
        submitText="提交"
        maxWidth="md"
        onClose={() => setOpen(false)}
        onSubmit={handleSubmit((v) => void doSave(v, true))}
        extraActions={
          <Button color="inherit" onClick={handleSubmit((v) => void doSave(v, false))}>
            存草稿
          </Button>
        }
      >
        <TextField select label="周次" {...register('week')} fullWidth error={Boolean(errors.week)} helperText={errors.week?.message}>
          {weekOptions.map((w) => (
            <MenuItem key={w} value={w}>
              {w}
            </MenuItem>
          ))}
        </TextField>

        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{REPORT_SECTION_TITLE.done}</Typography>
          <TextField label="补充说明（对照计划的完成情况）" {...register('doneNote')} fullWidth multiline minRows={2} placeholder="本周按计划完成了哪些关键事项" />
          <Stack spacing={1} sx={{ mt: 1 }}>
            {leaves.map((n) => {
              const t = taskMap[n.id] ?? { progressAfter: n.progress, selected: false };
              return (
                <Stack key={n.id} direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                  <input
                    type="checkbox"
                    checked={t.selected}
                    onChange={(e) => setTaskMap((m) => ({ ...m, [n.id]: { ...t, selected: e.target.checked } }))}
                    style={{ accentColor: tokens.brand.primary }}
                  />
                  <Typography sx={{ fontSize: 13, flex: '1 1 200px', minWidth: 0 }} noWrap>
                    {n.wbsCode} {n.name}
                  </Typography>
                  <Box sx={{ width: 110 }}>
                    <ProgressBar value={n.progress} height={5} showLabel={false} />
                  </Box>
                  <TextField
                    type="number"
                    label="完成后%"
                    size="small"
                    value={t.progressAfter}
                    onChange={(e) => setTaskMap((m) => ({ ...m, [n.id]: { ...t, progressAfter: Number(e.target.value) } }))}
                    sx={{ width: 110 }}
                    InputProps={{ inputProps: { min: 0, max: 100 } }}
                  />
                </Stack>
              );
            })}
          </Stack>
        </Box>

        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{REPORT_SECTION_TITLE.plan}</Typography>
          <Stack spacing={1}>
            {planItems.map((val, index) => (
              <Stack key={index} direction="row" spacing={1} alignItems="center">
                <TextField
                  value={val}
                  onChange={(e) => setPlanItems((prev) => prev.map((p, i) => (i === index ? e.target.value : p)))}
                  fullWidth
                  size="small"
                  placeholder={`计划项 ${index + 1}`}
                />
                <IconButton
                  size="small"
                  color="error"
                  onClick={() => setPlanItems((prev) => prev.filter((_, i) => i !== index))}
                  disabled={planItems.length === 1}
                >
                  <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Stack>
            ))}
            <Button startIcon={<AddIcon />} size="small" onClick={() => setPlanItems((prev) => [...prev, ''])} sx={{ alignSelf: 'flex-start' }}>
              添加计划项
            </Button>
          </Stack>
        </Box>

        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{REPORT_SECTION_TITLE.risks}</Typography>
          <Stack spacing={1}>
            {risks.fields.map((field, index) => (
              <Stack key={field.id} spacing={1} sx={{ p: 1, border: `1px solid ${tokens.border.subtle}`, borderRadius: 1.5 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <TextField {...register(`risks.${index}.description` as const)} label="风险描述" fullWidth size="small" error={Boolean(errors.risks?.[index]?.description)} helperText={errors.risks?.[index]?.description?.message} />
                  <IconButton size="small" color="error" onClick={() => risks.remove(index)}>
                    <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Stack>
                <Stack direction="row" spacing={1}>
                  <TextField {...register(`risks.${index}.owner` as const)} select label="责任人" size="small" sx={{ flex: 1 }} error={Boolean(errors.risks?.[index]?.owner)} helperText={errors.risks?.[index]?.owner?.message}>
                    <MenuItem value="">（未选）</MenuItem>
                    {ownerOptions.map((m) => (
                      <MenuItem key={m.userOpenId} value={m.userOpenId}>
                        {m.userName}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField {...register(`risks.${index}.dueDate` as const)} type="date" label="截止日" size="small" sx={{ flex: 1 }} InputLabelProps={{ shrink: true }} error={Boolean(errors.risks?.[index]?.dueDate)} helperText={errors.risks?.[index]?.dueDate?.message} />
                </Stack>
              </Stack>
            ))}
            <Button startIcon={<AddIcon />} size="small" onClick={() => risks.append({ description: '', owner: '', dueDate: '' })} sx={{ alignSelf: 'flex-start' }}>
              添加风险项
            </Button>
          </Stack>
        </Box>

        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{REPORT_SECTION_TITLE.resource}</Typography>
          <TextField label="需要协调的资源" {...register('resourceNote')} fullWidth multiline minRows={2} placeholder="需要跨团队 / 上级协调的支持" />
        </Box>
      </FormDialog>
    </Stack>
  );
}
