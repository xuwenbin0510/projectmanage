/**
 * 逾期 / 临期任务下探抽屉（B13 · T01 · P0，P2 增强于 B13.5）
 *
 * 点击「逾期/临期报表」里某个项目 → 右侧滑出（MUI Drawer，宽 420px），
 * 展示该项目的逾期 / 临期任务明细清单（六字段 + Tab 切换 + 空/加载态）。
 *
 * P2 增强（本次）：
 *  - P2-1 行点击跳 WBS 页：点任务行 → 跳该项目 WBS 页（`ROUTES.projectWbs`）。
 *  - P2-2 分页：任务数超过 `PAGE_SIZE` 时启用 `DataTable` 分页（零新依赖）。
 *  - P2-3 二次筛选：状态下拉 + 关键字搜索（任务名/负责人），在已逾期/临期集合内再过滤。
 *  - P2-4 仅看我负责：传入 `currentUserId` 时显示开关，仅保留 owner === 当前用户 的任务。
 *
 * 数据策略（零后端新增、零全局污染）：
 * - 抽屉内 `Promise.all([api.listWbs(projectId), api.listMilestones(projectId)])`
 *   **局部拉取**，不写入全局 `wbsStore`，关闭即丢弃。
 * - 里程碑名由 `milestoneId` 经 milestones 接口建 `id → name` 映射解析。
 * - 日期口径统一走 `utils/date`（`splitOverdueByStatus` 内部用 `today`/`diffDays`），
 *   **禁止**在组件里 `new Date()` / 手撸字符串比较。
 *
 * 骨架/样式/关闭交互复用 `OwnerLoadDrawer`：`<Drawer anchor="right" width:420 maxWidth:'92vw'>`、
 * 头部 `subtitle1` + 关闭 `IconButton`、遮罩/×/ESC 关闭，内部 `DataTable` 渲染。
 *
 * @prd B13
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

import { DataTable, ErrorState, StatusChip, ProgressBar } from '@/components/common';
import type { Column } from '@/components/common';
import { api } from '@/api/client';
import { ROUTES } from '@/config/routes';
import type { OverdueDrawerTab, OverdueTaskRow } from '@/types/dashboard';
import type { WbsNode } from '@/types/wbs';
import { splitOverdueByStatus } from '@/utils/dashboardAgg';
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
  /** 当前下钻项目 id（来源报表行的 projectId） */
  projectId: string;
  /** 项目名（用于抽屉头部标题；来源报表行已含，可不传由抽屉本地回落） */
  projectName?: string;
  /** 初始 Tab，默认 'overdue' */
  initialTab?: OverdueDrawerTab;
  /** 当前登录用户 openId（P2-4「仅看我负责」开关；不传则隐藏该开关） */
  currentUserId?: string;
  /** 关闭抽屉（遮罩 / × / ESC） */
  onClose: () => void;
}

/**
 * 逾期 / 临期任务下探抽屉。
 *
 * 纯前端局部拉取 + 日期口径过滤（单一真相 `splitOverdueByStatus`）+ 里程碑名解析，
 * 渲染「逾期 / 临期」双 Tab 的任务明细表，并支持分页 / 二次筛选 / 仅看我负责（P2）。
 */
export function OverdueTaskDrawer({
  open,
  projectId,
  projectName,
  initialTab = 'overdue',
  currentUserId,
  onClose,
}: OverdueTaskDrawerProps): JSX.Element {
  const navigate = useNavigate();
  const [tab, setTab] = useState<OverdueDrawerTab>(initialTab);
  /** 项目全量 WBS 节点（本地，不写 wbsStore） */
  const [nodes, setNodes] = useState<WbsNode[]>([]);
  /** milestoneId → name 映射 */
  const [msMap, setMsMap] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* P2 筛选 / 分页状态（抽屉重新打开时全部复位，见下方 load 副作用） */
  const [page, setPage] = useState(1);
  const [onlyMine, setOnlyMine] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [keyword, setKeyword] = useState('');

  /**
   * 局部拉取项目 WBS + 里程碑（不污染全局 store）。
   * 抽成 useCallback 以便「加载失败」时重试；打开新项目时复位筛选与分页。
   */
  const load = useCallback(async (pid: string): Promise<void> => {
    setLoading(true);
    setError(null);
    setPage(1);
    setOnlyMine(false);
    setStatusFilter('');
    setKeyword('');
    try {
      const [wbs, milestones] = await Promise.all([
        api.listWbs(pid),
        api.listMilestones(pid),
      ]);
      setNodes(Array.isArray(wbs) ? wbs : []);
      const map = new Map<string, string>();
      (Array.isArray(milestones) ? milestones : []).forEach((m) => {
        if (m && m.id) map.set(m.id, m.name || '');
      });
      setMsMap(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败，请重试');
    } finally {
      setLoading(false);
    }
  }, []);

  /* 打开且 projectId 变化时拉取；切换项目重置到初始 Tab */
  useEffect(() => {
    if (!open || !projectId) return;
    setTab(initialTab);
    void load(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, initialTab, load]);

  /* 头部副标题计数：本地重算（不依赖来源报表，更稳） */
  const counts = useMemo(() => {
    const { overdue, dueSoon } = splitOverdueByStatus(nodes);
    return { overdue: overdue.length, dueSoon: dueSoon.length };
  }, [nodes]);

  /* 当前 Tab 对应的视图模型行（WbsNode → OverdueTaskRow，含里程碑名解析） */
  const baseRows = useMemo<OverdueTaskRow[]>(() => {
    const { overdue, dueSoon } = splitOverdueByStatus(nodes);
    const source = tab === 'overdue' ? overdue : dueSoon;
    return source.map((n) => ({
      id: n.id,
      wbsCode: n.wbsCode,
      name: n.name,
      ownerId: n.owner || '',
      ownerName: n.ownerName || UNASSIGNED,
      dueDate: n.dueDate,
      status: n.status,
      progress: n.progress,
      milestoneName: n.milestoneId ? msMap.get(n.milestoneId) ?? NO_MILESTONE : NO_MILESTONE,
    }));
  }, [nodes, msMap, tab]);

  /* 二次筛选（P2-3 / P2-4）：仅看我负责 → 状态筛选 → 关键字搜索 */
  const filteredRows = useMemo<OverdueTaskRow[]>(() => {
    const kw = keyword.trim().toLowerCase();
    return baseRows.filter((r) => {
      if (onlyMine && currentUserId && r.ownerId !== currentUserId) return false;
      if (statusFilter && r.status !== statusFilter) return false;
      if (kw && !`${r.name} ${r.ownerName}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [baseRows, onlyMine, currentUserId, statusFilter, keyword]);

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

  const isFiltering = onlyMine || !!statusFilter || !!keyword.trim();

  /* 列定义（六字段）；日期着色随 Tab 切换（逾期红 / 临期黄） */
  const columns = useMemo<Array<Column<OverdueTaskRow>>>(() => {
    const dateColor = tab === 'overdue' ? 'error.main' : 'warning.main';
    const progressTone = tab === 'overdue' ? 'danger' : 'brand';
    return [
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
  }, [tab]);

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
              {projectName || '项目'} · 逾期 / 临期明细
            </Typography>
            <Typography variant="caption" color="text.secondary">
              逾期 {counts.overdue} · 临期 {counts.dueSoon}
              {isFiltering ? ` · 筛选后 ${filteredRows.length}` : ''}
            </Typography>
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

        {/* P2 工具栏：仅看我负责 / 状态筛选 / 关键字搜索 */}
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
            <ErrorState error={error} onRetry={() => void load(projectId)} />
          ) : (
            <DataTable<OverdueTaskRow>
              columns={columns}
              rows={pagedRows}
              rowKey={(r) => r.id}
              loading={loading}
              emptyTitle={tab === 'overdue' ? '该项目暂无已逾期任务' : '该项目暂无临期任务'}
              emptyDescription={
                isFiltering
                  ? '当前筛选条件下没有匹配的任务'
                  : tab === 'overdue'
                    ? '所有任务都在计划节奏内'
                    : '未来 3 天内没有待完成的任务'
              }
              onRowClick={() => navigate(ROUTES.projectWbs(projectId))}
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
