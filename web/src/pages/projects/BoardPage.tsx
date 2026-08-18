import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { useParams } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';

import {
  EmptyState,
  LoadingState,
  PermissionButton,
  ProgressBar,
  SectionCard,
  UserAvatar,
} from '@/components/common';
import { BoardToolbar, OwnerSwimlanes } from '@/components/board';
import type { BoardColumn, BoardFilter, BoardGroupBy, TaskStatus, WbsNode } from '@/types/wbs';
import { EMPTY_BOARD_FILTER, MILESTONE_NONE } from '@/types/wbs';
import type { BoardOption } from '@/utils/board';
import { collectOwnerOptions, filterCards, groupByOwner, isFilterActive } from '@/utils/board';
import { useWbsStore } from '@/stores/wbsStore';
import { useProjectStore } from '@/stores/projectStore';
import { usePermission, useToast } from '@/hooks';
import { api } from '@/api/client';
import { DEFAULT_WIP_LIMIT } from '@/config/enums';
import { ErrorCode, isApiError } from '@/types/api';
import { alphaOf, tokens } from '@/theme/tokens';
import { fmtDays } from '@/utils/format';

/* ═══════════════════════════════════════════════════
 * 卡片
 * ═══════════════════════════════════════════════════
 * ⚠ useDraggable / useDroppable 必须写在**真正的组件**里。
 *   原实现把它们放在 renderCard() / renderColumn() 这类普通函数中，
 *   再由 .map() 循环调用，且调用点位于 `if (!board) return` 早退之后 ——
 *   每次渲染的 Hook 数量随卡片数变化，违反 Hooks 规则，
 *   导致 dnd-kit 内部的 node/listener 注册错位，拖拽完全失效。
 */

interface CardBodyProps {
  card: WbsNode;
}

/** 卡片视觉内容（真实卡片与 DragOverlay 影子共用，保证拖拽时外观一致） */
function CardBody({ card }: CardBodyProps): JSX.Element {
  return (
    <>
      <Typography sx={{ fontSize: 13, fontWeight: 500 }} noWrap>
        {card.wbsCode} {card.name}
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.75 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <ProgressBar value={card.progress} height={5} showLabel={false} />
        </Box>
        {/* B9（R6）：卡片副信息「估 x.x / 实 x.x 人日」，超支（实>估，估 0 且实>0 同判）时「实」值着色 */}
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
          <Typography variant="caption" color="text.secondary">
            估 {fmtDays(card.estimateDays)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            /
          </Typography>
          <Typography
            variant="caption"
            sx={{ color: card.effortHours > card.estimateDays ? tokens.status.danger : 'text.secondary' }}
          >
            实 {fmtDays(card.effortHours)}
          </Typography>
        </Stack>
        {card.ownerName ? <UserAvatar name={card.ownerName} size={22} /> : null}
      </Stack>
    </>
  );
}

interface BoardCardProps {
  card: WbsNode;
  movable: boolean;
}

/** 可拖拽的看板卡片 */
function BoardCard({ card, movable }: BoardCardProps): JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id,
    disabled: !movable,
    data: { status: card.status },
  });

  return (
    <Paper
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      variant="outlined"
      elevation={0}
      sx={{
        p: 1.25,
        mb: 1,
        cursor: movable ? 'grab' : 'default',
        // 触屏必须关闭原生滚动手势，否则 PointerSensor 收不到 move 事件
        touchAction: movable ? 'none' : 'auto',
        userSelect: 'none',
        // 拖拽中保留占位但淡出，真实跟手影子由 DragOverlay 渲染
        opacity: isDragging ? 0.35 : 1,
        borderColor: 'divider',
        transition: 'border-color .15s, opacity .15s',
        '&:hover': movable ? { borderColor: tokens.brand.primary } : {},
        '&:active': movable ? { cursor: 'grabbing' } : {},
      }}
    >
      <CardBody card={card} />
    </Paper>
  );
}

/* ═══════════════════════════════════════════════════
 * 列
 * ═══════════════════════════════════════════════════ */

interface BoardColumnViewProps {
  col: BoardColumn;
  /**
   * 过滤后的卡片（B11）。**只影响渲染，不影响 WIP 计数**（SK-B11-3）：
   * WIP 是流程管控指标，不能被观察者的筛选行为篡改。
   */
  cards: WbsNode[];
  /** 筛选是否生效 → 决定列头是否额外显示「显示 m / 共 n」 */
  filterActive: boolean;
  movable: boolean;
  onEditWip: (status: TaskStatus, current: number) => void;
}

/** 可放置的看板列 */
function BoardColumnView({
  col,
  cards,
  filterActive,
  movable,
  onEditWip,
}: BoardColumnViewProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: col.status, data: { status: col.status } });
  const wip = col.wipLimit && col.wipLimit > 0 ? col.wipLimit : null;
  /* SK-B11-3：恒用全量 col.cards.length 判超限，绝不用过滤后的 cards.length */
  const total = col.cards.length;
  const exceeded = wip !== null && total > wip;
  const full = wip !== null && total >= wip;

  return (
    // B11：由 4 列变 5 列，列宽下调（minWidth 200→176，flex basis 220→200），
    // 配合父容器 overflowX:'auto'，1024px 下仍可读，768px 横向滚动
    <Box sx={{ flex: '1 1 200px', minWidth: 176, display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 600 }} noWrap>
            {col.status}
          </Typography>
          <Tooltip
            title={wip !== null ? `WIP 上限 ${wip}，超限时拖入会被拦截` : '未设置 WIP 上限'}
            arrow
          >
            <Chip
              size="small"
              label={wip !== null ? `${total}/${wip}` : `${total}`}
              color={exceeded ? 'error' : full ? 'warning' : 'default'}
              sx={{ height: 20, fontSize: 11 }}
            />
          </Tooltip>
        </Stack>
        <Tooltip title="编辑 WIP 上限（0 = 不限）">
          <IconButton size="small" onClick={() => onEditWip(col.status, col.wipLimit ?? DEFAULT_WIP_LIMIT)}>
            <EditOutlinedIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* 筛选生效时才出现，避免默认视图出现冗余数字 */}
      {filterActive && (
        <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
          显示 {cards.length} / 共 {total}
        </Typography>
      )}

      <Box
        ref={setNodeRef}
        sx={{
          flex: 1,
          minHeight: 140,
          p: 1,
          borderRadius: 1.5,
          bgcolor: isOver ? alphaOf(tokens.brand.primary, 0.1) : alphaOf(tokens.text.secondary, 0.05),
          border: `1px dashed ${isOver ? tokens.brand.primary : tokens.border.subtle}`,
          transition: 'background-color .15s, border-color .15s',
        }}
      >
        {cards.length === 0 ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', textAlign: 'center', py: 2 }}
          >
            {filterActive && total > 0 ? '无匹配任务' : '拖拽任务到这里'}
          </Typography>
        ) : (
          cards.map((c) => <BoardCard key={c.id} card={c} movable={movable} />)
        )}
      </Box>
    </Box>
  );
}

/* ═══════════════════════════════════════════════════
 * 页面
 * ═══════════════════════════════════════════════════ */

/**
 * 看板：跨列拖拽改状态 + WIP 上限拦截（默认进行中 ≤ 5，0 = 不限）
 *
 * B11 增量：
 * - 5 列（补「阻塞」，运行时列仍以服务端 `board.config.columns` 为唯一来源）
 * - 工具条：关键字 / 负责人 / 里程碑 / 仅看逾期 —— **100% 前端过滤，零网络请求**
 * - 分列维度切换：按状态（可拖）/ 按负责人（只读，D-B11-6）
 * - 筛选状态**不持久化**（§9-4）：仅存组件内 state，不落 URL、不落 localStorage
 *
 * @prd P0-07 / B11
 */
export function BoardPage(): JSX.Element {
  const { id = '' } = useParams();
  const toast = useToast();
  const { can } = usePermission();

  const project = useProjectStore((s) => s.current);
  const board = useWbsStore((s) => s.board);
  const loading = useWbsStore((s) => s.boardLoading);
  const fetchBoard = useWbsStore((s) => s.fetchBoard);
  const moveTask = useWbsStore((s) => s.moveTask);
  const setWipLimit = useWbsStore((s) => s.setWipLimit);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [wipEdit, setWipEdit] = useState<{ status: TaskStatus; value: number } | null>(null);

  /* ── B11 视图状态（纯前端，不落后端参数） ── */
  const [filter, setFilter] = useState<BoardFilter>({ ...EMPTY_BOARD_FILTER });
  const [groupBy, setGroupBy] = useState<BoardGroupBy>('status');
  /** 里程碑 id → 名称（仅用于工具条下拉展示；卡片本身只有 milestoneId） */
  const [milestoneNames, setMilestoneNames] = useState<Record<string, string>>({});

  const archived = project?.status === '已结项' || project?.status === '已终止';
  /* D-B11-6：负责人视图恒只读 */
  const movable = can('task:status') && !archived && groupBy === 'status';

  useEffect(() => {
    if (id) void fetchBoard(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /* 里程碑名称：复用既有只读接口，失败不阻塞看板（下拉退化为显示 id） */
  useEffect(() => {
    let alive = true;
    if (!id) return () => {};
    void api
      .listMilestones(id)
      .then((list) => {
        if (!alive) return;
        const map: Record<string, string> = {};
        list.forEach((m) => {
          map[m.id] = m.code ? `${m.code} ${m.name}` : m.name;
        });
        setMilestoneNames(map);
      })
      .catch(() => {
        if (alive) setMilestoneNames({});
      });
    return () => {
      alive = false;
    };
  }, [id]);

  // PointerSensor 基于 Pointer Events，鼠标 / 触控 / 手写笔统一覆盖；
  // 5px 位移后才激活，避免和卡片点击冲突（配合卡片上的 touchAction: none）
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const allCards: WbsNode[] = useMemo(
    () => (board ? board.columns.flatMap((c) => c.cards) : []),
    [board],
  );

  const activeCard: WbsNode | null = useMemo(
    () => (activeId ? allCards.find((c) => c.id === activeId) ?? null : null),
    [activeId, allCards],
  );

  /* ── B11 派生视图（useMemo 缓存，切筛选/切视图零网络） ── */
  const filterActive = isFilterActive(filter);

  const ownerOptions: BoardOption[] = useMemo(() => collectOwnerOptions(allCards), [allCards]);

  const milestoneOptions: BoardOption[] = useMemo(() => {
    const counter = new Map<string, number>();
    let none = 0;
    allCards.forEach((c) => {
      const ms = c.milestoneId ?? null;
      if (!ms) {
        none += 1;
        return;
      }
      counter.set(ms, (counter.get(ms) ?? 0) + 1);
    });
    const opts: BoardOption[] = Array.from(counter.entries())
      .map(([value, count]) => ({ value, label: milestoneNames[value] ?? value, count }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true }));
    if (none > 0) opts.push({ value: MILESTONE_NONE, label: '未关联里程碑', count: none });
    return opts;
  }, [allCards, milestoneNames]);

  /** 逐列过滤后的卡片：key = 列状态 */
  const filteredByStatus = useMemo(() => {
    const map: Record<string, WbsNode[]> = {};
    (board?.columns ?? []).forEach((col) => {
      map[col.status] = filterCards(col.cards, filter);
    });
    return map;
  }, [board, filter]);

  const shownCount = useMemo(
    () => Object.values(filteredByStatus).reduce((s, arr) => s + arr.length, 0),
    [filteredByStatus],
  );

  const ownerLanes = useMemo(
    () => (groupBy === 'owner' ? groupByOwner(filterCards(allCards, filter)) : []),
    [groupBy, allCards, filter],
  );

  const handleDragStart = (event: DragStartEvent): void => {
    setActiveId(String(event.active.id));
  };

  const handleDragCancel = (): void => {
    setActiveId(null);
  };

  const handleDragEnd = async (event: DragEndEvent): Promise<void> => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const nodeId = String(active.id);
    // 只有列是 droppable，over.id 即目标列状态
    const targetStatus = String(over.id) as TaskStatus;
    const node = allCards.find((n) => n.id === nodeId);
    if (!node || node.status === targetStatus) return;

    try {
      await moveTask(nodeId, targetStatus, 0);
      toast.success(`「${node.name}」已移至「${targetStatus}」`);
    } catch (e) {
      // WIP 超限：给出上限与当前张数，明确告知为什么被拦截
      if (isApiError(e) && e.code === ErrorCode.E_WIP_EXCEEDED) {
        const d = e.data as { limit?: number; current?: number } | undefined;
        toast.error(
          d?.limit !== undefined
            ? `「${targetStatus}」列 WIP 已达上限 ${d.limit}（当前 ${d.current ?? 0} 张），请先完成在办任务`
            : e,
        );
        return;
      }
      toast.error(e);
    }
  };

  if (loading && !board) return <LoadingState variant="skeleton" rows={3} height={120} />;
  if (!board) return <EmptyState title="看板暂不可用" description="请稍后刷新" />;

  return (
    <SectionCard
      title="看板（Kanban）"
      subtitle={
        groupBy === 'owner'
          ? '按负责人分列（只读）：一眼看清每个人手上压了多少活、多少已逾期'
          : '拖拽任务卡片跨列移动以改变状态；WIP 上限防止在办任务堆积'
      }
      flush
    >
      <BoardToolbar
        filter={filter}
        onFilterChange={setFilter}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        ownerOptions={ownerOptions}
        milestoneOptions={milestoneOptions}
        totalCount={allCards.length}
        shownCount={shownCount}
      />

      {groupBy === 'owner' ? (
        /* D-B11-6：只读视图，不挂 DndContext */
        <OwnerSwimlanes lanes={ownerLanes} />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragCancel={handleDragCancel}
          onDragEnd={(e) => void handleDragEnd(e)}
        >
          <Box
            sx={{
              display: 'flex',
              gap: 1.5,
              p: 1.5,
              overflowX: 'auto',
              alignItems: 'stretch',
              flexDirection: { xs: 'column', md: 'row' },
            }}
          >
            {/* SK-B11-2：列的运行时单一数据源是服务端下发的 board.columns，
                不是前端 BOARD_COLUMNS 常量 —— 勿改成遍历常量 */}
            {board.columns.map((col) => (
              <BoardColumnView
                key={col.status}
                col={col}
                cards={filteredByStatus[col.status] ?? col.cards}
                filterActive={filterActive}
                movable={movable}
                onEditWip={(status, value) => setWipEdit({ status, value })}
              />
            ))}
          </Box>

          {/* 跟手影子：没有它拖拽在视觉上"看不见" */}
          <DragOverlay dropAnimation={{ duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
            {activeCard ? (
              <Paper
                variant="outlined"
                elevation={0}
                sx={{
                  p: 1.25,
                  width: 236,
                  cursor: 'grabbing',
                  borderColor: tokens.brand.primary,
                  bgcolor: tokens.bg.elevated,
                  boxShadow: `0 12px 28px ${alphaOf(tokens.text.primary, 0.22)}`,
                  transform: 'rotate(1.5deg)',
                }}
              >
                <CardBody card={activeCard} />
              </Paper>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      <Dialog open={Boolean(wipEdit)} onClose={() => setWipEdit(null)} maxWidth="xs" fullWidth>
        <DialogTitle>编辑 WIP 上限 · {wipEdit?.status}</DialogTitle>
        <DialogContent>
          <Typography variant="caption" color="text.secondary">
            限制「{wipEdit?.status}」列同时进行的卡片数，0 表示不限制。默认 {DEFAULT_WIP_LIMIT}。
          </Typography>
          <TextField
            type="number"
            fullWidth
            margin="dense"
            label="WIP 上限"
            value={wipEdit?.value ?? DEFAULT_WIP_LIMIT}
            onChange={(e) => setWipEdit((w) => (w ? { ...w, value: Math.max(0, Number(e.target.value)) } : w))}
            InputProps={{ inputProps: { min: 0 } }}
          />
        </DialogContent>
        <DialogActions>
          <PermissionButton
            action="board:config"
            disabledReason={archived ? '项目已归档' : ''}
            onClick={async () => {
              if (!wipEdit) return;
              try {
                await setWipLimit(wipEdit.status, wipEdit.value);
                toast.success('WIP 上限已更新');
                setWipEdit(null);
              } catch (e) {
                toast.error(e);
              }
            }}
          >
            保存
          </PermissionButton>
        </DialogActions>
      </Dialog>
    </SectionCard>
  );
}
