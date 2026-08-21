import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { api } from '@/api/client';
import type { TodoItem, TodoGroup, TodoState, TodoType } from '@/types/todo';
import {
  TODO_TYPE_ORDER,
  TODO_TYPE_LABEL,
  TODO_TASK_TYPES,
  priorityRankOf,
  normalizePriority,
  REVIEW_TYPE_LABEL,
} from '@/config/enums';
import { ROUTES } from '@/config/routes';
import { isOverdue } from '@/utils/date';
import type { WbsNode } from '@/types/wbs';
import type { Review } from '@/types/review';

/**
 * 统一待办中心（B14-块3）数据聚合 Hook。
 *
 * ⚠️ 零后端新增原则：六源**全部复用既有端点**，本 Hook 仅做并发聚合：
 *   ① `getWorkbench()` 一次性覆盖 APPROVAL / REPORT_FILL / ASSIGNED / OVERDUE / BLOCKED
 *      - `myApprovals`    → APPROVAL
 *      - `reportReminders`（filled=false）→ REPORT_FILL（与 B12 overview.reportMissing 同源）
 *      - `myTasks`        → ASSIGNED / OVERDUE / BLOCKED
 *   ② `listPendingConfirmation()` → REPORT_CONFIRM（跨项目，服务端按 resolveConfirmers 过滤）
 *
 * 六源结构各异，统一压平为 `TodoItem` 后再按 `TodoType` 分组渲染（见 `types/todo.ts`）。
 * 部分源失败不阻断其余源（容错聚合），`error` 仅记录提示。
 */
export function useTodos(): TodoState {
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [groups, setGroups] = useState<TodoGroup[]>([]);

  const aggregate = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');

    const [wbRes, pcRes] = await Promise.allSettled([
      api.getWorkbench(),
      api.listPendingConfirmation(),
    ]);

    const items: TodoItem[] = [];
    const failures: string[] = [];

    /* ① getWorkbench：覆盖 5/6 源 */
    if (wbRes.status === 'fulfilled') {
      const wb = wbRes.value;

      // APPROVAL：待我审批的评审
      for (const r of wb.myApprovals) {
        items.push({
          id: `APPROVAL:${r.id}`,
          type: 'APPROVAL',
          title: r.title,
          subtitle: `${r.projectName} · ${REVIEW_TYPE_LABEL[r.reviewType]}`,
          projectId: r.projectId,
          projectName: r.projectName,
          priorityRank: -1,
          priority: null,
          dueDate: null,
          targetRoute: ROUTES.approvals,
          payload: { review: r } as Record<string, unknown>,
        });
      }

      // REPORT_FILL：待我填写的周报（未填写提醒）
      for (const rem of wb.reportReminders) {
        if (rem.filled) continue;
        items.push({
          id: `REPORT_FILL:${rem.projectId}:${rem.week}`,
          type: 'REPORT_FILL',
          title: `填写周报 ${rem.week}`,
          subtitle: rem.projectName,
          projectId: rem.projectId,
          projectName: rem.projectName,
          priorityRank: -1,
          priority: null,
          dueDate: rem.weekEnd || null,
          targetRoute: ROUTES.projectReports(rem.projectId),
          payload: { reminder: rem } as Record<string, unknown>,
        });
      }

      // ASSIGNED / OVERDUE / BLOCKED：我的任务
      for (const t of wb.myTasks as WbsNode[]) {
        if (t.status === '完成') continue;
        const rank = priorityRankOf(t.priority);
        const prio = normalizePriority(t.priority);
        const projectName = t.projectName ?? '';

        items.push({
          id: `ASSIGNED:${t.id}`,
          type: 'ASSIGNED',
          title: `${t.wbsCode} ${t.name}`,
          subtitle: `${projectName} · ${t.ownerName || '未指派'}`,
          projectId: t.projectId,
          projectName,
          priorityRank: rank,
          priority: prio,
          dueDate: t.dueDate || null,
          targetRoute: ROUTES.projectWbs(t.projectId),
          payload: { node: t } as Record<string, unknown>,
        });

        if (isOverdue(t.dueDate)) {
          items.push({
            id: `OVERDUE:${t.id}`,
            type: 'OVERDUE',
            title: `${t.wbsCode} ${t.name}`,
            subtitle: `${projectName} · 截止 ${t.dueDate}`,
            projectId: t.projectId,
            projectName,
            priorityRank: rank,
            priority: prio,
            dueDate: t.dueDate || null,
            targetRoute: ROUTES.projectWbs(t.projectId),
            payload: { node: t } as Record<string, unknown>,
          });
        }

        if (t.status === '阻塞') {
          items.push({
            id: `BLOCKED:${t.id}`,
            type: 'BLOCKED',
            title: `${t.wbsCode} ${t.name}`,
            subtitle: `${projectName} · 阻塞中`,
            projectId: t.projectId,
            projectName,
            priorityRank: rank,
            priority: prio,
            dueDate: t.dueDate || null,
            targetRoute: ROUTES.projectWbs(t.projectId),
            payload: { node: t } as Record<string, unknown>,
          });
        }
      }
    } else {
      failures.push('工作台数据加载失败');
    }

    /* ② listPendingConfirmation：待我确认的周报（跨项目聚合） */
    if (pcRes.status === 'fulfilled') {
      for (const r of pcRes.value) {
        items.push({
          id: `REPORT_CONFIRM:${r.id}`,
          type: 'REPORT_CONFIRM',
          title: `确认周报 ${r.week}`,
          subtitle: `${r.authorName}`,
          projectId: r.projectId,
          projectName: '',
          priorityRank: -1,
          priority: null,
          dueDate: null,
          targetRoute: ROUTES.projectReports(r.projectId),
          payload: { report: r } as Record<string, unknown>,
        });
      }
    } else {
      failures.push('待确认周报加载失败');
    }

    // 按 TODO_TYPE_ORDER 顺序分组，仅保留非空分组；组内同类型，按 priorityRank(任务类) / dueDate 升序
    const grouped: TodoGroup[] = TODO_TYPE_ORDER.map((type: TodoType) => ({
      type,
      label: TODO_TYPE_LABEL[type],
      items: items
        .filter((i) => i.type === type)
        .sort((a, b) => {
          // 任务类优先按优先级升序（P0 置顶）
          if (TODO_TASK_TYPES.includes(a.type) && TODO_TASK_TYPES.includes(b.type)) {
            const d = a.priorityRank - b.priorityRank;
            if (d !== 0) return d;
          }
          const da = a.dueDate ?? '9999-12-31';
          const db = b.dueDate ?? '9999-12-31';
          return da < db ? -1 : da > db ? 1 : 0;
        }),
    })).filter((g) => g.items.length > 0);

    setGroups(grouped);
    if (failures.length) setError(failures.join('；'));
    setLoading(false);
  }, []);

  // 挂载时聚合一次
  useEffect(() => {
    void aggregate();
  }, [aggregate]);

  // 路由切换后重新聚合：用户跳去处理某条待办（审批/填周报/改任务）再返回时，
  // 铃铛常驻不卸载，需靠路由变化触发 reload，使已处理的待办数字实时更新。
  const location = useLocation();
  useEffect(() => {
    void aggregate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const total = groups.reduce((sum, g) => sum + g.items.length, 0);

  return {
    total,
    groups,
    loading,
    error,
    reload: () => void aggregate(),
  };
}
