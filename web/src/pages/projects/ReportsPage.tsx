import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useLocation, useParams } from 'react-router-dom';
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
import type { Report, ReportTaskRef } from '@/types/report';
import type { WbsTreeNode } from '@/types/wbs';
import type { ReportPayload } from '@/api/contract';
import { useProjectStore } from '@/stores/projectStore';
import { useWbsStore } from '@/stores/wbsStore';
import { useFlowStore } from '@/stores/flowStore';
import { useToast } from '@/hooks';
import { REPORT_SECTION_TITLE } from '@/config/enums';
import { dayjs, weekCode, shiftWeek, fmtDate } from '@/utils/date';
import { tokens } from '@/theme/tokens';
import { memberNameOf } from '@/utils/member';

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
  const location = useLocation();
  const toast = useToast();
  const project = useProjectStore((s) => s.current);
  const members = useProjectStore((s) => s.members);

  const reports = useFlowStore((s) => s.reports);
  const loading = useFlowStore((s) => s.loading);
  const fetchReports = useFlowStore((s) => s.fetchReports);
  const saveReport = useFlowStore((s) => s.saveReport);
  const submitReport = useFlowStore((s) => s.submitReport);
  const updateReport = useFlowStore((s) => s.updateReport);

  const nodes = useWbsStore((s) => s.nodes);
  const tree = useWbsStore((s) => s.tree);
  const fetchWbs = useWbsStore((s) => s.fetchWbs);

  const [open, setOpen] = useState(false);
  const [taskMap, setTaskMap] = useState<Record<string, TaskProgress>>({});
  /** 详情查看（用户反馈⑤：列表可查看完整内容） */
  const [detail, setDetail] = useState<Report | null>(null);
  /** 编辑中的周报 id（null = 新建） */
  const [editingReportId, setEditingReportId] = useState<string | null>(null);
  /** R3-7：编辑中的完整周报（assemble 时 tasks 原样回传的权威来源） */
  const [editingReport, setEditingReport] = useState<Report | null>(null);
  /** R3-5 接收端：避免同一路由 state（prefillNodeId）重复触发新建弹窗 */
  const prefilledRef = useRef<boolean>(false);

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
    watch,
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
    // R3-5 接收端：从 WBS「写日志」跳转过来时，location.state 携带 prefillNodeId
    const prefillNodeId = (location.state as { prefillNodeId?: string } | null)?.prefillNodeId;
    const wbsReady = project?.type ? fetchWbs(id, project.type) : Promise.resolve();
    void wbsReady.then(() => {
      if (prefillNodeId && !prefilledRef.current) {
        prefilledRef.current = true;
        openCreateWithPrefill(prefillNodeId);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const archived = project?.status === '已结项' || project?.status === '已终止';

  const openCreate = (): void => {
    reset({ week: weekOptions[0], doneNote: '', resourceNote: '', planItems: [''], risks: [] });
    setPlanItems(['']);
    // 关联范围覆盖全部 WBS 节点（树形勾选），不再只限叶子
    setTaskMap(
      Object.fromEntries(nodes.map((n) => [n.id, { progressAfter: n.progress, selected: false }])),
    );
    setEditingReportId(null);
    setEditingReport(null);
    setOpen(true);
  };

  /** R3-5 接收端：从 WBS「写日志」跳转 → 自动打开新建弹窗并预勾选该任务 */
  const openCreateWithPrefill = (nodeId: string): void => {
    // 从 store 取最新节点（fetchWbs 的 .then 回调里闭包 nodes 可能是旧值）
    const latestNodes = useWbsStore.getState().nodes;
    const target = latestNodes.find((n) => n.id === nodeId);
    if (!target) {
      // 节点不存在（可能已被删除）→ 降级为普通新建
      openCreate();
      return;
    }
    reset({ week: weekOptions[0], doneNote: '', resourceNote: '', planItems: [''], risks: [] });
    setPlanItems(['']);
    // 任务树全不选 + 该节点 selected=true
    setTaskMap(
      Object.fromEntries(
        latestNodes.map((n) => [n.id, { progressAfter: n.progress, selected: n.id === nodeId }]),
      ),
    );
    setEditingReportId(null);
    setEditingReport(null);
    setOpen(true);
  };

  /** 查看完整周报（用户反馈⑤：列表不再只是摘要） */
  const openDetail = (r: Report): void => {
    setDetail(r);
  };

  /** 编辑已有周报：表单预填，提交走 updateReport（原地更新） */
  const openEditReport = (r: Report): void => {
    reset({
      week: r.week,
      doneNote: r.doneNote,
      resourceNote: r.resourceNote,
      planItems: r.planItems.length ? r.planItems : [''],
      risks: r.risks.map((rk) => ({ description: rk.description, owner: rk.owner, dueDate: rk.dueDate })),
    });
    setPlanItems(r.planItems.length ? r.planItems : ['']);
    setTaskMap(
      Object.fromEntries(r.tasks.map((t) => [t.nodeId, { progressAfter: t.progressAfter, selected: t.selected }])),
    );
    setEditingReportId(r.id);
    // R3-7：保存完整编辑对象，assemble 时 tasks 原样回传
    setEditingReport(r);
    setOpen(true);
  };

  const assemble = (values: FormValues): ReportPayload => ({
    projectId: id,
    // R3-7：编辑态周次以原始报告为准（引擎不更新 week；也规避 disabled 字段丢失）
    week: editingReport ? editingReport.week : values.week,
    doneNote: values.doneNote,
    planItems: planItems.map((p) => p.trim()).filter(Boolean),
    resourceNote: values.resourceNote,
    // ★ R3-7 关键：编辑态原样回传原始 report.tasks（selected / progressAfter 不变），
    //   引擎按 payload.tasks 整体重建 report.tasks，否则关联会被清空
    tasks: editingReport
      ? editingReport.tasks.map<ReportTaskRef>((t) => ({
          nodeId: t.nodeId,
          progressAfter: t.progressAfter,
          selected: t.selected,
        }))
      : nodes.map((n) => ({
          nodeId: n.id,
          progressAfter: taskMap[n.id]?.progressAfter ?? n.progress,
          selected: taskMap[n.id]?.selected ?? false,
        })),
    risks: values.risks,
  });

  const doSave = async (values: FormValues, submit: boolean): Promise<void> => {
    const payload = assemble(values);
    try {
      if (editingReportId) {
        await updateReport(editingReportId, payload);
        toast.success('工作日志已更新');
      } else if (submit) {
        await submitReport(payload);
        toast.success('工作日志已提交');
      } else {
        await saveReport(payload);
        toast.success('工作日志已存草稿');
      }
      setOpen(false);
      setEditingReportId(null);
      setEditingReport(null);
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
    {
      key: 'tasks',
      label: '关联任务',
      width: 90,
      align: 'center',
      // 关联任务数 = 实际勾选关联的任务（与勾选一致，用户反馈⑤）
      render: (r) => <Chip size="small" label={r.tasks.filter((t) => t.selected).length} sx={{ height: 20 }} />,
    },
    { key: 'risks', label: '风险项', width: 80, align: 'center', render: (r) => <Chip size="small" label={r.risks.length} color={r.risks.length ? 'warning' : 'default'} sx={{ height: 20 }} /> },
    { key: 'submittedAt', label: '提交时间', width: 150, render: (r) => <Typography variant="caption" color="text.secondary">{r.submittedAt ? fmtDate(r.submittedAt) : '—'}</Typography> },
    {
      key: 'actions',
      label: '操作',
      width: 120,
      align: 'center',
      render: (r) => (
        <Stack direction="row" spacing={0.5} justifyContent="center">
          <Button size="small" onClick={() => openDetail(r)}>
            查看
          </Button>
          <Button size="small" color="primary" onClick={() => openEditReport(r)}>
            编辑
          </Button>
        </Stack>
      ),
    },
  ];

  /** WBS 树形勾选（用户反馈⑤：树形关联，保留勾选 + 进度逻辑；R3-7 编辑态只读） */
  const renderTaskTree = (list: WbsTreeNode[], depth: number): JSX.Element[] =>
    list.map((n) => {
      const t = taskMap[n.id] ?? { progressAfter: n.progress, selected: false };
      const readOnly = Boolean(editingReport);
      return (
        <Box key={n.id} sx={{ pl: depth * 2 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', py: 0.25 }}>
            <input
              type="checkbox"
              checked={t.selected}
              disabled={readOnly}
              onChange={(e) => setTaskMap((m) => ({ ...m, [n.id]: { ...t, selected: e.target.checked } }))}
              style={{ accentColor: tokens.brand.primary }}
            />
            <Typography sx={{ fontSize: 13, flex: '1 1 160px', minWidth: 0 }} noWrap>
              {n.wbsCode} {n.name}
            </Typography>
            <Box sx={{ width: 90 }}>
              <ProgressBar value={n.progress} height={5} showLabel={false} />
            </Box>
            <TextField
              type="number"
              label="完%"
              size="small"
              value={t.progressAfter}
              disabled={readOnly}
              onChange={(e) => setTaskMap((m) => ({ ...m, [n.id]: { ...t, progressAfter: Number(e.target.value) } }))}
              sx={{ width: 92 }}
              InputProps={{ inputProps: { min: 0, max: 100 } }}
            />
          </Stack>
          {n.children && n.children.length > 0 && renderTaskTree(n.children, depth + 1)}
        </Box>
      );
    });

  return (
    <Stack spacing={2.5}>
      <PageHeader
        title="工作日志"
        subtitle="按周记录进展，可多次提交并连续跟踪每个任务进度；同周可提交多条"
        actions={
          <PermissionButton
            action="report:write"
            disabledReason={archived ? '项目已归档' : ''}
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            onClick={openCreate}
          >
            新建日志
          </PermissionButton>
        }
      />

      <SectionCard flush>
        {loading && reports.length === 0 ? (
          <LoadingState variant="skeleton" rows={4} height={48} />
        ) : reports.length === 0 ? (
          <EmptyState title="暂无工作日志" description="点击右上角「新建日志」记录本周进展" />
        ) : (
          <DataTable<Report> columns={columns} rows={reports} rowKey={(r) => r.id} />
        )}
      </SectionCard>

      <FormDialog
        open={open}
        title={editingReportId ? `编辑工作日志 · ${project?.name ?? ''}` : `新建工作日志 · ${project?.name ?? ''}`}
        submitText="提交"
        maxWidth="md"
        onClose={() => {
          setOpen(false);
          setEditingReportId(null);
          setEditingReport(null);
        }}
        onSubmit={handleSubmit((v) => void doSave(v, true))}
        extraActions={
          <Button color="inherit" onClick={handleSubmit((v) => void doSave(v, false))}>
            存草稿
          </Button>
        }
      >
        {/* R3-7：编辑态周次只读展示 + 隐藏 input 保持注册（disabled 会丢值，不参与提交） */}
        {editingReport ? (
          <>
            <input type="hidden" {...register('week')} />
            <Typography variant="body2" sx={{ py: 1 }}>
              周次：{watch('week')}
            </Typography>
          </>
        ) : (
          <TextField select label="周次" {...register('week')} fullWidth error={Boolean(errors.week)} helperText={errors.week?.message}>
            {weekOptions.map((w) => (
              <MenuItem key={w} value={w}>
                {w}
              </MenuItem>
            ))}
          </TextField>
        )}

        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{REPORT_SECTION_TITLE.done}</Typography>
          <TextField label="补充说明（对照计划的完成情况）" {...register('doneNote')} fullWidth multiline minRows={2} placeholder="本周按计划完成了哪些关键事项" />
          {/* R3-6：任务关联区固定标题；编辑态追加只读说明 */}
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1, mb: 0.5 }}>
            <Typography variant="subtitle2">{REPORT_SECTION_TITLE.taskAssoc}</Typography>
            {editingReport && (
              <Typography variant="caption" color="text.secondary">
                编辑已提交日志时该区域只读
              </Typography>
            )}
          </Stack>
          <Box sx={{ maxHeight: 320, overflowY: 'auto', border: `1px solid ${tokens.border.subtle}`, borderRadius: 1.5, p: 1 }}>
            {tree.length === 0 ? (
              <Typography variant="caption" color="text.secondary">
                暂无 WBS 任务，可先到「工作分解」页建立
              </Typography>
            ) : (
              renderTaskTree(tree, 0)
            )}
          </Box>
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
            {risks.fields.map((field, index) => {
              const ownerOpenId = watch(`risks.${index}.owner` as const);
              const dueDateValue = watch(`risks.${index}.dueDate` as const);
              return (
                <Stack key={field.id} spacing={1} sx={{ p: 1, border: `1px solid ${tokens.border.subtle}`, borderRadius: 1.5 }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    {/* R3-7：风险描述编辑态保持可编辑（纯文本）；增删行属结构性修改，编辑态禁用 */}
                    <TextField {...register(`risks.${index}.description` as const)} label="风险描述" fullWidth size="small" error={Boolean(errors.risks?.[index]?.description)} helperText={errors.risks?.[index]?.description?.message} />
                    <IconButton size="small" color="error" onClick={() => risks.remove(index)} disabled={Boolean(editingReport)}>
                      <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Stack>
                  <Stack direction="row" spacing={1}>
                    {editingReport ? (
                      /* R3-7：编辑态责任人 / 截止日只读展示 + 隐藏 input 保持注册（disabled 会丢值） */
                      <>
                        <input type="hidden" {...register(`risks.${index}.owner` as const)} />
                        <input type="hidden" {...register(`risks.${index}.dueDate` as const)} />
                        <Typography variant="body2" sx={{ flex: 1, py: 1 }}>
                          责任人：{memberNameOf(members, ownerOpenId)}（截止 {dueDateValue}）
                        </Typography>
                      </>
                    ) : (
                      <>
                        <TextField {...register(`risks.${index}.owner` as const)} select label="责任人" size="small" sx={{ flex: 1 }} error={Boolean(errors.risks?.[index]?.owner)} helperText={errors.risks?.[index]?.owner?.message}>
                          <MenuItem value="">（未选）</MenuItem>
                          {ownerOptions.map((m) => (
                            <MenuItem key={m.userOpenId} value={m.userOpenId}>
                              {m.userName}
                            </MenuItem>
                          ))}
                        </TextField>
                        <TextField {...register(`risks.${index}.dueDate` as const)} type="date" label="截止日" size="small" sx={{ flex: 1 }} InputLabelProps={{ shrink: true }} error={Boolean(errors.risks?.[index]?.dueDate)} helperText={errors.risks?.[index]?.dueDate?.message} />
                      </>
                    )}
                  </Stack>
                </Stack>
              );
            })}
            <Button startIcon={<AddIcon />} size="small" onClick={() => risks.append({ description: '', owner: '', dueDate: '' })} sx={{ alignSelf: 'flex-start' }} disabled={Boolean(editingReport)}>
              添加风险项
            </Button>
          </Stack>
        </Box>

        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{REPORT_SECTION_TITLE.resource}</Typography>
          <TextField label="需要协调的资源" {...register('resourceNote')} fullWidth multiline minRows={2} placeholder="需要跨团队 / 上级协调的支持" />
        </Box>
      </FormDialog>

      {/* 详情查看：列表不再只是摘要（用户反馈⑤） */}
      <FormDialog
        open={Boolean(detail)}
        title={detail ? `工作日志详情 · ${detail.week}` : '工作日志详情'}
        submitText="关闭"
        maxWidth="md"
        onClose={() => setDetail(null)}
        onSubmit={() => setDetail(null)}
      >
        {detail && (
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} alignItems="center">
              <StatusChip status={detail.status} />
              <Typography variant="caption" color="text.secondary">
                填报人：{detail.authorName}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                提交：{detail.submittedAt ? fmtDate(detail.submittedAt) : '—'}
              </Typography>
            </Stack>
            <Box>
              <Typography variant="subtitle2">{REPORT_SECTION_TITLE.done}</Typography>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                {detail.doneNote || '—'}
              </Typography>
            </Box>
            <Box>
              <Typography variant="subtitle2">{REPORT_SECTION_TITLE.plan}</Typography>
              {detail.planItems.length ? (
                detail.planItems.map((p, i) => (
                  <Typography key={i} variant="body2">
                    · {p}
                  </Typography>
                ))
              ) : (
                <Typography variant="caption" color="text.secondary">
                  —
                </Typography>
              )}
            </Box>
            <Box>
              <Typography variant="subtitle2">
                关联任务（{detail.tasks.filter((t) => t.selected).length}）
              </Typography>
              {detail.tasks.filter((t) => t.selected).length ? (
                detail.tasks
                  .filter((t) => t.selected)
                  .map((t) => (
                    <Stack key={t.nodeId} direction="row" spacing={1} alignItems="center">
                      <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                        {t.nodeName}
                      </Typography>
                      <Chip size="small" label={`${t.progressBefore}% → ${t.progressAfter}%`} />
                    </Stack>
                  ))
              ) : (
                <Typography variant="caption" color="text.secondary">
                  —
                </Typography>
              )}
            </Box>
            <Box>
              <Typography variant="subtitle2">{REPORT_SECTION_TITLE.risks}</Typography>
              {detail.risks.length ? (
                detail.risks.map((rk) => (
                  <Typography key={rk.id} variant="body2">
                    {/* R3-8：责任人显示成员姓名（解析不到显示 openId 原文） */}
                    · {rk.description}（责任人：{memberNameOf(members, rk.owner)}，截止：{rk.dueDate}）
                  </Typography>
                ))
              ) : (
                <Typography variant="caption" color="text.secondary">
                  —
                </Typography>
              )}
            </Box>
            <Box>
              <Typography variant="subtitle2">{REPORT_SECTION_TITLE.resource}</Typography>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                {detail.resourceNote || '—'}
              </Typography>
            </Box>
          </Stack>
        )}
      </FormDialog>
    </Stack>
  );
}
