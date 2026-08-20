import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined';

import type { LifecycleTemplate, TemplateMilestone, TemplateGate, TemplateDocItem, TemplateTeamRule } from '@/types/project';
import { PROJECT_ROLES, PROJECT_ROLE_LABEL } from '@/config/enums';
import { api } from '@/api/client';
import { useToast } from '@/hooks';

/* ── 门编辑次级弹窗 ────────────────────────────────── */

interface GateForm {
  code: string;
  name: string;
  ownerRole: string;
  items: Array<{ content: string; ownerRole: string }>;
}

function GateEditor({
  open,
  gate,
  onClose,
  onSave,
}: {
  open: boolean;
  gate: GateForm | null;
  onClose: () => void;
  onSave: (g: GateForm) => void;
}): JSX.Element {
  const [form, setForm] = useState<GateForm>({ code: '', name: '', ownerRole: 'tl', items: [{ content: '', ownerRole: 'tl' }] });

  /* 每次打开时从外部 gate 初始化（新增 = 空表单） */
  useEffect(() => {
    if (!open) return;
    setForm(gate ? { code: gate.code, name: gate.name, ownerRole: gate.ownerRole, items: gate.items.map((x) => ({ ...x })) }
      : { code: '', name: '', ownerRole: 'tl', items: [{ content: '', ownerRole: 'tl' }] });
  }, [open, gate]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{gate ? '编辑质量门' : '添加质量门'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Stack direction="row" spacing={1.5}>
            <TextField
              label="门编码（必填）"
              size="small"
              fullWidth
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              helperText="如 QC1"
            />
            <TextField
              label="门名称（必填）"
              size="small"
              fullWidth
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Stack>
          <TextField
            label="默认责任角色"
            size="small"
            select
            fullWidth
            value={form.ownerRole}
            onChange={(e) => setForm({ ...form, ownerRole: e.target.value })}
          >
            {['pm', 'tl', 'qa', 'po', 'cm', 'pmo', 'management'].map((r) => (
              <MenuItem key={r} value={r}>
                {r}
              </MenuItem>
            ))}
          </TextField>
          <Divider />
          <Typography variant="caption" color="text.secondary">
            检查项清单（至少一项）
          </Typography>
          {form.items.map((it, i) => (
            <Stack key={i} direction="row" spacing={1} alignItems="center">
              <TextField
                size="small"
                fullWidth
                placeholder="检查项内容"
                value={it.content}
                onChange={(e) => {
                  const items = form.items.map((x, j) => (j === i ? { ...x, content: e.target.value } : x));
                  setForm({ ...form, items });
                }}
              />
              <TextField
                size="small"
                select
                sx={{ width: 120 }}
                value={it.ownerRole}
                onChange={(e) => {
                  const items = form.items.map((x, j) => (j === i ? { ...x, ownerRole: e.target.value } : x));
                  setForm({ ...form, items });
                }}
              >
                {['pm', 'tl', 'qa', 'po', 'cm', 'pmo', 'management'].map((r) => (
                  <MenuItem key={r} value={r}>
                    {r}
                  </MenuItem>
                ))}
              </TextField>
              <IconButton
                size="small"
                onClick={() => setForm({ ...form, items: form.items.filter((_, j) => j !== i) })}
              >
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Stack>
          ))}
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={() => setForm({ ...form, items: [...form.items, { content: '', ownerRole: form.ownerRole }] })}
          >
            添加检查项
          </Button>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose}>
          取消
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={!form.code.trim() || !form.name.trim() || form.items.length === 0 || form.items.some((x) => !x.content.trim())}
          onClick={() => {
            onSave({ ...form, code: form.code.trim(), name: form.name.trim() });
          }}
        >
          保存
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/* ── 模板编辑抽屉 ──────────────────────────────────── */

export interface TemplateEditorDialogProps {
  open: boolean;
  template: LifecycleTemplate | null;
  onClose: () => void;
  onSaved: (t: LifecycleTemplate) => void;
}

/**
 * 生命周期模板编辑抽屉（阶段三）。
 * 编辑「名称 / 里程碑（含内嵌质量门）/ 交付物」，保存时整包提交 definition（保留 wbsRules）。
 */
export function TemplateEditorDialog({ open, template, onClose, onSaved }: TemplateEditorDialogProps): JSX.Element {
  const toast = useToast();
  const [name, setName] = useState('');
  const [milestones, setMilestones] = useState<TemplateMilestone[]>([]);
  const [docs, setDocs] = useState<TemplateDocItem[]>([]);
  const [wbsRules, setWbsRules] = useState<LifecycleTemplate['definition']['wbsRules']>(undefined);
  /** 团队角色约束（可选；缺省回落系统默认 PM/TL 各1 + B 类 PO 1） */
  const [team, setTeam] = useState<TemplateTeamRule[]>([]);
  const [gateFor, setGateFor] = useState<number | null>(null); // 正在编辑门的里程碑下标
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  /* 打开时从 template 初始化 */
  const initFrom = (t: LifecycleTemplate | null): void => {
    if (!t) return;
    setName(t.name);
    setMilestones(t.definition.milestones.map((m) => ({
      code: m.code,
      name: m.name,
      offsetDays: m.offsetDays,
      required: m.required,
      gate: m.gate ? { ...m.gate, items: m.gate.items.map((x) => ({ ...x })) } : undefined,
    })));
    setDocs(t.definition.docs.map((d) => ({ name: d.name, milestoneCode: d.milestoneCode })));
    setWbsRules(t.definition.wbsRules);
    setTeam((t.definition.team ?? []).map((r) => ({ role: r.role, min: r.min, max: r.max })));
    setTouched(false);
  };

  /* open 打开时从 template 初始化 */
  useEffect(() => {
    if (open && template) initFrom(template);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template]);

  const setMs = (i: number, patch: Partial<TemplateMilestone>): void => {
    setMilestones((list) => list.map((m, j) => (j === i ? { ...m, ...patch } : m)));
    setTouched(true);
  };
  const setDoc = (i: number, patch: Partial<TemplateDocItem>): void => {
    setDocs((list) => list.map((d, j) => (j === i ? { ...d, ...patch } : d)));
    setTouched(true);
  };

  const save = async (): Promise<void> => {
    if (!template) return;
    setSaving(true);
    try {
      const definition: LifecycleTemplate['definition'] = {
        milestones: milestones.map((m) => ({
          code: m.code.trim(),
          name: m.name.trim(),
          offsetDays: Number(m.offsetDays) || 0,
          required: m.required !== false,
          gate: m.gate ? {
            code: m.gate.code.trim(),
            name: m.gate.name.trim(),
            ownerRole: m.gate.ownerRole,
            items: m.gate.items.map((x) => ({ content: x.content.trim(), ownerRole: x.ownerRole })),
          } : undefined,
        })),
        docs: docs.map((d) => ({ name: d.name.trim(), milestoneCode: d.milestoneCode.trim() })),
        wbsRules,
        team: team.map((r) => ({ role: r.role, min: Number(r.min) || 0, max: Number(r.max) === -1 ? -1 : Number(r.max) || 0 })),
      };
      const updated = await api.updateTemplate(template.id, {
        name: name.trim(),
        definition,
      });
      toast.success(`已保存「${updated.name}」`);
      onSaved(updated);
      /* 保存成功后自动关闭编辑窗口（用户反馈） */
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog open={open} onClose={() => !saving && onClose()} maxWidth="md" fullWidth>
        <DialogTitle>
          {template ? `编辑模板 · ${template.name}（v${template.version}）` : '编辑模板'}
          {template && <Chip size="small" variant="outlined" label={template.projectType} sx={{ ml: 1 }} />}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={3} sx={{ pt: 0.5 }}>
            {/* 基本信息 */}
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>基本信息</Typography>
              <TextField
                label="模板名称"
                size="small"
                fullWidth
                value={name}
                onChange={(e) => { setName(e.target.value); setTouched(true); }}
              />
            </Box>

            {/* 里程碑（含质量门） */}
            <Box>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                <Typography variant="subtitle2">里程碑骨架</Typography>
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={() => {
                    setMilestones((list) => [...list, { code: `M${list.length + 1}`, name: '', offsetDays: 0, required: true }]);
                    setTouched(true);
                  }}
                >
                  添加里程碑
                </Button>
              </Stack>
              <Stack spacing={1}>
                {milestones.map((m, i) => (
                  <Stack key={i} direction="row" spacing={1} alignItems="center" sx={{ borderBottom: '1px dashed', borderColor: 'divider', pb: 1 }}>
                    <TextField
                      size="small"
                      sx={{ width: 90 }}
                      label="编码"
                      value={m.code}
                      onChange={(e) => setMs(i, { code: e.target.value })}
                    />
                    <TextField
                      size="small"
                      fullWidth
                      label="名称"
                      value={m.name}
                      onChange={(e) => setMs(i, { name: e.target.value })}
                    />
                    <TextField
                      size="small"
                      type="number"
                      sx={{ width: 100 }}
                      label="天数偏移"
                      value={m.offsetDays}
                      onChange={(e) => setMs(i, { offsetDays: Number(e.target.value) })}
                    />
                    <FormControlLabel
                      control={
                        <Switch
                          size="small"
                          checked={m.required !== false}
                          onChange={(e) => setMs(i, { required: e.target.checked })}
                        />
                      }
                      label={<Typography variant="caption">必达</Typography>}
                    />
                    <Tooltip title={m.gate ? '编辑质量门' : '添加质量门'}>
                      <IconButton
                        size="small"
                        color={m.gate ? 'primary' : 'default'}
                        onClick={() => setGateFor(i)}
                      >
                        <VerifiedOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <IconButton size="small" onClick={() => setMilestones((list) => list.filter((_, j) => j !== i))}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                ))}
                {milestones.length === 0 && (
                  <Typography variant="caption" color="text.secondary">暂无里程碑，点击「添加里程碑」</Typography>
                )}
              </Stack>
            </Box>

            {/* 交付物 */}
            <Box>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                <Typography variant="subtitle2">交付物清单</Typography>
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={() => {
                    setDocs((list) => [...list, { name: '', milestoneCode: '' }]);
                    setTouched(true);
                  }}
                >
                  添加交付物
                </Button>
              </Stack>
              <Stack spacing={1}>
                {docs.map((d, i) => (
                  <Stack key={i} direction="row" spacing={1} alignItems="center">
                    <TextField
                      size="small"
                      fullWidth
                      label="交付物名称"
                      value={d.name}
                      onChange={(e) => setDoc(i, { name: e.target.value })}
                    />
                    <TextField
                      size="small"
                      select
                      sx={{ width: 180 }}
                      label="所属里程碑"
                      value={d.milestoneCode}
                      onChange={(e) => setDoc(i, { milestoneCode: e.target.value })}
                    >
                      <MenuItem value="">（不挂载）</MenuItem>
                      {milestones.map((m) => (
                        <MenuItem key={m.code} value={m.code}>{m.code}</MenuItem>
                      ))}
                    </TextField>
                    <IconButton size="small" onClick={() => setDocs((list) => list.filter((_, j) => j !== i))}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                ))}
                {docs.length === 0 && (
                  <Typography variant="caption" color="text.secondary">暂无交付物，点击「添加交付物」</Typography>
                )}
              </Stack>
            </Box>

            {/* 团队角色约束 */}
            <Box>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
                <Typography variant="subtitle2">团队角色约束</Typography>
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={() => {
                    setTeam((list) => [...list, { role: 'member', min: 0, max: -1 }]);
                    setTouched(true);
                  }}
                >
                  添加规则
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                建项向导按此约束校验团队组成（至少 / 至多人数）；不配置则按系统默认：PM、TL 各 1 人，B 类另需 PO 1 人。
              </Typography>
              <Stack spacing={1}>
                {team.map((r, i) => (
                  <Stack key={i} direction="row" spacing={1} alignItems="center">
                    <TextField
                      size="small"
                      select
                      sx={{ width: 150 }}
                      label="角色"
                      value={r.role}
                      onChange={(e) => {
                        setTeam((list) => list.map((x, j) => (j === i ? { ...x, role: e.target.value as TemplateTeamRule['role'] } : x)));
                        setTouched(true);
                      }}
                    >
                      {PROJECT_ROLES.map((rl) => (
                        <MenuItem key={rl} value={rl}>{PROJECT_ROLE_LABEL[rl]}</MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      size="small"
                      type="number"
                      sx={{ width: 100 }}
                      label="至少"
                      value={r.min}
                      onChange={(e) => {
                        setTeam((list) => list.map((x, j) => (j === i ? { ...x, min: Number(e.target.value) } : x)));
                        setTouched(true);
                      }}
                    />
                    <TextField
                      size="small"
                      type="number"
                      sx={{ width: 130 }}
                      label="至多（-1=不限）"
                      value={r.max}
                      onChange={(e) => {
                        setTeam((list) => list.map((x, j) => (j === i ? { ...x, max: Number(e.target.value) } : x)));
                        setTouched(true);
                      }}
                    />
                    <IconButton
                      size="small"
                      onClick={() => {
                        setTeam((list) => list.filter((_, j) => j !== i));
                        setTouched(true);
                      }}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                ))}
                {team.length === 0 && (
                  <Typography variant="caption" color="text.secondary">
                    未配置团队约束，建项向导使用系统默认规则（PM/TL 各 1 人，B 类另需 PO 1 人）。
                  </Typography>
                )}
              </Stack>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={onClose} disabled={saving}>取消</Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => void save()}
            disabled={saving || !name.trim() || milestones.some((m) => !m.code.trim() || !m.name.trim()) || docs.some((d) => !d.name.trim()) || team.some((r) => r.min < 0 || (r.max !== -1 && r.max < r.min))}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* 门编辑次级弹窗 */}
      <GateEditor
        open={gateFor !== null}
        gate={gateFor !== null ? (milestones[gateFor]?.gate ?? null) : null}
        onClose={() => setGateFor(null)}
        onSave={(g) => {
          if (gateFor !== null) {
            setMilestones((list) => list.map((m, j) => (j === gateFor ? { ...m, gate: g as TemplateGate } : m)));
            setTouched(true);
          }
          setGateFor(null);
        }}
      />
    </>
  );
}
