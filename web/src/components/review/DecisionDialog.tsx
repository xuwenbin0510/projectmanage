import { useState } from 'react';
import { Alert, Stack, TextField, Typography } from '@mui/material';

import { FormDialog } from '@/components/common';
import { ReviewStepper } from './ReviewStepper';
import type { Review } from '@/types/review';
import type { DecisionPayload } from '@/api/contract';
import { REVIEW_TYPE_LABEL } from '@/config/enums';
import { useToast } from '@/hooks/useToast';

export type DecisionAction = 'approve' | 'reject' | 'withdraw';

const ACTION_TITLE: Record<DecisionAction, string> = {
  approve: '审批通过',
  reject: '审批驳回',
  withdraw: '撤回评审',
};

interface DecisionDialogProps {
  open: boolean;
  review: Review | null;
  action: DecisionAction;
  onClose: () => void;
  onSubmit: (payload: DecisionPayload) => Promise<unknown>;
}

/**
 * 审批决策对话框：通过 / 驳回 / 撤回
 * @prd P0-10
 * 规则：驳回必须填意见；客户代表代录必须填意见或凭证链接。
 */
export function DecisionDialog({ open, review, action, onClose, onSubmit }: DecisionDialogProps): JSX.Element | null {
  const [comment, setComment] = useState<string>('');
  const [evidenceUrl, setEvidenceUrl] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const toast = useToast();

  if (!review) return null;

  const currentStep = review.steps.find((s) => s.status === 'current');
  const isProxy = currentStep?.role === 'customer_rep';
  const needComment = action === 'reject' || isProxy;

  const handleSubmit = async (): Promise<void> => {
    if (needComment && !comment.trim() && !evidenceUrl.trim()) {
      toast.warning(action === 'reject' ? '驳回必须填写意见' : '客户代表代录须填写意见或凭证链接');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ comment: comment.trim(), evidenceUrl: evidenceUrl.trim() });
      toast.success(`${ACTION_TITLE[action]}成功`);
      setComment('');
      setEvidenceUrl('');
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormDialog
      open={open}
      title={`${ACTION_TITLE[action]} · ${REVIEW_TYPE_LABEL[review.reviewType]}`}
      submitText={ACTION_TITLE[action]}
      submitting={submitting}
      onClose={onClose}
      onSubmit={() => void handleSubmit()}
    >
      <Stack spacing={0.5}>
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{review.title}</Typography>
        <Typography variant="caption" color="text.secondary">
          所属项目：{review.projectName} · 发起人：{review.initiatorName}
        </Typography>
      </Stack>

      <ReviewStepper review={review} />

      {isProxy && (
        <Alert severity="warning" variant="outlined">
          当前步骤为「客户代表」代录：必须填写会议纪要意见或上传凭证链接，系统会完整留痕代录人。
        </Alert>
      )}

      <TextField
        label={needComment ? '审批意见（必填）' : '审批意见（选填）'}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        multiline
        minRows={3}
        fullWidth
        required={needComment}
        placeholder={action === 'reject' ? '请说明驳回原因与整改要求' : '可填写补充说明'}
      />

      <TextField
        label="凭证链接（选填，如会议纪要 / 邮件存档）"
        value={evidenceUrl}
        onChange={(e) => setEvidenceUrl(e.target.value)}
        fullWidth
        placeholder="https://"
      />
    </FormDialog>
  );
}
