import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  FormControlLabel,
  InputAdornment,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import { useNavigate } from 'react-router-dom';

import {
  DataTable,
  HealthDot,
  PageHeader,
  PermissionButton,
  ProgressBar,
  SectionCard,
  StatusChip,
} from '@/components/common';
import type { Column } from '@/components/common';
import { useProjectStore } from '@/stores/projectStore';
import { useDebounced, useToast } from '@/hooks';
import type { ProjectListItem, ProjectType, ProjectStatus, Health } from '@/types/project';
import { PROJECT_STATUSES, PROJECT_TYPES, PROJECT_TYPE_LABEL, PROJECT_TYPE_SHORT, HEALTH_LABEL } from '@/config/enums';
import { ROUTES } from '@/config/routes';
import { fmtDate } from '@/utils/date';
import { fmtAmount } from '@/utils/format';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import { USE_MOCK } from '@/api/client';
import { csvDateStamp, downloadCsv, fetchCsv, toCsv } from '@/utils/csv';

const HEALTH_OPTIONS: Health[] = ['green', 'yellow', 'red'];

/** 导出列（与后端 server/services/export.service.js 口径一致）。 */
const PROJECT_CSV_HEADERS = [
  '项目ID', '项目编码', '项目名称', '类别', '客户', '合同额_万元', '状态', '健康度',
  '负责人', '计划开始', '计划结束', '实际结项', '进度(%)', '里程碑完成', '当前门控',
  '门通过数', '门总数', '高风险数',
];

/**
 * 项目列表：多维筛选 + 分页 + 健康度红黄绿
 * @prd P0-03 P0-04
 */
export function ProjectListPage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();

  const list = useProjectStore((s) => s.list);
  const total = useProjectStore((s) => s.total);
  const query = useProjectStore((s) => s.query);
  const loading = useProjectStore((s) => s.listLoading);
  const setQuery = useProjectStore((s) => s.setQuery);
  const fetchList = useProjectStore((s) => s.fetchList);

  const [keyword, setKeyword] = useState<string>(query.keyword ?? '');
  const debounced = useDebounced(keyword, 300);

  useEffect(() => {
    setQuery({ keyword: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  useEffect(() => {
    fetchList().catch((e: unknown) => toast.error(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  /** 导出项目清单 CSV（真实模式走服务端，mock 模式本地生成）。 */
  const handleExportProjects = async (): Promise<void> => {
    try {
      let csv: string;
      if (USE_MOCK) {
        const rows = list.map((p) => ({
          项目ID: p.id,
          项目编码: p.code,
          项目名称: p.name,
          类别: p.type,
          客户: p.customer,
          合同额_万元: p.contractAmount, // 键名与表头数组保持一致，下方统一导出
          状态: p.status,
          健康度: p.health,
          负责人: p.pmName,
          计划开始: p.planStart,
          计划结束: p.planEnd,
          实际结项: p.actualEnd ?? '',
          进度: p.progress,
          里程碑完成: `${p.milestoneDone ?? 0}/${p.milestoneTotal ?? 0}`,
          当前门控: p.currentGateCode,
          门通过数: p.gatePassed,
          门总数: p.gateTotal,
          高风险数: p.highRiskCount,
        }));
        csv = toCsv(PROJECT_CSV_HEADERS, rows);
      } else {
        csv = await fetchCsv('/export/projects');
      }
      downloadCsv(`projects_${csvDateStamp()}.csv`, csv);
      toast.success('项目清单已导出');
    } catch (e) {
      toast.error(e);
    }
  };

  const columns: Array<Column<ProjectListItem>> = [
    {
      key: 'name',
      label: '项目',
      render: (r) => (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
          <HealthDot health={r.health} />
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: 14, fontWeight: 600 }} noWrap>
              {r.name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {r.code} · {r.customer || '内部'}
            </Typography>
          </Box>
        </Stack>
      ),
    },
    {
      key: 'type',
      label: '分类',
      width: 78,
      render: (r) => (
        <Chip
          size="small"
          variant="outlined"
          label={PROJECT_TYPE_SHORT[r.type]}
          title={PROJECT_TYPE_LABEL[r.type]}
          sx={{ height: 22 }}
        />
      ),
    },
    { key: 'status', label: '状态', width: 92, render: (r) => <StatusChip status={r.status} /> },
    {
      /* N-5：项目「走到第几步」= 下一里程碑 + 已过 N/M 道门（不再有「当前阶段」） */
      key: 'nextMilestone',
      label: '下一里程碑 / 门',
      width: 190,
      hideOnMobile: true,
      render: (r) => (
        <Box>
          <Typography sx={{ fontSize: 13 }} noWrap>
            {r.nextMilestoneCode ? `${r.nextMilestoneCode} ${r.nextMilestoneName}` : '全部里程碑已达成'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            已过 {r.gatePassed}/{r.gateTotal} 道门
            {r.currentGateCode ? ` · ${r.currentGateCode} ${r.currentGateStatus}` : ''}
          </Typography>
        </Box>
      ),
    },
    {
      key: 'progress',
      label: '进度',
      width: 140,
      hideOnMobile: true,
      render: (r) => <ProgressBar value={r.progress} tone={r.health === 'red' ? 'danger' : 'brand'} />,
    },
    {
      key: 'milestone',
      label: '里程碑',
      width: 130,
      hideOnMobile: true,
      render: (r) => (
        <Box>
          <Typography sx={{ fontSize: 13 }}>
            {r.milestoneDone} / {r.milestoneTotal}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            下一个 {fmtDate(r.nextMilestoneDate)}
          </Typography>
        </Box>
      ),
    },
    { key: 'pmName', label: 'PM', width: 84, hideOnMobile: true },
    {
      key: 'amount',
      label: '合同额',
      width: 120,
      align: 'right',
      hideOnMobile: true,
      render: (r) => <Typography sx={{ fontSize: 13 }}>{fmtAmount(r.contractAmount)}</Typography>,
    },
  ];

  return (
    <Box>
      <PageHeader
        title="项目"
        subtitle={`共 ${total} 个项目 · A 类交付型 / B 类产品型 / C 类基建型 走不同生命周期`}
        actions={
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<FileDownloadIcon />}
              onClick={handleExportProjects}
            >
              导出 CSV
            </Button>
            <PermissionButton
              action="project:create"
              variant="contained"
              size="small"
              startIcon={<AddIcon />}
              onClick={() => navigate(ROUTES.projectCreate)}
            >
              新建项目
            </PermissionButton>
          </Stack>
        }
      />

      <SectionCard sx={{ mb: 2 }}>
        <Stack direction="row" spacing={1.25} flexWrap="wrap" useFlexGap alignItems="center">
          <TextField
            size="small"
            placeholder="搜索项目名 / 编号 / 客户"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            sx={{ minWidth: 240, flex: '1 1 240px' }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
          <TextField
            size="small"
            select
            label="分类"
            value={query.type ?? ''}
            onChange={(e) => setQuery({ type: e.target.value as ProjectType | '' })}
            sx={{ minWidth: 132 }}
          >
            <MenuItem value="">全部分类</MenuItem>
            {PROJECT_TYPES.map((t) => (
              <MenuItem key={t} value={t}>
                {PROJECT_TYPE_LABEL[t]}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="状态"
            value={query.status ?? ''}
            onChange={(e) => setQuery({ status: e.target.value as ProjectStatus | '' })}
            sx={{ minWidth: 124 }}
          >
            <MenuItem value="">全部状态</MenuItem>
            {PROJECT_STATUSES.map((s) => (
              <MenuItem key={s} value={s}>
                {s}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="健康度"
            value={query.health ?? ''}
            onChange={(e) => setQuery({ health: e.target.value })}
            sx={{ minWidth: 124 }}
          >
            <MenuItem value="">全部</MenuItem>
            {HEALTH_OPTIONS.map((h) => (
              <MenuItem key={h} value={h}>
                {HEALTH_LABEL[h]}
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={Boolean(query.onlyMine)}
                onChange={(e) => setQuery({ onlyMine: e.target.checked })}
              />
            }
            label={<Typography sx={{ fontSize: 13 }}>只看我参与的</Typography>}
          />
        </Stack>
      </SectionCard>

      <SectionCard flush>
        <DataTable<ProjectListItem>
          columns={columns}
          rows={list}
          rowKey={(r) => r.id}
          loading={loading}
          emptyTitle="没有符合条件的项目"
          emptyDescription="调整筛选条件，或新建一个项目"
          onRowClick={(r) => navigate(ROUTES.projectOverview(r.id))}
          pagination={{
            page: query.page ?? 1,
            pageSize: query.pageSize ?? 12,
            total,
            onChange: (page, pageSize) => setQuery({ page, pageSize }),
          }}
        />
      </SectionCard>
    </Box>
  );
}
