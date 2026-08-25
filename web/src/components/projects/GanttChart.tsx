/**
 * WBS 甘特图视图（feat/connect-b10 后续 · 纯前端、自包含）
 *
 * - 左侧树形任务名（保持层级缩进），右侧按周分列的时间轴任务条。
 * - 任务条：位置/宽度由 startDate→dueDate 映射；内部左起填充 progress%。
 * - 拖拽交互（@dnd-kit，复用已安装的 core）：
 *   - 拖条主体 → 整体平移改期（startDate/dueDate 同移）
 *   - 拖左端手柄 → 仅改 startDate
 *   - 拖右端手柄 → 仅改 dueDate
 *   - 拖行左侧 ⠿ 手柄 → 行内重排序（before/after/inside，复用 moveNode）
 * - 后端零改动；日期落点按天吸附。
 *
 * 落点校验：startDate ≤ dueDate；禁止拖成自身子孙（isDescendantOf）。
 */
import { useMemo, useRef, useState } from 'react';
import { Box, Stack, Typography, Tooltip } from '@mui/material';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import dayjs from 'dayjs';

import type { WbsNode, WbsTreeNode, TaskStatus } from '@/types/wbs';
import { fmtDate, isOverdue } from '@/utils/date';
import {
  DAY_WIDTH,
  GANTT_ROW_H,
  GANTT_BAR_H,
  GANTT_LABEL_W,
  GANTT_HEADER_H,
  GANTT_HEADER_MONTH_H,
  GANTT_HEADER_WEEK_H,
  computeRange,
  xOf,
  shiftDate,
  flattenWithDepth,
  compareWbsCode,
  GANTT_STATUS,
} from '@/utils/gantt';

interface GanttChartProps {
  nodes: WbsNode[];
  tree: WbsTreeNode[];
  editable: boolean;
  onReschedule: (id: string, startDate: string, dueDate: string) => void;
  onReorder: (id: string, newParentId: string | null, index: number) => void;
}

type Band = 'before' | 'after' | 'inside' | null;

function isDescendantOf(flat: WbsNode[], ancestorId: string, maybeParentId?: string | null): boolean {
  if (!maybeParentId) return false;
  const byId = new Map(flat.map((n) => [n.id, n]));
  let cur = byId.get(maybeParentId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.parentId === ancestorId) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

/** 单个任务条（含整体拖拽 + 两端手柄，三者为兄弟节点，避免嵌套拖拽冲突） */
function GanttBar({
  node,
  rangeStart,
  editable,
  onReschedule,
}: {
  node: WbsNode;
  rangeStart: dayjs.Dayjs;
  editable: boolean;
  onReschedule: (id: string, s: string, d: string) => void;
}) {
  const overdue = isOverdue(node.dueDate) && node.status !== '完成';
  const unscheduled = !node.startDate && !node.dueDate;
  const start = node.startDate ? dayjs(node.startDate) : rangeStart;
  const due = node.dueDate ? dayjs(node.dueDate) : start.add(1, 'day');
  const x = xOf(start, rangeStart);
  const w = Math.max(DAY_WIDTH, xOf(due, rangeStart) - x + DAY_WIDTH);
  const color = GANTT_STATUS[node.status as TaskStatus] ?? GANTT_STATUS['待办'];
  const pct = Math.max(0, Math.min(100, Number(node.progress) || 0));
  const barTop = (GANTT_ROW_H - GANTT_BAR_H) / 2;

  // 整体拖拽（改期）
  const body = useDraggable({ id: `bar:${node.id}`, disabled: !editable });
  // 左端手柄（改开始）
  const left = useDraggable({ id: `bar-l:${node.id}`, disabled: !editable });
  // 右端手柄（改截止）
  const right = useDraggable({ id: `bar-r:${node.id}`, disabled: !editable });

  // 拖拽条体时，两端手柄跟随同步位移（用条体 transform）
  const tx = body.transform?.x ?? 0;
  const handleShift = editable ? { transform: `translateX(${tx}px)` } : undefined;

  const tooltip = `${node.wbsCode} ${node.name}\n${fmtDate(node.startDate) || '未排期'} → ${fmtDate(node.dueDate) || '未排期'}`;

  return (
    <Tooltip title={tooltip} arrow placement="top">
      <Box sx={{ position: 'absolute', left: x, top: barTop, width: w, height: GANTT_BAR_H }}>
        <Box
          ref={body.setNodeRef}
          {...(editable ? body.listeners : {})}
          {...body.attributes}
          sx={{
            position: 'absolute',
            inset: 0,
            borderRadius: 1,
            bgcolor: color.track,
            border: `0.5px solid ${overdue ? '#A32D2D' : color.bar}`,
            overflow: 'hidden',
            cursor: editable ? 'grab' : 'default',
            opacity: unscheduled ? 0.75 : 1,
            ...(unscheduled ? { borderStyle: 'dashed' } : {}),
          }}
          style={tx ? { transform: `translateX(${tx}px)` } : undefined}
        >
          {/* 进度填充 */}
          <Box
            sx={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: `${pct}%`,
              bgcolor: color.bar,
              pointerEvents: 'none',
            }}
          />
          <Typography
            sx={{
              position: 'absolute',
              left: 6,
              top: 0,
              lineHeight: `${GANTT_BAR_H}px`,
              fontSize: 10,
              color: pct > 45 ? '#fff' : 'text.primary',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            {unscheduled ? '未排期' : w > 30 ? `${pct}%` : ''}
          </Typography>
        </Box>

        {editable && (
          <>
            <Box
              ref={left.setNodeRef}
              {...left.listeners}
              {...left.attributes}
              sx={{
                position: 'absolute',
                left: -4,
                top: -3,
                width: 9,
                height: GANTT_BAR_H + 6,
                borderRadius: 1.5,
                bgcolor: '#0F6E56',
                border: '0.5px solid #fff',
                cursor: 'ew-resize',
                zIndex: 2,
              }}
              style={handleShift}
              title="拖拽调整开始日期"
            />
            <Box
              ref={right.setNodeRef}
              {...right.listeners}
              {...right.attributes}
              sx={{
                position: 'absolute',
                left: `calc(100% - 5px)`,
                top: -3,
                width: 9,
                height: GANTT_BAR_H + 6,
                borderRadius: 1.5,
                bgcolor: '#0F6E56',
                border: '0.5px solid #fff',
                cursor: 'ew-resize',
                zIndex: 2,
              }}
              style={handleShift}
              title="拖拽调整截止日期"
            />
          </>
        )}
      </Box>
    </Tooltip>
  );
}

export function GanttChart({
  nodes,
  tree,
  editable,
  onReschedule,
  onReorder,
}: GanttChartProps): JSX.Element {
  const range = useMemo(() => computeRange(nodes), [nodes]);
  const timelineWidth = range.days * DAY_WIDTH;
  const rows = useMemo(() => flattenWithDepth(tree), [tree]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // 行重排序拖拽态
  const [rowActiveId, setRowActiveId] = useState<string | null>(null);
  const [rowOverId, setRowOverId] = useState<string | null>(null);
  const [rowBand, setRowBand] = useState<Band>(null);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const activeNode = rowActiveId ? nodeById.get(rowActiveId) : null;

  // 左右分栏垂直滚动同步
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const syncing = useRef(false);

  const syncScroll = (source: 'left' | 'right') => (e: React.UIEvent<HTMLDivElement>) => {
    if (syncing.current) return;
    syncing.current = true;
    const target = source === 'left' ? rightRef.current : leftRef.current;
    if (target) target.scrollTop = e.currentTarget.scrollTop;
    syncing.current = false;
  };

  const handleDragStart = (e: DragStartEvent): void => {
    const id = String(e.active.id);
    if (id.startsWith('row:')) setRowActiveId(id.slice(4));
  };

  const handleDragOver = (e: DragOverEvent): void => {
    const { active, over } = e;
    const aId = String(active.id);
    if (!aId.startsWith('row:') || !over) {
      setRowOverId(null);
      setRowBand(null);
      return;
    }
    const oId = String(over.id).replace('rowDropT:', '').replace('rowDrop:', '');
    const aNodeId = aId.slice(4);
    const flat = nodes;
    const aNode = flat.find((n) => n.id === aNodeId);
    const oNode = flat.find((n) => n.id === oId);
    if (!aNode || !oNode || aNodeId === oId) {
      setRowOverId(null);
      setRowBand(null);
      return;
    }
    if (oNode.parentId === aNodeId || isDescendantOf(flat, aNodeId, oNode.parentId)) {
      setRowOverId(null);
      setRowBand(null);
      return;
    }
    const rect = over.rect;
    const activeRect = active.rect.current.translated;
    if (!activeRect) return;
    const cy = rect.top + rect.height / 2;
    const ay = activeRect.top + activeRect.height / 2;
    let band: Band = ay < cy ? 'before' : 'after';
    // 中段 40%~60% 成为子节点，区域更明确
    if (ay > rect.top + rect.height * 0.4 && ay < rect.top + rect.height * 0.6) band = 'inside';
    // 禁止把祖先拖进自己的子孙里（inside 模式额外校验）
    if (band === 'inside' && isDescendantOf(flat, aNodeId, oId)) {
      setRowOverId(null);
      setRowBand(null);
      return;
    }
    setRowOverId(oId);
    setRowBand(band);
  };

  const handleDragEnd = (e: DragEndEvent): void => {
    const { active, delta } = e;
    const id = String(active.id);

    if (id.startsWith('bar:')) {
      const nodeId = id.slice(4);
      const dayDelta = Math.round(delta.x / DAY_WIDTH);
      if (dayDelta !== 0) {
        const n = nodeById.get(nodeId);
        if (n) onReschedule(nodeId, shiftDate(n.startDate, dayDelta), shiftDate(n.dueDate, dayDelta));
      }
    } else if (id.startsWith('bar-l:')) {
      const nodeId = id.slice(6);
      const dayDelta = Math.round(delta.x / DAY_WIDTH);
      if (dayDelta !== 0) {
        const n = nodeById.get(nodeId);
        if (n) {
          let ns = shiftDate(n.startDate, dayDelta);
          if (n.dueDate && dayjs(ns).isAfter(dayjs(n.dueDate), 'day')) ns = n.dueDate;
          onReschedule(nodeId, ns, n.dueDate ?? ns);
        }
      }
    } else if (id.startsWith('bar-r:')) {
      const nodeId = id.slice(6);
      const dayDelta = Math.round(delta.x / DAY_WIDTH);
      if (dayDelta !== 0) {
        const n = nodeById.get(nodeId);
        if (n) {
          let nd = shiftDate(n.dueDate, dayDelta);
          if (n.startDate && dayjs(nd).isBefore(dayjs(n.startDate), 'day')) nd = n.startDate;
          onReschedule(nodeId, n.startDate ?? nd, nd);
        }
      }
    } else if (id.startsWith('row:') && rowOverId && rowBand) {
      const aId = id.slice(4);
      const oId = rowOverId;
      const flat = nodes;
      const aNode = flat.find((n) => n.id === aId);
      const oNode = flat.find((n) => n.id === oId);
      if (aNode && oNode && aId !== oId) {
        const newParentId = rowBand === 'inside' ? oId : oNode.parentId;
        const siblings = flat
          .filter((n) => n.parentId === newParentId && n.id !== aId)
          .sort((x, y) => compareWbsCode(x.wbsCode, y.wbsCode));
        const oIndex = siblings.findIndex((n) => n.id === oId);
        const idx = rowBand === 'after' ? oIndex + 1 : rowBand === 'inside' ? siblings.length : oIndex;
        onReorder(aId, newParentId, idx);
      }
    }
    setRowActiveId(null);
    setRowOverId(null);
    setRowBand(null);
  };

  // 顶部月份带
  const monthBands = useMemo(() => {
    const bands: Array<{ x: number; w: number; label: string }> = [];
    let cur: dayjs.Dayjs | null = null;
    for (let d = 0; d < range.days; d += 1) {
      const dt = range.start.add(d, 'day');
      if (!cur || dt.month() !== cur.month() || dt.year() !== cur.year()) {
        bands.push({ x: d * DAY_WIDTH, w: 0, label: dt.format('YYYY年M月') });
        cur = dt;
      }
      const last = bands[bands.length - 1];
      if (last) last.w = (d + 1) * DAY_WIDTH - last.x;
    }
    return bands;
  }, [range]);

  // 顶部周刻度（每周起始日，如 8/25）
  const weekBands = useMemo(() => {
    const bands: Array<{ x: number; w: number; label: string }> = [];
    for (let d = 0; d < range.days; d += 7) {
      const dt = range.start.add(d, 'day');
      const w = Math.min(7, range.days - d) * DAY_WIDTH;
      bands.push({ x: d * DAY_WIDTH, w, label: dt.format('M/D') });
    }
    return bands;
  }, [range]);

  // 周网格线
  const weekLines = useMemo(() => {
    const lines: number[] = [];
    for (let d = 0; d <= range.days; d += 7) lines.push(d * DAY_WIDTH);
    return lines;
  }, [range.days]);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <Box
        sx={{
          border: '0.5px solid',
          borderColor: 'divider',
          borderRadius: 1.5,
          maxHeight: '72vh',
          bgcolor: 'background.paper',
          display: 'flex',
          overflow: 'hidden',
        }}
      >
        {/* 左侧固定列：任务名 */}
        <Box
          ref={leftRef}
          onScroll={syncScroll('left')}
          sx={{
            width: GANTT_LABEL_W,
            flexShrink: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            bgcolor: 'background.paper',
            // 隐藏自身滚动条，横向滚动条只出现在右侧进度区
            '&::-webkit-scrollbar': { display: 'none' },
            scrollbarWidth: 'none',
          }}
        >
          {/* 左侧表头 */}
          <Box
            sx={{
              height: GANTT_HEADER_H,
              px: 1.5,
              display: 'flex',
              alignItems: 'center',
              borderBottom: '0.5px solid',
              borderColor: 'divider',
              fontSize: 13,
              fontWeight: 500,
              color: 'text.secondary',
            }}
          >
            任务
          </Box>
          {/* 左侧行标签 */}
          {rows.map(({ node, depth }) => (
            <GanttLabelRow
              key={`label-${node.id}`}
              node={node}
              depth={depth}
              editable={editable}
              rowOverId={rowOverId}
              rowBand={rowActiveId === node.id ? null : rowBand}
              isRowActive={rowActiveId === node.id}
            />
          ))}
        </Box>

        {/* 右侧进度区：可横向滚动 */}
        <Box
          ref={rightRef}
          onScroll={syncScroll('right')}
          sx={{
            flex: '1 1 0px',
            minWidth: 0,
            overflow: 'auto',
            bgcolor: 'background.paper',
            position: 'relative',
          }}
        >
          <Box sx={{ width: timelineWidth, position: 'relative' }}>
            {/* 周网格线（背景层） */}
            <Box
              sx={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: timelineWidth,
                pointerEvents: 'none',
              }}
            >
              {weekLines.map((lx, i) => (
                <Box
                  key={i}
                  sx={{
                    position: 'absolute',
                    left: lx,
                    top: 0,
                    bottom: 0,
                    width: 0.5,
                    bgcolor: 'divider',
                  }}
                />
              ))}
            </Box>

            {/* 表头（sticky top） */}
            <Box
              sx={{
                position: 'sticky',
                top: 0,
                zIndex: 4,
                height: GANTT_HEADER_H,
                bgcolor: 'background.paper',
                borderBottom: '0.5px solid',
                borderColor: 'divider',
              }}
            >
              {/* 月份带 */}
              <Box sx={{ position: 'relative', height: GANTT_HEADER_MONTH_H }}>
                {monthBands.map((b, i) => (
                  <Box
                    key={i}
                    sx={{
                      position: 'absolute',
                      left: b.x,
                      top: 0,
                      width: b.w,
                      height: '100%',
                      px: 0.5,
                      display: 'flex',
                      alignItems: 'center',
                      fontSize: 11,
                      fontWeight: 500,
                      color: 'text.secondary',
                      borderRight: '0.5px solid',
                      borderColor: 'divider',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                    }}
                  >
                    {b.label}
                  </Box>
                ))}
              </Box>
              {/* 周刻度 */}
              <Box
                sx={{
                  position: 'relative',
                  height: GANTT_HEADER_WEEK_H,
                  borderTop: '0.5px solid',
                  borderColor: 'divider',
                }}
              >
                {weekBands.map((b, i) => (
                  <Box
                    key={i}
                    sx={{
                      position: 'absolute',
                      left: b.x,
                      top: 0,
                      width: b.w,
                      height: '100%',
                      px: 0.5,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 10,
                      color: 'text.secondary',
                      borderRight: '0.5px solid',
                      borderColor: 'divider',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                    }}
                  >
                    {b.label}
                  </Box>
                ))}
              </Box>
            </Box>

            {/* 行 */}
            {rows.map(({ node }) => (
              <GanttTimelineRow
                key={`timeline-${node.id}`}
                node={node}
                rangeStart={range.start}
                timelineWidth={timelineWidth}
                editable={editable}
                onReschedule={onReschedule}
                rowOverId={rowOverId}
                rowBand={rowActiveId === node.id ? null : rowBand}
                isRowActive={rowActiveId === node.id}
              />
            ))}
          </Box>
        </Box>
      </Box>

      {/* 图例 */}
      <Stack direction="row" spacing={2} sx={{ mt: 1, flexWrap: 'wrap' }}>
        {(['完成', '进行中', '待评审', '待办', '阻塞'] as TaskStatus[]).map((s) => (
          <Stack key={s} direction="row" spacing={0.5} alignItems="center">
            <Box sx={{ width: 12, height: 12, borderRadius: 0.5, bgcolor: GANTT_STATUS[s].bar }} />
            <Typography variant="caption" color="text.secondary">
              {s}
            </Typography>
          </Stack>
        ))}
        <Typography variant="caption" color="text.secondary">
          拖任务名/条=排序（上/下=同级，中=子任务）· 拖条体=改期 · 拖两端=改工期
        </Typography>
      </Stack>

      <DragOverlay dropAnimation={null} zIndex={1000}>
        {activeNode ? (
          <Box
            sx={{
              px: 1,
              py: 0.5,
              borderRadius: 1,
              bgcolor: '#2E7D87',
              color: '#fff',
              fontSize: 13,
              fontWeight: 500,
              boxShadow: 3,
              maxWidth: 260,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {activeNode.wbsCode ? `${activeNode.wbsCode} ` : ''}
            {activeNode.name}
          </Box>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/** 左侧固定列行（任务名 + 整行可拖可放） */
function GanttLabelRow({
  node,
  depth,
  editable,
  rowOverId,
  rowBand,
  isRowActive,
}: {
  node: WbsNode;
  depth: number;
  editable: boolean;
  rowOverId: string | null;
  rowBand: Band;
  isRowActive: boolean;
}) {
  const drop = useDroppable({ id: `rowDrop:${node.id}` });
  const drag = useDraggable({ id: `row:${node.id}`, disabled: !editable });
  const setRefs = (el: HTMLElement | null) => {
    drop.setNodeRef(el);
    drag.setNodeRef(el);
  };
  const isOver = rowOverId === node.id && !!rowBand && !isRowActive;
  const isInside = isOver && rowBand === 'inside';
  const isSibling = isOver && rowBand !== 'inside';
  // 同级 = 品牌青粗线+圆点；子节点 = 琥珀色缩进方框（颜色 + 形状 + 缩进 三重区分）
  const SIB_COLOR = '#2E7D87';
  const CHILD_COLOR = '#B8741B';

  return (
    <Box
      ref={setRefs}
      {...(editable ? drag.listeners : {})}
      {...drag.attributes}
      sx={{
        height: GANTT_ROW_H,
        borderBottom: '0.5px solid',
        borderColor: 'divider',
        bgcolor: isInside
          ? 'rgba(184,116,27,0.16)'
          : isSibling
            ? 'rgba(46,125,135,0.12)'
            : 'background.paper',
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        // 拖为子节点时整行向右缩进，模拟「落入内部」
        pl: 1 + depth * 1.4 + (isInside ? 1.8 : 0),
        pr: 1,
        position: 'relative',
        cursor: editable ? 'grab' : 'default',
        boxShadow: isInside ? `inset 0 0 0 2px ${CHILD_COLOR}` : 'none',
        borderRadius: isInside ? 1 : 0,
        opacity: isRowActive ? 0.4 : 1,
        transition: 'background-color 80ms, box-shadow 80ms, padding-left 80ms',
      }}
    >
      <DragIndicatorIcon sx={{ fontSize: 15, color: 'text.disabled', flexShrink: 0 }} />

      <Typography
        sx={{
          fontSize: 13,
          minWidth: 0,
          flex: 1,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={`${node.wbsCode} ${node.name}`}
      >
        {node.wbsCode ? `${node.wbsCode} ` : ''}
        {node.name}
      </Typography>

      {/* 子节点落点：琥珀色徽标（与青色同级线明显区分） */}
      {isInside && (
        <Typography
          variant="caption"
          sx={{
            ml: 0.5,
            px: 0.6,
            py: 0.1,
            borderRadius: 1,
            fontSize: 10,
            fontWeight: 700,
            color: '#fff',
            bgcolor: CHILD_COLOR,
            whiteSpace: 'nowrap',
            zIndex: 4,
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          ⊕ 成为子任务
        </Typography>
      )}

      {/* 同级落点：品牌青粗线 + 圆点（线上沿=前插 / 线下沿=后插） */}
      {isSibling && (
        <>
          <Box
            sx={{
              position: 'absolute',
              left: 0,
              right: 0,
              [rowBand === 'before' ? 'top' : 'bottom']: -2,
              height: 4,
              background: SIB_COLOR,
              borderRadius: 2,
              pointerEvents: 'none',
              zIndex: 3,
            }}
          />
          <Box
            sx={{
              position: 'absolute',
              [rowBand === 'before' ? 'top' : 'bottom']: -5,
              left: 2,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: SIB_COLOR,
              boxShadow: (theme: any) => `0 0 0 2px ${theme.palette.background.paper}`,
              pointerEvents: 'none',
              zIndex: 4,
            }}
          />
        </>
      )}
    </Box>
  );
}

/** 右侧时间轴行（任务条 + 落点指示 + 整行可放） */
function GanttTimelineRow({
  node,
  rangeStart,
  timelineWidth,
  editable,
  onReschedule,
  rowOverId,
  rowBand,
  isRowActive,
}: {
  node: WbsNode;
  rangeStart: dayjs.Dayjs;
  timelineWidth: number;
  editable: boolean;
  onReschedule: (id: string, s: string, d: string) => void;
  rowOverId: string | null;
  rowBand: Band;
  isRowActive: boolean;
}) {
  const { setNodeRef } = useDroppable({ id: `rowDropT:${node.id}` });
  const isOver = rowOverId === node.id && !!rowBand && !isRowActive;
  const isInside = isOver && rowBand === 'inside';
  const isSibling = isOver && rowBand !== 'inside';
  return (
    <Box
      ref={setNodeRef}
      sx={{
        height: GANTT_ROW_H,
        borderBottom: '0.5px solid',
        borderColor: 'divider',
        position: 'relative',
        width: timelineWidth,
      }}
    >
      <GanttBar node={node} rangeStart={rangeStart} editable={editable} onReschedule={onReschedule} />
      {/* 子节点落点：琥珀色内缩方框（与左侧标签呼应） */}
      {isInside && (
        <Box
          sx={{
            position: 'absolute',
            inset: 4,
            borderRadius: 1,
            boxShadow: 'inset 0 0 0 2px #B8741B',
            bgcolor: 'rgba(184,116,27,0.10)',
            pointerEvents: 'none',
            zIndex: 3,
          }}
        />
      )}
      {/* 同级落点：品牌青粗线 + 圆点 */}
      {isSibling && (
        <>
          <Box
            sx={{
              position: 'absolute',
              left: 0,
              right: 0,
              [rowBand === 'before' ? 'top' : 'bottom']: -2,
              height: 4,
              background: '#2E7D87',
              borderRadius: 2,
              pointerEvents: 'none',
              zIndex: 3,
            }}
          />
          <Box
            sx={{
              position: 'absolute',
              [rowBand === 'before' ? 'top' : 'bottom']: -5,
              left: 2,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: '#2E7D87',
              boxShadow: (theme: any) => `0 0 0 2px ${theme.palette.background.paper}`,
              pointerEvents: 'none',
              zIndex: 4,
            }}
          />
        </>
      )}
    </Box>
  );
}
