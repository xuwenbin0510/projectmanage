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
  LifecycleTemplate,
} from '@/types/project';
import type { WbsNode, WbsNodeType, WbsRules, TaskStatus, BoardConfig } from '@/types/wbs';
import type { Change, ChangeType, ChangeRoute, RouteResult } from '@/types/change';
import type { Review } from '@/types/review';
import type { ReportPayload } from '../contract';
import type { ReportValidation } from '@/types/report';
import {
  CCB_EFFORT_THRESHOLD,
  CLASSIFY_AMOUNT_THRESHOLD,
  REVIEW_TEMPLATES,
  GRANULARITY_LIMIT,
  DEFAULT_WBS_RULES,
  WBS_NODE_TYPE_LABEL,
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

/* ═══════════════════════════════════════════════════
 * WBS 层级规则（重构 D-2）—— Mock 引擎与 WbsPage 共用同一份纯函数
 *   引擎侧：createWbsNode / updateWbsNode / moveWbsNode 落地拦截
 *   页面侧：类型下拉动态过滤 + 提交前预校验，避免「先弹错再改」
 * ═══════════════════════════════════════════════════ */

/**
 * 取项目实际生效的 WBS 规则：`DEFAULT_WBS_RULES` 兜底 + 模板差异覆盖。
 * 传 null / undefined（模板缺失）时退化为纯缺省，保证任何调用点都拿得到完整规则。
 * @prd P0-06
 */
export function resolveWbsRules(template?: LifecycleTemplate | null): WbsRules {
  const override = template?.definition?.wbsRules;
  if (!override) return { ...DEFAULT_WBS_RULES, childTypes: { ...DEFAULT_WBS_RULES.childTypes } };
  return {
    maxDepth: override.maxDepth ?? DEFAULT_WBS_RULES.maxDepth,
    allowRootTask: override.allowRootTask ?? DEFAULT_WBS_RULES.allowRootTask,
    requireStageBinding: override.requireStageBinding ?? DEFAULT_WBS_RULES.requireStageBinding,
    skeleton: override.skeleton ?? DEFAULT_WBS_RULES.skeleton,
    childTypes: { ...DEFAULT_WBS_RULES.childTypes, ...(override.childTypes ?? {}) },
  };
}

/**
 * 某父节点下允许挂哪些子节点类型（页面类型下拉的唯一数据源）。
 * - `parent === null` 视为根层，额外受 `allowRootTask` 收敛
 * - 已达 `maxDepth` 时返回空数组（下拉为空 → 页面据此禁用「新建子节点」）
 */
export function allowedChildTypes(parent: WbsNode | null, rules: WbsRules): WbsNodeType[] {
  const targetLevel = parent ? parent.level + 1 : 1;
  if (targetLevel > rules.maxDepth) return [];
  const key: 'root' | WbsNodeType = parent ? parent.nodeType : 'root';
  const list = rules.childTypes[key] ?? [];
  if (!parent && !rules.allowRootTask) return list.filter((t) => t !== 'task');
  return [...list];
}

/**
 * 子树相对深度：节点自身记 0，其最深后代记 n。
 * 移动校验必须用它——否则「把 3 层子树移到第 3 层」可绕过 maxDepth。
 */
export function subtreeRelativeDepth(nodes: WbsNode[], nodeId: string): number {
  const childrenOf = new Map<string, WbsNode[]>();
  for (const n of nodes) {
    const key = n.parentId ?? '__root__';
    const arr = childrenOf.get(key);
    if (arr) arr.push(n);
    else childrenOf.set(key, [n]);
  }
  const walk = (id: string, guard: number): number => {
    if (guard > 64) return 0; // 防御性：脏数据成环时兜底，不递归爆栈
    const kids = childrenOf.get(id) ?? [];
    if (!kids.length) return 0;
    return 1 + Math.max(...kids.map((k) => walk(k.id, guard + 1)));
  };
  return walk(nodeId, 0);
}

/** 层级校验失败结果；`code` 直接对应 `ErrorCode` 中的四个新码 */
export interface WbsPlacementError {
  code: 'E_WBS_PARENT_TYPE' | 'E_WBS_DEPTH' | 'E_WBS_STAGE_UNBOUND';
  message: string;
  data: Record<string, unknown>;
}

export interface WbsPlacementInput {
  /** 待落位的节点类型 */
  nodeType: WbsNodeType;
  /** 目标父节点；null = 挂在根层 */
  parent: WbsNode | null;
  /** 工作分区绑定的生命周期阶段；仅 `nodeType==='stage'` 参与校验 */
  lifecycleStageId?: string | null;
  /** 被落位节点自身的子树相对深度（新建恒为 0；移动时传 subtreeRelativeDepth 结果） */
  subtreeDepth?: number;
}

/**
 * WBS 落位三连校验（R-1 深度 / R-2 父子类型 / R-6 工作分区绑阶段）。
 * 返回 null 表示放行；否则返回首个命中的错误。
 *
 * ⚠️ R-1 深度**先于** R-2 父子类型判定：`allowedChildTypes` 在达 `maxDepth` 时会返回空数组，
 *    若 R-2 先判会把「层级超限」误报为「父类型非法」。先判深度可保证 V-06/V-08
 *    深度违规稳定返回 `E_WBS_DEPTH`（含 move 的子树整体判定）。
 *
 * ⚠️ 规则**全部**来自 `rules` 参数（由 `resolveWbsRules(template)` 得到），
 *    本函数内不出现任何按项目类型分支的硬编码（决策 D-2）。
 * @prd P0-06
 */
export function validateWbsPlacement(
  input: WbsPlacementInput,
  rules: WbsRules,
): WbsPlacementError | null {
  const { nodeType, parent } = input;
  const subtreeDepth = input.subtreeDepth ?? 0;
  const targetLevel = parent ? parent.level + 1 : 1;
  const label = (t: WbsNodeType): string => WBS_NODE_TYPE_LABEL[t];

  /* ── R-1 最大深度（含被移动子树的整体高度） ─────── */
  const resultDepth = targetLevel + subtreeDepth;
  if (resultDepth > rules.maxDepth) {
    return {
      code: 'E_WBS_DEPTH',
      message: `层级将达到第 ${resultDepth} 层，超过上限 ${rules.maxDepth} 层`,
      data: { targetLevel, subtreeDepth, resultDepth, maxDepth: rules.maxDepth },
    };
  }

  /* ── R-2 父子类型 ─────────────────────────────── */
  const allowed = allowedChildTypes(parent, rules);
  if (!allowed.includes(nodeType)) {
    const parentDesc = parent ? `「${parent.wbsCode} ${parent.name}」(${label(parent.nodeType)})` : '根层';
    const allowDesc = allowed.length ? allowed.map(label).join(' / ') : '（无，已达层级上限）';
    return {
      code: 'E_WBS_PARENT_TYPE',
      message: `${parentDesc}下不允许创建「${label(nodeType)}」，允许的类型：${allowDesc}`,
      data: {
        parentId: parent?.id ?? null,
        parentType: parent?.nodeType ?? 'root',
        nodeType,
        allowed,
      },
    };
  }

  /* ── R-6 工作分区必须绑定生命周期阶段 ───────────── */
  if (nodeType === 'stage' && rules.requireStageBinding && !input.lifecycleStageId) {
    return {
      code: 'E_WBS_STAGE_UNBOUND',
      message: '工作分区必须选择「归属阶段」',
      data: { nodeType, lifecycleStageId: input.lifecycleStageId ?? null },
    };
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
