/**
 * 管理后台 · 权限矩阵（B19 阶段二 · 真·可配置）
 *
 * 角色 × 权限点矩阵：行 = 权限点（按业务域分组），列 = 全部启用角色（来自 roles 表，
 * 前端以 ROLE_CATALOG 镜像），单元格 = 该角色是否具备该权限。
 *
 * 数据源（真实模式）：
 *  - 只读元数据（角色 + 动作分组）：GET /api/meta/permissions
 *  - 当前生效矩阵 + 写接口：GET/PUT /api/admin/permissions、POST /api/admin/permissions/reset
 *  - 前端按钮显隐用的 canDo 在登录后由 GET /api/meta/permission-matrix 注入，
 *    与后端 permissionCatalog.rolesFor 同源；后台改矩阵后无需刷新登录即可生效（写后刷新）。
 *
 * 防锁死：admin 列恒为勾选且禁用（永不取消 admin 授权）；重置默认恢复 DEFAULT_PERMISSIONS。
 *
 * Mock 模式：MockApiClient 提供完全同构的 6 个端点（含默认 seed），UI 零改动。
 */
import { Box, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography, Chip, Button, Stack, Alert, CircularProgress, Tooltip } from '@mui/material';
import CheckOutlinedIcon from '@mui/icons-material/CheckOutlined';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';

import { useEffect, useMemo, useState } from 'react';
import { PageHeader, SectionCard } from '@/components/common';
import { AdminTabs } from './AdminTabs';
import { api } from '@/api/client';
import { useAuthStore } from '@/stores/authStore';
import type { PermissionActionMeta, PermissionRoleMeta } from '@/api/contract';

const GROUP_ORDER = ['项目', '质量门 / 里程碑', 'WBS / 看板 / 任务', '周报 / 评审 / 变更', '全局 / 管理'];

interface GroupedMatrix {
  group: string;
  items: PermissionActionMeta[];
}

export function AdminPermissionsPage(): JSX.Element {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && Array.isArray(user.globalRoles)
    ? user.globalRoles.includes('admin')
    : user?.globalRole === 'admin';

  const [roles, setRoles] = useState<PermissionRoleMeta[]>([]);
  const [actions, setActions] = useState<PermissionActionMeta[]>([]);
  // 编辑态矩阵：action → { roleKey: granted }
  const [matrix, setMatrix] = useState<Record<string, Record<string, boolean>>>({});
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const grouped = useMemo<GroupedMatrix[]>(() => {
    const map = new Map<string, PermissionActionMeta[]>();
    actions.forEach((a) => {
      const g = a.group_label || '其他';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(a);
    });
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g)! }))
      .concat(
        Array.from(map.keys())
          .filter((g) => !GROUP_ORDER.includes(g))
          .map((g) => ({ group: g, items: map.get(g)! })),
      );
  }, [actions]);

  const loadMeta = async () => {
    const meta = await api.getMetaPermissions();
    setRoles(meta.roles);
    setActions(meta.actions);
  };

  const loadMatrix = async () => {
    if (!isAdmin) return;
    const resp = await api.getPermissionMatrix();
    setMatrix(resp.matrix);
    setDirty(false);
  };

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      await loadMeta();
      await loadMatrix();
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载权限矩阵失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const toggle = (action: string, roleKey: string) => {
    if (roleKey === 'admin') return; // 防锁死：admin 恒授权
    setMatrix((prev) => {
      const row = { ...(prev[action] || {}) };
      row[roleKey] = !row[roleKey];
      return { ...prev, [action]: row };
    });
    setDirty(true);
    setNotice(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const resp = await api.updatePermissionMatrix(matrix);
      setMatrix(resp.matrix);
      setDirty(false);
      setNotice('已保存，权限矩阵即时生效（无需重启，前端按钮显隐已自动跟随）');
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const resp = await api.resetPermissionMatrix();
      setMatrix(resp.matrix);
      setDirty(false);
      setNotice('已恢复默认权限矩阵');
    } catch (e) {
      setError(e instanceof Error ? e.message : '重置失败');
    } finally {
      setSaving(false);
    }
  };

  const yes = (action: string, roleKey: string): boolean => {
    if (roleKey === 'admin') return true; // admin 恒具备
    const row = matrix[action];
    return !!(row && row[roleKey]);
  };

  if (loading) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <CircularProgress size={28} />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>加载权限矩阵…</Typography>
      </Box>
    );
  }

  return (
    <Box>
      <AdminTabs />
      <PageHeader
        title="权限矩阵"
        subtitle="角色 × 权限点（真·可配置：后台勾选即真实生效，与后端鉴权同源；角色列头来自服务端 roles 表，与「职位管理」实时同步）"
        actions={
          isAdmin ? (
            <Stack direction="row" spacing={1}>
              <Button
                variant="outlined"
                color="warning"
                startIcon={<RestartAltIcon />}
                disabled={saving}
                onClick={reset}
              >
                恢复默认
              </Button>
              <Button
                variant="contained"
                startIcon={<SaveOutlinedIcon />}
                disabled={saving || !dirty}
                onClick={save}
              >
                {saving ? '保存中…' : '保存修改'}
              </Button>
            </Stack>
          ) : null
        }
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert>}
      {!isAdmin && (
        <Alert severity="info" sx={{ mb: 2 }}>
          当前账号非管理员，仅可查看权限矩阵；如需修改请联系系统管理员。
        </Alert>
      )}

      <SectionCard flush>
        <TableContainer sx={{ maxHeight: '66vh', overflow: 'auto' }}>
          <Table size="small" stickyHeader sx={{ minWidth: 860 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ minWidth: 150, fontWeight: 700, position: 'sticky', left: 0, bgcolor: 'background.paper', zIndex: 2 }}>
                  权限点
                </TableCell>
                {roles.map((r) => (
                  <TableCell
                    key={r.roleKey}
                    align="center"
                    sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}
                  >
                    {r.name}
                    <Chip
                      size="small"
                      label={r.scope === 'global' ? '全局' : '项目'}
                      color={r.scope === 'global' ? 'primary' : 'default'}
                      sx={{ ml: 0.5, height: 16, fontSize: 10 }}
                    />
                    {r.roleKey === 'admin' && (
                      <LockOutlinedIcon sx={{ fontSize: 12, ml: 0.3, color: 'text.disabled', verticalAlign: 'middle' }} />
                    )}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {grouped.map((g) => (
                <GroupRows
                  key={g.group}
                  group={g.group}
                  items={g.items}
                  roles={roles}
                  matrix={matrix}
                  isAdmin={isAdmin}
                  onToggle={toggle}
                  yes={yes}
                />
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </SectionCard>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
        ✔ = 该角色具备权限；admin 恒具备全部权限（锁定，不可取消）。
        角标「全局」= 该角色跨项目生效（scope=global）；「项目」= 仅用户担任该角色的项目内生效（scope=project）。
        修改角色的 scope 后，此表立即跟随变化。后台勾选保存后即时生效，前端按钮显隐自动同步，无需重启。
      </Typography>
    </Box>
  );
}

interface GroupRowsProps {
  group: string;
  items: PermissionActionMeta[];
  roles: PermissionRoleMeta[];
  matrix: Record<string, Record<string, boolean>>;
  isAdmin: boolean;
  yes: (action: string, roleKey: string) => boolean;
  onToggle: (action: string, roleKey: string) => void;
}

function GroupRows({ group, items, roles, isAdmin, yes, onToggle }: GroupRowsProps): JSX.Element {
  return (
    <>
      <TableRow>
        <TableCell colSpan={1 + roles.length} sx={{ bgcolor: 'action.hover', py: 0.75 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 700, color: 'text.secondary' }}>{group}</Typography>
        </TableCell>
      </TableRow>
      {items.map((it) => (
        <TableRow key={it.action} hover>
          <TableCell sx={{ whiteSpace: 'nowrap', position: 'sticky', left: 0, bgcolor: 'background.paper' }}>
            <Typography sx={{ fontSize: 13 }}>{it.label}</Typography>
            <Typography variant="caption" color="text.disabled">
              {it.action}
            </Typography>
          </TableCell>
          {roles.map((r) => {
            const checked = yes(it.action, r.roleKey);
            const locked = r.roleKey === 'admin';
            const editable = isAdmin && !locked;
            return (
              <TableCell key={r.roleKey} align="center">
                {checked ? (
                  <Tooltip title={locked ? 'admin 恒具备，不可取消' : (editable ? '点击取消授权' : '')}>
                    <span>
                      {locked ? (
                        <CheckOutlinedIcon sx={{ fontSize: 15, color: 'grey.500' }} />
                      ) : (
                        <CheckOutlinedIcon
                          sx={{ fontSize: 15, color: 'primary.main', cursor: editable ? 'pointer' : 'default' }}
                          onClick={editable ? () => onToggle(it.action, r.roleKey) : undefined}
                        />
                      )}
                    </span>
                  </Tooltip>
                ) : (
                  <Typography
                    variant="caption"
                    color="text.disabled"
                    sx={{ cursor: editable ? 'pointer' : 'default', userSelect: 'none' }}
                    onClick={editable ? () => onToggle(it.action, r.roleKey) : undefined}
                  >
                    —
                  </Typography>
                )}
              </TableCell>
            );
          })}
        </TableRow>
      ))}
    </>
  );
}
