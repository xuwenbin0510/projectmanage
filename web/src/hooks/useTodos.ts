import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { api } from '@/api/client';
import type { TodoItem, TodoGroup, TodoState, TodoType } from '@/types/todo';
import {
  TODO_TYPE_ORDER,
  TODO_TYPE_LABEL,
  TODO_TASK_TYPES,
  REVIEW_TYPE_LABEL,
} from '@/config/enums';
import { ROUTES } from '@/config/routes';

/**
 * 统一待办中心（B14-块3）数据聚合 Hook —— 瘦身为「动作闹钟」。
 *
 * ⚠️ 零后端新增原则：两类**动作型**待办**全部复用既有端点**，本 Hook 仅做并发聚合：
 *   ① `getWorkbench().myApprovals`     → APPROVAL（待我审批的评审）
 *   ② `listPendingConfirmation()`      → REPORT_CONFIRM（待我确认的周报，跨项目，服务端按 resolveConfirmers 过滤）
 *
 * 设计取舍（2026-08-26）：OVERDUE / BLOCKED / ASSIGNED（计划周期内的任务）三类**任务态**待办
 * 已从铃铛移出，统一收口到工作台面板（逾期 StatCard + 抽屉 / 进度环下钻 / 计划周期内面板），
 * 避免与工作台重复渲染；铃铛只保留「有人在等我动作」的推送式待办，红点 = 真正需我处理的条数。
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

    /* ① getWorkbench：APPROVAL 源 */
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
