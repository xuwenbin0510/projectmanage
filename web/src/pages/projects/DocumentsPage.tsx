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
  EmptyState,
  LoadingState,
  PageHeader,
  SectionCard,
} from '@/components/common';
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
  /* D04：模板项交付（非空时提交走覆盖升版） */
  const [uploadTemplateKey, setUploadTemplateKey] = useState('');

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
    setUploadTemplateKey('');
    setUploadOpen(true);
  };

  /** D04：模板清单项「交付/替换」——打开对话框并携带 templateKey（提交时覆盖升版） */
  const openDeliver = (d: ProjectDocument) => {
    setUploadFile(null);
    setUploadKind('none' as FilterKind);
    setUploadTarget('');
    setLinkMode(false);
    setLinkName('');
    setLinkUrl('');
    setUploadTemplateKey(d.templateKey);
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
          templateKey: uploadTemplateKey || undefined,
        });
        toast.success(uploadTemplateKey ? '已交付' : '已关联文档');
      } else {
        if (!uploadFile) {
          toast.error('请先选择文件');
          return;
        }
        await api.uploadDocument(id, {
          file: uploadFile,
          nodeId: uploadKind === 'node' ? uploadTarget : '',
          milestoneId: uploadKind === 'milestone' ? uploadTarget : '',
          templateKey: uploadTemplateKey || undefined,
        });
        toast.success(uploadTemplateKey ? '已交付' : '上传成功');
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

  /* D04：单行渲染（模板交付物 / 手动记录统一卡片行） */
  const renderRow = (d: ProjectDocument): JSX.Element => {
    const isTpl = !!d.templateKey;
    const isLink = d.docType === 'link';
    const pending = isTpl && d.status === '待交付';
    return (
      <Box
        key={d.id}
        sx={{
          p: 1.25,
          borderRadius: 1.5,
          border: '1px solid',
          borderColor: pending ? 'warning.main' : 'divider',
          bgcolor: pending ? 'action.hover' : 'transparent',
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          <Box sx={{ color: 'text.secondary', display: 'flex', flexShrink: 0 }}>{iconFor(d)}</Box>
          <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
            <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography sx={{ fontSize: 14, fontWeight: 500 }}>{d.name}</Typography>
              {isTpl &&
                (pending ? (
                  <Chip size="small" label="待交付" sx={{ height: 18, fontSize: 11, bgcolor: 'warning.main', color: '#fff' }} />
                ) : (
                  <Chip size="small" label={`已交付 · v${d.version}`} sx={{ height: 18, fontSize: 11, bgcolor: 'primary.main', color: '#fff' }} />
                ))}
              {isTpl && <Chip size="small" label="模板" variant="outlined" sx={{ height: 18, fontSize: 11 }} />}
              {d.baselineFlag === 1 && (
                <Chip size="small" label="基线" variant="outlined" sx={{ height: 18, fontSize: 11, color: 'warning.main', borderColor: 'warning.main' }} />
              )}
              {!isTpl && <Chip size="small" label={associationLabel(d)} variant="outlined" sx={{ height: 18, fontSize: 11 }} />}
            </Stack>
            <Typography
              variant="caption"
              color={isLink ? 'primary.main' : 'text.secondary'}
              sx={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}
            >
              {isLink ? d.url : d.fileName ? `${formatSize(d.fileSize)} · ${d.mimeType || '未知类型'}` : isTpl ? '未交付' : ''}
            </Typography>
            {d.uploadedBy && (
              <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
                交付 {usersMap[d.uploadedBy] || d.uploadedBy}
                {d.uploadedAt ? ` · ${new Date(d.uploadedAt).toLocaleString('zh-CN')}` : ''}
              </Typography>
            )}
          </Box>
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
            {isTpl && (
              <Tooltip title={pending ? '上传文件或粘贴链接完成交付' : '替换交付物（自动升版）'}>
                <Button size="small" variant="outlined" startIcon={<UploadFileIcon fontSize="small" />} onClick={() => openDeliver(d)}>
                  {pending ? '交付' : '替换'}
                </Button>
              </Tooltip>
            )}
            {!isTpl && isLink && (
              <Tooltip title="打开文档">
                <IconButton size="small" onClick={() => window.open(d.url, '_blank', 'noopener')}>
                  <OpenInNewOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            {!isTpl && !isLink && (
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
        </Stack>
      </Box>
    );
  };

  /* D04：分组视图 —— 模板交付物按里程碑分组（项目级置后），手动记录最后 */
  const groups: Array<{ key: string; title: string; items: ProjectDocument[] }> = (() => {
    const templateRows = rows.filter((r) => r.templateKey);
    const manualRows = rows.filter((r) => !r.templateKey);
    const g: Array<{ key: string; title: string; items: ProjectDocument[] }> = [];
    milestones.forEach((ms) => {
      const items = templateRows.filter((r) => r.milestoneId === ms.id);
      if (items.length) g.push({ key: 'ms-' + ms.id, title: ms.name, items });
    });
    const projItems = templateRows.filter((r) => !r.milestoneId);
    if (projItems.length) g.push({ key: 'proj', title: '项目级交付物', items: projItems });
    if (manualRows.length) g.push({ key: 'manual', title: '手动记录（任务附件 / 飞书链接）', items: manualRows });
    return g;
  })();

  return (
    <Stack spacing={2.5}>
      <PageHeader
        title="项目文档"
        subtitle="D04：模板交付物清单（按里程碑派生，交付/替换自动升版）+ 上传附件（≤20MB）/ 关联飞书文档（粘贴链接自动抓标题）"
        actions={
          can('document:upload') ? (
            <Button variant="contained" startIcon={<UploadFileIcon />} onClick={openUpload}>
              添加文档
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
              <EmptyState title="暂无文档" description="点击右上角「上传附件」上传文件或「粘贴链接」关联飞书文档" />
            ) : (
              <Stack spacing={2}>
                {groups.map((g) => {
                  const pending = g.items.filter((r) => r.status === '待交付').length;
                  const done = g.items.length - pending;
                  return (
                    <Box key={g.key}>
                      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
                        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{g.title}</Typography>
                        <Chip
                          size="small"
                          label={`待交付 ${pending}`}
                          sx={{ height: 20, fontSize: 11, bgcolor: pending ? 'warning.main' : 'action.hover', color: pending ? '#fff' : 'text.disabled' }}
                        />
                        <Chip
                          size="small"
                          label={`已交付 ${done}`}
                          sx={{ height: 20, fontSize: 11, bgcolor: done ? 'primary.main' : 'action.hover', color: done ? '#fff' : 'text.disabled' }}
                        />
                      </Stack>
                      <Stack spacing={1}>{g.items.map(renderRow)}</Stack>
                    </Box>
                  );
                })}
              </Stack>
            )}
          </Box>
        )}
      </SectionCard>

      <Dialog open={uploadOpen} onClose={() => !uploading && setUploadOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>
          {uploadTemplateKey
            ? linkMode
              ? '交付模板交付物（链接）'
              : '交付模板交付物（文件）'
            : linkMode
              ? '关联飞书文档'
              : '上传附件'}
        </DialogTitle>
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
