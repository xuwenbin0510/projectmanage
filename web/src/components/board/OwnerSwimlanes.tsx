/**
 * 按负责人分列的**只读**看板视图（B11 · T03 · D-B11-6）
 *
 * 为什么只读：按负责人分列时，「拖到别人泳道」的自然语义是改 `owner`，
 * 属 PRD P1-4（本期不做）；若保留拖拽但只允许同泳道内改状态，交互解释成本极高。
 * 结论：本视图不挂 `DndContext`，卡片一律不可拖，工具条给 Tooltip 说明。
 *
 * ⚠️ 列不再表达状态，因此**每张卡片必须带 `StatusChip`**，否则丢失状态信息。
 *
 * @prd B11
 */

import { Box, Paper, Stack, Tooltip, Typography } from '@mui/material';

import { EmptyState, ProgressBar, StatusChip, UserAvatar } from '@/components/common';
import type { WbsNode } from '@/types/wbs';
import type { OwnerLane } from '@/utils/board';
import { isCardOverdue } from '@/utils/board';
import { alphaOf, tokens } from '@/theme/tokens';
import { fmtDate } from '@/utils/date';

interface OwnerCardProps {
  card: WbsNode;
}

/** 只读卡片：状态标签 + 编码名称 + 截止日 + 进度条 */
function OwnerCard({ card }: OwnerCardProps): JSX.Element {
  const overdue = isCardOverdue(card.dueDate);

  return (
    <Paper
      variant="outlined"
      elevation={0}
      sx={{
        p: 1.25,
        mb: 1,
        cursor: 'default',
        borderColor: overdue ? alphaOf(tokens.status.danger, 0.5) : 'divider',
      }}
    >
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
        <StatusChip status={card.status} sx={{ height: 19, fontSize: 11 }} />
        <Typography
          variant="caption"
          sx={{ color: overdue ? tokens.status.danger : 'text.secondary', ml: 'auto' }}
          noWrap
        >
          {fmtDate(card.dueDate)}
          {overdue ? ' · 逾期' : ''}
        </Typography>
      </Stack>

      <Typography sx={{ fontSize: 13, fontWeight: 500 }} noWrap title={`${card.wbsCode} ${card.name}`}>
        {card.wbsCode} {card.name}
      </Typography>

      <Box sx={{ mt: 0.75 }}>
        <ProgressBar value={card.progress} tone={overdue ? 'danger' : 'brand'} height={5} showLabel={false} />
      </Box>
    </Paper>
  );
}

export interface OwnerSwimlanesProps {
  /** `groupByOwner(filterCards(...))` 的结果 */
  lanes: OwnerLane[];
}

/**
 * 负责人泳道容器。
 *
 * 泳道顺序由 `groupByOwner` 决定（逾期数 ↓ → 任务数 ↓ → 姓名 ↑，未分配恒最后），
 * 本组件**不再排序**，只负责渲染。
 */
export function OwnerSwimlanes({ lanes }: OwnerSwimlanesProps): JSX.Element {
  if (lanes.length === 0) {
    return (
      <Box sx={{ p: 3 }}>
        <EmptyState title="没有符合条件的任务" description="试试清空筛选条件" dense />
      </Box>
    );
  }

  return (
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
      {lanes.map((lane) => (
        <Box
          key={lane.owner || '__unassigned__'}
          sx={{ flex: '1 1 200px', minWidth: 176, display: 'flex', flexDirection: 'column' }}
        >
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 1, minWidth: 0 }}>
            <UserAvatar name={lane.ownerName} size={22} />
            <Typography sx={{ fontSize: 13, fontWeight: 600, minWidth: 0 }} noWrap>
              {lane.ownerName}
            </Typography>
            <Tooltip title={`${lane.cards.length} 个任务，其中 ${lane.overdueCount} 个已逾期`} arrow>
              <Typography
                variant="caption"
                sx={{
                  ml: 'auto',
                  flexShrink: 0,
                  color: lane.overdueCount > 0 ? tokens.status.danger : 'text.secondary',
                }}
              >
                {lane.cards.length} 个 / {lane.overdueCount} 逾期
              </Typography>
            </Tooltip>
          </Stack>

          <Box
            sx={{
              flex: 1,
              minHeight: 140,
              p: 1,
              borderRadius: 1.5,
              bgcolor: alphaOf(tokens.text.secondary, 0.05),
              border: `1px dashed ${tokens.border.subtle}`,
            }}
          >
            {lane.cards.map((c) => (
              <OwnerCard key={c.id} card={c} />
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
