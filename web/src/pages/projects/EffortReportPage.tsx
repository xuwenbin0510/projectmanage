import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Chip,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import { useParams } from 'react-router-dom';

import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  ProgressBar,
  SectionCard,
} from '@/components/common';
import type { EffortReport, EffortReportRow } from '@/types/effort';
import { api } from '@/api/client';
import { alphaOf, tokens, toneColor } from '@/theme/tokens';
import { fmtDays } from '@/utils/format';
import { fmtDateTime } from '@/utils/date';

/** 可排序列（同层排序，父子层级恒保持；diffRate=null 恒置组内末尾，D-B9-4） */
type SortKey = 'estimateDays' | 'effortHours' | 'diff' | 'diffRate' | 'progress';

interface SortState {
  key: SortKey;
  order: 'asc' | 'desc';
}

/** 汇总卡片（品牌青左侧竖条装饰，参考 ReportsPage SectionTitle 范式） */
function SummaryCard(props: {
  label: string;
  value: string;
  unit?: string;
  tone: 'brand' | 'success' | 'warning' | 'danger' | 'neutral';
  highlight?: boolean;
}): JSX.Element {
  const color = toneColor[props.tone];
  return (
    <Box
      sx={{
        position: 'relative',
        flex: '1 1 168px',
        minWidth: 152,
        p: 1.75,
        borderRadius: 1.5,
        border: `1px solid ${tokens.border.subtle}`,
        bgcolor: tokens.bg.card,
        overflow: 'hidden',
        boxShadow: props.highlight ? `0 0 0 1px ${alphaOf(tokens.status.danger, 0.4)}` : 'none',
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          bgcolor: props.tone === 'brand' ? tokens.brand.accent : color,
        }}
      />
      <Typography variant="caption" color="text.secondary">
        {props.label}
      </Typography>
      <Stack direction="row" alignItems="baseline" spacing={0.5} sx={{ mt: 0.5 }}>
        <Typography sx={{ fontSize: 26, fontWeight: 600, lineHeight: 1.15, color }}>{props.value}</Typography>
        {props.unit && (
          <Typography variant="caption" color="text.secondary">
            {props.unit}
          </Typography>
        )}
      </Stack>
    </Box>
  );
}

/**
 * 工时统计报表（B9 · R1/R2/R3/R4）
 *
 * 数据：页面本地 state + `api.getEffortReport`（单页只读，一次请求，不加 store）。
 * 明细表：自建 MUI Table（不复用 DataTable，因其无树缩进/行展开）；flatten 树 pre-order +
 * depth 缩进；父行展开/折叠（默认全展开）、叶行展开「实际工时构成」（默认折叠）；
 * 表头点击同层排序（估算/实际/差值/偏差率/进度），diffRate=null 置底。
 * 差值/偏差率/汇总全部由服务端算好，前端只排序/展开/格式化（共享约定 B9-5）。
 * R7 导出 CSV / R8 跨项目报表 = 本期不做，页面不渲染导出入口。
 */
export function EffortReportPage(): JSX.Element {
  const { id = '' } = useParams();

  const [report, setReport] = useState<EffortReport | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState<number>(0);
  const [sort, setSort] = useState<SortState | null>(null);
  /** 折叠的父节点 id 集（空 = 全部展开，D-B9-3 补充3） */
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  /** 已展开「实际工时构成」的叶节点 id 集（默认折叠） */
  const [breakdownIds, setBreakdownIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getEffortReport(id)
      .then((r) => {
        if (alive) setReport(r);
      })
      .catch((e: unknown) => {
        if (alive) setError(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id, reloadKey]);

  const handleSort = (key: SortKey): void => {
    setSort((prev) => {
      if (prev && prev.key === key) return { key, order: prev.order === 'asc' ? 'desc' : 'asc' };
      return { key, order: 'asc' };
    });
  };

  const toggleCollapsed = (nodeId: string): void => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const toggleBreakdown = (nodeId: string): void => {
    setBreakdownIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  /* flatten 树（pre-order）+ 同层排序；折叠隐藏后代行；depth 用于缩进 */
  const visible = useMemo(() => {
    const depthOf = new Map<string, number>();
    const out: EffortReportRow[] = [];
    if (!report) return { rows: out, depthOf };
    const rows = report.rows;
    const childrenOf = new Map<string, EffortReportRow[]>();
    for (const r of rows) {
      const key = r.parentId ?? '__root__';
      const arr = childrenOf.get(key);
      if (arr) arr.push(r);
      else childrenOf.set(key, [r]);
    }
    const compare = (a: EffortReportRow, b: EffortReportRow): number => {
      if (!sort) return 0;
      const av = a[sort.key];
      const bv = b[sort.key];
      if (sort.key === 'diffRate') {
        const aNull = av === null;
        const bNull = bv === null;
        if (aNull && bNull) return 0;
        if (aNull) return 1; // diffRate=null 恒置组内末尾
        if (bNull) return -1;
      }
      const an = Number(av) || 0;
      const bn = Number(bv) || 0;
      if (an < bn) return sort.order === 'asc' ? -1 : 1;
      if (an > bn) return sort.order === 'asc' ? 1 : -1;
      return 0;
    };
    const flatten = (group: EffortReportRow[], depth: number, hidden: boolean): void => {
      const sorted = sort ? group.slice().sort(compare) : group;
      for (const r of sorted) {
        if (hidden) continue;
        depthOf.set(r.id, depth);
        out.push(r);
        const kids = childrenOf.get(r.id);
        if (kids && kids.length) flatten(kids, depth + 1, collapsedIds.has(r.id));
      }
    };
    flatten(childrenOf.get('__root__') ?? [], 0, false);
    return { rows: out, depthOf };
  }, [report, sort, collapsedIds]);

  const diffColorOf = (diff: number): string =>
    diff > 0 ? tokens.status.danger : diff < 0 ? tokens.status.success : 'text.secondary';

  if (loading && !report) return <LoadingState variant="skeleton" rows={5} height={52} />;
  if (error) return <ErrorState error={error} onRetry={() => { setError(null); setReloadKey((k) => k + 1); }} />;
  if (!report || report.rows.length === 0) {
    return (
      <Stack spacing={2.5}>
        <PageHeader title="工时报表" subtitle="估算（人日）vs 累计实际工时（人日）对比；超支任务高亮预警" />
        <SectionCard flush>
          <EmptyState title="暂无任务" description="该项目暂无 WBS 节点，可先到「WBS」页新建任务" />
        </SectionCard>
      </Stack>
    );
  }

  const { summary } = report;
  const hasChildrenOf = (r: EffortReportRow): boolean => r.effortChildCount > 0;
  const sortableHeader = (key: SortKey, label: string): JSX.Element => (
    <TableSortLabel
      active={sort?.key === key}
      direction={sort?.key === key ? sort.order : 'asc'}
      onClick={() => handleSort(key)}
    >
      {label}
    </TableSortLabel>
  );

  return (
    <Stack spacing={2.5}>
      <PageHeader
        title="工时报表"
        subtitle="估算（人日）vs 累计实际工时（人日）对比；超支任务高亮预警（R7 导出 / R8 跨项目报表本期不做）"
      />

      {/* 汇总卡片区（B9-R3）：Σ 叶子口径，服务端算好 */}
      <SectionCard title="汇总" subtitle="口径 = 全部叶子任务（容器父节点行仅作行级比较）">
        <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1.5}>
          <SummaryCard label="估算总和" value={summary.estimateTotal.toFixed(1)} unit="人日" tone="brand" />
          <SummaryCard label="实际总和" value={summary.actualTotal.toFixed(1)} unit="人日" tone="brand" />
          <SummaryCard
            label="差值（实际 − 估算）"
            value={`${summary.diff > 0 ? '+' : ''}${summary.diff.toFixed(1)}`}
            unit="人日"
            tone={summary.diff > 0 ? 'danger' : summary.diff < 0 ? 'success' : 'neutral'}
          />
          <SummaryCard
            label="偏差率"
            value={summary.diffRate === null ? '—' : `${(summary.diffRate * 100).toFixed(0)}%`}
            tone={summary.diffRate !== null && summary.diffRate > 0 ? 'danger' : summary.diffRate !== null && summary.diffRate < 0 ? 'success' : 'brand'}
          />
          <SummaryCard
            label="超支任务数"
            value={`${summary.overrunCount}`}
            unit={`/ ${summary.leafCount} 个叶子`}
            tone={summary.overrunCount > 0 ? 'danger' : 'brand'}
            highlight={summary.overrunCount > 0}
          />
        </Stack>
      </SectionCard>

      {/* 明细表格区（B9-R2/R4）：树序缩进 + 同层排序 + 超支高亮 + 行展开构成 */}
      <SectionCard
        flush
        title="估算 vs 实际明细"
        subtitle={`共 ${report.rows.length} 行（父 ${summary.parentCount} / 叶 ${summary.leafCount}）· 点击表头同层排序 · 父行折叠/展开 · 任务行展开看实际工时构成`}
      >
        <TableContainer>
          <Table size="small" sx={{ minWidth: 900 }}>
            <TableHead>
              <TableRow sx={{ '& th': { borderBottom: `1px solid ${tokens.border.subtle}`, whiteSpace: 'nowrap' } }}>
                <TableCell sx={{ pl: 2 }}>节点</TableCell>
                <TableCell>里程碑</TableCell>
                <TableCell>负责人</TableCell>
                <TableCell align="right">{sortableHeader('estimateDays', '估算人日')}</TableCell>
                <TableCell align="right">{sortableHeader('effortHours', '累计实际工时')}</TableCell>
                <TableCell align="right">{sortableHeader('diff', '差值')}</TableCell>
                <TableCell align="right">{sortableHeader('diffRate', '偏差率')}</TableCell>
                <TableCell align="right">{sortableHeader('progress', '进度')}</TableCell>
                <TableCell align="right" sx={{ pr: 2 }}>展开</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.rows.flatMap((r) => {
                const depth = visible.depthOf.get(r.id) ?? 0;
                const hasChildren = hasChildrenOf(r);
                const collapsed = collapsedIds.has(r.id);
                const bdOpen = breakdownIds.has(r.id);
                const bdItems = report.effortBreakdown[r.id] ?? [];
                const subtotal = bdItems.reduce((s, it) => s + it.weekActualDays, 0);
                const bdMismatch = Math.abs(subtotal - r.effortHours) > 0.01;
                const diffColor = diffColorOf(r.diff);
                return [
                  <TableRow
                    key={r.id}
                    hover
                    sx={{
                      bgcolor: r.isOverrun ? alphaOf(tokens.status.danger, 0.06) : 'inherit',
                      '& td': { borderBottom: `1px solid ${tokens.border.subtle}` },
                    }}
                  >
                    <TableCell sx={{ pl: 1, py: 0.75 }}>
                      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ pl: `${8 + depth * 18}px`, minWidth: 0 }}>
                        {hasChildren ? (
                          <IconButton size="small" sx={{ p: 0.25, flexShrink: 0 }} onClick={() => toggleCollapsed(r.id)}>
                            {collapsed ? <ChevronRightIcon sx={{ fontSize: 16 }} /> : <ExpandMoreIcon sx={{ fontSize: 16 }} />}
                          </IconButton>
                        ) : (
                          <IconButton size="small" sx={{ p: 0.25, flexShrink: 0 }} onClick={() => toggleBreakdown(r.id)}>
                            {bdOpen ? <ExpandMoreIcon sx={{ fontSize: 16 }} /> : <ChevronRightIcon sx={{ fontSize: 16 }} />}
                          </IconButton>
                        )}
                        <Typography variant="caption" color="text.secondary" sx={{ width: 40, flexShrink: 0 }}>
                          {r.wbsCode}
                        </Typography>
                        <Typography
                          sx={{ fontSize: 14, fontWeight: r.isLeaf ? 400 : 600, minWidth: 0 }}
                          noWrap
                        >
                          {r.name}
                        </Typography>
                        {hasChildren && (
                          <Chip size="small" variant="outlined" label={`Σ ${r.effortChildCount}`} sx={{ height: 18, flexShrink: 0 }} />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {r.milestoneCode ? (
                        <Chip
                          size="small"
                          variant="outlined"
                          icon={<FlagOutlinedIcon sx={{ fontSize: 13 }} />}
                          label={`${r.milestoneCode} ${r.milestoneName}`}
                          sx={{ height: 20, maxWidth: 200 }}
                        />
                      ) : (
                        <Typography variant="caption" color="text.secondary">
                          —
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">{r.ownerName || '—'}</Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="caption">{fmtDays(r.estimateDays)}</Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="caption" sx={{ fontWeight: 600 }}>
                        {fmtDays(r.effortHours)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end" alignItems="center">
                        <Typography variant="caption" sx={{ color: diffColor }}>
                          {fmtDays(r.diff)}
                        </Typography>
                        {r.isOverrun && <Chip size="small" color="error" label="超支" sx={{ height: 18, fontSize: 11 }} />}
                      </Stack>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="caption" sx={{ color: r.diffRate === null ? 'text.secondary' : diffColorOf(r.diff) }}>
                        {r.diffRate === null ? '—' : `${(r.diffRate * 100).toFixed(0)}%`}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.75} alignItems="center" justifyContent="flex-end" sx={{ minWidth: 104 }}>
                        <Box sx={{ width: 64 }}>
                          <ProgressBar value={r.progress} height={5} showLabel={false} />
                        </Box>
                        <Typography variant="caption" color="text.secondary" sx={{ width: 34, textAlign: 'right' }}>
                          {r.progress}%
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="caption" color="text.secondary">
                        {hasChildren ? (collapsed ? '展开' : '收起') : bdOpen ? '收起' : '构成'}
                      </Typography>
                    </TableCell>
                  </TableRow>,
                  ...(bdOpen && !hasChildren
                    ? [
                        <TableRow key={`${r.id}-bd`}>
                          <TableCell colSpan={9} sx={{ py: 1, pl: `${8 + (depth + 1) * 18}px`, pr: 2, bgcolor: alphaOf(tokens.text.secondary, 0.03) }}>
                            {bdItems.length === 0 ? (
                              <Typography variant="caption" color="text.secondary">
                                暂无周报贡献
                              </Typography>
                            ) : (
                              <Stack spacing={0.75}>
                                <Box sx={{ border: `1px solid ${tokens.border.subtle}`, borderRadius: 1, overflow: 'hidden' }}>
                                  {bdItems.map((it, i) => (
                                    <Stack
                                      key={`${it.week}-${i}`}
                                      direction="row"
                                      spacing={2}
                                      sx={{
                                        px: 1.5,
                                        py: 0.5,
                                        borderBottom: i < bdItems.length - 1 ? `1px solid ${tokens.border.subtle}` : 'none',
                                      }}
                                    >
                                      <Typography variant="caption" sx={{ width: 92, flexShrink: 0 }}>
                                        {it.week}
                                      </Typography>
                                      <Typography variant="caption" sx={{ width: 92, flexShrink: 0 }}>
                                        {it.reporterName}
                                      </Typography>
                                      <Typography variant="caption" color="text.secondary" sx={{ width: 150, flexShrink: 0 }}>
                                        {it.submittedAt ? fmtDateTime(it.submittedAt) : '—'}
                                      </Typography>
                                      <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                        {fmtDays(it.weekActualDays)}
                                      </Typography>
                                    </Stack>
                                  ))}
                                </Box>
                                <Stack direction="row" spacing={1} alignItems="center">
                                  <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                    小计：{fmtDays(subtotal)}
                                  </Typography>
                                  {bdMismatch ? (
                                    <Chip
                                      size="small"
                                      color="warning"
                                      label={`与累计实际 ${fmtDays(r.effortHours)} 不一致（数据异常）`}
                                      sx={{ height: 18, fontSize: 11 }}
                                    />
                                  ) : (
                                    <Typography variant="caption" color="text.secondary">
                                      = 累计实际工时 {fmtDays(r.effortHours)}
                                    </Typography>
                                  )}
                                </Stack>
                              </Stack>
                            )}
                          </TableCell>
                        </TableRow>,
                      ]
                    : []),
                ];
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </SectionCard>
    </Stack>
  );
}
