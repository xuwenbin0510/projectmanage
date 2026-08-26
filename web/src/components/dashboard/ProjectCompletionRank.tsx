/**
 * 项目完成率排行（全局总览·「项目健康」面板）
 * 以「棒棒糖图（lollipop / dot plot）」呈现：每行显式名次 01–N，降序（完成率最高排 #1），
 * 末三名（最落后）红字标注。细杆 + 圆点定位完成率，比粗条更精致；所有列固定宽度，跨行严格对齐。
 * 复用 projectTaskStats（含 completionRate/total/done/overdue），零额外请求。
 */
import { Box, Typography, CircularProgress } from '@mui/material';
import type { ProjectTaskStat } from '@/types/dashboard';

export interface ProjectCompletionRankProps {
  items: ProjectTaskStat[];
  loading?: boolean;
  onSelect?: (projectId: string) => void;
}

export function ProjectCompletionRank({ items, loading = false, onSelect }: ProjectCompletionRankProps): JSX.Element {
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 120 }}>
        <CircularProgress size={26} />
      </Box>
    );
  }
  const data = (items ?? [])
    .filter((it) => it.total > 0)
    .slice()
    .sort((a, b) => {
      if (a.completionRate !== b.completionRate) return b.completionRate - a.completionRate; // 降序：最高 #1
      if (a.overdue !== b.overdue) return b.overdue - a.overdue;
      return b.total - a.total;
    });
  if (data.length === 0) {
    return (
      <Box sx={{ py: 2 }}>
        <Typography variant="body2" color="text.secondary">
          暂无任务数据
        </Typography>
      </Box>
    );
  }

  const maxRank = data.length;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      {data.map((it, idx) => {
        const pct = Math.max(0, Math.min(100, it.completionRate));
        const low = pct < 25;
        const accent = low ? '#D64550' : '#6DA8AE';
        const bottomThree = idx >= maxRank - 3; // 最落后三名
        return (
          <Box
            key={it.projectId}
            title={`${it.projectName} · 完成率${it.completionRate}% · 任务${it.total} · 完成${it.done} · 逾期${it.overdue}`}
            onClick={() => onSelect && onSelect(it.projectId)}
            sx={{
              display: 'grid',
              gridTemplateColumns: '34px minmax(120px, 2.2fr) 2.4fr 116px',
              alignItems: 'center',
              gap: 1,
              px: 0.5,
              py: 0.5,
              cursor: onSelect ? 'pointer' : 'default',
              borderBottom: '1px solid rgba(10,14,18,.05)',
              background: bottomThree ? 'rgba(214,69,80,.05)' : 'transparent',
              transition: 'background .12s',
              '&:hover': onSelect ? { background: 'rgba(109,168,174,.10)' } : {},
            }}
          >
            {/* 名次序号 */}
            <Typography
              variant="body2"
              sx={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontWeight: 800,
                fontSize: '0.92rem',
                textAlign: 'right',
                pr: 0.5,
                color: bottomThree ? '#D64550' : 'text.secondary',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {String(idx + 1).padStart(2, '0')}
            </Typography>
            {/* 项目名 */}
            <Typography
              variant="body2"
              sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={it.projectName}
            >
              {it.projectName}
            </Typography>
            {/* 棒棒糖图：细杆 + 圆点定位完成率 */}
            <Box sx={{ position: 'relative', height: 14, display: 'flex', alignItems: 'center' }}>
              {/* 轨道 */}
              <Box sx={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 2, transform: 'translateY(-50%)', background: 'rgba(109,168,174,.16)', borderRadius: 2 }} />
              {/* 已完成的杆 */}
              <Box sx={{ position: 'absolute', left: 0, top: '50%', height: 3, width: `${pct}%`, transform: 'translateY(-50%)', background: accent, borderRadius: 2 }} />
              {/* 圆点 */}
              <Box
                sx={{
                  position: 'absolute',
                  left: `${pct}%`,
                  top: '50%',
                  width: 11,
                  height: 11,
                  transform: 'translate(-50%, -50%)',
                  borderRadius: '50%',
                  background: accent,
                  boxShadow: '0 0 0 2px #fff, 0 1px 2px rgba(0,0,0,.18)',
                }}
              />
            </Box>
            {/* 数值区（固定宽度，保证对齐） */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, justifyContent: 'flex-end' }}>
              <Typography
                variant="body2"
                sx={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: accent, minWidth: 38, textAlign: 'right' }}
              >
                {pct}%
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ minWidth: 42, textAlign: 'right' }}>
                {it.total}任务
              </Typography>
              {it.overdue > 0 ? (
                <Box
                  sx={{
                    minWidth: 14,
                    height: 14,
                    px: 0.4,
                    borderRadius: 2,
                    background: '#D64550',
                    color: '#fff',
                    fontSize: 9,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {it.overdue}
                </Box>
              ) : (
                <Box sx={{ minWidth: 14 }} />
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
