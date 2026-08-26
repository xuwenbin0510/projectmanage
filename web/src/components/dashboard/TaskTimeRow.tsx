/**
 * 时间轴任务行（逾期 / 临期 / 计划周期内 三栏共用同格式）。
 *
 * 抽自「我的工作台」WorkbenchPage，提升为跨页共享组件：
 *  - 全局总览（B12）的「任务时间轴」三栏复用同一渲染，保证两页视觉与心智一致。
 *  - 入参 `task` 为 `WbsNode`（含 projectName 可选，用于跨项目展示时由调用方拼接 hint）。
 *
 * 🚫 禁止 import `tokens` / `alphaOf` 之外的硬编码色；颜色走主题 tokens。
 */
import { Box, Stack, Typography } from '@mui/material';
import { PriorityChip, ProgressBar } from '@/components/common';
import type { WbsNode } from '@/types/wbs';
import { alphaOf as alpha, tokens } from '@/theme/tokens';

export interface TaskTimeRowProps {
  /** 任务节点（WbsNode） */
  task: WbsNode;
  /** 第二行辅助说明（如「截止 2026-08-30 · 已逾期 3 天」） */
  hint: string;
  /** 整行点击（跳转到任务详情 / 所属项目 WBS） */
  onClick: () => void;
}

export function TaskTimeRow({ task, hint, onClick }: TaskTimeRowProps): JSX.Element {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1}
      alignItems={{ xs: 'stretch', sm: 'center' }}
      justifyContent="space-between"
      onClick={onClick}
      sx={{
        px: 1.5,
        py: 1.25,
        borderRadius: 1.5,
        cursor: 'pointer',
        border: `1px solid ${tokens.border.subtle}`,
        '&:hover': { borderColor: alpha(tokens.brand.primary, 0.6) },
      }}
    >
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
          <PriorityChip priority={task.priority} />
          <Typography sx={{ fontSize: 13.5 }} noWrap>
            {task.wbsCode} {task.name}
          </Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
          {hint}
        </Typography>
      </Box>
      <ProgressBar value={task.progress} tone="brand" sx={{ maxWidth: 130, flexShrink: 0 }} />
    </Stack>
  );
}
