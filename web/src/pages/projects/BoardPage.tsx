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
import type { BoardColumn, TaskStatus, WbsNode } from '@/types/wbs';
import { useWbsStore } from '@/stores/wbsStore';
import { useProjectStore } from '@/stores/projectStore';
import { usePermission, useToast } from '@/hooks';
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
        <Typography variant="caption" color="text.secondary">
          {fmtDays(card.estimateDays)}
        </Typography>
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
  movable: boolean;
  onEditWip: (status: TaskStatus, current: number) => void;
}

/** 可放置的看板列 */
function BoardColumnView({ col, movable, onEditWip }: BoardColumnViewProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: col.status, data: { status: col.status } });
  const wip = col.wipLimit && col.wipLimit > 0 ? col.wipLimit : null;
  const exceeded = wip !== null && col.cards.length > wip;
  const full = wip !== null && col.cards.length >= wip;

  return (
    <Box sx={{ flex: '1 1 220px', minWidth: 200, display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{col.status}</Typography>
          <Tooltip
            title={wip !== null ? `WIP 上限 ${wip}，超限时拖入会被拦截` : '未设置 WIP 上限'}
            arrow
          >
            <Chip
              size="small"
              label={wip !== null ? `${col.cards.length}/${wip}` : `${col.cards.length}`}
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
        {col.cards.length === 0 ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', textAlign: 'center', py: 2 }}
          >
            拖拽任务到这里
          </Typography>
        ) : (
          col.cards.map((c) => <BoardCard key={c.id} card={c} movable={movable} />)
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
 * @prd P0-07
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

  const archived = project?.status === '已结项' || project?.status === '已终止';
  const movable = can('task:status') && !archived;

  useEffect(() => {
    if (id) void fetchBoard(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      subtitle="拖拽任务卡片跨列移动以改变状态；WIP 上限防止在办任务堆积"
      flush
    >
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
          {board.columns.map((col) => (
            <BoardColumnView key={col.status} col={col} movable={movable} onEditWip={(status, value) => setWipEdit({ status, value })} />
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
