import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Stack,
  Typography,
  Button,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Chip,
  Tooltip,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';

import {
  DataTable,
  PageHeader,
  SectionCard,
  EmptyState,
  LoadingState,
} from '@/components/common';
import type { Column } from '@/components/common';
import type { ProjectDocument } from '@/types/audit';
import type { WbsNode } from '@/types/wbs';
import type { MilestoneWithGate, User } from '@/types/project';
import { useParams } from 'react-router-dom';
import { api } from '@/api/client';
import { useToast } from '@/hooks';
import { useAuthStore } from '@/stores/authStore';

type FilterKind = 'all' | 'node' | 'milestone';
interface DocFilter {
  kind: FilterKind;
  id: string;
}

function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function isPreviewable(mime: string): boolean {
  return mime.startsWith('image/') || mime === 'application/pdf';
}

function iconFor(d: ProjectDocument) {
  if (d.docType === 'link') return <LinkOutlinedIcon fontSize="small" />;
  const mime = d.mimeType || '';
  if (mime.startsWith('image/')) return <ImageOutlinedIcon fontSize="small" />;
  if (mime === 'application/pdf') return <PictureAsPdfIcon fontSize="small" />;
  return <InsertDriveFileOutlinedIcon fontSize="small" />;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 任务附件（C01 · 方案 A）
 * 在 WBS 任务或里程碑上挂文件，支持上传 / 列表 / 预览 / 下载 / 删除。
 * 权限：上传面向所有项目参与者，删除仅管理员 / 项目负责人（与服务端 RBAC 一致）。
 */
export function DocumentsPage(): JSX.Element {
  const { id = '' } = useParams();
  const toast = useToast();
  const can = useAuthStore((s) => s.can);

  const [rows, setRows] = useState<ProjectDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [wbsNodes, setWbsNodes] = useState<WbsNode[]>([]);
  const [milestones, setMilestones] = useState<MilestoneWithGate[]>([]);
  const [usersMap, setUsersMap] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<DocFilter>({ kind: 'all', id: '' });

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadKind, setUploadKind] = useState<FilterKind>('none' as FilterKind);
  const [uploadTarget, setUploadTarget] = useState('');
  const [uploading, setUploading] = useState(false);
  /* D02：粘贴链接模式（false=上传文件 / true=关联飞书文档） */
  const [linkMode, setLinkMode] = useState(false);
  const [linkName, setLinkName] = useState('');
  const [linkUrl, setLinkUrl] = useState('');

  const nodeMap = useMemo(() => {
    const m: Record<string, string> = {};
    wbsNodes.forEach((n) => (m[n.id] = n.name));
    return m;
  }, [wbsNodes]);
  const msMap = useMemo(() => {
    const m: Record<string, string> = {};
    milestones.forEach((x) => (m[x.id] = x.name));
    return m;
  }, [milestones]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const opts =
          filter.kind === 'node'
            ? { nodeId: filter.id }
            : filter.kind === 'milestone'
              ? { milestoneId: filter.id }
              : {};
        const [wbs, ms, users, list] = await Promise.all([
          api.listWbs(id),
          api.listMilestones(id),
          api.listUsers(),
          api.listDocuments(id, opts),
        ]);
        if (cancelled) return;
        setWbsNodes(wbs);
        setMilestones(ms);
        const m: Record<string, string> = {};
        users.forEach((u: User) => (m[u.openId] = u.name));
        setUsersMap(m);
        setRows(list);
      } catch (e: unknown) {
        if (!cancelled) toast.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, filter, toast]);

  const associationLabel = (d: ProjectDocument): string => {
    if (d.nodeId && nodeMap[d.nodeId]) return `任务：${nodeMap[d.nodeId]}`;
    if (d.milestoneId && msMap[d.milestoneId]) return `里程碑：${msMap[d.milestoneId]}`;
    return '项目级';
  };

  const openUpload = () => {
    setUploadFile(null);
    setUploadKind('none' as FilterKind);
    setUploadTarget('');
    setLinkMode(false);
    setLinkName('');
    setLinkUrl('');
    setUploadOpen(true);
  };

  const doSubmit = async () => {
    setUploading(true);
    try {
      if (linkMode) {
        if (!linkUrl.trim()) {
          toast.error('请粘贴飞书文档链接');
          return;
        }
        await api.createLinkDocument(id, {
          url: linkUrl.trim(),
          name: linkName.trim() || undefined,
          nodeId: uploadKind === 'node' ? uploadTarget : '',
          milestoneId: uploadKind === 'milestone' ? uploadTarget : '',
        });
        toast.success('已关联文档');
      } else {
        if (!uploadFile) {
          toast.error('请先选择文件');
          return;
        }
        await api.uploadDocument(id, {
          file: uploadFile,
          nodeId: uploadKind === 'node' ? uploadTarget : '',
          milestoneId: uploadKind === 'milestone' ? uploadTarget : '',
        });
        toast.success('上传成功');
      }
      setUploadOpen(false);
      const opts =
        filter.kind === 'node'
          ? { nodeId: filter.id }
          : filter.kind === 'milestone'
            ? { milestoneId: filter.id }
            : {};
      setRows(await api.listDocuments(id, opts));
    } catch (e: unknown) {
      toast.error(e);
    } finally {
      setUploading(false);
    }
  };

  const doDelete = async (d: ProjectDocument) => {
    if (!window.confirm(`确认删除附件「${d.name}」？该操作不可恢复。`)) return;
    try {
      await api.deleteDocument(id, d.id);
      toast.success('已删除');
      setRows(rows.filter((r) => r.id !== d.id));
    } catch (e: unknown) {
      toast.error(e);
    }
  };

  const doPreview = async (d: ProjectDocument) => {
    try {
      const blob = await api.downloadDocument(id, d.id, { asDownload: false });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e: unknown) {
      toast.error(e);
    }
  };

  const doDownload = async (d: ProjectDocument) => {
    try {
      const blob = await api.downloadDocument(id, d.id, { asDownload: true });
      triggerDownload(blob, d.name);
    } catch (e: unknown) {
      toast.error(e);
    }
  };

  const filterValue = filter.kind === 'all' ? 'all' : `${filter.kind}:${filter.id}`;
  const onFilterChange = (v: string) => {
    if (v === 'all') setFilter({ kind: 'all', id: '' });
    else {
      const [kind, fid] = v.split(':');
      setFilter({ kind: kind as FilterKind, id: fid });
    }
  };

  const columns: Array<Column<ProjectDocument>> = [
    {
      key: 'name',
      label: '文档',
      render: (d) => (
        <Stack direction="row" spacing={1} alignItems="center">
          <Box sx={{ color: 'text.secondary', display: 'flex' }}>{iconFor(d)}</Box>
          <Box>
            <Typography sx={{ fontSize: 14, fontWeight: 500 }}>{d.name}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
              {d.docType === 'link'
                ? d.url
                : `${formatSize(d.fileSize)} · ${d.mimeType || '未知类型'}`}
            </Typography>
          </Box>
        </Stack>
      ),
    },
    {
      key: 'assoc',
      label: '关联',
      width: 200,
      render: (d) => <Chip size="small" variant="outlined" label={associationLabel(d)} />,
    },
    { key: 'uploader', label: '上传人', width: 120, render: (d) => usersMap[d.uploadedBy] || d.uploadedBy || '—' },
    {
      key: 'uploadedAt',
      label: '上传时间',
      width: 160,
      render: (d) => (d.uploadedAt ? new Date(d.uploadedAt).toLocaleString('zh-CN') : '—'),
    },
    {
      key: 'ops',
      label: '操作',
      width: 150,
      align: 'center',
      render: (d) => (
        <Stack direction="row" spacing={0.5} justifyContent="center">
          {d.docType === 'link' ? (
            <Tooltip title="打开文档">
              <IconButton size="small" onClick={() => window.open(d.url, '_blank', 'noopener')}>
                <OpenInNewOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : (
            <>
              {isPreviewable(d.mimeType) && (
                <Tooltip title="预览">
                  <IconButton size="small" onClick={() => doPreview(d)}>
                    <VisibilityOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip title="下载">
                <IconButton size="small" onClick={() => doDownload(d)}>
                  <DownloadOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </>
          )}
          {can('document:delete') && (
            <Tooltip title="删除">
              <IconButton size="small" color="error" onClick={() => doDelete(d)}>
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Stack>
      ),
    },
  ];

  return (
    <Stack spacing={2.5}>
      <PageHeader
        title="任务附件"
        subtitle="C01/D02：在 WBS 任务或里程碑上挂载交付文件（上传 ≤ 20MB）或关联飞书文档（粘贴链接自动抓标题）"
        actions={
          can('document:upload') ? (
            <Button variant="contained" startIcon={<UploadFileIcon />} onClick={openUpload}>
              上传附件
            </Button>
          ) : null
        }
      />

      <SectionCard flush>
        {loading ? (
          <LoadingState variant="skeleton" rows={4} height={48} />
        ) : (
          <Box sx={{ p: 1.5 }}>
            <FormControl size="small" sx={{ minWidth: 240, mb: 1.5 }}>
              <InputLabel id="doc-filter-label">筛选</InputLabel>
              <Select
                labelId="doc-filter-label"
                label="筛选"
                value={filterValue}
                onChange={(e) => onFilterChange(e.target.value)}
              >
                <MenuItem value="all">全部附件（{rows.length}）</MenuItem>
                {wbsNodes.map((n) => (
                  <MenuItem key={n.id} value={`node:${n.id}`}>
                    任务：{n.name}
                  </MenuItem>
                ))}
                {milestones.map((x) => (
                  <MenuItem key={x.id} value={`milestone:${x.id}`}>
                    里程碑：{x.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {rows.length === 0 ? (
              <EmptyState title="暂无附件" description="点击右上角「上传附件」在任务或里程碑上挂载文件" />
            ) : (
              <DataTable<ProjectDocument> columns={columns} rows={rows} rowKey={(d) => d.id} />
            )}
          </Box>
        )}
      </SectionCard>

      <Dialog open={uploadOpen} onClose={() => !uploading && setUploadOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{linkMode ? '关联飞书文档' : '上传附件'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={linkMode ? 'link' : 'file'}
              onChange={(_e, v: string | null) => {
                if (v === 'link' || v === 'file') setLinkMode(v === 'link');
              }}
              fullWidth
            >
              <ToggleButton value="file" disabled={uploading}>
                上传文件
              </ToggleButton>
              <ToggleButton value="link" disabled={uploading}>
                粘贴链接
              </ToggleButton>
            </ToggleButtonGroup>

            {linkMode ? (
              <>
                <TextField
                  size="small"
                  fullWidth
                  label="飞书文档链接"
                  placeholder="https://xxx.feishu.cn/docx/xxxxxxxx"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  helperText="粘贴飞书文档 / 知识库 / 表格链接，自动抓取文档标题（未配置飞书凭证时使用你填写的名称）"
                />
                <TextField
                  size="small"
                  fullWidth
                  label="展示名称（可选）"
                  placeholder="留空则用文档标题 / 链接"
                  value={linkName}
                  onChange={(e) => setLinkName(e.target.value)}
                />
              </>
            ) : (
              <Button variant="outlined" component="label" startIcon={<UploadFileIcon />}>
                {uploadFile ? `已选：${uploadFile.name}` : '选择文件'}
                <input
                  hidden
                  type="file"
                  onChange={(e) => setUploadFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
                />
              </Button>
            )}

            <FormControl size="small" fullWidth>
              <InputLabel id="upload-kind-label">关联对象</InputLabel>
              <Select
                labelId="upload-kind-label"
                label="关联对象"
                value={uploadKind}
                onChange={(e) => {
                  setUploadKind(e.target.value as FilterKind);
                  setUploadTarget('');
                }}
              >
                <MenuItem value="none">不关联（项目级）</MenuItem>
                <MenuItem value="node">关联到任务</MenuItem>
                <MenuItem value="milestone">关联到里程碑</MenuItem>
              </Select>
            </FormControl>

            {uploadKind === 'node' && (
              <FormControl size="small" fullWidth>
                <InputLabel id="upload-node-label">选择任务</InputLabel>
                <Select
                  labelId="upload-node-label"
                  label="选择任务"
                  value={uploadTarget}
                  onChange={(e) => setUploadTarget(e.target.value)}
                >
                  {wbsNodes.map((n) => (
                    <MenuItem key={n.id} value={n.id}>
                      {n.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            {uploadKind === 'milestone' && (
              <FormControl size="small" fullWidth>
                <InputLabel id="upload-ms-label">选择里程碑</InputLabel>
                <Select
                  labelId="upload-ms-label"
                  label="选择里程碑"
                  value={uploadTarget}
                  onChange={(e) => setUploadTarget(e.target.value)}
                >
                  {milestones.map((x) => (
                    <MenuItem key={x.id} value={x.id}>
                      {x.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            <Typography variant="caption" color="text.secondary">
              {linkMode
                ? '链接记录点击「打开文档」跳转飞书；支持 docx / wiki / sheets / slides / 多维表格。'
                : '允许图片 / PDF / Office / 文本 / 压缩包等常见格式，单文件不超过 20MB。'}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUploadOpen(false)} disabled={uploading}>
            取消
          </Button>
          <Button
            variant="contained"
            onClick={doSubmit}
            disabled={uploading || (linkMode ? !linkUrl.trim() : !uploadFile)}
          >
            {uploading ? '处理中…' : linkMode ? '关联' : '上传'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
