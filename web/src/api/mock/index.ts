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
import type { Review, ReviewStep, Approval } from '@/types/review';
import type { Change, RouteResult } from '@/types/change';
import type { AuditLog, AuditDiffEntry, Risk, ProjectDocument } from '@/types/audit';
import type { WorkbenchData, ReportReminder, Session } from '@/types/workbench';
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
} from './rules';
import {
  PROJECT_TRANSITIONS,
  REVIEW_TEMPLATES,
  DEFAULT_WIP_LIMIT,
  AUDIT_ACTION_LABEL,
  GATE_PASSED_STATUSES,
} from '@/config/enums';
import { canDo } from '@/config/permissions';
import { addDays, today, nowIso, diffDays, weekCode, weekRange, fitMilestoneDates } from '@/utils/date';
import { genId, deepClone } from '@/utils/format';
import {
  compareWbsCode,
  nextChildCode,
  leafNodesOf,
  isLeafNode,
  milestoneTaskStats,
} from '@/utils/wbs';

/* ═══════════════════════════════════════════════════
 * 内存 Mock 引擎：实现 ApiClient 全部方法
 * 与真实 HTTP 实现签名一致，页面零改动切换
 * ═══════════════════════════════════════════════════ */

const MOCK_TOKEN_PREFIX = 'mock-token-';
const ROLE_FALLBACK_ORDER: GlobalRole[] = ['pmo', 'management', 'tl', 'qa', 'cm', 'po', 'pm'];

function nf(): never {
  throw new ApiError(ErrorCode.E_NOT_FOUND);
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
            startDate: '',
            dueDate: ms.currentDate,
            status: '待办',
            progress: 0,
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
      db.wbsNodes.filter((n) => n.projectId === projectId).sort((a, b) => compareWbsCode(a.wbsCode, b.wbsCode)),
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
      id: genId('W'),
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
      startDate: payload.startDate ?? today(),
      dueDate: effectiveDue,
      status: payload.status ?? '待办',
      progress: payload.progress ?? 0,
      boardOrder: db.wbsNodes.filter((n) => n.projectId === projectId).length,
      isCritical: false,
      milestoneId,
      createdBy: me.openId,
      createdAt: ts,
      updatedAt: ts,
    };
    db.wbsNodes.push(node);
    audit(db, me, 'wbs_node', node.id, 'create', projectId, `新增 WBS 节点「${wbsCode} ${payload.name}」`);
    /* 新叶子会改变里程碑完成度 → 触发状态重推 */
    refreshMilestoneStatuses(db, projectId);
    saveDb();
    return deepClone(node);
  }

  async updateWbsNode(id: string, payload: Partial<WbsNodePayload>): Promise<WbsNode> {
    await delay();
    const db = getDb();
    const node = db.wbsNodes.find((n) => n.id === id) ?? nf();
    assertWritable(db, node.projectId);
    const me = assertCan(db, 'wbs.edit', node.projectId);

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
    /* 进度 / 挂载关系变化会影响里程碑完成度 → 触发状态重推 */
    refreshMilestoneStatuses(db, node.projectId);
    saveDb();
    return deepClone(node);
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
    audit(db, me, 'wbs_node', id, 'delete', node.projectId, `删除节点「${node.wbsCode} ${node.name}」及其 ${toDelete.size - 1} 个子节点`);
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
    saveDb();
    return deepClone(
      db.wbsNodes.filter((n) => n.projectId === node.projectId).sort((a, b) => compareWbsCode(a.wbsCode, b.wbsCode)),
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
          if (node.progress >= 100) node.status = '完成';
          node.updatedAt = ts;
        }
        snapshot[t.nodeId] = t.progressAfter;
      });
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

  /* ── 评审 ─────────────────────────────────────── */

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
    const myTasks = leafNodesOf(db.wbsNodes)
      .filter((n) => n.owner === me.openId && n.status !== '完成')
      .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));

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

  async listDocuments(projectId: string): Promise<ProjectDocument[]> {
    await delay(80);
    const db = getDb();
    currentUser(db);
    return deepClone(db.documents.filter((d) => d.projectId === projectId));
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
