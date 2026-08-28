import { useEffect, useState } from 'react';
import { Box, Button, Chip, MenuItem, Stack, TextField, Typography } from '@mui/material';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import FileDownloadIcon from '@mui/icons-material/FileDownload';

import { EmptyState, LoadingState, PageHeader, SectionCard } from '@/components/common';
import { AdminTabs } from './AdminTabs';
import type { AuditLog } from '@/types/audit';
import { api, USE_MOCK } from '@/api/client';
import { usePermission, useToast } from '@/hooks';
import { AUDIT_ACTION_LABEL, AUDIT_ENTITY_LABEL } from '@/config/enums';
import { fmtDateTime } from '@/utils/date';
import { alphaOf as alpha, tokens, toneColor } from '@/theme/tokens';
import { csvDateStamp, downloadCsv, fetchCsv, toCsv } from '@/utils/csv';

/** 导出列（与后端 server/services/export.service.js 口径一致）。 */
const AUDIT_CSV_HEADERS = [
  '日志ID', '项目ID', '项目名称', '实体类型', '实体ID', '操作', '操作人ID', '操作人名', '摘要', '时间',
];

const ACTION_TONE: Record<string, keyof typeof toneColor> = {
  create: 'success',
  update: 'brand',
  status_change: 'warning',
  decide: 'brand',
  approve: 'success',
  reject: 'danger',
  apply: 'success',
  delete: 'danger',
};

/**
 * 管理后台 · 全局审计日志（P0-16 管理后台）
 * @prd P0-16
 */
export function AdminAuditPage(): JSX.Element {
  const toast = useToast();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');

  const { can } = usePermission();
  // 与后端 /export/audits 的 requirePermission('admin:audit:view') 同源
  const canExportAudit = can('admin:audit:view');

  /** 导出审计 CSV（真实模式走服务端，mock 模式本地生成）。 */
  const handleExportAudit = async (): Promise<void> => {
    try {
      let csv: string;
      if (USE_MOCK) {
        const rows = logs.map((a) => ({
          日志ID: a.id,
          项目ID: a.projectId || '',
          项目名称: a.projectName || '',
          实体类型: a.entityType,
          实体ID: a.entityId || '',
          操作: a.action,
          操作人ID: a.actorOpenId,
          操作人名: a.actorName,
          摘要: a.summary,
          时间: a.createdAt,
        }));
        csv = toCsv(AUDIT_CSV_HEADERS, rows);
      } else {
        csv = await fetchCsv('/export/audits');
      }
      downloadCsv(`audits_${csvDateStamp()}.csv`, csv);
      toast.success('审计日志已导出');
    } catch (e) {
      toast.error(e);
    }
  };

  // 以 entityType / action 为依赖驱动查询，始终使用最新筛选值（避免闭包捕获旧值导致筛选慢一拍）。
  useEffect(() => {
    if (!canExportAudit) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    api
      .listAudit({ entityType, action, pageSize: 100 })
      .then((res) => { if (alive) setLogs(res.items); })
      .catch((e: unknown) => toast.error(e))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [entityType, action, canExportAudit, toast]);

  if (!canExportAudit) {
    return (
      <Stack spacing={2.5}>
        <AdminTabs />
        <EmptyState
          title="无访问权限"
          description="当前账号无「审计日志查看」权限（admin:audit:view）。如需开通，请联系系统管理员在权限矩阵中授予。"
          icon={<HistoryOutlinedIcon />}
        />
      </Stack>
    );
  }

  return (
    <Stack spacing={2.5}>
      <AdminTabs />
      <PageHeader
        title="审计日志"
        subtitle="全平台关键操作的留痕查询；可按对象类型与动作过滤"
        actions={
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip size="small" label={`共 ${logs.length} 条`} sx={{ height: 22 }} />
            {canExportAudit && (
              <Button
                variant="outlined"
                size="small"
                startIcon={<FileDownloadIcon />}
                onClick={handleExportAudit}
              >
                导出 CSV
              </Button>
            )}
          </Stack>
        }
      />

      <SectionCard>
        <Stack direction="row" spacing={1.25} flexWrap="wrap" useFlexGap>
          <TextField
            size="small"
            select
            label="对象类型"
            value={entityType}
            displayEmpty
            renderValue={(v) => (v ? AUDIT_ENTITY_LABEL[v] ?? v : '全部')}
            onChange={(e) => setEntityType(e.target.value)}
            sx={{ minWidth: 150 }}
          >
            <MenuItem value="">全部</MenuItem>
            {Object.entries(AUDIT_ENTITY_LABEL).map(([k, v]) => (
              <MenuItem key={k} value={k}>
                {v}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="动作"
            value={action}
            displayEmpty
            renderValue={(v) => (v ? AUDIT_ACTION_LABEL[v] ?? v : '全部')}
            onChange={(e) => setAction(e.target.value)}
            sx={{ minWidth: 150 }}
          >
            <MenuItem value="">全部</MenuItem>
            {Object.entries(AUDIT_ACTION_LABEL).map(([k, v]) => (
              <MenuItem key={k} value={k}>
                {v}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
      </SectionCard>

      <SectionCard flush>
        {loading ? (
          <LoadingState variant="skeleton" rows={6} height={56} />
        ) : logs.length === 0 ? (
          <EmptyState title="暂无审计记录" description="全平台关键操作会自动留痕于此" icon={<HistoryOutlinedIcon />} />
        ) : (
          <Stack spacing={0} sx={{ p: 2 }}>
            {logs.map((log, idx) => {
              const tone = ACTION_TONE[log.action] ?? 'neutral';
              const color = toneColor[tone];
              const isLast = idx === logs.length - 1;
              return (
                <Stack key={log.id} direction="row" spacing={1.75} sx={{ position: 'relative' }}>
                  <Stack alignItems="center" sx={{ width: 18, flexShrink: 0 }}>
                    <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: color, boxShadow: `0 0 0 3px ${alpha(color, 0.18)}`, mt: 0.5 }} />
                    {!isLast && <Box sx={{ flex: 1, width: 2, bgcolor: tokens.border.subtle, my: 0.5 }} />}
                  </Stack>
                  <Box sx={{ pb: isLast ? 0 : 2.5, minWidth: 0, flex: 1 }}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Chip size="small" label={AUDIT_ACTION_LABEL[log.action] ?? log.action} sx={{ height: 20, bgcolor: alpha(color, 0.16), color, fontWeight: 600 }} />
                      <Chip size="small" variant="outlined" label={`${AUDIT_ENTITY_LABEL[log.entityType] ?? log.entityType} · ${log.summary}`} sx={{ height: 20, maxWidth: 360 }} />
                      <Typography variant="caption" color="text.secondary">{fmtDateTime(log.createdAt)}</Typography>
                    </Stack>
                    <Typography variant="body2" sx={{ mt: 0.5 }}>
                      <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>{log.actorName}</Box> · {log.projectName}
                    </Typography>
                    {log.diff.length > 0 && (
                      <Stack spacing={0.5} sx={{ mt: 0.75, pl: 1, borderLeft: `2px solid ${tokens.border.subtle}` }}>
                        {log.diff.map((d) => (
                          <Typography key={d.field} variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                            <Box component="span" sx={{ color: 'text.primary' }}>{d.label}</Box>：{d.before || '—'} →{' '}
                            <Box component="span" sx={{ color }}>{d.after || '—'}</Box>
                          </Typography>
                        ))}
                      </Stack>
                    )}
                  </Box>
                </Stack>
              );
            })}
          </Stack>
        )}
      </SectionCard>
    </Stack>
  );
}
