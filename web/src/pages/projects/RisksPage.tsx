import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';

import { DataTable, PageHeader, SectionCard, StatusChip } from '@/components/common';
import type { Column } from '@/components/common';
import { ConfirmDialog, FormDialog } from '@/components/common';
import type { Risk, CreateRiskPayload, UpdateRiskPayload } from '@/types/audit';
import { RISK_CATEGORIES, RISK_STATUSES, RISK_LEVELS, RISK_HIGH_THRESHOLD } from '@/config/enums';
import { useParams } from 'react-router-dom';
import { api } from '@/api/client';
import { useToast } from '@/hooks';
import { usePermission } from '@/hooks';
import { useProjectStore } from '@/stores/projectStore';
import { fmtDate } from '@/utils/date';

interface RiskForm {
  description: string;
  category: string;
  probability: number;
  impact: number;
  strategy: string;
  owner: string;
  status: string;
  reviewDate: string;
}

const EMPTY_FORM: RiskForm = {
  description: '',
  category: '',
  probability: 3,
  impact: 3,
  strategy: '',
  owner: '',
  status: '待评估',
  reviewDate: '',
};

/**
 * 风险登记册（本期新增功能域）
 * 权限：复用 `project:edit`（负责人 / 管理员 / 项目负责人），归档态禁用写。
 * 口径：风险值 = 概率 × 影响，≥ 12 记为高风险（与后端 / 列表 highRiskCount 同源）。
 */
export function RisksPage(): JSX.Element {
  const { id = '' } = useParams();
  const toast = useToast();
  const { can } = usePermission();
  const project = useProjectStore((s) => s.current);

  const [rows, setRows] = useState<Risk[]>([]);
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<RiskForm>(EMPTY_FORM);
  const [editing, setEditing] = useState<Risk | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Risk | null>(null);

  const archived = project?.status === '已结项' || project?.status === '已终止';
  const canEdit = can('project:edit') && !archived;

  const load = (): void => {
    if (!id) return;
    setLoading(true);
    api
      .listRisks(id)
      .then(setRows)
      .catch((e: unknown) => toast.error(e))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const openCreate = (): void => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  };

  const openEdit = (r: Risk): void => {
    setEditing(r);
    setForm({
      description: r.description,
      category: r.category,
      probability: r.probability,
      impact: r.impact,
      strategy: r.strategy,
      owner: r.owner,
      status: r.status,
      reviewDate: r.reviewDate ?? '',
    });
    setFormOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    if (!id) return;
    if (!form.description.trim()) {
      toast.error('风险描述不能为空');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        description: form.description,
        category: form.category,
        probability: form.probability,
        impact: form.impact,
        strategy: form.strategy,
        owner: form.owner,
        status: form.status,
        reviewDate: form.reviewDate || null,
      };
      if (editing) {
        await api.updateRisk(editing.id, payload as UpdateRiskPayload);
        toast.success('风险已更新');
      } else {
        await api.createRisk(id, payload as CreateRiskPayload);
        toast.success('风险已登记');
      }
      setFormOpen(false);
      setEditing(null);
      load();
    } catch (e) {
      toast.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    try {
      await api.deleteRisk(deleteTarget.id);
      toast.success('风险已删除');
      setDeleteTarget(null);
      load();
    } catch (e) {
      toast.error(e);
    }
  };

  const liveValue = form.probability * form.impact;

  const columns: Array<Column<Risk>> = [
    { key: 'code', label: '编号', width: 90 },
    {
      key: 'description',
      label: '风险描述',
      render: (r) => <Typography sx={{ fontSize: 14 }}>{r.description}</Typography>,
    },
    { key: 'category', label: '类别', width: 96 },
    {
      key: 'riskValue',
      label: '风险值',
      width: 90,
      align: 'right',
      render: (r) => (
        <Typography
          sx={{
            fontSize: 13,
            fontWeight: 600,
            color: r.riskValue >= RISK_HIGH_THRESHOLD ? 'error.main' : 'text.primary',
          }}
        >
          {r.probability * r.impact}
        </Typography>
      ),
    },
    { key: 'owner', label: '责任人', width: 96 },
    { key: 'status', label: '状态', width: 96, render: (r) => <StatusChip status={r.status} /> },
    {
      key: 'reviewDate',
      label: '复评日',
      width: 110,
      render: (r) => <Typography sx={{ fontSize: 13 }}>{fmtDate(r.reviewDate)}</Typography>,
    },
    ...(canEdit
      ? [
          {
            key: 'actions',
            label: '操作',
            width: 96,
            render: (r: Risk) => (
              <Stack direction="row" spacing={0.25}>
                <Tooltip title="编辑">
                  <IconButton size="small" onClick={(e) => { e.stopPropagation(); openEdit(r); }}>
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="删除">
                  <IconButton
                    size="small"
                    color="error"
                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(r); }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            ),
          } as Column<Risk>,
        ]
      : []),
  ];

  return (
    <Stack spacing={2.5}>
      <PageHeader
        title="风险登记册"
        subtitle="风险登记、概率/影响矩阵与应对跟踪；风险值 = 概率 × 影响，≥ 12 记为高风险"
        actions={
          canEdit ? (
            <Button variant="contained" onClick={openCreate}>
              登记风险
            </Button>
          ) : undefined
        }
      />
      <SectionCard flush>
        <DataTable<Risk>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          emptyTitle="暂无风险记录"
          emptyDescription="点击右上角「登记风险」开始记录项目风险"
        />
      </SectionCard>

      <FormDialog
        open={formOpen}
        title={editing ? '编辑风险' : '登记风险'}
        submitting={submitting}
        onClose={() => setFormOpen(false)}
        onSubmit={handleSubmit}
      >
        <TextField
          label="风险描述"
          required
          fullWidth
          multiline
          minRows={2}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <TextField
          select
          label="类别"
          fullWidth
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
        >
          <MenuItem value="">未分类</MenuItem>
          {RISK_CATEGORIES.map((c) => (
            <MenuItem key={c} value={c}>
              {c}
            </MenuItem>
          ))}
        </TextField>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
          <TextField
            select
            label="概率 (1-5)"
            value={form.probability}
            onChange={(e) => setForm({ ...form, probability: Number(e.target.value) })}
            sx={{ minWidth: 130 }}
          >
            {RISK_LEVELS.map((n) => (
              <MenuItem key={n} value={n}>
                {n}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="影响 (1-5)"
            value={form.impact}
            onChange={(e) => setForm({ ...form, impact: Number(e.target.value) })}
            sx={{ minWidth: 130 }}
          >
            {RISK_LEVELS.map((n) => (
              <MenuItem key={n} value={n}>
                {n}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="风险值"
            value={liveValue}
            InputProps={{ readOnly: true }}
            sx={{ width: 120 }}
            helperText={liveValue >= RISK_HIGH_THRESHOLD ? '高风险' : undefined}
            color={liveValue >= RISK_HIGH_THRESHOLD ? 'error' : 'primary'}
          />
        </Stack>
        <TextField
          label="应对策略"
          fullWidth
          multiline
          minRows={2}
          value={form.strategy}
          onChange={(e) => setForm({ ...form, strategy: e.target.value })}
        />
        <TextField
          label="责任人"
          fullWidth
          value={form.owner}
          onChange={(e) => setForm({ ...form, owner: e.target.value })}
        />
        <TextField
          select
          label="状态"
          fullWidth
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value })}
        >
          {RISK_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {s}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="复评日期"
          type="date"
          fullWidth
          InputLabelProps={{ shrink: true }}
          value={form.reviewDate}
          onChange={(e) => setForm({ ...form, reviewDate: e.target.value })}
        />
      </FormDialog>

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除风险"
        content={`确认删除风险「${deleteTarget?.code ?? ''} ${deleteTarget?.description ?? ''}」？此操作不可撤销。`}
        danger
        confirmText="删除"
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
      />
    </Stack>
  );
}
