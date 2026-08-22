import { useEffect, useMemo, useState } from 'react';
import {
  Autocomplete,
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
import PersonAddOutlinedIcon from '@mui/icons-material/PersonAddOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';

import { DataTable, LoadingState, PageHeader, PermissionButton, SectionCard, UserAvatar } from '@/components/common';
import type { Column } from '@/components/common';
import { AdminTabs } from './AdminTabs';
import type { User } from '@/types/project';
import { api } from '@/api/client';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks';
import { GLOBAL_ROLE_LABEL } from '@/config/enums';
import type { Role } from '@/types/project';

/** 新增用户弹窗表单值（E1.5：支持一人多全局职位） */
interface NewUserForm {
  openId: string;
  name: string;
  employeeId: string;
  email: string;
  dept: string;
  /** 主职位（单值兜底），值为 role_key（含动态职位） */
  primaryRole: string;
  /** 额外职位（不含主职位），值为 role_key 数组 */
  extraRoles: string[];
}

const EMPTY_FORM: NewUserForm = { openId: '', name: '', employeeId: '', email: '', dept: '', primaryRole: 'member', extraRoles: [] };

/**
 * 管理后台 · 用户与职位（阶段一：用户 CRUD + 启停 + 部门；E1.5：一人可多公司职位）
 * @prd P0-12（用户管理后台） P0-10（角色体系与 RBAC）
 */
export function AdminUsersPage(): JSX.Element {
  const toast = useToast();
  const me = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  /** 职位目录（动态，含职位管理页新加的职位），用于用户角色下拉 */
  const [roles, setRoles] = useState<Role[]>([]);

  /* 新增用户弹窗状态 */
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<NewUserForm>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  /** role_key → 中文名 映射（动态职位 + 预置兜底，保证旧数据也有名） */
  const roleLabelMap: Record<string, string> = useMemo(() => {
    const map: Record<string, string> = { ...GLOBAL_ROLE_LABEL };
    roles.forEach((r) => {
      if (r.name) map[r.roleKey] = r.name;
    });
    return map;
  }, [roles]);

  /** scope → 视野范围说明（便于管理员分配时判断该职位的数据可见范围） */
  const scopeLabelMap: Record<string, string> = {
    global: '全公司视野',
    project: '仅项目内视野',
  };
  const scopeOf = (key: string): 'global' | 'project' =>
    roles.find((r) => r.roleKey === key)?.scope ?? 'project';

  /** 可指派的职位 = 职位管理里的全部职位（谁都能分配；视野维度由职位自身设定决定），按 orderNo 排序 */
  const roleOptions: Role[] = useMemo(
    () => roles.filter((r) => r.enabled).sort((a, b) => a.orderNo - b.orderNo),
    [roles],
  );

  const load = (): void => {
    setLoading(true);
    Promise.all([api.listUsers(), api.listRoles()])
      .then(([us, rs]) => {
        setUsers(us);
        setRoles(rs);
      })
      .catch((e: unknown) => toast.error(e))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [toast]);

  /** 合并主职位 + 额外职位（去重，主职位在前） */
  const mergeRoles = (primary: string, extra: string[]): string[] => {
    const set = new Set<string>([primary]);
    extra.forEach((r) => set.add(r));
    return Array.from(set);
  };

  /** 保存某用户的多职位（首项为主职位） */
  const saveRoles = async (u: User, roles: string[]): Promise<void> => {
    try {
      const updated = await api.updateUser(u.openId, { globalRoles: roles });
      setUsers((list) => list.map((x) => (x.openId === u.openId ? updated : x)));
      toast.success(`已更新 ${u.name} 的职位`);
    } catch (e) {
      toast.error(e);
      load();
    }
  };

  /** 启用 / 停用（仅 admin；不能停用自己） */
  const toggleStatus = async (u: User): Promise<void> => {
    const next = u.status === 'active' ? 'disabled' : 'active';
    try {
      const updated = await api.updateUser(u.openId, { status: next });
      setUsers((list) => list.map((x) => (x.openId === u.openId ? updated : x)));
      toast.success(next === 'active' ? `已启用 ${u.name}` : `已停用 ${u.name}`);
    } catch (e) {
      toast.error(e);
      load();
    }
  };

  const createUser = async (): Promise<void> => {
    setCreating(true);
    try {
      const created = await api.createUser({
        openId: form.openId.trim(),
        name: form.name.trim(),
        employeeId: form.employeeId.trim() || undefined,
        email: form.email.trim() || undefined,
        dept: form.dept.trim() || undefined,
        globalRoles: mergeRoles(form.primaryRole, form.extraRoles),
      });
      setUsers((list) => [...list, created]);
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      toast.success(`已创建用户 ${created.name}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setCreating(false);
    }
  };

  /* 编辑用户资料弹窗（复用部分字段 + 多职位） */
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<User | null>(null);
  const [editForm, setEditForm] = useState({ name: '', dept: '', email: '', employeeId: '', primaryRole: 'member', extraRoles: [] as string[] });
  const [editing, setEditing] = useState(false);

  const openEdit = (u: User): void => {
    setEditTarget(u);
    const all = u.globalRoles?.length ? u.globalRoles : [u.globalRole];
    setEditForm({
      name: u.name ?? '',
      dept: u.dept ?? '',
      email: u.email ?? '',
      employeeId: u.employeeId ?? '',
      primaryRole: all[0],
      extraRoles: all.slice(1),
    });
    setEditOpen(true);
  };

  const saveEdit = async (): Promise<void> => {
    if (!editTarget) return;
    setEditing(true);
    try {
      const updated = await api.updateUser(editTarget.openId, {
        name: editForm.name.trim(),
        dept: editForm.dept.trim() || undefined,
        email: editForm.email.trim() || undefined,
        employeeId: editForm.employeeId.trim() || undefined,
        globalRoles: mergeRoles(editForm.primaryRole, editForm.extraRoles),
      });
      setUsers((list) => list.map((x) => (x.openId === updated.openId ? updated : x)));
      setEditOpen(false);
      toast.success(`已更新 ${updated.name} 的资料`);
    } catch (e) {
      toast.error(e);
    } finally {
      setEditing(false);
    }
  };

  const columns: Array<Column<User>> = [
    {
      key: 'name',
      label: '用户',
      render: (u) => (
        <Stack direction="row" spacing={1} alignItems="center">
          <UserAvatar name={u.name} size={28} />
          <Box>
            <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{u.name}</Typography>
            <Typography variant="caption" color="text.secondary">{u.dept || '—'}</Typography>
          </Box>
        </Stack>
      ),
    },
    { key: 'employeeId', label: '工号', width: 100, hideOnMobile: true, render: (u) => <Typography variant="caption">{u.employeeId || '—'}</Typography> },
    { key: 'email', label: '邮箱', hideOnMobile: true, render: (u) => <Typography variant="caption">{u.email || '—'}</Typography> },
    {
      key: 'globalRoles',
      label: '公司职位',
      width: 260,
      render: (u) => {
        const all = u.globalRoles?.length ? u.globalRoles : [u.globalRole];
        return (
          <PermissionButton action="admin:user:role" fallback="disable">
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {all.map((r, i) => (
                <Chip
                  key={r}
                  size="small"
                  label={roleLabelMap[r] ?? r}
                  color={i === 0 ? 'primary' : 'default'}
                  variant={i === 0 ? 'filled' : 'outlined'}
                  title={i === 0 ? '主职位' : '额外职位'}
                />
              ))}
            </Stack>
          </PermissionButton>
        );
      },
    },
    {
      /* 阶段一：状态可操作（启停开关；不能停用自己） */
      key: 'status',
      label: '状态',
      width: 100,
      render: (u) => (
        <PermissionButton action="admin:user:role" fallback="disable">
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Switch
              size="small"
              checked={u.status === 'active'}
              disabled={me?.openId === u.openId}
              onChange={() => void toggleStatus(u)}
            />
            <Typography variant="caption" sx={{ color: u.status === 'active' ? 'success.main' : 'text.secondary' }}>
              {u.status === 'active' ? '启用' : '停用'}
            </Typography>
          </Stack>
        </PermissionButton>
      ),
    },
    {
      key: 'actions',
      label: '操作',
      width: 90,
      render: (u) => (
        <PermissionButton action="admin:user:role" fallback="disable">
          <Button size="small" startIcon={<EditOutlinedIcon />} onClick={() => openEdit(u)}>
            编辑
          </Button>
        </PermissionButton>
      ),
    },
  ];

  return (
    <Stack spacing={2.5}>
      <AdminTabs />
      <PageHeader
        title="用户与职位"
        subtitle="管理公司职位与启停状态；系统至少保留一名管理员，且不可修改/停用自己"
        actions={
          <PermissionButton action="admin:user:role" fallback="disable">
            <Button variant="contained" size="small" startIcon={<PersonAddOutlinedIcon />} onClick={() => setCreateOpen(true)}>
              新增用户
            </Button>
          </PermissionButton>
        }
      />
      <SectionCard flush>
        {loading ? (
          <LoadingState variant="skeleton" rows={6} height={48} />
        ) : (
          <Box sx={{ p: 1 }}>
            <DataTable<User> columns={columns} rows={users} rowKey={(u) => u.openId} />
          </Box>
        )}
      </SectionCard>

      {/* 新增用户弹窗 */}
      <Dialog open={createOpen} onClose={() => !creating && setCreateOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>新增用户</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="openId（必填）"
              size="small"
              fullWidth
              value={form.openId}
              onChange={(e) => setForm((f) => ({ ...f, openId: e.target.value }))}
              helperText="飞书用户 open_id，用于免登识别，创建后不可修改"
            />
            <TextField
              label="姓名（必填）"
              size="small"
              fullWidth
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <Stack direction="row" spacing={1.5}>
              <TextField
                label="工号"
                size="small"
                fullWidth
                value={form.employeeId}
                onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
              />
              <TextField
                label="部门"
                size="small"
                fullWidth
                value={form.dept}
                onChange={(e) => setForm((f) => ({ ...f, dept: e.target.value }))}
              />
            </Stack>
            <TextField
              label="邮箱"
              size="small"
              fullWidth
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
            <Box>
              <Typography variant="caption" color="text.secondary">主职位（必选 1 个，权限兜底）</Typography>
              <TextField
                select
                size="small"
                fullWidth
                value={form.primaryRole}
                onChange={(e) => setForm((f) => ({ ...f, primaryRole: e.target.value }))}
              >
                {roleOptions.map((r) => (
                  <MenuItem key={r.roleKey} value={r.roleKey}>
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 1 }}>
                      <span>{r.name}</span>
                      <Chip
                        size="small"
                        variant="outlined"
                        label={scopeLabelMap[r.scope] ?? r.scope}
                        sx={{ height: 20, fontSize: 11 }}
                      />
                    </Box>
                  </MenuItem>
                ))}
              </TextField>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">额外职位（可多选，一人可兼多职）</Typography>
              <Autocomplete<string, true>
                multiple
                size="small"
                options={roleOptions.map((r) => r.roleKey).filter((k) => k !== form.primaryRole)}
                getOptionLabel={(k) => `${roleLabelMap[k] ?? k}（${scopeLabelMap[scopeOf(k)] ?? scopeOf(k)}）`}
                value={form.extraRoles}
                onChange={(_, v) => setForm((f) => ({ ...f, extraRoles: v }))}
                renderTags={(value, getTagProps) =>
                  value.map((option, index) => (
                    <Chip size="small" label={roleLabelMap[option] ?? option} {...getTagProps({ index })} key={option} />
                  ))
                }
                renderInput={(params) => <TextField {...params} placeholder="选择额外职位" />}
              />
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setCreateOpen(false)} disabled={creating}>
            取消
          </Button>
          <Button size="small" variant="contained" onClick={() => void createUser()} disabled={creating || !form.openId.trim() || !form.name.trim()}>
            {creating ? '创建中…' : '创建'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* 编辑用户资料弹窗（含多职位编辑） */}
      <Dialog open={editOpen} onClose={() => !editing && setEditOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>编辑用户 · {editTarget?.name}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="姓名"
              size="small"
              fullWidth
              value={editForm.name}
              onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
            />
            <Stack direction="row" spacing={1.5}>
              <TextField
                label="工号"
                size="small"
                fullWidth
                value={editForm.employeeId}
                onChange={(e) => setEditForm((f) => ({ ...f, employeeId: e.target.value }))}
              />
              <TextField
                label="部门"
                size="small"
                fullWidth
                value={editForm.dept}
                onChange={(e) => setEditForm((f) => ({ ...f, dept: e.target.value }))}
              />
            </Stack>
            <TextField
              label="邮箱"
              size="small"
              fullWidth
              value={editForm.email}
              onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
            />
            <Box>
              <Typography variant="caption" color="text.secondary">主职位（必选 1 个，权限兜底）</Typography>
              <TextField
                select
                size="small"
                fullWidth
                value={editForm.primaryRole}
                onChange={(e) => setEditForm((f) => ({ ...f, primaryRole: e.target.value }))}
              >
                {roleOptions.map((r) => (
                  <MenuItem key={r.roleKey} value={r.roleKey}>
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 1 }}>
                      <span>{r.name}</span>
                      <Chip
                        size="small"
                        variant="outlined"
                        label={scopeLabelMap[r.scope] ?? r.scope}
                        sx={{ height: 20, fontSize: 11 }}
                      />
                    </Box>
                  </MenuItem>
                ))}
              </TextField>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">额外职位（可多选，一人可兼多职）</Typography>
              <Autocomplete<string, true>
                multiple
                size="small"
                options={roleOptions.map((r) => r.roleKey).filter((k) => k !== editForm.primaryRole)}
                getOptionLabel={(k) => `${roleLabelMap[k] ?? k}（${scopeLabelMap[scopeOf(k)] ?? scopeOf(k)}）`}
                value={editForm.extraRoles}
                onChange={(_, v) => setEditForm((f) => ({ ...f, extraRoles: v }))}
                renderTags={(value, getTagProps) =>
                  value.map((option, index) => (
                    <Chip size="small" label={roleLabelMap[option] ?? option} {...getTagProps({ index })} key={option} />
                  ))
                }
                renderInput={(params) => <TextField {...params} placeholder="选择额外职位" />}
              />
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setEditOpen(false)} disabled={editing}>
            取消
          </Button>
          <Button size="small" variant="contained" onClick={() => void saveEdit()} disabled={editing || !editForm.name.trim()}>
            {editing ? '保存中…' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
