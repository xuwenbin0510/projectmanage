import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { SimpleTreeView, TreeItem } from '@mui/x-tree-view';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import type { Dayjs } from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import { ROUTES } from '@/config/routes';

import {
  ConfirmDialog,
  EmptyState,
  FormDialog,
  LoadingState,
  PermissionButton,
  ProgressBar,
  SectionCard,
  StatusChip,
  UserAvatar,
} from '@/components/common';
import { ReportFormModal } from '@/components/report/ReportFormModal';
import type { WbsNodeType, WbsTreeNode, TaskStatus, WbsRules, Priority } from '@/types/wbs';
import { useWbsStore } from '@/stores/wbsStore';
import { useProjectStore } from '@/stores/projectStore';
import { useFlowStore } from '@/stores/flowStore';
import { usePermission, useToast } from '@/hooks';
import { api, USE_MOCK } from '@/api/client';
import { csvDateStamp, downloadCsv, fetchCsv, toCsv } from '@/utils/csv';
import { allowedChildTypes, resolveWbsRules, validateWbsPlacement } from '@/api/mock/rules';
import {
  DEFAULT_WBS_RULES,
  GRANULARITY_LIMIT,
  TASK_STATUSES,
  WBS_NODE_TYPE_LABEL,
  PRIORITY_OPTIONS,
  DEFAULT_PRIORITY,
} from '@/config/enums';
import { tokens, toneColor, progressToneOf } from '@/theme/tokens';
import { flattenTree, rollupProgress } from '@/utils/wbs';
import { fmtDays } from '@/utils/format';
import { dayjs, fmtDate, DATE_FMT, isOverdue, today, diffDays } from '@/utils/date';
import { reportCountByNode, nodeReportsOf } from '@/utils/reportAgg';
import { memberNameOf } from '@/utils/member';

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
  /** 开始日期 YYYY-MM-DD（B16：让工时估算按真实起止区间校验，而非默认锚定今天） */
  startDate: string;
  /** 任务优先级（B14-块1）：默认 P2 */
  priority: Priority;
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
  startDate: '',
  priority: DEFAULT_PRIORITY,
};

/**
 * WBS 工作分解结构：树形展示 + 新建 / 编辑 / 删除 / 粒度告警 / 层级规则预校验
 * @prd P0-06
 * WBS 简化方案一（Q-3）：只保留「任务 / 子任务」两类，靠层级区分容器与叶子；
 * 任务可下挂任务或子任务，子任务恒为最底层。方案一中已无阶段实体，任务直接挂里程碑。
 */
/** 导出列（与后端 server/services/export.service.js 口径一致）。 */
const TASK_CSV_HEADERS = [
  '节点ID', 'WBS编码', '层级', '类型', '名称', '描述', '负责人ID', '负责人名',
  '估算_天', '实际_天', '开始', '截止', '状态', '进度(%)', '优先级', '关键路径', '里程碑ID', '父ID',
];

export function WbsPage(): JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = usePermission();

  const project = useProjectStore((s) => s.current);
  const projectType = project?.type ?? 'A';
  const members = useProjectStore((s) => s.members);
  const milestones = useProjectStore((s) => s.milestones);
  const refreshMilestones = useProjectStore((s) => s.refreshMilestones);

  const tree = useWbsStore((s) => s.tree);
  const nodes = useWbsStore((s) => s.nodes);
  const loading = useWbsStore((s) => s.loading);
  const fetchWbs = useWbsStore((s) => s.fetchWbs);
  const createNode = useWbsStore((s) => s.createNode);
  const updateNode = useWbsStore((s) => s.updateNode);
  const deleteNode = useWbsStore((s) => s.deleteNode);

  /** 导出 WBS 任务 CSV（真实模式走服务端，mock 模式本地生成）。 */
  const handleExportTasks = async (): Promise<void> => {
    try {
      let csv: string;
      if (USE_MOCK) {
        const rows = nodes.map((n) => ({
          节点ID: n.id,
          WBS编码: n.wbsCode,
          层级: n.level,
          类型: n.nodeType,
          名称: n.name,
          描述: n.description,
          负责人ID: n.owner,
          负责人名: n.ownerName,
          估算_天: n.estimateDays,
          实际_天: n.actualDays,
          开始: n.startDate,
          截止: n.dueDate,
          状态: n.status,
          进度: n.progress,
          优先级: n.priority,
          关键路径: n.isCritical ? '是' : '否',
          里程碑ID: n.milestoneId || '',
          父ID: n.parentId || '',
        }));
        csv = toCsv(TASK_CSV_HEADERS, rows);
      } else {
        csv = await fetchCsv(`/export/projects/${id}/tasks`);
      }
      downloadCsv(`project_tasks_${id}_${csvDateStamp()}.csv`, csv);
      toast.success('WBS 任务已导出');
    } catch (e) {
      toast.error(e);
    }
  };

  /* R3-5：工作日志数据源（徽标计数 / 详情聚合） */
  const reports = useFlowStore((s) => s.reports);
  const fetchReports = useFlowStore((s) => s.fetchReports);

  const [form, setForm] = useState<NodeForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WbsTreeNode | null>(null);
  /** R3-5：日志详情弹窗的目标节点 */
  const [logDetailNode, setLogDetailNode] = useState<WbsTreeNode | null>(null);
  /** D04.2 反查：任务附件计数（按 nodeId） */
  const [docCountByNode, setDocCountByNode] = useState<Record<string, number>>({});
  /** R4-P0-4：页内写日志 Modal 开关 + 预关联锁定节点 id（不再跳转 ReportsPage） */
  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [reportLockNodeId, setReportLockNodeId] = useState<string | null>(null);
  /** 创建子任务时里程碑若继承自上级则锁定（用户反馈④a：避免误改继承关系） */
  const [lockMilestone, setLockMilestone] = useState<boolean>(false);
  /** R5-P0-2：从节点行「+」创建下级时锁定「上级节点」（与 lockMilestone 同层同范式；移动节点走「编辑」） */
  const [lockParent, setLockParent] = useState<boolean>(false);
  const [rules, setRules] = useState<WbsRules>(DEFAULT_WBS_RULES);

  useEffect(() => {
    if (id) {
      void fetchWbs(id, projectType);
      // ★ R3-4 根因修复：WBS 页挂载即同步刷新里程碑（与 MilestonesPage 一致），
      //   保证「关联里程碑」下拉 / 节点徽标使用引擎最新排序（currentDate 升序 + M1..Mn 幂等）
      void refreshMilestones(id);
      // ★ R3-5：挂载拉取工作日志（徽标计数与详情聚合数据源）
      void fetchReports(id).catch((e: unknown) => toast.error(e));
      // ★ D04.2 反查：拉取项目文档，按任务 nodeId 统计附件数（跳转文档页 ?node= 反查）
      void api
        .listDocuments(id)
        .then((list) => {
          const m: Record<string, number> = {};
          list.forEach((d) => {
            if (d.nodeId) m[d.nodeId] = (m[d.nodeId] ?? 0) + 1;
          });
          setDocCountByNode(m);
        })
        .catch(() => {
          // 附件计数失败不影响 WBS
        });
    }
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

  /* ── R3-5：日志聚合派生值 ── */
  /** 节点 → 关联日志数（selected=true 口径，与 ReportsPage 列表「关联任务数」一致） */
  const reportCounts = useMemo(() => reportCountByNode(reports), [reports]);
  /** 详情弹窗数据：目标节点关联日志（createdAt 升序） */
  const nodeReports = useMemo(
    () => (logDetailNode ? nodeReportsOf(reports, logDetailNode.id) : []),
    [reports, logDetailNode],
  );
  /** 写日志入口：report:write 权限且项目未归档（不依赖 wbs:edit，保证只有写日志权限的人也能写） */
  const canWriteLog = can('report:write') && !archived;

  /**
   * B16-估算联动：工时估算默认值 = 1人 × 计划天数（开始→截止区间，含首尾）。
   * - 随开始/截止日期变化自动联动；
   * - 用户一旦手动修改估算，即冻结自动联动（后续改日期不再覆盖手动值）。
   */
  const manualEstimateRef = useRef(false);
  const plannedDaysOf = (start: string, due: string): number => {
    if (start && due) {
      const d = diffDays(start, due);
      if (Number.isFinite(d)) return Math.max(1, Math.floor(d) + 1); // 含首尾：同日 = 1 天
    }
    return 1;
  };
  const plannedDays = plannedDaysOf(form.startDate, form.dueDate);
  const handleStartDateChange = (v: Dayjs | null): void => {
    const sd = v && v.isValid() ? v.format(DATE_FMT) : '';
    const est = manualEstimateRef.current ? form.estimateDays : plannedDaysOf(sd, form.dueDate);
    setForm({ ...form, startDate: sd, estimateDays: est });
  };
  const handleDueDateChange = (v: Dayjs | null): void => {
    const dd = v && v.isValid() ? v.format(DATE_FMT) : '';
    const est = manualEstimateRef.current ? form.estimateDays : plannedDaysOf(form.startDate, dd);
    setForm({ ...form, dueDate: dd, estimateDays: est });
  };

  const openCreate = (parentId: string): void => {
    const parent = parentId ? flatNodes.find((n) => n.id === parentId) ?? null : null;
    setEditingId(null);
    const sd = parent?.startDate ?? dayjs().format(DATE_FMT);
    const dd = parent?.dueDate ?? '';
    setForm({
      ...EMPTY_FORM,
      parentId,
      // R5-P0-2（D-4 防御）：上级锁定后用户无法再靠换父触发 changeParent 的类型收敛，
      // 这里先收敛到该上级允许的首个类型（默认规则下恒为「任务」，行为零变化）
      nodeType: allowedChildTypes(parent, rules)[0] ?? EMPTY_FORM.nodeType,
      // 用户反馈②：子任务默认继承上级绑定的里程碑与截止日期
      milestoneId: parent?.milestoneId ?? '',
      dueDate: dd,
      // B16：开始日期默认继承上级；上级无则取今天，使工时估算起止区间对用户可见、可调整
      startDate: sd,
      // B16-估算联动：新建默认估算 = 1人 × 计划天数（含首尾）
      estimateDays: plannedDaysOf(sd, dd),
      // B14-块1：新节点默认 P2（服务端与 EMPTY_FORM 兜底一致）
      priority: DEFAULT_PRIORITY,
    });
    manualEstimateRef.current = false;
    // 用户反馈④a：继承自上二级碑则锁定，避免误改
    setLockMilestone(Boolean(parent?.milestoneId));
    // R5-P0-2：节点行「+」进入（parentId 非空）锁定上级；顶部「新建任务」openCreate('') 恒不锁（AC-2.7）
    setLockParent(Boolean(parentId));
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
      // B16：开始日期回显（无则取今天，保证区间可见，工时估算按真实窗口校验）
      startDate: node.startDate ?? dayjs().format(DATE_FMT),
      priority: node.priority,
    });
    setLockMilestone(false);
    // R5-P0-2（AC-2.8）：编辑是合法的「移动节点」路径，上级保持可改
    setLockParent(false);
    // B16-估算联动：编辑态同样「默认跟随日期联动」——打开时回填既有估算值用于展示，
    // 但一旦用户改日期即按 1人×计划天数 重算；只有用户在估算输入框手动键入才冻结（见 estimate onChange）
    manualEstimateRef.current = false;
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
    const sd = parent?.startDate ?? dayjs().format(DATE_FMT);
    const dd = parent?.dueDate ?? '';
    setForm({
      ...form,
      parentId,
      nodeType: keepType,
      milestoneId: parent?.milestoneId ?? '',
      dueDate: dd,
      // B16：切换上级时同步继承其开始日期（与截止日期一致）
      startDate: sd,
      // B16-估算联动：未手动改过时，跟随新上级的计划区间重算默认估算
      estimateDays: manualEstimateRef.current ? form.estimateDays : plannedDaysOf(sd, dd),
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
    // B16：开始日期不得晚于截止日期（否则起止区间非法，工时估算校验无意义）
    if (form.startDate && form.dueDate && diffDays(form.startDate, form.dueDate) < 0) {
      toast.warning('开始日期不能晚于截止日期');
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
      // B16：开始日期随表单上报（缺省由后端回落今天），使工时估算按真实起止区间校验
      startDate: form.startDate || undefined,
      // B14-块1：优先级随表单上报（缺省已在 EMPTY_FORM / openCreate 兜底为 P2）
      priority: form.priority,
    };
    try {
      if (editingId) {
        const saved = await updateNode(editingId, payload);
        // 叶子且用户手动改了状态：若后端按进度引擎收敛后状态与意图不一致，提示真实结果
        const isParent = Boolean(editingNode && editingNode.children.length > 0);
        if (!isParent && payload.status && saved.status && saved.status !== payload.status) {
          toast.warning(`状态已按进度自动调整为「${saved.status}」`);
        } else {
          toast.success('节点已更新');
        }
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
    const logCount = reportCounts.get(node.id) ?? 0;
    /* B16：逾期（未完成且超截止日）红标 / 临期（未完成且 3 天内）黄标，口径同工作台 utils/date；已完成不标 */
    const overdue = node.status !== '完成' && isOverdue(node.dueDate);
    const dueSoon = node.status !== '完成' && !overdue && diffDays(today(), node.dueDate) <= 3;
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
            {/* R4-P0-5：节点行状态标识（全节点可见，父/叶同规则） */}
            <StatusChip
              status={node.status}
              variant="soft"
              sx={{ width: 52, justifyContent: 'center', flexShrink: 0 }}
            />
            {boundMs && (
              <Chip
                size="small"
                variant="outlined"
                icon={<FlagOutlinedIcon sx={{ fontSize: 13 }} />}
                label={`${boundMs.code} ${boundMs.name}`}
                sx={{ height: 20, flexShrink: 0 }}
              />
            )}
            {/* R3-3 / B16：行内计划起止区间，去掉「开始/截止」字样省空间；逾期红 / 临期黄仅作用于截止 */}
            {!node.startDate && !node.dueDate ? (
              <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 0 }}>
                —
              </Typography>
            ) : (
              <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0, alignItems: 'baseline' }}>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {fmtDate(node.startDate) || '—'}
                </Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  →
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    color: overdue ? tokens.status.danger : dueSoon ? tokens.status.warning : 'text.secondary',
                    fontWeight: overdue || dueSoon ? 600 : 400,
                  }}
                >
                  {fmtDate(node.dueDate) || '—'}
                  {overdue ? ' · 逾期' : dueSoon ? ' · 临期' : ''}
                </Typography>
              </Stack>
            )}
            {/* R3-5：日志聚合徽标（n=0 弱化样式，仍可点击查看空态） */}
            <Chip
              size="small"
              label={`日志 ${logCount}`}
              variant={logCount > 0 ? 'filled' : 'outlined'}
              color={logCount > 0 ? 'primary' : 'default'}
              sx={{ height: 20, flexShrink: 0, cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation();
                setLogDetailNode(node);
              }}
            />
            {/* D04.2 反查：任务附件徽标（点击跳文档页并筛选该任务） */}
            <Chip
              size="small"
              label={`附件 ${docCountByNode[node.id] ?? 0}`}
              variant={(docCountByNode[node.id] ?? 0) > 0 ? 'filled' : 'outlined'}
              color={(docCountByNode[node.id] ?? 0) > 0 ? 'secondary' : 'default'}
              sx={{ height: 20, flexShrink: 0, cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation();
                navigate(`${ROUTES.projectDocuments(id)}?node=${node.id}`);
              }}
            />
            {/* R4-P0-4：写日志入口（页内开 ReportFormModal，不再跳转工作日志页）
                R5-P0-3 源头拦截：仅叶子可点，父节点禁用置灰 + Tooltip 引导（AC-3.1/3.2）；
                PermissionButton 见 disabledReason 即自动 disabled + Tooltip，无需再加 disabled / 包 span */}
            {canWriteLog && (
              <PermissionButton
                action="report:write"
                disabledReason={
                  archived ? '项目已归档' : isLeaf ? '' : '该任务已有下级，请在具体子任务上记录工作日志'
                }
                size="small"
                sx={{ height: 24, minWidth: 0, px: 1, fontSize: 12, flexShrink: 0 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setReportLockNodeId(node.id);
                  setReportModalOpen(true);
                }}
              >
                写日志
              </PermissionButton>
            )}
            {node.warnings.length > 0 && (
              <Tooltip title={node.warnings.join('；')} arrow>
                <WarningAmberIcon sx={{ fontSize: 16, color: toneColor.warning }} />
              </Tooltip>
            )}
            {/* R4-P0-5：进度条全节点渲染（父节点=子树叶子加权汇总，D1）+ 悬停百分比/状态 + 状态色调 */}
            <Tooltip title={`${node.name} ${progress}%（${node.status}）`} arrow>
              <Box sx={{ width: 120, flexShrink: 0 }}>
                <ProgressBar value={progress} height={5} showLabel={false} tone={progressToneOf(node.status)} />
              </Box>
            </Tooltip>
            {/* B9（R5）：全节点「估 x.x · 实 x.x 人日」只读（前端零聚合，直接用出参
                estimateDays/effortHours/effortChildCount；父=Σ 子由服务端 decorateEffort 保证） */}
            <Tooltip
              title={isLeaf ? '估算 vs 累计实际工时（人日）' : `实为 Σ ${node.effortChildCount} 个子任务（由工作日志累计）`}
              arrow
            >
              <Typography
                variant="caption"
                sx={{ color: 'text.secondary', width: 116, flexShrink: 0, textAlign: 'right', whiteSpace: 'nowrap' }}
              >
                估 {fmtDays(node.estimateDays)} · 实 {fmtDays(node.effortHours)}
              </Typography>
            </Tooltip>
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
        粒度建议 ≤ ${GRANULARITY_LIMIT[projectType]} 人日（超过仅提示拆分，不阻断保存）。
      </Alert>

      <SectionCard
        title="工作分解结构（WBS）"
        subtitle={`共 ${nodes.length} 个节点 · 展开/折叠点击节点左侧箭头`}
        actions={
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<FileDownloadIcon />}
              onClick={handleExportTasks}
            >
              导出 CSV
            </Button>
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
          </Stack>
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
        {/* R5-P0-2：从「创建下级任务」进入时锁定上级（字段级锁定范式，与下方 lockMilestone 一致） */}
        <TextField
          select
          label={lockParent ? '上级节点（已锁定）' : '上级节点'}
          value={form.parentId}
          onChange={(e) => changeParent(e.target.value)}
          fullWidth
          disabled={lockParent}
          helperText={
            lockParent
              ? '由「创建下级任务」进入，上级节点已锁定；如需调整层级，请到该节点「编辑」中修改上级'
              : '根层可建任务；任务下可继续挂任务或子任务，子任务为最底层'
          }
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
        {/* B16：开始日期字段——让工时估算的起止区间由用户真实定义，而非后端默认锚定今天 */}
        <DatePicker
          label="开始日期"
          value={form.startDate ? dayjs(form.startDate) : null}
          format={DATE_FMT}
          onChange={(v) => handleStartDateChange(v)}
          slotProps={{ textField: { fullWidth: true, size: 'small' } }}
        />
        {/* 用户反馈③：截止日期字段（硬拦截在引擎层，前端预填父级日期） */}
        <DatePicker
          label="截止日期"
          value={form.dueDate ? dayjs(form.dueDate) : null}
          format={DATE_FMT}
          slotProps={{ textField: { size: 'small', fullWidth: true } }}
          onChange={(v) => handleDueDateChange(v)}
        />
        <TextField
          select
          label="负责人"
          value={form.owner}
          onChange={(e) => setForm({ ...form, owner: e.target.value })}
          fullWidth
          helperText={
            form.owner && !memberOptions.some((m) => m.value === form.owner)
              ? '该负责人当前不在本项目成员列表，请确认是否正确'
              : undefined
          }
        >
          <MenuItem value="">（未指派）</MenuItem>
          {memberOptions.map((m) => (
            <MenuItem key={m.value} value={m.value}>
              {m.label}
            </MenuItem>
          ))}
          {/* 兜底：form.owner 有值但不在本项目成员下拉中（导入数据/历史残留），
              仍能回显真实姓名，避免下拉空白、且保存时后端会自动补为成员 */}
          {form.owner && !memberOptions.some((m) => m.value === form.owner) && (
            <MenuItem key={form.owner} value={form.owner}>
              {editingNode?.ownerName ?? form.owner}（非项目成员）
            </MenuItem>
          )}
        </TextField>
        <TextField
          label="工时估算（人日）"
          type="number"
          value={form.estimateDays}
          onChange={(e) => {
            manualEstimateRef.current = true; // 用户手动接管，后续改日期不再自动覆盖
            setForm({ ...form, estimateDays: Number(e.target.value) });
          }}
          fullWidth
          InputProps={{ inputProps: { min: 0 } }}
          helperText={`默认 1人 × 计划天数（${plannedDays} 天），可手动修改`}
        />
        {/* B8（R1）：累计实际工时（人日）只读展示 —— 不进 form state；
            唯一写入方 = 工作日志 submit / 已提交日志编辑（WBS 不再支持填写工时） */}
        <Stack spacing={0.5}>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            累计实际工时（人日）：{editingNode ? editingNode.effortHours : 0}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {editingNode
              ? editingNode.children.length > 0
                ? `由 ${editingNode.effortChildCount} 个子任务汇总（只读，由工作日志累计）`
                : '由工作日志累计（只读）'
              : '0（提交工作日志后累计）'}
          </Typography>
        </Stack>
        <TextField
          select
          label="优先级"
          value={form.priority}
          onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}
          fullWidth
          helperText="P0 最高（阻塞交付立即处理）→ P3 最低（有空再做）；默认 P2"
        >
          {PRIORITY_OPTIONS.map((o) => (
            <MenuItem key={o.value} value={o.value}>
              {o.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          label={editingNode && editingNode.children.length > 0 ? '状态（由子任务汇总·锁定）' : '状态'}
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value })}
          fullWidth
          disabled={Boolean(editingNode && editingNode.children.length > 0)}
          helperText={
            editingNode && editingNode.children.length > 0
              ? '该节点含子任务，状态由子任务进度自动汇总，不可手动修改'
              : '待办→进行中需先通过「写日志」填写进度；进度达 100% 自动置为完成；阻塞/待评审为人工态，需手动解除'
          }
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

      {/* R3-5：节点关联日志详情（createdAt 升序；每条含该节点进度 before→after） */}
      <FormDialog
        open={Boolean(logDetailNode)}
        title={logDetailNode ? `工作日志详情 · ${logDetailNode.wbsCode} ${logDetailNode.name}` : '工作日志详情'}
        submitText="关闭"
        maxWidth="md"
        onClose={() => setLogDetailNode(null)}
        onSubmit={() => setLogDetailNode(null)}
      >
        {logDetailNode && (
          <Stack spacing={1.5}>
            {nodeReports.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                该节点暂无关联工作日志
              </Typography>
            ) : (
              nodeReports.map((r) => {
                const row = r.tasks.find((t) => t.nodeId === logDetailNode.id);
                return (
                  <Box
                    key={r.id}
                    sx={{ p: 1.5, border: `1px solid ${tokens.border.subtle}`, borderRadius: 1.5 }}
                  >
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                      <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{r.week}</Typography>
                      <StatusChip status={r.status} />
                      <Typography variant="caption" color="text.secondary">
                        填报人：{r.authorName}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        提交：{r.submittedAt ? fmtDate(r.submittedAt) : '—'}
                      </Typography>
                    </Stack>
                    {row && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                        该任务进度：{row.progressBefore}% → {row.progressAfter}%
                      </Typography>
                    )}
                    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                      {r.doneNote || '—'}
                    </Typography>
                    {r.planItems.length > 0 && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        下周计划：{r.planItems.join('；')}
                      </Typography>
                    )}
                    {r.risks.length > 0 && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        风险：
                        {r.risks
                          .map(
                            (rk) =>
                              `${rk.description}（责任人：${memberNameOf(members, rk.owner)}，截止：${rk.dueDate}）`,
                          )
                          .join('；')}
                      </Typography>
                    )}
                    {r.resourceNote && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        协调资源：{r.resourceNote}
                      </Typography>
                    )}
                  </Box>
                );
              })
            )}
          </Stack>
        )}
      </FormDialog>

      {/* R4-P0-4：页内写日志 Modal（lockNodeId=当前节点；提交后刷新 WBS 树 + 里程碑，不跳转路由）
          R5-P0-1：keepOpenOnSubmit={false} → 提交 / 存草稿成功后关窗，页面停留 WBS（AC-1.1/1.2/1.3）；
          失败走 catch 不关窗、内容保留（AC-1.5）。onClose 刻意不清 reportLockNodeId（D-3：
          清空会在 Dialog 淡出期间闪掉锁图标；下次点击在同一 handler 内被新 id 覆盖，AC-1.6 依然成立） */}
      <ReportFormModal
        open={reportModalOpen}
        projectId={id}
        lockNodeId={reportLockNodeId}
        keepOpenOnSubmit={false}
        onSubmitted={() => {
          void fetchWbs(id, projectType);
          void refreshMilestones(id);
        }}
        onClose={() => setReportModalOpen(false)}
      />
    </Stack>
  );
}
