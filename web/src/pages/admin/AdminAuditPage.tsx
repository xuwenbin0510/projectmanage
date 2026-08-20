import { useEffect, useState } from 'react';
import { Box, Chip, MenuItem, Stack, TextField, Typography } from '@mui/material';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';

import { EmptyState, LoadingState, PageHeader, SectionCard } from '@/components/common';
import { AdminTabs } from './AdminTabs';
import type { AuditLog } from '@/types/audit';
import { api } from '@/api/client';
import { useToast } from '@/hooks';
import { AUDIT_ACTION_LABEL, AUDIT_ENTITY_LABEL } from '@/config/enums';
import { fmtDateTime } from '@/utils/date';
import { alphaOf as alpha, tokens, toneColor } from '@/theme/tokens';

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

  const load = (): void => {
    setLoading(true);
    api
      .listAudit({ entityType, action, pageSize: 100 })
      .then((res) => setLogs(res.items))
      .catch((e: unknown) => toast.error(e))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  return (
    <Stack spacing={2.5}>
      <AdminTabs />
      <PageHeader
        title="审计日志"
        subtitle="全平台关键操作的留痕查询；可按对象类型与动作过滤"
        actions={
          <Chip size="small" label={`共 ${logs.length} 条`} sx={{ height: 22 }} />
        }
      />

      <SectionCard>
        <Stack direction="row" spacing={1.25} flexWrap="wrap" useFlexGap>
          <TextField
            size="small"
            select
            label="对象类型"
            value={entityType}
            onChange={(e) => {
              setEntityType(e.target.value);
              setTimeout(load, 0);
            }}
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
            onChange={(e) => {
              setAction(e.target.value);
              setTimeout(load, 0);
            }}
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
