import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';

import { DataTable, LoadingState, PageHeader, PermissionButton, SectionCard } from '@/components/common';
import type { Column } from '@/components/common';
import { AdminTabs } from './AdminTabs';
import type { Role, RoleScope, CreateRolePayload, UpdateRolePayload } from '@/types/project';
import { api } from '@/api/client';
import { useToast } from '@/hooks';

/** 职位 scope 中文文案（内联，避免向 enums 注入一次性常量） */
const SCOPE_LABEL: Record<RoleScope, string> = {
  global: '全局（看全公司）',
  project: '项目内',
};

/** 新增 / 编辑职位弹窗表单值 */
interface RoleForm {
  roleKey: string;
  name: string;
  scope: RoleScope;
  description: string;
}

const EMPTY_FORM: RoleForm = { roleKey: '', name: '', scope: 'global', description: '' };

/**
 * 管理后台 · 职位管理（E1.5）
 *
 * 维护「职位目录」：每个职位有唯一 key、中文名、视野维度（global/project）、启停、排序。
 * 权限判定仍由 canDo 按 role key 对齐，本页只管目录本身。
 * 仅 admin 可访问（后端路由已强制）。
 */
export function AdminRolesPage(): JSX.Element {
  const toast = useToast();
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);

  /* 新增职位弹窗状态 */
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<RoleForm>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  /* 编辑职位弹窗状态 */
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Role | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; scope: RoleScope; description: string }>({
    name: '',
    scope: 'global',
    description: '',
  });
  const [editing, setEditing] = useState(false);

  /* 删除确认弹窗状态 */
  const [deleteTarget, setDeleteTarget] = useState<Role | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = (): void => {
    setLoading(true);
    api
      .listRoles()
      .then(setRoles)
      .catch((e: unknown) => toast.error(e))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [toast]);

  /* ── 新增 ─────────────────────────────────────── */
  const openCreate = (): void => {
    setForm(EMPTY_FORM);
    setCreateOpen(true);
  };

  const createRole = async (): Promise<void> => {
    const key = form.roleKey.trim();
    const name = form.name.trim();
    if (!key || !name) {
      toast.error('职位 key 与中文名均为必填');
      return;
    }
    if (!/^[a-z0-9_]+$/.test(key)) {
      toast.error('职位 key 只能包含小写字母、数字与下划线');
      return;
    }
    setCreating(true);
    try {
      const payload: CreateRolePayload = {
        roleKey: key,
        name,
        scope: form.scope,
        description: form.description.trim() || undefined,
      };
      const created = await api.createRole(payload);
      setRoles((list) => [...list, created].sort((a, b) => a.orderNo - b.orderNo));
      setCreateOpen(false);
      toast.success(`已新增职位「${created.name}」`);
    } catch (e) {
      toast.error(e);
    } finally {
      setCreating(false);
    }
  };

  /* ── 编辑 ─────────────────────────────────────── */
  const openEdit = (r: Role): void => {
    setEditTarget(r);
    setEditForm({ name: r.name, scope: r.scope, description: r.description });
    setEditOpen(true);
  };

  const saveEdit = async (): Promise<void> => {
    if (!editTarget) return;
    const name = editForm.name.trim();
    if (!name) {
      toast.error('中文名不能为空');
      return;
    }
    setEditing(true);
    try {
      const patch: UpdateRolePayload = {
        name,
        scope: editForm.scope,
        description: editForm.description.trim() || undefined,
      };
      const updated = await api.updateRole(editTarget.roleKey, patch);
      setRoles((list) => list.map((x) => (x.roleKey === updated.roleKey ? updated : x)));
      setEditOpen(false);
      toast.success(`已更新职位「${updated.name}」`);
    } catch (e) {
      toast.error(e);
    } finally {
      setEditing(false);
    }
  };

  /* ── 启停（直接调 updateRole，无需弹窗） ──────────── */
  const toggleEnabled = async (r: Role): Promise<void> => {
    try {
      const updated = await api.updateRole(r.roleKey, { enabled: !r.enabled });
      setRoles((list) => list.map((x) => (x.roleKey === updated.roleKey ? updated : x)));
      toast.success(updated.enabled ? `已启用「${updated.name}」` : `已停用「${updated.name}」`);
    } catch (e) {
      toast.error(e);
    }
  };

  /* ── 删除（带引用校验，后端校验失败会带原因） ────── */
  const openDelete = (r: Role): void => {
    setDeleteTarget(r);
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteRole(deleteTarget.roleKey);
      setRoles((list) => list.filter((x) => x.roleKey !== deleteTarget.roleKey));
      toast.success(`已删除职位「${deleteTarget.name}」`);
      setDeleteTarget(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setDeleting(false);
    }
  };

  const columns: Array<Column<Role>> = [
    {
      key: 'name',
      label: '职位',
      render: (r) => (
        <Stack direction="row" spacing={1} alignItems="center">
          <Box>
            <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{r.name}</Typography>
            <Typography variant="caption" color="text.secondary">{r.roleKey}</Typography>
          </Box>
        </Stack>
      ),
    },
    {
      key: 'scope',
      label: '视野维度',
      width: 160,
      render: (r) => (
        <Chip
          size="small"
          label={SCOPE_LABEL[r.scope]}
          color={r.scope === 'global' ? 'primary' : 'default'}
          variant={r.scope === 'global' ? 'filled' : 'outlined'}
        />
      ),
    },
    {
      key: 'description',
      label: '说明',
      hideOnMobile: true,
      render: (r) => <Typography variant="caption" color="text.secondary">{r.description || '—'}</Typography>,
    },
    {
      key: 'orderNo',
      label: '排序',
      width: 80,
      align: 'center',
      render: (r) => <Typography variant="caption">{r.orderNo}</Typography>,
    },
    {
      key: 'enabled',
      label: '状态',
      width: 100,
      render: (r) => (
        <PermissionButton action="admin:user:role" fallback="disable">
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Switch size="small" checked={r.enabled} onChange={() => void toggleEnabled(r)} />
            <Typography variant="caption" sx={{ color: r.enabled ? 'success.main' : 'text.secondary' }}>
              {r.enabled ? '启用' : '停用'}
            </Typography>
          </Stack>
        </PermissionButton>
      ),
    },
    {
      key: 'actions',
      label: '操作',
      width: 140,
      render: (r) => (
        <Stack direction="row" spacing={0.5}>
          <PermissionButton action="admin:user:role" fallback="disable">
            <Button size="small" startIcon={<EditOutlinedIcon />} onClick={() => openEdit(r)}>
              编辑
            </Button>
          </PermissionButton>
          <PermissionButton action="admin:user:role" fallback="disable">
            <Button
              size="small"
              color="error"
              startIcon={<DeleteOutlineOutlinedIcon />}
              onClick={() => openDelete(r)}
            >
              删除
            </Button>
          </PermissionButton>
        </Stack>
      ),
    },
  ];

  return (
    <Stack spacing={2.5}>
      <AdminTabs />
      <PageHeader
        title="职位管理"
        subtitle="维护职位目录：中文名、视野维度（全局看全公司 / 项目内）、启停与排序。权限判定沿用既有职位 key。"
        actions={
          <PermissionButton action="admin:user:role" fallback="disable">
            <Button variant="contained" size="small" startIcon={<AddOutlinedIcon />} onClick={openCreate}>
              新增职位
            </Button>
          </PermissionButton>
        }
      />
      <SectionCard flush>
        {loading ? (
          <LoadingState variant="skeleton" rows={6} height={48} />
        ) : (
          <Box sx={{ p: 1 }}>
            <DataTable<Role> columns={columns} rows={roles} rowKey={(r) => r.roleKey} />
          </Box>
        )}
      </SectionCard>

      {/* 新增职位弹窗 */}
      <Dialog open={createOpen} onClose={() => !creating && setCreateOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>新增职位</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="职位 key（必填）"
              size="small"
              fullWidth
              value={form.roleKey}
              onChange={(e) => setForm((f) => ({ ...f, roleKey: e.target.value }))}
              helperText="唯一标识，只能小写字母 / 数字 / 下划线，创建后不可修改"
            />
            <TextField
              label="中文名（必填）"
              size="small"
              fullWidth
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <TextField
              select
              label="视野维度"
              size="small"
              fullWidth
              value={form.scope}
              onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value as RoleScope }))}
            >
              {(['global', 'project'] as RoleScope[]).map((s) => (
                <MenuItem key={s} value={s}>
                  {SCOPE_LABEL[s]}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="说明"
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
          <Button size="small" onClick={() => setCreateOpen(false)} disabled={creating}>
            取消
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => void createRole()}
            disabled={creating || !form.roleKey.trim() || !form.name.trim()}
          >
            {creating ? '创建中…' : '创建'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* 编辑职位弹窗 */}
      <Dialog open={editOpen} onClose={() => !editing && setEditOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>编辑职位 · {editTarget?.name}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="职位 key"
              size="small"
              fullWidth
              value={editTarget?.roleKey ?? ''}
              disabled
              helperText="唯一标识，不可修改"
            />
            <TextField
              label="中文名（必填）"
              size="small"
              fullWidth
              value={editForm.name}
              onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
            />
            <TextField
              select
              label="视野维度"
              size="small"
              fullWidth
              value={editForm.scope}
              onChange={(e) => setEditForm((f) => ({ ...f, scope: e.target.value as RoleScope }))}
            >
              {(['global', 'project'] as RoleScope[]).map((s) => (
                <MenuItem key={s} value={s}>
                  {SCOPE_LABEL[s]}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="说明"
              size="small"
              fullWidth
              multiline
              minRows={2}
              value={editForm.description}
              onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setEditOpen(false)} disabled={editing}>
            取消
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => void saveEdit()}
            disabled={editing || !editForm.name.trim()}
          >
            {editing ? '保存中…' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={!!deleteTarget} onClose={() => !deleting && setDeleteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>删除职位</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            确认删除职位「<b>{deleteTarget?.name}</b>」({deleteTarget?.roleKey})？
          </Typography>
          <Typography variant="caption" color="text.secondary">
            若该职位已被指派给用户，后端将拒绝删除并提示引用情况。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setDeleteTarget(null)} disabled={deleting}>
            取消
          </Button>
          <Button
            size="small"
            color="error"
            variant="contained"
            onClick={() => void confirmDelete()}
            disabled={deleting}
          >
            {deleting ? '删除中…' : '删除'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
