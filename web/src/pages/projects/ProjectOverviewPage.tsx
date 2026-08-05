import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useParams } from 'react-router-dom';

import {
  ConfirmDialog,
  EmptyState,
  FieldRow,
  FormDialog,
  PermissionButton,
  ProgressBar,
  SectionCard,
  StatusChip,
  UserAvatar,
} from '@/components/common';
import { api } from '@/api/client';
import { useProjectStore } from '@/stores/projectStore';
import { useAsync, useToast } from '@/hooks';
import type { CloseBlocker, GateChecklistItem, ProjectStatus, StageWithGate } from '@/types/project';
import {
  GATE_CONCLUSIONS,
  GATE_ICON,
  PROJECT_ROLE_LABEL,
  PROJECT_TRANSITIONS,
  PROJECT_TYPE_LABEL,
} from '@/config/enums';
import { alphaOf as alpha, colorOf, tokens, toneColor } from '@/theme/tokens';
import { ErrorCode, isApiError } from '@/types/api';
import { fmtDate } from '@/utils/date';
import { fmtAmount } from '@/utils/format';
import { rollupProjectProgress } from '@/api/mock/rules';
import type { WbsNode } from '@/types/wbs';

type Conclusion = '已通过' | '有条件通过' | '不通过';

/** 阶段推进受阻项（对应契约 E_GATE_NOT_PASSED.blockers[]） */
interface StageBlocker {
  /** 归类：检查项未确认 / 门未决议 / 阶段顺序 */
  kind: 'gate_item' | 'gate_status' | 'sequence';
  message: string;
  hint?: string;
}

/**
 * 项目概览：阶段条 + 质量门检查清单 + 关键信息 + 状态流转
 * @prd P0-04 P0-05 P0-06 P0-17
 */
export function ProjectOverviewPage(): JSX.Element {
  const { id = '' } = useParams();
  const toast = useToast();

  const project = useProjectStore((s) => s.current);
  const stages = useProjectStore((s) => s.stages);
  const members = useProjectStore((s) => s.members);
  const milestones = useProjectStore((s) => s.milestones);
  const refreshStages = useProjectStore((s) => s.refreshStages);
  const fetchDetail = useProjectStore((s) => s.fetchDetail);

  const [activeStageId, setActiveStageId] = useState<string>('');
  const [gateOpen, setGateOpen] = useState<boolean>(false);
  const [conclusion, setConclusion] = useState<Conclusion>('已通过');
  const [gateComment, setGateComment] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [transitionTo, setTransitionTo] = useState<ProjectStatus | ''>('');
  const [blockers, setBlockers] = useState<CloseBlocker[]>([]);
  const [advancing, setAdvancing] = useState<boolean>(false);
  const [stageBlockers, setStageBlockers] = useState<StageBlocker[] | null>(null);

  const { data: nodes } = useAsync<WbsNode[]>(() => (id ? api.listWbs(id) : Promise.resolve([])), [id]);

  /** 默认选中当前阶段 */
  useEffect(() => {
    if (!stages.length) return;
    const fallback = project?.currentStageId ?? stages[0].id;
    setActiveStageId((prev) => (stages.some((s) => s.id === prev) ? prev : fallback));
  }, [stages, project?.currentStageId]);

  const activeStage: StageWithGate | undefined = useMemo(
    () => stages.find((s) => s.id === activeStageId),
    [stages, activeStageId],
  );

  const progress = useMemo(() => rollupProjectProgress(nodes ?? []), [nodes]);
  const uncheckedCount = (activeStage?.gateItems ?? []).filter((i) => !i.checked).length;
  const allowedTransitions: ProjectStatus[] = project ? PROJECT_TRANSITIONS[project.status] ?? [] : [];
  const archived = project?.status === '已结项' || project?.status === '已终止';

  /** 下一阶段（按 seq 顺序，阶段不可跳阶） */
  const nextStage: StageWithGate | null = activeStage
    ? stages.find((s) => s.seq === activeStage.seq + 1) ?? null
    : null;
  const isCurrentStage = Boolean(activeStage && project?.currentStageId === activeStage.id);

  if (!project) return <EmptyState title="项目不存在" description="请返回项目列表重新选择" />;

  /* ── 门检查项 ────────────────────────────────── */

  const handleToggleItem = async (item: GateChecklistItem, checked: boolean): Promise<void> => {
    try {
      await api.toggleGateItem(item.id, checked);
      await refreshStages(id);
    } catch (e) {
      toast.error(e);
    }
  };

  /* ── 阶段推进（B3：受阻时必须列出 blockers） ────────
   * 契约里没有独立的 advanceStage：门控结论为「已通过 / 有条件通过」时，
   * mock 会在 decideGate 内部调用 advanceStage 自动推进。
   * 因此"进入下一阶段"= 先做本地门禁体检，全通过才提交通过结论；
   * 任何一项不满足都把未通过检查项**逐条列出来**，而不是静默或只弹一句 toast。
   */

  /** 把服务端返回的结构化拦截数据翻译成 blockers 列表 */
  const blockersFromError = (e: unknown): StageBlocker[] | null => {
    if (!isApiError(e)) return null;
    if (e.code !== ErrorCode.E_GATE_NOT_PASSED && e.code !== ErrorCode.E_GATE_ITEM_INCOMPLETE) return null;
    const data = e.data as
      | { unchecked?: Array<{ id: string; content: string }>; blockers?: Array<{ message: string }> }
      | undefined;
    const list: StageBlocker[] = [];
    (data?.unchecked ?? []).forEach((u) =>
      list.push({ kind: 'gate_item', message: `检查项未确认：${u.content}` }),
    );
    (data?.blockers ?? []).forEach((b) => list.push({ kind: 'gate_status', message: b.message }));
    return list.length ? list : [{ kind: 'gate_status', message: e.message }];
  };

  /** 本地门禁体检：返回全部未通过项（空数组 = 可推进） */
  const collectStageBlockers = (): StageBlocker[] => {
    const list: StageBlocker[] = [];
    if (!activeStage) return [{ kind: 'sequence', message: '未选择阶段' }];

    if (!isCurrentStage) {
      list.push({
        kind: 'sequence',
        message: `「${activeStage.seq}. ${activeStage.name}」不是当前阶段，阶段只能顺序推进、不可跳阶`,
        hint: '请先回到当前阶段完成推进',
      });
    }

    if (!activeStage.gate) {
      list.push({
        kind: 'gate_status',
        message: `阶段「${activeStage.name}」未配置质量门，无法通过门控推进`,
        hint: '请在生命周期模板中为该阶段配置质量门',
      });
      return list;
    }

    activeStage.gateItems
      .filter((i) => !i.checked)
      .forEach((i) =>
        list.push({
          kind: 'gate_item',
          message: `检查项未确认：${i.seq}. ${i.content}`,
          hint: `责任角色 ${i.ownerRole.toUpperCase()}`,
        }),
      );

    if (activeStage.gate.status === '不通过') {
      list.push({
        kind: 'gate_status',
        message: `质量门 ${activeStage.gate.code} 结论为「不通过」`,
        hint: '需整改后重新提交门控结论',
      });
    }

    return list;
  };

  const handleAdvance = async (): Promise<void> => {
    const found = collectStageBlockers();
    if (found.length) {
      // 受阻：把未通过检查项清单摆到台面上（E_GATE_NOT_PASSED.blockers[]）
      setStageBlockers(found);
      return;
    }
    if (!activeStage?.gate) return;

    // 已是「有条件通过」的门保持原结论，避免推进动作偷偷把结论升级为「已通过」
    const advanceConclusion: Conclusion =
      activeStage.gate.conclusion === '有条件通过' ? '有条件通过' : '已通过';

    setAdvancing(true);
    try {
      await api.decideGate(id, {
        gateId: activeStage.gate.id,
        conclusion: advanceConclusion,
        comment: activeStage.gate.comment || '阶段推进：质量门检查项已全部确认',
      });
      toast.success(nextStage ? `已推进到「${nextStage.seq}. ${nextStage.name}」` : '本阶段已完成');
      await fetchDetail(id);
    } catch (e) {
      const fromServer = blockersFromError(e);
      if (fromServer) {
        setStageBlockers(fromServer);
        return;
      }
      toast.error(e);
    } finally {
      setAdvancing(false);
    }
  };

  const handleDecide = async (): Promise<void> => {
    if (!activeStage?.gate) return;
    setSubmitting(true);
    try {
      await api.decideGate(id, { gateId: activeStage.gate.id, conclusion, comment: gateComment.trim() });
      toast.success(`门控结论已记录：${conclusion}`);
      setGateOpen(false);
      setGateComment('');
      await fetchDetail(id);
    } catch (e) {
      // 门检查项不齐备：同样列出未通过项，而不是只弹一句「存在未确认的检查项」
      const fromServer = blockersFromError(e);
      if (fromServer) {
        setGateOpen(false);
        setStageBlockers(fromServer);
        return;
      }
      toast.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  /* ── 状态流转 ────────────────────────────────── */

  const openTransition = async (to: ProjectStatus): Promise<void> => {
    setBlockers([]);
    if (to === '已结项') {
      try {
        const list = await api.checkClose(id);
        setBlockers(list);
      } catch (e) {
        toast.error(e);
      }
    }
    setTransitionTo(to);
  };

  const doTransition = async (): Promise<void> => {
    if (!transitionTo) return;
    await api.transitionProject(id, transitionTo, `概览页操作：流转到「${transitionTo}」`);
    toast.success(`项目状态已更新为「${transitionTo}」`);
    setTransitionTo('');
    await fetchDetail(id);
  };

  return (
    <Stack spacing={2.5}>
      {archived && (
        <Alert severity="info" variant="outlined">
          项目已{project.status}，当前处于<strong>只读归档</strong>状态，所有写操作均被拦截。
        </Alert>
      )}

      {/* 阶段条 */}
      <SectionCard
        title="生命周期阶段"
        subtitle={`${PROJECT_TYPE_LABEL[project.type]} · 阶段只能顺序推进，质量门通过后才进入下一阶段`}
        actions={
          <PermissionButton
            action="stage:advance"
            size="small"
            variant="contained"
            disabled={archived || advancing || !activeStage}
            disabledReason={archived ? '项目已归档' : ''}
            endIcon={<ArrowForwardIcon sx={{ fontSize: 16 }} />}
            onClick={() => void handleAdvance()}
          >
            {advancing ? '推进中…' : nextStage ? `进入「${nextStage.name}」` : '完成本阶段'}
          </PermissionButton>
        }
      >
        <Stack direction="row" spacing={1.25} sx={{ overflowX: 'auto', pb: 1 }}>
          {stages.map((s) => {
            const gateStatus = s.gate?.status ?? '未开始';
            const isActive = s.id === activeStageId;
            const isCurrent = s.id === project.currentStageId;
            const color = colorOf(s.status === '已完成' ? '已通过' : s.status);
            return (
              <Box
                key={s.id}
                onClick={() => setActiveStageId(s.id)}
                sx={{
                  minWidth: 168,
                  flexShrink: 0,
                  p: 1.5,
                  borderRadius: 1.5,
                  cursor: 'pointer',
                  border: '1px solid',
                  borderColor: isActive ? alpha(tokens.brand.primary, 0.75) : 'divider',
                  bgcolor: isActive ? alpha(tokens.brand.primary, 0.1) : 'transparent',
                  transition: 'border-color .18s, background-color .18s',
                }}
              >
                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography sx={{ color, fontSize: 15, lineHeight: 1 }}>{GATE_ICON[gateStatus]}</Typography>
                  <Typography sx={{ fontSize: 13, fontWeight: 600 }} noWrap>
                    {s.seq}. {s.name}
                  </Typography>
                  {isCurrent && <Chip size="small" label="当前" sx={{ height: 18, fontSize: 11 }} />}
                </Stack>
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <StatusChip status={s.status} />
                  {s.gate && (
                    <Tooltip title={`${s.gate.code} ${s.gate.name}`} arrow>
                      <Box>
                        <StatusChip status={gateStatus} variant="outlined" />
                      </Box>
                    </Tooltip>
                  )}
                </Stack>
              </Box>
            );
          })}
        </Stack>
      </SectionCard>

      <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', lg: '1.35fr 1fr' } }}>
        {/* 质量门检查清单 */}
        <SectionCard
          title={activeStage?.gate ? `${activeStage.gate.code} ${activeStage.gate.name}` : '质量门'}
          subtitle={
            activeStage?.gate
              ? `责任角色 ${activeStage.gate.ownerRole.toUpperCase()} · 全部检查项确认后方可提交结论`
              : '该阶段未配置质量门'
          }
          actions={
            activeStage?.gate ? (
              <PermissionButton
                action="gate:decide"
                size="small"
                variant="contained"
                disabled={archived}
                disabledReason={uncheckedCount > 0 ? `还有 ${uncheckedCount} 项未确认（可提交「不通过」）` : ''}
                onClick={() => setGateOpen(true)}
              >
                提交门控结论
              </PermissionButton>
            ) : undefined
          }
        >
          {!activeStage?.gate ? (
            <EmptyState title="该阶段无质量门" description="生命周期模板未为此阶段配置质量门" dense />
          ) : (
            <>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
                <StatusChip status={activeStage.gate.status} />
                <Typography variant="caption" color="text.secondary">
                  {activeStage.gateItems.filter((i) => i.checked).length} / {activeStage.gateItems.length} 项已确认
                  {activeStage.gate.decidedAt ? ` · 决议于 ${fmtDate(activeStage.gate.decidedAt)}` : ''}
                </Typography>
              </Stack>

              <List dense disablePadding>
                {activeStage.gateItems.map((item) => (
                  <ListItem key={item.id} disableGutters sx={{ alignItems: 'flex-start' }}>
                    <ListItemIcon sx={{ minWidth: 34, mt: 0.25 }}>
                      <Checkbox
                        size="small"
                        checked={item.checked}
                        disabled={archived}
                        onChange={(e) => void handleToggleItem(item, e.target.checked)}
                      />
                    </ListItemIcon>
                    <ListItemText
                      primary={
                        <Typography
                          sx={{
                            fontSize: 14,
                            color: item.checked ? 'text.secondary' : 'text.primary',
                            textDecoration: item.checked ? 'line-through' : 'none',
                          }}
                        >
                          {item.seq}. {item.content}
                        </Typography>
                      }
                      secondary={
                        <Typography variant="caption" color="text.secondary">
                          责任角色 {item.ownerRole.toUpperCase()}
                          {item.checked && item.checkedAt ? ` · ${fmtDate(item.checkedAt)} 确认` : ''}
                          {item.source === 'custom' ? ' · 项目自定义' : ''}
                        </Typography>
                      }
                    />
                  </ListItem>
                ))}
              </List>

              {activeStage.gate.comment && (
                <Alert severity="info" variant="outlined" sx={{ mt: 1.5 }}>
                  <AlertTitle sx={{ mb: 0.25 }}>门控结论：{activeStage.gate.conclusion}</AlertTitle>
                  {activeStage.gate.comment}
                </Alert>
              )}
            </>
          )}
        </SectionCard>

        {/* 项目关键信息 */}
        <Stack spacing={2.5}>
          <SectionCard title="项目信息">
            <Stack spacing={1.5}>
              <FieldRow label="整体进度">
                <ProgressBar value={progress} tone={project.health === 'red' ? 'danger' : 'brand'} />
              </FieldRow>
              <FieldRow label="里程碑">
                {milestones.filter((m) => m.done).length} / {milestones.length} 已达成
              </FieldRow>
              <FieldRow label="客户">{project.customer || '内部项目'}</FieldRow>
              <FieldRow label="合同额">{fmtAmount(project.contractAmount)}</FieldRow>
              <FieldRow label="计划周期">
                {fmtDate(project.planStart)} ~ {fmtDate(project.planEnd)}
              </FieldRow>
              <FieldRow label="项目背景">
                <Typography variant="body2" color="text.secondary">
                  {project.background || '—'}
                </Typography>
              </FieldRow>
              <FieldRow label="项目目标">
                <Stack component="ol" spacing={0.25} sx={{ pl: 2.25, my: 0 }}>
                  {project.goal.length ? (
                    project.goal.map((g) => (
                      <Typography component="li" key={g} variant="body2" color="text.secondary">
                        {g}
                      </Typography>
                    ))
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )}
                </Stack>
              </FieldRow>
              {project.classifyOverrideReason && (
                <FieldRow label="分类覆盖">
                  <Typography variant="body2" sx={{ color: toneColor.warning }}>
                    {project.classifyOverrideReason}
                  </Typography>
                </FieldRow>
              )}
            </Stack>
          </SectionCard>

          <SectionCard title="项目团队" subtitle={`${new Set(members.map((m) => m.userOpenId)).size} 人 · PM / TL 各 1 人`}>
            <Stack spacing={1.25}>
              {members.map((m) => (
                <Stack key={m.id} direction="row" spacing={1.25} alignItems="center">
                  <UserAvatar name={m.userName} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography sx={{ fontSize: 14 }}>{m.userName}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {PROJECT_ROLE_LABEL[m.projectRole]}
                    </Typography>
                  </Box>
                </Stack>
              ))}
              {!members.length && <EmptyState title="暂无成员" dense />}
            </Stack>
          </SectionCard>

          <SectionCard title="状态流转" subtitle={`当前状态「${project.status}」`}>
            {allowedTransitions.length ? (
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {allowedTransitions.map((to) => (
                  <PermissionButton
                    key={to}
                    action="project:transition"
                    size="small"
                    variant={to === '已终止' ? 'outlined' : 'contained'}
                    color={to === '已终止' ? 'error' : 'primary'}
                    onClick={() => void openTransition(to)}
                  >
                    流转到「{to}」
                  </PermissionButton>
                ))}
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">
                当前状态为终态，无可用流转。
              </Typography>
            )}
          </SectionCard>
        </Stack>
      </Box>

      {/* 门控结论对话框 */}
      <FormDialog
        open={gateOpen}
        title={`提交门控结论 · ${activeStage?.gate?.code ?? ''}`}
        submitText="提交结论"
        submitting={submitting}
        onClose={() => setGateOpen(false)}
        onSubmit={() => void handleDecide()}
      >
        {uncheckedCount > 0 && (
          <Alert severity="warning" variant="outlined">
            还有 {uncheckedCount} 项检查项未确认，只能提交「不通过」结论。
          </Alert>
        )}
        <TextField
          select
          label="门控结论"
          value={conclusion}
          onChange={(e) => setConclusion(e.target.value as Conclusion)}
          fullWidth
        >
          {GATE_CONCLUSIONS.map((c) => (
            <MenuItem key={c} value={c} disabled={uncheckedCount > 0 && c !== '不通过'}>
              {c}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="结论说明"
          value={gateComment}
          onChange={(e) => setGateComment(e.target.value)}
          multiline
          minRows={3}
          fullWidth
          placeholder="有条件通过请写明遗留项与关闭时间"
        />
        <Divider />
        <Typography variant="caption" color="text.secondary">
          通过 / 有条件通过后，系统会自动完成本阶段并推进到下一阶段，同时写入审计日志。
        </Typography>
      </FormDialog>

      {/* 阶段推进受阻：逐条列出未通过检查项（E_GATE_NOT_PASSED.blockers[]） */}
      <Dialog
        open={Boolean(stageBlockers)}
        onClose={() => setStageBlockers(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ pb: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <BlockOutlinedIcon sx={{ color: toneColor.danger, fontSize: 20 }} />
            <span>质量门未通过，无法进入下一阶段</span>
          </Stack>
        </DialogTitle>
        <DialogContent>
          <Alert severity="error" variant="outlined" sx={{ mb: 1.5 }}>
            共 <strong>{stageBlockers?.length ?? 0}</strong> 项未通过，全部处理完成后才可推进
            {nextStage ? `到「${nextStage.seq}. ${nextStage.name}」` : ''}。
          </Alert>
          <List dense disablePadding>
            {(stageBlockers ?? []).map((b, i) => (
              <ListItem
                key={`${b.kind}-${i}`}
                disableGutters
                sx={{
                  alignItems: 'flex-start',
                  px: 1.25,
                  py: 0.75,
                  mb: 0.75,
                  borderRadius: 1,
                  border: `1px solid ${alpha(toneColor.danger, 0.35)}`,
                  bgcolor: alpha(toneColor.danger, 0.08),
                }}
              >
                <ListItemIcon sx={{ minWidth: 28, mt: 0.25 }}>
                  <Typography sx={{ fontSize: 12, fontWeight: 700, color: toneColor.danger }}>
                    {i + 1}
                  </Typography>
                </ListItemIcon>
                <ListItemText
                  primary={<Typography sx={{ fontSize: 14 }}>{b.message}</Typography>}
                  secondary={
                    b.hint ? (
                      <Typography variant="caption" color="text.secondary">
                        {b.hint}
                      </Typography>
                    ) : null
                  }
                />
              </ListItem>
            ))}
          </List>
          <Typography variant="caption" color="text.secondary">
            提示：在左侧「质量门」清单勾选完全部检查项后，再点击「
            {nextStage ? `进入「${nextStage.name}」` : '完成本阶段'}」即可推进。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setStageBlockers(null)} variant="contained">
            我知道了
          </Button>
        </DialogActions>
      </Dialog>

      {/* 状态流转确认 */}
      <ConfirmDialog
        open={Boolean(transitionTo)}
        title={`确认流转到「${transitionTo}」？`}
        danger={transitionTo === '已终止'}
        onClose={() => setTransitionTo('')}
        onConfirm={doTransition}
        content={
          blockers.length ? (
            <Box>
              <Alert severity="error" variant="outlined" sx={{ mb: 1 }}>
                存在 {blockers.length} 项结项阻塞，服务端会拒绝本次流转：
              </Alert>
              <Stack component="ul" spacing={0.25} sx={{ pl: 2.25, my: 0 }}>
                {blockers.map((b) => (
                  <Typography component="li" key={b.message} variant="body2">
                    {b.message}
                  </Typography>
                ))}
              </Stack>
            </Box>
          ) : (
            `项目「${project.name}」状态将由「${project.status}」变更为「${transitionTo}」，操作会写入审计日志。`
          )
        }
      />
    </Stack>
  );
}
