import { useEffect, useState } from 'react';
import {
  Box,
  Button,
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

import { DataTable, LoadingState, PageHeader, PermissionButton, SectionCard, UserAvatar } from '@/components/common';
import type { Column } from '@/components/common';
import { AdminTabs } from './AdminTabs';
import type { User, GlobalRole } from '@/types/project';
import { api } from '@/api/client';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks';
import { GLOBAL_ROLE_LABEL, GLOBAL_ROLES } from '@/config/enums';

/** 新增用户弹窗表单值 */
interface NewUserForm {
  openId: string;
  name: string;
  employeeId: string;
  email: string;
  dept: string;
  globalRole: GlobalRole;
}

const EMPTY_FORM: NewUserForm = { openId: '', name: '', employeeId: '', email: '', dept: '', globalRole: 'member' };

/**
 * 管理后台 · 用户与角色（阶段一：用户 CRUD + 启停 + 部门）
 * @prd P0-12（用户管理后台） P0-10（角色体系与 RBAC）
 */
export function AdminUsersPage(): JSX.Element {
  const toast = useToast();
  const me = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  /* 新增用户弹窗状态 */
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<NewUserForm>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  const load = (): void => {
    setLoading(true);
    api
      .listUsers()
      .then(setUsers)
      .catch((e: unknown) => toast.error(e))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [toast]);

  const changeRole = async (u: User, role: GlobalRole): Promise<void> => {
    try {
      const updated = await api.updateUserRole(u.openId, role);
      setUsers((list) => list.map((x) => (x.openId === u.openId ? updated : x)));
      toast.success(`已将 ${u.name} 调整为 ${GLOBAL_ROLE_LABEL[role]}`);
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
        globalRole: form.globalRole,
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
      key: 'globalRole',
      label: '全局角色',
      width: 200,
      render: (u) => (
        <PermissionButton action="admin:user:role" fallback="disable">
          <TextField
            select
            size="small"
            value={u.globalRole}
            onChange={(e) => void changeRole(u, e.target.value as GlobalRole)}
            disabled={me?.openId === u.openId}
            sx={{ minWidth: 140 }}
          >
            {GLOBAL_ROLES.map((r) => (
              <MenuItem key={r} value={r}>
                {GLOBAL_ROLE_LABEL[r]}
              </MenuItem>
            ))}
          </TextField>
        </PermissionButton>
      ),
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
  ];

  return (
    <Stack spacing={2.5}>
      <AdminTabs />
      <PageHeader
        title="用户与角色"
        subtitle="管理全局角色与启停状态；系统至少保留一名管理员，且不可修改/停用自己"
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
            <TextField
              select
              label="全局角色"
              size="small"
              fullWidth
              value={form.globalRole}
              onChange={(e) => setForm((f) => ({ ...f, globalRole: e.target.value as GlobalRole }))}
            >
              {GLOBAL_ROLES.map((r) => (
                <MenuItem key={r} value={r}>
                  {GLOBAL_ROLE_LABEL[r]}
                </MenuItem>
              ))}
            </TextField>
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
    </Stack>
  );
}
