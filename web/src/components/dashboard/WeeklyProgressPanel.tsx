/**
 * 上周工作进展面板（D01/D02/D03 · 全局总览）
 *
 * 挂载在全局总览（/metrics）图表区之后、项目明细表之前，突出**上周**（上一自然 ISO 周）的项目动态：
 *  ① 周报动态   —— 范围内项目上周（week=上周周码）的周报（含草稿），D02 起展开勾选任务进度明细（before→after）
 *  ② 上周任务进展 —— 上周 updated_at 落在上周区间内的叶子任务（进度更新 + 已完成均列，完成高亮；点击跳项目 WBS）
 *  ③ 上周达成里程碑 —— 上周 done_at 落在区间内的里程碑（点击跳项目里程碑页）
 * D03 新增：任务进度环比区块（上周 vs 前周全量快照，推进/完成/新增/回退）+ 里程碑双周达成对比。
 * 顶部警示条：D02 上周未提交周报的进行中项目（周例会跟进补交）。
 *
 * 周一开周例会回顾「上周主要进展」：周报表按周码存储，week=上周周码天然匹配。
 * 数据源 `WeeklyProgress` 由 `GET /api/dashboard/overview` 的 `weeklyProgress` 字段一次性返回，
 * 与全局总览同源同范围（scope / 筛选 / 决策 ⑥ 已在服务端算好）。
 *
 * @prd D01 / D02 / D03
 */

import { useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import PlaylistAddCheckOutlinedIcon from '@mui/icons-material/PlaylistAddCheckOutlined';
import EmojiEventsOutlinedIcon from '@mui/icons-material/EmojiEventsOutlined';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import TrendingUpOutlinedIcon from '@mui/icons-material/TrendingUpOutlined';
import { useNavigate } from 'react-router-dom';
import { SectionCard, StatusChip } from '@/components/common';
import { ROUTES } from '@/config/routes';
import { api } from '@/api/client';
import { fmtDate, fmtDateTime, fmtShort, shiftWeek, weekCode, weekRange } from '@/utils/date';
import type { Report } from '@/types/report';
import type {
  MilestoneAchievedItem,
  TaskDeltaItem,
  TaskUpdatedItem,
  WeeklyProgress,
  WeeklyReportItem,
} from '@/types/dashboard';

export interface WeeklyProgressPanelProps {
  /** 服务端聚合结果；未加载时为 undefined */
  data?: WeeklyProgress;
  /** 加载态：覆盖整个面板显示骨架 */
  loading?: boolean;
}

/** 单块列表最多展示条数（其余以「共 N 条」提示，避免长列表撑爆面板） */
const MAX_ITEMS = 10;

/* ── 单块容器 ───────────────────────────────────────── */
interface BlockProps {
  icon: React.ReactNode;
  title: string;
  count: number;
  emptyText: string;
  /** 列表上方的说明文字（如排序/交互提示） */
  caption?: string;
  children?: React.ReactNode;
}

function Block({ icon, title, count, emptyText, caption, children }: BlockProps): JSX.Element {
  const isEmpty = count === 0;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        {icon}
        <Typography sx={{ fontSize: 14, fontWeight: 600, flex: '1 1 auto', minWidth: 0 }} noWrap>
          {title}
        </Typography>
        <Chip
          size="small"
          label={count}
          sx={{
            height: 22,
            fontWeight: 700,
            bgcolor: count ? 'primary.main' : 'action.hover',
            color: count ? '#fff' : 'text.disabled',
          }}
        />
      </Stack>
      <Divider sx={{ mb: 1.25 }} />
      {caption && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
          {caption}
        </Typography>
      )}
      {isEmpty ? (
        <Typography
          variant="body2"
          sx={{ color: 'text.disabled', fontSize: 13, py: 3, textAlign: 'center' }}
        >
          {emptyText}
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ maxHeight: 340, overflowY: 'auto', pr: 0.5 }}>
          {children}
        </Stack>
      )}
    </Box>
  );
}

/* ── 周报动态行 ─────────────────────────────────────── */
function ReportRow({ r, onOpen }: { r: WeeklyReportItem; onOpen: (r: WeeklyReportItem) => void }): JSX.Element {
  return (
    <Box
      onClick={() => onOpen(r)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen(r);
      }}
      sx={{
        p: 1.25,
        borderRadius: 1.5,
        border: '1px solid',
        cursor: 'pointer',
        borderColor: 'divider',
        '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
        <Typography sx={{ fontSize: 13, fontWeight: 600, minWidth: 0 }} noWrap>
          {r.projectName}
        </Typography>
        <Stack direction="row" spacing={0.5} alignItems="center">
          {r.status === '已提交' && (
            <Chip
              size="small"
              label="待确认"
              sx={{ height: 20, fontSize: 11, bgcolor: 'warning.main', color: '#fff', fontWeight: 700 }}
            />
          )}
          <StatusChip status={r.status} />
        </Stack>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.25, display: 'block' }}>
        {r.authorName || '—'}
        {r.submittedAt ? ` · 提交 ${fmtShort(r.submittedAt)}` : ` · 更新 ${fmtShort(r.updatedAt)}`}
      </Typography>
      {r.summary && (
        <Typography
          variant="body2"
          sx={{
            mt: 0.5,
            fontSize: 13,
            color: 'text.secondary',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {r.summary}
        </Typography>
      )}
      {/* D02：周报勾选的任务进度明细（before → after） */}
      {(r.taskRows ?? []).length > 0 && (
        <Stack spacing={0.5} sx={{ mt: 1 }}>
          {(r.taskRows ?? []).slice(0, 4).map((t, i) => (
            <Stack
              key={`${t.nodeCode}-${i}`}
              direction="row"
              spacing={0.75}
              alignItems="center"
              sx={{ bgcolor: 'action.hover', borderRadius: 1, px: 1, py: 0.5 }}
            >
              <Typography
                sx={{ fontSize: 11, color: 'text.secondary', fontFamily: 'monospace', flexShrink: 0 }}
              >
                {t.nodeCode}
              </Typography>
              <Typography sx={{ fontSize: 12, minWidth: 0, flex: 1 }} noWrap>
                {t.nodeName}
              </Typography>
              <Typography sx={{ fontSize: 12, fontWeight: 700, flexShrink: 0, color: 'primary.main' }}>
                {t.progressBefore}% → {t.progressAfter}%
              </Typography>
            </Stack>
          ))}
          {(r.taskRows ?? []).length > 4 && (
            <Typography variant="caption" color="text.disabled" sx={{ pl: 0.5 }}>
              等 {(r.taskRows ?? []).length} 项任务进度
            </Typography>
          )}
        </Stack>
      )}
      <Typography variant="caption" color="primary.main" sx={{ display: 'block', mt: 0.75 }}>
        点击查看完整周报
      </Typography>
    </Box>
  );
}

/* ── 上周任务进展行 ─────────────────────────────────── */
function TaskRow({ t }: { t: TaskUpdatedItem }): JSX.Element {
  const navigate = useNavigate();
  return (
    <Box
      onClick={() => navigate(ROUTES.projectWbs(t.projectId))}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') navigate(ROUTES.projectWbs(t.projectId));
      }}
      sx={{
        p: 1.25,
        borderRadius: 1.5,
        border: '1px solid',
        cursor: 'pointer',
        // 完成态：绿框 + 左侧绿色强调条，未完成为默认分隔线（占位保持对齐）
        borderColor: t.done ? 'success.main' : 'divider',
        borderLeft: '3px solid',
        borderLeftColor: t.done ? 'success.main' : 'transparent',
        '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography
            sx={{ fontSize: 12, color: 'text.secondary', fontFamily: 'monospace' }}
          >
            {t.wbsCode}
          </Typography>
          <Typography sx={{ fontSize: 13, fontWeight: 600, minWidth: 0 }} noWrap>
            {t.name}
          </Typography>
        </Stack>
        <StatusChip status={t.status} />
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
        <Typography
          variant="caption"
          sx={{ color: 'text.secondary', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {t.projectName}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 0 }}>
          {t.ownerName || '未分配'}
        </Typography>
        <Typography variant="caption" sx={{ fontWeight: 700, flexShrink: 0 }}>
          {t.progress}%
        </Typography>
      </Stack>
      <Typography variant="caption" color="text.disabled" sx={{ mt: 0.25, display: 'block' }}>
        更新于 {fmtShort(t.updatedAt)}
      </Typography>
    </Box>
  );
}

/* ── 上周达成里程碑行 ───────────────────────────────── */
function MilestoneRow({ m }: { m: MilestoneAchievedItem }): JSX.Element {
  const navigate = useNavigate();
  return (
    <Box
      onClick={() => navigate(ROUTES.projectMilestones(m.projectId))}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') navigate(ROUTES.projectMilestones(m.projectId));
      }}
      sx={{
        p: 1.25,
        borderRadius: 1.5,
        border: '1px solid',
        cursor: 'pointer',
        borderColor: 'divider',
        borderLeft: '3px solid',
        borderLeftColor: 'warning.main',
        '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center">
        <EmojiEventsOutlinedIcon fontSize="small" sx={{ color: 'warning.main', flexShrink: 0 }} />
        <Typography sx={{ fontSize: 13, fontWeight: 600, minWidth: 0 }} noWrap>
          {m.name}
        </Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.25, display: 'block' }}>
        {m.projectName} · 达成 {fmtDate(m.doneAt)}
      </Typography>
    </Box>
  );
}

/* ── D03 任务进度环比行 ─────────────────────────────── */
function DeltaRow({ t }: { t: TaskDeltaItem }): JSX.Element {
  const up = t.delta > 0;
  const down = t.delta < 0;
  const accent = t.done ? 'success.main' : up ? 'primary.main' : down ? 'error.main' : 'transparent';
  return (
    <Box
      sx={{
        p: 1,
        borderRadius: 1,
        border: '1px solid',
        borderColor: t.done ? 'success.main' : 'divider',
        borderLeft: '3px solid',
        borderLeftColor: accent,
        bgcolor: down ? 'action.hover' : 'transparent',
      }}
    >
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: 11, color: 'text.secondary', fontFamily: 'monospace', flexShrink: 0 }}>
          {t.wbsCode}
        </Typography>
        <Typography sx={{ fontSize: 12.5, fontWeight: 600, minWidth: 0, flex: 1 }} noWrap>
          {t.name}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, display: { xs: 'none', sm: 'block' } }}>
          {t.projectName}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
          {t.added ? '—' : `${t.prevProgress}%`} → {t.progress}%
        </Typography>
        <Typography
          sx={{
            fontSize: 12,
            fontWeight: 700,
            flexShrink: 0,
            color: t.done ? 'success.main' : up ? 'primary.main' : down ? 'error.main' : 'text.secondary',
          }}
        >
          {t.added ? '新增' : `${up ? '+' : ''}${t.delta}%`}
        </Typography>
      </Stack>
    </Box>
  );
}

/* ── D03.1 周报完整详情弹窗（下钻） ─────────────────── */
function ReportDetailDialog({
  report,
  loading,
  open,
  projectName,
  onClose,
}: {
  report: Report | null;
  loading: boolean;
  open: boolean;
  projectName: string;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography sx={{ fontSize: 16, fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>
            {report ? `${report.week} 周报` : '周报详情'}
          </Typography>
          {report && <StatusChip status={report.status} />}
        </Stack>
        {report && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {projectName || ''} · {report.authorName || '—'}
            {report.submittedAt ? ` · 提交 ${fmtDateTime(report.submittedAt)}` : ''}
            {report.confirmedBy ? ` · 已确认` : ''}
          </Typography>
        )}
      </DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Stack alignItems="center" justifyContent="center" sx={{ py: 5 }}>
            <CircularProgress size={26} />
          </Stack>
        ) : !report ? (
          <Typography variant="body2" sx={{ color: 'text.disabled', py: 3, textAlign: 'center' }}>
            周报详情加载失败或已被删除，请刷新后重试
          </Typography>
        ) : (
          <Stack spacing={2}>
            <section>
              <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 0.5 }}>完成说明</Typography>
              <Typography variant="body2" sx={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
                {report.doneNote || '（未填写）'}
              </Typography>
            </section>
            <section>
              <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 0.5 }}>下周计划</Typography>
              {report.planItems.length ? (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {report.planItems.map((p, i) => (
                    <li key={i}>
                      <Typography variant="body2" sx={{ fontSize: 13 }}>
                        {p}
                      </Typography>
                    </li>
                  ))}
                </ul>
              ) : (
                <Typography variant="body2" sx={{ fontSize: 13, color: 'text.disabled' }}>
                  （未填写）
                </Typography>
              )}
            </section>
            <section>
              <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 0.5 }}>
                任务进度（{report.tasks.length}）
              </Typography>
              {report.tasks.length ? (
                <Stack spacing={0.5}>
                  {report.tasks.map((t) => (
                    <Stack
                      key={t.nodeId}
                      direction="row"
                      spacing={0.75}
                      alignItems="center"
                      sx={{ bgcolor: 'action.hover', borderRadius: 1, px: 1, py: 0.5 }}
                    >
                      <Typography sx={{ fontSize: 11, color: 'text.secondary', fontFamily: 'monospace', flexShrink: 0 }}>
                        {t.nodeCode}
                      </Typography>
                      <Typography sx={{ fontSize: 12, minWidth: 0, flex: 1 }} noWrap>
                        {t.nodeName}
                      </Typography>
                      {t.selected && (
                        <Chip size="small" label="汇报项" sx={{ height: 18, fontSize: 11, bgcolor: 'primary.main', color: '#fff' }} />
                      )}
                      <Typography sx={{ fontSize: 12, fontWeight: 700, flexShrink: 0, color: 'primary.main' }}>
                        {t.progressBefore}% → {t.progressAfter}%
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              ) : (
                <Typography variant="body2" sx={{ fontSize: 13, color: 'text.disabled' }}>
                  （未关联任务）
                </Typography>
              )}
            </section>
            <section>
              <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 0.5 }}>
                风险与问题（{report.risks.length}）
              </Typography>
              {report.risks.length ? (
                <Stack spacing={0.5}>
                  {report.risks.map((rk) => (
                    <Box key={rk.id} sx={{ p: 1, borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
                      <Typography sx={{ fontSize: 13 }}>{rk.description}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                        责任人 {rk.owner || '—'} · 截止 {rk.dueDate ? fmtDate(rk.dueDate) : '—'}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              ) : (
                <Typography variant="body2" sx={{ fontSize: 13, color: 'text.disabled' }}>
                  （无）
                </Typography>
              )}
            </section>
            <section>
              <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 0.5 }}>需要协调的资源</Typography>
              <Typography variant="body2" sx={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
                {report.resourceNote || '（无）'}
              </Typography>
            </section>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  );
}

/* ── 主组件 ─────────────────────────────────────────── */
export function WeeklyProgressPanel({ data, loading }: WeeklyProgressPanelProps): JSX.Element {
  const navigate = useNavigate();

  /* D03.1 周报下钻：点击周报卡片 → 拉完整周报弹窗展示 */
  const [detailItem, setDetailItem] = useState<WeeklyReportItem | null>(null);
  const [detailReport, setDetailReport] = useState<Report | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const openReportDetail = async (r: WeeklyReportItem): Promise<void> => {
    setDetailItem(r);
    setDetailReport(null);
    setDetailLoading(true);
    try {
      const list = await api.listReports(r.projectId);
      const found = list.find((x) => x.id === r.id) ?? null;
      setDetailReport(found);
    } catch {
      setDetailReport(null);
    } finally {
      setDetailLoading(false);
    }
  };

  if (loading && !data) {
    return (
      <SectionCard title="上周工作进展" sx={{ mb: 2 }}>
        <Stack alignItems="center" justifyContent="center" sx={{ py: 6 }}>
          <CircularProgress size={28} />
        </Stack>
      </SectionCard>
    );
  }

  /* 副标题恒显示「上周」（上一自然 ISO 周），与后端 computeWeeklyProgress 口径一致 */
  const weekLabel = (() => {
    const code = data ? data.week : shiftWeek(weekCode(), -1);
    const { start, end } = weekRange(code);
    return `上周（${code} · ${fmtDate(start)} ~ ${fmtDate(end)}）`;
  })();

  const reports = data?.reports ?? [];
  const tasks = data?.tasks ?? [];
  const milestones = data?.milestones ?? [];
  const missing = data?.missing ?? [];
  const allEmpty = reports.length === 0 && tasks.length === 0 && milestones.length === 0;

  return (
    <SectionCard title="上周工作进展" subtitle={weekLabel} sx={{ mb: 2 }}>
      {/* D02：上周未提交周报的进行中项目警示（项目名可点击 → 项目周报页补交） */}
      {missing.length > 0 && (
        <Box
          sx={{
            mb: 2,
            p: 1.25,
            borderRadius: 1.5,
            border: '1px solid',
            borderColor: 'warning.main',
          }}
        >
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <ReportProblemOutlinedIcon fontSize="small" sx={{ color: 'warning.main', mt: 0.25, flexShrink: 0 }} />
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontSize: 13, fontWeight: 600, color: 'warning.main' }}>
                上周有 {missing.length} 个项目未提交周报
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.75 }}>
                {missing.slice(0, 8).map((m) => (
                  <Chip
                    key={m.projectId}
                    size="small"
                    variant="outlined"
                    label={m.projectName}
                    onClick={() => navigate(ROUTES.projectReports(m.projectId))}
                    sx={{ height: 22, fontSize: 12, cursor: 'pointer', borderColor: 'warning.main', '&:hover': { bgcolor: 'action.hover' } }}
                  />
                ))}
                {missing.length > 8 && (
                  <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                    等 {missing.length} 个
                  </Typography>
                )}
              </Stack>
              <Typography variant="body2" sx={{ fontSize: 12, color: 'text.secondary', mt: 0.75 }}>
                点击项目名进入该项目的周报页补交
              </Typography>
            </Box>
          </Stack>
        </Box>
      )}
      {/* D03：任务进度环比（上周 vs 前周全量快照，周报提交时采集） */}
      {data?.delta && (
        <Box sx={{ mb: 2, p: 1.25, borderRadius: 1.5, border: '1px solid', borderColor: 'divider' }}>
          <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
            <TrendingUpOutlinedIcon fontSize="small" sx={{ color: 'primary.main' }} />
            <Typography sx={{ fontSize: 14, fontWeight: 600 }}>任务进度环比</Typography>
            <Typography variant="caption" color="text.secondary">
              {fmtDate(weekRange(data.delta.prevWeek).start)} ~ {fmtDate(weekRange(data.delta.prevWeek).end)} → 上周
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Tooltip title="上周快照中进度较前周上升的任务数">
              <Chip size="small" label={`推进 ${data.delta.advancedCount}`} sx={{ height: 22, fontWeight: 600, bgcolor: 'primary.main', color: '#fff' }} />
            </Tooltip>
            <Tooltip title="上周快照中已完成（进度 100%）的任务数">
              <Chip size="small" label={`完成 ${data.delta.completedCount}`} sx={{ height: 22, fontWeight: 600, bgcolor: 'success.main', color: '#fff' }} />
            </Tooltip>
            <Tooltip title="前周快照不存在、上周才出现的任务数">
              <Chip size="small" label={`新增 ${data.delta.addedCount}`} sx={{ height: 22, fontWeight: 600, bgcolor: 'warning.main', color: '#fff' }} />
            </Tooltip>
            <Tooltip title={`所有推进任务的进度增量之和（百分点）：上周快照进度合计 − 前周快照进度合计`}>
              <Chip size="small" label={`净增 ${data.delta.netPoints} 个百分点`} variant="outlined" sx={{ height: 22, fontWeight: 700 }} />
            </Tooltip>
            {data.milestoneCompare && (
              <Tooltip title="里程碑达成数按完成日期（done_at）所在周统计">
                <Chip
                  size="small"
                  label={`里程碑达成：前周 ${data.milestoneCompare.prevDone} → 上周 ${data.milestoneCompare.lastDone}`}
                  variant="outlined"
                  sx={{ height: 22, fontWeight: 600, color: 'warning.main', borderColor: 'warning.main' }}
                />
              </Tooltip>
            )}
          </Stack>
          {data.delta.tasks.length === 0 ? (
            <Typography variant="body2" sx={{ color: 'text.disabled', py: 1.5, textAlign: 'center', fontSize: 13 }}>
              暂无环比数据——快照自本周起积累：项目每周提交周报时自动记录全量任务进度，
              需连续两周提交后展示「上周 vs 前周」的进展变化
            </Typography>
          ) : (
            <Stack spacing={1}>
              {data.delta.tasks.slice(0, MAX_ITEMS).map((t) => (
                <DeltaRow key={t.nodeId} t={t} />
              ))}
              {data.delta.tasks.length > MAX_ITEMS && (
                <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                  共 {data.delta.tasks.length} 条变化，仅显示前 {MAX_ITEMS} 条
                </Typography>
              )}
            </Stack>
          )}
        </Box>
      )}
      {allEmpty ? (
        <Typography variant="body2" sx={{ color: 'text.disabled', py: 2, textAlign: 'center' }}>
          上周暂无周报提交、任务更新或里程碑达成记录
        </Typography>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gap: 2.5,
            gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' },
          }}
        >
          <Block
            icon={<DescriptionOutlinedIcon fontSize="small" sx={{ color: 'primary.main' }} />}
            title="周报动态"
            count={reports.length}
            emptyText="上周暂无周报"
            caption="按提交时间倒序 · 点击卡片查看完整周报"
          >
            {reports.slice(0, MAX_ITEMS).map((r) => (
              <ReportRow key={r.id} r={r} onOpen={openReportDetail} />
            ))}
            {reports.length > MAX_ITEMS && (
              <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                共 {reports.length} 条，仅显示前 {MAX_ITEMS} 条
              </Typography>
            )}
          </Block>

          <Block
            icon={<PlaylistAddCheckOutlinedIcon fontSize="small" sx={{ color: 'primary.main' }} />}
            title="上周任务进展"
            count={tasks.length}
            emptyText="上周暂无任务更新"
            caption="按任务最后更新时间（物理时间）落在上周统计"
          >
            {tasks.slice(0, MAX_ITEMS).map((t) => (
              <TaskRow key={t.id} t={t} />
            ))}
            {tasks.length > MAX_ITEMS && (
              <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                共 {tasks.length} 条，仅显示前 {MAX_ITEMS} 条
              </Typography>
            )}
          </Block>

          <Block
            icon={<EmojiEventsOutlinedIcon fontSize="small" sx={{ color: 'warning.main' }} />}
            title="上周达成里程碑"
            count={milestones.length}
            emptyText="上周暂无里程碑达成"
          >
            {milestones.slice(0, MAX_ITEMS).map((m) => (
              <MilestoneRow key={m.id} m={m} />
            ))}
            {milestones.length > MAX_ITEMS && (
              <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                共 {milestones.length} 条，仅显示前 {MAX_ITEMS} 条
              </Typography>
            )}
          </Block>
        </Box>
      )}
      {/* D03.1：周报完整详情弹窗（点击周报卡片下钻） */}
      <ReportDetailDialog
        report={detailReport}
        loading={detailLoading}
        open={detailItem !== null}
        projectName={detailItem?.projectName ?? ''}
        onClose={() => setDetailItem(null)}
      />
    </SectionCard>
  );
}
