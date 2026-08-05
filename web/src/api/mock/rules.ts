import type {
  ClassifyInput,
  ClassifyResult,
  ProjectType,
  Project,
  Milestone,
  QualityGate,
  GateChecklistItem,
  CloseBlocker,
  Health,
} from '@/types/project';
import type { WbsNode, TaskStatus, BoardConfig } from '@/types/wbs';
import type { Change, ChangeType, ChangeRoute, RouteResult } from '@/types/change';
import type { Review } from '@/types/review';
import type { ReportPayload } from '../contract';
import type { ReportValidation } from '@/types/report';
import {
  CCB_EFFORT_THRESHOLD,
  CLASSIFY_AMOUNT_THRESHOLD,
  REVIEW_TEMPLATES,
  GRANULARITY_LIMIT,
} from '@/config/enums';
import { diffDays, today } from '@/utils/date';

/* ═══════════════════════════════════════════════════
 * 纯业务规则（Mock 引擎与页面预校验共用，服务端为准）
 * ═══════════════════════════════════════════════════ */

/**
 * 项目分类判定规则
 * @prd P0-01（修订：本质特征优先，合同额由硬规则降级为参考信号）
 *
 * 优先级链（自上而下，命中即返回）：
 *   1. C 类 —— 勾选「基础设施建设」：最高优先硬规则
 *   2. A 类 —— 勾选「包含硬件交付」或「需要客户正式验收」：交付本质，优先于自研
 *   3. B 类 —— 勾选「自研产品持续迭代」：产品本质，优先于合同金额
 *   4. 金额参考 —— 四项本质特征全未勾选且合同额 ≥ 阈值：建议 A 类（非硬规则）
 *   5. 默认 —— B 类（产品型）
 *
 * ⚠️ reasons 在 ProjectCreatePage 的分类建议区被直接用作 React key，
 *    任一执行路径内不得出现重复字符串（当前实现已保证）。
 */
export function classifyProject(input: ClassifyInput): ClassifyResult {
  const reasons: string[] = [];
  const amount = input.contractAmount;
  const bigAmount = amount >= CLASSIFY_AMOUNT_THRESHOLD;
  /** 交付本质特征：硬件交付 或 客户验收 */
  const hasDelivery = input.hasHardware || input.hasAcceptance;

  /* ── 1. C 类：基建型（最高优先硬规则） ───────────── */
  if (input.isInfrastructure) {
    reasons.push('勾选「基础设施建设」→ 判定为 C 类（基建型）');
    if (hasDelivery || input.isSelfIteration) {
      reasons.push('虽同时勾选了其他特征，但「基础设施建设」为最高优先硬规则，仍判定为 C 类');
    }
    if (bigAmount) {
      reasons.push(
        `合同额 ${amount} 万元 ≥ ${CLASSIFY_AMOUNT_THRESHOLD} 万，仅作参考信号，不改变 C 类判定`,
      );
    }
    return { suggested: 'C', reasons };
  }

  /* ── 2. A 类：交付型（硬件 / 客户验收，优先级高于自研） ─── */
  if (hasDelivery) {
    if (input.hasHardware) reasons.push('勾选「包含硬件交付」→ 指向 A 类（交付型）');
    if (input.hasAcceptance) reasons.push('勾选「需要客户正式验收」→ 指向 A 类（交付型）');
    if (input.isSelfIteration) {
      reasons.push(
        '同时勾选「自研产品持续迭代」，但交付特征（硬件交付 / 客户验收）体现项目本质，优先级更高 → A 类优先',
      );
    }
    reasons.push(
      bigAmount
        ? `合同额 ${amount} 万元 ≥ ${CLASSIFY_AMOUNT_THRESHOLD} 万，与 A 类判定一致（金额仅为参考信号）`
        : `合同额 ${amount} 万元 < ${CLASSIFY_AMOUNT_THRESHOLD} 万，但交付特征为硬规则 → 仍判定为 A 类（交付型）`,
    );
    return { suggested: 'A', reasons };
  }

  /* ── 3. B 类：产品型（自研迭代，优先于合同金额） ───── */
  if (input.isSelfIteration) {
    reasons.push('勾选「自研产品持续迭代」→ 判定为 B 类（产品型）');
    reasons.push('未勾选「包含硬件交付」「需要客户正式验收」「基础设施建设」，无交付 / 基建本质特征');
    if (bigAmount) {
      reasons.push(
        `提示：合同额 ${amount} 万元 ≥ ${CLASSIFY_AMOUNT_THRESHOLD} 万，但已按「自研产品持续迭代」判为 B 类（产品型）；` +
          '若该项目实际包含交付或客户验收环节，请确认分类，必要时手动改为 A 类并填写覆盖理由',
      );
    }
    return { suggested: 'B', reasons };
  }

  /* ── 4. 金额参考信号：无任何本质特征 + 大额 → 建议 A ─── */
  if (bigAmount) {
    reasons.push('未勾选硬件交付 / 客户验收 / 自研迭代 / 基础设施建设，无明确本质特征');
    reasons.push(
      `合同额 ${amount} 万元 ≥ ${CLASSIFY_AMOUNT_THRESHOLD} 万 → 建议按 A 类（交付型）管理`,
    );
    reasons.push('金额为参考信号而非硬性规则；若为纯自研或内部项目，可手动改为 B 类并填写覆盖理由');
    return { suggested: 'A', reasons };
  }

  /* ── 5. 默认：B 类（产品型） ─────────────────────── */
  reasons.push('未勾选硬件交付 / 客户验收 / 自研迭代 / 基础设施建设，无明确本质特征');
  reasons.push(
    `合同额 ${amount} 万元 < ${CLASSIFY_AMOUNT_THRESHOLD} 万，未触发大额参考信号 → 默认 B 类（产品型）`,
  );
  return { suggested: 'B', reasons };
}

/**
 * 变更路由判定
 * @prd P0-14
 * 命中任一即走 CCB：里程碑日期变更 / 需求基线变更 / 工作量 ≥ 3 人日
 */
export function routeOfChange(input: {
  changeType: ChangeType;
  effortDays: number;
  targetType: string;
}): RouteResult {
  const reasons: string[] = [];
  let route: ChangeRoute = 'pm_only';

  if (input.changeType === 'milestone_date') {
    route = 'ccb';
    reasons.push('变更类型为「里程碑日期」→ 必须走 CCB');
  }
  if (input.changeType === 'requirement_baseline') {
    route = 'ccb';
    reasons.push('变更类型为「需求基线」→ 必须走 CCB');
  }
  if (input.effortDays >= CCB_EFFORT_THRESHOLD) {
    route = 'ccb';
    reasons.push(`预计工作量 ${input.effortDays} 人日 ≥ ${CCB_EFFORT_THRESHOLD} 人日阈值 → 走 CCB`);
  }
  if (route === 'pm_only') {
    reasons.push(`未涉及基线且工作量 < ${CCB_EFFORT_THRESHOLD} 人日 → 由 PM 直接审批`);
  }

  const chain = route === 'ccb' ? REVIEW_TEMPLATES.ccb.chain : ['pm'];
  return { route, chain, reasons };
}

/**
 * 质量门是否满足决议条件：全部检查项已勾选
 * @prd P0-03
 */
export function gateReady(items: GateChecklistItem[]): { ready: boolean; unchecked: GateChecklistItem[] } {
  const unchecked = items.filter((i) => !i.checked);
  return { ready: unchecked.length === 0, unchecked };
}

/**
 * 里程碑单向规则：提前 / 保持允许直接改；延后必须走变更单
 * @prd P0-05
 */
export function milestoneDelayNeedsChange(current: Milestone, toDate: string): boolean {
  return diffDays(current.currentDate, toDate) > 0;
}

/**
 * WIP 限制检查
 * @prd P0-07
 * 返回 null 表示放行；否则返回超限信息（0 = 不限）
 */
export function checkWip(
  nodes: WbsNode[],
  config: BoardConfig,
  targetStatus: TaskStatus,
  movingNodeId: string,
): { limit: number; current: number } | null {
  const limit = config.wipLimits[targetStatus] ?? 0;
  if (!limit || limit <= 0) return null;
  const current = nodes.filter(
    (n) => n.nodeType === 'task' && n.status === targetStatus && n.id !== movingNodeId,
  ).length;
  if (current + 1 > limit) return { limit, current };
  return null;
}

/**
 * 周报提交强校验：风险行必须有责任人与截止日
 * @prd P0-08
 */
export function validateReport(payload: ReportPayload): ReportValidation {
  const invalidRiskRows: number[] = [];
  const messages: string[] = [];

  payload.risks.forEach((r, i) => {
    const noOwner = !r.owner || !r.owner.trim();
    const noDue = !r.dueDate || !r.dueDate.trim();
    const noDesc = !r.description || !r.description.trim();
    if (noOwner || noDue || noDesc) invalidRiskRows.push(i + 1);
    if (noDesc) messages.push(`第 ${i + 1} 条风险缺少描述`);
    if (noOwner) messages.push(`第 ${i + 1} 条风险缺少责任人`);
    if (noDue) messages.push(`第 ${i + 1} 条风险缺少截止日期`);
  });

  if (!payload.planItems.filter((p) => p.trim()).length) {
    messages.push('「下周计划」至少填写 1 条');
  }

  return { ok: messages.length === 0, invalidRiskRows, messages };
}

/**
 * 结项前置检查
 * @prd P0-17
 */
export function closeBlockers(
  project: Project,
  gates: QualityGate[],
  milestones: Milestone[],
  changes: Change[],
  reviews: Review[],
): CloseBlocker[] {
  const blockers: CloseBlocker[] = [];

  const openGates = gates.filter((g) => g.status !== '已通过' && g.status !== '有条件通过');
  openGates.forEach((g) => {
    blockers.push({ kind: 'gate', message: `质量门「${g.code} ${g.name}」尚未通过（当前：${g.status}）` });
  });

  const openMs = milestones.filter((m) => !m.done);
  openMs.forEach((m) => {
    blockers.push({ kind: 'milestone', message: `里程碑「${m.code} ${m.name}」尚未达成` });
  });

  changes
    .filter((c) => c.projectId === project.id && (c.status === '审批中' || c.status === '草稿'))
    .forEach((c) => {
      blockers.push({ kind: 'change', message: `变更单「${c.code} ${c.title}」尚未关闭（当前：${c.status}）` });
    });

  reviews
    .filter((r) => r.projectId === project.id && r.status === '审批中')
    .forEach((r) => {
      blockers.push({ kind: 'review', message: `评审「${r.title}」仍在审批中` });
    });

  return blockers;
}

/**
 * 健康度计算：红 = 存在逾期里程碑；黄 = 里程碑 7 天内到期或门待检；绿 = 其他
 * @prd P0-04
 */
export function computeHealth(milestones: Milestone[], gates: QualityGate[]): Health {
  const t = today();
  const overdue = milestones.some((m) => !m.done && diffDays(t, m.currentDate) < 0);
  if (overdue) return 'red';
  const dueSoon = milestones.some(
    (m) => !m.done && diffDays(t, m.currentDate) >= 0 && diffDays(t, m.currentDate) <= 7,
  );
  const gatePending = gates.some((g) => g.status === '待检查');
  if (dueSoon || gatePending) return 'yellow';
  return 'green';
}

/**
 * WBS 节点粒度告警（非阻塞）
 * @prd P0-06
 */
export function granularityWarn(node: WbsNode, projectType: ProjectType): string | null {
  if (node.nodeType !== 'task') return null;
  const limit = GRANULARITY_LIMIT[projectType];
  if (node.estimateDays > limit) {
    return `任务估算 ${node.estimateDays} 人日超过 ${projectType} 类上限 ${limit} 人日，建议继续拆分`;
  }
  return null;
}

/** 项目整体进度：叶子任务按估算工时加权 */
export function rollupProjectProgress(nodes: WbsNode[]): number {
  const leaves = nodes.filter((n) => n.nodeType === 'task');
  if (!leaves.length) return 0;
  const totalWeight = leaves.reduce((s, n) => s + (n.estimateDays || 1), 0);
  const done = leaves.reduce((s, n) => s + (n.estimateDays || 1) * (n.progress / 100), 0);
  return Math.round((done / totalWeight) * 100);
}
