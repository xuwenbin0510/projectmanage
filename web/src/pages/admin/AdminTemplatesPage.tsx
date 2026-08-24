import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';

import { DataTable, EmptyState, LoadingState, PageHeader, PermissionButton, SectionCard, StatusChip } from '@/components/common';
import type { Column } from '@/components/common';
import { AdminTabs } from './AdminTabs';
import { TemplateEditorDialog } from '@/components/admin/TemplateEditorDialog';
import type { LifecycleTemplate, ProjectType, CreateTemplatePayload } from '@/types/project';
import { api } from '@/api/client';
import { useToast } from '@/hooks';
import { PROJECT_TYPE_LABEL } from '@/config/enums';

/** 新增模板弹窗表单 */
interface CreateForm {
  projectType: ProjectType;
  name: string;
}
const EMPTY_CREATE: CreateForm = { projectType: 'A', name: '' };

/**
 * 管理后台 · 生命周期模板（阶段三：模板 CRUD + 节点编辑）
 * @prd P0-16（管理后台）
 */
export function AdminTemplatesPage(): JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<LifecycleTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  /** 动态职位中文名（单一真相源 = 后台 roles 表，替代写死的 PROJECT_ROLE_LABEL） */
  const [roleNameMap, setRoleNameMap] = useState<Record<string, string>>({});

  /* 新增弹窗 */
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(EMPTY_CREATE);
  const [creating, setCreating] = useState(false);

  /* 编辑抽屉 */
  const [editing, setEditing] = useState<LifecycleTemplate | null>(null);

  /* 行操作「更多」菜单 */
  const [menuAnchor, setMenuAnchor] = useState<{ el: HTMLElement; tpl: LifecycleTemplate } | null>(null);
  const openMenu = (e: React.MouseEvent<HTMLElement>, tpl: LifecycleTemplate): void => {
    e.stopPropagation();
    setMenuAnchor({ el: e.currentTarget, tpl });
  };
  const closeMenu = (): void => setMenuAnchor(null);

  const load = (): void => {
    setLoading(true);
    api
      .listTemplates()
      .then(setRows)
      .catch((e: unknown) => toast.error(e))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [toast]);

  /* 加载后台角色目录，用于团队约束列的中文渲染（动态，避免与 roles 表脱节） */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rs = await api.listRoles();
        if (!alive) return;
        const map: Record<string, string> = {};
        rs.forEach((r) => {
          map[r.roleKey] = r.name;
        });
        setRoleNameMap(map);
      } catch {
        /* 失败则回退 roleKey 原文 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const toggleActive = async (t: LifecycleTemplate): Promise<void> => {
    try {
      const updated = await api.toggleTemplateActive(t.id, !t.isActive);
      setRows((list) => list.map((x) => (x.id === t.id ? updated : x)));
      toast.success(`${updated.isActive ? '已启用' : '已停用'}「${updated.name}」`);
    } catch (e) {
      toast.error(e);
      load();
    }
  };

  const duplicate = async (t: LifecycleTemplate): Promise<void> => {
    try {
      const copy = await api.duplicateTemplate(t.id);
      setRows((list) => [...list, copy].sort((a, b) => a.projectType.localeCompare(b.projectType) || b.version - a.version));
      toast.success(`已复制为「${copy.name}」（副本默认停用）`);
    } catch (e) {
      toast.error(e);
    }
  };

  const remove = async (t: LifecycleTemplate): Promise<void> => {
    if (!window.confirm(`确认删除模板「${t.name}」？被项目引用时无法删除。`)) return;
    try {
      await api.deleteTemplate(t.id);
      setRows((list) => list.filter((x) => x.id !== t.id));
      toast.success(`已删除「${t.name}」`);
    } catch (e) {
      toast.error(e);
      load();
    }
  };

  const createTemplate = async (): Promise<void> => {
    setCreating(true);
    try {
      const payload: CreateTemplatePayload = {
        projectType: createForm.projectType,
        name: createForm.name.trim(),
      };
      const created = await api.createTemplate(payload);
      setRows((list) => [...list, created]);
      setCreateOpen(false);
      setCreateForm(EMPTY_CREATE);
      toast.success(`已创建「${created.name}」`);
    } catch (e) {
      toast.error(e);
    } finally {
      setCreating(false);
    }
  };

  const columns: Array<Column<LifecycleTemplate>> = [
    {
      key: 'name',
      label: '模板名称',
      width: 260,
      render: (t) => (
        <Tooltip title={t.name} placement="top-start">
          <Typography sx={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t.name}
          </Typography>
        </Tooltip>
      ),
    },
    {
      key: 'type',
      label: '适用分类',
      width: 96,
      render: (t) => <Chip size="small" variant="outlined" label={PROJECT_TYPE_LABEL[t.projectType as ProjectType]} />,
    },
    { key: 'version', label: '版本', width: 56, align: 'center', hideBelow: 'md', render: (t) => <Typography variant="caption">v{t.version}</Typography> },
    {
      key: 'milestones',
      label: '里程碑数',
      width: 84,
      align: 'center',
      hideBelow: 'md',
      render: (t) => <Typography variant="caption">{t.definition.milestones.length}</Typography>,
    },
    {
      key: 'gates',
      label: '质量门数',
      width: 84,
      align: 'center',
      hideBelow: 'md',
      render: (t) => (
        <Typography variant="caption">{t.definition.milestones.filter((m) => m.gate).length}</Typography>
      ),
    },
    {
      key: 'docs',
      label: '交付物数',
      width: 84,
      align: 'center',
      hideBelow: 'md',
      render: (t) => <Typography variant="caption">{t.definition.docs.length}</Typography>,
    },
    {
      key: 'team',
      label: '团队约束',
      width: 360,
      render: (t) => {
        const rules = t.definition.team;
        if (!rules || rules.length === 0) {
          return <Typography variant="caption" color="text.secondary">系统默认</Typography>;
        }
        return (
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
            {rules.map((r) => (
              <Chip
                key={r.role}
                size="small"
                variant="outlined"
                label={`${roleNameMap[r.role] ?? r.role} ${r.min}~${r.max === -1 ? '∞' : r.max}`}
                sx={{ height: 22, fontSize: 12 }}
              />
            ))}
          </Stack>
        );
      },
    },
    {
      key: 'isActive',
      label: '状态',
      width: 92,
      render: (t) => (
        <PermissionButton action="admin:user:role" fallback="disable">
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Switch size="small" checked={t.isActive} onChange={() => void toggleActive(t)} />
            <Typography variant="caption" sx={{ color: t.isActive ? 'success.main' : 'text.secondary' }}>
              {t.isActive ? '启用' : '停用'}
            </Typography>
          </Stack>
        </PermissionButton>
      ),
    },
    {
      key: 'actions',
      label: '操作',
      width: 72,
      render: (t) => (
        <PermissionButton action="admin:user:role" fallback="disable">
          <Tooltip title="操作">
            <IconButton size="small" onClick={(e) => openMenu(e, t)}>
              <MoreVertOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </PermissionButton>
      ),
    },
  ];

  return (
    <Stack spacing={2.5}>
      <AdminTabs />
      <PageHeader
        title="内置模板"
        subtitle="A / B / C 三类项目各自的生命周期定义：里程碑（含质量门）与交付物；停用后建项向导改用其他启用模板"
        actions={
          <PermissionButton action="admin:user:role" fallback="disable">
            <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
              新增模板
            </Button>
          </PermissionButton>
        }
      />
      <SectionCard flush>
        {loading ? (
          <LoadingState variant="skeleton" rows={5} height={48} />
        ) : rows.length === 0 ? (
          <EmptyState title="暂无模板" description="生命周期模板由系统初始化生成" />
        ) : (
          <Box sx={{ p: 1 }}>
            <DataTable<LifecycleTemplate> columns={columns} rows={rows} rowKey={(t) => t.id} tableLayout="fixed" />
          </Box>
        )}
      </SectionCard>

      {/* 行操作「更多」菜单 */}
      <Menu anchorEl={menuAnchor?.el} open={!!menuAnchor} onClose={closeMenu}>
        <MenuItem
          onClick={() => {
            if (menuAnchor) setEditing(menuAnchor.tpl);
            closeMenu();
          }}
        >
          <ListItemIcon><EditOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText>编辑</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuAnchor) void duplicate(menuAnchor.tpl);
            closeMenu();
          }}
        >
          <ListItemIcon><ContentCopyIcon fontSize="small" /></ListItemIcon>
          <ListItemText>复制</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuAnchor) void remove(menuAnchor.tpl);
            closeMenu();
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon><DeleteOutlineIcon fontSize="small" color="error" /></ListItemIcon>
          <ListItemText>删除</ListItemText>
        </MenuItem>
      </Menu>

      {/* 新增模板弹窗 */}
      <Dialog open={createOpen} onClose={() => !creating && setCreateOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>新增生命周期模板</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              select
              label="适用分类（必填）"
              size="small"
              fullWidth
              value={createForm.projectType}
              onChange={(e) => setCreateForm((f) => ({ ...f, projectType: e.target.value as ProjectType }))}
            >
              <MenuItem value="A">A 类（交付型）</MenuItem>
              <MenuItem value="B">B 类（产品型）</MenuItem>
              <MenuItem value="C">C 类（基建型）</MenuItem>
            </TextField>
            <TextField
              label="模板名称（必填）"
              size="small"
              fullWidth
              value={createForm.name}
              onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
              helperText="创建后进入编辑抽屉添加里程碑/质量门/交付物"
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
            onClick={() => void createTemplate()}
            disabled={creating || !createForm.name.trim()}
          >
            {creating ? '创建中…' : '创建'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* 编辑抽屉 */}
      <TemplateEditorDialog
        open={editing !== null}
        template={editing}
        onClose={() => setEditing(null)}
        onSaved={(t) => setRows((list) => list.map((x) => (x.id === t.id ? t : x)))}
      />
    </Stack>
  );
}
