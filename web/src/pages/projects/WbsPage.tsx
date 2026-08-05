import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { SimpleTreeView, TreeItem } from '@mui/x-tree-view';
import { useParams } from 'react-router-dom';

import {
  ConfirmDialog,
  EmptyState,
  FormDialog,
  LoadingState,
  PermissionButton,
  ProgressBar,
  SectionCard,
  UserAvatar,
} from '@/components/common';
import type { WbsNodeType, WbsTreeNode, TaskStatus } from '@/types/wbs';
import { useWbsStore } from '@/stores/wbsStore';
import { useProjectStore } from '@/stores/projectStore';
import { usePermission, useToast } from '@/hooks';
import { GRANULARITY_LIMIT, TASK_STATUSES, WBS_NODE_TYPE_LABEL } from '@/config/enums';
import { tokens, toneColor } from '@/theme/tokens';
import { flattenTree, rollupProgress } from '@/utils/wbs';
import { fmtDays } from '@/utils/format';

interface NodeForm {
  parentId: string;
  nodeType: WbsNodeType;
  name: string;
  owner: string;
  estimateDays: number;
  status: string;
}

const EMPTY_FORM: NodeForm = {
  parentId: '',
  nodeType: 'package',
  name: '',
  owner: '',
  estimateDays: 1,
  status: '待办',
};

/**
 * WBS 工作分解结构：树形展示 + 新建 / 编辑 / 删除 / 粒度告警
 * @prd P0-06
 */
export function WbsPage(): JSX.Element {
  const { id = '' } = useParams();
  const toast = useToast();
  const { can } = usePermission();

  const project = useProjectStore((s) => s.current);
  const projectType = project?.type ?? 'A';
  const members = useProjectStore((s) => s.members);

  const tree = useWbsStore((s) => s.tree);
  const nodes = useWbsStore((s) => s.nodes);
  const loading = useWbsStore((s) => s.loading);
  const fetchWbs = useWbsStore((s) => s.fetchWbs);
  const createNode = useWbsStore((s) => s.createNode);
  const updateNode = useWbsStore((s) => s.updateNode);
  const deleteNode = useWbsStore((s) => s.deleteNode);

  const [form, setForm] = useState<NodeForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WbsTreeNode | null>(null);

  useEffect(() => {
    if (id) void fetchWbs(id, projectType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, projectType]);

  const archived = project?.status === '已结项' || project?.status === '已终止';
  const editable = can('wbs:edit') && !archived;

  // 改动 B：一人可担任多个角色 → db.members 一人多行，按 userOpenId 去重避免 MUI Select 重复 value
  const memberOptions = useMemo(
    () =>
      Array.from(new Map(members.map((m) => [m.userOpenId, m])).values()).map((m) => ({
        value: m.userOpenId,
        label: m.userName,
      })),
    [members],
  );

  const allIds = useMemo(() => flattenTree(tree).map((n) => n.id), [tree]);
  const expanded = useMemo(() => allIds, [allIds]);

  const openCreate = (parentId: string): void => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, parentId });
    setDialogOpen(true);
  };

  const openEdit = (node: WbsTreeNode): void => {
    setEditingId(node.id);
    setForm({
      parentId: node.parentId ?? '',
      nodeType: node.nodeType,
      name: node.name,
      owner: node.owner,
      estimateDays: node.estimateDays,
      status: node.status,
    });
    setDialogOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    if (!form.name.trim()) {
      toast.warning('请填写节点名称');
      return;
    }
    const payload = {
      parentId: form.parentId || null,
      nodeType: form.nodeType,
      name: form.name.trim(),
      owner: form.owner || undefined,
      estimateDays: Number(form.estimateDays) || 0,
      status: form.status as TaskStatus,
    };
    try {
      if (editingId) {
        await updateNode(editingId, payload);
        toast.success('节点已更新');
      } else {
        await createNode(payload);
        toast.success('节点已创建');
      }
      setDialogOpen(false);
    } catch (e) {
      toast.error(e);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    try {
      await deleteNode(deleteTarget.id);
      toast.success('节点已删除');
      setDeleteTarget(null);
    } catch (e) {
      toast.error(e);
      setDeleteTarget(null);
    }
  };

  const renderNode = (node: WbsTreeNode): JSX.Element => {
    const progress = rollupProgress(node);
    const isLeaf = node.children.length === 0;
    const limit = GRANULARITY_LIMIT[projectType];
    return (
      <TreeItem
        key={node.id}
        itemId={node.id}
        label={
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ py: 0.5, pr: 1, minWidth: 0 }}
          >
            <Typography variant="caption" sx={{ color: 'text.secondary', width: 38, flexShrink: 0 }}>
              {node.wbsCode}
            </Typography>
            <Chip size="small" variant="outlined" label={WBS_NODE_TYPE_LABEL[node.nodeType]} sx={{ height: 20, flexShrink: 0 }} />
            <Typography sx={{ fontSize: 14, fontWeight: 500, minWidth: 0, flex: '1 1 auto' }} noWrap>
              {node.name}
            </Typography>
            {node.warnings.length > 0 && (
              <Tooltip title={node.warnings.join('；')} arrow>
                <WarningAmberIcon sx={{ fontSize: 16, color: toneColor.warning }} />
              </Tooltip>
            )}
            {isLeaf && (
              <Box sx={{ width: 120, flexShrink: 0 }}>
                <ProgressBar value={progress} height={5} showLabel={false} />
              </Box>
            )}
            {isLeaf && <Typography variant="caption" sx={{ color: 'text.secondary', width: 56, flexShrink: 0 }}>{fmtDays(node.estimateDays)}</Typography>}
            {node.ownerName ? <UserAvatar name={node.ownerName} size={24} /> : <Typography variant="caption" color="text.secondary">无负责人</Typography>}
            {editable && (
              <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0 }}>
                <IconButton size="small" onClick={(e) => { e.stopPropagation(); openEdit(node); }}>
                  <EditOutlinedIcon sx={{ fontSize: 16 }} />
                </IconButton>
                <IconButton size="small" color="error" onClick={(e) => { e.stopPropagation(); setDeleteTarget(node); }}>
                  <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                </IconButton>
                <IconButton size="small" onClick={(e) => { e.stopPropagation(); openCreate(node.id); }}>
                  <AddIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Stack>
            )}
          </Stack>
        }
      >
        {node.children.map((c) => renderNode(c))}
      </TreeItem>
    );
  };

  return (
    <Stack spacing={2.5}>
      <Alert severity="info" variant="outlined">
        WBS 按 <strong>阶段 → 工作包 → 任务</strong> 三级分解；叶子任务须挂负责人与工时估算，
        {projectType === 'B' ? `粒度建议 ≤ ${GRANULARITY_LIMIT[projectType]} 人日` : `A/C 类粒度建议 ≤ ${GRANULARITY_LIMIT[projectType]} 人日`}。
      </Alert>

      <SectionCard
        title="工作分解结构（WBS）"
        subtitle={`共 ${nodes.length} 个节点 · 展开/折叠点击节点左侧箭头`}
        actions={
          <PermissionButton action="wbs:edit" disabledReason={archived ? '项目已归档' : ''} variant="contained" size="small" startIcon={<AddIcon />} onClick={() => openCreate('')}>
            新建根节点
          </PermissionButton>
        }
        flush
      >
        {loading ? (
          <LoadingState variant="skeleton" rows={5} height={48} />
        ) : tree.length === 0 ? (
          <EmptyState title="暂无 WBS 节点" description="点击右上角「新建根节点」开始分解" />
        ) : (
          <Box sx={{ px: 1, py: 1 }}>
            <SimpleTreeView defaultExpandedItems={expanded} sx={{ flexGrow: 1 }}>
              {tree.map((n) => renderNode(n))}
            </SimpleTreeView>
          </Box>
        )}
      </SectionCard>

      <FormDialog
        open={dialogOpen}
        title={editingId ? '编辑 WBS 节点' : '新建 WBS 节点'}
        submitText={editingId ? '保存' : '创建'}
        onClose={() => setDialogOpen(false)}
        onSubmit={() => void handleSubmit()}
      >
        <TextField
          select
          label="上级节点"
          value={form.parentId}
          onChange={(e) => setForm({ ...form, parentId: e.target.value })}
          fullWidth
        >
          <MenuItem value="">（根节点）</MenuItem>
          {flattenTree(tree)
            .filter((n) => n.id !== editingId)
            .map((n) => (
              <MenuItem key={n.id} value={n.id}>
                {n.wbsCode} {n.name}
              </MenuItem>
            ))}
        </TextField>
        <TextField
          select
          label="节点类型"
          value={form.nodeType}
          onChange={(e) => setForm({ ...form, nodeType: e.target.value as WbsNodeType })}
          fullWidth
        >
          {(['stage', 'package', 'task'] as WbsNodeType[]).map((t) => (
            <MenuItem key={t} value={t}>
              {WBS_NODE_TYPE_LABEL[t]}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="名称"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          fullWidth
          required
        />
        <TextField
          select
          label="负责人"
          value={form.owner}
          onChange={(e) => setForm({ ...form, owner: e.target.value })}
          fullWidth
        >
          <MenuItem value="">（未指派）</MenuItem>
          {memberOptions.map((m) => (
            <MenuItem key={m.value} value={m.value}>
              {m.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="工时估算（人日）"
          type="number"
          value={form.estimateDays}
          onChange={(e) => setForm({ ...form, estimateDays: Number(e.target.value) })}
          fullWidth
          InputProps={{ inputProps: { min: 0 } }}
        />
        <TextField
          select
          label="状态"
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value })}
          fullWidth
        >
          {TASK_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {s}
            </MenuItem>
          ))}
        </TextField>
      </FormDialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除 WBS 节点"
        danger
        confirmText="删除"
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        content={
          deleteTarget
            ? `确定删除「${deleteTarget.wbsCode} ${deleteTarget.name}」${deleteTarget.children.length ? '及其全部子节点' : ''}？该操作不可撤销。`
            : ''
        }
      />
    </Stack>
  );
}
