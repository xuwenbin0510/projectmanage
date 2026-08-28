import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import CloudDownloadOutlinedIcon from '@mui/icons-material/CloudDownloadOutlined';
import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined';

import { api } from '@/api/client';
import { useToast } from '@/hooks';
import type { FeishuContactDTO, FeishuImportPreview, FeishuImportResult } from '@/api/contract';

/** 单条联系人的合并/跳过决策 */
type Decision = 'merge' | 'skip';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 导入完成后回调（用于刷新用户列表） */
  onImported?: () => void;
}

/** 三桶色标 */
const BUCKET_META: Record<FeishuContactDTO['bucket'], { label: string; color: 'default' | 'warning' | 'success' }> = {
  definite: { label: '铁证重复（将跳过）', color: 'default' },
  suspected: { label: '疑似重复（待确认）', color: 'warning' },
  fresh: { label: '新建（待授权）', color: 'success' },
};

/** 单人摘要行 */
function ContactLine({ c }: { c: FeishuContactDTO }): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" noWrap>
          <strong>{c.name}</strong>
          {c.departmentNames?.length ? <span style={{ color: 'text.secondary' }}> · {c.departmentNames.join(' / ')}</span> : null}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap display="block">
          {c.email || '（无邮箱）'}
          {c.employeeId ? ` · 工号 ${c.employeeId}` : ''}
        </Typography>
      </Box>
      <Chip size="small" variant="outlined" label={BUCKET_META[c.bucket].label} color={BUCKET_META[c.bucket].color} />
    </Stack>
  );
}

export function FeishuImportDialog({ open, onClose, onImported }: Props): JSX.Element {
  const toast = useToast();
  const [tab, setTab] = useState(1); // 默认进入「按姓名搜索」，避免打开即全量拉取

  /* 全量预览 */
  const [preview, setPreview] = useState<FeishuImportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [initialStatus, setInitialStatus] = useState<'pending' | 'active'>('pending');
  const [previewDecisions, setPreviewDecisions] = useState<Record<string, Decision>>({});

  /* 搜索 */
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<FeishuContactDTO[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchDecisions, setSearchDecisions] = useState<Record<string, Decision>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<FeishuImportResult | null>(null);

  /* 打开时重置状态，但【不】自动拉全量——默认走按姓名搜索，全量预览改为手动触发 */
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setPreviewDecisions({});
    setSearchDecisions({});
    setSelected({});
    setQuery('');
    setHits([]);
    setPreview(null);
    setTab(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const loadPreview = (): void => {
    setPreviewLoading(true);
    api
      .previewFeishuContacts()
      .then((p) => setPreview(p))
      .catch((e: unknown) => toast.error(e))
      .finally(() => setPreviewLoading(false));
  };

  /* 搜索防抖 300ms */
  useEffect(() => {
    if (!open || tab !== 1 || !query.trim()) {
      setHits([]);
      return;
    }
    setSearchLoading(true);
    const t = setTimeout(() => {
      api
        .searchFeishuUsers(query.trim())
        .then((r) => {
          setHits(r.hits);
          // 默认全选
          const sel: Record<string, boolean> = {};
          r.hits.forEach((h) => { sel[h.openId] = true; });
          setSelected(sel);
        })
        .catch((e: unknown) => toast.error(e))
        .finally(() => setSearchLoading(false));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tab, open]);

  const doImportFull = async (): Promise<void> => {
    setImporting(true);
    try {
      const r = await api.importFeishuUsers({ initialStatus, suspectedDecisions: previewDecisions });
      setResult(r);
      toast.success(`导入完成：新增 ${r.added} / 合并 ${r.merged} / 跳过 ${r.skipped}${r.failed ? ` / 失败 ${r.failed}` : ''}`);
      onImported?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setImporting(false);
    }
  };

  const doImportSearch = async (): Promise<void> => {
    setImporting(true);
    try {
      const contacts = hits.filter((h) => selected[h.openId]);
      if (!contacts.length) {
        toast.error('请至少选择一条搜索结果');
        setImporting(false);
        return;
      }
      const r = await api.importFeishuUsers({ initialStatus, suspectedDecisions: searchDecisions, contacts });
      setResult(r);
      toast.success(`导入完成：新增 ${r.added} / 合并 ${r.merged} / 跳过 ${r.skipped}${r.failed ? ` / 失败 ${r.failed}` : ''}`);
      onImported?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setImporting(false);
    }
  };

  const counts = useMemo(() => {
    const c = preview?.buckets;
    return {
      definite: c?.definite.length || 0,
      suspected: c?.suspected.length || 0,
      fresh: c?.fresh.length || 0,
    };
  }, [preview]);

  const resultSummary = result ? (
    <Alert severity={result.failed > 0 ? 'warning' : 'success'} sx={{ mt: 1 }}>
      新增 <b>{result.added}</b> · 合并 <b>{result.merged}</b> · 跳过 <b>{result.skipped}</b>
      {result.failed > 0 ? ` · 失败 ${result.failed}` : ''}
      {result.failed > 0 && (
        <Box component="ul" sx={{ m: 0, pl: 3, fontSize: 12 }}>
          {result.details.filter((d) => d.result === 'failed').map((d, i) => (
            <li key={i}>{d.name}：{d.reason}</li>
          ))}
        </Box>
      )}
    </Alert>
  ) : null;

  return (
    <Dialog open={open} onClose={importing ? () => {} : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>从飞书通讯录导入</DialogTitle>
      <DialogContent>
        {result ? (
          <Stack spacing={1.5}>
            <Alert icon={<CheckCircleOutlineOutlinedIcon />} severity="info">
              导入已完成。可关闭弹窗或继续调整。
            </Alert>
            {resultSummary}
            <Button variant="outlined" size="small" onClick={() => { setResult(null); loadPreview(); }}>
              重新预览
            </Button>
          </Stack>
        ) : (
          <>
            <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 1.5 }}>
              <Tab label="全量预览" />
              <Tab label="按姓名搜索" />
            </Tabs>

            {tab === 0 && (
              <Stack spacing={1.5}>
                {previewLoading ? (
                  <Box sx={{ textAlign: 'center', py: 3 }}><CircularProgress size={24} /></Box>
                ) : preview ? (
                  <>
                    <Alert severity="info">{preview.visibilityHint}</Alert>
                    <Typography variant="caption" color="text.secondary">
                      铁证 {counts.definite} · 疑似 {counts.suspected} · 新建 {counts.fresh}
                    </Typography>

                    {/* 铁证 */}
                    <Section title="铁证重复（open_id / union_id 命中，自动跳过，仅同步档案）" count={counts.definite}>
                      {preview.buckets.definite.map((c) => (
                        <ContactLine key={c.openId} c={c} />
                      ))}
                    </Section>

                    {/* 疑似 */}
                    <Section title="疑似重复（姓名/邮箱命中但飞书标识不一致，默认跳过）" count={counts.suspected}>
                      {preview.buckets.suspected.map((c) => (
                        <Box key={c.openId} sx={{ py: 0.5 }}>
                          <ContactLine c={c} />
                          <Stack direction="row" spacing={2} alignItems="center" sx={{ pl: 1 }}>
                            <Typography variant="caption" color="text.secondary">
                              本地账号：{c.matchedLocalOpenId}（按{c.matchedBy === 'name' ? '姓名' : '邮箱'}命中）
                            </Typography>
                            <RadioGroup
                              row
                              value={previewDecisions[c.openId] || 'skip'}
                              onChange={(e) => setPreviewDecisions((d) => ({ ...d, [c.openId]: e.target.value as Decision }))}
                            >
                              <FormControlLabel value="skip" control={<Radio size="small" />} label="跳过" />
                              <FormControlLabel value="merge" control={<Radio size="small" />} label="合并（回填飞书标识）" />
                            </RadioGroup>
                          </Stack>
                        </Box>
                      ))}
                    </Section>

                    {/* 新建 */}
                    <Section title="新建（库中无匹配，将建为待授权账号）" count={counts.fresh}>
                      {preview.buckets.fresh.map((c) => (
                        <ContactLine key={c.openId} c={c} />
                      ))}
                    </Section>

                    <Divider />
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="body2">新建账号初始状态：</Typography>
                      <RadioGroup row value={initialStatus} onChange={(e) => setInitialStatus(e.target.value as 'pending' | 'active')}>
                        <FormControlLabel value="pending" control={<Radio size="small" />} label="待授权" />
                        <FormControlLabel value="active" control={<Radio size="small" />} label="直接启用" />
                      </RadioGroup>
                    </Stack>
                  </>
                ) : (
                  <Stack spacing={1.5} alignItems="center" sx={{ py: 2, width: '100%' }}>
                    <Typography variant="body2" color="text.secondary" align="center">
                      全量拉取会读取整个通讯录（可能含未分部门的成员），建议优先用「按姓名搜索」定向导入。
                    </Typography>
                    <Button variant="outlined" startIcon={<CloudDownloadOutlinedIcon />} onClick={() => loadPreview()}>
                      加载全部通讯录
                    </Button>
                  </Stack>
                )}
              </Stack>
            )}

            {tab === 1 && (
              <Stack spacing={1.5}>
                <TextField
                  size="small"
                  fullWidth
                  placeholder="输入姓名或关键字搜索"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  InputProps={{ startAdornment: <SearchOutlinedIcon fontSize="small" style={{ marginRight: 6, opacity: 0.6 }} /> }}
                />
                {searchLoading ? (
                  <Box sx={{ textAlign: 'center', py: 2 }}><CircularProgress size={22} /></Box>
                ) : hits.length ? (
                  hits.map((h) => (
                    <Box key={h.openId} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}>
                      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                          <ContactLine c={h} />
                        </Box>
                        <FormControlLabel
                          control={<Checkbox size="small" checked={!!selected[h.openId]} onChange={(e) => setSelected((s) => ({ ...s, [h.openId]: e.target.checked }))} />}
                          label="导入"
                        />
                      </Stack>
                      {h.bucket === 'suspected' && (
                        <RadioGroup
                          row
                          value={searchDecisions[h.openId] || 'skip'}
                          onChange={(e) => setSearchDecisions((d) => ({ ...d, [h.openId]: e.target.value as Decision }))}
                        >
                          <FormControlLabel value="skip" control={<Radio size="small" />} label="跳过" />
                          <FormControlLabel value="merge" control={<Radio size="small" />} label="合并" />
                        </RadioGroup>
                      )}
                    </Box>
                  ))
                ) : query.trim() ? (
                  <Typography variant="body2" color="text.secondary">未搜索到结果</Typography>
                ) : null}
              </Stack>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={importing}>关闭</Button>
        {!result && tab === 0 && (
          <Button variant="contained" startIcon={<CloudDownloadOutlinedIcon />} onClick={() => void doImportFull()} disabled={importing || previewLoading || !preview || counts.definite + counts.suspected + counts.fresh === 0}>
            {importing ? '导入中…' : '确认导入'}
          </Button>
        )}
        {!result && tab === 1 && (
          <Button variant="contained" startIcon={<CloudDownloadOutlinedIcon />} onClick={() => void doImportSearch()} disabled={importing || searchLoading}>
            {importing ? '导入中…' : '导入选中'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

/** 带标题与计数的分组容器 */
function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }): JSX.Element {
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{title}（{count}）</Typography>
      <Stack spacing={0.5} divider={<Divider flexItem />}>
        {count ? children : <Typography variant="caption" color="text.secondary">无</Typography>}
      </Stack>
    </Box>
  );
}
