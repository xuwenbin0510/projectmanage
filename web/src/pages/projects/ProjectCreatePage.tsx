import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AddIcon from '@mui/icons-material/Add';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';

import { FieldRow, PageHeader, SectionCard, UserAvatar } from '@/components/common';
import { api } from '@/api/client';
import type { CreateProjectPayload } from '@/api/contract';
import type {
  ClassifyInput,
  ClassifyResult,
  MilestoneAnchor,
  MilestoneDraft,
  ProjectRole,
  ProjectType,
  User,
} from '@/types/project';
import {
  PROJECT_ROLES,
  PROJECT_ROLE_LABEL,
  PROJECT_TYPES,
  PROJECT_TYPE_LABEL,
  PROJECT_TYPE_SHORT,
  MILESTONE_ANCHOR_LABEL,
  MILESTONE_ANCHORS,
} from '@/config/enums';
import { ROUTES } from '@/config/routes';
import { useAsync, useToast } from '@/hooks';
import { dayjs, today, addDays, DATE_FMT } from '@/utils/date';
import { fmtAmount } from '@/utils/format';
import { classifyProject } from '@/api/mock/rules';

/* ── 表单模型 ─────────────────────────────────────── */

interface MemberDraft {
  userOpenId: string;
  role: ProjectRole;
}

interface CreateForm {
  name: string;
  customer: string;
  contractAmount: number;
  background: string;
  goalText: string;
  planStart: string;
  planEnd: string;
  hasHardware: boolean;
  hasAcceptance: boolean;
  isSelfIteration: boolean;
  isInfrastructure: boolean;
  type: ProjectType;
  overrideReason: string;
  members: MemberDraft[];
  /** 里程碑草稿；未触碰时由生命周期模板预填 */
  milestones: MilestoneDraft[];
}

const STEPS = ['基本信息', '分类判定', '团队组建', '里程碑规划', '确认提交'] as const;

const baseSchema = z.object({
  name: z.string().trim().min(2, '项目名称至少 2 个字'),
  customer: z.string().trim(),
  contractAmount: z.number().min(0, '合同额不能为负数'),
  background: z.string().trim().min(5, '项目背景至少 5 个字'),
  goalText: z.string().trim().min(2, '至少填写 1 条项目目标'),
  planStart: z.string().min(1, '请选择计划开始日期'),
  planEnd: z.string().min(1, '请选择计划结束日期'),
});

const EMPTY_FORM: CreateForm = {
  name: '',
  customer: '',
  contractAmount: 0,
  background: '',
  goalText: '',
  planStart: today(),
  planEnd: addDays(today(), 90),
  hasHardware: false,
  hasAcceptance: false,
  isSelfIteration: true,
  isInfrastructure: false,
  type: 'B',
  overrideReason: '',
  members: [],
  milestones: [],
};

/** 取里程碑草稿的下一个编号：M{现有 code 数字后缀最大值 + 1} */
function nextMilestoneCode(list: MilestoneDraft[]): string {
  const max = list.reduce((acc, d) => {
    const m = /(\d+)\s*$/.exec(d.code ?? '');
    return m ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return `M${max + 1}`;
}

/**
 * 新建项目向导：基本信息 → 分类判定 → 团队组建 → 里程碑规划 → 确认提交
 * @prd P0-01 P0-02
 * 规则：覆盖系统分类建议必须写理由；PM / TL 各且仅 1 人；B 类必须有 PO。
 * 同一人可担任多个角色，成员唯一键为「人 + 角色」复合键。
 */
export function ProjectCreatePage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();

  const [step, setStep] = useState<number>(0);
  const [form, setForm] = useState<CreateForm>({ ...EMPTY_FORM });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<boolean>(false);
  /** 用户是否动过里程碑（动过之后模板预填不再覆盖） */
  const [msTouched, setMsTouched] = useState<boolean>(false);
  const [msLoading, setMsLoading] = useState<boolean>(false);
  /** 当前分类模板的阶段（U-13：里程碑「归属阶段」下拉选项 = 模板 stage code） */
  const [tplStages, setTplStages] = useState<Array<{ code: string; name: string }>>([]);
  const [classifyResult, setClassifyResult] = useState<ClassifyResult>(() =>
    classifyProject({
      contractAmount: 0,
      hasHardware: false,
      hasAcceptance: false,
      isSelfIteration: true,
      isInfrastructure: false,
    }),
  );

  const { data: users } = useAsync<User[]>(() => api.listUsers(), []);
  const userList: User[] = users ?? [];

  const classifyInput: ClassifyInput = useMemo(
    () => ({
      contractAmount: form.contractAmount,
      hasHardware: form.hasHardware,
      hasAcceptance: form.hasAcceptance,
      isSelfIteration: form.isSelfIteration,
      isInfrastructure: form.isInfrastructure,
    }),
    [
      form.contractAmount,
      form.hasHardware,
      form.hasAcceptance,
      form.isSelfIteration,
      form.isInfrastructure,
    ],
  );

  /** 分类输入变化 → 实时请求判定建议，并把 type 同步到建议值（用户手动覆盖后保留覆盖） */
  useEffect(() => {
    let alive = true;
    api
      .classify(classifyInput)
      .then((res) => {
        if (!alive) return;
        setClassifyResult(res);
        setForm((f) => (f.type === res.suggested ? f : { ...f, type: res.suggested, overrideReason: '' }));
      })
      .catch(() => {
        if (alive) setClassifyResult(classifyProject(classifyInput));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classifyInput]);

  /**
   * 里程碑预填：分类 / 计划开始日期变化时按生命周期模板重算。
   * 用户一旦动过（msTouched）就不再覆盖；模板缺失或请求失败降级为空列表，不阻断向导。
   */
  useEffect(() => {
    if (msTouched) return;
    // 计划开始被清空 / 非法时不预填，避免算出 "Invalid Date"；用户填回合法日期后会自动重跑
    if (!form.planStart || !dayjs(form.planStart).isValid()) return;
    let alive = true;
    setMsLoading(true);
    api
      .getLifecycleTemplate(form.type)
      .then((tpl) => {
        if (!alive) return;
        const defs = tpl?.definition.milestones ?? [];
        setTplStages((tpl?.definition.stages ?? []).map((s) => ({ code: s.code, name: s.name })));
        setForm((f) => ({
          ...f,
          milestones: defs.map((d) => ({
            code: d.code,
            name: d.name,
            target: '',
            date: addDays(f.planStart, d.offsetDays),
            // U-12 模板预填带出锚点：A 类模板有 anchorStage/anchor，B/C 无则留空（安全默认）
            stageCode: d.anchorStage ?? null,
            anchor: d.anchor ?? null,
          })),
        }));
      })
      .catch(() => {
        if (alive) setForm((f) => ({ ...f, milestones: [] }));
      })
      .finally(() => {
        // 改动 B 回归修复(P2-2)：loading 标记幂等，无条件清除；
        // 否则模板请求在途时 effect 因 msTouched 翻 true 早退 + cleanup 置 alive=false，
        // 旧请求 settle 时 setMsLoading(false) 不触发 → spinner 永久卡住、重置按钮永久置灰。
        setMsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [form.type, form.planStart, msTouched]);

  const patch = (p: Partial<CreateForm>): void => setForm((f) => ({ ...f, ...p }));

  const goals: string[] = form.goalText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const pmMember = form.members.find((m) => m.role === 'pm');
  const tlCount = form.members.filter((m) => m.role === 'tl').length;
  const pmCount = form.members.filter((m) => m.role === 'pm').length;
  const hasPo = form.members.some((m) => m.role === 'po');
  const isOverride = form.type !== classifyResult.suggested;

  const nameOf = (openId: string): string => userList.find((u) => u.openId === openId)?.name ?? openId;

  /* ── 分步校验 ────────────────────────────────── */

  /**
   * 纯函数收集校验错误（只 return，不 setState）。
   * `target` = 即将进入的步骤索引；guard 累积式：0 基本 / 1 分类 / 2 团队 / 3 里程碑 / 4 确认。
   * 提交时需要同步读取错误来决定回跳步骤，因此不能依赖异步的 errors state。
   */
  const collectErrors = (target: number): Record<string, string> => {
    const next: Record<string, string> = {};

    if (target >= 1) {
      const parsed = baseSchema.safeParse({
        name: form.name,
        customer: form.customer,
        contractAmount: form.contractAmount,
        background: form.background,
        goalText: form.goalText,
        planStart: form.planStart,
        planEnd: form.planEnd,
      });
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          next[String(issue.path[0] ?? 'name')] = issue.message;
        }
      }
      if (form.planStart && form.planEnd && dayjs(form.planEnd).isBefore(dayjs(form.planStart), 'day')) {
        next.planEnd = '计划结束日期不能早于开始日期';
      }
    }

    if (target >= 2 && isOverride && !form.overrideReason.trim()) {
      next.overrideReason = '覆盖系统分类建议时必须填写理由（会写入审计日志）';
    }

    if (target >= 3) {
      // 复合键防御：同一人可担任多个角色，但「同一人 + 同一角色」不能重复
      const keys = form.members.map((m) => `${m.userOpenId}::${m.role}`);
      if (new Set(keys).size !== keys.length) next.members = '同一成员的同一角色不能重复添加';
      else if (pmCount !== 1) next.members = '项目经理（PM）有且仅有 1 人';
      else if (tlCount !== 1) next.members = '技术负责人（TL）有且仅有 1 人';
      else if (form.type === 'B' && !hasPo) next.members = 'B 类（产品型）项目必须指定产品负责人（PO）';
    }

    if (target >= 4) {
      // 里程碑不硬校验数量（允许全部清空）；单条要求名称与日期非空，越界日期只给软提示
      const bad = form.milestones.findIndex((d) => !d.name.trim() || !d.date);
      if (bad >= 0) next.milestones = `第 ${bad + 1} 条里程碑的名称与计划日期均为必填`;
    }

    return next;
  };

  const validateStep = (target: number): boolean => {
    const next = collectErrors(target);
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleNext = (): void => {
    if (!validateStep(step + 1)) return;
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const handleBack = (): void => {
    setErrors({});
    setStep((s) => Math.max(s - 1, 0));
  };

  /** 按「人 + 角色」组合挑选下一个候选：优先补齐关键角色，兜底扫描全部组合 */
  const addMember = (): void => {
    const used = new Set(form.members.map((m) => `${m.userOpenId}::${m.role}`));
    const desired: ProjectRole = pmCount === 0 ? 'pm' : tlCount === 0 ? 'tl' : 'member';

    let hit: User | undefined = userList.find((u) => !used.has(`${u.openId}::${desired}`));
    let role: ProjectRole = desired;

    if (!hit) {
      const combos: Array<{ user: User; role: ProjectRole }> = [];
      for (const u of userList) {
        for (const r of PROJECT_ROLES) combos.push({ user: u, role: r });
      }
      const found = combos.find((c) => !used.has(`${c.user.openId}::${c.role}`));
      if (found) {
        hit = found.user;
        role = found.role;
      }
    }

    if (!hit) {
      toast.warning('所有「成员 + 角色」组合都已用尽');
      return;
    }
    patch({ members: [...form.members, { userOpenId: hit.openId, role }] });
  };

  const updateMember = (index: number, p: Partial<MemberDraft>): void => {
    patch({ members: form.members.map((m, i) => (i === index ? { ...m, ...p } : m)) });
  };

  const removeMember = (index: number): void => {
    patch({ members: form.members.filter((_, i) => i !== index) });
  };

  /* ── 里程碑草稿编辑（任何改动都会锁定 msTouched，防止预填 effect 覆盖） ── */

  const updateMilestoneDraft = (index: number, p: Partial<MilestoneDraft>): void => {
    setMsTouched(true);
    setForm((f) => ({
      ...f,
      milestones: f.milestones.map((d, i) => (i === index ? { ...d, ...p } : d)),
    }));
  };

  const addMilestoneDraft = (): void => {
    setMsTouched(true);
    setForm((f) => {
      const last = f.milestones[f.milestones.length - 1];
      return {
        ...f,
        milestones: [
          ...f.milestones,
          {
            code: nextMilestoneCode(f.milestones),
            name: '',
            target: '',
            date: last?.date || f.planStart,
            // U-15 用户新增里程碑默认不锚定，可稍后在里程碑页补选
            stageCode: null,
            anchor: null,
          },
        ],
      };
    });
  };

  const removeMilestoneDraft = (index: number): void => {
    setMsTouched(true);
    setForm((f) => ({ ...f, milestones: f.milestones.filter((_, i) => i !== index) }));
  };

  /** 解锁 msTouched 即可触发预填 effect 重新按模板生成 */
  const resetMilestonesToTemplate = (): void => {
    setErrors((e) => {
      if (!e.milestones) return e;
      const rest = { ...e };
      delete rest.milestones;
      return rest;
    });
    setMsTouched(false);
  };

  /** 日期落在计划周期之外 —— 仅软提示，不拦截提交 */
  const isMsDateOutOfRange = (d: MilestoneDraft): boolean => {
    if (!d.date || !form.planStart || !form.planEnd) return false;
    const day = dayjs(d.date);
    return day.isBefore(dayjs(form.planStart), 'day') || day.isAfter(dayjs(form.planEnd), 'day');
  };

  /* ── 提交 ────────────────────────────────────── */

  const handleSubmit = async (): Promise<void> => {
    const nextErrors = collectErrors(4);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setStep(nextErrors.milestones ? 3 : nextErrors.members ? 2 : nextErrors.overrideReason ? 1 : 0);
      return;
    }
    const payload: CreateProjectPayload = {
      name: form.name.trim(),
      type: form.type,
      customer: form.customer.trim(),
      contractAmount: form.contractAmount,
      background: form.background.trim(),
      goal: goals,
      planStart: form.planStart,
      planEnd: form.planEnd,
      pm: pmMember?.userOpenId ?? '',
      classifyInput,
      classifySuggested: classifyResult.suggested,
      classifyOverrideReason: isOverride ? form.overrideReason.trim() : '',
      members: form.members.map((m) => ({ userOpenId: m.userOpenId, role: m.role })),
      // 三态：未触碰 → undefined（后端按模板生成）；触碰过 → 数组（[] 即显式清空）
      milestones: msTouched ? form.milestones : undefined,
    };
    setSubmitting(true);
    try {
      const project = await api.createProject(payload);
      toast.success(`项目「${project.name}」已创建，编号 ${project.code}`);
      navigate(ROUTES.projectOverview(project.id));
    } catch (e) {
      toast.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  /* ── 各步内容 ────────────────────────────────── */

  const renderBasic = (): JSX.Element => (
    <Stack spacing={2.25}>
      <TextField
        label="项目名称"
        required
        value={form.name}
        onChange={(e) => patch({ name: e.target.value })}
        error={Boolean(errors.name)}
        helperText={errors.name ?? '建议包含客户 / 产品与阶段，例如「XX 局智慧园区一期」'}
        fullWidth
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField
          label="客户 / 需求方"
          value={form.customer}
          onChange={(e) => patch({ customer: e.target.value })}
          helperText="内部项目可留空"
          fullWidth
        />
        <TextField
          label="合同额（万元）"
          type="number"
          /* 显示层与数据层解耦：0 显示为空串，避免删空后残留 0 造成「05」前导零 */
          value={form.contractAmount || ''}
          onChange={(e) => patch({ contractAmount: Number(e.target.value) || 0 })}
          inputProps={{ min: 0, step: 1 }}
          error={Boolean(errors.contractAmount)}
          helperText={errors.contractAmount ?? '大额但特征不明时建议 A 类，自研迭代优先'}
          fullWidth
        />
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <DatePicker
          label="计划开始"
          value={dayjs(form.planStart)}
          onChange={(v) => patch({ planStart: v ? v.format(DATE_FMT) : '' })}
          slotProps={{ textField: { fullWidth: true, error: Boolean(errors.planStart), helperText: errors.planStart } }}
        />
        <DatePicker
          label="计划结束"
          value={dayjs(form.planEnd)}
          onChange={(v) => patch({ planEnd: v ? v.format(DATE_FMT) : '' })}
          slotProps={{ textField: { fullWidth: true, error: Boolean(errors.planEnd), helperText: errors.planEnd } }}
        />
      </Stack>
      <TextField
        label="项目背景"
        required
        value={form.background}
        onChange={(e) => patch({ background: e.target.value })}
        error={Boolean(errors.background)}
        helperText={errors.background ?? '为什么要做这个项目，解决什么问题'}
        multiline
        minRows={3}
        fullWidth
      />
      <TextField
        label="项目目标（每行一条）"
        required
        value={form.goalText}
        onChange={(e) => patch({ goalText: e.target.value })}
        error={Boolean(errors.goalText)}
        helperText={errors.goalText ?? `已识别 ${goals.length} 条目标，建议可度量`}
        multiline
        minRows={3}
        fullWidth
      />
    </Stack>
  );

  const renderClassify = (): JSX.Element => (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          项目特征（系统据此判定分类）
        </Typography>
        <Stack spacing={0.25}>
          <FormControlLabel
            control={
              <Checkbox checked={form.hasHardware} onChange={(e) => patch({ hasHardware: e.target.checked })} />
            }
            label="包含硬件交付（设备采购 / 集成部署）"
          />
          <FormControlLabel
            control={
              <Checkbox checked={form.hasAcceptance} onChange={(e) => patch({ hasAcceptance: e.target.checked })} />
            }
            label="需要客户正式验收"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={form.isSelfIteration}
                onChange={(e) => patch({ isSelfIteration: e.target.checked })}
              />
            }
            label="自研产品持续迭代"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={form.isInfrastructure}
                onChange={(e) => patch({ isInfrastructure: e.target.checked })}
              />
            }
            label="基础设施建设（机房 / 网络 / 平台底座）"
          />
        </Stack>
        <Typography variant="caption" color="text.secondary">
          合同额 {fmtAmount(form.contractAmount)}（取自上一步，修改请返回基本信息）
        </Typography>
      </Box>

      <Alert severity={isOverride ? 'warning' : 'info'} variant="outlined">
        <AlertTitle sx={{ mb: 0.5 }}>
          系统建议：{PROJECT_TYPE_LABEL[classifyResult.suggested]}
        </AlertTitle>
        <Stack component="ul" spacing={0.25} sx={{ pl: 2.25, my: 0.5 }}>
          {classifyResult.reasons.map((r, i) => (
            <Typography component="li" key={`${r}-${i}`} variant="body2">
              {r}
            </Typography>
          ))}
        </Stack>
      </Alert>

      <Box>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          最终分类（决定生命周期模板与质量门）
        </Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={form.type}
          onChange={(_, v: ProjectType | null) => {
            if (v) patch({ type: v, overrideReason: v === classifyResult.suggested ? '' : form.overrideReason });
          }}
        >
          {PROJECT_TYPES.map((t) => (
            <ToggleButton key={t} value={t} sx={{ px: 2 }}>
              {PROJECT_TYPE_LABEL[t]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      {isOverride && (
        <TextField
          label="覆盖理由（必填，写入审计日志）"
          required
          value={form.overrideReason}
          onChange={(e) => patch({ overrideReason: e.target.value })}
          error={Boolean(errors.overrideReason)}
          helperText={errors.overrideReason ?? `已由「${PROJECT_TYPE_SHORT[classifyResult.suggested]}」改为「${PROJECT_TYPE_SHORT[form.type]}」`}
          multiline
          minRows={2}
          fullWidth
        />
      )}
    </Stack>
  );

  const renderMembers = (): JSX.Element => (
    <Stack spacing={2}>
      <Alert severity="info" variant="outlined">
        角色约束：项目经理（PM）与技术负责人（TL）<strong>各且仅有 1 人</strong>
        {form.type === 'B' ? '；B 类（产品型）项目必须指定产品负责人（PO）' : ''}。
        <br />
        同一人可担任多个角色（如既是 PM 又是 TL），请<strong>分行添加</strong>。
      </Alert>

      {form.members.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          暂未添加成员，请至少指派 PM 与 TL。
        </Typography>
      )}

      <Stack spacing={1.25}>
        {form.members.map((m, i) => (
          <Stack key={`${m.userOpenId}::${m.role}::${i}`} direction="row" spacing={1.25} alignItems="center">
            <UserAvatar name={nameOf(m.userOpenId)} />
            <TextField
              select
              size="small"
              label="成员"
              value={m.userOpenId}
              onChange={(e) => updateMember(i, { userOpenId: e.target.value })}
              sx={{ flex: '1 1 200px', minWidth: 160 }}
            >
              {userList.map((u) => (
                <MenuItem
                  key={u.openId}
                  value={u.openId}
                  disabled={form.members.some(
                    (x, xi) => xi !== i && x.userOpenId === u.openId && x.role === m.role,
                  )}
                >
                  {u.name} · {u.dept}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label="项目角色"
              value={m.role}
              onChange={(e) => updateMember(i, { role: e.target.value as ProjectRole })}
              sx={{ width: 170 }}
            >
              {PROJECT_ROLES.map((r) => (
                <MenuItem
                  key={r}
                  value={r}
                  disabled={form.members.some(
                    (x, xi) => xi !== i && x.userOpenId === m.userOpenId && x.role === r,
                  )}
                >
                  {PROJECT_ROLE_LABEL[r]}
                </MenuItem>
              ))}
            </TextField>
            <IconButton size="small" onClick={() => removeMember(i)} aria-label="移除成员">
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Stack>
        ))}
      </Stack>

      <Box>
        <Button size="small" startIcon={<AddIcon />} onClick={addMember}>
          添加成员
        </Button>
      </Box>

      {errors.members && <Alert severity="error">{errors.members}</Alert>}
    </Stack>
  );

  const renderMilestones = (): JSX.Element => {
    const list = form.milestones;
    const dates = list.map((d) => d.date).filter(Boolean).sort();
    const outOfRangeCount = list.filter(isMsDateOutOfRange).length;

    return (
      <Stack spacing={2}>
        <Alert severity="info" variant="outlined">
          日期已按「计划开始 + <strong>{PROJECT_TYPE_SHORT[form.type]}</strong>模板偏移」预填，可自由增删改。
          全部删除则<strong>创建后不生成里程碑</strong>，可稍后在里程碑页补充。
          每条可选「归属阶段 + 锚点」（A 类模板自动带出；留空不阻断向导，可稍后补选）。
          创建后日期即成为基线，延后需走变更单。
        </Alert>

        {msLoading && (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={16} />
            <Typography variant="body2" color="text.secondary">
              正在按模板预填里程碑…
            </Typography>
          </Stack>
        )}

        {!msLoading && list.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            当前没有里程碑（该分类暂无生效模板，或已被清空）。可点击下方「新增里程碑」手动添加。
          </Typography>
        )}

        <Stack spacing={1.5}>
          {list.map((d, i) => {
            const nameError = !d.name.trim();
            const dateError = !d.date;
            const outOfRange = !dateError && isMsDateOutOfRange(d);
            return (
              <Stack
                key={`${d.code}-${i}`}
                direction={{ xs: 'column', md: 'row' }}
                spacing={1.25}
                alignItems={{ xs: 'stretch', md: 'flex-start' }}
              >
                <Chip size="small" label={d.code || `M${i + 1}`} sx={{ mt: { md: 1 }, minWidth: 52 }} />
                <TextField
                  size="small"
                  label="名称"
                  required
                  value={d.name}
                  onChange={(e) => updateMilestoneDraft(i, { name: e.target.value })}
                  error={nameError}
                  helperText={nameError ? '名称必填' : ' '}
                  sx={{ flex: '1 1 180px', minWidth: 150 }}
                />
                <TextField
                  size="small"
                  label="目标 / 达成标准"
                  value={d.target}
                  placeholder="例：需求规格说明书通过评审并冻结基线"
                  onChange={(e) => updateMilestoneDraft(i, { target: e.target.value })}
                  helperText=" "
                  multiline
                  minRows={2}
                  sx={{ flex: '2 1 260px', minWidth: 200 }}
                />
                <DatePicker
                  label="计划日期"
                  format={DATE_FMT}
                  value={d.date ? dayjs(d.date) : null}
                  onChange={(v) =>
                    updateMilestoneDraft(i, { date: v && v.isValid() ? v.format(DATE_FMT) : '' })
                  }
                  slotProps={{
                    textField: {
                      size: 'small',
                      error: dateError,
                      helperText: dateError ? '日期必填' : outOfRange ? '不在计划周期内' : ' ',
                      sx: { width: { xs: '100%', md: 178 }, flexShrink: 0 },
                    },
                  }}
                />
                {/* U-13 归属阶段 + 锚点：选项 = 所选分类模板的阶段 code；留空不阻断向导 */}
                <TextField
                  select
                  size="small"
                  label="归属阶段（可选）"
                  value={d.stageCode ?? ''}
                  onChange={(e) =>
                    updateMilestoneDraft(i, {
                      stageCode: e.target.value || null,
                      anchor: e.target.value ? d.anchor : null,
                    })
                  }
                  helperText={d.stageCode ? ' ' : '可稍后在里程碑页补选'}
                  sx={{ width: { xs: '100%', md: 148 }, flexShrink: 0 }}
                >
                  <MenuItem value="">
                    <Typography variant="body2" color="text.secondary">未归属</Typography>
                  </MenuItem>
                  {tplStages.map((s) => (
                    <MenuItem key={s.code} value={s.code}>
                      {s.code} {s.name}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  select
                  size="small"
                  label="锚点（可选）"
                  value={d.anchor ?? ''}
                  disabled={!d.stageCode}
                  onChange={(e) =>
                    updateMilestoneDraft(i, { anchor: (e.target.value as MilestoneAnchor) || null })
                  }
                  helperText={!d.stageCode ? '先选归属阶段' : ' '}
                  sx={{ width: { xs: '100%', md: 148 }, flexShrink: 0 }}
                >
                  <MenuItem value="">
                    <Typography variant="body2" color="text.secondary">未指定</Typography>
                  </MenuItem>
                  {MILESTONE_ANCHORS.map((a) => (
                    <MenuItem key={a} value={a}>
                      {MILESTONE_ANCHOR_LABEL[a]}
                    </MenuItem>
                  ))}
                </TextField>
                <IconButton
                  size="small"
                  onClick={() => removeMilestoneDraft(i)}
                  aria-label="删除里程碑"
                  sx={{ mt: { md: 0.5 }, alignSelf: { xs: 'flex-end', md: 'flex-start' } }}
                >
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Stack>
            );
          })}
        </Stack>

        <Stack direction="row" spacing={1}>
          <Button size="small" startIcon={<AddIcon />} onClick={addMilestoneDraft}>
            新增里程碑
          </Button>
          <Button size="small" color="inherit" onClick={resetMilestonesToTemplate} disabled={msLoading}>
            重置为模板
          </Button>
        </Stack>

        {outOfRangeCount > 0 && (
          <Alert severity="warning" variant="outlined">
            有 <strong>{outOfRangeCount}</strong> 条里程碑的日期不在计划周期（{form.planStart} ~ {form.planEnd}）内，
            仅作提醒，不影响提交。
          </Alert>
        )}

        {errors.milestones && <Alert severity="error">{errors.milestones}</Alert>}

        <Typography variant="caption" color="text.secondary">
          共 {list.length} 条
          {dates.length > 0 ? ` · 最早 ${dates[0]} ~ 最晚 ${dates[dates.length - 1]}` : ''}
          {msTouched ? ' · 已自定义（切换分类不会覆盖）' : ' · 跟随模板自动更新'}
        </Typography>
      </Stack>
    );
  };

  const renderConfirm = (): JSX.Element => (
    <Stack spacing={1.75}>
      <FieldRow label="项目名称">{form.name}</FieldRow>
      <FieldRow label="项目分类">
        <Stack direction="row" spacing={1} alignItems="center">
          <Chip size="small" label={PROJECT_TYPE_LABEL[form.type]} />
          {isOverride && <Chip size="small" color="warning" variant="outlined" label="已覆盖系统建议" />}
        </Stack>
      </FieldRow>
      {isOverride && <FieldRow label="覆盖理由">{form.overrideReason}</FieldRow>}
      <FieldRow label="客户">{form.customer || '内部项目'}</FieldRow>
      <FieldRow label="合同额">{fmtAmount(form.contractAmount)}</FieldRow>
      <FieldRow label="计划周期">
        {form.planStart} ~ {form.planEnd}
      </FieldRow>
      <FieldRow label="项目目标">
        <Stack component="ol" spacing={0.25} sx={{ pl: 2.25, my: 0 }}>
          {goals.map((g, i) => (
            <Typography component="li" key={`${g}-${i}`} variant="body2">
              {g}
            </Typography>
          ))}
        </Stack>
      </FieldRow>
      <Divider />
      <FieldRow label="里程碑规划">
        {form.milestones.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            未规划（创建后可在里程碑页补充）
          </Typography>
        ) : (
          <Stack spacing={0.25}>
            {form.milestones.map((d, i) => (
              <Typography key={`${d.code}-${i}`} variant="body2">
                {d.code || `M${i + 1}`} {d.name || `里程碑 ${i + 1}`} · {d.date}
                {d.stageCode ? ` · ${d.stageCode}${d.anchor ? `（${MILESTONE_ANCHOR_LABEL[d.anchor]}）` : ''}` : ' · 未归属阶段'}
                {d.target ? ` · 目标：${d.target}` : ''}
              </Typography>
            ))}
          </Stack>
        )}
      </FieldRow>
      <Divider />
      <FieldRow label="项目团队">
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {form.members.map((m) => (
            <Chip
              key={`${m.userOpenId}-${m.role}`}
              size="small"
              variant="outlined"
              label={`${nameOf(m.userOpenId)} · ${PROJECT_ROLE_LABEL[m.role]}`}
            />
          ))}
        </Stack>
      </FieldRow>
      <Alert severity="info" variant="outlined">
        提交后系统会按 <strong>{PROJECT_TYPE_SHORT[form.type]}</strong> 模板自动实例化阶段与质量门；
        {msTouched ? (
          form.milestones.length > 0 ? (
            <>
              里程碑按你上一步的规划<strong>自定义创建 {form.milestones.length} 条</strong>。
            </>
          ) : (
            <>
              <strong>本次不创建里程碑</strong>，可在里程碑页补充。
            </>
          )
        ) : (
          <>
            里程碑按 <strong>{PROJECT_TYPE_SHORT[form.type]}</strong> 模板生成{' '}
            <strong>{form.milestones.length}</strong> 条。
          </>
        )}
        项目初始状态为「草稿」，需在概览页发起立项审批。
      </Alert>
    </Stack>
  );

  const STEP_RENDER: Array<() => JSX.Element> = [
    renderBasic,
    renderClassify,
    renderMembers,
    renderMilestones,
    renderConfirm,
  ];

  return (
    <Box>
      <PageHeader
        title="新建项目"
        crumbs={[{ label: '项目', to: ROUTES.projects }, { label: '新建' }]}
        subtitle="分类决定生命周期：A 类交付型 / B 类产品型 / C 类基建型"
      />

      <SectionCard>
        <Stepper activeStep={step} alternativeLabel sx={{ mb: 3.5 }}>
          {STEPS.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {STEP_RENDER[step]()}

        <Divider sx={{ my: 3 }} />

        <Stack direction="row" spacing={1.25} justifyContent="flex-end">
          <Button color="inherit" onClick={() => navigate(ROUTES.projects)} disabled={submitting}>
            取消
          </Button>
          <Button color="inherit" onClick={handleBack} disabled={step === 0 || submitting}>
            上一步
          </Button>
          {step < STEPS.length - 1 ? (
            <Button variant="contained" onClick={handleNext}>
              下一步
            </Button>
          ) : (
            <Button variant="contained" onClick={() => void handleSubmit()} disabled={submitting}>
              {submitting ? '创建中…' : '创建项目'}
            </Button>
          )}
        </Stack>
      </SectionCard>
    </Box>
  );
}
