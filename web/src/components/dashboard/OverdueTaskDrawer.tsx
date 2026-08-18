/**
 * 逾期 / 临期任务下探抽屉（B13 · T01 · P0，P2 增强于 B13.5，B15 扩展全局模式）
 *
 * 点击「逾期/临期报表」里某个项目 → 右侧滑出（MUI Drawer，宽 420px），
 * 展示该项目的逾期 / 临期任务明细清单（六字段 + Tab 切换 + 空/加载态）。
 *
 * P2 增强（B13.5）：
 *  - P2-1 行点击跳 WBS 页：点任务行 → 跳该项目 WBS 页（`ROUTES.projectWbs`）。
 *  - P2-2 分页：任务数超过 `PAGE_SIZE` 时启用 `DataTable` 分页（零新依赖）。
 *  - P2-3 二次筛选：状态下拉 + 关键字搜索（任务名/负责人），在已逾期/临期集合内再过滤。
 *  - P2-4 仅看我负责：传入 `currentUserId` 时显示开关，仅保留 owner === 当前用户 的任务。
 *
 * B15 扩展（`mode` 缺省 = 'project'，行为与 B13 逐字一致）：
 *  - `mode:'all'` 全局多项目：`projects`（来自 `dashboard.overdue`）并行局部拉取
 *    `listWbs + listMilestones`，扁平化为带项目上下文（`__projectId/__projectName`）的行；
 *    里程碑名映射改用 `projectId::milestoneId` 复合 key（两种模式统一，防跨项目 id 冲突）；
 *    头部标题「全部项目 · 逾期 / 临期明细」，副标题追加「涉及 K 个项目」+「含他人任务」提示行；
 *    表格列尾追加「所属项目」列（width 110，hideOnMobile）；行点击跳**各自项目** WBS 页。
 *
 * 数据策略（零后端新增、零全局污染）：
 * - 抽屉内 `Promise.all([api.listWbs(projectId), api.listMilestones(projectId)])`
 *   **局部拉取**，不写入全局 `wbsStore`，关闭即丢弃。
 * - 里程碑名由 `milestoneId` 经 milestones 接口建 `projectId::milestoneId → name` 映射解析。
 * - 日期口径统一走 `utils/date`（`splitOverdueByStatus` 内部用 `today`/`diffDays`），
 *   **禁止**在组件里 `new Date()` / 手撸字符串比较。
 *
 * 骨架/样式/关闭交互复用 `OwnerLoadDrawer`：`<Drawer anchor="right" width:420 maxWidth:'92vw'>`、
 * 头部 `subtitle1` + 关闭 `IconButton`、遮罩/×/ESC 关闭，内部 `DataTable` 渲染。
 *
 * @prd B13 / B15
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Drawer,
  FormControl,
  FormControlLabel,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';

import { DataTable, ErrorState, StatusChip, PriorityChip, ProgressBar } from '@/components/common';
import type { Column } from '@/components/common';
import { api } from '@/api/client';
import { ROUTES } from '@/config/routes';
import { PRIORITY_OPTIONS, normalizePriority, priorityRankOf } from '@/config/enums';
import type { OverdueDrawerTab, OverdueTaskRow } from '@/types/dashboard';
import type { WbsNode } from '@/types/wbs';
import { comparePriority, splitOverdueByStatus, UNNAMED_PROJECT } from '@/utils/dashboardAgg';
import { fmtDate } from '@/utils/date';

/** 每页任务数（P2-2 分页阈值） */
const PAGE_SIZE = 8;
/** 负责人未分配兜底 */
const UNASSIGNED = '未分配';
/** 里程碑未关联兜底 */
const NO_MILESTONE = '未关联';

export interface OverdueTaskDrawerProps {
  /** 是否打开 */
  open: boolean;
  /** 单项目模式的项目 id（B13 语义不变）；all 模式传 '' */
  projectId: string;
  /** 项目名（用于抽屉头部标题；来源报表行已含，可不传由抽屉本地回落） */
  projectName?: string;
  /** 初始 Tab，默认 'overdue' */
  initialTab?: OverdueDrawerTab;
  /** 当前登录用户 openId（P2-4「仅看我负责」开关；不传则隐藏该开关） */
  currentUserId?: string;
  /** B15 新增：'project'=单项目（缺省，B13 行为逐字一致）；'all'=全局多项目 */
  mode?: 'project' | 'all';
  /** B15 新增：all 模式项目清单（WorkbenchPage 传 dashboard.overdue）；project 模式忽略 */
  projects?: Array<{ projectId: string; projectName: string }>;
  /** 关闭抽屉（遮罩 / × / ESC） */
  onClose: () => void;
}

/** B15 新增：带项目上下文的 WBS 节点（抽屉内部行来源；两种模式统一填充，避免类型体操） */
interface ScopedWbsNode extends WbsNode {
  __projectId: string;
  __projectName: string;
}

/**
 * 逾期 / 临期任务下探抽屉。
 *
 * 纯前端局部拉取 + 日期口径过滤（单一真相 `splitOverdueByStatus`）+ 里程碑名解析，
 * 渲染「逾期 / 临期」双 Tab 的任务明细表，并支持分页 / 二次筛选 / 仅看我负责（P2）。
 * `mode:'all'` 时聚合 `projects` 覆盖项目的全量逾期/临期任务（含他人），行跳各自项目。
 */
export function OverdueTaskDrawer({
  open,
  projectId,
  projectName,
  initialTab = 'overdue',
  currentUserId,
  mode = 'project',
  projects,
  onClose,
}: OverdueTaskDrawerProps): JSX.Element {
  const navigate = useNavigate();
  const [tab, setTab] = useState<OverdueDrawerTab>(initialTab);
  /** 项目全量 WBS 节点（本地，不写 wbsStore）；B15：带项目上下文 */
  const [nodes, setNodes] = useState<ScopedWbsNode[]>([]);
  /** `projectId::milestoneId` → name 映射（B15：复合 key 防跨项目 id 冲突） */
  const [msMap, setMsMap] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* P2 筛选 / 分页状态（抽屉重新打开时全部复位，见下方 load 副作用） */
  const [page, setPage] = useState(1);
  const [onlyMine, setOnlyMine] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  /** B14-块1：优先级二次筛选（'' = 全部） */
  const [priorityFilter, setPriorityFilter] = useState('');
  const [keyword, setKeyword] = useState('');

  /**
   * 局部拉取 WBS + 里程碑（不污染全局 store），按 `mode` 分支：
   * - 'project'：B13 原逻辑（单项目 `Promise.all`），节点包装项目上下文，msMap 用复合 key；
   * - 'all'：`projects` 并行 `Promise.all` 拉取后扁平化，每节点带 `__projectId/__projectName`。
   * 抽成 useCallback 以便「加载失败」时重试；打开新项目时复位筛选与分页。
   */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setPage(1);
    setOnlyMine(false);
    setStatusFilter('');
    setPriorityFilter('');
    setKeyword('');
    try {
      if (mode === 'all') {
        const projectList = Array.isArray(projects) ? projects : [];
        const grouped = await Promise.all(
          projectList.map((p) =>
            Promise.all([api.listWbs(p.projectId), api.listMilestones(p.projectId)]),
          ),
        );
        const allNodes: ScopedWbsNode[] = [];
        const map = new Map<string, string>();
        grouped.forEach(([wbs, milestones], idx) => {
          const pid = projectList[idx]?.projectId ?? '';
          const pname = projectList[idx]?.projectName || UNNAMED_PROJECT;
          (Array.isArray(wbs) ? wbs : []).forEach((n) => {
            allNodes.push({ ...n, __projectId: pid, __projectName: pname });
          });
          (Array.isArray(milestones) ? milestones : []).forEach((m) => {
            if (m && m.id) map.set(`${pid}::${m.id}`, m.name || '');
          });
        });
        setNodes(allNodes);
        setMsMap(map);
      } else {
        const [wbs, milestones] = await Promise.all([
          api.listWbs(projectId),
          api.listMilestones(projectId),
        ]);
        const pid = projectId;
        const pname = projectName || UNNAMED_PROJECT;
        setNodes(
          (Array.isArray(wbs) ? wbs : []).map((n) => ({
            ...n,
            __projectId: pid,
            __projectName: pname,
          })),
        );
        const map = new Map<string, string>();
        (Array.isArray(milestones) ? milestones : []).forEach((m) => {
          if (m && m.id) map.set(`${pid}::${m.id}`, m.name || '');
        });
        setMsMap(map);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [mode, projectId, projectName, projects]);

  /* 打开且参数合法时拉取；切换项目/模式重置到初始 Tab */
  useEffect(() => {
    if (!open) return;
    if (mode === 'project' && !projectId) return;
    if (mode === 'all' && !(Array.isArray(projects) && projects.length > 0)) return;
    setTab(initialTab);
    void load();
  }, [open, mode, projectId, projects, initialTab, load]);

  /* 头部副标题计数：本地重算（不依赖来源报表，更稳） */
  const counts = useMemo(() => {
    const { overdue, dueSoon } = splitOverdueByStatus(nodes);
    return { overdue: overdue.length, dueSoon: dueSoon.length };
  }, [nodes]);

  /**
   * 当前 Tab 对应的视图模型行（WbsNode → OverdueTaskRow，含里程碑名解析）。
   *
   * B14-块1：**按优先级升序（P0 置顶）**，同级按截止日升序 —— 排序口径唯一实现
   * `dashboardAgg#comparePriority`，禁止在此处手写字符串比较。
   *
   * B15：里程碑名解析用 `projectId::milestoneId` 复合 key；行带 `projectId/projectName`
   * （all 模式「所属项目」列与跨项目行跳转；project 模式亦填充 = 本项目）。
   */
  const baseRows = useMemo<OverdueTaskRow[]>(() => {
    const { overdue, dueSoon } = splitOverdueByStatus(nodes);
    /* splitOverdueByStatus 只过滤不克隆，元素仍是 ScopedWbsNode（带 __projectId/__projectName） */
    const source: ScopedWbsNode[] = (tab === 'overdue' ? overdue : dueSoon) as ScopedWbsNode[];
    return source
      .map<OverdueTaskRow>((n) => ({
        id: n.id,
        wbsCode: n.wbsCode,
        name: n.name,
        ownerId: n.owner || '',
        ownerName: n.ownerName || UNASSIGNED,
        dueDate: n.dueDate,
        status: n.status,
        progress: n.progress,
        milestoneName: n.milestoneId
          ? msMap.get(`${n.__projectId}::${n.milestoneId}`) ?? NO_MILESTONE
          : NO_MILESTONE,
        priority: normalizePriority(n.priority),
        priorityRank: priorityRankOf(n.priority),
        projectId: n.__projectId,
        projectName: n.__projectName,
      }))
      .sort(comparePriority);
  }, [nodes, msMap, tab]);

  /* 二次筛选（P2-3 / P2-4 / B14 优先级）：仅看我负责 → 状态 → 优先级 → 关键字 */
  const filteredRows = useMemo<OverdueTaskRow[]>(() => {
    const kw = keyword.trim().toLowerCase();
    return baseRows.filter((r) => {
      if (onlyMine && currentUserId && r.ownerId !== currentUserId) return false;
      if (statusFilter && r.status !== statusFilter) return false;
      if (priorityFilter && r.priority !== priorityFilter) return false;
      if (kw && !`${r.name} ${r.ownerName}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [baseRows, onlyMine, currentUserId, statusFilter, priorityFilter, keyword]);

  /* P2-2 分页：仅对当前筛选结果切片 */
  const pagedRows = useMemo<OverdueTaskRow[]>(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [filteredRows, page]);

  /* 状态下拉可选项：取当前 Tab 实际出现的状态，保持原始顺序去重 */
  const statusOptions = useMemo(
    () => Array.from(new Set(baseRows.map((r) => r.status))),
    [baseRows],
  );

  /** B15：全局模式副标题「涉及 K 个项目」= 当前 Tab 行去重后的项目数 */
  const involvedProjects = useMemo(
    () => new Set(baseRows.map((r) => r.projectId)).size,
    [baseRows],
  );

  const isFiltering = onlyMine || !!statusFilter || !!priorityFilter || !!keyword.trim();

  /* 列定义（project 模式七字段；all 模式列尾追加「所属项目」）；日期着色随 Tab 切换 */
  const columns = useMemo<Array<Column<OverdueTaskRow>>>(() => {
    const dateColor = tab === 'overdue' ? 'error.main' : 'warning.main';
    const progressTone = tab === 'overdue' ? 'danger' : 'brand';
    const list: Array<Column<OverdueTaskRow>> = [
      {
        /* B14-块1：优先级色标置于首列，配合 P0 置顶排序，一眼看出最急的任务 */
        key: 'priority',
        label: '优先级',
        width: 62,
        render: (r) => <PriorityChip priority={r.priority} />,
      },
      {
        key: 'name',
        label: '任务',
        render: (r) => (
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 600 }} noWrap>
              {r.wbsCode ? `${r.wbsCode} ` : ''}
              {r.name}
            </Typography>
          </Box>
        ),
      },
      {
        key: 'ownerName',
        label: '负责人',
        width: 66,
        render: (r) => (
          <Typography sx={{ fontSize: 13 }} color="text.secondary" noWrap>
            {r.ownerName}
          </Typography>
        ),
      },
      {
        key: 'dueDate',
        label: '计划完成日',
        width: 88,
        render: (r) => (
          <Typography sx={{ fontSize: 13 }} color={dateColor} noWrap>
            {fmtDate(r.dueDate)}
          </Typography>
        ),
      },
      {
        key: 'status',
        label: '状态',
        width: 70,
        render: (r) => <StatusChip status={r.status} />,
      },
      {
        key: 'progress',
        label: '进度',
        width: 88,
        render: (r) => <ProgressBar value={r.progress} tone={progressTone} />,
      },
      {
        key: 'milestoneName',
        label: '所属里程碑',
        width: 110,
        hideOnMobile: true,
        render: (r) => (
          <Typography sx={{ fontSize: 13 }} color="text.secondary" noWrap>
            {r.milestoneName}
          </Typography>
        ),
      },
    ];
    /* B15：全局模式追加「所属项目」列（跨项目区分行来源） */
    if (mode === 'all') {
      list.push({
        key: 'projectName',
        label: '所属项目',
        width: 110,
        hideOnMobile: true,
        render: (r) => (
          <Typography sx={{ fontSize: 13 }} color="text.secondary" noWrap>
            {r.projectName}
          </Typography>
        ),
      });
    }
    return list;
  }, [tab, mode]);

  return (
    <Drawer anchor="right" open={open} onClose={onClose}>
      <Box
        sx={{
          width: 420,
          maxWidth: '92vw',
          p: 2.5,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}
      >
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="flex-start"
          spacing={1}
          sx={{ mb: 1 }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap>
              {mode === 'all'
                ? '全部项目 · 逾期 / 临期明细'
                : `${projectName || '项目'} · 逾期 / 临期明细`}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              逾期 {counts.overdue} · 临期 {counts.dueSoon}
              {mode === 'all' ? ` · 涉及 ${involvedProjects} 个项目` : ''}
              {isFiltering ? ` · 筛选后 ${filteredRows.length}` : ''}
            </Typography>
            {mode === 'all' && currentUserId ? (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mt: 0.25 }}
              >
                含他人任务，可开「仅看我」对齐卡片数值
              </Typography>
            ) : null}
          </Box>
          <IconButton onClick={onClose} size="small" aria-label="关闭" sx={{ flexShrink: 0 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        <Tabs
          value={tab}
          onChange={(_, v: OverdueDrawerTab) => {
            setTab(v);
            setPage(1);
          }}
          sx={{ mb: 1, minHeight: 36, '& .MuiTab-root': { minHeight: 36, py: 0.5 } }}
        >
          <Tab label="逾期" value="overdue" />
          <Tab label="临期" value="dueSoon" />
        </Tabs>

        {/* P2 工具栏：仅看我负责 / 状态筛选 / 优先级筛选 / 关键字搜索（B15 不改） */}
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" sx={{ mb: 1 }}>
          {currentUserId ? (
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={onlyMine}
                  onChange={(e) => {
                    setOnlyMine(e.target.checked);
                    setPage(1);
                  }}
                />
              }
              label="仅看我负责"
            />
          ) : null}
          <FormControl size="small" sx={{ minWidth: 116 }}>
            <InputLabel id="ov-status-label">状态</InputLabel>
            <Select
              labelId="ov-status-label"
              label="状态"
              value={statusFilter}
              displayEmpty
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
            >
              <MenuItem value="">全部</MenuItem>
              {statusOptions.map((s) => (
                <MenuItem key={s} value={s}>
                  {s}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {/* B14-块1：优先级筛选（选项来自 PRIORITY_OPTIONS 单一真源） */}
          <FormControl size="small" sx={{ minWidth: 108 }}>
            <InputLabel id="ov-priority-label">优先级</InputLabel>
            <Select
              labelId="ov-priority-label"
              label="优先级"
              value={priorityFilter}
              displayEmpty
              onChange={(e) => {
                setPriorityFilter(e.target.value);
                setPage(1);
              }}
            >
              <MenuItem value="">全部</MenuItem>
              {PRIORITY_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {o.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            size="small"
            placeholder="搜索任务/负责人"
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setPage(1);
            }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
            sx={{ flex: 1, minWidth: 150 }}
          />
        </Stack>

        <Box sx={{ flex: 1, minHeight: 0, overflowX: 'auto' }}>
          {error ? (
            <ErrorState error={error} onRetry={() => void load()} />
          ) : (
            <DataTable<OverdueTaskRow>
              columns={columns}
              rows={pagedRows}
              rowKey={(r) => r.id}
              loading={loading}
              emptyTitle={
                mode === 'all'
                  ? tab === 'overdue'
                    ? '太好了，没有逾期任务'
                    : '未来 3 天内没有待完成的任务'
                  : tab === 'overdue'
                    ? '该项目暂无已逾期任务'
                    : '该项目暂无临期任务'
              }
              emptyDescription={
                isFiltering
                  ? '当前筛选条件下没有匹配的任务'
                  : mode === 'all'
                    ? ''
                    : tab === 'overdue'
                      ? '所有任务都在计划节奏内'
                      : '未来 3 天内没有待完成的任务'
              }
              onRowClick={(row) => navigate(ROUTES.projectWbs(row.projectId))}
              pagination={
                filteredRows.length > PAGE_SIZE
                  ? {
                      page,
                      pageSize: PAGE_SIZE,
                      total: filteredRows.length,
                      onChange: (p: number) => setPage(p),
                    }
                  : undefined
              }
              dense
            />
          )}
        </Box>
      </Box>
    </Drawer>
  );
}
