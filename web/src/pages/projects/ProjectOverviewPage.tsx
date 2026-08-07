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
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
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
import type { CloseBlocker, GateChecklistItem, MilestoneWithGate, ProjectStatus } from '@/types/project';
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

/** 门控受阻项（对应契约 E_GATE_NOT_PASSED.blockers[]） */
interface GateBlocker {
  /** 归类：检查项未确认 / 门未决议 */
  kind: 'gate_item' | 'gate_status';
  message: string;
  hint?: string;
}

/**
 * 项目概览：里程碑时间轴 + 质量门检查清单 + 关键信息 + 状态流转
 * 方案一（Q-1）：删除阶段实体，里程碑（含挂载质量门）是唯一时间轴。
 * 门控结论为「通过 / 有条件通过」时引擎自动把该里程碑标记为已达成（§4.3），无需单独的推进动作。
 * @prd P0-04 P0-05 P0-06 P0-17
 */
export function ProjectOverviewPage(): JSX.Element {
  const { id = '' } = useParams();
  const toast = useToast();

  const project = useProjectStore((s) => s.current);
  const members = useProjectStore((s) => s.members);
  const milestones = useProjectStore((s) => s.milestones);
  const refreshProject = useProjectStore((s) => s.refreshProject);
  const fetchDetail = useProjectStore((s) => s.fetchDetail);

  const [activeMsId, setActiveMsId] = useState<string>('');
  const [gateOpen, setGateOpen] = useState<boolean>(false);
  const [conclusion, setConclusion] = useState<Conclusion>('已通过');
  const [gateComment, setGateComment] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [transitionTo, setTransitionTo] = useState<ProjectStatus | ''>('');
  const [blockers, setBlockers] = useState<CloseBlocker[]>([]);
  const [gateBlockers, setGateBlockers] = useState<GateBlocker[] | null>(null);

  const { data: nodes } = useAsync<WbsNode[]>(() => (id ? api.listWbs(id) : Promise.resolve([])), [id]);

  /** 默认选中第一个未达成里程碑（按 store 既定顺序，引擎已排序） */
  useEffect(() => {
    const firstUndone = milestones.find((m) => !m.done);
    setActiveMsId((prev) =>
      milestones.some((m) => m.id === prev) ? prev : (firstUndone ?? milestones[0])?.id ?? '',
    );
  }, [milestones]);

  const activeMs: MilestoneWithGate | undefined = useMemo(
    () => milestones.find((m) => m.id === activeMsId),
    [milestones, activeMsId],
  );

  const progress = useMemo(() => rollupProjectProgress(nodes ?? []), [nodes]);
  const uncheckedCount = (activeMs?.gateItems ?? []).filter((i) => !i.checked).length;
  const allowedTransitions: ProjectStatus[] = project ? PROJECT_TRANSITIONS[project.status] ?? [] : [];
  const archived = project?.status === '已结项' || project?.status === '已终止';

  if (!project) return <EmptyState title="项目不存在" description="请返回项目列表重新选择" />;

  /* ── 门检查项 ────────────────────────────────── */

  const handleToggleItem = async (item: GateChecklistItem, checked: boolean): Promise<void> => {
    try {
      await api.toggleGateItem(item.id, checked);
      await refreshProject(id);
    } catch (e) {
      toast.error(e);
    }
  };

  /* ── 门控决议 ──────────────────────────────────
   * 契约里没有独立的 advanceStage：门控结论为「已通过 / 有条件通过」时，
   * mock 会在 decideGate 内部自动把该里程碑标记为已达成（§4.3）。
   * 因此"推进"= 先做本地门禁体检，全通过才提交通过结论；
   * 任何一项不满足都把未通过检查项**逐条列出来**，而不是静默或只弹一句 toast。
   */

  /** 把服务端返回的结构化拦截数据翻译成 blockers 列表 */
  const blockersFromError = (e: unknown): GateBlocker[] | null => {
    if (!isApiError(e)) return null;
    if (e.code !== ErrorCode.E_GATE_NOT_PASSED && e.code !== ErrorCode.E_GATE_ITEM_INCOMPLETE) return null;
    const data = e.data as
      | { unchecked?: Array<{ id: string; content: string }>; blockers?: Array<{ message: string }> }
      | undefined;
    const list: GateBlocker[] = [];
    (data?.unchecked ?? []).forEach((u) =>
      list.push({ kind: 'gate_item', message: `检查项未确认：${u.content}` }),
    );
    (data?.blockers ?? []).forEach((b) => list.push({ kind: 'gate_status', message: b.message }));
    return list.length ? list : [{ kind: 'gate_status', message: e.message }];
  };

  /** 本地门禁体检：返回全部未通过项（空数组 = 可提交通过） */
  const collectGateBlockers = (): GateBlocker[] => {
    const list: GateBlocker[] = [];
    if (!activeMs?.gate) return list;
    activeMs.gateItems
      .filter((i) => !i.checked)
      .forEach((i) =>
        list.push({
          kind: 'gate_item',
          message: `检查项未确认：${i.seq}. ${i.content}`,
          hint: `责任角色 ${i.ownerRole.toUpperCase()}`,
        }),
      );
    if (activeMs.gate.status === '不通过') {
      list.push({
        kind: 'gate_status',
        message: `质量门 ${activeMs.gate.code} 结论为「不通过」`,
        hint: '需整改后重新提交门控结论',
      });
    }
    return list;
  };

  /** 直接标记选中里程碑达成（仅对无门的自建里程碑有效；有门走门控） */
  const handleAchieve = async (): Promise<void> => {
    if (!activeMs) return;
    setSubmitting(true);
    try {
      await api.updateMilestone(activeMs.id, { achieved: true });
      toast.success(`「${activeMs.code} ${activeMs.name}」已标记达成`);
      await refreshProject(id);
    } catch (e) {
      if (isApiError(e) && e.code === ErrorCode.E_GATE_NOT_PASSED) {
        toast.error('该里程碑已挂质量门，需门控结论为「通过 / 有条件通过」后方可标记达成');
        return;
      }
      toast.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDecide = async (): Promise<void> => {
    if (!activeMs?.gate) return;
    setSubmitting(true);
    try {
      await api.decideGate(id, { gateId: activeMs.gate.id, conclusion, comment: gateComment.trim() });
      toast.success(`门控结论已记录：${conclusion}${conclusion !== '不通过' ? '，里程碑已自动达成' : ''}`);
      setGateOpen(false);
      setGateComment('');
      await refreshProject(id);
    } catch (e) {
      // 门检查项不齐备：同样列出未通过项，而不是只弹一句「存在未确认的检查项」
      const fromServer = blockersFromError(e);
      if (fromServer) {
        setGateOpen(false);
        setGateBlockers(fromServer);
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

      {/* 里程碑时间轴 */}
      <SectionCard
        title="里程碑时间轴"
        subtitle={`${PROJECT_TYPE_LABEL[project.type]} · 共 ${milestones.length} 个里程碑，已达成 ${milestones.filter((m) => m.done).length} 个`}
        actions={
          activeMs && !activeMs.done && !activeMs.gate ? (
            <PermissionButton
              action="milestone:edit"
              size="small"
              variant="contained"
              disabled={archived || submitting}
              disabledReason={archived ? '项目已归档' : ''}
              startIcon={<CheckCircleOutlineIcon sx={{ fontSize: 16 }} />}
              onClick={() => void handleAchieve()}
            >
              标记「{activeMs.code}」达成
            </PermissionButton>
          ) : undefined
        }
      >
        <Stack direction="row" spacing={1.25} sx={{ overflowX: 'auto', pb: 1 }}>
          {milestones.map((m) => {
            const gateStatus = m.gate?.status ?? '未开始';
            const isActive = m.id === activeMsId;
            const color = colorOf(m.status);
            return (
              <Box
                key={m.id}
                onClick={() => setActiveMsId(m.id)}
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
                    {m.code} {m.name}
                  </Typography>
                  {m.done && <Chip size="small" label="已达成" sx={{ height: 18, fontSize: 11 }} />}
                  {m.required && !m.done && (
                    <Chip size="small" label="必备" sx={{ height: 18, fontSize: 11 }} />
                  )}
                </Stack>
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <StatusChip status={m.status} />
                  {m.gate && (
                    <Tooltip title={`${m.gate.code} ${m.gate.name}`} arrow>
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
        {/* 质量门检查清单（绑定选中里程碑的门） */}
        <SectionCard
          title={activeMs?.gate ? `${activeMs.gate.code} ${activeMs.gate.name}` : '质量门'}
          subtitle={
            activeMs?.gate
              ? `责任角色 ${activeMs.gate.ownerRole.toUpperCase()} · 全部检查项确认后方可提交结论`
              : activeMs
                ? '该里程碑未挂载质量门'
                : '请选择一个里程碑'
          }
          actions={
            activeMs?.gate ? (
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
          {!activeMs?.gate ? (
            <EmptyState
              title="该里程碑无质量门"
              description={
                activeMs?.done
                  ? '里程碑已达成'
                  : '无门里程碑可直接在里程碑页或上方「标记达成」触发达成，无需门控'
              }
              dense
            />
          ) : (
            <>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
                <StatusChip status={activeMs.gate.status} />
                <Typography variant="caption" color="text.secondary">
                  {activeMs.gateItems.filter((i) => i.checked).length} / {activeMs.gateItems.length} 项已确认
                  {activeMs.gate.decidedAt ? ` · 决议于 ${fmtDate(activeMs.gate.decidedAt)}` : ''}
                </Typography>
              </Stack>

              <List dense disablePadding>
                {activeMs.gateItems.map((item) => (
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

              {activeMs.gate.comment && (
                <Alert severity="info" variant="outlined" sx={{ mt: 1.5 }}>
                  <AlertTitle sx={{ mb: 0.25 }}>门控结论：{activeMs.gate.conclusion}</AlertTitle>
                  {activeMs.gate.comment}
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
              <FieldRow label="质量门">
                已过 {milestones.filter((m) => m.gate && (m.gate.status === '已通过' || m.gate.status === '有条件通过')).length} /{' '}
                {milestones.filter((m) => m.gate).length} 道门
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
        title={`提交门控结论 · ${activeMs?.gate?.code ?? ''}`}
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
          通过 / 有条件通过后，系统会自动将该里程碑标记为已达成，同时写入审计日志。
        </Typography>
      </FormDialog>

      {/* 门控受阻：逐条列出未通过检查项（E_GATE_NOT_PASSED.blockers[]） */}
      <Dialog open={Boolean(gateBlockers)} onClose={() => setGateBlockers(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ pb: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <BlockOutlinedIcon sx={{ color: toneColor.danger, fontSize: 20 }} />
            <span>质量门未通过，无法标记达成</span>
          </Stack>
        </DialogTitle>
        <DialogContent>
          <Alert severity="error" variant="outlined" sx={{ mb: 1.5 }}>
            共 <strong>{gateBlockers?.length ?? 0}</strong> 项未通过，全部处理完成后才可提交通过结论。
          </Alert>
          <List dense disablePadding>
            {(gateBlockers ?? []).map((b, i) => (
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
            提示：在左侧「质量门」清单勾选完全部检查项后，再点击「提交门控结论」即可。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setGateBlockers(null)} variant="contained">
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
