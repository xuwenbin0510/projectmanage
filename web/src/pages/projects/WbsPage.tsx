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
import { fmtDate } from '@/utils/date';

interface NodeForm {
  parentId: string;
  nodeType: WbsNodeType;
  name: string;
  owner: string;
  estimateDays: number;
  status: string;
  /** 归属生命周期阶段 id（仅 nodeType='stage' 显示/提交） */
  lifecycleStageId: string;
  /** 关联里程碑 id（仅 package/task 显示/提交） */
  milestoneId: string;
}

const EMPTY_FORM: NodeForm = {
  parentId: '',
  nodeType: 'package',
  name: '',
  owner: '',
  estimateDays: 1,
  status: '待办',
  lifecycleStageId: '',
  milestoneId: '',
};

/**
 * WBS 工作分解结构：树形展示 + 新建 / 编辑 / 删除 / 粒度告警 / 层级规则预校验
 * @prd P0-06
 * WBS 重构 D-2/D-4：层级规则（R-1~R-6）由模板 wbsRules 驱动，页面与引擎共用 validateWbsPlacement；
 * 文案「阶段」统一改为「工作分区」，stage 节点支持绑定生命周期阶段，task/package 支持挂里程碑。
 */
export function WbsPage(): JSX.Element {
  const { id = '' } = useParams();
  const toast = useToast();
  const { can } = usePermission();

  const project = useProjectStore((s) => s.current);
  const projectType = project?.type ?? 'A';
  const members = useProjectStore((s) => s.members);
  const stages = useProjectStore((s) => s.stages);
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

  /** 阶段 id → 「S3 设计」 快速查找 */
  const stageLabelOf = (stageId: string | null): string => {
    if (!stageId) return '';
    const st = stages.find((s) => s.id === stageId);
    return st ? `${st.code} ${st.name}` : stageId;
  };

  const milestoneOf = (milestoneId: string | null): { code: string; name: string } | null => {
    if (!milestoneId) return null;
    return milestones.find((m) => m.id === milestoneId) ?? null;
  };

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
      lifecycleStageId: node.lifecycleStageId ?? '',
      milestoneId: node.milestoneId ?? '',
    });
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
    setForm({ ...form, parentId, nodeType: keepType });
  };

  const handleSubmit = async (): Promise<void> => {
    if (!form.name.trim()) {
      toast.warning('请填写节点名称');
      return;
    }
    // U-5 前端预校验（后端兜底）：父子类型 / 深度 / stage 绑定
    const preErr = validateWbsPlacement(
      {
        nodeType: form.nodeType,
        parent: formParent,
        lifecycleStageId: form.nodeType === 'stage' ? (form.lifecycleStageId || null) : null,
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
      // 仅工作分区可带归属阶段；其余类型强制 null（引擎侧同规则）
      lifecycleStageId: form.nodeType === 'stage' ? (form.lifecycleStageId || null) : null,
      // 仅 package/task 可挂里程碑
      milestoneId: form.nodeType === 'stage' ? null : (form.milestoneId || null),
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
    const canAddChild = allowedChildTypes(node, rules).length > 0;
    const boundStage = node.nodeType === 'stage' ? stageLabelOf(node.lifecycleStageId) : '';
    const boundMs = node.nodeType !== 'stage' ? milestoneOf(node.milestoneId) : null;
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
            {boundStage && (
              <Chip
                size="small"
                label={boundStage}
                sx={{ height: 20, flexShrink: 0, bgcolor: alphaOf(tokens.brand.primary, 0.08), color: tokens.brand.primary }}
              />
            )}
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
        WBS 按 <strong>工作分区 → 工作包 → 任务</strong> 三级分解；工作分区可绑定到生命周期阶段（未绑定仅提示、不阻塞），
        叶子任务须挂负责人与工时估算，
        {projectType === 'B' ? `粒度建议 ≤ ${GRANULARITY_LIMIT[projectType]} 人日` : `A/C 类粒度建议 ≤ ${GRANULARITY_LIMIT[projectType]} 人日`}。
      </Alert>

      <SectionCard
        title="工作分解结构（WBS）"
        subtitle={`共 ${nodes.length} 个节点 · 展开/折叠点击节点左侧箭头`}
        actions={
          <PermissionButton action="wbs:edit" disabledReason={archived ? '项目已归档' : ''} variant="contained" size="small" startIcon={<AddIcon />} onClick={() => openCreate('')}>
            新建工作分区
          </PermissionButton>
        }
        flush
      >
        {loading ? (
          <LoadingState variant="skeleton" rows={5} height={48} />
        ) : tree.length === 0 ? (
          <EmptyState title="暂无工作分区" description="该项目暂无工作分区，可点击「新建工作分区」补建（新项目会按模板自动生成骨架）" />
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
          helperText="根层可建工作分区 / 工作包；任务为叶子节点，其下不可再建"
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
              ? '该节点已有子节点，类型不可修改（R-4 类型锁）'
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
        {/* U-3 归属阶段选择器：仅工作分区显示；A/C 必填（requireStageBinding），B 选填 */}
        {form.nodeType === 'stage' && (
          <TextField
            select
            label={rules.requireStageBinding ? '归属生命周期阶段（必选）' : '归属生命周期阶段（可选）'}
            value={form.lifecycleStageId}
            onChange={(e) => setForm({ ...form, lifecycleStageId: e.target.value })}
            fullWidth
            error={Boolean(rules.requireStageBinding && !form.lifecycleStageId)}
            helperText={
              rules.requireStageBinding && !form.lifecycleStageId
                ? '当前项目类型要求工作分区必须绑定生命周期阶段'
                : '选择该工作分区覆盖的生命周期阶段'
            }
          >
            <MenuItem value="">（未绑定）</MenuItem>
            {stages.map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.code} {s.name}
              </MenuItem>
            ))}
          </TextField>
        )}
        {/* U-4 关联里程碑选择器：仅工作包/任务显示；选填；补 I-1 */}
        {form.nodeType !== 'stage' && (
          <TextField
            select
            label="关联里程碑（可选）"
            value={form.milestoneId}
            onChange={(e) => setForm({ ...form, milestoneId: e.target.value })}
            fullWidth
            helperText="将该工作包 / 任务挂到某个里程碑，便于按里程碑追踪交付"
          >
            <MenuItem value="">（不关联）</MenuItem>
            {milestones.map((m) => (
              <MenuItem key={m.id} value={m.id}>
                {m.code} {m.name}（{fmtDate(m.currentDate)}）
              </MenuItem>
            ))}
          </TextField>
        )}
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
            ? `确定删除「${deleteTarget.wbsCode} ${deleteTarget.name}」${deleteTarget.children.length ? '及其全部子节点' : ''}？该操作不可撤销。${
                deleteTarget.nodeType === 'stage' && deleteTarget.lifecycleStageId && deleteTarget.children.length > 0
                  ? '注意：该工作分区已绑定生命周期阶段且含有子节点，删除会被引擎拦截（骨架保护）。'
                  : ''
              }`
            : ''
        }
      />
    </Stack>
  );
}
