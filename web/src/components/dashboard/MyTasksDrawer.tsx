/**
 * 我的任务明细抽屉（B15 · T02 · 新建）
 *
 * 「图表 → 明细 → 项目 WBS 详情/编辑」连贯路径的中间层：
 * 进度环点段 / 优先级环点段 / 「我的任务」区块「查看全部」三入口统一打开本抽屉，
 * 展示跨项目聚合的**我的未完成任务**（`WorkbenchPage` 传入 `sortedTasks` 快照）。
 *
 * 数据策略（决策 #3，零额外请求）：
 * - `tasks` 由 `WorkbenchPage` 传 `sortByPriority(data.myTasks)` 快照（P0 置顶、含 projectName），
 *   抽屉**零 api 调用、不改状态、不刷新**（编辑一律跳项目 WBS 页）。
 * - 打开时按 `initialProgress` / `initialPriority` 预置筛选，可在抽屉内切换/清空。
 *
 * 口径红线（与 dashboardAgg / utils/date 逐字一致）：
 * - 进度三段 `progressSegmentOf` 镜像 `aggregateTaskProgress`：
 *   done=`完成` / active=`进行中+待评审` / pending=`待办+阻塞`。
 * - 优先级归一走 `normalizePriority`，下拉选项走 `PRIORITY_OPTIONS`（禁止字符串比较）。
 * - 逾期/临期判定走 `utils/date` 的 `isOverdue`/`diffDays(today(),dueDate)<=3`。
 * - **禁止**组件内 `new Date()` / 手撸字符串比较 / 复写三段口径。
 *
 * 骨架复用 `OverdueTaskDrawer`：`<Drawer anchor="right" width:420 maxWidth:'92vw'>`、
 * 关闭 `IconButton`（遮罩 / × / ESC），内部 `DataTable` 渲染，`PAGE_SIZE = 8`。
 *
 * @prd B15
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Drawer,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';

import { DataTable, PriorityChip, ProgressBar, StatusChip } from '@/components/common';
import type { Column } from '@/components/common';
import { ROUTES } from '@/config/routes';
import { PRIORITY_OPTIONS, normalizePriority } from '@/config/enums';
import { UNNAMED_PROJECT } from '@/utils/dashboardAgg';
import { diffDays, fmtDate, isOverdue, today } from '@/utils/date';
import type { ProgressSegment } from '@/types/dashboard';
import type { Priority, TaskStatus, WbsNode } from '@/types/wbs';

/** 每页任务数（与 OverdueTaskDrawer 保持一致） */
const PAGE_SIZE = 8;

/** 进度段下拉选项（P0-8：全部/已完成/在办/未启动） */
const PROGRESS_OPTIONS: ReadonlyArray<{ value: ProgressSegment; label: string }> = [
  { value: 'done', label: '已完成' },
  { value: 'active', label: '在办' },
  { value: 'pending', label: '未启动' },
];

export interface MyTasksDrawerProps {
  /** 是否打开 */
  open: boolean;
  /** 我的任务快照（WorkbenchPage 传 sortedTasks：sortByPriority(data.myTasks)，P0 置顶、含 projectName）；抽屉零请求 */
  tasks: WbsNode[];
  /** B15 新增：初始进度段筛选（进度环点段带入），缺省不过滤 */
  initialProgress?: ProgressSegment;
  /** B15 新增：初始优先级筛选（优先级环点段带入），缺省不过滤 */
  initialPriority?: Priority;
  /** 关闭抽屉（遮罩 / × / ESC） */
  onClose: () => void;
}

/**
 * 进度段分类：口径镜像 `dashboardAgg#aggregateTaskProgress`
 * （done=完成 / active=进行中+待评审 / pending=待办+阻塞+未知）。
 */
function progressSegmentOf(status: TaskStatus): ProgressSegment {
  switch (status) {
    case '完成':
      return 'done';
    case '进行中':
    case '待评审':
      return 'active';
    case '待办':
    case '阻塞':
    default:
      return 'pending';
  }
}

/**
 * 我的任务明细抽屉（跨项目聚合，纯受控快照）。
 */
export function MyTasksDrawer({
  open,
  tasks,
  initialProgress,
  initialPriority,
  onClose,
}: MyTasksDrawerProps): JSX.Element {
  const navigate = useNavigate();

  /* 筛选工具栏 state（打开时按 initial* 预置并复位分页） */
  const [progressFilter, setProgressFilter] = useState<ProgressSegment | ''>('');
  const [priorityFilter, setPriorityFilter] = useState<Priority | ''>('');
  const [statusFilter, setStatusFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);

  /* 打开时预置 / 复位（快照语义，抽屉内不改任务数据） */
  useEffect(() => {
    if (!open) return;
    setProgressFilter(initialProgress ?? '');
    setPriorityFilter(initialPriority ?? '');
    setStatusFilter('');
    setKeyword('');
    setPage(1);
  }, [open, initialProgress, initialPriority]);

  /* 筛选逻辑（顺序：进度段 → 优先级 → 状态 → 关键字） */
  const filteredRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return tasks.filter((t) => {
      if (progressFilter && progressSegmentOf(t.status) !== progressFilter) return false;
      if (priorityFilter && normalizePriority(t.priority) !== priorityFilter) return false;
      if (statusFilter && t.status !== statusFilter) return false;
      if (kw && !`${t.wbsCode} ${t.name} ${t.projectName ?? ''}`.toLowerCase().includes(kw))
        return false;
      return true;
    });
  }, [tasks, progressFilter, priorityFilter, statusFilter, keyword]);

  /* 分页（P1-2）：仅对当前筛选结果切片，1 起（组件内部转 0 起） */
  const pagedRows = useMemo<WbsNode[]>(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [filteredRows, page]);

  /* 状态下拉可选项（P1-1）：保序去重（同 OverdueTaskDrawer statusOptions 模式） */
  const statusOptions = useMemo(() => Array.from(new Set(tasks.map((t) => t.status))), [tasks]);

  const isFiltering = !!progressFilter || !!priorityFilter || !!statusFilter || !!keyword.trim();

  /* 空态三分支（决策 #4 + P1-4）：无任务 / 已完成段（服务端已滤完成，恒空）/ 筛选无匹配 */
  const emptyTitle =
    tasks.length === 0
      ? '没有分配给我的未完成任务'
      : progressFilter === 'done'
        ? '没有已完成任务'
        : isFiltering
          ? '当前筛选条件下没有匹配的任务'
          : '暂无任务';
  const emptyDescription =
    tasks.length === 0
      ? ''
      : progressFilter === 'done'
        ? '已完成任务请在项目 WBS 查看'
        : isFiltering
          ? '试试调整筛选条件'
          : '';

  /* 列定义（六列，不含里程碑列——决策 #5：myTasks 无 milestoneName，避免额外拉取） */
  const columns = useMemo<Array<Column<WbsNode>>>(() => [
    {
      key: 'priority',
      label: '优先级',
      width: 62,
      render: (r) => <PriorityChip priority={normalizePriority(r.priority)} />,
    },
    {
      key: 'name',
      label: '任务',
      render: (r) => (
        <Typography sx={{ fontSize: 13, fontWeight: 600 }} noWrap>
          {r.wbsCode ? `${r.wbsCode} ` : ''}
          {r.name}
        </Typography>
      ),
    },
    {
      key: 'projectName',
      label: '项目名',
      width: 110,
      hideOnMobile: true,
      render: (r) => (
        <Typography sx={{ fontSize: 13 }} color="text.secondary" noWrap>
          {r.projectName || UNNAMED_PROJECT}
        </Typography>
      ),
    },
    {
      key: 'dueDate',
      label: '截止日',
      width: 96,
      render: (r) => {
        const overdue = isOverdue(r.dueDate);
        const soon = !overdue && diffDays(today(), r.dueDate) <= 3;
        return (
          <Typography
            sx={{
              fontSize: 13,
              color: overdue ? 'error.main' : soon ? 'warning.main' : 'text.secondary',
            }}
            noWrap
          >
            {fmtDate(r.dueDate)}
            {overdue ? ' · 已逾期' : soon ? ' · 临期' : ''}
          </Typography>
        );
      },
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
      render: (r) => <ProgressBar value={r.progress} tone={isOverdue(r.dueDate) ? 'danger' : 'brand'} />,
    },
  ], []);

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
              我的任务明细
            </Typography>
            <Typography variant="caption" color="text.secondary">
              共 {tasks.length} 个未完成 · 按优先级排序
              {isFiltering ? ` · 筛选后 ${filteredRows.length}` : ''}
            </Typography>
          </Box>
          <IconButton onClick={onClose} size="small" aria-label="关闭" sx={{ flexShrink: 0 }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        {/* 筛选工具栏：进度段 / 优先级 / 状态 / 关键字（P1-1 二次筛选） */}
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" sx={{ mb: 1 }}>
          <FormControl size="small" sx={{ minWidth: 108 }}>
            <InputLabel id="mt-progress-label" shrink>进度段</InputLabel>
            <Select
              labelId="mt-progress-label"
              label="进度段"
              notched
              value={progressFilter}
              displayEmpty
              onChange={(e) => {
                setProgressFilter(e.target.value as ProgressSegment | '');
                setPage(1);
              }}
            >
              <MenuItem value="">全部</MenuItem>
              {PROGRESS_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {o.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 108 }}>
            <InputLabel id="mt-priority-label" shrink>优先级</InputLabel>
            <Select
              labelId="mt-priority-label"
              label="优先级"
              notched
              value={priorityFilter}
              displayEmpty
              onChange={(e) => {
                setPriorityFilter(e.target.value as Priority | '');
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
          <FormControl size="small" sx={{ minWidth: 100 }}>
            <InputLabel id="mt-status-label" shrink>状态</InputLabel>
            <Select
              labelId="mt-status-label"
              label="状态"
              notched
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
            placeholder="搜索任务/项目"
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
          <DataTable<WbsNode>
            columns={columns}
            rows={pagedRows}
            rowKey={(r) => r.id}
            emptyTitle={emptyTitle}
            emptyDescription={emptyDescription}
            onRowClick={(row) => navigate(ROUTES.projectWbs(row.projectId) + '?taskId=' + row.id)}
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
        </Box>
      </Box>
    </Drawer>
  );
}
