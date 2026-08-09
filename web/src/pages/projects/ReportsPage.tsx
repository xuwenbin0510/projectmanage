import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Stack,
  TableSortLabel,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useLocation, useParams } from 'react-router-dom';

import {
  DataTable,
  EmptyState,
  FormDialog,
  LoadingState,
  PageHeader,
  PermissionButton,
  SectionCard,
  StatusChip,
  UserAvatar,
} from '@/components/common';
import type { Column } from '@/components/common';
import { ReportFormModal } from '@/components/report/ReportFormModal';
import type { Report } from '@/types/report';
import { useProjectStore } from '@/stores/projectStore';
import { useWbsStore } from '@/stores/wbsStore';
import { useFlowStore } from '@/stores/flowStore';
import { useToast } from '@/hooks';
import { REPORT_SECTION_TITLE } from '@/config/enums';
import { fmtDateTime } from '@/utils/date';
import { memberNameOf } from '@/utils/member';
import { tokens } from '@/theme/tokens';

/**
 * 结构化周报：① 完成 ② 计划 ③ 风险 ④ 协调资源（P0-08）
 * R4-P0-4：新建/编辑表单抽为共享组件 ReportFormModal（WBS 页内写日志 / 本页新建/编辑双入口复用）。
 * @prd P0-08
 */
export function ReportsPage(): JSX.Element {
  const { id = '' } = useParams();
  const location = useLocation();
  const toast = useToast();
  const project = useProjectStore((s) => s.current);
  const members = useProjectStore((s) => s.members);

  const reports = useFlowStore((s) => s.reports);
  const loading = useFlowStore((s) => s.loading);
  const fetchReports = useFlowStore((s) => s.fetchReports);

  const fetchWbs = useWbsStore((s) => s.fetchWbs);

  const [open, setOpen] = useState(false);
  /** 详情查看（用户反馈⑤：列表可查看完整内容） */
  const [detail, setDetail] = useState<Report | null>(null);
  /** 编辑中的周报（null = 新建） */
  const [editingReport, setEditingReport] = useState<Report | null>(null);
  /** R4-P0-4 接收端兼容：location.state 旧链接（WBS「写日志」跳转）→ lockNodeId */
  const [prefillLockNodeId, setPrefillLockNodeId] = useState<string | null>(null);
  /** R3-5 接收端：避免同一路由 state（prefillNodeId）重复触发新建弹窗 */
  const prefilledRef = useRef<boolean>(false);

  useEffect(() => {
    void fetchReports(id).catch((e: unknown) => toast.error(e));
    // R3-5 接收端：从 WBS「写日志」跳转过来时，location.state 携带 prefillNodeId（R4-P0-4 后仅兼容旧链接）
    const prefillNodeId = (location.state as { prefillNodeId?: string } | null)?.prefillNodeId;
    const wbsReady = project?.type ? fetchWbs(id, project.type) : Promise.resolve();
    void wbsReady.then(() => {
      if (prefillNodeId && !prefilledRef.current) {
        prefilledRef.current = true;
        openCreateWithPrefill(prefillNodeId);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const archived = project?.status === '已结项' || project?.status === '已终止';

  const openCreate = (): void => {
    setEditingReport(null);
    setPrefillLockNodeId(null);
    setOpen(true);
  };

  /** R3-5 接收端：旧链接预填 → 打开新建弹窗并锁定该任务 */
  const openCreateWithPrefill = (nodeId: string): void => {
    const latestNodes = useWbsStore.getState().nodes;
    if (!latestNodes.find((n) => n.id === nodeId)) {
      // 节点不存在（可能已被删除）→ 降级为普通新建
      openCreate();
      return;
    }
    setEditingReport(null);
    setPrefillLockNodeId(nodeId);
    setOpen(true);
  };

  /** 查看完整周报（用户反馈⑤：列表不再只是摘要） */
  const openDetail = (r: Report): void => {
    setDetail(r);
  };

  /** 编辑已有周报：表单预填由 ReportFormModal 内部完成，提交走 updateReport（原地更新） */
  const openEditReport = (r: Report): void => {
    setPrefillLockNodeId(null);
    setEditingReport(r);
    setOpen(true);
  };

  const handleModalClose = (): void => {
    setOpen(false);
    setEditingReport(null);
    setPrefillLockNodeId(null);
  };

  /** B5-R3：页面级排序状态（默认填报时间倒序；点击表头切换升/降，不改共享 DataTable） */
  const [sortState, setSortState] = useState<{ key: 'createdAt'; order: 'asc' | 'desc' }>({
    key: 'createdAt',
    order: 'desc',
  });

  const toggleSort = (): void => {
    setSortState((prev) => ({ key: 'createdAt', order: prev.order === 'desc' ? 'asc' : 'desc' }));
  };

  /** B5-R3：渲染前按排序状态对行排序（字符串比较，空值兜底排后） */
  const sortedReports = useMemo(() => {
    const rows = [...reports];
    rows.sort((a, b) => {
      const av = a.createdAt || '';
      const bv = b.createdAt || '';
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortState.order === 'desc' ? -cmp : cmp;
    });
    return rows;
  }, [reports, sortState]);

  const columns: Array<Column<Report>> = [
    { key: 'week', label: '周次', width: 110, render: (r) => <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{r.week}</Typography> },
    { key: 'status', label: '状态', width: 90, render: (r) => <StatusChip status={r.status} /> },
    { key: 'author', label: '填报人', width: 100, render: (r) => <Stack direction="row" spacing={0.75} alignItems="center"><UserAvatar name={r.authorName} size={22} /><Typography variant="caption">{r.authorName}</Typography></Stack> },
    { key: 'doneNote', label: '完成摘要', render: (r) => <Typography variant="caption" color="text.secondary" noWrap>{r.doneNote || '—'}</Typography> },
    {
      key: 'tasks',
      label: '关联任务',
      width: 90,
      align: 'center',
      // 关联任务数 = 实际勾选关联的任务（与勾选一致，用户反馈⑤）
      render: (r) => <Chip size="small" label={r.tasks.filter((t) => t.selected).length} sx={{ height: 20 }} />,
    },
    { key: 'risks', label: '风险项', width: 80, align: 'center', render: (r) => <Chip size="small" label={r.risks.length} color={r.risks.length ? 'warning' : 'default'} sx={{ height: 20 }} /> },
    /* B5-R3：新增「填报时间」列（createdAt，YYYY-MM-DD HH:mm，空值兜底 —，title 放完整时间） */
    {
      key: 'createdAt',
      label: '填报时间',
      width: 150,
      render: (r) => (
        <Typography variant="caption" color="text.secondary" title={r.createdAt || undefined} sx={{ whiteSpace: 'nowrap' }}>
          {fmtDateTime(r.createdAt)}
        </Typography>
      ),
    },
    { key: 'submittedAt', label: '提交时间', width: 150, render: (r) => <Typography variant="caption" color="text.secondary" title={r.submittedAt || undefined} sx={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.submittedAt)}</Typography> },
    {
      key: 'actions',
      label: '操作',
      width: 120,
      align: 'center',
      render: (r) => (
        <Stack direction="row" spacing={0.5} justifyContent="center">
          <Button size="small" onClick={() => openDetail(r)}>
            查看
          </Button>
          <Button size="small" color="primary" onClick={() => openEditReport(r)}>
            编辑
          </Button>
        </Stack>
      ),
    },
  ];

  /** B5-R4：详情分段标题（品牌青左侧竖条装饰 + 统一字号） */
  const SectionTitle = (props: { title: string; count?: number }): JSX.Element => (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.75 }}>
      <Box sx={{ width: 3, height: 14, borderRadius: 1, bgcolor: tokens.brand.accent, flexShrink: 0 }} />
      <Typography variant="subtitle2">
        {props.title}
        {props.count !== undefined ? `（${props.count}）` : ''}
      </Typography>
    </Stack>
  );

  return (
    <Stack spacing={2.5}>
      <PageHeader
        title="工作日志"
        subtitle="按周记录进展，可多次提交并连续跟踪每个任务进度；同周可提交多条"
        actions={
          <PermissionButton
            action="report:write"
            disabledReason={archived ? '项目已归档' : ''}
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            onClick={openCreate}
          >
            新建日志
          </PermissionButton>
        }
      />

      <SectionCard flush>
        {loading && reports.length === 0 ? (
          <LoadingState variant="skeleton" rows={4} height={48} />
        ) : reports.length === 0 ? (
          <EmptyState title="暂无工作日志" description="点击右上角「新建日志」记录本周进展" />
        ) : (
          <>
            {/* B5-R3：页面级排序控制（默认填报时间倒序，点击切换升/降 + 箭头） */}
            <Stack direction="row" alignItems="center" justifyContent="flex-end" sx={{ px: 2, pt: 1.25 }}>
              <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
                排序：
              </Typography>
              <TableSortLabel active direction={sortState.order} onClick={toggleSort} sx={{ fontSize: 13 }}>
                填报时间
              </TableSortLabel>
            </Stack>
            <DataTable<Report> columns={columns} rows={sortedReports} rowKey={(r) => r.id} />
          </>
        )}
      </SectionCard>

      {/* R4-P0-4：共享日志表单（新建提交后关闭，行为与现状一致；旧链接 prefill 走 lockNodeId 锁定） */}
      <ReportFormModal
        open={open}
        projectId={id}
        editingReport={editingReport}
        lockNodeId={prefillLockNodeId}
        keepOpenOnSubmit={false}
        onSubmitted={() => {
          // 提交后补拉 WBS 树保持最新（引擎回写父节点进度，D2）
          void fetchWbs(id, project?.type ?? 'A');
        }}
        onClose={handleModalClose}
      />

      {/* 详情查看：列表不再只是摘要（用户反馈⑤） */}
      <FormDialog
        open={Boolean(detail)}
        title={detail ? `工作日志详情 · ${detail.week}` : '工作日志详情'}
        submitText="关闭"
        maxWidth="md"
        onClose={() => setDetail(null)}
        onSubmit={() => setDetail(null)}
      >
        {detail && (
          <Stack spacing={1.5}>
            {/* B5-R4：顶部 meta 行 = 状态 Chip + 填报人 + 填报时间 + 提交时间（caption 次要色） */}
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap' }}>
              <StatusChip status={detail.status} />
              <Typography variant="caption" color="text.secondary">
                填报人：{detail.authorName}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                填报：{fmtDateTime(detail.createdAt)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                提交：{fmtDateTime(detail.submittedAt)}
              </Typography>
            </Stack>
            <Box>
              <SectionTitle title={REPORT_SECTION_TITLE.done} />
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                {detail.doneNote || '—'}
              </Typography>
            </Box>
            <Box>
              <SectionTitle title={REPORT_SECTION_TITLE.plan} />
              {detail.planItems.length ? (
                <Stack spacing={0.5}>
                  {detail.planItems.map((p, i) => (
                    <Typography key={i} variant="body2">
                      · {p}
                    </Typography>
                  ))}
                </Stack>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  —
                </Typography>
              )}
            </Box>
            <Box>
              <SectionTitle
                title="关联任务"
                count={detail.tasks.filter((t) => t.selected).length}
              />
              {detail.tasks.filter((t) => t.selected).length ? (
                <Stack spacing={0.75}>
                  {detail.tasks
                    .filter((t) => t.selected)
                    .map((t) => (
                      <Stack key={t.nodeId} direction="row" spacing={1} alignItems="center">
                        <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                          {t.nodeName}
                        </Typography>
                        <Chip size="small" label={`${t.progressBefore}% → ${t.progressAfter}%`} sx={{ height: 20 }} />
                      </Stack>
                    ))}
                </Stack>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  —
                </Typography>
              )}
            </Box>
            <Box>
              <SectionTitle title={REPORT_SECTION_TITLE.risks} />
              {detail.risks.length ? (
                <Stack spacing={1}>
                  {detail.risks.map((rk) => (
                    <Stack key={rk.id} direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                      <Typography variant="body2" sx={{ flex: '1 1 220px', minWidth: 0 }}>
                        · {rk.description}
                      </Typography>
                      <Chip size="small" variant="outlined" label={`责任人：${memberNameOf(members, rk.owner)}`} sx={{ height: 20 }} />
                      <Chip size="small" variant="outlined" label={`截止：${rk.dueDate}`} sx={{ height: 20 }} />
                    </Stack>
                  ))}
                </Stack>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  —
                </Typography>
              )}
            </Box>
            <Box>
              <SectionTitle title={REPORT_SECTION_TITLE.resource} />
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                {detail.resourceNote || '—'}
              </Typography>
            </Box>
          </Stack>
        )}
      </FormDialog>
    </Stack>
  );
}
