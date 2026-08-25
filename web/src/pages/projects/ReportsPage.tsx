import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import TaskAltOutlinedIcon from '@mui/icons-material/TaskAltOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
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
import { api, USE_MOCK } from '@/api/client';
import { REPORT_SECTION_TITLE, REJECT_REASON_MAX } from '@/config/enums';
import { fmtDateTime } from '@/utils/date';
import { csvDateStamp, downloadCsv, fetchCsv, toCsv } from '@/utils/csv';
import { memberNameOf } from '@/utils/member';
import { tokens } from '@/theme/tokens';

/** 导出列（与后端 server/services/export.service.js 口径一致）。 */
const REPORT_CSV_HEADERS = [
  '周报ID', '项目ID', '周次', '周开始', '周结束', '作者ID', '作者名', '状态',
  '完成说明', '资源说明', '任务数', '风险数', '确认人', '确认时间', '驳回原因', '提交时间', '创建时间',
];

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

  /** 导出周报 CSV（真实模式走服务端，mock 模式本地生成）。 */
  const handleExportReports = async (): Promise<void> => {
    try {
      let csv: string;
      if (USE_MOCK) {
        const rows = reports.map((r) => ({
          周报ID: r.id,
          项目ID: r.projectId,
          周次: r.week,
          周开始: r.weekStart,
          周结束: r.weekEnd,
          作者ID: r.author,
          作者名: r.authorName,
          状态: r.status,
          完成说明: r.doneNote,
          资源说明: r.resourceNote,
          任务数: Array.isArray(r.tasks) ? r.tasks.length : 0,
          风险数: Array.isArray(r.risks) ? r.risks.length : 0,
          确认人: r.confirmedBy || '',
          确认时间: r.confirmedAt || '',
          驳回原因: r.rejectReason || '',
          提交时间: r.submittedAt || '',
          创建时间: r.createdAt,
        }));
        csv = toCsv(REPORT_CSV_HEADERS, rows);
      } else {
        csv = await fetchCsv(`/export/projects/${id}/reports`);
      }
      downloadCsv(`project_reports_${id}_${csvDateStamp()}.csv`, csv);
      toast.success('周报已导出');
    } catch (e) {
      toast.error(e);
    }
  };

  const [open, setOpen] = useState(false);
  /** 详情查看（用户反馈⑤：列表可查看完整内容） */
  const [detail, setDetail] = useState<Report | null>(null);
  /** 编辑中的周报（null = 新建） */
  const [editingReport, setEditingReport] = useState<Report | null>(null);
  /** R4-P0-4 接收端兼容：location.state 旧链接（WBS「写日志」跳转）→ lockNodeId */
  const [prefillLockNodeId, setPrefillLockNodeId] = useState<string | null>(null);
  /** R3-5 接收端：避免同一路由 state（prefillNodeId）重复触发新建弹窗 */
  const prefilledRef = useRef<boolean>(false);

  /* ── B14-块2：周报轻量闭环（确认 / 打回）────────────────────────── */
  /**
   * 待「我」确认的周报 id 集合：来自 `listPendingConfirmation()`（服务端按
   * `resolveConfirmers` 权威判定过滤，**绝不**前端自行推断确认人）。
   * 该接口跨项目聚合，故本页用 `id` 集合与当前项目列表取交集即可。
   */
  const [confirmableIds, setConfirmableIds] = useState<Set<string>>(new Set());
  const [confirmableLoading, setConfirmableLoading] = useState<boolean>(false);
  /** 打回原因弹窗目标（null = 关闭） */
  const [rejectTarget, setRejectTarget] = useState<Report | null>(null);
  const [rejectReason, setRejectReason] = useState<string>('');
  /** 正在执行确认 / 打回动作的周报 id（禁重复点击） */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ el: HTMLElement; report: Report } | null>(null);
  const openMenu = (event: MouseEvent<HTMLElement>, report: Report): void => {
    setMenuAnchor({ el: event.currentTarget, report });
  };
  const closeMenu = (): void => setMenuAnchor(null);

  const reloadConfirmable = useCallback((): void => {
    setConfirmableLoading(true);
    void api
      .listPendingConfirmation()
      .then((list) => setConfirmableIds(new Set(list.map((p) => p.id))))
      .catch(() => setConfirmableIds(new Set()))
      .finally(() => setConfirmableLoading(false));
  }, []);

  useEffect(() => {
    void reloadConfirmable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadConfirmable]);

  /** 当前周报是否可被「我」确认（已提交 + 在服务端确认人集合内 + 项目未归档） */
  const isConfirmable = (r: Report): boolean =>
    !archived && r.status === '已提交' && confirmableIds.has(r.id);

  const handleConfirm = async (r: Report): Promise<void> => {
    setBusyId(r.id);
    try {
      await api.confirmReport(id, r.id);
      toast.success('已确认该周报');
      await Promise.all([fetchReports(id), Promise.resolve(reloadConfirmable())]);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusyId(null);
    }
  };

  const openReject = (r: Report): void => {
    setRejectReason('');
    setRejectTarget(r);
  };
  const closeReject = (): void => {
    setRejectReason('');
    setRejectTarget(null);
  };
  const handleReject = async (): Promise<void> => {
    if (!rejectTarget) return;
    const reason = rejectReason.trim();
    if (!reason) {
      toast.warning('请填写打回原因');
      return;
    }
    if (reason.length > REJECT_REASON_MAX) {
      toast.warning(`打回原因不超过 ${REJECT_REASON_MAX} 字`);
      return;
    }
    setBusyId(rejectTarget.id);
    try {
      await api.rejectReport(id, rejectTarget.id, reason);
      toast.success('已打回该周报');
      closeReject();
      await Promise.all([fetchReports(id), Promise.resolve(reloadConfirmable())]);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusyId(null);
    }
  };

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
    {
      key: 'status',
      label: '状态',
      width: 96,
      render: (r) => (
        <Stack direction="column" spacing={0.25} alignItems="flex-start">
          <StatusChip status={r.status} />
          {isConfirmable(r) && (
            <Chip size="small" label="待你确认" color="warning" sx={{ height: 18, fontSize: 11, fontWeight: 600 }} />
          )}
        </Stack>
      ),
    },
    { key: 'author', label: '填报人', width: 100, hideBelow: 'sm', render: (r) => <Stack direction="row" spacing={0.75} alignItems="center"><UserAvatar name={r.authorName} size={22} /><Typography variant="caption">{r.authorName}</Typography></Stack> },
    {
      key: 'doneNote',
      label: '完成摘要',
      render: (r) => (
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          title={r.doneNote || undefined}
          sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}
        >
          {r.doneNote || '—'}
        </Typography>
      ),
    },
    {
      key: 'tasks',
      label: '关联任务',
      width: 90,
      align: 'center',
      hideBelow: 'md',
      // 关联任务数 = 实际勾选关联的任务（与勾选一致，用户反馈⑤）
      render: (r) => <Chip size="small" label={r.tasks.filter((t) => t.selected).length} sx={{ height: 20 }} />,
    },
    { key: 'risks', label: '风险项', width: 80, align: 'center', hideBelow: 'md', render: (r) => <Chip size="small" label={r.risks.length} color={r.risks.length ? 'warning' : 'default'} sx={{ height: 20 }} /> },
    /* B5-R3：新增「填报时间」列（createdAt，YYYY-MM-DD HH:mm，空值兜底 —，title 放完整时间） */
    {
      key: 'createdAt',
      label: '填报时间',
      width: 150,
      hideBelow: 'lg',
      render: (r) => (
        <Typography variant="caption" color="text.secondary" title={r.createdAt || undefined} sx={{ whiteSpace: 'nowrap' }}>
          {fmtDateTime(r.createdAt)}
        </Typography>
      ),
    },
    {
      key: 'actions',
      label: '操作',
      width: 132,
      align: 'center',
      render: (r) => {
        const confirmable = isConfirmable(r);
        return (
          <Stack direction="row" spacing={0.25} justifyContent="center" alignItems="center">
            {confirmable && (
              <>
                <Tooltip title="确认该周报">
                  <IconButton
                    size="small"
                    color="success"
                    disabled={busyId === r.id}
                    onClick={(e) => { e.stopPropagation(); void handleConfirm(r); }}
                  >
                    <TaskAltOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="打回该周报">
                  <IconButton
                    size="small"
                    color="error"
                    disabled={busyId === r.id}
                    onClick={(e) => { e.stopPropagation(); openReject(r); }}
                  >
                    <BlockOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </>
            )}
            <Tooltip title="更多操作">
              <IconButton size="small" onClick={(e) => { e.stopPropagation(); openMenu(e, r); }}>
                <MoreVertOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        );
      },
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
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<FileDownloadIcon />}
              onClick={handleExportReports}
            >
              导出 CSV
            </Button>
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
          </Stack>
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
            <DataTable<Report> columns={columns} rows={sortedReports} rowKey={(r) => r.id} tableLayout="fixed" />
          </>
        )}
      </SectionCard>

      {/* 行操作「更多」菜单 */}
      <Menu anchorEl={menuAnchor?.el} open={!!menuAnchor} onClose={closeMenu}>
        <MenuItem
          onClick={() => {
            if (menuAnchor) openDetail(menuAnchor.report);
            closeMenu();
          }}
        >
          <ListItemIcon>
            <VisibilityOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>查看</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuAnchor) openEditReport(menuAnchor.report);
            closeMenu();
          }}
        >
          <ListItemIcon>
            <EditOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>编辑</ListItemText>
        </MenuItem>
      </Menu>

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
            {/* B5-R4：顶部 meta 行 = 状态 Chip + 填报人 + 填报时间（caption 次要色） */}
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap' }}>
              <StatusChip status={detail.status} />
              <Typography variant="caption" color="text.secondary">
                填报人：{detail.authorName}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                填报：{fmtDateTime(detail.createdAt)}
              </Typography>
            </Stack>
            {/* B14-块2：闭环状态展示（已确认 / 已打回原因） */}
            {detail.status === '已确认' && (
              <Alert severity="success" variant="outlined" sx={{ fontSize: 13 }}>
                已由 {detail.confirmedBy ? memberNameOf(members, detail.confirmedBy) : '—'} 确认
                {detail.confirmedAt ? `（${fmtDateTime(detail.confirmedAt)}）` : ''}
              </Alert>
            )}
            {detail.status === '草稿' && detail.rejectReason && (
              <Alert severity="warning" variant="outlined" sx={{ fontSize: 13 }}>
                <Typography variant="caption" sx={{ fontWeight: 600 }}>
                  打回原因：
                </Typography>
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mt: 0.25 }}>
                  {detail.rejectReason}
                </Typography>
              </Alert>
            )}
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

      {/* B14-块2：打回原因必填弹窗 */}
      <FormDialog
        open={Boolean(rejectTarget)}
        title="打回周报"
        submitText="确认打回"
        disabled={!rejectReason.trim() || rejectReason.trim().length > REJECT_REASON_MAX || busyId === rejectTarget?.id}
        maxWidth="sm"
        onClose={closeReject}
        onSubmit={() => void handleReject()}
      >
        {rejectTarget && (
          <Stack spacing={1.5}>
            <Alert severity="info" variant="outlined" sx={{ fontSize: 13 }}>
              打回后该周报状态回退为「草稿」，作者需重新提交。请填写明确的打回原因（必填）。
            </Alert>
            <Typography variant="body2" color="text.secondary">
              周次：{rejectTarget.week}　填报人：{rejectTarget.authorName}
            </Typography>
            <TextField
              label={`打回原因（必填，≤${REJECT_REASON_MAX}字）`}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              fullWidth
              multiline
              minRows={3}
              autoFocus
              error={rejectReason.trim().length > REJECT_REASON_MAX}
              helperText={
                rejectReason.trim().length > REJECT_REASON_MAX
                  ? `已超过 ${REJECT_REASON_MAX} 字上限`
                  : `${rejectReason.trim().length}/${REJECT_REASON_MAX}`
              }
            />
          </Stack>
        )}
      </FormDialog>
    </Stack>
  );
}
