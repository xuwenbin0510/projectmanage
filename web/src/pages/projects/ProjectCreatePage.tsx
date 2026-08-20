import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
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
import type { ClassifyInput, ClassifyResult, LifecycleTemplate, ProjectRole, ProjectType, TemplateTeamRule, User } from '@/types/project';
import {
  PROJECT_ROLES,
  PROJECT_ROLE_LABEL,
  PROJECT_TYPES,
  PROJECT_TYPE_LABEL,
  PROJECT_TYPE_SHORT,
} from '@/config/enums';
import { ROUTES } from '@/config/routes';
import { useAsync, useToast } from '@/hooks';
import { dayjs, today, diffDays, DATE_FMT, fitMilestoneDatesEx } from '@/utils/date';
import type { FitMilestoneDatesResult } from '@/utils/date';
import { fmtAmount } from '@/utils/format';
import { tokens } from '@/theme/tokens';
import { classifyProject } from '@/api/mock/rules';

/* ── 表单模型 ─────────────────────────────────────── */

interface MemberDraft {
  userOpenId: string;
  role: ProjectRole;
}

/** 向导里程碑草稿（用户反馈①：模板带出 + 可改名称/日期 + 可新增） */
interface MilestoneDraft {
  code: string;
  name: string;
  target: string;
  date: string;
  /** 模板血缘语义（R3-1：字段保留写入引擎，页面不再展示「必备」UI） */
  required: boolean;
  gate: { code: string; name: string; ownerRole: string; items: Array<{ content: string; ownerRole: string }> } | null;
  /** 模板原始偏移天数；用户手动新增的碑为 undefined（重算时按旧周期反推） */
  offsetDays?: number;
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
  /** 里程碑规划草稿（由模板带出，用户可改 / 可新增） */
  milestones: MilestoneDraft[];
}

const STEPS = ['基本信息', '分类判定', '里程碑规划', '团队组建', '确认提交'] as const;

/** 按团队约束规则检查成员；不满足返回错误文案，满足返回 null（与后端 assertMemberCardinality 同口径） */
function checkTeamRules(members: MemberDraft[], rules: TemplateTeamRule[]): string | null {
  for (const rule of rules) {
    const count = members.filter((m) => m.role === rule.role).length;
    const min = Number(rule.min) || 0;
    const maxRaw = Number(rule.max);
    const max = maxRaw === -1 ? Infinity : maxRaw;
    if (count < min || count > max) {
      if (rule.role === 'po' && count === 0 && min === 1) return '模板要求必须指定产品负责人（PO）';
      return `模板要求角色「${PROJECT_ROLE_LABEL[rule.role]}」${min}~${maxRaw === -1 ? '不限' : maxRaw} 人，当前 ${count} 人`;
    }
  }
  return null;
}

/** 团队约束的展示文案（用于提示 Alert 与确认页） */
function teamRuleLabel(r: TemplateTeamRule): string {
  return `${PROJECT_ROLE_LABEL[r.role]} ${r.min}~${r.max === -1 ? '不限' : r.max} 人`;
}

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
  planEnd: today(),
  hasHardware: false,
  hasAcceptance: false,
  isSelfIteration: true,
  isInfrastructure: false,
  type: 'B',
  overrideReason: '',
  members: [],
  milestones: [],
};

/**
 * 新建项目向导：基本信息 → 分类判定 → 团队组建 → 确认提交
 * @prd P0-01 P0-02
 * 规则：覆盖系统分类建议必须写理由；PM / TL 各且仅 1 人；B 类必须有 PO。
 * 同一人可担任多个角色，成员唯一键为「人 + 角色」复合键。
 *
 * 简化方案一（Q-1/Q-2）：里程碑与质量门由生命周期模板**静默生成**，
 * 向导不再配置里程碑（创建后在里程碑页自由增删改）。
 */
export function ProjectCreatePage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();

  const [step, setStep] = useState<number>(0);
  const [form, setForm] = useState<CreateForm>({ ...EMPTY_FORM });
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** 已据以构建里程碑草稿的「分类::模板id」组合（变化时才重建，避免覆盖用户编辑） */
  const [tplBuiltFor, setTplBuiltFor] = useState<string>('');
  /** 方案A：当前分类的全部启用模板（version DESC，下拉数据源） */
  const [templateOptions, setTemplateOptions] = useState<LifecycleTemplate[]>([]);
  /** 方案A：向导中显式选中的模板 id（空 = 未选择，走系统默认） */
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  /** 生成里程碑时采用过的计划周期（用于检测周期变更是否需重算，P0-M5） */
  const [builtPeriod, setBuiltPeriod] = useState<{ start: string; end: string }>({ start: '', end: '' });
  /** 最近一次里程碑日期压缩结果（含压缩比 / 堆叠标志，供透明化提示 P1-M11/M12） */
  const [fitInfo, setFitInfo] = useState<FitMilestoneDatesResult | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
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

  /* ── 里程碑规划草稿：进入里程碑步骤时按「分类 + 显式选中的模板」带出（用户反馈① + 方案A） ──
   * 仅在「分类或模板」变化（tplBuiltFor !== `${type}::${templateId}`）时重建，避免覆盖用户编辑。
   * 模板下拉数据源 = 该分类全部启用模板（version DESC），默认选中最新；切换模板即时重渲染。
   * 日期 = planStart + 模板偏移；用户在向导中可改名称 / 日期、可新增。
   */
  useEffect(() => {
    if (step !== 2) return;
    const key = `${form.type}::${selectedTemplateId}`;
    if (tplBuiltFor === key) return; // 分类 / 模板未变（含仅周期变化）→ 不重建，保留用户编辑
    const { planStart, planEnd } = form;
    let alive = true;
    api
      .listTemplateOptions(form.type)
      .then((opts) => {
        if (!alive) return;
        setTemplateOptions(opts);
        // 生效模板：选中项仍在该分类启用列表 → 用之；否则默认最新（version DESC 第一个）
        const tpl = opts.find((t) => t.id === selectedTemplateId) ?? opts[0] ?? null;
        if (selectedTemplateId !== (tpl?.id ?? '')) setSelectedTemplateId(tpl?.id ?? '');
        if (!tpl) {
          setTplBuiltFor(key);
          return; // 该分类无启用模板 → 保持空里程碑，用户手工填写
        }
        const offsets = tpl.definition.milestones.map((md) => md.offsetDays);
        const fit = fitMilestoneDatesEx(planStart, planEnd, offsets); // ★ 不再直算 addDays
        const specs: MilestoneDraft[] = tpl.definition.milestones.map((md, i) => ({
          code: md.code,
          name: md.name,
          target: '',
          date: fit.dates[i],
          required: md.required,
          offsetDays: md.offsetDays,
          gate: md.gate
            ? {
                code: md.gate.code,
                name: md.gate.name,
                ownerRole: md.gate.ownerRole,
                items: md.gate.items.map((it) => ({ content: it.content, ownerRole: it.ownerRole })),
              }
            : null,
        }));
        setForm((f) => ({ ...f, milestones: specs }));
        setFitInfo(fit);
        setBuiltPeriod({ start: planStart, end: planEnd });
        setTplBuiltFor(`${form.type}::${tpl.id}`);
      })
      .catch(() => {
        if (alive) setTplBuiltFor(key);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, form.type, selectedTemplateId, tplBuiltFor, form.planStart, form.planEnd]);

  const patch = (p: Partial<CreateForm>): void => setForm((f) => ({ ...f, ...p }));

  const goals: string[] = form.goalText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const pmMember = form.members.find((m) => m.role === 'pm');
  const tlCount = form.members.filter((m) => m.role === 'tl').length;
  const pmCount = form.members.filter((m) => m.role === 'pm').length;
  const isOverride = form.type !== classifyResult.suggested;
  /** 方案A：当前选中的模板对象（下拉展示用） */
  const selectedTpl = templateOptions.find((t) => t.id === selectedTemplateId) ?? null;
  /** 团队约束：模板 definition.team 优先，缺省回落系统默认（PM/TL 各恰 1；B 类另需 PO 恰 1） */
  const teamRules: TemplateTeamRule[] = useMemo(() => {
    if (selectedTpl?.definition.team?.length) return selectedTpl.definition.team;
    const defs: TemplateTeamRule[] = [
      { role: 'pm', min: 1, max: 1 },
      { role: 'tl', min: 1, max: 1 },
      ...(form.type === 'B' ? [{ role: 'po' as ProjectRole, min: 1, max: 1 }] : []),
    ];
    return defs;
  }, [selectedTpl, form.type]);

  const nameOf = (openId: string): string => userList.find((u) => u.openId === openId)?.name ?? openId;

  /* ── 分步校验 ────────────────────────────────── */

  /**
   * 纯函数收集校验错误（只 return，不 setState）。
   * `target` = 即将进入的步骤索引；guard 累积式：0 基本 / 1 分类 / 2 里程碑 / 3 团队 / 4 确认。
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
      // 里程碑规划：每个里程碑名称与计划日期必填（用户反馈①）
      form.milestones.forEach((m, i) => {
        if (!m.name.trim()) next[`milestone-${i}`] = '名称必填';
        else if (!m.date) next[`milestone-${i}`] = '计划日期必填';
      });
      if (form.milestones.some((m) => !m.name.trim() || !m.date)) {
        next.milestones = '请完善里程碑规划（每个里程碑的名称与计划日期必填）';
      }
    }

    if (target >= 4) {
      // 复合键防御：同一人可担任多个角色，但「同一人 + 同一角色」不能重复
      const keys = form.members.map((m) => `${m.userOpenId}::${m.role}`);
      if (new Set(keys).size !== keys.length) next.members = '同一成员的同一角色不能重复添加';
      else {
        // 团队约束：读模板 definition.team（缺省回落系统默认，与后端 assertMemberCardinality 同口径）
        const ruleMsg = checkTeamRules(form.members, teamRules);
        if (ruleMsg) next.members = ruleMsg;
      }
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

  /* ── 提交 ────────────────────────────────────── */

  const handleSubmit = async (): Promise<void> => {
    const nextErrors = collectErrors(4);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setStep(nextErrors.members ? 3 : nextErrors.milestones ? 2 : nextErrors.overrideReason ? 1 : 0);
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
      templateId: selectedTemplateId || undefined,
      members: form.members.map((m) => ({ userOpenId: m.userOpenId, role: m.role })),
      milestones: form.milestones.map((m) => ({
        code: m.code,
        name: m.name.trim(),
        target: m.target.trim(),
        date: m.date,
        required: m.required,
        gate: m.gate,
      })),
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
        helperText={errors.name ?? '建议包含客户 / 产品，例如「XX 局智慧园区一期」'}
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
          最终分类（决定生命周期模板与默认里程碑）
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
        团队约束（{selectedTpl ? `模板「${selectedTpl.name}」` : '系统默认'}）：{teamRules.map(teamRuleLabel).join('；')}。
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
      <FieldRow label="生命周期模板">
        {selectedTpl ? `${selectedTpl.name} · v${selectedTpl.version}` : '系统默认模板'}
      </FieldRow>
      <FieldRow label="团队约束">
        {teamRules.map(teamRuleLabel).join('；')}
      </FieldRow>
      <FieldRow label="里程碑">
        {form.milestones.length} 个里程碑 · 创建后可在里程碑页自由增删改
      </FieldRow>
      <Divider />
      <Alert severity="info" variant="outlined">
        提交后系统按所选模板（{PROJECT_TYPE_SHORT[form.type]} 类）生成里程碑（向导中已规划，可在此后继续增删改）；
        项目初始状态为「草稿」，需在概览页发起立项审批。
      </Alert>
    </Stack>
  );

  /* ── 计划周期变更检测 + 重算（P0-M5，不静默覆盖用户已手改的日期） ── */
  const periodDirty =
    step === 2 &&
    form.milestones.length > 0 &&
    Boolean(builtPeriod.start) &&
    (form.planStart !== builtPeriod.start || form.planEnd !== builtPeriod.end);

  const recalcMilestoneDates = (): void => {
    /* 模板碑用原始 offsetDays；用户手动新增的碑无 offsetDays，按相对旧 planStart 的天数反推 */
    const offsets = form.milestones.map(
      (m) => m.offsetDays ?? Math.max(0, diffDays(builtPeriod.start, m.date)),
    );
    const fit = fitMilestoneDatesEx(form.planStart, form.planEnd, offsets);
    patch({ milestones: form.milestones.map((m, i) => ({ ...m, date: fit.dates[i] })) });
    setFitInfo(fit);
    setBuiltPeriod({ start: form.planStart, end: form.planEnd });
  };

  const renderMilestones = (): JSX.Element => (
    <Stack spacing={2}>
      {/* 方案A：显式选择生命周期模板（该分类全部启用模板，默认最新；切换即时重渲染里程碑） */}
      <Stack spacing={0.75}>
        <Typography variant="subtitle2">生命周期模板（决定默认里程碑）</Typography>
        <TextField
          select
          size="small"
          fullWidth
          value={selectedTemplateId}
          onChange={(e) => setSelectedTemplateId(e.target.value)}
          disabled={templateOptions.length === 0}
          helperText={
            templateOptions.length === 0
              ? '该分类暂无启用模板，可手工填写里程碑（不阻断提交）'
              : `${selectedTpl?.definition.milestones.length ?? 0} 个里程碑 · 创建后可在里程碑页自由增删改`
          }
        >
          {templateOptions.map((t) => (
            <MenuItem key={t.id} value={t.id}>
              {t.name} · v{t.version}
              {t.id === templateOptions[0]?.id ? '（默认）' : ''}
            </MenuItem>
          ))}
        </TextField>
      </Stack>
      <Alert severity="info" variant="outlined">
        默认里程碑由所选模板带出，可修改<strong>名称 / 计划日期</strong>，
        可自由增删；也支持新增里程碑。
      </Alert>
      {periodDirty && (
        <Alert severity="warning" variant="outlined"
          action={<Button size="small" onClick={recalcMilestoneDates}>按新周期重算日期</Button>}>
          计划周期已调整为 {form.planStart} ~ {form.planEnd}，当前里程碑日期仍按旧周期生成。
          点击重算会按新周期等比调整全部日期，<strong>你手动修改过的日期会被覆盖</strong>。
        </Alert>
      )}
      {fitInfo?.compressed && (
        <Alert severity="info" variant="outlined">
          计划周期 {fitInfo.planDays} 天 &lt; 模板跨度 {fitInfo.templateSpan} 天，
          里程碑日期已按 <strong>{(fitInfo.ratio * 100).toFixed(1)}%</strong> 等比压缩，节奏保持不变。
        </Alert>
      )}
      {fitInfo?.stacked && (
        <Alert severity="warning" variant="outlined">
          计划周期过短（{fitInfo.planDays} 天），{form.milestones.length} 个里程碑无法完全错开，
          存在同日里程碑。建议延长周期或删减里程碑。<strong>不影响提交</strong>。
        </Alert>
      )}
      <Stack spacing={1.5}>
        {form.milestones.map((m, i) => (
          <Box
            key={`${m.code}-${i}`}
            sx={{ p: 1.5, border: `1px solid ${tokens.border.subtle}`, borderRadius: 1.5 }}
          >
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems="flex-start">
              <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography variant="subtitle2">{m.code}</Typography>
                </Stack>
                <TextField
                  label="里程碑名称"
                  value={m.name}
                  onChange={(e) =>
                    patch({
                      milestones: form.milestones.map((x, xi) => (xi === i ? { ...x, name: e.target.value } : x)),
                    })
                  }
                  error={Boolean(errors[`milestone-${i}`])}
                  fullWidth
                  size="small"
                />
              </Box>
              <DatePicker
                label="计划日期"
                value={m.date ? dayjs(m.date) : null}
                format={DATE_FMT}
                slotProps={{
                  textField: { size: 'small', fullWidth: true, error: Boolean(errors[`milestone-${i}`]) },
                }}
                onChange={(v) =>
                  patch({
                    milestones: form.milestones.map((x, xi) =>
                      xi === i ? { ...x, date: v && v.isValid() ? v.format(DATE_FMT) : '' } : x,
                    ),
                  })
                }
              />
              <IconButton
                size="small"
                color="error"
                onClick={() => patch({ milestones: form.milestones.filter((_, xi) => xi !== i) })}
                aria-label="删除里程碑"
              >
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Stack>
          </Box>
        ))}
      </Stack>
      <Box>
        <Button
          size="small"
          startIcon={<AddIcon />}
          onClick={() =>
            patch({
              milestones: [
                ...form.milestones,
                {
                  code: `M${form.milestones.length + 1}`,
                  name: '',
                  target: '',
                  date: form.planStart,
                  required: false,
                  gate: null,
                },
              ],
            })
          }
        >
          添加里程碑
        </Button>
      </Box>
      {errors.milestones && <Alert severity="error">{errors.milestones}</Alert>}
    </Stack>
  );

  const STEP_RENDER: Array<() => JSX.Element> = [
    renderBasic,
    renderClassify,
    renderMilestones,
    renderMembers,
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
