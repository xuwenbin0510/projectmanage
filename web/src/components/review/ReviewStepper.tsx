import { Box, Stack, Tooltip, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import RadioButtonCheckedIcon from '@mui/icons-material/RadioButtonChecked';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';

import type { Review, ReviewStep, ReviewStepStatus } from '@/types/review';
import { CHAIN_ROLE_LABEL, REVIEW_MODE_LABEL, REVIEW_STEP_STATUS_LABEL } from '@/config/enums';
import { alphaOf as alpha, toneColor } from '@/theme/tokens';
import type { SemanticTone } from '@/theme/tokens';
import { fmtDateTime } from '@/utils/date';

const STEP_TONE: Record<ReviewStepStatus, SemanticTone> = {
  approved: 'success',
  rejected: 'danger',
  current: 'warning',
  pending: 'neutral',
  skipped: 'neutral',
};

function StepIcon({ status }: { status: ReviewStepStatus }): JSX.Element {
  const color = toneColor[STEP_TONE[status]];
  const sx = { fontSize: 20, color };
  if (status === 'approved') return <CheckCircleIcon sx={sx} />;
  if (status === 'rejected') return <CancelIcon sx={sx} />;
  if (status === 'current') return <RadioButtonCheckedIcon sx={sx} />;
  if (status === 'skipped') return <RemoveCircleOutlineIcon sx={sx} />;
  return <RadioButtonUncheckedIcon sx={sx} />;
}

interface ReviewStepperProps {
  review: Review;
  /** 紧凑模式：单行横向展示（列表内嵌用） */
  dense?: boolean;
  /** 角色中文名映射（动态从 roles 表取）；缺省时回落写死常量 */
  roleNameMap?: Record<string, string>;
}

/**
 * 审批链可视化：串行逐级 / 并行一票否决 / 单人决议
 * @prd P0-09 P0-10
 */
export function ReviewStepper({ review, dense = false, roleNameMap }: ReviewStepperProps): JSX.Element {
  const steps: ReviewStep[] = review.steps;
  const roleLabel = (key: string): string => roleNameMap?.[key] ?? CHAIN_ROLE_LABEL[key] ?? key;

  /**
   * 兜底代批备注：步骤已决策且「实际决策人」与「归属人」不同（如 admin 代批）时，
   * 追加 `由 X 代批`；相同则不重复显示。归属人仍保留（表示这一步该谁批）。
   */
  const proxyNote = (s: ReviewStep): string => {
    const decided = s.status === 'approved' || s.status === 'rejected';
    if (decided && s.decidedByName && s.decidedByName !== s.assigneeName) {
      return `由 ${s.decidedByName} 代批`;
    }
    return '';
  };

  if (dense) {
    return (
      <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
        {steps.map((s, i) => (
          <Tooltip
            key={s.id}
            arrow
            title={`${roleLabel(s.role)} · ${s.assigneeName} · ${REVIEW_STEP_STATUS_LABEL[s.status]}${
              proxyNote(s) ? `（${proxyNote(s)}）` : ''
            }${s.comment ? `：${s.comment}` : ''}`}
          >
            <Stack direction="row" spacing={0.5} alignItems="center">
              <StepIcon status={s.status} />
              <Typography variant="caption" sx={{ color: toneColor[STEP_TONE[s.status]] }}>
                {s.assigneeName || roleLabel(s.role)}
              </Typography>
              {i < steps.length - 1 && review.mode === 'serial' && (
                <Typography variant="caption" color="text.secondary">
                  ›
                </Typography>
              )}
            </Stack>
          </Tooltip>
        ))}
      </Stack>
    );
  }

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        审批模式：{REVIEW_MODE_LABEL[review.mode]}
        {review.mode === 'parallel_veto' && '（任一否决即驳回，全部通过才算通过）'}
      </Typography>
      <Stack spacing={0}>
        {steps.map((s, i) => {
          const color = toneColor[STEP_TONE[s.status]];
          return (
            <Stack key={s.id} direction="row" spacing={1.5}>
              <Stack alignItems="center" sx={{ width: 22, flexShrink: 0 }}>
                <StepIcon status={s.status} />
                {i < steps.length - 1 && (
                  <Box sx={{ flex: 1, width: 2, minHeight: 26, bgcolor: alpha(color, 0.35), my: 0.25 }} />
                )}
              </Stack>
              <Box sx={{ pb: i < steps.length - 1 ? 1.75 : 0, minWidth: 0, flex: 1 }}>
                <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap>
                  <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
                    {roleLabel(s.role)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {s.assigneeName || '待指派'}
                  </Typography>
                  {proxyNote(s) && (
                    <Typography variant="caption" color="text.secondary">
                      · {proxyNote(s)}
                    </Typography>
                  )}
                  <Typography variant="caption" sx={{ color }}>
                    {REVIEW_STEP_STATUS_LABEL[s.status]}
                  </Typography>
                  {s.decidedAt && (
                    <Typography variant="caption" color="text.secondary">
                      {fmtDateTime(s.decidedAt)}
                    </Typography>
                  )}
                </Stack>
                {s.comment && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                    “{s.comment}”
                  </Typography>
                )}
              </Box>
            </Stack>
          );
        })}
      </Stack>
    </Box>
  );
}
