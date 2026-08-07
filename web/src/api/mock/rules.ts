import type {
  ClassifyInput,
  ClassifyResult,
  ProjectType,
  Project,
  Milestone,
  MilestoneStatus,
  MilestoneTaskStats,
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
import { isLeafNode, leafNodesOf, weightedProgress } from '@/utils/wbs';

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
  // SK-4：WIP 统计的是「干活单元」= 真叶子，不是 nodeType==='task'
  const current = nodes.filter(
    (n) => isLeafNode(nodes, n.id) && n.status === targetStatus && n.id !== movingNodeId,
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
 *
 * ⚠️ SK-4：只对**真叶子**告警。容器节点的估算是子树汇总值，超限属正常。
 * @param isLeaf 由调用方用 `isLeafNode(nodes, node.id)` 算出后传入
 */
export function granularityWarn(node: WbsNode, isLeaf: boolean, projectType: ProjectType): string | null {
  if (!isLeaf) return null;
  const limit = GRANULARITY_LIMIT[projectType];
  if (node.estimateDays > limit) {
    return `估算 ${node.estimateDays} 人日超过 ${projectType} 类上限 ${limit} 人日，建议继续拆分`;
  }
  return null;
}

/* ═══════════════════════════════════════════════════
 * 里程碑状态推导引擎（§2.5 · 时间 + 完成度双输入）
 *
 * ⚠️ SK-2：`Milestone.status` / `done` 是**派生值**，唯一真值 = `doneAt` +
 *    `statusOverride` 三元组。业务代码禁止直接写 `ms.status = ...`，
 *    一律经 `refreshMilestoneStatuses()`（`api/mock/index.ts`）落盘。
 * ═══════════════════════════════════════════════════ */

/**
 * 人工覆盖是否仍然有效（SK-7）。
 * 覆盖时快照了 `currentDate`；一旦改期，快照对不上 → 覆盖自动作废。
 */
export function isOverrideValid(ms: Milestone): boolean {
  return ms.statusOverride !== null && ms.overrideBaseDate === ms.currentDate;
}

/**
 * 里程碑的「起算日」（§2.5.4）：
 * 同项目里程碑按 `compareMilestones` 定序，取上一里程碑的 `currentDate`；
 * 首碑取 `project.planStart`。
 *
 * @param list 同项目全部里程碑（无需预排序）
 */
export function milestoneStartFrom(list: Milestone[], ms: Milestone, planStart: string): string {
  const sorted = sortMilestones(list);
  const idx = sorted.findIndex((m) => m.id === ms.id);
  if (idx <= 0) return planStart;
  return sorted[idx - 1].currentDate;
}

/** 里程碑排序 / 编号的**唯一**比较键（SK-M1） */
export type MilestoneOrderKey = Pick<Milestone, 'currentDate' | 'createdAt' | 'id'>;

/**
 * 里程碑确定性比较（SK-M1 · 排序与编号的**唯一真源**）。
 *
 * 排序键：`currentDate` 升序 → `createdAt` 升序 → `id` 自然序
 *
 * ⚠️ 三级 tie-break 缺一不可：
 * - `currentDate`：业务主序（时间轴）
 * - `createdAt`  ：同日时「先建的排前面」，符合直觉
 * - `id`         ：`createProject` 同批里程碑的 `createdAt` **完全相同**（F-4），
 *                  必须有终极键才能保证幂等；用 numeric localeCompare，
 *                  使 `P1-MS2` 正确排在 `P1-MS10` 之前
 *
 * 🚫 **禁止把 `code` 作为比较键** —— `code` 由 `renumberMilestones` 按本函数结果
 *    反写，引入 `code` 会形成 `sort → code → sort` 循环依赖（F-3），
 *    导致同日里程碑的顺序随历史脏值抖动，列表顺序与 M 编号自相矛盾。
 *
 * `sortMilestones`（读路径排序）与 `renumberMilestones`（写路径编号）**必须**共用本函数。
 */
export function compareMilestones(a: MilestoneOrderKey, b: MilestoneOrderKey): number {
  if (a.currentDate !== b.currentDate) return a.currentDate < b.currentDate ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id.localeCompare(b.id, 'en', { numeric: true });
}

/** 里程碑确定性排序（委托 `compareMilestones`，保持既有函数名与调用点不变 · SK-M1） */
export function sortMilestones<T extends MilestoneOrderKey>(list: T[]): T[] {
  return [...list].sort(compareMilestones);
}

export interface MilestoneDeriveContext {
  /** 今天 `YYYY-MM-DD` */
  today: string;
  /** 起算日，由 `milestoneStartFrom` 得出 */
  startFrom: string;
  /** 关联任务完成度，由 `milestoneTaskStats` 得出 */
  stats: MilestoneTaskStats;
}

/**
 * 里程碑状态五级优先链（§2.5.1，自上而下命中即定）：
 *
 * | 序 | 条件 | 结果 |
 * |---|---|---|
 * | P1 | 覆盖有效（`statusOverride` 且基线日未变） | `statusOverride` |
 * | P2 | `doneAt !== null` | 已达成 |
 * | P3 | `today > currentDate` | 已逾期 |
 * | P4 | 完成度 > 0% 或 `today >= startFrom` | 进行中 |
 * | P5 | 其余 | 未开始 |
 *
 * 不变量：`achieve` / `取消达成` / `改期` 三个动作一律清空 override 三元组，
 * 故 P1 与 P2 永不冲突。
 */
export function deriveMilestoneStatus(ms: Milestone, ctx: MilestoneDeriveContext): MilestoneStatus {
  /* P1 人工覆盖（改期后自动失效） */
  if (isOverrideValid(ms)) return ms.statusOverride as MilestoneStatus;
  /* P2 达成（唯一真值 doneAt） */
  if (ms.doneAt) return '已达成';
  /* P3 逾期：diffDays(today, currentDate) < 0 即 today > currentDate（SK-11） */
  if (diffDays(ctx.today, ms.currentDate) < 0) return '已逾期';
  /* P4 进行中：有任何完成度，或已过起算日（零任务挂载也会随时间自然启动） */
  if (ctx.stats.progress > 0 || diffDays(ctx.startFrom, ctx.today) >= 0) return '进行中';
  /* P5 未开始 */
  return '未开始';
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
    skeleton: override.skeleton ?? DEFAULT_WBS_RULES.skeleton,
    childTypes: { ...DEFAULT_WBS_RULES.childTypes, ...(override.childTypes ?? {}) },
  };
}

/**
 * 某父节点下允许挂哪些子节点类型（页面类型下拉的唯一数据源）。
 * - `parent === null` 视为根层，缺省规则下只允许「任务」
 * - 已达 `maxDepth` 时返回空数组（下拉为空 → 页面据此禁用「新建子节点」）
 * - 「子任务」的 `childTypes` 恒为 `[]` ⇒ 子任务下不会出现新建入口
 */
export function allowedChildTypes(parent: WbsNode | null, rules: WbsRules): WbsNodeType[] {
  const targetLevel = parent ? parent.level + 1 : 1;
  if (targetLevel > rules.maxDepth) return [];
  const key: 'root' | WbsNodeType = parent ? parent.nodeType : 'root';
  return [...(rules.childTypes[key] ?? [])];
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

/** 层级校验失败结果；`code` 直接对应 `ErrorCode` 中的两个层级码 */
export interface WbsPlacementError {
  code: 'E_WBS_PARENT_TYPE' | 'E_WBS_DEPTH';
  message: string;
  data: Record<string, unknown>;
}

export interface WbsPlacementInput {
  /** 待落位的节点类型 */
  nodeType: WbsNodeType;
  /** 目标父节点；null = 挂在根层 */
  parent: WbsNode | null;
  /** 被落位节点自身的子树相对深度（新建恒为 0；移动时传 subtreeRelativeDepth 结果） */
  subtreeDepth?: number;
}

/**
 * WBS 落位校验（简化后仅剩 2 条 · §2.4.2）：
 * - **W-1 深度上限**：`目标层级 + 被移动子树高度 ≤ maxDepth(4)` → `E_WBS_DEPTH`
 * - **W-2 父子类型**：根层只能是任务；任务下可挂任务 / 子任务；子任务下不可挂任何节点 → `E_WBS_PARENT_TYPE`
 *
 * 返回 null 表示放行；否则返回首个命中的错误。
 *
 * ⚠️ W-1 深度**先于** W-2 父子类型判定：`allowedChildTypes` 在达 `maxDepth` 时会返回空数组，
 *    若 W-2 先判会把「层级超限」误报为「父类型非法」。
 *
 * ⚠️ 规则**全部**来自 `rules` 参数（由 `resolveWbsRules(template)` 得到），
 *    本函数内不出现任何按项目类型分支的硬编码（决策 D-2 / SK-5）。
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

  /* ── W-1 最大深度（含被移动子树的整体高度） ─────── */
  const resultDepth = targetLevel + subtreeDepth;
  if (resultDepth > rules.maxDepth) {
    return {
      code: 'E_WBS_DEPTH',
      message: `层级将达到第 ${resultDepth} 层，超过上限 ${rules.maxDepth} 层`,
      data: { targetLevel, subtreeDepth, resultDepth, maxDepth: rules.maxDepth },
    };
  }

  /* ── W-2 父子类型（含「子任务必为叶」） ─────────── */
  const allowed = allowedChildTypes(parent, rules);
  if (!allowed.includes(nodeType)) {
    const parentDesc = parent ? `「${parent.wbsCode} ${parent.name}」(${label(parent.nodeType)})` : '根层';
    const allowDesc = allowed.length ? allowed.map(label).join(' / ') : '（无，子任务下不能再挂节点）';
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

  return null;
}

/** 截止日期约束失败结果 */
export interface WbsDeadlineError {
  code: 'E_WBS_DEADLINE_OVERFLOW';
  message: string;
  data: Record<string, unknown>;
}

/**
 * 子任务截止日期硬拦截（用户反馈③）：
 * - 有上级任务且上级有 dueDate：子节点 dueDate 不得晚于上级 dueDate
 * - 有关联里程碑：子节点 dueDate 不得晚于里程碑 currentDate
 * 任一上限被突破即拒绝，返回 `E_WBS_DEADLINE_OVERFLOW`。
 *
 * ⚠️ `diffDays(a, b) = dayjs(b).diff(dayjs(a))`，故「子晚于上限」等价于
 *    `diffDays(上限日期, dueDate) > 0`（注意参数顺序，曾因写反而失效）。
 *
 * 无上级日期且未关联里程碑（根层任务）→ 放行（无约束）。
 * @prd P0-06
 */
export function validateWbsDeadline(input: {
  dueDate: string;
  parent?: WbsNode | null;
  milestone?: Milestone | null;
}): WbsDeadlineError | null {
  const { dueDate, parent, milestone } = input;
  if (!dueDate) return null;

  if (parent?.dueDate && diffDays(parent.dueDate, dueDate) > 0) {
    return {
      code: 'E_WBS_DEADLINE_OVERFLOW',
      message: `截止日期 ${dueDate} 不能超过上级任务「${parent.wbsCode} ${parent.name}」的计划日期 ${parent.dueDate}`,
      data: { dueDate, parentDue: parent.dueDate, milestoneDue: milestone?.currentDate ?? null },
    };
  }
  if (milestone?.currentDate && diffDays(milestone.currentDate, dueDate) > 0) {
    return {
      code: 'E_WBS_DEADLINE_OVERFLOW',
      message: `截止日期 ${dueDate} 不能超过关联里程碑「${milestone.code} ${milestone.name}」的计划日期 ${milestone.currentDate}`,
      data: { dueDate, parentDue: parent?.dueDate ?? null, milestoneDue: milestone.currentDate },
    };
  }
  return null;
}

/** 工时估算上限失败结果 */
export interface WbsEstimateError {
  code: 'E_WBS_ESTIMATE_OVERFLOW';
  message: string;
  data: Record<string, unknown>;
}

/**
 * 工时估算硬拦截（用户反馈④b）：估算人日不得超过起止区间可用天数
 * （`dueDate - startDate`，按自然日计）。无日期或可用天数非正时放行，
 * 交由其它校验处理非法区间。
 * @prd P0-06
 */
export function validateWbsEstimate(input: {
  estimateDays: number;
  startDate: string;
  dueDate: string;
}): WbsEstimateError | null {
  const { estimateDays, startDate, dueDate } = input;
  if (!startDate || !dueDate) return null;
  const available = diffDays(startDate, dueDate); // dueDate - startDate（天）
  if (available <= 0) return null;
  if (estimateDays > available) {
    return {
      code: 'E_WBS_ESTIMATE_OVERFLOW',
      message: `工时估算 ${estimateDays} 人日，超过起止区间可用天数 ${available} 天（${startDate} → ${dueDate}）`,
      data: { estimateDays, startDate, dueDate, available },
    };
  }
  return null;
}

/** 项目整体进度：真叶子按估算工时加权（SK-4 口径） */
export function rollupProjectProgress(nodes: WbsNode[]): number {
  return weightedProgress(leafNodesOf(nodes));
}
