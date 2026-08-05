import { useCallback, useState } from 'react';
import { Box, Button, Chip, Paper, Stack, Tab, Tabs, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';

import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  StatusChip,
} from '@/components/common';
import { ReviewStepper } from '@/components/review/ReviewStepper';
import { DecisionDialog } from '@/components/review/DecisionDialog';
import type { DecisionAction } from '@/components/review/DecisionDialog';
import { api } from '@/api/client';
import type { DecisionPayload } from '@/api/contract';
import type { Review } from '@/types/review';
import { useAsync } from '@/hooks';
import { REVIEW_TYPE_LABEL } from '@/config/enums';
import { ROUTES } from '@/config/routes';
import { fmtDateTime } from '@/utils/date';
import { alphaOf as alpha, tokens } from '@/theme/tokens';

type TabKey = 'todo' | 'mine' | 'all';

/**
 * 审批中心：待我审批 / 我发起的 / 全部
 * @prd P0-10 P0-13
 */
export function ApprovalsPage(): JSX.Element {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>('todo');
  const [target, setTarget] = useState<Review | null>(null);
  const [action, setAction] = useState<DecisionAction>('approve');

  const fetcher = useCallback(
    async (): Promise<{ todo: Review[]; all: Review[] }> => {
      const [todo, all] = await Promise.all([api.listMyApprovals(), api.listReviews()]);
      return { todo, all };
    },
    [],
  );
  const { data, loading, error, run } = useAsync(fetcher, []);

  const me = data?.todo ?? [];
  const all = data?.all ?? [];
  const mine = all.filter((r) => r.initiator && me.every((t) => t.id !== r.id) && r.status !== '已撤回');

  const rows: Review[] = tab === 'todo' ? me : tab === 'mine' ? mine : all;

  const openDialog = (review: Review, act: DecisionAction): void => {
    setTarget(review);
    setAction(act);
  };

  const submitDecision = async (payload: DecisionPayload): Promise<void> => {
    if (!target) return;
    if (action === 'approve') await api.approveReview(target.id, payload);
    else if (action === 'reject') await api.rejectReview(target.id, payload);
    else await api.withdrawReview(target.id, payload);
    await run();
  };

  if (loading && !data) return <LoadingState variant="skeleton" rows={5} height={92} />;
  if (error && !data) return <ErrorState error={error} onRetry={() => void run()} />;

  return (
    <Box>
      <PageHeader
        title="审批中心"
        subtitle="所有评审 / 门控 / 立项 / 变更审批的统一入口，每一步决策都会写入审计日志"
        actions={
          <Button size="small" variant="outlined" onClick={() => void run()}>
            刷新
          </Button>
        }
      />

      <Tabs value={tab} onChange={(_, v: TabKey) => setTab(v)} sx={{ mb: 2, minHeight: 40 }}>
        <Tab
          value="todo"
          sx={{ minHeight: 40 }}
          label={
            <Stack direction="row" spacing={0.75} alignItems="center">
              <span>待我审批</span>
              <Chip size="small" label={me.length} sx={{ height: 18, fontSize: 11 }} color={me.length ? 'warning' : 'default'} />
            </Stack>
          }
        />
        <Tab value="mine" sx={{ minHeight: 40 }} label={`其他进行中（${mine.length}）`} />
        <Tab value="all" sx={{ minHeight: 40 }} label={`全部（${all.length}）`} />
      </Tabs>

      {rows.length === 0 ? (
        <SectionCard>
          <EmptyState
            title={tab === 'todo' ? '当前没有待我处理的审批' : '暂无记录'}
            description={tab === 'todo' ? '所有落到你名下的审批步骤都已处理完毕' : ''}
          />
        </SectionCard>
      ) : (
        <Stack spacing={1.75}>
          {rows.map((r) => {
            const actionable = me.some((t) => t.id === r.id);
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
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      项目：
                      <Box
                        component="span"
                        onClick={() => navigate(ROUTES.projectReviews(r.projectId))}
                        sx={{ color: tokens.brand.primary, cursor: 'pointer', mx: 0.5 }}
                      >
                        {r.projectName}
                      </Box>
                      · 发起人 {r.initiatorName} · {fmtDateTime(r.createdAt)}
                    </Typography>
                  </Box>

                  {actionable && (
                    <Stack direction="row" spacing={1} flexShrink={0}>
                      <Button size="small" variant="contained" onClick={() => openDialog(r, 'approve')}>
                        通过
                      </Button>
                      <Button size="small" variant="outlined" color="error" onClick={() => openDialog(r, 'reject')}>
                        驳回
                      </Button>
                    </Stack>
                  )}
                  {!actionable && r.status === '审批中' && (
                    <Button size="small" color="inherit" onClick={() => openDialog(r, 'withdraw')}>
                      撤回
                    </Button>
                  )}
                </Stack>

                <Box
                  sx={{
                    mt: 1.5,
                    pt: 1.5,
                    borderTop: `1px solid ${alpha(tokens.border.subtle, 0.9)}`,
                  }}
                >
                  <ReviewStepper review={r} />
                </Box>
              </Paper>
            );
          })}
        </Stack>
      )}

      <DecisionDialog
        open={Boolean(target)}
        review={target}
        action={action}
        onClose={() => setTarget(null)}
        onSubmit={submitDecision}
      />
    </Box>
  );
}
