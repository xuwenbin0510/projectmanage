import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { FormDialog, ProgressBar } from '@/components/common';
import type { Report, ReportTaskRef } from '@/types/report';
import type { WbsTreeNode } from '@/types/wbs';
import type { ReportPayload } from '@/api/contract';
import { useProjectStore } from '@/stores/projectStore';
import { useWbsStore } from '@/stores/wbsStore';
import { useFlowStore } from '@/stores/flowStore';
import { useToast } from '@/hooks';
import { REPORT_SECTION_TITLE } from '@/config/enums';
import { dayjs, weekCode, shiftWeek } from '@/utils/date';
import { tokens, progressToneOf } from '@/theme/tokens';
import { memberNameOf } from '@/utils/member';
import { flattenTree, parentIdSet } from '@/utils/wbs';

interface TaskProgress {
  progressAfter: number;
  selected: boolean;
}

/* ── R5 统一文案（设计 §8.2：逐字使用，禁止改写） ── */
/** 弹窗任务树父节点行 Tooltip */
const PARENT_ROW_TIP = '该任务已有下级，进度由子任务加权汇总，请在子任务中记录';
/** 任务关联区统一说明（新建态恒显） */
const PARENT_SECTION_TIP = '父任务进度由子任务汇总，不可直接勾选';
/** lockNodeId 指向非叶子时的降级提示（D-2：caption，不弹 toast） */
const LOCK_DOWNGRADED_TIP = '该任务已有下级，请到具体子任务记录进度';

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

export interface ReportFormModalProps {
  /** 是否打开 */
  open: boolean;
  projectId: string;
  /** 编辑目标；null/undefined = 新建 */
  editingReport?: Report | null;
  /**
   * R4-P0-4 新建态预关联锁定节点 id（WBS 入口传入）：
   * checkbox `checked + disabled` + 锁图标 + tooltip「由「写日志」进入，该任务已锁定；可继续勾选其他任务」；
   * 仅锁定关联关系，进度值输入保持可编辑；可额外勾选其他任务。
   *
   * R5-P0-3（AC-3.8）：若该 id 指向的节点**已有子节点**，自动降级为不锁定
   * （见 `effectiveLockNodeId`），并在任务关联区 caption 提示，保护 ReportsPage 旧链接兼容路径。
   */
  lockNodeId?: string | null;
  /**
   * 提交成功回调（组件 resolve 后按 keepOpenOnSubmit 决定行为）：
   * - true：保持打开并重置（周次默认本周、锁定任务不变）→ 连续添加；
   * - false：调用 onClose 关闭。
   *
   * R5-P0-1：WBS / ReportsPage **两入口均传 `false`**（提交与存草稿后一律关窗）；
   * `keepOpenOnSubmit` 分支作为「连续填报」备用能力保留，不删除、不新增第二个开关。
   */
  onSubmitted: (report: Report) => void;
  keepOpenOnSubmit?: boolean;
  onClose: () => void;
}

/**
 * R4-P0-4 共享工作日志表单 Modal（WBS 页内写日志 / ReportsPage 新建/编辑双入口复用）。
 *
 * 内部数据源（沿用页面直连 store 惯例）：
 * - useProjectStore: members（风险责任人下拉）、current?.name（标题）
 * - useWbsStore: nodes / tree（任务树勾选数据源；父节点行进度条用存储 progress，D2 回写后=汇总）
 * - useFlowStore: saveReport / submitReport / updateReport（提交后 store 自动刷新 reports）
 *
 * 内部状态：RHF(zod schema) + planItems 本地数组 + risks useFieldArray + taskMap，均从 ReportsPage 原样迁移。
 */
export function ReportFormModal({
  open,
  projectId,
  editingReport = null,
  lockNodeId = null,
  onSubmitted,
  keepOpenOnSubmit = false,
  onClose,
}: ReportFormModalProps): JSX.Element {
  const toast = useToast();
  const project = useProjectStore((s) => s.current);
  const members = useProjectStore((s) => s.members);
  const tree = useWbsStore((s) => s.tree);

  const saveReport = useFlowStore((s) => s.saveReport);
  const submitReport = useFlowStore((s) => s.submitReport);
  const updateReport = useFlowStore((s) => s.updateReport);

  const [taskMap, setTaskMap] = useState<Record<string, TaskProgress>>({});
  // planItems 为基础字符串数组，直接用本地状态管理（避免原始数组进入 useFieldArray 的类型约束）
  const [planItems, setPlanItems] = useState<string[]>(['']);

  const weekOptions = useMemo(() => buildWeekOptions(weekCode(dayjs())), []);

  /* ── R5-P0-3 派生值（叶子口径唯一入口 SK-4：只走 utils/wbs，禁止自写循环 / nodeType 判定） ── */
  /** 有子节点的父节点 id 集合（渲染层口径，与 tree 同源） */
  const parentIds = useMemo(() => parentIdSet(flattenTree(tree)), [tree]);
  /** AC-3.8：lockNodeId 指向非叶子时降级为不锁定；渲染与 taskMap 初始化统一用它 */
  const effectiveLockNodeId = useMemo(
    () => (lockNodeId && !parentIds.has(lockNodeId) ? lockNodeId : null),
    [lockNodeId, parentIds],
  );
  /** 锁定被降级（仅用于区域 caption 提示，D-2：不弹 toast） */
  const lockDowngraded = Boolean(lockNodeId) && !effectiveLockNodeId;

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

  const risks = useFieldArray<FormValues, 'risks'>({ control, name: 'risks' });

  /** 从 store 取最新扁平节点（打开 / 重置时 nodes 闭包可能陈旧） */
  const latestNodesOf = (): ReturnType<typeof useWbsStore.getState>['nodes'] => useWbsStore.getState().nodes;

  // 打开时初始化表单（编辑态回填；新建态全不选 + lockNodeId 锁定勾选）
  useEffect(() => {
    if (!open) return;
    if (editingReport) {
      reset({
        week: editingReport.week,
        doneNote: editingReport.doneNote,
        resourceNote: editingReport.resourceNote,
        planItems: editingReport.planItems.length ? editingReport.planItems : [''],
        risks: editingReport.risks.map((rk) => ({ description: rk.description, owner: rk.owner, dueDate: rk.dueDate })),
      });
      setPlanItems(editingReport.planItems.length ? editingReport.planItems : ['']);
      setTaskMap(
        Object.fromEntries(
          editingReport.tasks.map((t) => [t.nodeId, { progressAfter: t.progressAfter, selected: t.selected }]),
        ),
      );
    } else {
      const latestNodes = latestNodesOf();
      reset({ week: weekOptions[0], doneNote: '', resourceNote: '', planItems: [''], risks: [] });
      setPlanItems(['']);
      setTaskMap(
        Object.fromEntries(
          latestNodes.map((n) => [n.id, { progressAfter: n.progress, selected: n.id === effectiveLockNodeId }]),
        ),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * 新建态任务行组装（★ R5-P0-3 数据一致性契约 · 设计 §3.3 唯一真源）：
   * - 父节点：`selected` 恒 false、`progressAfter` 恒等于提交前存储值
   *   → 引擎 `upsertReport` 的写入退化为**幂等无副作用写**，随后 `syncWbsProgressStatus`
   *     照常按真叶子加权回算，父节点进度只有 `rollupProgressFlat` 一个来源（AC-3.5/3.6/3.7/3.10）；
   * - 叶子：行为完全不变（AC-3.4）。
   *
   * ⚠️ 父子判定在此**重新**基于 `latestNodesOf()` 求取，与 payload 数组严格同源，
   *    避免与渲染用的 `parentIds`（tree 源）在极端刷新时序下漂移。
   */
  const buildNewTaskRefs = (): ReportTaskRef[] => {
    const latest = latestNodesOf();
    const latestParentIds = parentIdSet(latest);
    return latest.map<ReportTaskRef>((n) => {
      const isParent = latestParentIds.has(n.id);
      return {
        nodeId: n.id,
        progressAfter: isParent ? n.progress : (taskMap[n.id]?.progressAfter ?? n.progress),
        selected: isParent ? false : (taskMap[n.id]?.selected ?? false),
      };
    });
  };

  const assemble = (values: FormValues): ReportPayload => ({
    projectId,
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
      : buildNewTaskRefs(),
    risks: values.risks,
  });

  const doSave = async (values: FormValues, submit: boolean): Promise<void> => {
    const payload = assemble(values);
    try {
      let saved: Report;
      if (editingReport) {
        saved = await updateReport(editingReport.id, payload);
        toast.success('工作日志已更新');
      } else if (submit) {
        saved = await submitReport(payload);
        toast.success('工作日志已提交');
      } else {
        saved = await saveReport(payload);
        toast.success('工作日志已存草稿');
      }
      onSubmitted(saved);
      if (keepOpenOnSubmit) {
        // R4-P0-4：保持打开并重置（周次默认本周、任务全不选 + 锁定任务保留勾选、计划/风险清空）→ 连续添加
        const latestNodes = latestNodesOf();
        const progressByNode = new Map(payload.tasks.map((t) => [t.nodeId, t.progressAfter]));
        reset({ week: weekOptions[0], doneNote: '', resourceNote: '', planItems: [''], risks: [] });
        setPlanItems(['']);
        setTaskMap(
          Object.fromEntries(
            latestNodes.map((n) => [
              n.id,
              { progressAfter: progressByNode.get(n.id) ?? n.progress, selected: n.id === effectiveLockNodeId },
            ]),
          ),
        );
      } else {
        onClose();
      }
    } catch (e) {
      toast.error(e);
    }
  };

  /**
   * WBS 树形勾选（R4-P0-4：新建态 lockNodeId 锁定勾选 + 锁图标；编辑态只读）。
   *
   * R5-P0-3：父节点行「禁用可见」——checkbox 与「完%」`disabled` + Tooltip 解释（AC-3.3），
   * 叶子行行为完全不变（AC-3.4）。
   * ⚠️ 不变量：本轮**只动 `disabled` 与文案，绝不动 `checked`**，否则历史父节点关联
   *    在编辑态会被显示成未勾选（违反 AC-3.9 存量如实展示）。
   */
  const renderTaskTree = (list: WbsTreeNode[], depth: number): JSX.Element[] =>
    list.map((n) => {
      const t = taskMap[n.id] ?? { progressAfter: n.progress, selected: false };
      const readOnly = Boolean(editingReport);
      const locked = !editingReport && effectiveLockNodeId === n.id;
      /** 有子节点 = 父节点：进度纯由子任务加权汇总，不可勾选、不可录入 */
      const hasChildren = parentIds.has(n.id);
      const checkbox = (
        <input
          type="checkbox"
          checked={t.selected || locked}
          disabled={readOnly || locked || hasChildren}
          onChange={(e) => setTaskMap((m) => ({ ...m, [n.id]: { ...t, selected: e.target.checked } }))}
          style={{ accentColor: tokens.brand.primary }}
        />
      );
      return (
        <Box key={n.id} sx={{ pl: depth * 2 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', py: 0.25 }}>
            {/* disabled input 不触发 hover，父节点行必须套 span 才能出 Tooltip（布局不跳动） */}
            {hasChildren ? (
              <Tooltip title={PARENT_ROW_TIP} arrow>
                <span style={{ display: 'inline-flex' }}>{checkbox}</span>
              </Tooltip>
            ) : (
              checkbox
            )}
            {locked && (
              <Tooltip title="由「写日志」进入，该任务已锁定；可继续勾选其他任务" arrow>
                <LockOutlinedIcon sx={{ fontSize: 14, color: tokens.text.secondary, flexShrink: 0 }} />
              </Tooltip>
            )}
            <Typography
              sx={{ fontSize: 13, flex: '1 1 160px', minWidth: 0, color: hasChildren ? 'text.secondary' : undefined }}
              noWrap
            >
              {n.wbsCode} {n.name}
            </Typography>
            {/* R4-P0-5：进度条包 Tooltip + 状态色调（ReportsPage 树部分） */}
            <Tooltip title={`${n.name} ${n.progress}%（${n.status}）`} arrow>
              <Box sx={{ width: 90 }}>
                <ProgressBar value={n.progress} height={5} showLabel={false} tone={progressToneOf(n.status)} />
              </Box>
            </Tooltip>
            <TextField
              type="number"
              label="完%"
              size="small"
              value={t.progressAfter}
              /* R5-P0-3：父节点「完%」禁用，灰显当前汇总值（AC-3.3） */
              disabled={readOnly || hasChildren}
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
    <FormDialog
      open={open}
      title={editingReport ? `编辑工作日志 · ${project?.name ?? ''}` : `新建工作日志 · ${project?.name ?? ''}`}
      submitText="提交"
      maxWidth="md"
      onClose={onClose}
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
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          {REPORT_SECTION_TITLE.done}
        </Typography>
        <TextField
          label="补充说明（对照计划的完成情况）"
          {...register('doneNote')}
          fullWidth
          multiline
          minRows={2}
          placeholder="本周按计划完成了哪些关键事项"
        />
        {/* R3-6：任务关联区固定标题；编辑态追加只读说明；新建态 lockNodeId 追加锁定说明 */}
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1, mb: 0.5 }}>
          <Typography variant="subtitle2">{REPORT_SECTION_TITLE.taskAssoc}</Typography>
          {editingReport && (
            <Typography variant="caption" color="text.secondary">
              编辑已提交日志时该区域只读
            </Typography>
          )}
          {!editingReport && effectiveLockNodeId && (
            <Typography variant="caption" color="text.secondary">
              由「写日志」进入，预关联任务已锁定；可继续勾选其他任务
            </Typography>
          )}
          {/* R5-P0-3：新建态恒显父节点规则说明（AC-3.3） */}
          {!editingReport && (
            <Typography variant="caption" color="text.secondary">
              {PARENT_SECTION_TIP}
            </Typography>
          )}
          {/* AC-3.8：lockNodeId 指向非叶子 → 降级不锁定 + 行内提示（D-2：不弹 toast） */}
          {!editingReport && lockDowngraded && (
            <Typography variant="caption" color="text.secondary">
              {LOCK_DOWNGRADED_TIP}
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
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          {REPORT_SECTION_TITLE.plan}
        </Typography>
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
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          {REPORT_SECTION_TITLE.risks}
        </Typography>
        <Stack spacing={1}>
          {risks.fields.map((field, index) => {
            const ownerOpenId = watch(`risks.${index}.owner` as const);
            const dueDateValue = watch(`risks.${index}.dueDate` as const);
            return (
              <Stack key={field.id} spacing={1} sx={{ p: 1, border: `1px solid ${tokens.border.subtle}`, borderRadius: 1.5 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  {/* R3-7：风险描述编辑态保持可编辑（纯文本）；增删行属结构性修改，编辑态禁用 */}
                  <TextField
                    {...register(`risks.${index}.description` as const)}
                    label="风险描述"
                    fullWidth
                    size="small"
                    error={Boolean(errors.risks?.[index]?.description)}
                    helperText={errors.risks?.[index]?.description?.message}
                  />
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
                      <TextField
                        {...register(`risks.${index}.owner` as const)}
                        select
                        label="责任人"
                        size="small"
                        sx={{ flex: 1 }}
                        error={Boolean(errors.risks?.[index]?.owner)}
                        helperText={errors.risks?.[index]?.owner?.message}
                      >
                        <MenuItem value="">（未选）</MenuItem>
                        {Array.from(new Map(members.map((m) => [m.userOpenId, m])).values()).map((m) => (
                          <MenuItem key={m.userOpenId} value={m.userOpenId}>
                            {m.userName}
                          </MenuItem>
                        ))}
                      </TextField>
                      <TextField
                        {...register(`risks.${index}.dueDate` as const)}
                        type="date"
                        label="截止日"
                        size="small"
                        sx={{ flex: 1 }}
                        InputLabelProps={{ shrink: true }}
                        error={Boolean(errors.risks?.[index]?.dueDate)}
                        helperText={errors.risks?.[index]?.dueDate?.message}
                      />
                    </>
                  )}
                </Stack>
              </Stack>
            );
          })}
          <Button
            startIcon={<AddIcon />}
            size="small"
            onClick={() => risks.append({ description: '', owner: '', dueDate: '' })}
            sx={{ alignSelf: 'flex-start' }}
            disabled={Boolean(editingReport)}
          >
            添加风险项
          </Button>
        </Stack>
      </Box>

      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          {REPORT_SECTION_TITLE.resource}
        </Typography>
        <TextField
          label="需要协调的资源"
          {...register('resourceNote')}
          fullWidth
          multiline
          minRows={2}
          placeholder="需要跨团队 / 上级协调的支持"
        />
      </Box>
    </FormDialog>
  );
}
