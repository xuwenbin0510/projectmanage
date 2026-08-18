import type { Paged } from '@/types/api';
import { ApiError, ErrorCode } from '@/types/api';
import type {
  User,
  GlobalRole,
  Project,
  ProjectListItem,
  ProjectMember,
  ProjectRole,
  ProjectStatus,
  ProjectType,
  ClassifyInput,
  ClassifyResult,
  LifecycleTemplate,
  Milestone,
  MilestoneWithGate,
  QualityGate,
  GateChecklistItem,
  CloseBlocker,
} from '@/types/project';
import type { WbsNode, TaskStatus, BoardConfig, BoardView, BoardColumn } from '@/types/wbs';
import { BOARD_COLUMNS } from '@/types/wbs';
import type { Report, ReportTaskRow, ReportRisk } from '@/types/report';
import type { EffortReport, EffortSummary, EffortReportRow, EffortBreakdownItem } from '@/types/effort';
import type { Review, ReviewStep, Approval } from '@/types/review';
import type { Change, RouteResult } from '@/types/change';
import type { AuditLog, AuditDiffEntry, Risk, ProjectDocument, UploadDocumentPayload } from '@/types/audit';
import type { WorkbenchData, ReportReminder, Session } from '@/types/workbench';
import type {
  DashboardOverview,
  DashboardOverviewQuery,
  DashboardScope,
  DashboardTaskRow,
  DashboardTasksQuery,
  OverdueBucket,
  OwnerLoadProjectRow,
  OwnerLoadRow,
  ReportMissingRow,
  StatusDonutSegment,
} from '@/types/dashboard';
import type {
  ApiClient,
  ProjectQuery,
  CreateProjectPayload,
  UpdateProjectPayload,
  GateDecisionPayload,
  MilestoneCreatePayload,
  MilestoneUpdatePayload,
  CreateMilestoneSpec,
  WbsNodePayload,
  ReportPayload,
  CreateReviewPayload,
  DecisionPayload,
  ChangePayloadInput,
  AuditQuery,
  MetaData,
} from '../contract';
import { getDb, saveDb, resetDb } from './db';
import type { MockDb } from './db';
import { delay } from './delay';
import {
  classifyProject,
  routeOfChange,
  gateReady,
  milestoneDelayNeedsChange,
  checkWip,
  validateReport,
  closeBlockers,
  computeHealth,
  rollupProjectProgress,
  resolveWbsRules,
  validateWbsPlacement,
  validateWbsDeadline,
  validateWbsEstimate,
  subtreeRelativeDepth,
  deriveMilestoneStatus,
  milestoneStartFrom,
  sortMilestones,
  compareMilestones,
  syncNodeStatusFromProgress,
} from './rules';
import {
  PROJECT_TRANSITIONS,
  PROJECT_STATUSES,
  REVIEW_TEMPLATES,
  DEFAULT_WIP_LIMIT,
  WEEK_ACTUAL_DAYS_MAX,
  EFFORT_DAYS_CUM_MAX,
  AUDIT_ACTION_LABEL,
  GATE_PASSED_STATUSES,
  DEFAULT_PRIORITY,
  normalizePriority,
  REJECT_REASON_MAX,
  TASK_STATUSES,
} from '@/config/enums';
import {
  aggregateHealth,
  aggregateOverdue,
  aggregatePriorityDistribution,
  aggregateStatusDist,
  aggregateOverdueDuration,
  overdueBucketOf,
} from '@/utils/dashboardAgg';
import { canDo } from '@/config/permissions';
import { addDays, today, nowIso, diffDays, weekCode, weekRange, fitMilestoneDates } from '@/utils/date';
import { genId, deepClone } from '@/utils/format';
import {
  compareWbsCode,
  nextChildCode,
  leafNodesOf,
  isLeafNode,
  parentIdSet,
  milestoneTaskStats,
  rollupProgressFlat,
} from '@/utils/wbs';

/* ═══════════════════════════════════════════════════
 * 内存 Mock 引擎：实现 ApiClient 全部方法
 * 与真实 HTTP 实现签名一致，页面零改动切换
 * ═══════════════════════════════════════════════════ */

const MOCK_TOKEN_PREFIX = 'mock-token-';
const ROLE_FALLBACK_ORDER: GlobalRole[] = ['pmo', 'management', 'tl', 'qa', 'cm', 'po', 'pm'];

/**
 * B12 决策 ⑥：全局总览统计基线 —— 在管三态。
 * ⚠ 与 `server/services/dashboard.service.js#MANAGED_STATUSES` 逐字一致。
 */
const DASHBOARD_MANAGED_STATUSES: ProjectStatus[] = ['已批准', '进行中', '挂起'];

/** B12 明细表默认页大小（与服务端 `DEFAULT_PAGE_SIZE` 一致） */
const DASHBOARD_PAGE_SIZE = 20;

/** B12 明细表页大小上限（与服务端 `MAX_PAGE_SIZE` 一致） */
const DASHBOARD_MAX_PAGE_SIZE = 200;

/** B12 未分配负责人展示名（与 `server/lib/portfolioAgg.js#UNASSIGNED_LABEL` 一致） */
const DASHBOARD_UNASSIGNED_LABEL = '未分配';

/** B12 项目名缺失占位（与 `server/lib/portfolioAgg.js#UNNAMED_PROJECT` 一致） */
const DASHBOARD_UNNAMED_PROJECT = '未命名项目';

/** B12 明细表健康度排序权重：红 → 黄 → 绿（问题优先） */
const DASHBOARD_HEALTH_RANK: Record<string, number> = { red: 0, yellow: 1, green: 2 };

function nf(): never {
  throw new ApiError(ErrorCode.E_NOT_FOUND);
}

/**
 * B8（与后端 `server/lib/wbs.js#decorateEffort` 同口径）：工时读时汇总。
 * `effortHours` 恒指「累计实际工时（人日）」：叶子=历次已提交日志累加存储值（缺省 0）；
 * 父=Σ直接子节点；补充 effortChildCount（直接子节点数）。
 * 返回**新数组**，不改入参。Mock 与真实后端出参形态保持一致。
 */
function decorateEffort(nodes: WbsNode[]): WbsNode[] {
  const childrenOf = new Map<string, WbsNode[]>();
  for (const n of nodes) {
    const key = n.parentId ?? '__root__';
    const arr = childrenOf.get(key);
    if (arr) arr.push(n);
    else childrenOf.set(key, [n]);
  }
  const memo = new Map<string, { effortHours: number; effortChildCount: number }>();
  const compute = (n: WbsNode, guard: number): { effortHours: number; effortChildCount: number } => {
    if (guard > 64) return { effortHours: Number(n.effortHours) || 0, effortChildCount: 0 };
    const cached = memo.get(n.id);
    if (cached) return cached;
    const kids = childrenOf.get(n.id) ?? [];
    const effortHours = kids.length
      ? kids.reduce((s, k) => s + compute(k, guard + 1).effortHours, 0)
      : (Number(n.effortHours) || 0);
    const result = { effortHours, effortChildCount: kids.length };
    memo.set(n.id, result);
    return result;
  };
  return nodes.map((n) => {
    const r = compute(n, 0);
    return { ...n, effortHours: r.effortHours, effortChildCount: r.effortChildCount };
  });
}

/**
 * B8（D4）工时写通道守卫（与后端 assertEffortWriteDisabled 同口径）：
 * 任意 WBS 写（create/update）携带 effortHours → E_WBS_EFFORT_WRITE_DISABLED。
 * 工时唯一写入方 = 工作日志 submit / 已提交日志编辑（upsertReport / updateReport）。
 */
function assertEffortWriteDisabled(payload: object): void {
  const p = payload as { effortHours?: unknown };
  if (p.effortHours !== undefined) {
    throw new ApiError(ErrorCode.E_WBS_EFFORT_WRITE_DISABLED, '工时登记已移至工作日志，WBS 不再支持填写工时', {});
  }
}

/**
 * B8（R5）日志行 actualDays 校验（与后端 resolveTaskRefs 同口径，仅勾选叶子可携带）：
 * - 0 ≤ v ≤ WEEK_ACTUAL_DAYS_MAX、最多 2 位小数（非法 → E_VALIDATION）
 * - 未勾选携带 → E_VALIDATION（拒绝）
 * - 有子节点（父节点）携带 → E_VALIDATION（拒绝）
 */
function assertActualDaysValid(t: { nodeId: string; selected: boolean; actualDays?: number }, isParent: boolean): void {
  if (t.actualDays === undefined) return;
  const v = Number(t.actualDays);
  if (!Number.isFinite(v) || v < 0 || v > WEEK_ACTUAL_DAYS_MAX || Math.round(v * 100) / 100 !== v) {
    throw new ApiError(
      ErrorCode.E_VALIDATION,
      `本周实际工时（人日）须为 0~${WEEK_ACTUAL_DAYS_MAX} 的数字，最多 2 位小数`,
      { nodeId: t.nodeId, fields: { actualDays: '非法取值' } },
    );
  }
  if (!t.selected) {
    throw new ApiError(ErrorCode.E_VALIDATION, '未勾选的任务不能登记本周实际工时（人日）', { nodeId: t.nodeId, actualDays: t.actualDays });
  }
  if (isParent) {
    throw new ApiError(ErrorCode.E_VALIDATION, '父节点不可登记本周实际工时（人日），请在具体子任务上登记', { nodeId: t.nodeId });
  }
}

/** 取当前会话用户，未登录抛 E_UNAUTHORIZED */
function currentUser(db: MockDb): User {
  if (!db.sessionOpenId) throw new ApiError(ErrorCode.E_UNAUTHORIZED, undefined, undefined, 401);
  const u = db.users.find((x) => x.openId === db.sessionOpenId);
  if (!u) throw new ApiError(ErrorCode.E_UNAUTHORIZED, undefined, undefined, 401);
  return u;
}

/** 当前用户在指定项目的角色集合 */
function projectRolesOf(db: MockDb, projectId: string, openId: string): ProjectRole[] {
  return db.members.filter((m) => m.projectId === projectId && m.userOpenId === openId).map((m) => m.projectRole);
}

/** 引擎内部动作别名 → config/permissions.ts 的 action key */
const ACTION_KEY: Record<string, string> = {
  'project.create': 'project:create',
  'project.edit': 'project:edit',
  'project.transition': 'project:transition',
  'member.manage': 'project:member:assign',
  'gate.check': 'gate:item:check',
  'gate.decide': 'gate:decide',
  'milestone.edit': 'milestone:edit',
  'wbs.edit': 'wbs:edit',
  'task.move': 'task:status',
  'board.config': 'board:config',
  'report.write': 'report:write',
  'review.create': 'review:start',
  'change.create': 'change:create',
  'change.apply': 'change:submit',
  'user.manage': 'admin:user:role',
};

/** 权限断言（前端镜像；真实实现由服务端把关） */
function assertCan(db: MockDb, alias: string, projectId?: string): User {
  const action = ACTION_KEY[alias] ?? alias;
  const me = currentUser(db);
  const roles = projectId ? projectRolesOf(db, projectId, me.openId) : [];
  if (!canDo(me.globalRole, action, roles)) {
    throw new ApiError(ErrorCode.E_FORBIDDEN, undefined, undefined, 403);
  }
  return me;
}

/** 已结项项目只读 */
function assertWritable(db: MockDb, projectId: string): Project {
  const p = db.projects.find((x) => x.id === projectId) ?? nf();
  if (p.status === '已结项' || p.status === '已终止') {
    throw new ApiError(ErrorCode.E_PROJECT_ARCHIVED);
  }
  return p;
}

/** 取项目生效的生命周期模板（WBS 规则解析用）；找不到返回 null，调用方回落 DEFAULT_WBS_RULES */
function projectTemplateOf(db: MockDb, projectId: string): LifecycleTemplate | null {
  const p = db.projects.find((x) => x.id === projectId);
  if (!p) return null;
  return db.templates.find((t) => t.id === p.templateId) ?? null;
}

/**
 * 校验引用的里程碑属于同一项目，否则抛 E_VALIDATION。
 * 方案一删除阶段实体后，跨表引用只剩「里程碑」一种。
 */
function assertSameProjectMilestone(
  db: MockDb,
  projectId: string,
  refId: string | null | undefined,
): void {
  if (!refId) return;
  const ms = db.milestones.find((m) => m.id === refId);
  if (!ms || ms.projectId !== projectId) {
    throw new ApiError(ErrorCode.E_VALIDATION, '关联里程碑不存在或不属于当前项目', { refId });
  }
}

/** 写审计日志 */
function audit(
  db: MockDb,
  actor: User,
  entityType: AuditLog['entityType'],
  entityId: string,
  action: AuditLog['action'],
  projectId: string,
  summary: string,
  diff: AuditDiffEntry[] = [],
): void {
  const project = db.projects.find((p) => p.id === projectId);
  db.auditLogs.unshift({
    id: genId('AL'),
    projectId,
    projectName: project?.name ?? '',
    entityType,
    entityId,
    action,
    actorOpenId: actor.openId,
    actorName: actor.name,
    before: null,
    after: null,
    diff,
    summary: summary || AUDIT_ACTION_LABEL[action],
    createdAt: nowIso(),
  });
}

/**
 * 项目列表行聚合（§3.2 / N-5）
 * 「走到第几步」由「下一里程碑 + 已过 N/M 道门」表达，不再有「当前阶段」。
 */
function toListItem(db: MockDb, p: Project): ProjectListItem {
  const pm = db.members.find((m) => m.projectId === p.id && m.projectRole === 'pm');
  const ms = sortMilestones(db.milestones.filter((m) => m.projectId === p.id));
  const gates = db.gates.filter((g) => g.projectId === p.id);
  const nodes = db.wbsNodes.filter((n) => n.projectId === p.id);
  /* 下一个未达成里程碑（确定性排序后首个 !done） */
  const next = ms.find((m) => !m.done) ?? null;
  /* 当前门 = 下一里程碑挂载的门；无下一碑或该碑无门 → 空 */
  const gate = next ? gates.find((g) => g.milestoneId === next.id) ?? null : null;
  const risks = db.risks.filter((r) => r.projectId === p.id && r.riskValue >= 12);

  return {
    ...p,
    pmName: pm?.userName ?? '—',
    nextMilestoneCode: next?.code ?? '',
    nextMilestoneName: next?.name ?? '',
    currentGateCode: gate?.code ?? '',
    currentGateStatus: gate?.status ?? '未开始',
    gatePassed: gates.filter((g) => GATE_PASSED_STATUSES.includes(g.status)).length,
    gateTotal: gates.length,
    progress: p.status === '已结项' ? 100 : rollupProjectProgress(nodes),
    milestoneDone: ms.filter((m) => m.done).length,
    milestoneTotal: ms.length,
    nextMilestoneDate: next?.currentDate ?? null,
    highRiskCount: risks.length,
  };
}

/**
 * 里程碑 + 门 + 门检查项 + 关联任务统计 聚合（取代原 `stagesWithGate`）。
 * 是里程碑页 / 概览页的唯一数据源；返回前先刷新派生状态，保证读到的 status 永远最新。
 */
function milestonesWithGate(db: MockDb, projectId: string): MilestoneWithGate[] {
  /* P0-M2：读路径幂等重排，自愈 localStorage 中的历史脏 code（F-2）。
   * 仅改内存 db 的 code 显示字段；落盘由调用方决定（listMilestones 已 saveDb）。 */
  renumberMilestones(db, projectId);
  refreshMilestoneStatuses(db, projectId);
  const nodes = db.wbsNodes.filter((n) => n.projectId === projectId);
  return sortMilestones(db.milestones.filter((m) => m.projectId === projectId)).map((m) => {
    const gate = db.gates.find((g) => g.milestoneId === m.id) ?? null;
    const gateItems = gate
      ? db.gateItems.filter((i) => i.gateId === gate.id).sort((a, b) => a.seq - b.seq)
      : [];
    return { ...m, gate, gateItems, taskStats: milestoneTaskStats(nodes, m.id) };
  });
}

/**
 * 里程碑编号重排（用户反馈① / P0-M1 / P0-M2）：按 `compareMilestones` 排序后重排为 M1..Mn。
 *
 * - **幂等**：连续调用结果一致（比较函数不依赖 `code`）
 * - 仅改显示用 `code`；身份是 `id`，WBS 经 `milestoneId` 关联，重排不影响引用完整性
 * - 只在**内存 db** 上改，是否落盘由调用方决定（读路径不主动 `saveDb`）
 *
 * @returns 是否发生了变化（供读路径判断要不要落盘 / 供测试断言幂等性）
 */
function renumberMilestones(db: MockDb, projectId: string): boolean {
  let changed = false;
  db.milestones
    .filter((m) => m.projectId === projectId)
    .sort(compareMilestones) // ← 与 sortMilestones 同一比较函数（SK-M1）
    .forEach((m, i) => {
      const next = `M${i + 1}`;
      if (m.code !== next) {
        m.code = next;
        changed = true;
      }
    });
  return changed;
}

/**
 * ⚠️ SK-2 **里程碑派生状态的唯一写入口**（§2.5）。
 *
 * 输入：时间（`currentDate` / 起算日 / 今天）+ 完成度（关联任务叶子）+ 真值（`doneAt` / `statusOverride`）
 * 输出：回写 `status` 与 `done`，并顺带重算项目健康度。
 *
 * 任何修改里程碑日期 / 达成 / 覆盖 / 任务进度的动作，落库后都必须调用本函数。
 */
function refreshMilestoneStatuses(db: MockDb, projectId: string): void {
  const project = db.projects.find((p) => p.id === projectId);
  if (!project) return;
  const list = db.milestones.filter((m) => m.projectId === projectId);
  const nodes = db.wbsNodes.filter((n) => n.projectId === projectId);
  const t = today();

  for (const ms of list) {
    const status = deriveMilestoneStatus(ms, {
      today: t,
      startFrom: milestoneStartFrom(list, ms, project.planStart),
      stats: milestoneTaskStats(nodes, ms.id),
    });
    ms.status = status;
    /* SK-2：done 退化为派生值，与 status 恒等同步 */
    ms.done = status === '已达成';
  }

  project.health = computeHealth(list, db.gates.filter((g) => g.projectId === projectId));
}

/**
 * R4-P0-3 单点收口：进度→状态自动流转 + 父节点回写（D2 采用「引擎回写存储字段」）。
 * 触发点（PRD D2）：createWbsNode / updateWbsNode / 日志提交 upsertReport / moveTask；
 * 结构性路径（deleteWbsNode / moveWbsNode）同样调用（父子变化会影响汇总，属同口径超集）。
 *
 * 流程：① 自底向上回写每个节点 progress —— 叶子保留自身存储值，
 *         父节点 = 子树真叶子按 estimateDays 加权（rollupProgressFlat，与视图层同算法）；
 *       ② 每节点 status = syncNodeStatusFromProgress(status, progress) 纯函数收敛；
 *       ③ 仅实际变化时写 updatedAt（不写审计，避免派生噪音）。
 */
function syncWbsProgressStatus(db: MockDb, projectId: string): void {
  const nodes = db.wbsNodes.filter((n) => n.projectId === projectId);
  if (!nodes.length) return;
  const ts = nowIso();
  nodes.forEach((n) => {
    const next = rollupProgressFlat(nodes, n.id);
    const nextStatus = syncNodeStatusFromProgress(n.status, next);
    if (n.progress !== next || n.status !== nextStatus) {
      n.progress = next;
      n.status = nextStatus;
      n.actualDays = Number(((n.estimateDays * next) / 100).toFixed(1));
      n.updatedAt = ts;
    }
  });
}

/** 清空人工覆盖三元组 + 基线快照（达成 / 取消达成 / 改期 三个动作共用 · SK-7） */
function clearOverride(ms: Milestone): void {
  ms.statusOverride = null;
  ms.overrideBy = null;
  ms.overrideAt = null;
  ms.overrideBaseDate = null;
}

/** 生成评审步骤 */
function buildSteps(db: MockDb, reviewId: string, projectId: string, chain: string[], assignees?: string[]): ReviewStep[] {
  return chain.map((role, idx) => {
    let openId = assignees?.[idx] ?? '';
    if (!openId) {
      const member = db.members.find((m) => m.projectId === projectId && m.projectRole === (role as ProjectRole));
      openId = member?.userOpenId ?? '';
    }
    if (!openId) {
      const byGlobal = db.users.find((u) => u.globalRole === (role as GlobalRole));
      openId = byGlobal?.openId ?? '';
    }
    if (!openId) {
      for (const r of ROLE_FALLBACK_ORDER) {
        const u = db.users.find((x) => x.globalRole === r);
        if (u) {
          openId = u.openId;
          break;
        }
      }
    }
    const user = db.users.find((u) => u.openId === openId);
    return {
      id: `${reviewId}-S${idx + 1}`,
      reviewId,
      stepIndex: idx,
      role,
      assigneeOpenId: openId || null,
      assigneeName: user?.name ?? '待指派',
      required: true,
      status: idx === 0 ? 'current' : 'pending',
      decidedBy: null,
      decidedByName: '',
      decidedAt: null,
      comment: '',
    } satisfies ReviewStep;
  });
}

/** 判定某用户是否为评审当前可决策人 */
function canDecide(review: Review, openId: string): ReviewStep | null {
  if (review.status !== '审批中') return null;
  if (review.mode === 'parallel_veto') {
    return review.steps.find((s) => s.assigneeOpenId === openId && s.status === 'current') ?? null;
  }
  const step = review.steps[review.currentStep];
  if (!step) return null;
  return step.assigneeOpenId === openId && step.status === 'current' ? step : null;
}

/** 评审通过后的联动（门 / 项目状态 / 变更） */
function onReviewApproved(db: MockDb, review: Review, actor: User): void {
  if (review.refType === 'gate') {
    const gate = db.gates.find((g) => g.id === review.refId);
    if (gate && gate.status !== '已通过') {
      gate.status = '已通过';
      gate.conclusion = '已通过';
      gate.decidedBy = actor.openId;
      gate.decidedAt = today();
      achieveMilestoneByGate(db, gate, actor);
    }
  }
  if (review.refType === 'project') {
    const p = db.projects.find((x) => x.id === review.refId);
    if (p && p.status === '审批中') {
      p.status = '已批准';
      p.updatedAt = nowIso();
      audit(db, actor, 'project', p.id, 'status_change', p.id, '立项审批通过，项目状态变更为「已批准」', [
        { field: 'status', label: '项目状态', before: '审批中', after: '已批准' },
      ]);
    }
  }
  if (review.refType === 'change') {
    const c = db.changes.find((x) => x.id === review.refId);
    if (c && c.status === '审批中') {
      c.status = '已批准';
      audit(db, actor, 'change', c.id, 'approve', c.projectId, `变更单 ${c.code} 审批通过，待实施`);
    }
  }
}

/**
 * 门通过 → 其挂载里程碑自动达成（§4.3，取代原 `advanceStage`）。
 *
 * 写 `doneAt` / `doneBy`（真值来源），清空人工覆盖，再由 `refreshMilestoneStatuses`
 * 把 `status` 推导为「已达成」。不做任何"下一碑推进"——碑的先后完全由日期决定。
 */
function achieveMilestoneByGate(db: MockDb, gate: QualityGate, actor: User): void {
  const ms = db.milestones.find((m) => m.id === gate.milestoneId);
  if (!ms) return;
  if (!ms.doneAt) {
    ms.doneAt = today();
    ms.doneBy = actor.openId;
    ms.updatedAt = nowIso();
    clearOverride(ms);
    audit(
      db,
      actor,
      'milestone',
      ms.id,
      'status_change',
      gate.projectId,
      `质量门「${gate.code} ${gate.name}」通过，里程碑「${ms.code} ${ms.name}」自动达成`,
      [{ field: 'status', label: '里程碑状态', before: ms.status, after: '已达成' }],
    );
  }
  refreshMilestoneStatuses(db, gate.projectId);
}

/** 看板视图组装 */
function buildBoard(db: MockDb, projectId: string): BoardView {
  let config = db.boardConfigs.find((c) => c.projectId === projectId);
  if (!config) {
    config = {
      projectId,
      columns: [...BOARD_COLUMNS],
      wipLimits: { 进行中: DEFAULT_WIP_LIMIT },
      updatedAt: nowIso(),
    };
    db.boardConfigs.push(config);
  }
  /* B11 决策 D-B11-1 · 列快照读时自愈（与后端 board.service.js#ensureBoardConfig 同口径）：
   * columns 只是「创建时刻的枚举快照」且无 API 可改；localStorage 里的老快照会导致
   * 「老项目 4 列 / 新项目 5 列」。此处幂等修复，**只改 columns，wipLimits 分毫不动**。 */
  if (
    config.columns.length !== BOARD_COLUMNS.length ||
    config.columns.some((c, i) => c !== BOARD_COLUMNS[i])
  ) {
    config.columns = [...BOARD_COLUMNS];
  }
  /* Q-3：看板卡片 = 真叶子（无子节点），不再以 nodeType==='task' 判定 */
  const tasks = leafNodesOf(db.wbsNodes.filter((n) => n.projectId === projectId));
  const columns: BoardColumn[] = config.columns.map((status) => ({
    status,
    cards: tasks.filter((t) => t.status === status).sort((a, b) => a.boardOrder - b.boardOrder),
    wipLimit: config!.wipLimits[status] ?? 0,
  }));
  return { projectId, columns, config };
}

/* ═══════════════════════════════════════════════════ */

export class MockApiClient implements ApiClient {
  /* ── 认证 ─────────────────────────────────────── */

  /**
   * @prd P0-11 Mock 态没有服务端凭证，恒返回空串。
   * 登录页据此提示「请改用开发登录」，而不是拿假 AppID 去调 JSSDK。
   */
  async getAppId(): Promise<string> {
    await delay(30);
    return '';
  }

  /** @prd P0-11 开发态免飞书登录 */
  async devLogin(openId: string): Promise<Session> {
    await delay();
    const db = getDb();
    const user = db.users.find((u) => u.openId === openId);
    if (!user) throw new ApiError(ErrorCode.E_NOT_FOUND, '用户不存在，请从列表中选择');
    if (user.status === 'disabled') throw new ApiError(ErrorCode.E_FORBIDDEN, '该账号已停用');
    db.sessionOpenId = openId;
    saveDb();
    return { token: MOCK_TOKEN_PREFIX + openId, user: deepClone(user) };
  }

  /** @prd P0-11 飞书免登（Mock 下按 code 映射首个用户） */
  async feishuLogin(code: string): Promise<Session> {
    await delay();
    const db = getDb();
    const user = db.users.find((u) => u.openId === code) ?? db.users[0];
    db.sessionOpenId = user.openId;
    saveDb();
    return { token: MOCK_TOKEN_PREFIX + user.openId, user: deepClone(user) };
  }

  /** @prd P0-11 / B4-T03 飞书网页登录 Mock：返回与 loginByCode 同形态（当前登录用户） */
  async loginByFeishuCode(_code: string): Promise<{ token: string; user: User }> {
    await delay();
    const db = getDb();
    const me = currentUser(db);
    return { token: MOCK_TOKEN_PREFIX + me.openId, user: deepClone(me) };
  }

  async me(): Promise<User> {
    await delay(60);
    return deepClone(currentUser(getDb()));
  }

  async logout(): Promise<void> {
    await delay(60);
    const db = getDb();
    db.sessionOpenId = null;
    saveDb();
  }

  /* ── 元数据 ───────────────────────────────────── */

  async getMeta(): Promise<MetaData> {
    await delay(60);
    const db = getDb();
    return {
      templates: deepClone(db.templates),
      reviewTemplates: Object.values(REVIEW_TEMPLATES).map((t) => ({
        key: t.key,
        label: t.label,
        mode: t.mode,
        chain: t.chain,
      })),
      wipDefault: DEFAULT_WIP_LIMIT,
    };
  }

  /**
   * 按分类取当前生效的生命周期模板（新建向导里程碑预填用）
   * 查找条件与 `createProject` 保持完全一致，避免预填与落库用了不同模板；
   * 模板缺失时返回 null（不抛 404），向导降级为空列表而非阻断。
   */
  async getLifecycleTemplate(type: ProjectType): Promise<LifecycleTemplate | null> {
    await delay(60);
    const db = getDb();
    currentUser(db);
    const tpl = db.templates.find((t) => t.projectType === type && t.isActive);
    return tpl ? deepClone(tpl) : null;
  }

  /* ── 项目 ─────────────────────────────────────── */

  /** @prd P0-01 分类判定 */
  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    await delay(80);
    return classifyProject(input);
  }

  /** @prd P0-04 项目列表（筛选 + 分页） */
  async listProjects(query: ProjectQuery): Promise<Paged<ProjectListItem>> {
    await delay();
    const db = getDb();
    const me = currentUser(db);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    let rows = db.projects.map((p) => toListItem(db, p));
    if (query.keyword) {
      const k = query.keyword.trim().toLowerCase();
      rows = rows.filter(
        (r) => r.name.toLowerCase().includes(k) || r.code.toLowerCase().includes(k) || r.customer.toLowerCase().includes(k),
      );
    }
    if (query.type) rows = rows.filter((r) => r.type === query.type);
    if (query.status) rows = rows.filter((r) => r.status === query.status);
    if (query.health) rows = rows.filter((r) => r.health === query.health);
    if (query.pm) rows = rows.filter((r) => r.pmName === query.pm);
    if (query.onlyMine) {
      const mine = new Set(db.members.filter((m) => m.userOpenId === me.openId).map((m) => m.projectId));
      rows = rows.filter((r) => mine.has(r.id));
    }
    rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

    const total = rows.length;
    const items = rows.slice((page - 1) * pageSize, page * pageSize);
    return { items, total, page, pageSize };
  }

  async getProject(id: string): Promise<Project> {
    await delay();
    const db = getDb();
    currentUser(db);
    return deepClone(db.projects.find((p) => p.id === id) ?? nf());
  }

  /** @prd P0-02 新建项目（按模板实例化里程碑 / 门 / 骨架） */
  async createProject(payload: CreateProjectPayload): Promise<Project> {
    await delay(300);
    const db = getDb();
    const me = assertCan(db, 'project.create');

    if (payload.type !== payload.classifySuggested && !payload.classifyOverrideReason.trim()) {
      throw new ApiError(ErrorCode.E_CLASSIFY_REASON_REQUIRED);
    }
    if (payload.type === 'B' && !payload.members.some((m) => m.role === 'po')) {
      throw new ApiError(ErrorCode.E_PROJECT_PO_REQUIRED);
    }
    const pmCount = payload.members.filter((m) => m.role === 'pm').length;
    const tlCount = payload.members.filter((m) => m.role === 'tl').length;
    if (pmCount !== 1 || tlCount !== 1) throw new ApiError(ErrorCode.E_ROLE_CARDINALITY);

    const tpl = db.templates.find((t) => t.projectType === payload.type && t.isActive) ?? nf();
    const seq = db.projects.length + 1;
    const id = genId('P');
    const code = `P-${String(1000 + seq * 3).padStart(4, '0')}`;
    const ts = nowIso();

    const project: Project = {
      id,
      code,
      name: payload.name,
      type: payload.type,
      classifyInput: payload.classifyInput,
      classifySuggested: payload.classifySuggested,
      classifyOverrideReason: payload.classifyOverrideReason,
      customer: payload.customer,
      contractAmount: payload.contractAmount,
      background: payload.background,
      goal: payload.goal,
      status: '草稿',
      health: 'green',
      planStart: payload.planStart,
      planEnd: payload.planEnd,
      actualEnd: null,
      approvalStep: 0,
      templateId: tpl.id,
      createdBy: me.openId,
      createdAt: ts,
      updatedAt: ts,
    };
    db.projects.push(project);

    /* ── 里程碑（方案一·极简：不再内联质量门） ─────────────
     * 优先使用向导中用户编辑 / 新增的里程碑（payload.milestones）；
     * 老客户端未传时回退到模板静默生成（向后兼容）。
     * 必备/非必备碑均可自由增删；名称 / 日期用户可改（Q-2 / 用户反馈①②）。
     */
    const wbsRules = resolveWbsRules(tpl);

    /* 把模板定义拍平成「绝对日期」规格，与向导提交的 CreateMilestoneSpec 同构 */
    /* 模板里程碑偏移 → 等比压缩后的绝对日期（SK-M7：日期生成唯一入口 fitMilestoneDates） */
    const tplDates = fitMilestoneDates(
      payload.planStart,
      payload.planEnd,
      tpl.definition.milestones.map((md) => md.offsetDays),
    );
    const templateSpecs: CreateMilestoneSpec[] = tpl.definition.milestones.map((md, i) => ({
      code: md.code,
      name: md.name,
      target: '',
      date: tplDates[i] ?? addDays(payload.planStart, md.offsetDays),
      required: md.required,
      gate: null, // K-1：新建项目不生成质量门（方案一·极简），字段仅保类型契约
    }));
    const specList: CreateMilestoneSpec[] =
      payload.milestones && payload.milestones.length ? payload.milestones : templateSpecs;

    const createdMilestones: Milestone[] = [];
    specList.forEach((md, idx) => {
      const msId = `${id}-MS${idx + 1}`;
      const date = md.date; // 绝对日期：向导已用 planStart + 偏移预填，用户可改
      const ms: Milestone = {
        id: msId,
        projectId: id,
        code: md.code,
        name: md.name,
        target: md.target ?? '',
        required: md.required,
        baselineDate: date, // 创建即基线
        currentDate: date,
        delayDays: 0,
        /* SK-2：此处占位，落库后统一由 refreshMilestoneStatuses 推导 */
        status: '未开始',
        done: false,
        doneAt: null,
        doneBy: null,
        statusOverride: null,
        overrideBy: null,
        overrideAt: null,
        overrideBaseDate: null,
        lastChangeId: null,
        createdAt: ts,
        updatedAt: ts,
      };
      db.milestones.push(ms);
      createdMilestones.push(ms);

      /* 用户反馈②：新建项目不再自动生成质量门，里程碑为独立可编辑实体 */
    });

    /* P0-M1 触发点⑤：向导可能改过日期 / 加过碑，模板 code 顺序已失效；
     * 必须在 WBS 骨架生成之前重排，否则骨架 description 里内嵌的 ms.code 是脏的 */
    renumberMilestones(db, id);

    /* ── WBS 骨架预生成（D-3 方案丙 + Q-3 per-milestone） ──────
     * 逐个里程碑生成一个顶层 `nodeType:'task'` 根节点并绑定 milestoneId，
     * 使新项目一进 WBS 页就有「里程碑为脊」的骨架，而不是空树导致结构漂移。
     * 根节点此刻是叶子，会自然计入里程碑完成度；用户往下挂子任务后自动让位。
     */
    if (wbsRules.skeleton === 'per-milestone') {
      createdMilestones.forEach((ms, idx) => {
          db.wbsNodes.push({
            id: `${id}-WS${idx + 1}`,
            projectId: id,
            parentId: null,
            wbsCode: String(idx + 1),
            level: 1,
            nodeType: 'task',
            name: ms.name,
            description: `由 ${tpl.name} 模板里程碑「${ms.code} ${ms.name}」自动生成`,
            owner: '',
            ownerName: '',
            estimateDays: 0,
            actualDays: 0,
            // B7：骨架根节点此刻是叶子，工时按 0 起步；读时由 decorateEffort 覆盖父节点 Σ
            effortHours: 0,
            effortChildCount: 0,
            startDate: '',
            dueDate: ms.currentDate,
            status: '待办',
            progress: 0,
            // B14-块1：骨架节点走缺省优先级
            priority: DEFAULT_PRIORITY,
            boardOrder: idx,
            isCritical: false,
            milestoneId: ms.id,
            createdBy: me.openId,
            createdAt: ts,
            updatedAt: ts,
          });
        });
    }

    payload.members.forEach((m, i) => {
      const u = db.users.find((x) => x.openId === m.userOpenId);
      db.members.push({
        id: `${id}-MB${i + 1}`,
        projectId: id,
        userOpenId: m.userOpenId,
        userName: u?.name ?? m.userOpenId,
        projectRole: m.role,
        assignedBy: me.openId,
        assignedAt: ts,
      });
    });

    db.boardConfigs.push({
      projectId: id,
      columns: [...BOARD_COLUMNS],
      wipLimits: { 进行中: DEFAULT_WIP_LIMIT },
      updatedAt: ts,
    });

    /* SK-2：骨架落库后统一推导里程碑状态（首碑会随起算日自然「进行中」） */
    refreshMilestoneStatuses(db, id);

    const msCount = db.milestones.filter((m) => m.projectId === id).length;
    const createDiff: AuditDiffEntry[] = [
      { field: 'type', label: '项目分类', before: '', after: `${payload.type} 类` },
      {
        field: 'milestones',
        label: '里程碑',
        before: '',
        after: `按 ${tpl.name} 生成 ${msCount} 个里程碑`,
      },
    ];
    audit(db, me, 'project', id, 'create', id, `创建项目「${payload.name}」，分类 ${payload.type} 类`, createDiff);
    saveDb();
    return deepClone(project);
  }

  async updateProject(id: string, payload: UpdateProjectPayload): Promise<Project> {
    await delay();
    const db = getDb();
    const p = assertWritable(db, id);
    const me = assertCan(db, 'project.edit', id);
    const diff: AuditDiffEntry[] = [];
    const apply = <K extends keyof Project>(k: K, label: string, v: Project[K] | undefined): void => {
      if (v === undefined || v === p[k]) return;
      diff.push({ field: String(k), label, before: String(p[k] ?? ''), after: String(v ?? '') });
      p[k] = v;
    };
    apply('name', '项目名称', payload.name);
    apply('customer', '客户', payload.customer);
    apply('contractAmount', '合同额', payload.contractAmount);
    apply('background', '项目背景', payload.background);
    apply('planStart', '计划开始', payload.planStart);
    apply('planEnd', '计划结束', payload.planEnd);
    if (payload.goal) p.goal = payload.goal;
    if (payload.health) p.health = payload.health as Project['health'];
    p.updatedAt = nowIso();
    audit(db, me, 'project', id, 'update', id, `修改项目基本信息`, diff);
    saveDb();
    return deepClone(p);
  }

  /** @prd P0-17 项目状态机流转 */
  async transitionProject(id: string, to: ProjectStatus, comment: string): Promise<Project> {
    await delay();
    const db = getDb();
    const p = db.projects.find((x) => x.id === id) ?? nf();
    const me = assertCan(db, 'project.transition', id);
    const allowed = PROJECT_TRANSITIONS[p.status] ?? [];
    if (!allowed.includes(to)) {
      throw new ApiError(ErrorCode.E_VALIDATION, `不允许从「${p.status}」流转到「${to}」`);
    }
    if (to === '已结项') {
      const blockers = closeBlockers(
        p,
        db.gates.filter((g) => g.projectId === id),
        db.milestones.filter((m) => m.projectId === id),
        db.changes,
        db.reviews,
      );
      if (blockers.length) {
        throw new ApiError(ErrorCode.E_CLOSE_BLOCKED, '结项被阻塞，请先处理阻塞项', { blockers });
      }
      p.actualEnd = today();
    }
    const before = p.status;
    p.status = to;
    p.updatedAt = nowIso();
    audit(db, me, 'project', id, 'status_change', id, comment || `项目状态由「${before}」变更为「${to}」`, [
      { field: 'status', label: '项目状态', before, after: to },
    ]);
    saveDb();
    return deepClone(p);
  }

  /** @prd P0-17 结项前置检查 */
  async checkClose(id: string): Promise<CloseBlocker[]> {
    await delay();
    const db = getDb();
    currentUser(db);
    const p = db.projects.find((x) => x.id === id) ?? nf();
    return closeBlockers(
      p,
      db.gates.filter((g) => g.projectId === id),
      db.milestones.filter((m) => m.projectId === id),
      db.changes,
      db.reviews,
    );
  }

  /* ── 成员 ─────────────────────────────────────── */

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    await delay(80);
    const db = getDb();
    currentUser(db);
    return deepClone(db.members.filter((m) => m.projectId === projectId));
  }

  async addMember(projectId: string, userOpenId: string, role: ProjectRole): Promise<ProjectMember> {
    await delay();
    const db = getDb();
    assertWritable(db, projectId);
    const me = assertCan(db, 'member.manage', projectId);
    if ((role === 'pm' || role === 'tl') && db.members.some((m) => m.projectId === projectId && m.projectRole === role)) {
      throw new ApiError(ErrorCode.E_ROLE_CARDINALITY);
    }
    const u = db.users.find((x) => x.openId === userOpenId) ?? nf();
    const member: ProjectMember = {
      id: genId('MB'),
      projectId,
      userOpenId,
      userName: u.name,
      projectRole: role,
      assignedBy: me.openId,
      assignedAt: nowIso(),
    };
    db.members.push(member);
    audit(db, me, 'project', projectId, 'update', projectId, `添加项目成员「${u.name}」（${role}）`);
    saveDb();
    return deepClone(member);
  }

  async removeMember(projectId: string, memberId: string): Promise<void> {
    await delay();
    const db = getDb();
    assertWritable(db, projectId);
    const me = assertCan(db, 'member.manage', projectId);
    const idx = db.members.findIndex((m) => m.id === memberId);
    if (idx === -1) nf();
    const m = db.members[idx];
    if (m.projectRole === 'pm' || m.projectRole === 'tl') throw new ApiError(ErrorCode.E_ROLE_CARDINALITY);
    db.members.splice(idx, 1);
    audit(db, me, 'project', projectId, 'update', projectId, `移除项目成员「${m.userName}」`);
    saveDb();
  }

  /* ── 质量门（挂载于里程碑 · 决策 D-A） ──────────── */

  /** @prd P0-03 勾选门检查项 */
  async toggleGateItem(itemId: string, checked: boolean): Promise<MilestoneWithGate[]> {
    await delay(120);
    const db = getDb();
    const item = db.gateItems.find((i) => i.id === itemId) ?? nf();
    const gate = db.gates.find((g) => g.id === item.gateId) ?? nf();
    assertWritable(db, gate.projectId);
    const me = assertCan(db, 'gate.check', gate.projectId);
    item.checked = checked;
    item.checkedBy = checked ? me.openId : null;
    item.checkedAt = checked ? today() : null;
    audit(db, me, 'gate_item', itemId, 'update', gate.projectId, `${checked ? '勾选' : '取消勾选'}检查项「${item.content}」`);
    saveDb();
    return deepClone(milestonesWithGate(db, gate.projectId));
  }

  /**
   * @prd P0-03 提交门控结论（检查项未齐备直接拒绝）
   * 通过 / 有条件通过 → 其挂载里程碑自动达成（§4.3），无需单独的推进动作。
   */
  async decideGate(projectId: string, payload: GateDecisionPayload): Promise<MilestoneWithGate[]> {
    await delay(200);
    const db = getDb();
    assertWritable(db, projectId);
    const me = assertCan(db, 'gate.decide', projectId);
    const gate = db.gates.find((g) => g.id === payload.gateId) ?? nf();
    const items = db.gateItems.filter((i) => i.gateId === gate.id);
    const { ready, unchecked } = gateReady(items);

    if (!ready && payload.conclusion !== '不通过') {
      throw new ApiError(ErrorCode.E_GATE_ITEM_INCOMPLETE, undefined, {
        unchecked: unchecked.map((u) => ({ id: u.id, content: u.content })),
      });
    }

    const before = gate.status;
    gate.status = payload.conclusion;
    gate.conclusion = payload.conclusion;
    gate.comment = payload.comment;
    gate.decidedBy = me.openId;
    gate.decidedAt = today();

    audit(db, me, 'gate', gate.id, 'decide', projectId, `${gate.code} 门控结论：${payload.conclusion}`, [
      { field: 'status', label: '门状态', before, after: payload.conclusion },
    ]);

    if (GATE_PASSED_STATUSES.includes(payload.conclusion)) {
      achieveMilestoneByGate(db, gate, me);
    } else {
      refreshMilestoneStatuses(db, projectId);
    }
    saveDb();
    return deepClone(milestonesWithGate(db, projectId));
  }

  /* ── 里程碑（唯一时间轴 · Q-1 / Q-2） ───────────── */

  async listMilestones(projectId: string): Promise<MilestoneWithGate[]> {
    await delay(80);
    const db = getDb();
    currentUser(db);
    const rows = deepClone(milestonesWithGate(db, projectId));
    /* refreshMilestoneStatuses 可能回写了 status/done/health，需要落盘 */
    saveDb();
    return rows;
  }

  /**
   * @prd P0-05 新增里程碑（Q-2 自由增）
   * 用户自建碑恒为 `required:false`（可删）且不带门（C-G2）。
   */
  async createMilestone(projectId: string, payload: MilestoneCreatePayload): Promise<MilestoneWithGate> {
    await delay(150);
    const db = getDb();
    assertWritable(db, projectId);
    const me = assertCan(db, 'milestone.edit', projectId);

    const name = payload.name.trim();
    if (!name) throw new ApiError(ErrorCode.E_VALIDATION, '里程碑名称不能为空');
    if (!payload.date) throw new ApiError(ErrorCode.E_VALIDATION, '里程碑日期不能为空');

    const siblings = db.milestones.filter((m) => m.projectId === projectId);
    /* code 取 M{max+1}，避免与模板碑冲突；解析不出数字的 code 视作 0 */
    const maxSeq = siblings.reduce((max, m) => {
      const n = Number.parseInt(m.code.replace(/^\D+/, ''), 10);
      return Number.isNaN(n) ? max : Math.max(max, n);
    }, 0);
    const ts = nowIso();
    const ms: Milestone = {
      id: genId('MS'),
      projectId,
      code: `M${maxSeq + 1}`,
      name,
      target: (payload.target ?? '').trim(),
      required: false,
      baselineDate: payload.date,
      currentDate: payload.date,
      delayDays: 0,
      status: '未开始',
      done: false,
      doneAt: null,
      doneBy: null,
      statusOverride: null,
      overrideBy: null,
      overrideAt: null,
      overrideBaseDate: null,
      lastChangeId: null,
      createdAt: ts,
      updatedAt: ts,
    };
    db.milestones.push(ms);
    /* 插入后按日期重排编号，避免 M2-M3 间插入出现 M5（用户反馈①） */
    renumberMilestones(db, projectId);

    audit(db, me, 'milestone', ms.id, 'create', projectId, `新增里程碑「${ms.code} ${ms.name}」（${ms.currentDate}）`, [
      { field: 'currentDate', label: '计划日期', before: '', after: ms.currentDate },
    ]);
    refreshMilestoneStatuses(db, projectId);
    saveDb();
    const row = milestonesWithGate(db, projectId).find((m) => m.id === ms.id) ?? nf();
    return deepClone(row);
  }

  /**
   * @prd P0-05 删除里程碑（Q-2 模板必备碑锁删）
   * 必备碑 → `E_MS_REQUIRED_LOCKED`；同时级联清理其门 / 门检查项，
   * 并把挂载在该碑上的 WBS 节点解绑（置 null），不删任务。
   */
  async deleteMilestone(id: string): Promise<void> {
    await delay(150);
    const db = getDb();
    const ms = db.milestones.find((m) => m.id === id) ?? nf();
    assertWritable(db, ms.projectId);
    const me = assertCan(db, 'milestone.edit', ms.projectId);

    /* 级联：门 → 门检查项（里程碑可自由删除，不再因「必备」锁删，用户反馈②） */
    const gates = db.gates.filter((g) => g.milestoneId === id);
    for (const g of gates) {
      db.gateItems = db.gateItems.filter((i) => i.gateId !== g.id);
    }
    db.gates = db.gates.filter((g) => g.milestoneId !== id);
    /* WBS 关联只解绑不删任务，避免误删用户工作量 */
    for (const n of db.wbsNodes) {
      if (n.milestoneId === id) {
        n.milestoneId = null;
        n.updatedAt = nowIso();
      }
    }
    db.milestones = db.milestones.filter((m) => m.id !== id);
    /* 删除后按日期重排编号（用户反馈①） */
    renumberMilestones(db, ms.projectId);

    audit(db, me, 'milestone', id, 'delete', ms.projectId, `删除里程碑「${ms.code} ${ms.name}」`, [
      { field: 'name', label: '里程碑', before: `${ms.code} ${ms.name}`, after: '' },
    ]);
    refreshMilestoneStatuses(db, ms.projectId);
    saveDb();
  }

  /**
   * @prd P0-05 修改里程碑
   * - `currentDate`：提前可直改，延后抛 `E_MS_NEED_CHANGE`；改期清空 override（SK-7）
   * - `achieved`：C-G4 有门且门未过 → `E_GATE_NOT_PASSED`；写 `doneAt/doneBy` 并清空 override
   * - `statusOverride`：三元组审计留痕 + 快照 `overrideBaseDate`
   */
  async updateMilestone(id: string, payload: MilestoneUpdatePayload): Promise<MilestoneWithGate> {
    await delay();
    const db = getDb();
    const ms = db.milestones.find((m) => m.id === id) ?? nf();
    assertWritable(db, ms.projectId);
    const me = assertCan(db, 'milestone.edit', ms.projectId);

    /* ① 改期（单向规则） */
    if (payload.currentDate && payload.currentDate !== ms.currentDate) {
      if (milestoneDelayNeedsChange(ms, payload.currentDate)) {
        throw new ApiError(ErrorCode.E_MS_NEED_CHANGE, '里程碑日期延后须走变更申请', {
          changeDraft: {
            projectId: ms.projectId,
            changeType: 'milestone_date',
            title: `${ms.code} ${ms.name} 里程碑日期调整`,
            targetType: 'milestone',
            targetId: ms.id,
            payload: { fromDate: ms.currentDate, toDate: payload.currentDate },
          },
        });
      }
      const before = ms.currentDate;
      ms.currentDate = payload.currentDate;
      ms.delayDays = diffDays(ms.baselineDate, ms.currentDate);
      /* SK-7：改期后人工覆盖自动作废 */
      clearOverride(ms);
      audit(db, me, 'milestone', id, 'update', ms.projectId, `里程碑 ${ms.code} 日期提前`, [
        { field: 'currentDate', label: '当前日期', before, after: ms.currentDate },
      ]);
      /* P0-M1 触发点③：改期后必须重排，否则 M4 提前编号不动（F-1） */
      renumberMilestones(db, ms.projectId);
    }

    /* ② 名称 */
    if (payload.name !== undefined && payload.name.trim() && payload.name !== ms.name) {
      const before = ms.name;
      ms.name = payload.name.trim();
      audit(db, me, 'milestone', id, 'update', ms.projectId, `里程碑 ${ms.code} 名称调整`, [
        { field: 'name', label: '名称', before, after: ms.name },
      ]);
    }

    /* ③ 目标 / 达成标准：纯文本，不触发单向日期约束 */
    if (payload.target !== undefined && payload.target !== ms.target) {
      const before = ms.target;
      ms.target = payload.target;
      audit(db, me, 'milestone', id, 'update', ms.projectId, `里程碑 ${ms.code} 目标调整`, [
        { field: 'target', label: '目标 / 达成标准', before, after: ms.target },
      ]);
    }

    /* ④ 标记 / 取消达成（真值来源 doneAt） */
    if (payload.achieved !== undefined && payload.achieved !== Boolean(ms.doneAt)) {
      if (payload.achieved) {
        /* 用户反馈②：不再因质量门卡住达成，允许直接标记 */
        ms.doneAt = today();
        ms.doneBy = me.openId;
      } else {
        ms.doneAt = null;
        ms.doneBy = null;
      }
      /* 达成 / 取消达成一律清空覆盖，保证 P1 与 P2 不冲突 */
      clearOverride(ms);
      audit(
        db,
        me,
        'milestone',
        id,
        'status_change',
        ms.projectId,
        `里程碑 ${ms.code} ${payload.achieved ? '标记达成' : '取消达成'}`,
        [{ field: 'doneAt', label: '达成时间', before: '', after: ms.doneAt ?? '' }],
      );
    }

    /* ⑤ 人工覆盖状态（SK-7b：类型层已排除「已达成」） */
    if (payload.statusOverride !== undefined && payload.statusOverride !== ms.statusOverride) {
      const before = ms.statusOverride ?? '（无）';
      if (payload.statusOverride === null) {
        clearOverride(ms);
      } else {
        ms.statusOverride = payload.statusOverride;
        ms.overrideBy = me.openId;
        ms.overrideAt = nowIso();
        /* 快照当前计划日，改期后该覆盖自动失效 */
        ms.overrideBaseDate = ms.currentDate;
      }
      audit(db, me, 'milestone', id, 'status_change', ms.projectId, `里程碑 ${ms.code} 人工覆盖状态`, [
        { field: 'statusOverride', label: '覆盖状态', before, after: ms.statusOverride ?? '（撤销）' },
      ]);
    }

    ms.updatedAt = nowIso();
    /* SK-2：所有真值改完后统一推导 status / done + 项目健康度 */
    refreshMilestoneStatuses(db, ms.projectId);
    saveDb();
    const row = milestonesWithGate(db, ms.projectId).find((m) => m.id === id) ?? nf();
    return deepClone(row);
  }

  /* ── WBS ──────────────────────────────────────── */

  async listWbs(projectId: string): Promise<WbsNode[]> {
    await delay(100);
    const db = getDb();
    currentUser(db);
    return deepClone(
      decorateEffort(
        db.wbsNodes.filter((n) => n.projectId === projectId).sort((a, b) => compareWbsCode(a.wbsCode, b.wbsCode)),
      ),
    );
  }

  /** @prd P0-06 新建 WBS 节点（自动编码 + 层级校验 R-1/R-2/R-6） */
  async createWbsNode(projectId: string, payload: WbsNodePayload): Promise<WbsNode> {
    await delay();
    const db = getDb();
    assertWritable(db, projectId);
    const me = assertCan(db, 'wbs.edit', projectId);

    // 父节点先解析（跨项目引用直接拒）
    const parent = payload.parentId ? (db.wbsNodes.find((n) => n.id === payload.parentId) ?? null) : null;
    if (payload.parentId && !parent) throw new ApiError(ErrorCode.E_NOT_FOUND, '父节点不存在');
    if (parent && parent.projectId !== projectId) {
      throw new ApiError(ErrorCode.E_VALIDATION, '父节点不属于当前项目', { parentId: parent.id });
    }

    /* B8（D4）：WBS 写通道关闭 —— 携带 effortHours → E_WBS_EFFORT_WRITE_DISABLED */
    assertEffortWriteDisabled(payload);

    // W-1 深度 / W-2 父子类型 —— fail-fast，先于叶子完整性
    const rules = resolveWbsRules(projectTemplateOf(db, projectId));
    const placementError = validateWbsPlacement({ nodeType: payload.nodeType, parent }, rules);
    if (placementError) {
      throw new ApiError(placementError.code, placementError.message, placementError.data);
    }

    /* 叶子完整性：新建节点必然还没有子节点，故一律按叶子口径校验负责人 / 估算 */
    if (!payload.owner || !payload.estimateDays) {
      throw new ApiError(ErrorCode.E_WBS_LEAF_INCOMPLETE);
    }

    const newId = genId('W');

    // 关联里程碑：显式传入用传入值；未传则默认继承上级节点的里程碑（用户反馈②）
    const milestoneId = payload.milestoneId !== undefined ? payload.milestoneId : (parent?.milestoneId ?? null);
    assertSameProjectMilestone(db, projectId, milestoneId);

    const siblings = db.wbsNodes.filter((n) => n.projectId === projectId && n.parentId === payload.parentId);
    const wbsCode = nextChildCode(parent?.wbsCode ?? null, siblings.map((s) => s.wbsCode));
    const owner = payload.owner ?? '';
    const u = db.users.find((x) => x.openId === owner);
    const ts = nowIso();

    // 有效截止日期（未传则默认 +7 天），用于截止日期硬拦截校验（用户反馈③）
    const effectiveDue = payload.dueDate ?? addDays(today(), 7);
    const milestone = milestoneId ? db.milestones.find((m) => m.id === milestoneId) ?? null : null;
    const deadlineErr = validateWbsDeadline({ dueDate: effectiveDue, parent, milestone });
    if (deadlineErr) {
      throw new ApiError(deadlineErr.code, deadlineErr.message, deadlineErr.data);
    }

    /* 工时估算硬拦截（用户反馈④b）：估算不得超过起止区间可用天数 */
    const estimateErr = validateWbsEstimate({
      estimateDays: payload.estimateDays ?? 0,
      startDate: payload.startDate ?? today(),
      dueDate: effectiveDue,
    });
    if (estimateErr) {
      throw new ApiError(estimateErr.code, estimateErr.message, estimateErr.data);
    }

    const node: WbsNode = {
      id: newId,
      projectId,
      parentId: payload.parentId,
      wbsCode,
      level: wbsCode.split('.').length,
      nodeType: payload.nodeType,
      name: payload.name,
      description: payload.description ?? '',
      owner,
      ownerName: u?.name ?? '',
      estimateDays: payload.estimateDays ?? 0,
      actualDays: 0,
      // B8（D9）：新节点 effortHours 存储值恒 0（后端列 NULL → 展示 0）；由日志 submit 累加
      effortHours: 0,
      effortChildCount: 0,
      startDate: payload.startDate ?? today(),
      dueDate: effectiveDue,
      status: payload.status ?? '待办',
      progress: payload.progress ?? 0,
      // B14-块1：与后端 wbs.service#createWbsNode 同构 —— 缺省 P2，非法值收敛
      priority: normalizePriority(payload.priority ?? DEFAULT_PRIORITY),
      boardOrder: db.wbsNodes.filter((n) => n.projectId === projectId).length,
      isCritical: false,
      milestoneId,
      createdBy: me.openId,
      createdAt: ts,
      updatedAt: ts,
    };
    db.wbsNodes.push(node);
    /* B8（D9）：WBS 写路径不再触碰 effort_hours —— 不再「成为父即清」父节点存储值 */
    audit(db, me, 'wbs_node', node.id, 'create', projectId, `新增 WBS 节点「${wbsCode} ${payload.name}」`);
    /* R4-P0-3：新叶子改变父子汇总 → 父链回写 + 状态收敛 */
    syncWbsProgressStatus(db, projectId);
    /* 新叶子会改变里程碑完成度 → 触发状态重推 */
    refreshMilestoneStatuses(db, projectId);
    saveDb();
    return deepClone(decorateEffort([node])[0]);
  }

  async updateWbsNode(id: string, payload: Partial<WbsNodePayload>): Promise<WbsNode> {
    await delay();
    const db = getDb();
    const node = db.wbsNodes.find((n) => n.id === id) ?? nf();
    assertWritable(db, node.projectId);
    const me = assertCan(db, 'wbs.edit', node.projectId);

    /* B8（D4）：WBS 写通道关闭 —— 携带 effortHours → E_WBS_EFFORT_WRITE_DISABLED */
    assertEffortWriteDisabled(payload);

    const diff: AuditDiffEntry[] = [];

    // R-4 类型锁：已有子节点的节点不可改 nodeType
    const children = db.wbsNodes.filter((n) => n.parentId === node.id);

    if (payload.nodeType !== undefined && payload.nodeType !== node.nodeType) {
      if (children.length > 0) {
        throw new ApiError(ErrorCode.E_WBS_TYPE_LOCKED, undefined, { nodeId: id, childCount: children.length });
      }
      // 无子节点时允许改类型，但须重新满足父子白名单（对其父重校验）
      const rules = resolveWbsRules(projectTemplateOf(db, node.projectId));
      const parent = node.parentId ? (db.wbsNodes.find((n) => n.id === node.parentId) ?? null) : null;
      const placementError = validateWbsPlacement({ nodeType: payload.nodeType, parent }, rules);
      if (placementError) {
        throw new ApiError(placementError.code, placementError.message, placementError.data);
      }
      const beforeType = node.nodeType;
      node.nodeType = payload.nodeType;
      diff.push({ field: 'nodeType', label: '节点类型', before: beforeType, after: node.nodeType });
    }

    if (payload.name !== undefined && payload.name !== node.name) {
      diff.push({ field: 'name', label: '名称', before: node.name, after: payload.name });
      node.name = payload.name;
    }
    if (payload.description !== undefined) node.description = payload.description;
    if (payload.owner !== undefined && payload.owner !== node.owner) {
      const u = db.users.find((x) => x.openId === payload.owner);
      diff.push({ field: 'owner', label: '负责人', before: node.ownerName, after: u?.name ?? '' });
      node.owner = payload.owner;
      node.ownerName = u?.name ?? '';
    }
    if (payload.estimateDays !== undefined && payload.estimateDays !== node.estimateDays) {
      diff.push({
        field: 'estimateDays',
        label: '估算人日',
        before: String(node.estimateDays),
        after: String(payload.estimateDays),
      });
      node.estimateDays = payload.estimateDays;
    }
    /* B14-块1：优先级变更（与后端 wbs.service#updateWbsNode 同构，含审计 diff） */
    if (payload.priority !== undefined) {
      const nextPriority = normalizePriority(payload.priority);
      if (nextPriority !== node.priority) {
        diff.push({ field: 'priority', label: '优先级', before: node.priority, after: nextPriority });
        node.priority = nextPriority;
      }
    }
    if (payload.startDate !== undefined) node.startDate = payload.startDate;
    if (payload.dueDate !== undefined) {
      // 截止日期硬拦截（用户反馈③）：子节点不得晚于上级任务或关联里程碑
      const nextMsId = payload.milestoneId !== undefined ? (payload.milestoneId ?? null) : node.milestoneId;
      const ms = nextMsId ? db.milestones.find((m) => m.id === nextMsId) ?? null : null;
      const parentNode = node.parentId ? db.wbsNodes.find((n) => n.id === node.parentId) ?? null : null;
      const deadlineErr = validateWbsDeadline({ dueDate: payload.dueDate, parent: parentNode, milestone: ms });
      if (deadlineErr) {
        throw new ApiError(deadlineErr.code, deadlineErr.message, deadlineErr.data);
      }
      node.dueDate = payload.dueDate;
    }

    /* 工时估算硬拦截（用户反馈④b）：与起止/截止任一变更后统一复检 */
    {
      const effEstimate = payload.estimateDays !== undefined ? payload.estimateDays : node.estimateDays;
      const effStart = payload.startDate !== undefined ? payload.startDate : node.startDate;
      const effDue = payload.dueDate !== undefined ? payload.dueDate : node.dueDate;
      const estErr = validateWbsEstimate({ estimateDays: effEstimate, startDate: effStart, dueDate: effDue });
      if (estErr) {
        throw new ApiError(estErr.code, estErr.message, estErr.data);
      }
    }
    if (payload.status !== undefined && payload.status !== node.status) {
      diff.push({ field: 'status', label: '状态', before: node.status, after: payload.status });
      node.status = payload.status;
    }
    if (payload.progress !== undefined) {
      node.progress = Math.max(0, Math.min(100, payload.progress));
      node.actualDays = Number(((node.estimateDays * node.progress) / 100).toFixed(1));
    }

    // milestoneId：任意节点均可挂；跨项目引用拒
    if (payload.milestoneId !== undefined) {
      const nextMs = payload.milestoneId ?? null;
      if (nextMs !== node.milestoneId) {
        assertSameProjectMilestone(db, node.projectId, nextMs);
        diff.push({
          field: 'milestoneId',
          label: '关联里程碑',
          before: node.milestoneId ?? '',
          after: nextMs ?? '',
        });
        node.milestoneId = nextMs;
      }
    }

    /* SK-13 叶子完整性：仅对真叶子（无子节点）要求负责人 + 估算 */
    if (isLeafNode(db.wbsNodes, node.id) && (!node.owner || !node.estimateDays)) {
      throw new ApiError(ErrorCode.E_WBS_LEAF_INCOMPLETE);
    }
    node.updatedAt = nowIso();
    audit(db, me, 'wbs_node', id, 'update', node.projectId, `修改节点「${node.wbsCode} ${node.name}」`, diff);
    /* R4-P0-3：进度 / 父子结构变化 → 父链回写 + 状态收敛 */
    syncWbsProgressStatus(db, node.projectId);
    /* 进度 / 挂载关系变化会影响里程碑完成度 → 触发状态重推 */
    refreshMilestoneStatuses(db, node.projectId);
    saveDb();
    /* B7：返回装饰后的单节点（父=Σ直接子节点，叶=存储值） */
    return deepClone(decorateEffort(db.wbsNodes).find((n) => n.id === id) ?? node);
  }

  async deleteWbsNode(id: string): Promise<void> {
    await delay();
    const db = getDb();
    const node = db.wbsNodes.find((n) => n.id === id) ?? nf();
    assertWritable(db, node.projectId);
    const me = assertCan(db, 'wbs.edit', node.projectId);

    const toDelete = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of db.wbsNodes) {
        if (n.parentId && toDelete.has(n.parentId) && !toDelete.has(n.id)) {
          toDelete.add(n.id);
          grew = true;
        }
      }
    }
    db.wbsNodes = db.wbsNodes.filter((n) => !toDelete.has(n.id));
    /* B8（D9）：WBS 写路径不再触碰 effort_hours —— 删除不再清父节点存储值 */
    audit(db, me, 'wbs_node', id, 'delete', node.projectId, `删除节点「${node.wbsCode} ${node.name}」及其 ${toDelete.size - 1} 个子节点`);
    /* R4-P0-3：删除改变父子汇总 → 父链回写 + 状态收敛 */
    syncWbsProgressStatus(db, node.projectId);
    /* 删除叶子会改变里程碑完成度 → 触发状态重推 */
    refreshMilestoneStatuses(db, node.projectId);
    saveDb();
  }

  /** @prd P0-06 拖拽移动节点（防循环 + 父子类型 + 子树整体深度校验 + 重排编码） */
  async moveWbsNode(id: string, newParentId: string | null, index: number): Promise<WbsNode[]> {
    await delay();
    const db = getDb();
    const node = db.wbsNodes.find((n) => n.id === id) ?? nf();
    assertWritable(db, node.projectId);
    const me = assertCan(db, 'wbs.edit', node.projectId);

    // 循环引用检查：新父节点不能是自身或自身后代
    let cursor: string | null = newParentId;
    while (cursor) {
      if (cursor === id) throw new ApiError(ErrorCode.E_WBS_CYCLE);
      cursor = db.wbsNodes.find((n) => n.id === cursor)?.parentId ?? null;
    }

    // 目标父节点归属校验
    const parent = newParentId ? (db.wbsNodes.find((n) => n.id === newParentId) ?? null) : null;
    if (newParentId && !parent) throw new ApiError(ErrorCode.E_NOT_FOUND, '目标父节点不存在');
    if (parent && parent.projectId !== node.projectId) {
      throw new ApiError(ErrorCode.E_VALIDATION, '目标父节点不属于当前项目', { parentId: parent.id });
    }

    // W-2 父子类型 + W-1 子树整体深度（把深树搬到深处绕过 maxDepth 的路径被显式拦截）
    const rules = resolveWbsRules(projectTemplateOf(db, node.projectId));
    const subDepth = subtreeRelativeDepth(db.wbsNodes, node.id);
    const placementError = validateWbsPlacement(
      { nodeType: node.nodeType, parent, subtreeDepth: subDepth },
      rules,
    );
    if (placementError) {
      throw new ApiError(placementError.code, placementError.message, placementError.data);
    }

    /* B8（D9）：移动不再清原父/新父 effort_hours —— 叶子积累后成为父 → 存储值保留、展示走 Σ 子 */
    node.parentId = newParentId;
    const siblings = db.wbsNodes
      .filter((n) => n.projectId === node.projectId && n.parentId === newParentId && n.id !== id)
      .sort((a, b) => compareWbsCode(a.wbsCode, b.wbsCode));
    siblings.splice(Math.max(0, Math.min(index, siblings.length)), 0, node);

    const prefix = parent ? `${parent.wbsCode}.` : '';
    siblings.forEach((s, i) => {
      const newCode = `${prefix}${i + 1}`;
      renameSubtree(db, s, newCode);
    });

    node.updatedAt = nowIso();
    audit(db, me, 'wbs_node', id, 'update', node.projectId, `移动节点「${node.name}」至 ${node.wbsCode}`);
    /* R4-P0-3：移动改变父子结构 → 父链回写 + 状态收敛 */
    syncWbsProgressStatus(db, node.projectId);
    saveDb();
    return deepClone(
      decorateEffort(
        db.wbsNodes.filter((n) => n.projectId === node.projectId).sort((a, b) => compareWbsCode(a.wbsCode, b.wbsCode)),
      ),
    );
  }

  /* ── 看板 ─────────────────────────────────────── */

  async getBoard(projectId: string): Promise<BoardView> {
    await delay(100);
    const db = getDb();
    currentUser(db);
    return deepClone(buildBoard(db, projectId));
  }

  /** @prd P0-07 拖拽改状态（WIP 超限拦截） */
  async moveTask(nodeId: string, status: TaskStatus, order: number): Promise<BoardView> {
    await delay(140);
    const db = getDb();
    const node = db.wbsNodes.find((n) => n.id === nodeId) ?? nf();
    assertWritable(db, node.projectId);
    const me = assertCan(db, 'task.move', node.projectId);
    const config = db.boardConfigs.find((c) => c.projectId === node.projectId);

    if (config && node.status !== status) {
      const exceeded = checkWip(
        db.wbsNodes.filter((n) => n.projectId === node.projectId),
        config,
        status,
        nodeId,
      );
      if (exceeded) {
        throw new ApiError(ErrorCode.E_WIP_EXCEEDED, `「${status}」列 WIP 已达上限 ${exceeded.limit}，请先完成在办任务`, exceeded);
      }
    }

    const before = node.status;
    node.status = status;
    node.boardOrder = order;
    if (status === '完成') node.progress = 100;
    else if (status === '待办' && node.progress === 100) node.progress = 0;
    node.actualDays = Number(((node.estimateDays * node.progress) / 100).toFixed(1));
    node.updatedAt = nowIso();

    /* R4-P0-3：拖「进行中」但 progress=100 会被强规则收敛回「完成」（PRD 强规则字面语义） */
    syncWbsProgressStatus(db, node.projectId);
    /* R4-P1-1 D3 联动缺口修复：看板拖拽改变进度后刷新里程碑 taskStats/状态 */
    refreshMilestoneStatuses(db, node.projectId);

    if (before !== status) {
      audit(db, me, 'wbs_node', nodeId, 'status_change', node.projectId, `任务「${node.name}」状态由「${before}」变更为「${status}」`, [
        { field: 'status', label: '任务状态', before, after: status },
      ]);
    }
    saveDb();
    return deepClone(buildBoard(db, node.projectId));
  }

  async updateBoardConfig(projectId: string, wipLimits: Record<string, number>): Promise<BoardConfig> {
    await delay();
    const db = getDb();
    const me = assertCan(db, 'board.config', projectId);
    let config = db.boardConfigs.find((c) => c.projectId === projectId);
    if (!config) {
      config = { projectId, columns: [...BOARD_COLUMNS], wipLimits: {}, updatedAt: nowIso() };
      db.boardConfigs.push(config);
    }
    config.wipLimits = wipLimits;
    config.updatedAt = nowIso();
    audit(db, me, 'project', projectId, 'update', projectId, `调整看板 WIP 限制：${JSON.stringify(wipLimits)}`);
    saveDb();
    return deepClone(config);
  }

  /* ── 周报 ─────────────────────────────────────── */

  async listReports(projectId: string): Promise<Report[]> {
    await delay(100);
    const db = getDb();
    currentUser(db);
    return deepClone(db.reports.filter((r) => r.projectId === projectId).sort((a, b) => (a.week < b.week ? 1 : -1)));
  }

  async getReport(projectId: string, week: string): Promise<Report | null> {
    await delay(80);
    const db = getDb();
    currentUser(db);
    const r = db.reports.find((x) => x.projectId === projectId && x.week === week);
    return r ? deepClone(r) : null;
  }

  /** @prd P0-08 保存草稿 */
  async saveReport(payload: ReportPayload): Promise<Report> {
    return this.upsertReport(payload, '草稿');
  }

  /** @prd P0-08 提交周报（风险行强校验 + 进度快照冻结） */
  async submitReport(payload: ReportPayload): Promise<Report> {
    const v = validateReport(payload);
    if (!v.ok) {
      throw new ApiError(ErrorCode.E_REPORT_RISK_INCOMPLETE, v.messages.join('；'), v);
    }
    return this.upsertReport(payload, '已提交');
  }

  private async upsertReport(payload: ReportPayload, status: Report['status']): Promise<Report> {
    await delay(200);
    const db = getDb();
    assertWritable(db, payload.projectId);
    const me = assertCan(db, 'report.write', payload.projectId);
    const range = weekRange(payload.week);
    const ts = nowIso();

    /* B8（R5）：mock 与后端同构 —— actualDays 结构校验（0~100/≤2 位小数/未勾选拒绝/父节点拒绝） */
    const parentIdsOf = parentIdSet(db.wbsNodes);
    payload.tasks.forEach((t) => {
      assertActualDaysValid(t, parentIdsOf.has(t.nodeId));
    });

    // 用户反馈⑤：工作日志允许同周多次提交，不再按周次查重；每次存/交均新建一条
    const report: Report = {
      id: genId('RP'),
      projectId: payload.projectId,
      week: payload.week,
      weekStart: range.start,
      weekEnd: range.end,
      author: me.openId,
      authorName: me.name,
      status,
      doneNote: '',
      planItems: [],
      resourceNote: '',
      tasks: [],
      risks: [],
      snapshot: null,
      submittedAt: null,
      // B14-块2：新建/提交时确认三字段恒空（确认态只由 confirmReport/rejectReport 写入）
      confirmedBy: null,
      confirmedAt: null,
      rejectReason: null,
      createdAt: ts,
      updatedAt: ts,
    };
    db.reports.push(report);
    const isNew = true;

    report.status = status;
    report.doneNote = payload.doneNote;
    report.planItems = payload.planItems.filter((p) => p.trim());
    report.resourceNote = payload.resourceNote;
    report.updatedAt = ts;

    report.tasks = payload.tasks.map<ReportTaskRow>((t) => {
      const node = db.wbsNodes.find((n) => n.id === t.nodeId);
      return {
        reportId: report!.id,
        nodeId: t.nodeId,
        nodeCode: node?.wbsCode ?? '',
        nodeName: node?.name ?? '',
        progressBefore: node?.progress ?? 0,
        progressAfter: t.progressAfter,
        selected: t.selected,
        // B8（R3）：本周实际人日（仅勾选行携带；未勾选 / 父节点为 0）
        weekActualDays: t.actualDays ?? 0,
      };
    });

    report.risks = payload.risks.map<ReportRisk>((r, i) => ({
      id: `${report!.id}-RK${i + 1}`,
      reportId: report!.id,
      seq: i + 1,
      description: r.description,
      owner: r.owner,
      dueDate: r.dueDate,
      promotedRiskId: null,
    }));

    if (status === '已提交') {
      // 提交时回写任务进度并冻结快照
      const snapshot: Record<string, number> = {};
      report.tasks.forEach((t) => {
        const node = db.wbsNodes.find((n) => n.id === t.nodeId);
        if (node) {
          node.progress = t.progressAfter;
          node.actualDays = Number(((node.estimateDays * node.progress) / 100).toFixed(1));
          node.updatedAt = ts;
        }
        snapshot[t.nodeId] = t.progressAfter;
      });
      /* B8（R3）：提交日志 → 累加实际工时（人日）到节点（仅勾选；草稿不累加） */
      report.tasks.forEach((t) => {
        const node = db.wbsNodes.find((n) => n.id === t.nodeId);
        if (node && t.selected) {
          const next = (node.effortHours ?? 0) + (t.weekActualDays ?? 0);
          if (next < 0 || next > EFFORT_DAYS_CUM_MAX) {
            throw new ApiError(
              ErrorCode.E_VALIDATION,
              `累计实际工时（人日）须为 0~${EFFORT_DAYS_CUM_MAX}，当前操作将超出该范围`,
              { nodeId: t.nodeId, next },
            );
          }
          node.effortHours = next;
        }
      });
      /* R4-P0-3：进度→状态自动流转统一收口（父节点回写 + 状态收敛），
       * 不再散落 if(progress>=100) 类判断（规则唯一实现 syncNodeStatusFromProgress） */
      syncWbsProgressStatus(db, payload.projectId);
      /* R4-P1-1 D3 联动缺口修复：日志提交回写进度后刷新里程碑 taskStats/状态 */
      refreshMilestoneStatuses(db, payload.projectId);
      report.snapshot = snapshot;
      report.submittedAt = ts;
      audit(db, me, 'report', report.id, isNew ? 'create' : 'update', payload.projectId, `提交 ${payload.week} 周报，冻结 ${report.tasks.length} 条任务进度快照`, [
        { field: 'status', label: '周报状态', before: '草稿', after: '已提交' },
      ]);
    }

    saveDb();
    return deepClone(report);
  }

  /** @prd P0-08 编辑已有周报（按 id 原地更新，不复用周次查重） */
  async updateReport(id: string, payload: ReportPayload): Promise<Report> {
    await delay(150);
    const db = getDb();
    const report = db.reports.find((r) => r.id === id) ?? nf();
    assertWritable(db, report.projectId);
    const me = assertCan(db, 'report.write', report.projectId);
    const ts = nowIso();

    /* B8（R5）：mock 与后端同构 —— actualDays 结构校验（0~100/≤2 位小数/未勾选拒绝/父节点拒绝） */
    const parentIdsOf = parentIdSet(db.wbsNodes);
    payload.tasks.forEach((t) => {
      assertActualDaysValid(t, parentIdsOf.has(t.nodeId));
    });

    /* B8（R4）：已提交日志先扣旧后加新（同构后端）；草稿不冲正 */
    const wasSubmitted = report.status === '已提交';
    const oldTaskRows = report.tasks;
    if (wasSubmitted) {
      oldTaskRows.forEach((t) => {
        const node = db.wbsNodes.find((n) => n.id === t.nodeId);
        if (node) {
          const next = (node.effortHours ?? 0) - (t.weekActualDays ?? 0);
          if (next < 0 || next > EFFORT_DAYS_CUM_MAX) {
            throw new ApiError(
              ErrorCode.E_VALIDATION,
              `累计实际工时（人日）须为 0~${EFFORT_DAYS_CUM_MAX}，当前冲正将超出该范围`,
              { nodeId: t.nodeId, next },
            );
          }
          node.effortHours = next;
        }
      });
      payload.tasks.forEach((t) => {
        const node = db.wbsNodes.find((n) => n.id === t.nodeId);
        if (node && t.selected) {
          const next = (node.effortHours ?? 0) + (t.actualDays ?? 0);
          if (next < 0 || next > EFFORT_DAYS_CUM_MAX) {
            throw new ApiError(
              ErrorCode.E_VALIDATION,
              `累计实际工时（人日）须为 0~${EFFORT_DAYS_CUM_MAX}，当前冲正将超出该范围`,
              { nodeId: t.nodeId, next },
            );
          }
          node.effortHours = next;
        }
      });
    }

    report.doneNote = payload.doneNote;
    report.planItems = payload.planItems.filter((p) => p.trim());
    report.resourceNote = payload.resourceNote;
    report.updatedAt = ts;
    report.tasks = payload.tasks.map<ReportTaskRow>((t) => {
      const node = db.wbsNodes.find((n) => n.id === t.nodeId);
      return {
        reportId: report.id,
        nodeId: t.nodeId,
        nodeCode: node?.wbsCode ?? '',
        nodeName: node?.name ?? '',
        progressBefore: node?.progress ?? 0,
        progressAfter: t.progressAfter,
        selected: t.selected,
        // B8（R3）：本周实际人日（仅勾选行携带；未勾选 / 父节点为 0）
        weekActualDays: t.actualDays ?? 0,
      };
    });
    report.risks = payload.risks.map<ReportRisk>((r, i) => ({
      id: `${report.id}-RK${i + 1}`,
      reportId: report.id,
      seq: i + 1,
      description: r.description,
      owner: r.owner,
      dueDate: r.dueDate,
      promotedRiskId: null,
    }));

    saveDb();
    return deepClone(report);
  }

  /* ── 周报轻量闭环 B14-块2（与后端 report.service 同构） ─────────── */

  /**
   * 确认人解析（架构 §1.3 的 Mock 同构实现）。
   *
   * 权威源 = `project_members(project_role='pm')`（mock 里即 `db.members` 的 `projectRole==='pm'`）；
   * 作者本人恒被剔除 → 天然保证「作者不能确认自己」；
   * 作者即 PM（或项目无 PM）→ 升级为 `tl` ∪ `global_role='admin'`。
   *
   * ⚠️ 唯一权威实现在后端 `report.service#resolveConfirmers`；本函数仅供 Mock 演示态使用。
   */
  private resolveConfirmers(db: MockDb, projectId: string, authorOpenId: string): Set<string> {
    const pm = db.members
      .filter((m) => m.projectId === projectId && m.projectRole === 'pm')
      .map((m) => m.userOpenId);

    let result: string[];
    if (pm.length === 0 || pm.includes(authorOpenId)) {
      const tl = db.members
        .filter((m) => m.projectId === projectId && m.projectRole === 'tl')
        .map((m) => m.userOpenId);
      const admins = db.users.filter((u) => u.globalRole === 'admin').map((u) => u.openId);
      result = [...tl, ...admins];
    } else {
      result = pm;
    }

    const set = new Set(result.filter((x) => Boolean(x)));
    set.delete(authorOpenId);
    return set;
  }

  /** 取「已提交」周报并校验当前用户是否为确认人；失败按后端同码抛错 */
  private assertConfirmable(db: MockDb, id: string, meOpenId: string): Report {
    const report = db.reports.find((r) => r.id === id) ?? nf();
    if (report.status !== '已提交') {
      throw new ApiError(ErrorCode.E_VALIDATION, `仅「已提交」的周报可确认或打回，当前状态：${report.status}`, {
        id,
        status: report.status,
      });
    }
    const confirmers = this.resolveConfirmers(db, report.projectId, report.author);
    if (!confirmers.has(meOpenId)) {
      throw new ApiError(ErrorCode.E_FORBIDDEN, '你不是该周报的确认人（作者本人不可确认自己的周报）', {
        id,
      });
    }
    return report;
  }

  /** B14-块2：确认周报 → `已确认` + 写 `confirmedBy/confirmedAt`，清空打回原因 */
  async confirmReport(projectId: string, id: string): Promise<Report> {
    await delay(150);
    const db = getDb();
    assertWritable(db, projectId);
    const me = currentUser(db);
    const report = this.assertConfirmable(db, id, me.openId);
    const ts = nowIso();

    report.status = '已确认';
    report.confirmedBy = me.openId;
    report.confirmedAt = ts;
    report.rejectReason = null;
    report.updatedAt = ts;

    audit(db, me, 'report', report.id, 'approve', report.projectId, `确认周报「${report.week}」`);
    saveDb();
    return deepClone(report);
  }

  /** B14-块2：打回周报 → 回退 `草稿` + 写 `rejectReason`（必填），清空确认字段 */
  async rejectReport(projectId: string, id: string, reason: string): Promise<Report> {
    await delay(150);
    const db = getDb();
    assertWritable(db, projectId);
    const me = currentUser(db);

    const trimmed = String(reason ?? '').trim();
    if (!trimmed) {
      throw new ApiError(ErrorCode.E_VALIDATION, '打回原因不能为空', { fields: { reason: '必填' } });
    }
    if (trimmed.length > REJECT_REASON_MAX) {
      throw new ApiError(ErrorCode.E_VALIDATION, `打回原因不能超过 ${REJECT_REASON_MAX} 字`, {
        fields: { reason: '过长' },
      });
    }

    const report = this.assertConfirmable(db, id, me.openId);
    const ts = nowIso();

    report.status = '草稿';
    report.rejectReason = trimmed;
    report.confirmedBy = null;
    report.confirmedAt = null;
    report.updatedAt = ts;

    audit(db, me, 'report', report.id, 'reject', report.projectId, `打回周报「${report.week}」：${trimmed}`);
    saveDb();
    return deepClone(report);
  }

  /** B14-块2：待我确认的周报（跨项目聚合，服务端过滤口径同构） */
  async listPendingConfirmation(): Promise<Report[]> {
    await delay(120);
    const db = getDb();
    const me = currentUser(db);

    const rows = db.reports
      .filter((r) => r.status === '已提交')
      .filter((r) => this.resolveConfirmers(db, r.projectId, r.author).has(me.openId))
      .sort((a, b) => String(b.submittedAt ?? '').localeCompare(String(a.submittedAt ?? '')));

    return deepClone(rows);
  }

  /* ── 工时统计报表 B9（只读聚合 · 与后端 report.service#getEffortReport 同构） ── */

  /**
   * B9（R2/R3/R4）：工时统计报表。
   * 行/汇总复用文件内 `decorateEffort`（与后端 loadNodes 出参同口径），
   * 父估算 = Σ 子树叶子（读时算、不落库）；breakdown 仅已提交 & weekActualDays>0，周倒序。
   */
  async getEffortReport(projectId: string): Promise<EffortReport> {
    await delay(120);
    const db = getDb();
    currentUser(db);
    const nodes = decorateEffort(db.wbsNodes.filter((n) => n.projectId === projectId));

    /* parentId → 直接子数组（'__root__' = 根层），叶子判定唯一入口（SK-4） */
    const childrenOf = new Map<string, WbsNode[]>();
    for (const n of nodes) {
      const key = n.parentId ?? '__root__';
      const arr = childrenOf.get(key);
      if (arr) arr.push(n);
      else childrenOf.set(key, [n]);
    }
    const isLeaf = (n: WbsNode): boolean => !(childrenOf.get(n.id) ?? []).length;

    /* 父估算 = Σ 子树叶子 estimateDays（读时算、不落库，与后端 buildEstimateIndex 同构） */
    const estMemo = new Map<string, number>();
    const estimateOf = (n: WbsNode, guard: number): number => {
      if (guard > 64) return 0; // 防御性：脏数据成环时兜底
      const cached = estMemo.get(n.id);
      if (cached !== undefined) return cached;
      const kids = childrenOf.get(n.id) ?? [];
      const v = kids.length
        ? kids.reduce((s, k) => s + estimateOf(k, guard + 1), 0)
        : (Number(n.estimateDays) || 0);
      estMemo.set(n.id, v);
      return v;
    };

    /* 里程碑 badge：一次查表带 code/name */
    const msMap = new Map<string, { code: string; name: string }>();
    for (const m of db.milestones) msMap.set(m.id, { code: m.code, name: m.name });

    const rows: EffortReportRow[] = nodes.map((n) => {
      const leaf = isLeaf(n);
      const estimateDays = estimateOf(n, 0);
      const effortHours = Number(n.effortHours) || 0;
      const diff = effortHours - estimateDays;
      const diffRate = estimateDays > 0 ? effortHours / estimateDays - 1 : null;
      const ms = n.milestoneId ? msMap.get(n.milestoneId) : null;
      return {
        id: n.id,
        parentId: n.parentId,
        wbsCode: n.wbsCode,
        level: n.level,
        nodeType: n.nodeType,
        name: n.name,
        owner: n.owner,
        ownerName: n.ownerName,
        estimateDays,
        effortHours,
        effortChildCount: Number(n.effortChildCount) || 0,
        diff,
        diffRate,
        isOverrun: effortHours > estimateDays,
        progress: n.progress,
        status: n.status,
        isLeaf: leaf,
        milestoneId: n.milestoneId,
        milestoneCode: ms?.code ?? '',
        milestoneName: ms?.name ?? '',
      };
    });

    const leaves = nodes.filter((n) => isLeaf(n));
    const estimateTotal = leaves.reduce((s, n) => s + (Number(n.estimateDays) || 0), 0);
    const actualTotal = leaves.reduce((s, n) => s + (Number(n.effortHours) || 0), 0);
    const summary: EffortSummary = {
      estimateTotal,
      actualTotal,
      diff: actualTotal - estimateTotal,
      diffRate: estimateTotal > 0 ? actualTotal / estimateTotal - 1 : null,
      overrunCount: leaves.filter((n) => (Number(n.effortHours) || 0) > (Number(n.estimateDays) || 0)).length,
      leafCount: leaves.length,
      parentCount: nodes.length - leaves.length,
    };

    /* breakdown：仅已提交 & selected & weekActualDays>0，周倒序（同周按 submittedAt 升序） */
    const effortBreakdown: Record<string, EffortBreakdownItem[]> = {};
    const submitted = db.reports
      .filter((r) => r.projectId === projectId && r.status === '已提交')
      .sort((a, b) => {
        if (a.week !== b.week) return a.week < b.week ? 1 : -1;
        const sa = a.submittedAt ?? '';
        const sb = b.submittedAt ?? '';
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
    for (const r of submitted) {
      for (const t of r.tasks) {
        if (!t.selected) continue;
        const days = Number(t.weekActualDays) || 0;
        if (days <= 0) continue;
        const list = effortBreakdown[t.nodeId] ?? (effortBreakdown[t.nodeId] = []);
        list.push({ week: r.week, reporterName: r.authorName, submittedAt: r.submittedAt, weekActualDays: days });
      }
    }

    return deepClone({ projectId, summary, rows, effortBreakdown });
  }

  async listReviews(projectId?: string): Promise<Review[]> {
    await delay(100);
    const db = getDb();
    currentUser(db);
    const rows = projectId ? db.reviews.filter((r) => r.projectId === projectId) : db.reviews;
    return deepClone([...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }

  /** @prd P0-13 我的待办审批 */
  async listMyApprovals(): Promise<Review[]> {
    await delay(100);
    const db = getDb();
    const me = currentUser(db);
    const rows = db.reviews.filter((r) => canDecide(r, me.openId) !== null);
    return deepClone(rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }

  /* ── 评审 ─────────────────────────────────────── */

  async getReview(id: string): Promise<Review> {
    await delay(80);
    const db = getDb();
    currentUser(db);
    return deepClone(db.reviews.find((r) => r.id === id) ?? nf());
  }

  /** @prd P0-09 发起评审（按模板生成审批链） */
  async createReview(payload: CreateReviewPayload): Promise<Review> {
    await delay(200);
    const db = getDb();
    assertWritable(db, payload.projectId);
    const me = assertCan(db, 'review.create', payload.projectId);
    const tpl = REVIEW_TEMPLATES[payload.reviewType];
    const project = db.projects.find((p) => p.id === payload.projectId) ?? nf();
    const id = genId('RV');
    const ts = nowIso();

    const steps = buildSteps(db, id, payload.projectId, tpl.chain, payload.assignees);
    if (tpl.mode === 'parallel_veto') steps.forEach((s) => (s.status = 'current'));

    const review: Review = {
      id,
      projectId: payload.projectId,
      projectName: project.name,
      refType: payload.refType,
      refId: payload.refId,
      reviewType: payload.reviewType,
      title: payload.title,
      templateKey: tpl.key,
      mode: tpl.mode,
      status: '审批中',
      currentStep: 0,
      initiator: me.openId,
      initiatorName: me.name,
      createdAt: ts,
      updatedAt: ts,
      closedAt: null,
      steps,
      approvals: [
        {
          id: `${id}-A0`,
          reviewId: id,
          projectId: payload.projectId,
          stepIndex: -1,
          stepRole: 'initiator',
          actorOpenId: me.openId,
          actorName: me.name,
          action: 'submit',
          comment: '发起评审',
          evidenceUrl: '',
          createdAt: ts,
        },
      ],
    };
    db.reviews.push(review);
    audit(db, me, 'review', id, 'create', payload.projectId, `发起评审「${payload.title}」（${tpl.label}·${tpl.mode}）`);
    saveDb();
    return deepClone(review);
  }

  /** @prd P0-09 审批通过 */
  async approveReview(id: string, payload: DecisionPayload): Promise<Review> {
    return this.decide(id, 'approve', payload);
  }

  /** @prd P0-09 审批驳回 */
  async rejectReview(id: string, payload: DecisionPayload): Promise<Review> {
    if (!payload.comment.trim()) throw new ApiError(ErrorCode.E_VALIDATION, '驳回必须填写意见');
    return this.decide(id, 'reject', payload);
  }

  async withdrawReview(id: string, payload: DecisionPayload): Promise<Review> {
    await delay();
    const db = getDb();
    const review = db.reviews.find((r) => r.id === id) ?? nf();
    const me = currentUser(db);
    if (review.status !== '审批中') throw new ApiError(ErrorCode.E_REVIEW_CLOSED);
    if (review.initiator !== me.openId && me.globalRole !== 'admin') {
      throw new ApiError(ErrorCode.E_FORBIDDEN, '仅发起人可撤回');
    }
    review.status = '已撤回';
    review.closedAt = nowIso();
    review.updatedAt = nowIso();
    review.approvals.push({
      id: genId('AP'),
      reviewId: id,
      projectId: review.projectId,
      stepIndex: review.currentStep,
      stepRole: 'initiator',
      actorOpenId: me.openId,
      actorName: me.name,
      action: 'withdraw',
      comment: payload.comment,
      evidenceUrl: payload.evidenceUrl ?? '',
      createdAt: nowIso(),
    });
    audit(db, me, 'review', id, 'update', review.projectId, `撤回评审「${review.title}」`);
    saveDb();
    return deepClone(review);
  }

  private async decide(id: string, action: 'approve' | 'reject', payload: DecisionPayload): Promise<Review> {
    await delay(200);
    const db = getDb();
    const review = db.reviews.find((r) => r.id === id) ?? nf();
    const me = currentUser(db);
    if (review.status !== '审批中') throw new ApiError(ErrorCode.E_REVIEW_CLOSED);

    const step = canDecide(review, me.openId);
    if (!step) throw new ApiError(ErrorCode.E_NOT_APPROVER);
    if (step.role === 'customer_rep' && !payload.comment.trim() && !payload.evidenceUrl) {
      throw new ApiError(ErrorCode.E_PROXY_EVIDENCE_REQUIRED);
    }

    const ts = nowIso();
    step.status = action === 'approve' ? 'approved' : 'rejected';
    step.decidedBy = me.openId;
    step.decidedByName = me.name;
    step.decidedAt = ts;
    step.comment = payload.comment;

    review.approvals.push({
      id: genId('AP'),
      reviewId: id,
      projectId: review.projectId,
      stepIndex: step.stepIndex,
      stepRole: step.role,
      actorOpenId: me.openId,
      actorName: me.name,
      action,
      comment: payload.comment,
      evidenceUrl: payload.evidenceUrl ?? '',
      createdAt: ts,
    });

    if (action === 'reject') {
      review.status = '已驳回';
      review.closedAt = ts;
      review.steps.forEach((s) => {
        if (s.status === 'current' || s.status === 'pending') s.status = 'skipped';
      });
      audit(db, me, 'review', id, 'reject', review.projectId, `驳回评审「${review.title}」：${payload.comment}`, [
        { field: 'status', label: '评审状态', before: '审批中', after: '已驳回' },
      ]);
    } else if (review.mode === 'parallel_veto') {
      const allDone = review.steps.every((s) => s.status === 'approved');
      if (allDone) {
        review.status = '已通过';
        review.closedAt = ts;
        onReviewApproved(db, review, me);
      }
      audit(db, me, 'review', id, 'approve', review.projectId, `${me.name} 在「${review.title}」投出通过票`);
    } else {
      const nextIdx = review.currentStep + 1;
      if (nextIdx >= review.steps.length) {
        review.status = '已通过';
        review.currentStep = review.steps.length;
        review.closedAt = ts;
        onReviewApproved(db, review, me);
        audit(db, me, 'review', id, 'approve', review.projectId, `评审「${review.title}」终审通过`, [
          { field: 'status', label: '评审状态', before: '审批中', after: '已通过' },
        ]);
      } else {
        review.currentStep = nextIdx;
        review.steps[nextIdx].status = 'current';
        audit(db, me, 'review', id, 'approve', review.projectId, `评审「${review.title}」第 ${step.stepIndex + 1} 步通过，流转至下一审批人`);
      }
    }

    review.updatedAt = ts;
    saveDb();
    return deepClone(review);
  }

  /* ── 变更 ─────────────────────────────────────── */

  /** @prd P0-14 路由实时预判 */
  async routeChange(input: { changeType: Change['changeType']; effortDays: number; targetType: string }): Promise<RouteResult> {
    await delay(60);
    return routeOfChange(input);
  }

  async listChanges(projectId: string): Promise<Change[]> {
    await delay(100);
    const db = getDb();
    currentUser(db);
    return deepClone(db.changes.filter((c) => c.projectId === projectId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }

  async getChange(id: string): Promise<Change> {
    await delay(80);
    const db = getDb();
    currentUser(db);
    return deepClone(db.changes.find((c) => c.id === id) ?? nf());
  }

  /** @prd P0-14 创建变更单 */
  async createChange(payload: ChangePayloadInput): Promise<Change> {
    await delay(200);
    const db = getDb();
    assertWritable(db, payload.projectId);
    const me = assertCan(db, 'change.create', payload.projectId);
    const routing = routeOfChange({
      changeType: payload.changeType,
      effortDays: payload.effortDays,
      targetType: payload.targetType,
    });
    const seq = db.changes.filter((c) => c.projectId === payload.projectId).length + 1;
    const id = genId('CR');
    const change: Change = {
      id,
      projectId: payload.projectId,
      code: `CR-${String(seq).padStart(3, '0')}`,
      changeType: payload.changeType,
      title: payload.title,
      content: payload.content,
      impactAnalysis: payload.impactAnalysis,
      effortDays: payload.effortDays,
      targetType: payload.targetType,
      targetId: payload.targetId,
      payload: (payload.payload ?? {}) as Change['payload'],
      route: routing.route,
      status: '草稿',
      reviewId: null,
      createdBy: me.openId,
      createdByName: me.name,
      createdAt: nowIso(),
      appliedAt: null,
    };
    db.changes.push(change);
    audit(db, me, 'change', id, 'create', payload.projectId, `提交变更单 ${change.code}「${payload.title}」，路由判定 ${routing.route === 'ccb' ? 'CCB' : 'PM 直批'}`, [
      { field: 'route', label: '审批路由', before: '', after: routing.route === 'ccb' ? 'CCB 变更控制委员会' : '仅 PM 审批' },
    ]);
    saveDb();
    return deepClone(change);
  }

  /** @prd P0-14 提交变更单进入审批 */
  async submitChange(id: string): Promise<Change> {
    await delay(200);
    const db = getDb();
    const change = db.changes.find((c) => c.id === id) ?? nf();
    assertWritable(db, change.projectId);
    const me = assertCan(db, 'change.create', change.projectId);
    if (change.status !== '草稿') throw new ApiError(ErrorCode.E_VALIDATION, '仅草稿状态可提交');

    const reviewType = change.route === 'ccb' ? 'ccb' : 'technical';
    const tpl = REVIEW_TEMPLATES[reviewType];
    const rid = genId('RV');
    const ts = nowIso();
    const steps = buildSteps(db, rid, change.projectId, tpl.chain);
    const project = db.projects.find((p) => p.id === change.projectId);

    db.reviews.push({
      id: rid,
      projectId: change.projectId,
      projectName: project?.name ?? '',
      refType: 'change',
      refId: change.id,
      reviewType: tpl.key,
      title: `${change.code} ${change.title} · ${tpl.label}`,
      templateKey: tpl.key,
      mode: tpl.mode,
      status: '审批中',
      currentStep: 0,
      initiator: me.openId,
      initiatorName: me.name,
      createdAt: ts,
      updatedAt: ts,
      closedAt: null,
      steps,
      approvals: [
        {
          id: `${rid}-A0`,
          reviewId: rid,
          projectId: change.projectId,
          stepIndex: -1,
          stepRole: 'initiator',
          actorOpenId: me.openId,
          actorName: me.name,
          action: 'submit',
          comment: '提交变更审批',
          evidenceUrl: '',
          createdAt: ts,
        },
      ],
    });

    change.status = '审批中';
    change.reviewId = rid;
    audit(db, me, 'change', id, 'update', change.projectId, `变更单 ${change.code} 提交${tpl.label}`);
    saveDb();
    return deepClone(change);
  }

  /** @prd P0-14 实施变更（唯一可改里程碑当前日期的入口） */
  async applyChange(id: string): Promise<Change> {
    await delay(250);
    const db = getDb();
    const change = db.changes.find((c) => c.id === id) ?? nf();
    assertWritable(db, change.projectId);
    const me = assertCan(db, 'change.apply', change.projectId);
    if (change.status !== '已批准') throw new ApiError(ErrorCode.E_VALIDATION, '仅已批准的变更单可实施');

    if (change.changeType === 'milestone_date' && change.targetType === 'milestone') {
      const ms = db.milestones.find((m) => m.id === change.targetId);
      const toDate = String(change.payload.toDate ?? '');
      if (ms && toDate) {
        const before = ms.currentDate;
        ms.currentDate = toDate;
        ms.delayDays = diffDays(ms.baselineDate, toDate);
        /* SK-2：只改日期这一个真值，status / done 交给 refreshMilestoneStatuses 推导；
         * SK-7：改期后人工覆盖自动作废 */
        clearOverride(ms);
        ms.lastChangeId = change.id;
        ms.updatedAt = nowIso();
        audit(db, me, 'milestone', ms.id, 'apply', change.projectId, `变更实施：${ms.code} 当前日期调整（基线日期保持不变）`, [
          { field: 'currentDate', label: '当前日期', before, after: toDate },
          { field: 'delayDays', label: '累计延期', after: `${ms.delayDays} 天`, before: '' },
        ]);
        /* P0-M1 触发点④：变更单回写里程碑日期后重排 */
        renumberMilestones(db, change.projectId);
      }
    }

    change.status = '已实施';
    change.appliedAt = nowIso();
    /* 里程碑日期变动会连带改变起算日 → 全项目重推状态（内含健康度重算） */
    refreshMilestoneStatuses(db, change.projectId);
    audit(db, me, 'change', id, 'apply', change.projectId, `变更单 ${change.code} 已实施`);
    saveDb();
    return deepClone(change);
  }

  /* ── 审计 ─────────────────────────────────────── */

  /** @prd P0-15 审计日志查询 */
  async listAudit(query: AuditQuery): Promise<Paged<AuditLog>> {
    await delay(120);
    const db = getDb();
    currentUser(db);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 30;
    let rows = [...db.auditLogs];
    if (query.projectId) rows = rows.filter((l) => l.projectId === query.projectId);
    if (query.entityType) rows = rows.filter((l) => l.entityType === query.entityType);
    if (query.action) rows = rows.filter((l) => l.action === query.action);
    if (query.actor) rows = rows.filter((l) => l.actorOpenId === query.actor || l.actorName === query.actor);
    if (query.from) rows = rows.filter((l) => l.createdAt.slice(0, 10) >= query.from!);
    if (query.to) rows = rows.filter((l) => l.createdAt.slice(0, 10) <= query.to!);
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
  }

  /* ── 工作台 ───────────────────────────────────── */

  /** @prd P0-13 我的工作台聚合 */
  async getWorkbench(): Promise<WorkbenchData> {
    await delay(180);
    const db = getDb();
    const me = currentUser(db);

    const myProjectIds = new Set(db.members.filter((m) => m.userOpenId === me.openId).map((m) => m.projectId));
    const myProjects = db.projects
      .filter((p) => myProjectIds.has(p.id) && p.status !== '已结项' && p.status !== '已终止')
      .map((p) => toListItem(db, p));

    /* Q-3：我的任务 = 我负责的真叶子（无子节点），不再以 nodeType==='task' 判定 */
    /* B11：与真后端 listMyTasks 对齐，纯追加 projectName（逾期柱状图按项目分组用） */
    const projectNameById = new Map(db.projects.map((p) => [p.id, p.name]));
    const myTasks = leafNodesOf(db.wbsNodes)
      .filter((n) => n.owner === me.openId && n.status !== '完成')
      .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))
      .map((n) => ({ ...n, projectName: projectNameById.get(n.projectId) ?? '' }));

    const myApprovals = db.reviews.filter((r) => canDecide(r, me.openId) !== null);

    const curWeek = weekCode(today());
    const range = weekRange(curWeek);
    const reportReminders: ReportReminder[] = db.projects
      .filter((p) => myProjectIds.has(p.id) && p.status === '进行中')
      .map((p) => {
        const filled = db.reports.some((r) => r.projectId === p.id && r.week === curWeek && r.status === '已提交');
        return {
          projectId: p.id,
          projectName: p.name,
          week: curWeek,
          weekStart: range.start,
          weekEnd: range.end,
          filled,
        };
      });

    const overdueTasks = myTasks.filter((t) => diffDays(today(), t.dueDate) < 0).length;

    return deepClone({
      stats: {
        pendingApprovals: myApprovals.length,
        overdueTasks,
        missingReports: reportReminders.filter((r) => !r.filled).length,
      },
      myProjects,
      myTasks,
      myApprovals,
      reportReminders,
    });
  }

  /* ── 全局总览 B12 ─────────────────────────────── */

  /**
   * 全局总览（对应 `GET /api/dashboard/overview`）。
   *
   * 与服务端 `dashboard.service.getDashboardOverview` **字段逐个对齐**：
   *  - 决策 ①：`dashboard:global` 决定能否看公司全量；无权限恒降级为 `mine`（不抛 403）
   *  - 决策 ②：`timeRange` 接受但忽略
   *  - 决策 ③：负责人负荷 = 在办任务数 + 逾期数
   *  - 决策 ⑥：统计基线恒为在管三态，非法 `status` 入参直接丢弃
   *
   * ⚠ 已知口径差异（Mock 内部自洽优先）：`toListItem` 的 `progress` 在 Mock 里是
   *   **WBS 加权**（`rollupProjectProgress`），服务端是**里程碑达成率**。这是 B11 前既有的
   *   Mock/真后端差异，本期不在 B12 内擅自纠偏，以免 Mock 的总览与项目列表页自相矛盾。
   */
  async getDashboardOverview(query: DashboardOverviewQuery): Promise<DashboardOverview> {
    await delay(200);
    const db = getDb();
    const me = currentUser(db);

    /* 1. 范围解析（决策 ① / ⑤） */
    const canSeeAll = canDo(me.globalRole, 'dashboard:global');
    const scope: DashboardScope = canSeeAll ? (query.scope === 'mine' ? 'mine' : 'all') : 'mine';

    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(
      DASHBOARD_MAX_PAGE_SIZE,
      Math.max(1, Number(query.pageSize) || DASHBOARD_PAGE_SIZE),
    );
    const sort = query.sort ?? 'health';

    /* 2. 项目范围（决策 ⑥ 三态基线 + scope + 过滤条件） */
    const statusFilter =
      query.status && DASHBOARD_MANAGED_STATUSES.includes(query.status) ? query.status : '';

    const myProjectIds = new Set(
      db.members.filter((m) => m.userOpenId === me.openId).map((m) => m.projectId),
    );
    const myPmProjectIds = new Set(
      db.members
        .filter((m) => m.userOpenId === me.openId && m.projectRole === 'pm')
        .map((m) => m.projectId),
    );

    let items = db.projects
      .filter((p) =>
        statusFilter ? p.status === statusFilter : DASHBOARD_MANAGED_STATUSES.includes(p.status),
      )
      .filter((p) => {
        if (scope === 'all') return true;
        return query.onlyMine ? myPmProjectIds.has(p.id) : myProjectIds.has(p.id);
      })
      .map((p) => toListItem(db, p));

    if (query.type) items = items.filter((r) => r.type === query.type);
    if (query.health) items = items.filter((r) => r.health === query.health);
    if (query.keyword) {
      const k = query.keyword.trim().toLowerCase();
      if (k) {
        items = items.filter(
          (r) =>
            r.name.toLowerCase().includes(k) ||
            r.code.toLowerCase().includes(k) ||
            r.customer.toLowerCase().includes(k),
        );
      }
    }

    /* D01.5：选项池基准 = 应用 type/status/health/keyword 但**不含 ownerOpenId** 的项目集
       （负责人选项不随负责人筛选漂移，与服务端 listScopedRows(Object.assign({}, q, {ownerOpenId:''})) 对齐） */
    const itemsBase = items;

    /* D01.5：任务负责人筛选 —— 项目内含该负责人（openId）的真叶子任务即命中（与服务端 EXISTS 子查询同口径） */
    if (query.ownerOpenId) {
      const ownerProjectIds = new Set(
        leafNodesOf(db.wbsNodes)
          .filter((n) => n.owner === query.ownerOpenId)
          .map((n) => n.projectId),
      );
      items = items.filter((p) => ownerProjectIds.has(p.id));
    }

    /* 3. 范围内「叶子任务」：真叶子判定要在项目全量节点上做（B17 保留全量叶子，含已完成） */
    const scopeIds = new Set(items.map((p) => p.id));
    const projectNameById = new Map(db.projects.map((p) => [p.id, p.name]));
    const userNameById = new Map(db.users.map((u) => [u.openId, u.name]));
    const allLeafTasks = leafNodesOf(db.wbsNodes.filter((n) => scopeIds.has(n.projectId)))
      .map((n) => ({ ...n, projectName: projectNameById.get(n.projectId) ?? '' })); // 全量叶子（含已完成）
    const tasks = allLeafTasks.filter((n) => n.status !== '完成'); // 在办（既有口径逐字不变）

    /* 4. 图表聚合（复用 B11/B14 纯函数 + B17 新纯函数，口径零漂移） */
    const health = aggregateHealth(items);
    const overdue = aggregateOverdue(tasks, items);
    const overdueTasks = tasks.filter((t) => !!t.dueDate && diffDays(today(), t.dueDate) < 0).length;
    const priorityDist = aggregatePriorityDistribution(tasks); // 在办叶子（复用 B14 纯函数）
    const statusDist = aggregateStatusDist(allLeafTasks); // 全量叶子（含已完成）
    const overdueDuration = aggregateOverdueDuration(tasks); // 在办叶子中已逾期者分段

    const statusCounter = new Map<string, number>();
    items.forEach((p) => statusCounter.set(p.status, (statusCounter.get(p.status) ?? 0) + 1));
    const segments: StatusDonutSegment[] = PROJECT_STATUSES.filter(
      (s) => (statusCounter.get(s) ?? 0) > 0,
    ).map((s) => ({ status: s, value: statusCounter.get(s) as number }));
    const statusDonut = {
      segments,
      total: segments.reduce((n, s) => n + s.value, 0),
    };

    /* 负责人负荷（决策 ③）：排序 逾期 ↓ → 在办 ↓ → 姓名 ↑，未分配恒最后。
       `projects` 跨项目明细供 P1-6 抽屉直接渲染（与服务端 aggregateOwnerLoad 同构） */
    interface OwnerLoadAcc {
      owner: string;
      ownerName: string;
      activeTasks: number;
      overdueTasks: number;
      projects: Map<string, OwnerLoadProjectRow>;
    }
    const loadMap = new Map<string, OwnerLoadAcc>();
    tasks.forEach((n) => {
      const owner = n.owner || '';
      let row = loadMap.get(owner);
      if (!row) {
        row = {
          owner,
          ownerName: owner
            ? n.ownerName || userNameById.get(owner) || owner
            : DASHBOARD_UNASSIGNED_LABEL,
          activeTasks: 0,
          overdueTasks: 0,
          projects: new Map<string, OwnerLoadProjectRow>(),
        };
        loadMap.set(owner, row);
      }
      const late = !!n.dueDate && diffDays(today(), n.dueDate) < 0;
      row.activeTasks += 1;
      if (late) row.overdueTasks += 1;
      if (n.projectId) {
        let pr = row.projects.get(n.projectId);
        if (!pr) {
          pr = {
            projectId: n.projectId,
            projectName: projectNameById.get(n.projectId) ?? DASHBOARD_UNNAMED_PROJECT,
            activeTasks: 0,
            overdueTasks: 0,
          };
          row.projects.set(n.projectId, pr);
        }
        pr.activeTasks += 1;
        if (late) pr.overdueTasks += 1;
      }
    });
    const ownerLoad: OwnerLoadRow[] = Array.from(loadMap.values())
      .map((r) => {
        const projects = Array.from(r.projects.values()).sort((a, b) => {
          if (a.overdueTasks !== b.overdueTasks) return b.overdueTasks - a.overdueTasks;
          if (a.activeTasks !== b.activeTasks) return b.activeTasks - a.activeTasks;
          return a.projectName.localeCompare(b.projectName, 'zh-CN');
        });
        return {
          owner: r.owner,
          ownerName: r.ownerName,
          activeTasks: r.activeTasks,
          overdueTasks: r.overdueTasks,
          projectCount: projects.length,
          projects,
        };
      })
      .sort((a, b) => {
        if (!a.owner !== !b.owner) return a.owner ? -1 : 1; // 未分配恒最后
        if (a.overdueTasks !== b.overdueTasks) return b.overdueTasks - a.overdueTasks;
        if (a.activeTasks !== b.activeTasks) return b.activeTasks - a.activeTasks;
        return a.ownerName.localeCompare(b.ownerName, 'zh-CN');
      });

    /* 5. 周报填报（口径与工作台提醒一致：仅「进行中」项目应填） */
    const curWeek = weekCode(today());
    const activeItems = items.filter((p) => p.status === '进行中');
    const reportMissing: ReportMissingRow[] = activeItems
      .filter((p) => !db.reports.some((r) => r.projectId === p.id && r.week === curWeek && r.status === '已提交'))
      .map((p) => ({ projectId: p.id, projectName: p.name, pmName: p.pmName }));
    const reportDue = activeItems.length;
    const reportFilled = reportDue - reportMissing.length;

    /* 5.5 D01.5：任务负责人选项池（基准 = itemsBase，不含 ownerOpenId；真叶子 owner 去重，姓名升序） */
    const ownerOptions: Array<{ openId: string; name: string }> = (() => {
      const baseIds = new Set(itemsBase.map((p) => p.id));
      const map = new Map<string, string>();
      leafNodesOf(db.wbsNodes)
        .filter((n) => baseIds.has(n.projectId) && !!n.owner)
        .forEach((n) => {
          if (!map.has(n.owner as string)) {
            map.set(n.owner as string, userNameById.get(n.owner as string) ?? '(已移除)');
          }
        });
      return Array.from(map.entries())
        .map(([openId, name]) => ({ openId, name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    })();

    /* 5.6 D01：上周工作进展（口径与服务端 computeWeeklyProgress 对齐：周报=上周周码、
       任务=真叶子且 updatedAt 落在上周区间、里程碑=doneAt 落在上周区间） */
    const lastWeek = weekCode(addDays(today(), -7));
    const lastStart = weekRange(lastWeek).start;
    const lastEnd = weekRange(lastWeek).end;
    const weeklyReports = db.reports
      .filter((r) => scopeIds.has(r.projectId) && r.week === lastWeek)
      .map((r) => ({
        id: r.id,
        projectId: r.projectId,
        projectName: projectNameById.get(r.projectId) ?? DASHBOARD_UNNAMED_PROJECT,
        authorName: r.authorName,
        status: r.status,
        submittedAt: r.submittedAt ?? '',
        updatedAt: r.updatedAt,
        summary: r.doneNote,
      }));
    const weeklyTasks = leafNodesOf(db.wbsNodes)
      .filter((n) => scopeIds.has(n.projectId))
      .filter((n) => {
        const d = n.updatedAt.slice(0, 10);
        return d >= lastStart && d <= lastEnd;
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map((n) => ({
        id: n.id,
        projectId: n.projectId,
        projectName: projectNameById.get(n.projectId) ?? DASHBOARD_UNNAMED_PROJECT,
        wbsCode: n.wbsCode,
        name: n.name,
        ownerName: n.ownerName || userNameById.get(n.owner ?? '') || '',
        status: n.status,
        progress: n.progress,
        updatedAt: n.updatedAt,
        done: n.status === '完成',
      }));
    const weeklyMilestones = db.milestones
      .filter(
        (m) => scopeIds.has(m.projectId) && !!m.doneAt && m.doneAt >= lastStart && m.doneAt <= lastEnd,
      )
      .map((m) => ({
        id: m.id,
        projectId: m.projectId,
        projectName: projectNameById.get(m.projectId) ?? DASHBOARD_UNNAMED_PROJECT,
        name: m.name,
        doneAt: m.doneAt as string,
      }))
      .sort((a, b) => (a.doneAt < b.doneAt ? 1 : a.doneAt > b.doneAt ? -1 : 0));
    const weeklyProgress = {
      week: lastWeek,
      reports: weeklyReports,
      tasks: weeklyTasks,
      milestones: weeklyMilestones,
    };

    /* 6. 明细表排序 + 分页（决策 ④） */
    const overdueByProject = new Map(overdue.map((r) => [r.projectId, r.overdue]));
    const sorted = items.slice().sort((a, b) => {
      if (sort === 'progress') {
        if (a.progress !== b.progress) return a.progress - b.progress;
      } else if (sort === 'overdue') {
        const oa = overdueByProject.get(a.id) ?? 0;
        const ob = overdueByProject.get(b.id) ?? 0;
        if (oa !== ob) return ob - oa;
      } else if (sort === 'nextMilestone') {
        const da = a.nextMilestoneDate ?? '';
        const dbv = b.nextMilestoneDate ?? '';
        if (!da !== !dbv) return da ? -1 : 1;
        if (da !== dbv) return da < dbv ? -1 : 1;
      } else {
        const ra = DASHBOARD_HEALTH_RANK[a.health] ?? 3;
        const rb = DASHBOARD_HEALTH_RANK[b.health] ?? 3;
        if (ra !== rb) return ra - rb;
        if (a.progress !== b.progress) return a.progress - b.progress;
      }
      return a.name.localeCompare(b.name, 'zh-CN');
    });

    const averageProgress = items.length
      ? Math.round(items.reduce((n, p) => n + (Number(p.progress) || 0), 0) / items.length)
      : 0;

    return deepClone({
      scope,
      generatedAt: nowIso(),
      stats: {
        managedProjects: items.length,
        redProjects: health.red,
        overdueTasks,
        /* 无应填项目时视为 100%（0 缺口），避免空数据把卡片染成告警色 */
        reportFillRate: reportDue ? Math.round((reportFilled / reportDue) * 100) : 100,
        reportFilled,
        reportDue,
        averageProgress,
      },
      statusDonut,
      health,
      priorityDist,
      statusDist,
      overdueDuration,
      overdue,
      ownerLoad,
      reportMissing,
      weeklyProgress,
      ownerOptions,
      projects: {
        items: sorted.slice((page - 1) * pageSize, page * pageSize),
        total: items.length,
        page,
        pageSize,
      },
    });
  }

  /**
   * B18：分布图点档下钻任务明细（对应 `GET /api/dashboard/tasks`）。
   * 与服务端 getDashboardTasks 逐字对齐：
   *  - 步骤 1-2（范围 + 项目过滤）与上方 getDashboardOverview 同口径（mock 手工双写惯例，逐字拷贝）；
   *  - 维度三选一互斥（taskStatus → overdueBucket → priority），优先级脏值兜底 P2；
   *  - taskStatus 命中基数 = 全量叶子（含已完成），否则 = 在办叶子；
   *  - 行 = WbsNode 字段 + projectName 映射；排序 优先级 → 截止日 → 名称；分页返回 { items, total, page, pageSize }。
   */
  async getDashboardTasks(query: DashboardTasksQuery): Promise<Paged<DashboardTaskRow>> {
    await delay(200);
    const db = getDb();
    const me = currentUser(db);

    /* 1. 范围解析（与服务端 resolveScope 同口径） */
    const canSeeAll = canDo(me.globalRole, 'dashboard:global');
    const scope: DashboardScope = canSeeAll ? (query.scope === 'mine' ? 'mine' : 'all') : 'mine';

    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(DASHBOARD_MAX_PAGE_SIZE, Math.max(1, Number(query.pageSize) || DASHBOARD_PAGE_SIZE));

    /* 2. 项目范围（决策 ⑥ 三态基线 + scope + 过滤，与 getDashboardOverview 步骤 1-2 逐字一致） */
    const statusFilter =
      query.status && DASHBOARD_MANAGED_STATUSES.includes(query.status) ? query.status : '';
    const myProjectIds = new Set(
      db.members.filter((m) => m.userOpenId === me.openId).map((m) => m.projectId),
    );
    const myPmProjectIds = new Set(
      db.members
        .filter((m) => m.userOpenId === me.openId && m.projectRole === 'pm')
        .map((m) => m.projectId),
    );
    let items = db.projects
      .filter((p) =>
        statusFilter ? p.status === statusFilter : DASHBOARD_MANAGED_STATUSES.includes(p.status),
      )
      .filter((p) => {
        if (scope === 'all') return true;
        return query.onlyMine ? myPmProjectIds.has(p.id) : myProjectIds.has(p.id);
      })
      .map((p) => toListItem(db, p));
    if (query.type) items = items.filter((r) => r.type === query.type);
    if (query.health) items = items.filter((r) => r.health === query.health);
    if (query.keyword) {
      const k = query.keyword.trim().toLowerCase();
      if (k) {
        items = items.filter(
          (r) =>
            r.name.toLowerCase().includes(k) ||
            r.code.toLowerCase().includes(k) ||
            r.customer.toLowerCase().includes(k),
        );
      }
    }

    /* 3. 维度解析（三选一互斥；priority 脏值兜底 P2 —— normalizePriority('')→P2 与服务端一致） */
    const dim: { kind: 'taskStatus' | 'overdueBucket' | 'priority' | 'none'; value: string } = {
      kind: 'none',
      value: '',
    };
    if (query.taskStatus && TASK_STATUSES.includes(query.taskStatus)) {
      dim.kind = 'taskStatus';
      dim.value = query.taskStatus;
    } else if (query.overdueBucket && (query.overdueBucket === '1to7' || query.overdueBucket === '8to30' || query.overdueBucket === 'over30')) {
      dim.kind = 'overdueBucket';
      dim.value = query.overdueBucket;
    } else if (query.priority !== undefined && query.priority !== null) {
      dim.kind = 'priority';
      dim.value = normalizePriority(query.priority);
    }

    /* 4. 叶子任务基数 + 维度过滤 + 行组装（projectName 映射补齐） */
    const scopeIds = new Set(items.map((p) => p.id));
    const projectNameById = new Map(db.projects.map((p) => [p.id, p.name]));
    const userNameById = new Map(db.users.map((u) => [u.openId, u.name]));
    const allLeafTasks = leafNodesOf(db.wbsNodes.filter((n) => scopeIds.has(n.projectId)));
    const base = dim.kind === 'taskStatus'
      ? allLeafTasks
      : allLeafTasks.filter((n) => n.status !== '完成');

    const rows: DashboardTaskRow[] = base
      .filter((n) => {
        if (dim.kind === 'taskStatus') return n.status === dim.value;
        if (dim.kind === 'priority') return normalizePriority(n.priority) === dim.value;
        if (dim.kind === 'overdueBucket') return overdueBucketOf(n.dueDate) === dim.value;
        return true;
      })
      .map((n) => ({
        id: n.id,
        projectId: n.projectId,
        projectName: projectNameById.get(n.projectId) ?? DASHBOARD_UNNAMED_PROJECT,
        wbsCode: n.wbsCode,
        name: n.name,
        priority: normalizePriority(n.priority),
        status: n.status,
        dueDate: n.dueDate,
        progress: Number(n.progress) || 0,
        ownerName: n.ownerName ?? userNameById.get(n.owner ?? '') ?? '',
      }))
      .sort((a, b) => {
        const RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
        const ra = RANK[a.priority] ?? 2;
        const rb = RANK[b.priority] ?? 2;
        if (ra !== rb) return ra - rb;
        const da = a.dueDate || '';
        const dbv = b.dueDate || '';
        if (!da !== !dbv) return da ? -1 : 1;
        if (da !== dbv) return da < dbv ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN');
      });

    /* 5. 分页返回（与服务端 envelope.paged 同构） */
    return deepClone({
      items: rows.slice((page - 1) * pageSize, page * pageSize),
      total: rows.length,
      page,
      pageSize,
    });
  }

  /* ── 管理后台 ─────────────────────────────────── */

  async listUsers(): Promise<User[]> {
    await delay(80);
    const db = getDb();
    currentUser(db);
    return deepClone(db.users);
  }

  async updateUserRole(openId: string, role: GlobalRole): Promise<User> {
    await delay();
    const db = getDb();
    const me = assertCan(db, 'user.manage');
    if (openId === me.openId) throw new ApiError(ErrorCode.E_SELF_ROLE);
    const u = db.users.find((x) => x.openId === openId) ?? nf();
    if (u.globalRole === 'admin' && role !== 'admin') {
      const admins = db.users.filter((x) => x.globalRole === 'admin').length;
      if (admins <= 1) throw new ApiError(ErrorCode.E_LAST_ADMIN);
    }
    const before = u.globalRole;
    u.globalRole = role;
    u.updatedAt = nowIso();
    audit(db, me, 'user', openId, 'update', '', `修改用户「${u.name}」全局角色`, [
      { field: 'globalRole', label: '全局角色', before, after: role },
    ]);
    saveDb();
    return deepClone(u);
  }

  async listTemplates(): Promise<LifecycleTemplate[]> {
    await delay(80);
    const db = getDb();
    currentUser(db);
    return deepClone(db.templates);
  }

  /** 演示数据一键复位 */
  async resetDemoData(): Promise<void> {
    await delay(150);
    const openId = getDb().sessionOpenId;
    const db = resetDb();
    db.sessionOpenId = openId;
    saveDb();
  }

  /* ── P1 占位 ──────────────────────────────────── */

  async listRisks(projectId: string): Promise<Risk[]> {
    await delay(80);
    const db = getDb();
    currentUser(db);
    return deepClone(db.risks.filter((r) => r.projectId === projectId));
  }

  async listDocuments(projectId: string, opts?: { nodeId?: string; milestoneId?: string }): Promise<ProjectDocument[]> {
    await delay(80);
    const db = getDb();
    currentUser(db);
    let list = db.documents.filter((d) => d.projectId === projectId);
    if (opts?.nodeId) list = list.filter((d) => d.nodeId === opts.nodeId);
    if (opts?.milestoneId) list = list.filter((d) => d.milestoneId === opts.milestoneId);
    return deepClone(list);
  }

  /* C01 任务附件：mock 仅在内存建记录，不落真实文件 */
  async uploadDocument(projectId: string, payload: UploadDocumentPayload): Promise<ProjectDocument> {
    await delay(200);
    const db = getDb();
    assertWritable(db, projectId);
    const me = assertCan(db, 'document.upload', projectId);

    const f = payload.file;
    const nodeId = payload.nodeId ?? '';
    const milestoneId = payload.milestoneId ?? '';
    if (nodeId) {
      const node = db.wbsNodes.find((n) => n.id === nodeId && n.projectId === projectId);
      if (!node) throw new ApiError(ErrorCode.E_VALIDATION, '关联任务不存在', undefined, 400);
    }
    if (milestoneId) {
      const ms = db.milestones.find((m) => m.id === milestoneId && m.projectId === projectId);
      if (!ms) throw new ApiError(ErrorCode.E_VALIDATION, '关联里程碑不存在', undefined, 400);
    }

    const now = nowIso();
    const id = genId('DOC');
    const doc: ProjectDocument = {
      id,
      projectId,
      nodeId,
      milestoneId,
      name: (f && f.name) || '未命名文件',
      fileName: (f && f.name) || 'file',
      fileSize: f && typeof f.size === 'number' ? f.size : 0,
      mimeType: (f && f.type) || 'application/octet-stream',
      storagePath: `${projectId}/__mock__${id}`,
      uploadedBy: me.openId,
      uploadedAt: now,
      createdAt: now,
    };
    db.documents.push(doc);
    saveDb();
    return deepClone(doc);
  }

  async deleteDocument(projectId: string, id: string): Promise<ProjectDocument> {
    await delay(150);
    const db = getDb();
    assertWritable(db, projectId);
    assertCan(db, 'document.delete', projectId);
    const idx = db.documents.findIndex((d) => d.id === id && d.projectId === projectId);
    if (idx < 0) throw new ApiError(ErrorCode.E_NOT_FOUND, '附件不存在', undefined, 404);
    const [doc] = db.documents.splice(idx, 1);
    saveDb();
    return deepClone(doc);
  }

  /** mock 合成占位文件（演示用，无真实文件内容） */
  async downloadDocument(projectId: string, id: string, opts?: { asDownload?: boolean }): Promise<Blob> {
    void opts;
    await delay(120);
    const db = getDb();
    currentUser(db);
    const doc = db.documents.find((d) => d.id === id && d.projectId === projectId);
    if (!doc) throw new ApiError(ErrorCode.E_NOT_FOUND, '附件不存在', undefined, 404);
    const text = `[演示附件] ${doc.name}\n类型：${doc.mimeType}\n大小：${doc.fileSize} 字节\n上传人：${doc.uploadedBy}\n（Mock 模式无真实文件内容）`;
    return new Blob([text], { type: 'text/plain;charset=utf-8' });
  }
}

/** 重命名子树 WBS 编码 */
function renameSubtree(db: MockDb, node: WbsNode, newCode: string): void {
  const oldCode = node.wbsCode;
  node.wbsCode = newCode;
  node.level = newCode.split('.').length;
  const children = db.wbsNodes
    .filter((n) => n.parentId === node.id)
    .sort((a, b) => compareWbsCode(a.wbsCode, b.wbsCode));
  children.forEach((c, i) => renameSubtree(db, c, `${newCode}.${i + 1}`));
  void oldCode;
}

export const mockClient = new MockApiClient();
