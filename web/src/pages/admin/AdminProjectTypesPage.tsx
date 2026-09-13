import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';

import {
  DataTable,
  LoadingState,
  PageHeader,
  PermissionButton,
  PermissionGate,
  SectionCard,
} from '@/components/common';
import type { Column } from '@/components/common';
import { AdminTabs } from './AdminTabs';
import { TemplateEditorDialog } from '@/components/admin/TemplateEditorDialog';
import type {
  CreateReviewTemplatePayload,
  CreateTemplatePayload,
  LifecycleTemplate,
  ProjectTypeEntity,
  ReviewTemplateConfig,
  Role,
  UpdateReviewTemplatePayload,
} from '@/types/project';
import type { ReviewMode } from '@/types/review';
import { api } from '@/api/client';
import { useProjectTypes, useToast } from '@/hooks';

/** 新增弹窗的「空白起步」哨兵值（与后端约定一致） */
const BLANK_SOURCE = '__blank__';

/** 审批流模式展示文案 */
const MODE_LABEL: Record<ReviewMode, string> = {
  serial: '串行逐级',
  parallel_veto: '并行一票否决',
  single: '单人决议',
};

/** 审批流语义前缀（与后端 `project:<code>` / `ccb:<code>` 约定一致） */
const REVIEW_KINDS = [
  { prefix: 'project', label: '立项审批', suffixHint: 'project' },
  { prefix: 'ccb', label: '变更评审', suffixHint: 'ccb' },
] as const;

/** 「一键创建默认链」用的兜底链（与后端种子口径近似） */
const DEFAULT_CHAIN: Record<string, string[]> = {
  project: ['pmo', 'tl', 'management'],
  ccb: ['pm', 'tl', 'po'],
};

/** 新增项目类型弹窗表单 */
interface CreateForm {
  name: string;
  example: string;
  /** 克隆来源（`BLANK_SOURCE` = 空白起步） */
  cloneFrom: string;
}

/** 编辑抽屉「基本信息」表单 */
interface InfoForm {
  name: string;
  example: string;
  orderNo: number;
  enabled: boolean;
}

/** 审批流编辑弹窗表单 */
interface ReviewForm {
  /** 完整 key（新增时不可改；编辑时为既有 key） */
  key: string;
  label: string;
  mode: ReviewMode;
  chain: string[];
  description: string;
  /** true = 新建（key 只读但会用于创建） */
  isNew: boolean;
}

/** 取某类型的「当前生效」生命周期模板（`is_active=1`，版本倒序首个） */
function activeTemplateOf(templates: LifecycleTemplate[], code: string): LifecycleTemplate | null {
  const list = templates
    .filter((t) => t.projectType === code && t.isActive)
    .sort((a, b) => b.version - a.version);
  return list[0] ?? null;
}

/** 取某 key 的审批模板（不限启用态） */
function reviewOf(templates: ReviewTemplateConfig[], key: string): ReviewTemplateConfig | null {
  return templates.find((t) => t.key === key) ?? null;
}

/**
 * 管理后台 · 项目类型（表驱动 · 对齐草案 §四）
 *
 * 一个「项目类型」= ①基本信息 ②生命周期模板（1:1，`lifecycle_templates.project_type=code`）
 * ③审批流（立项 `project:<code>` + 变更 `ccb:<code>`）。
 * **停用而非删除**：仅提供 `enabled` 切换；停用不触碰历史项目。
 * 权限 = `admin:template`（与生命周期 / 审批模板同域，设计 §7-10）。
 */
export function AdminProjectTypesPage(): JSX.Element {
  const toast = useToast();
  /** 后台增改类型后刷新全站类型目录（标签即时同步） */
  const { reload: reloadTypeCatalog } = useProjectTypes();

  const [types, setTypes] = useState<ProjectTypeEntity[]>([]);
  const [templates, setTemplates] = useState<LifecycleTemplate[]>([]);
  const [reviewTemplates, setReviewTemplates] = useState<ReviewTemplateConfig[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);

  /* 新增弹窗 */
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>({ name: '', example: '', cloneFrom: BLANK_SOURCE });
  const [creating, setCreating] = useState(false);

  /* 编辑抽屉 */
  const [editing, setEditing] = useState<ProjectTypeEntity | null>(null);
  const [infoForm, setInfoForm] = useState<InfoForm>({ name: '', example: '', orderNo: 0, enabled: true });
  const [savingInfo, setSavingInfo] = useState(false);
  const [cloneTplFrom, setCloneTplFrom] = useState<string>('');

  /* 生命周期模板编辑器（复用既有 TemplateEditorDialog） */
  const [editTemplate, setEditTemplate] = useState<LifecycleTemplate | null>(null);

  /* 审批流编辑器 */
  const [reviewForm, setReviewForm] = useState<ReviewForm | null>(null);
  const [savingReview, setSavingReview] = useState(false);

  const roleNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    roles.forEach((r) => {
      map[r.roleKey] = r.name;
    });
    return map;
  }, [roles]);

  const roleOptions = useMemo(
    () => roles.filter((r) => r.enabled).sort((a, b) => a.orderNo - b.orderNo),
    [roles],
  );

  const load = useCallback((): void => {
    setLoading(true);
    /* 角色目录用 meta/roles（仅登录可读）：admin/roles 对 management 会 403 */
    Promise.all([
      api.listProjectTypes(),
      api.listTemplates(),
      api.listReviewTemplates(),
      api.listSelectableRoles(),
    ])
      .then(([typeList, tplList, reviewList, roleList]) => {
        setTypes([...typeList].sort((a, b) => a.orderNo - b.orderNo));
        setTemplates(tplList);
        setReviewTemplates(reviewList);
        setRoles(roleList);
      })
      .catch((e: unknown) => toast.error(e))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  /* ── 列表列 ─────────────────────────────────── */

  const toggleEnabled = async (t: ProjectTypeEntity): Promise<void> => {
    try {
      const updated = await api.updateProjectType(t.code, { enabled: !t.enabled });
      setTypes((list) => list.map((x) => (x.code === t.code ? updated : x)));
      await reloadTypeCatalog();
      toast.success(`${updated.enabled ? '已启用' : '已停用'}「${updated.name}」`);
    } catch (e) {
      toast.error(e);
      load();
    }
  };

  const columns: Array<Column<ProjectTypeEntity>> = [
    {
      key: 'name',
      label: '名称',
      width: 200,
      render: (t) => (
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: 14, fontWeight: 600 }} noWrap title={t.name}>
            {t.name}
          </Typography>
          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
            {t.code}
          </Typography>
        </Box>
      ),
    },
    {
      key: 'example',
      label: '例子',
      width: 200,
      hideBelow: 'md',
      render: (t) => (
        <Typography variant="caption" color="text.secondary">
          {t.example || '—'}
        </Typography>
      ),
    },
    {
      key: 'enabled',
      label: '启用',
      width: 120,
      render: (t) => (
        <PermissionGate action="admin:template" fallback="disable">
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Switch size="small" checked={t.enabled} onChange={() => void toggleEnabled(t)} />
            <Typography variant="caption" sx={{ color: t.enabled ? 'success.main' : 'text.secondary' }}>
              {t.enabled ? '启用' : '停用'}
            </Typography>
          </Stack>
        </PermissionGate>
      ),
    },
    {
      key: 'orderNo',
      label: '排序',
      width: 70,
      align: 'center',
      hideBelow: 'md',
      render: (t) => <Typography variant="caption">{t.orderNo}</Typography>,
    },
    {
      key: 'binding',
      label: '关联模板摘要',
      width: 220,
      render: (t) => {
        const tpl = activeTemplateOf(templates, t.code);
        const milestoneCount = tpl?.definition.milestones.length ?? 0;
        const gateCount = tpl?.definition.milestones.filter((m) => m.gate).length ?? 0;
        const projectFlow = reviewOf(reviewTemplates, `project:${t.code}`);
        const ccbFlow = reviewOf(reviewTemplates, `ccb:${t.code}`);
        const reviewNodes = (projectFlow?.chain.length ?? 0) + (ccbFlow?.chain.length ?? 0);
        return (
          <Box>
            <Typography variant="caption" color={tpl ? 'text.primary' : 'warning.main'} sx={{ display: 'block' }}>
              {tpl ? `生命周期：${milestoneCount} 碑 / ${gateCount} 门` : '生命周期：尚未配置'}
            </Typography>
            <Typography variant="caption" color={reviewNodes ? 'text.secondary' : 'warning.main'}>
              {reviewNodes ? `审批链：${reviewNodes} 节点` : '审批流：尚未配置'}
            </Typography>
          </Box>
        );
      },
    },
    {
      key: 'actions',
      label: '操作',
      width: 112,
      render: (t) => (
        <Button size="small" startIcon={<EditOutlinedIcon fontSize="small" />} onClick={() => openEditor(t)}>
          编辑
        </Button>
      ),
    },
  ];

  /* ── 新增 ───────────────────────────────────── */

  const submitCreate = async (): Promise<void> => {
    setCreating(true);
    try {
      const created = await api.createProjectType({
        name: createForm.name.trim(),
        example: createForm.example.trim(),
        cloneFrom: createForm.cloneFrom || BLANK_SOURCE,
      });
      toast.success(`已新增项目类型「${created.name}」（${created.code}）`);
      setCreateOpen(false);
      setCreateForm({ name: '', example: '', cloneFrom: BLANK_SOURCE });
      await reloadTypeCatalog();
      load();
    } catch (e) {
      toast.error(e);
    } finally {
      setCreating(false);
    }
  };

  /* ── 编辑抽屉 ───────────────────────────────── */

  const openEditor = (t: ProjectTypeEntity): void => {
    setEditing(t);
    setInfoForm({ name: t.name, example: t.example, orderNo: t.orderNo, enabled: t.enabled });
    setCloneTplFrom('');
  };

  const saveInfo = async (): Promise<void> => {
    if (!editing) return;
    if (!infoForm.name.trim()) {
      toast.error(new Error('类型名称必填'));
      return;
    }
    setSavingInfo(true);
    try {
      const updated = await api.updateProjectType(editing.code, {
        name: infoForm.name.trim(),
        example: infoForm.example.trim(),
        orderNo: Number(infoForm.orderNo) || 0,
        enabled: infoForm.enabled,
      });
      setTypes((list) => list.map((x) => (x.code === updated.code ? updated : x)));
      setEditing(updated);
      await reloadTypeCatalog();
      toast.success('已保存类型基本信息');
    } catch (e) {
      toast.error(e);
    } finally {
      setSavingInfo(false);
    }
  };

  const activeTpl = editing ? activeTemplateOf(templates, editing.code) : null;

  /** 空白新建生命周期模板（该类型）并直接打开编辑器 */
  const createBlankTemplate = async (): Promise<void> => {
    if (!editing) return;
    try {
      const created = await api.createTemplate({
        projectType: editing.code,
        name: `${editing.name}生命周期`,
      });
      setTemplates((list) => [...list, created]);
      setEditTemplate(created);
      toast.success(`已创建「${created.name}」，请在编辑器中配置里程碑`);
    } catch (e) {
      toast.error(e);
    }
  };

  /** 从其他类型克隆生命周期模板（新 id、projectType=当前 code、is_active=1） */
  const cloneTemplateFrom = async (): Promise<void> => {
    if (!editing || !cloneTplFrom) return;
    const src = activeTemplateOf(templates, cloneTplFrom) ?? templates.find((t) => t.projectType === cloneTplFrom);
    if (!src) {
      toast.error(new Error('来源类型没有可用模板'));
      return;
    }
    try {
      const payload: CreateTemplatePayload = {
        projectType: editing.code,
        name: `${editing.name}生命周期（克隆自 ${src.name}）`,
        definition: {
          milestones: src.definition.milestones.map((m) => ({
            ...m,
            gate: m.gate ? { ...m.gate, items: m.gate.items.map((x) => ({ ...x })) } : undefined,
          })),
          docs: src.definition.docs.map((d) => ({ ...d })),
          wbsRules: src.definition.wbsRules,
          team: src.definition.team?.map((r) => ({ ...r })),
        },
      };
      const created = await api.createTemplate(payload);
      setTemplates((list) => [...list, created]);
      setEditTemplate(created);
      setCloneTplFrom('');
      toast.success(`已从「${src.name}」克隆模板`);
    } catch (e) {
      toast.error(e);
    }
  };

  /* ── 审批流编辑 ─────────────────────────────── */

  const openReviewEditor = (kind: string, code: string, label: string): void => {
    const key = `${kind}:${code}`;
    const existing = reviewOf(reviewTemplates, key);
    if (existing) {
      setReviewForm({
        key: existing.key,
        label: existing.label,
        mode: existing.mode,
        chain: [...existing.chain],
        description: existing.description,
        isNew: false,
      });
    } else {
      setReviewForm({
        key,
        label: `${label}链`,
        mode: kind === 'ccb' ? 'serial' : 'serial',
        chain: [...(DEFAULT_CHAIN[kind] ?? [])],
        description: '',
        isNew: true,
      });
    }
  };

  const saveReview = async (): Promise<void> => {
    if (!reviewForm) return;
    if (!reviewForm.label.trim() || reviewForm.chain.length === 0) {
      toast.error(new Error('请填写模板名称并至少配置一个审批节点'));
      return;
    }
    setSavingReview(true);
    try {
      if (reviewForm.isNew) {
        const payload: CreateReviewTemplatePayload = {
          key: reviewForm.key,
          scope: 'project',
          label: reviewForm.label.trim(),
          mode: reviewForm.mode,
          chain: reviewForm.chain,
          description: reviewForm.description,
        };
        const created = await api.createReviewTemplate(payload);
        setReviewTemplates((list) => [...list, created]);
        toast.success(`已创建审批流「${created.label}」`);
      } else {
        const patch: UpdateReviewTemplatePayload = {
          label: reviewForm.label.trim(),
          mode: reviewForm.mode,
          chain: reviewForm.chain,
          description: reviewForm.description,
        };
        const updated = await api.updateReviewTemplate(reviewForm.key, patch);
        setReviewTemplates((list) => list.map((x) => (x.key === updated.key ? updated : x)));
        toast.success(`已更新审批流「${updated.label}」`);
      }
      setReviewForm(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setSavingReview(false);
    }
  };

  const toggleReviewActive = async (tpl: ReviewTemplateConfig): Promise<void> => {
    try {
      const updated = await api.toggleReviewTemplateActive(tpl.key, !tpl.active);
      setReviewTemplates((list) => list.map((x) => (x.key === updated.key ? updated : x)));
      toast.success(`${updated.active ? '已启用' : '已停用'}「${updated.label}」`);
    } catch (e) {
      toast.error(e);
    }
  };

  const addChainNode = (roleKey: string): void => {
    setReviewForm((f) => (f ? { ...f, chain: [...f.chain, roleKey] } : f));
  };
  const removeChainNode = (idx: number): void => {
    setReviewForm((f) => (f ? { ...f, chain: f.chain.filter((_, i) => i !== idx) } : f));
  };
  const moveChainNode = (idx: number, dir: -1 | 1): void => {
    setReviewForm((f) => {
      if (!f) return f;
      const target = idx + dir;
      if (target < 0 || target >= f.chain.length) return f;
      const next = [...f.chain];
      [next[idx], next[target]] = [next[target], next[idx]];
      return { ...f, chain: next };
    });
  };

  /* ── 渲染 ───────────────────────────────────── */

  return (
    <Stack spacing={2.5}>
      <AdminTabs />
      <PageHeader
        title="项目类型"
        subtitle="项目类型是「生命周期模板 + 审批流」的绑定单元；停用而非删除，历史项目不受影响"
        actions={
          <PermissionButton action="admin:template" fallback="disable">
            <Button
              variant="contained"
              size="small"
              startIcon={<AddIcon />}
              onClick={() => setCreateOpen(true)}
            >
              新增项目类型
            </Button>
          </PermissionButton>
        }
      />

      <SectionCard flush>
        {loading ? (
          <LoadingState variant="skeleton" rows={5} height={48} />
        ) : (
          <Box sx={{ p: 1 }}>
            <DataTable<ProjectTypeEntity>
              columns={columns}
              rows={types}
              rowKey={(t) => t.code}
              tableLayout="fixed"
              emptyTitle="暂无项目类型"
              emptyDescription="点击右上角「新增项目类型」创建"
            />
          </Box>
        )}
      </SectionCard>

      {/* 新增项目类型弹窗 */}
      <Dialog open={createOpen} onClose={() => !creating && setCreateOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>新增项目类型</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="名称（必填）"
              size="small"
              fullWidth
              value={createForm.name}
              onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
              helperText="如「预研类」；创建后可在列表中继续调整"
            />
            <TextField
              label="例子 / 说明（选填）"
              size="small"
              fullWidth
              value={createForm.example}
              onChange={(e) => setCreateForm((f) => ({ ...f, example: e.target.value }))}
              helperText="建项时辅助识别，如「技术预研 / 概念验证」"
            />
            <TextField
              select
              label="克隆来源（选填）"
              size="small"
              fullWidth
              value={createForm.cloneFrom}
              onChange={(e) => setCreateForm((f) => ({ ...f, cloneFrom: e.target.value }))}
              helperText="克隆将复制来源类型的生命周期模板与立项 / 变更审批流"
            >
              <MenuItem value={BLANK_SOURCE}>空白起步</MenuItem>
              {types.map((t) => (
                <MenuItem key={t.code} value={t.code}>
                  {t.name}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setCreateOpen(false)} disabled={creating}>
            取消
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => void submitCreate()}
            disabled={creating || !createForm.name.trim()}
          >
            {creating ? '创建中…' : '创建'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* 编辑抽屉（三块：基本信息 / 生命周期模板 / 审批流） */}
      <Drawer
        anchor="right"
        open={editing !== null}
        onClose={() => setEditing(null)}
        PaperProps={{ sx: { width: { xs: '100%', sm: 520 } } }}
      >
        {editing && (
          <Box sx={{ p: 2.5 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
              <Box>
                <Typography variant="h6">编辑项目类型</Typography>
                <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                  {editing.code}
                </Typography>
              </Box>
              <IconButton size="small" onClick={() => setEditing(null)} aria-label="关闭">
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>
            <Divider sx={{ mb: 2.5 }} />

            {/* ① 基本信息 */}
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              ① 基本信息
            </Typography>
            <Stack spacing={2}>
              <TextField
                label="名称"
                size="small"
                fullWidth
                value={infoForm.name}
                onChange={(e) => setInfoForm((f) => ({ ...f, name: e.target.value }))}
              />
              <TextField
                label="例子 / 说明"
                size="small"
                fullWidth
                value={infoForm.example}
                onChange={(e) => setInfoForm((f) => ({ ...f, example: e.target.value }))}
              />
              <Stack direction="row" spacing={2} alignItems="center">
                <TextField
                  label="排序（升序）"
                  type="number"
                  size="small"
                  value={infoForm.orderNo}
                  onChange={(e) => setInfoForm((f) => ({ ...f, orderNo: Number(e.target.value) || 0 }))}
                  sx={{ width: 140 }}
                />
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <Switch
                    size="small"
                    checked={infoForm.enabled}
                    onChange={(e) => setInfoForm((f) => ({ ...f, enabled: e.target.checked }))}
                  />
                  <Typography variant="caption">{infoForm.enabled ? '启用' : '停用'}</Typography>
                </Stack>
              </Stack>
              <Box>
                <PermissionButton action="admin:template" fallback="disable">
                  <Button size="small" variant="contained" onClick={() => void saveInfo()} disabled={savingInfo}>
                    {savingInfo ? '保存中…' : '保存基本信息'}
                  </Button>
                </PermissionButton>
              </Box>
            </Stack>

            <Divider sx={{ my: 2.5 }} />

            {/* ② 生命周期模板（1:1） */}
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
              <Typography variant="subtitle2">② 生命周期模板</Typography>
              <PermissionButton action="admin:template" fallback="disable">
                <Button
                  size="small"
                  startIcon={<EditOutlinedIcon fontSize="small" />}
                  disabled={!activeTpl}
                  onClick={() => setEditTemplate(activeTpl)}
                >
                  编辑当前模板
                </Button>
              </PermissionButton>
            </Stack>
            {activeTpl ? (
              <Stack spacing={1}>
                <Typography variant="body2">
                  {activeTpl.name} · v{activeTpl.version}
                </Typography>
                <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                  <Chip size="small" variant="outlined" label={`${activeTpl.definition.milestones.length} 个里程碑`} sx={{ height: 22 }} />
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`${activeTpl.definition.milestones.filter((m) => m.gate).length} 道质量门`}
                    sx={{ height: 22 }}
                  />
                  <Chip size="small" variant="outlined" label={`${activeTpl.definition.docs.length} 个交付物`} sx={{ height: 22 }} />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  该类型仅维护一条「当前生效」模板（1:1）；点击右侧可编辑里程碑 / 质量门 / 交付物。
                </Typography>
              </Stack>
            ) : (
              <Stack spacing={1.25}>
                <Alert severity="warning" variant="outlined">
                  尚未配置该类型的生命周期模板 —— 建项时会被「类型未配置」闸门拦截。
                </Alert>
                <Stack direction="row" spacing={1.25} flexWrap="wrap" useFlexGap alignItems="center">
                  <PermissionButton action="admin:template" fallback="disable">
                    <Button size="small" variant="outlined" onClick={() => void createBlankTemplate()}>
                      空白新建
                    </Button>
                  </PermissionButton>
                  <TextField
                    select
                    size="small"
                    label="从其他类型克隆"
                    value={cloneTplFrom}
                    onChange={(e) => setCloneTplFrom(e.target.value)}
                    sx={{ minWidth: 180 }}
                  >
                    <MenuItem value="">请选择来源</MenuItem>
                    {types
                      .filter((t) => t.code !== editing.code)
                      .map((t) => (
                        <MenuItem key={t.code} value={t.code}>
                          {t.name}
                        </MenuItem>
                      ))}
                  </TextField>
                  <Button
                    size="small"
                    variant="contained"
                    disabled={!cloneTplFrom}
                    onClick={() => void cloneTemplateFrom()}
                  >
                    克隆
                  </Button>
                </Stack>
              </Stack>
            )}

            <Divider sx={{ my: 2.5 }} />

            {/* ③ 审批流（立项 + 变更） */}
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              ③ 审批流
            </Typography>
            <Stack spacing={1.5}>
              {REVIEW_KINDS.map((k) => {
                const key = `${k.prefix}:${editing.code}`;
                const tpl = reviewOf(reviewTemplates, key);
                return (
                  <Box
                    key={key}
                    sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1.5 }}
                  >
                    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
                      <Box>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {k.label}
                        </Typography>
                        <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                          {key}
                        </Typography>
                      </Box>
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        {tpl && (
                          <Tooltip title={tpl.active ? '停用' : '启用'}>
                            <Switch size="small" checked={tpl.active} onChange={() => void toggleReviewActive(tpl)} />
                          </Tooltip>
                        )}
                        <PermissionButton action="admin:template" fallback="disable">
                          <Button
                            size="small"
                            startIcon={tpl ? <EditOutlinedIcon fontSize="small" /> : <RuleOutlinedIcon fontSize="small" />}
                            onClick={() => openReviewEditor(k.prefix, editing.code, k.label)}
                          >
                            {tpl ? '编辑' : '一键创建默认链'}
                          </Button>
                        </PermissionButton>
                      </Stack>
                    </Stack>
                    {tpl ? (
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        <Chip size="small" variant="outlined" label={MODE_LABEL[tpl.mode]} sx={{ height: 22, fontSize: 12 }} />
                        {tpl.chain.map((r, i) => (
                          <Chip
                            key={`${r}-${i}`}
                            size="small"
                            label={`${i + 1}. ${roleNameMap[r] ?? r}`}
                            sx={{ height: 22, fontSize: 12 }}
                          />
                        ))}
                      </Stack>
                    ) : (
                      <Typography variant="caption" color="warning.main">
                        尚未配置 —— 建项时会被「类型未配置」闸门拦截。
                      </Typography>
                    )}
                  </Box>
                );
              })}
            </Stack>
          </Box>
        )}
      </Drawer>

      {/* 生命周期模板编辑器（复用既有组件） */}
      <TemplateEditorDialog
        open={editTemplate !== null}
        template={editTemplate}
        onClose={() => setEditTemplate(null)}
        onSaved={(t) => setTemplates((list) => list.map((x) => (x.id === t.id ? t : x)))}
      />

      {/* 审批流编辑弹窗 */}
      <Dialog open={reviewForm !== null} onClose={() => !savingReview && setReviewForm(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{reviewForm?.isNew ? '创建审批流' : `编辑审批流 · ${reviewForm?.key}`}</DialogTitle>
        <DialogContent>
          {reviewForm && (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <TextField
                label="模板 Key"
                size="small"
                fullWidth
                value={reviewForm.key}
                disabled
                helperText="由项目类型标识自动生成（project:<code> / ccb:<code>），不可修改"
              />
              <Stack direction="row" spacing={1.5}>
                <TextField
                  label="模板名称（必填）"
                  size="small"
                  fullWidth
                  value={reviewForm.label}
                  onChange={(e) => setReviewForm((f) => (f ? { ...f, label: e.target.value } : f))}
                />
                <TextField
                  select
                  label="模式"
                  size="small"
                  sx={{ minWidth: 160 }}
                  value={reviewForm.mode}
                  onChange={(e) => setReviewForm((f) => (f ? { ...f, mode: e.target.value as ReviewMode } : f))}
                >
                  {Object.entries(MODE_LABEL).map(([k, v]) => (
                    <MenuItem key={k} value={k}>
                      {v}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
                  审批链（按顺序排列；角色可添加、删除、上下移动）
                </Typography>
                {reviewForm.chain.length === 0 && (
                  <Typography variant="caption" color="text.secondary">
                    审批链为空，请从下方添加角色
                  </Typography>
                )}
                <Stack spacing={1} sx={{ mb: 1 }}>
                  {reviewForm.chain.map((role, i) => (
                    <Stack key={`${role}-${i}`} direction="row" spacing={1} alignItems="center">
                      <Typography variant="caption" sx={{ minWidth: 18, color: 'text.secondary' }}>
                        {i + 1}.
                      </Typography>
                      <Chip size="small" label={roleNameMap[role] ?? role} sx={{ minWidth: 110 }} />
                      <Tooltip title="上移">
                        <span>
                          <IconButton size="small" disabled={i === 0} onClick={() => moveChainNode(i, -1)}>
                            <ArrowUpwardIcon sx={{ fontSize: 16 }} />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="下移">
                        <span>
                          <IconButton
                            size="small"
                            disabled={i === reviewForm.chain.length - 1}
                            onClick={() => moveChainNode(i, 1)}
                          >
                            <ArrowDownwardIcon sx={{ fontSize: 16 }} />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <IconButton size="small" onClick={() => removeChainNode(i)} sx={{ color: 'text.secondary' }}>
                        <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Stack>
                  ))}
                </Stack>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {roleOptions
                    .filter((r) => !reviewForm.chain.includes(r.roleKey))
                    .map((r) => (
                      <Chip
                        key={r.roleKey}
                        label={`+ ${r.name}`}
                        size="small"
                        variant="outlined"
                        icon={<AddIcon sx={{ fontSize: 13 }} />}
                        onClick={() => addChainNode(r.roleKey)}
                        sx={{ cursor: 'pointer' }}
                      />
                    ))}
                </Stack>
              </Box>
              <TextField
                label="描述"
                size="small"
                fullWidth
                multiline
                minRows={2}
                value={reviewForm.description}
                onChange={(e) => setReviewForm((f) => (f ? { ...f, description: e.target.value } : f))}
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setReviewForm(null)} disabled={savingReview}>
            取消
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => void saveReview()}
            disabled={savingReview || !reviewForm?.label.trim() || reviewForm.chain.length === 0}
          >
            {savingReview ? '保存中…' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
