import { useEffect, useState } from 'react';
import { Box, MenuItem, Stack, TextField, Typography } from '@mui/material';

import { DataTable, LoadingState, PageHeader, PermissionButton, SectionCard, UserAvatar } from '@/components/common';
import type { Column } from '@/components/common';
import type { User, GlobalRole } from '@/types/project';
import { api } from '@/api/client';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks';
import { GLOBAL_ROLE_LABEL, GLOBAL_ROLES } from '@/config/enums';

/**
 * 管理后台 · 用户与角色
 * @prd P0-12（用户管理后台） P0-10（角色体系与 RBAC）
 */
export function AdminUsersPage(): JSX.Element {
  const toast = useToast();
  const me = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

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

  const columns: Array<Column<User>> = [
    {
      key: 'name',
      label: '用户',
      render: (u) => (
        <Stack direction="row" spacing={1} alignItems="center">
          <UserAvatar name={u.name} size={28} />
          <Box>
            <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{u.name}</Typography>
            <Typography variant="caption" color="text.secondary">{u.dept}</Typography>
          </Box>
        </Stack>
      ),
    },
    { key: 'employeeId', label: '工号', width: 110, hideOnMobile: true },
    { key: 'email', label: '邮箱', hideOnMobile: true, render: (u) => <Typography variant="caption">{u.email}</Typography> },
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
      key: 'status',
      label: '状态',
      width: 90,
      render: (u) => (
        <Typography variant="caption" sx={{ color: u.status === 'active' ? 'success.main' : 'text.secondary' }}>
          {u.status === 'active' ? '启用' : '停用'}
        </Typography>
      ),
    },
  ];

  return (
    <Stack spacing={2.5}>
      <PageHeader title="用户与角色" subtitle="管理全局角色分配；系统至少保留一名管理员，且不可修改自己的角色" />
      <SectionCard flush>
        {loading ? (
          <LoadingState variant="skeleton" rows={6} height={48} />
        ) : (
          <Box sx={{ p: 1 }}>
            <DataTable<User> columns={columns} rows={users} rowKey={(u) => u.openId} />
          </Box>
        )}
      </SectionCard>
    </Stack>
  );
}
