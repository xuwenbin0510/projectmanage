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
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { SimpleTreeView, TreeItem } from '@mui/x-tree-view';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
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
import type { WbsNodeType, WbsTreeNode, TaskStatus, WbsRules } from '@/types/wbs';
import { useWbsStore } from '@/stores/wbsStore';
import { useProjectStore } from '@/stores/projectStore';
import { usePermission, useToast } from '@/hooks';
import { api } from '@/api/client';
import { allowedChildTypes, resolveWbsRules, validateWbsPlacement } from '@/api/mock/rules';
import {
  DEFAULT_WBS_RULES,
  GRANULARITY_LIMIT,
  TASK_STATUSES,
  WBS_NODE_TYPE_LABEL,
} from '@/config/enums';
import { tokens, alphaOf, toneColor } from '@/theme/tokens';
import { flattenTree, rollupProgress } from '@/utils/wbs';
import { fmtDays } from '@/utils/format';
import { dayjs, fmtDate, DATE_FMT } from '@/utils/date';

interface NodeForm {
  parentId: string;
  nodeType: WbsNodeType;
  name: string;
  owner: string;
  estimateDays: number;
  status: string;
  /** 关联里程碑 id（任务 / 子任务均可挂） */
  milestoneId: string;
  /** 截止日期 YYYY-MM-DD（用户反馈③ · 硬拦截） */
  dueDate: string;
}

const EMPTY_FORM: NodeForm = {
  parentId: '',
  nodeType: 'task',
  name: '',
  owner: '',
  estimateDays: 1,
  status: '待办',
  milestoneId: '',
  dueDate: '',
};

/**
 * WBS 工作分解结构：树形展示 + 新建 / 编辑 / 删除 / 粒度告警 / 层级规则预校验
 * @prd P0-06
 * WBS 简化方案一（Q-3）：只保留「任务 / 子任务」两类，靠层级区分容器与叶子；
 * 任务可下挂任务或子任务，子任务恒为最底层。方案一中已无阶段实体，任务直接挂里程碑。
 */
export function WbsPage(): JSX.Element {
  const { id = '' } = useParams();
  const toast = useToast();
  const { can } = usePermission();

  const project = useProjectStore((s) => s.current);
  const projectType = project?.type ?? 'A';
  const members = useProjectStore((s) => s.members);
  const milestones = useProjectStore((s) => s.milestones);

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
  /** 创建子任务时里程碑若继承自上级则锁定（用户反馈④a：避免误改继承关系） */
  const [lockMilestone, setLockMilestone] = useState<boolean>(false);
  const [rules, setRules] = useState<WbsRules>(DEFAULT_WBS_RULES);

  useEffect(() => {
    if (id) void fetchWbs(id, projectType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, projectType]);

  // WBS 层级规则：按项目分类取生效模板合并 DEFAULT_WBS_RULES（U-3/U-5 数据源）
  useEffect(() => {
    let alive = true;
    api
      .getLifecycleTemplate(projectType)
      .then((tpl) => {
        if (alive) setRules(resolveWbsRules(tpl));
      })
      .catch(() => {
        if (alive) setRules(DEFAULT_WBS_RULES);
      });
    return () => {
      alive = false;
    };
  }, [projectType]);

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

  const flatNodes = useMemo(() => flattenTree(tree), [tree]);
  const editingNode = useMemo(
    () => (editingId ? flatNodes.find((n) => n.id === editingId) ?? null : null),
    [editingId, flatNodes],
  );

  /** 当前表单「上级节点」对应的节点；空串 = 根层 */
  const formParent = useMemo(
    () => (form.parentId ? flatNodes.find((n) => n.id === form.parentId) ?? null : null),
    [form.parentId, flatNodes],
  );

  /** 上级节点允许的子类型（U-5：动态过滤类型下拉；空数组 = 已达深度上限/必为叶） */
  const allowedTypes = useMemo(() => allowedChildTypes(formParent, rules), [formParent, rules]);

  const milestoneOf = (milestoneId: string | null): { code: string; name: string } | null => {
    if (!milestoneId) return null;
    return milestones.find((m) => m.id === milestoneId) ?? null;
  };

  const openCreate = (parentId: string): void => {
    const parent = parentId ? flatNodes.find((n) => n.id === parentId) ?? null : null;
    setEditingId(null);
    setForm({
      ...EMPTY_FORM,
      parentId,
      // 用户反馈②：子任务默认继承上级绑定的里程碑与截止日期
      milestoneId: parent?.milestoneId ?? '',
      dueDate: parent?.dueDate ?? '',
    });
    // 用户反馈④a：继承自上二级碑则锁定，避免误改
    setLockMilestone(Boolean(parent?.milestoneId));
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
      milestoneId: node.milestoneId ?? '',
      dueDate: node.dueDate ?? '',
    });
    setLockMilestone(false);
    setDialogOpen(true);
  };

  const changeParent = (parentId: string): void => {
    const parent = parentId ? flatNodes.find((n) => n.id === parentId) ?? null : null;
    const nextAllowed = allowedChildTypes(parent, rules);
    // 若当前类型在新父下不合法，自动收敛到第一个允许类型（编辑态保持原类型可回显）
    const keepType =
      editingNode && editingNode.nodeType === form.nodeType
        ? form.nodeType
        : nextAllowed.includes(form.nodeType)
          ? form.nodeType
          : nextAllowed[0] ?? form.nodeType;
    // 用户反馈②：切换上级时默认继承其里程碑与截止日期
    setForm({
      ...form,
      parentId,
      nodeType: keepType,
      milestoneId: parent?.milestoneId ?? '',
      dueDate: parent?.dueDate ?? '',
    });
    // 用户反馈④a：仅新建态下、上级带碑时锁定里程碑
    setLockMilestone(editingId === null && Boolean(parent?.milestoneId));
  };

  const handleSubmit = async (): Promise<void> => {
    if (!form.name.trim()) {
      toast.warning('请填写节点名称');
      return;
    }
    // U-5 前端预校验（后端兜底）：父子类型 / 深度
    const preErr = validateWbsPlacement(
      {
        nodeType: form.nodeType,
        parent: formParent,
      },
      rules,
    );
    if (preErr) {
      toast.warning(preErr.message);
      return;
    }
    const payload = {
      parentId: form.parentId || null,
      nodeType: form.nodeType,
      name: form.name.trim(),
      owner: form.owner || undefined,
      estimateDays: Number(form.estimateDays) || 0,
      status: form.status as TaskStatus,
      // 任务 / 子任务均可挂里程碑
      milestoneId: form.milestoneId || null,
      dueDate: form.dueDate || undefined,
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
    const boundMs = milestoneOf(node.milestoneId);
    const canAddChild = allowedChildTypes(node, rules).length > 0;
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
            {boundMs && (
              <Chip
                size="small"
                variant="outlined"
                icon={<FlagOutlinedIcon sx={{ fontSize: 13 }} />}
                label={`${boundMs.code} ${boundMs.name}`}
                sx={{ height: 20, flexShrink: 0 }}
              />
            )}
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
            {isLeaf && (
              <Typography variant="caption" sx={{ color: 'text.secondary', width: 56, flexShrink: 0 }}>
                {fmtDays(node.estimateDays)}
              </Typography>
            )}
            {node.ownerName ? (
              <UserAvatar name={node.ownerName} size={24} />
            ) : (
              <Typography variant="caption" color="text.secondary">
                无负责人
              </Typography>
            )}
            {editable && (
              <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0 }}>
                <IconButton size="small" onClick={(e) => { e.stopPropagation(); openEdit(node); }}>
                  <EditOutlinedIcon sx={{ fontSize: 16 }} />
                </IconButton>
                <IconButton size="small" color="error" onClick={(e) => { e.stopPropagation(); setDeleteTarget(node); }}>
                  <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                </IconButton>
                <Tooltip title={canAddChild ? '新建子节点' : '该节点下不可再建子节点（已达层级上限或必为叶子）'} arrow>
                  <span>
                    <IconButton
                      size="small"
                      disabled={!canAddChild}
                      onClick={(e) => { e.stopPropagation(); openCreate(node.id); }}
                    >
                      <AddIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </span>
                </Tooltip>
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
        WBS 按 <strong>任务 → 子任务</strong> 组织：任务可继续下挂任务或子任务，子任务为最底层不可再分解；
        叶子任务须挂负责人与工时估算，
        {projectType === 'B' ? `粒度建议 ≤ ${GRANULARITY_LIMIT[projectType]} 人日` : `A/C 类粒度建议 ≤ ${GRANULARITY_LIMIT[projectType]} 人日`}。
      </Alert>

      <SectionCard
        title="工作分解结构（WBS）"
        subtitle={`共 ${nodes.length} 个节点 · 展开/折叠点击节点左侧箭头`}
        actions={
          <PermissionButton
            action="wbs:edit"
            disabledReason={archived ? '项目已归档' : ''}
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            onClick={() => openCreate('')}
          >
            新建任务
          </PermissionButton>
        }
        flush
      >
        {loading ? (
          <LoadingState variant="skeleton" rows={5} height={48} />
        ) : tree.length === 0 ? (
          <EmptyState
            title="暂无任务"
            description="该项目暂无 WBS 节点，可点击「新建任务」补建（新项目会按模板自动生成骨架）"
          />
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
          onChange={(e) => changeParent(e.target.value)}
          fullWidth
          helperText="根层可建任务；任务下可继续挂任务或子任务，子任务为最底层"
        >
          <MenuItem value="">（根节点）</MenuItem>
          {flatNodes
            .filter((n) => n.id !== editingId)
            .map((n) => (
              <MenuItem key={n.id} value={n.id}>
                {n.wbsCode} {n.name}（{WBS_NODE_TYPE_LABEL[n.nodeType]}）
              </MenuItem>
            ))}
        </TextField>
        <TextField
          select
          label="节点类型"
          value={form.nodeType}
          onChange={(e) => setForm({ ...form, nodeType: e.target.value as WbsNodeType })}
          fullWidth
          disabled={Boolean(editingNode && editingNode.children.length > 0)}
          helperText={
            editingNode && editingNode.children.length > 0
              ? '该节点已有子节点，类型不可修改'
              : allowedTypes.length === 0
                ? '当前上级节点下无可创建的类型'
                : `当前上级允许：${allowedTypes.map((t) => WBS_NODE_TYPE_LABEL[t]).join(' / ')}`
          }
        >
          {allowedTypes.length === 0 && editingNode ? (
            <MenuItem key={editingNode.nodeType} value={editingNode.nodeType}>
              {WBS_NODE_TYPE_LABEL[editingNode.nodeType]}
            </MenuItem>
          ) : (
            allowedTypes.map((t) => (
              <MenuItem key={t} value={t}>
                {WBS_NODE_TYPE_LABEL[t]}
              </MenuItem>
            ))
          )}
        </TextField>
        <TextField
          label="名称"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          fullWidth
          required
        />
        {/* U-4 关联里程碑选择器：任务 / 子任务均可挂，选填；继承自上级时锁定 */}
        <TextField
          select
          label={lockMilestone ? '关联里程碑（已继承上级·锁定）' : '关联里程碑（可选）'}
          value={form.milestoneId}
          onChange={(e) => setForm({ ...form, milestoneId: e.target.value })}
          fullWidth
          disabled={lockMilestone}
          helperText={
            lockMilestone
              ? '该任务继承自上级里程碑，不可修改；如需调整请到上级节点更改'
              : '将该任务挂到某个里程碑，便于按里程碑追踪交付'
          }
        >
          <MenuItem value="">（不关联）</MenuItem>
          {milestones.map((m) => (
            <MenuItem key={m.id} value={m.id}>
              {m.code} {m.name}（{fmtDate(m.currentDate)}）
            </MenuItem>
          ))}
        </TextField>
        {/* 用户反馈③：截止日期字段（硬拦截在引擎层，前端预填父级日期） */}
        <DatePicker
          label="截止日期"
          value={form.dueDate ? dayjs(form.dueDate) : null}
          format={DATE_FMT}
          slotProps={{ textField: { size: 'small', fullWidth: true } }}
          onChange={(v) => setForm({ ...form, dueDate: v && v.isValid() ? v.format(DATE_FMT) : '' })}
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
