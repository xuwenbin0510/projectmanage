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
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import PersonAddOutlinedIcon from '@mui/icons-material/PersonAddOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import LockResetOutlinedIcon from '@mui/icons-material/LockResetOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';

import { DataTable, LoadingState, PageHeader, PermissionButton, SectionCard, UserAvatar } from '@/components/common';
import type { Column } from '@/components/common';
import { AdminTabs } from './AdminTabs';
import type { User } from '@/types/project';
import { api } from '@/api/client';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks';
import { GLOBAL_ROLE_LABEL } from '@/config/enums';
import type { Role } from '@/types/project';

/** 详情弹窗里的单行字段（可选复制） */
function DetailRow({ label, value, onCopy, mono }: { label: string; value: string; onCopy?: () => void; mono?: boolean }): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 72 }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1, textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.5 }}>
        <Typography
          variant="body2"
          sx={{
            wordBreak: 'break-all',
            fontFamily: mono ? 'monospace' : undefined,
            fontSize: mono ? 12 : 14,
          }}
        >
          {value}
        </Typography>
        {onCopy && (
          <IconButton size="small" onClick={onCopy} title="复制">
            <ContentCopyOutlinedIcon fontSize="small" />
          </IconButton>
        )}
      </Box>
    </Stack>
  );
}

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

  /** 重置用户密码（仅 admin；不能重置自己） */
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [resetting, setResetting] = useState(false);
  const openReset = (u: User): void => setResetTarget(u);
  const closeReset = (): void => {
    if (!resetting) setResetTarget(null);
  };
  const doReset = async (): Promise<void> => {
    if (!resetTarget) return;
    setResetting(true);
    try {
      const res = await api.resetUserPassword(resetTarget.openId);
      setResetTarget(null);
      toast.success(`已重置 ${resetTarget.name} 的密码，临时密码：${res.defaultPassword}（请通知其首次登录修改）`);
    } catch (e) {
      toast.error(e);
    } finally {
      setResetting(false);
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
  const [editForm, setEditForm] = useState({ name: '', dept: '', email: '', employeeId: '', openId: '', unionId: '', primaryRole: 'member', extraRoles: [] as string[] });
  const [editing, setEditing] = useState(false);

  /* 「更多」操作菜单（重置密码 / 删除） */
  const [menuAnchor, setMenuAnchor] = useState<{ el: HTMLElement; user: User } | null>(null);
  const openMenu = (e: React.MouseEvent<HTMLElement>, u: User): void => {
    setMenuAnchor({ el: e.currentTarget, user: u });
  };
  const closeMenu = (): void => setMenuAnchor(null);

  const openEdit = (u: User): void => {
    setEditTarget(u);
    const all = u.globalRoles?.length ? u.globalRoles : [u.globalRole];
    setEditForm({
      name: u.name ?? '',
      dept: u.dept ?? '',
      email: u.email ?? '',
      employeeId: u.employeeId ?? '',
      openId: u.openId ?? '',
      unionId: u.unionId ?? '',
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
        openId: editForm.openId.trim(),
        unionId: editForm.unionId.trim(),
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

  /* 详情弹窗（只读，展示完整字段 + open_id/union_id 可复制） */
  const [detailTarget, setDetailTarget] = useState<User | null>(null);

  /* 物理删除（带二次确认） */
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleting, setDeleting] = useState(false);
  const openDelete = (u: User): void => {
    if (me?.openId === u.openId) {
      toast.error('不能删除自己');
      return;
    }
    setDeleteTarget(u);
  };
  const doDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteUser(deleteTarget.openId);
      setUsers((list) => list.filter((x) => x.openId !== deleteTarget.openId));
      toast.success(`已删除用户 ${deleteTarget.name}`);
      setDeleteTarget(null);
    } catch (e: any) {
      // 引用冲突时后端返回 references，提示用户先处理关联数据
      const refs = e?.data?.references as Array<{ label: string; count: number }> | undefined;
      if (refs && refs.length) {
        toast.error(`无法删除：${deleteTarget.name} 仍关联 ${refs.map((r) => `${r.label}×${r.count}`).join('、')}，请先解绑`);
      } else {
        toast.error(e);
      }
    } finally {
      setDeleting(false);
    }
  };

  /** 复制文本到剪贴板 */
  const copyText = (text: string, label: string): void => {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(
      () => toast.success(`已复制${label}`),
      () => toast.error('复制失败'),
    );
  };

  /**
   * 数据体检：同一 union_id 或同一邮箱（忽略大小写、非空）在库中出现 ≥2 次。
   * 正常认回流程下不可能产生重复键（命中即 UPDATE 老号，不新建），此告警仅用于暴露
   * 历史脏数据残留（如早期手改 DB / 飞书数据异常），提示管理员核查，非实时防重复手段。
   */
  const dupKeys = useMemo(() => {
    const map = new Map<string, number>();
    users.forEach((u) => {
      if (u.unionId) {
        const k = 'U:' + u.unionId;
        map.set(k, (map.get(k) || 0) + 1);
      }
      if (u.email) {
        const k = 'E:' + u.email.toLowerCase();
        map.set(k, (map.get(k) || 0) + 1);
      }
    });
    return map;
  }, [users]);
  /** 该账号是否命中重复键（数据异常，需人工核查） */
  const isDataAnomaly = (u: User): boolean => {
    if (u.unionId && (dupKeys.get('U:' + u.unionId) || 0) > 1) return true;
    if (u.email && (dupKeys.get('E:' + u.email.toLowerCase()) || 0) > 1) return true;
    return false;
  };

  const columns: Array<Column<User>> = [
    {
      key: 'name',
      label: '用户',
      width: 100,
      align: 'center',
      render: (u) => (
        <Stack direction="row" spacing={1} alignItems="center">
          <UserAvatar name={u.name} size={28} />
          <Box>
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Typography sx={{ fontSize: 14, fontWeight: 600, color: isDataAnomaly(u) ? 'error.main' : 'text.primary' }}>{u.name}</Typography>
              {isDataAnomaly(u) && (
                <Chip
                  size="small"
                  icon={<WarningAmberOutlinedIcon />}
                  label="异常"
                  color="error"
                  variant="outlined"
                  title="该 union_id 或邮箱在库中存在多份，属历史脏数据残留，请核查"
                />
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary">{u.dept || '—'}</Typography>
          </Box>
        </Stack>
      ),
    },
    { key: 'employeeId', label: '工号', width: 90, align: 'center', hideOnMobile: true, render: (u) => <Typography variant="caption">{u.employeeId || '—'}</Typography> },
    { key: 'email', label: '邮箱', width: 180, align: 'center', hideOnMobile: true, render: (u) => <Typography variant="caption">{u.email || '—'}</Typography> },
    {
      key: 'globalRoles',
      label: '公司职位',
      width: 240,
      align: 'center',
      render: (u) => {
        const all = (u.globalRoles && u.globalRoles.length ? u.globalRoles : [u.globalRole]).filter(Boolean);
        return (
          <PermissionButton action="admin:user:role" fallback="disable">
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {all.length === 0 ? (
                <Chip size="small" label="未分配" variant="outlined" color="default" title="尚未分配公司职位" />
              ) : (
                all.map((r, i) => (
                  <Chip
                    key={r}
                    size="small"
                    label={roleLabelMap[r] ?? r}
                    color={i === 0 ? 'primary' : 'default'}
                    variant={i === 0 ? 'filled' : 'outlined'}
                    title={i === 0 ? '主职位' : '额外职位'}
                  />
                ))
              )}
            </Stack>
          </PermissionButton>
        );
      },
    },
    {
      /* 阶段一：状态可操作（启停开关；不能停用自己） */
      key: 'status',
      label: '状态',
      width: 90,
      align: 'center',
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
      width: 160,
      align: 'center',
      render: (u) => (
        <PermissionButton action="admin:user:role" fallback="disable">
          <Stack direction="row" spacing={0.5} justifyContent="center" useFlexGap>
            <Button size="small" startIcon={<VisibilityOutlinedIcon />} onClick={() => setDetailTarget(u)}>
              详情
            </Button>
            <Button size="small" startIcon={<EditOutlinedIcon />} onClick={() => openEdit(u)}>
              编辑
            </Button>
            <IconButton size="small" onClick={(e) => openMenu(e, u)} title="更多操作">
              <MoreVertOutlinedIcon fontSize="small" />
            </IconButton>
          </Stack>
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

      {/* 用户详情弹窗（只读，open_id/union_id 可复制） */}
      <Dialog open={!!detailTarget} onClose={() => setDetailTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>用户详情 · {detailTarget?.name}</DialogTitle>
        <DialogContent>
          {detailTarget && (
            <Stack spacing={1.5} sx={{ pt: 1 }}>
              <DetailRow label="ID" value={String(detailTarget.id)} onCopy={() => copyText(String(detailTarget.id), 'ID')} />
              <DetailRow label="姓名" value={detailTarget.name} />
              <DetailRow label="open_id" value={detailTarget.openId} onCopy={() => copyText(detailTarget.openId, 'open_id')} mono />
              <DetailRow
                label="union_id"
                value={detailTarget.unionId || '（未绑定飞书）'}
                onCopy={detailTarget.unionId ? () => copyText(detailTarget.unionId as string, 'union_id') : undefined}
                mono
              />
              <DetailRow label="邮箱" value={detailTarget.email || '—'} onCopy={detailTarget.email ? () => copyText(detailTarget.email, '邮箱') : undefined} />
              <DetailRow label="工号" value={detailTarget.employeeId || '—'} />
              <DetailRow label="部门" value={detailTarget.dept || '—'} />
              <DetailRow label="公司职位" value={(detailTarget.globalRoles?.length ? detailTarget.globalRoles.map((r) => roleLabelMap[r] ?? r).join('、') : (roleLabelMap[detailTarget.globalRole ?? ''] ?? detailTarget.globalRole ?? '未分配'))} />
              <DetailRow label="状态" value={detailTarget.status === 'active' ? '启用' : '停用'} />
              <DetailRow label="创建时间" value={detailTarget.createdAt || '—'} />
              <DetailRow label="更新时间" value={detailTarget.updatedAt || '—'} />
              {isDataAnomaly(detailTarget) && (
                <Chip size="small" icon={<WarningAmberOutlinedIcon />} label="数据异常：该 union_id 或邮箱在库中存在多份，请核查" color="error" variant="outlined" />
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDetailTarget(null)}>关闭</Button>
        </DialogActions>
      </Dialog>

      {/* 删除确认弹窗（带引用提示） */}
      <Dialog open={!!deleteTarget} onClose={() => !deleting && setDeleteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>确认删除用户</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            确定要物理删除「{deleteTarget?.name}」吗？此操作不可恢复。
          </Typography>
          <Typography variant="caption" color="text.secondary">
            若该用户仍有项目成员、任务、周报等关联数据，系统将拒绝删除并提示。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleting}>取消</Button>
          <Button color="error" variant="contained" onClick={() => void doDelete()} disabled={deleting}>
            确认删除
          </Button>
        </DialogActions>
      </Dialog>

      {/* 「更多」操作菜单：重置密码 / 删除（收起低频危险操作） */}
      <Menu
        anchorEl={menuAnchor?.el}
        open={!!menuAnchor}
        onClose={closeMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem
          disabled={menuAnchor ? me?.openId === menuAnchor.user.openId : false}
          onClick={() => {
            if (menuAnchor) openReset(menuAnchor.user);
            closeMenu();
          }}
        >
          <LockResetOutlinedIcon fontSize="small" style={{ marginRight: 8 }} />
          重置密码
        </MenuItem>
        <MenuItem
          disabled={menuAnchor ? me?.openId === menuAnchor.user.openId : false}
          onClick={() => {
            if (menuAnchor) openDelete(menuAnchor.user);
            closeMenu();
          }}
          sx={{ color: 'error.main' }}
        >
          <DeleteOutlineOutlinedIcon fontSize="small" style={{ marginRight: 8 }} />
          删除
        </MenuItem>
      </Menu>

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
            <Box>
              <Typography variant="caption" color="text.secondary">飞书标识（重复号认回失败时可手动粘贴新号值覆盖到本账号）</Typography>
              <Stack direction="row" spacing={1}>
                <TextField
                  label="open_id"
                  size="small"
                  fullWidth
                  value={editForm.openId}
                  onChange={(e) => setEditForm((f) => ({ ...f, openId: e.target.value }))}
                />
                <Tooltip title="复制当前 open_id">
                  <IconButton size="small" onClick={() => copyText(editForm.openId, 'open_id')}>
                    <ContentCopyOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
              <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                <TextField
                  label="union_id"
                  size="small"
                  fullWidth
                  value={editForm.unionId}
                  onChange={(e) => setEditForm((f) => ({ ...f, unionId: e.target.value }))}
                />
                <Tooltip title="复制当前 union_id">
                  <IconButton size="small" onClick={() => copyText(editForm.unionId, 'union_id')}>
                    <ContentCopyOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            </Box>
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

      {/* 重置密码确认弹窗（仅 admin；不能重置自己） */}
      <Dialog open={Boolean(resetTarget)} onClose={closeReset} maxWidth="xs" fullWidth>
        <DialogTitle>重置密码 · {resetTarget?.name}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            将 {resetTarget?.name} 的密码重置为系统默认密码，并强制其在下次登录时修改。该操作不会影响其姓名、职位与项目归属。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={closeReset} disabled={resetting}>
            取消
          </Button>
          <Button size="small" variant="contained" color="warning" onClick={() => void doReset()} disabled={resetting}>
            {resetting ? '重置中…' : '确认重置'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
