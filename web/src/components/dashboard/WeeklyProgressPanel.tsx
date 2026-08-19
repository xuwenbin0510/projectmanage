/**
 * 上周工作进展面板（D01/D02 · 全局总览）
 *
 * 挂载在全局总览（/metrics）图表区之后、项目明细表之前，突出**上周**（上一自然 ISO 周）的项目动态：
 *  ① 周报动态   —— 范围内项目上周（week=上周周码）的周报（含草稿），D02 起展开勾选任务进度明细（before→after）
 *  ② 上周任务进展 —— 上周 updated_at 落在上周区间内的叶子任务（进度更新 + 已完成均列，完成高亮；点击跳项目 WBS）
 *  ③ 上周达成里程碑 —— 上周 done_at 落在区间内的里程碑（点击跳项目里程碑页）
 * 顶部警示条：D02 上周未提交周报的进行中项目（周例会跟进补交）。
 *
 * 周一开周例会回顾「上周主要进展」：周报表按周码存储，week=上周周码天然匹配。
 * 数据源 `WeeklyProgress` 由 `GET /api/dashboard/overview` 的 `weeklyProgress` 字段一次性返回，
 * 与全局总览同源同范围（scope / 筛选 / 决策 ⑥ 已在服务端算好）。
 *
 * @prd D01 / D02
 */

import { Box, Chip, CircularProgress, Divider, Stack, Typography } from '@mui/material';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import PlaylistAddCheckOutlinedIcon from '@mui/icons-material/PlaylistAddCheckOutlined';
import EmojiEventsOutlinedIcon from '@mui/icons-material/EmojiEventsOutlined';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import { useNavigate } from 'react-router-dom';
import { SectionCard, StatusChip } from '@/components/common';
import { ROUTES } from '@/config/routes';
import { fmtDate, fmtShort, shiftWeek, weekCode, weekRange } from '@/utils/date';
import type {
  MilestoneAchievedItem,
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
  children?: React.ReactNode;
}

function Block({ icon, title, count, emptyText, children }: BlockProps): JSX.Element {
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
function ReportRow({ r }: { r: WeeklyReportItem }): JSX.Element {
  return (
    <Box sx={{ p: 1.25, borderRadius: 1.5, border: '1px solid', borderColor: 'divider' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
        <Typography sx={{ fontSize: 13, fontWeight: 600, minWidth: 0 }} noWrap>
          {r.projectName}
        </Typography>
        <StatusChip status={r.status} />
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

/* ── 主组件 ─────────────────────────────────────────── */
export function WeeklyProgressPanel({ data, loading }: WeeklyProgressPanelProps): JSX.Element {
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
      {/* D02：上周未提交周报的进行中项目警示（周例会跟进补交） */}
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
            <Box>
              <Typography sx={{ fontSize: 13, fontWeight: 600, color: 'warning.main' }}>
                上周有 {missing.length} 个项目未提交周报
              </Typography>
              <Typography variant="body2" sx={{ fontSize: 13, color: 'text.secondary', mt: 0.25 }}>
                {missing.slice(0, 3).map((m) => m.projectName).join('、')}
                {missing.length > 3 ? ` 等 ${missing.length} 个` : ''} —— 建议周例会跟进补交
              </Typography>
            </Box>
          </Stack>
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
          >
            {reports.slice(0, MAX_ITEMS).map((r) => (
              <ReportRow key={r.id} r={r} />
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
    </SectionCard>
  );
}
