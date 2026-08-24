import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Button, Chip, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useParams } from 'react-router-dom';

import {
  EmptyState,
  FormDialog,
  LoadingState,
  PageHeader,
  PermissionButton,
  SectionCard,
  StatusChip,
} from '@/components/common';
import { ReviewStepper } from '@/components/review/ReviewStepper';
import { DecisionDialog } from '@/components/review/DecisionDialog';
import type { DecisionAction } from '@/components/review/DecisionDialog';
import type { Review, ReviewType } from '@/types/review';
import type { Role } from '@/types/project';
import type { CreateReviewPayload, DecisionPayload } from '@/api/contract';
import { api } from '@/api/client';
import { useProjectStore } from '@/stores/projectStore';
import { useFlowStore } from '@/stores/flowStore';
import { useToast } from '@/hooks';
import { REVIEW_TYPE_LABEL } from '@/config/enums';
import { fmtDateTime } from '@/utils/date';
import { tokens } from '@/theme/tokens';

const REVIEW_TYPES: ReviewType[] = ['formal', 'technical', 'code', 'ccb', 'project'];

/**
 * 项目内评审与审批列表（P0-09 / P0-10）
 * @prd P0-09 P0-10
 */
export function ReviewsPage(): JSX.Element {
  const { id = '' } = useParams();
  const toast = useToast();
  const project = useProjectStore((s) => s.current);

  const reviews = useFlowStore((s) => s.reviews);
  const loading = useFlowStore((s) => s.loading);
  const fetchReviews = useFlowStore((s) => s.fetchReviews);

  const [myApprovals, setMyApprovals] = useState<Review[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [reviewType, setReviewType] = useState<ReviewType>('formal');
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState<Review | null>(null);
  const [action, setAction] = useState<DecisionAction>('approve');
  const [roles, setRoles] = useState<Role[]>([]);

  const roleNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    roles.forEach((r) => { if (r.enabled) map[r.roleKey] = r.name; });
    return map;
  }, [roles]);

  useEffect(() => {
    api.listRoles().then(setRoles).catch(() => {});
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [rs, mine] = await Promise.all([api.listReviews(id), api.listMyApprovals()]);
      // flowStore 内部已 set reviews；这里仅做本地并行取数
      void rs;
      setMyApprovals(mine.filter((r) => r.projectId === id));
    } catch (e) {
      toast.error(e);
    }
  }, [id, toast]);

  useEffect(() => {
    void fetchReviews(id).catch((e: unknown) => toast.error(e));
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const archived = project?.status === '已结项' || project?.status === '已终止';
  const myIds = useMemo(() => new Set(myApprovals.map((r) => r.id)), [myApprovals]);

  const openCreate = (): void => {
    setReviewType('formal');
    setTitle('');
    setCreateOpen(true);
  };

  const submitCreate = async (): Promise<void> => {
    if (!title.trim()) {
      toast.warning('请填写评审标题');
      return;
    }
    const payload: CreateReviewPayload = {
      projectId: id,
      refType: 'project',
      refId: id,
      reviewType,
      title: title.trim(),
    };
    try {
      await api.createReview(payload);
      toast.success('评审已发起');
      setCreateOpen(false);
      await fetchReviews(id);
      await refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  const submitDecision = async (p: DecisionPayload): Promise<void> => {
    if (!target) return;
    try {
      if (action === 'approve') await api.approveReview(target.id, p);
      else if (action === 'reject') await api.rejectReview(target.id, p);
      else await api.withdrawReview(target.id, p);
      toast.success('决策已记录');
      setTarget(null);
      await fetchReviews(id);
      await refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Stack spacing={2.5}>
      <PageHeader
        title="评审审批"
        subtitle="立项 / 设计 / 验收等评审的审批链统一在此追踪；串行逐级或并行一票否决"
        actions={
          <PermissionButton
            action="review:start"
            disabledReason={archived ? '项目已归档' : ''}
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            onClick={openCreate}
          >
            发起评审
          </PermissionButton>
        }
      />

      {loading && reviews.length === 0 ? (
        <LoadingState variant="skeleton" rows={4} height={92} />
      ) : reviews.length === 0 ? (
        <SectionCard>
          <EmptyState title="暂无评审记录" description="点击右上角「发起评审」新建一条评审" />
        </SectionCard>
      ) : (
        <Stack spacing={1.75}>
          {reviews.map((r) => {
            const actionable = myIds.has(r.id);
            return (
              <Paper key={r.id} variant="outlined" sx={{ p: 2 }}>
                <Stack
                  direction={{ xs: 'column', md: 'row' }}
                  justifyContent="space-between"
                  spacing={1.5}
                  alignItems={{ xs: 'flex-start', md: 'center' }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Typography sx={{ fontSize: 15, fontWeight: 600 }}>{r.title}</Typography>
                      <Chip size="small" variant="outlined" label={REVIEW_TYPE_LABEL[r.reviewType]} sx={{ height: 20 }} />
                      <StatusChip status={r.status} />
                      {actionable && <Chip size="small" label="待我审批" color="warning" sx={{ height: 20 }} />}
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      发起人 {r.initiatorName} · {fmtDateTime(r.createdAt)}
                    </Typography>
                  </Box>
                  {actionable && (
                    <Stack direction="row" spacing={1} flexShrink={0}>
                      <Button size="small" variant="contained" onClick={() => { setTarget(r); setAction('approve'); }}>
                        通过
                      </Button>
                      <Button size="small" variant="outlined" color="error" onClick={() => { setTarget(r); setAction('reject'); }}>
                        驳回
                      </Button>
                    </Stack>
                  )}
                  {!actionable && r.status === '审批中' && (
                    <Button size="small" color="inherit" onClick={() => { setTarget(r); setAction('withdraw'); }}>
                      撤回
                    </Button>
                  )}
                </Stack>

                <Box
                  sx={{
                    mt: 1.5,
                    pt: 1.5,
                    borderTop: `1px solid ${tokens.border.subtle}`,
                  }}
                >
                  <ReviewStepper review={r} roleNameMap={roleNameMap} />
                </Box>
              </Paper>
            );
          })}
        </Stack>
      )}

      <FormDialog
        open={createOpen}
        title="发起评审"
        submitText="发起"
        onClose={() => setCreateOpen(false)}
        onSubmit={() => void submitCreate()}
      >
        <TextField
          select
          label="评审类型"
          value={reviewType}
          onChange={(e) => setReviewType(e.target.value as ReviewType)}
          fullWidth
        >
          {REVIEW_TYPES.map((t) => (
            <MenuItem key={t} value={t}>
              {REVIEW_TYPE_LABEL[t]}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="评审标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          fullWidth
          required
          placeholder="如：立项评审 / 需求基线评审"
        />
      </FormDialog>

      <DecisionDialog
        open={Boolean(target)}
        review={target}
        action={action}
        onClose={() => setTarget(null)}
        onSubmit={(p) => submitDecision(p)}
      />
    </Stack>
  );
}
