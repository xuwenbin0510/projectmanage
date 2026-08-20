import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';

import { DataTable, LoadingState, PageHeader, PermissionButton, SectionCard } from '@/components/common';
import type { Column } from '@/components/common';
import { AdminTabs } from './AdminTabs';
import type { ReviewTemplateConfig, ReviewTemplateScope, CreateReviewTemplatePayload, UpdateReviewTemplatePayload } from '@/types/project';
import type { ReviewMode } from '@/types/review';
import { api } from '@/api/client';
import { useToast } from '@/hooks';
import { CHAIN_ROLE_LABEL, GLOBAL_ROLE_LABEL } from '@/config/enums';

/* ── 展示映射 ─────────────────────────────────────── */

const SCOPE_LABEL: Record<ReviewTemplateScope, string> = { project: '项目类', business: '业务类' };
const MODE_LABEL: Record<ReviewMode, string> = {
  serial: '串行逐级',
  parallel_veto: '并行一票否决',
  single: '单人决议',
};
const ROLE_LABEL: Record<string, string> = { ...CHAIN_ROLE_LABEL, ...GLOBAL_ROLE_LABEL };

/** 审批链可选角色（与服务端 ALLOWED_CHAIN_ROLES 白名单一致，按常见顺序排列） */
const ALL_ROLES: string[] = ['pmo', 'tl', 'management', 'pm', 'po', 'qa', 'cm', 'customer_rep', 'admin', 'member'];

/** 编辑弹窗表单值 */
interface TplForm {
  key: string;
  scope: ReviewTemplateScope;
  label: string;
  mode: ReviewMode;
  chain: string[];
  description: string;
}

const EMPTY_FORM: TplForm = { key: '', scope: 'business', label: '', mode: 'serial', chain: ['pm', 'tl'], description: '' };

/**
 * 管理后台 · 审批配置（阶段二：审批流程可配置）
 *
 * 管理内置审批流：项目类（project:A/B/C/_default 立项链）+ 业务类（正式评审/技术/代码/CCB/PM 审批）。
 * 保存后立即生效：审批引擎 DB 优先读取；停用的模板自动回落默认配置。
 */
export function AdminReviewTemplatesPage(): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<ReviewTemplateConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ReviewTemplateConfig | null>(null);
  const [form, setForm] = useState<TplForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = (): void => {
    setLoading(true);
    api
      .listReviewTemplates()
      .then(setRows)
      .catch((e: unknown) => toast.error(e))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [toast]);

  const openCreate = (): void => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setOpen(true);
  };

  const openEdit = (t: ReviewTemplateConfig): void => {
    setEditing(t);
    setForm({ key: t.key, scope: t.scope, label: t.label, mode: t.mode, chain: [...t.chain], description: t.description });
    setOpen(true);
  };

  const toggleActive = async (t: ReviewTemplateConfig): Promise<void> => {
    try {
      const updated = await api.toggleReviewTemplateActive(t.key, !t.active);
      setRows((list) => list.map((x) => (x.key === t.key ? updated : x)));
      toast.success(`${updated.active ? '已启用' : '已停用'}「${updated.label}」`);
    } catch (e) {
      toast.error(e);
      load();
    }
  };

  const remove = async (t: ReviewTemplateConfig): Promise<void> => {
    if (!window.confirm(`确认删除审批模板「${t.label}」（${t.key}）？存在进行中的审批时将无法删除。`)) return;
    try {
      await api.deleteReviewTemplate(t.key);
      setRows((list) => list.filter((x) => x.key !== t.key));
      toast.success(`已删除「${t.label}」`);
    } catch (e) {
      toast.error(e);
      load();
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      if (editing) {
        const patch: UpdateReviewTemplatePayload = {
          label: form.label.trim(),
          scope: form.scope,
          mode: form.mode,
          chain: form.chain,
          description: form.description,
        };
        const updated = await api.updateReviewTemplate(editing.key, patch);
        setRows((list) => list.map((x) => (x.key === editing.key ? updated : x)));
        toast.success(`已更新「${updated.label}」`);
      } else {
        const payload: CreateReviewTemplatePayload = {
          key: form.key.trim(),
          scope: form.scope,
          label: form.label.trim(),
          mode: form.mode,
          chain: form.chain,
          description: form.description,
        };
        const created = await api.createReviewTemplate(payload);
        setRows((list) => [...list, created]);
        toast.success(`已创建「${created.label}」`);
      }
      setOpen(false);
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  const moveRole = (idx: number, dir: -1 | 1): void => {
    setForm((f) => {
      const next = [...f.chain];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return f;
      [next[idx], next[target]] = [next[target], next[idx]];
      return { ...f, chain: next };
    });
  };

  const columns: Array<Column<ReviewTemplateConfig>> = [
    { key: 'key', label: 'Key', width: 150, render: (t) => <Typography sx={{ fontSize: 13, fontFamily: 'monospace' }}>{t.key}</Typography> },
    {
      key: 'label',
      label: '模板名称',
      width: 190,
      render: (t) => (
        <Box>
          <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{t.label}</Typography>
          {t.description && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.description}
            </Typography>
          )}
        </Box>
      ),
    },
    {
      key: 'scope',
      label: '范围',
      width: 90,
      render: (t) => <Chip label={SCOPE_LABEL[t.scope]} size="small" variant="outlined" sx={{ height: 22, fontSize: 12 }} />,
    },
    {
      key: 'mode',
      label: '模式',
      width: 120,
      hideOnMobile: true,
      render: (t) => <Chip label={MODE_LABEL[t.mode]} size="small" variant="outlined" sx={{ height: 22, fontSize: 12 }} />,
    },
    {
      key: 'chain',
      label: '审批链',
      width: 320,
      render: (t) => (
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
          {t.chain.map((r, i) => (
            <Chip key={`${r}-${i}`} label={`${i + 1}. ${ROLE_LABEL[r] ?? r}`} size="small" sx={{ height: 22, fontSize: 12 }} />
          ))}
        </Stack>
      ),
    },
    {
      key: 'active',
      label: '状态',
      width: 90,
      render: (t) => (
        <PermissionButton action="admin:user:role" fallback="disable">
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Switch size="small" checked={t.active} onChange={() => void toggleActive(t)} />
            <Typography variant="caption" sx={{ color: t.active ? 'success.main' : 'text.secondary' }}>
              {t.active ? '启用' : '停用'}
            </Typography>
          </Stack>
        </PermissionButton>
      ),
    },
    {
      key: 'actions',
      label: '操作',
      width: 90,
      render: (t) => (
        <Stack direction="row" spacing={0.5}>
          <PermissionButton action="admin:user:role" fallback="disable">
            <Tooltip title="编辑">
              <IconButton size="small" onClick={() => openEdit(t)}>
                <EditOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </PermissionButton>
          <PermissionButton action="admin:user:role" fallback="disable">
            <Tooltip title="删除">
              <IconButton size="small" color="error" onClick={() => void remove(t)}>
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </PermissionButton>
        </Stack>
      ),
    },
  ];

  const chainValid = useMemo(() => form.chain.length > 0 && form.chain.every((r) => ALL_ROLES.includes(r)), [form.chain]);

  return (
    <Stack spacing={2.5}>
      <AdminTabs />
      <PageHeader
        title="审批配置"
        subtitle="管理内置审批流程：项目类立项链（A/B/C）与业务类评审链；保存即生效，停用的模板自动回落默认配置"
        actions={
          <PermissionButton action="admin:user:role" fallback="disable">
            <Button variant="contained" size="small" startIcon={<RuleOutlinedIcon />} onClick={openCreate}>
              新增审批模板
            </Button>
          </PermissionButton>
        }
      />
      <SectionCard flush>
        {loading ? (
          <LoadingState variant="skeleton" rows={8} height={48} />
        ) : (
          <Box sx={{ p: 1 }}>
            <DataTable<ReviewTemplateConfig> columns={columns} rows={rows} rowKey={(t) => t.key} />
          </Box>
        )}
      </SectionCard>

      {/* 新增 / 编辑弹窗 */}
      <Dialog open={open} onClose={() => !saving && setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editing ? `编辑审批模板 · ${editing.key}` : '新增审批模板'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {!editing && (
              <TextField
                label="模板 Key（必填）"
                size="small"
                fullWidth
                value={form.key}
                onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
                helperText="唯一标识，如 project:A / formal；创建后不可修改"
              />
            )}
            <Stack direction="row" spacing={1.5}>
              <TextField
                select
                label="范围"
                size="small"
                fullWidth
                value={form.scope}
                onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value as ReviewTemplateScope }))}
              >
                <MenuItem value="project">项目类（立项审批链）</MenuItem>
                <MenuItem value="business">业务类（业务评审链）</MenuItem>
              </TextField>
              <TextField
                select
                label="模式"
                size="small"
                fullWidth
                value={form.mode}
                onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value as ReviewMode }))}
              >
                {Object.entries(MODE_LABEL).map(([k, v]) => (
                  <MenuItem key={k} value={k}>
                    {v}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
            <TextField
              label="模板名称（必填）"
              size="small"
              fullWidth
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            />
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
                审批链（按顺序串行；点击下方角色添加）
              </Typography>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                {form.chain.length === 0 && (
                  <Typography variant="caption" color="text.secondary">
                    审批链为空，请从下方添加角色
                  </Typography>
                )}
                {form.chain.map((r, i) => (
                  <Chip
                    key={`${r}-${i}`}
                    label={`${i + 1}. ${ROLE_LABEL[r] ?? r}`}
                    size="small"
                    onDelete={() => setForm((f) => ({ ...f, chain: f.chain.filter((_, j) => j !== i) }))}
                    deleteIcon={
                      <IconButton size="small" sx={{ mr: -0.5 }}>
                        <DeleteOutlineIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    }
                  />
                ))}
              </Stack>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {ALL_ROLES.filter((r) => !form.chain.includes(r)).map((r) => (
                  <Chip
                    key={r}
                    label={`+ ${ROLE_LABEL[r] ?? r}`}
                    size="small"
                    variant="outlined"
                    onClick={() => setForm((f) => ({ ...f, chain: [...f.chain, r] }))}
                    icon={<AddIcon sx={{ fontSize: 13 }} />}
                    sx={{ cursor: 'pointer' }}
                  />
                ))}
              </Stack>
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  调整顺序：
                </Typography>
                {form.chain.map((r, i) => (
                  <Stack key={`${r}-mv-${i}`} direction="row" spacing={0.25} alignItems="center">
                    <Tooltip title="上移">
                      <span>
                        <IconButton size="small" disabled={i === 0} onClick={() => moveRole(i, -1)}>
                          <ArrowUpwardIcon sx={{ fontSize: 15 }} />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Typography variant="caption" sx={{ minWidth: 16, textAlign: 'center' }}>
                      {i + 1}
                    </Typography>
                    <Tooltip title="下移">
                      <span>
                        <IconButton size="small" disabled={i === form.chain.length - 1} onClick={() => moveRole(i, 1)}>
                          <ArrowDownwardIcon sx={{ fontSize: 15 }} />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Stack>
                ))}
              </Stack>
            </Box>
            <TextField
              label="描述"
              size="small"
              fullWidth
              multiline
              minRows={2}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setOpen(false)} disabled={saving}>
            取消
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => void save()}
            disabled={saving || !form.key.trim() || !form.label.trim() || !chainValid}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
