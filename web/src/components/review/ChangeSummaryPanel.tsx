import { useEffect, useState } from 'react';
import { Box, Stack, Typography } from '@mui/material';

import { api } from '@/api/client';
import type { Change } from '@/types/change';
import { CHANGE_TYPE_LABEL } from '@/config/enums';
import { alphaOf as alpha, tokens } from '@/theme/tokens';

/** 面板渲染所需的最小数据（变更单 + 已解析的里程碑名） */
interface PanelData {
  change: Change;
  /** 里程碑名；解析失败回落 targetId，无目标时为空串 */
  targetName: string;
}

/**
 * 模块级缓存：changeId → PanelData | null。
 * null 表示「已确认拉取失败」，用于避免同一变更单反复请求（审批列表可能同时渲染多张卡片）。
 */
const panelCache = new Map<string, PanelData | null>();

interface ChangeSummaryPanelProps {
  /** 变更单 id（通常取自 review.refId） */
  changeId: string;
}

/**
 * 变更详情面板（审批场景只读展示）
 *
 * 审批人需要看到「自己在批什么」：变更单号 / 类型 / 目标 / 影响分析 / 工作量 / 状态，
 * 里程碑改期类额外展示 `fromDate → toDate`。
 *
 * 降级策略：加载中与请求失败一律渲染 null，绝不阻塞或污染宿主（审批列表 / 审批弹窗）。
 *
 * @prd P0-14
 */
export function ChangeSummaryPanel({ changeId }: ChangeSummaryPanelProps): JSX.Element | null {
  const [data, setData] = useState<PanelData | null>(() => (changeId ? panelCache.get(changeId) ?? null : null));
  const [ready, setReady] = useState<boolean>(() => (changeId ? panelCache.has(changeId) : true));

  useEffect(() => {
    if (!changeId) {
      setData(null);
      setReady(true);
      return;
    }
    if (panelCache.has(changeId)) {
      setData(panelCache.get(changeId) ?? null);
      setReady(true);
      return;
    }

    let alive = true;
    setReady(false);
    void (async (): Promise<void> => {
      try {
        const change = await api.getChange(changeId);
        if (!change || !change.id) {
          panelCache.set(changeId, null);
          if (alive) {
            setData(null);
            setReady(true);
          }
          return;
        }
        /* 里程碑名解析：尽力而为，失败静默回落 targetId，不影响主信息展示 */
        let targetName = '';
        if (change.targetType === 'milestone' && change.targetId) {
          targetName = change.targetId;
          try {
            const milestones = await api.listMilestones(change.projectId);
            const hit = milestones.find((m) => m.id === change.targetId);
            if (hit && hit.name) targetName = hit.name;
          } catch {
            /* 忽略：仅丢失里程碑名 */
          }
        }
        const payload: PanelData = { change, targetName };
        panelCache.set(changeId, payload);
        if (alive) {
          setData(payload);
          setReady(true);
        }
      } catch {
        panelCache.set(changeId, null);
        if (alive) {
          setData(null);
          setReady(true);
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [changeId]);

  if (!ready || !data) return null;

  const { change, targetName } = data;
  const isMilestoneDate = change.changeType === 'milestone_date';
  const fromDate = change.payload?.fromDate ?? '';
  const toDate = change.payload?.toDate ?? '';
  const typeLabel = CHANGE_TYPE_LABEL[change.changeType] ?? change.changeType;

  return (
    <Box
      sx={{
        mt: 1.25,
        p: 1.5,
        borderRadius: 1,
        bgcolor: alpha(tokens.brand.primary, 0.05),
        border: `1px solid ${alpha(tokens.border.subtle, 0.9)}`,
      }}
    >
      <Typography variant="caption" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
        变更详情
      </Typography>

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary">
          {change.code || change.id}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          ·
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {typeLabel}
        </Typography>
        {change.targetType === 'milestone' && targetName && (
          <Typography variant="caption" color="text.secondary">
            · 目标：{targetName}
          </Typography>
        )}
      </Stack>

      {isMilestoneDate && (fromDate || toDate) && (
        <Typography variant="caption" sx={{ display: 'block', mb: 0.5 }}>
          计划日期：{fromDate || '—'} → {toDate || '—'}
        </Typography>
      )}

      {change.impactAnalysis && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          影响分析：{change.impactAnalysis}
        </Typography>
      )}

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        工作量 {change.effortDays} 人日 · 状态：{change.status}
      </Typography>
    </Box>
  );
}
