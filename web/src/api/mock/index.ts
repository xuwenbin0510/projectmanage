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
  StageWithGate,
  Milestone,
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
  MilestoneUpdatePayload,
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
} from './rules';
import {
  PROJECT_TRANSITIONS,
  REVIEW_TEMPLATES,
  DEFAULT_WIP_LIMIT,
  AUDIT_ACTION_LABEL,
} from '@/config/enums';
import { canDo } from '@/config/permissions';
import { addDays, today, nowIso, diffDays, weekCode, weekRange } from '@/utils/date';
import { genId, deepClone } from '@/utils/format';
import { compareWbsCode, nextChildCode } from '@/utils/wbs';

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

/** 项目列表行聚合 */
function toListItem(db: MockDb, p: Project): ProjectListItem {
  const pm = db.members.find((m) => m.projectId === p.id && m.projectRole === 'pm');
  const stage = db.stages.find((s) => s.id === p.currentStageId);
  const gate = stage ? db.gates.find((g) => g.stageId === stage.id) : undefined;
  const ms = db.milestones.filter((m) => m.projectId === p.id);
  const nodes = db.wbsNodes.filter((n) => n.projectId === p.id);
  const next = ms
    .filter((m) => !m.done)
    .sort((a, b) => (a.currentDate < b.currentDate ? -1 : 1))[0];
  const risks = db.risks.filter((r) => r.projectId === p.id && r.riskValue >= 12);

  return {
    ...p,
    pmName: pm?.userName ?? '—',
    currentStageName: stage?.name ?? (p.status === '已结项' ? '已归档' : '未启动'),
    currentGateCode: gate?.code ?? '',
    currentGateStatus: gate?.status ?? '未开始',
    progress: p.status === '已结项' ? 100 : rollupProjectProgress(nodes),
    milestoneDone: ms.filter((m) => m.done).length,
    milestoneTotal: ms.length,
    nextMilestoneDate: next?.currentDate ?? null,
    highRiskCount: risks.length,
  };
}

/** 阶段 + 门 + 门检查项 聚合 */
function stagesWithGate(db: MockDb, projectId: string): StageWithGate[] {
  return db.stages
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => a.seq - b.seq)
    .map((s) => {
      const gate = db.gates.find((g) => g.stageId === s.id) ?? null;
      const gateItems = gate
        ? db.gateItems.filter((i) => i.gateId === gate.id).sort((a, b) => a.seq - b.seq)
        : [];
      return { ...s, gate, gateItems };
    });
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
      advanceStage(db, gate.projectId, gate.stageId, actor);
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

/** 门通过后推进阶段 */
function advanceStage(db: MockDb, projectId: string, stageId: string, actor: User): void {
  const stages = db.stages.filter((s) => s.projectId === projectId).sort((a, b) => a.seq - b.seq);
  const idx = stages.findIndex((s) => s.id === stageId);
  if (idx === -1) return;
  const cur = stages[idx];
  cur.status = '已完成';
  cur.finishedAt = today();
  const next = stages[idx + 1];
  const project = db.projects.find((p) => p.id === projectId);
  if (next) {
    next.status = '进行中';
    next.startedAt = today();
    const nextGate = db.gates.find((g) => g.stageId === next.id);
    if (nextGate && nextGate.status === '未开始') nextGate.status = '待检查';
    if (project) project.currentStageId = next.id;
    audit(db, actor, 'stage', next.id, 'status_change', projectId, `阶段推进至「${next.name}」`, [
      { field: 'stage', label: '当前阶段', before: cur.name, after: next.name },
    ]);
  } else if (project) {
    project.currentStageId = cur.id;
    audit(db, actor, 'stage', cur.id, 'status_change', projectId, '最后一个阶段已完成，可发起结项');
  }
  if (project) {
    project.health = computeHealth(
      db.milestones.filter((m) => m.projectId === projectId),
      db.gates.filter((g) => g.projectId === projectId),
    );
  }
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
  const tasks = db.wbsNodes.filter((n) => n.projectId === projectId && n.nodeType === 'task');
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

  /** @prd P0-02 新建项目（按模板实例化阶段 / 门 / 里程碑） */
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
      currentStageId: null,
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

    tpl.definition.stages.forEach((sd, idx) => {
      const stageId = `${id}-${sd.code}`;
      db.stages.push({
        id: stageId,
        projectId: id,
        seq: idx + 1,
        code: sd.code,
        name: sd.name,
        status: idx === 0 ? '进行中' : '未开始',
        startedAt: idx === 0 ? today() : null,
        finishedAt: null,
      });
      if (idx === 0) project.currentStageId = stageId;

      const gateId = `${id}-${sd.gate.code}`;
      db.gates.push({
        id: gateId,
        projectId: id,
        stageId,
        code: sd.gate.code,
        name: sd.gate.name,
        ownerRole: sd.gate.ownerRole,
        status: idx === 0 ? '待检查' : '未开始',
        conclusion: '',
        comment: '',
        decidedBy: null,
        decidedAt: null,
        createdAt: ts,
      });
      sd.gate.items.forEach((it, i) => {
        db.gateItems.push({
          id: `${gateId}-I${i + 1}`,
          gateId,
          seq: i + 1,
          content: it.content,
          ownerRole: it.ownerRole,
          checked: false,
          checkedBy: null,
          checkedAt: null,
          source: 'template',
        });
      });
    });

    /* ── 里程碑：用户覆盖优先，否则回退模板 ─────────────────
     * payload.milestones 三态：undefined = 按模板 / [] = 显式清空 / 非空 = 完全覆盖
     */
    const pushMs = (seq: number, code: string, name: string, target: string, date: string): void => {
      db.milestones.push({
        // 用索引拼 id，不用 code —— 用户可能造出重复 code
        id: `${id}-MS${seq}`,
        projectId: id,
        code,
        name,
        target,
        baselineDate: date, // 创建即基线
        currentDate: date,
        delayDays: 0,
        status: '未开始',
        done: false,
        doneAt: null,
        lastChangeId: null,
        createdAt: ts,
        updatedAt: ts,
      });
    };

    const drafts = payload.milestones;

    if (drafts === undefined) {
      // 分支 1：兼容既有调用（测试 / 种子数据）→ 按模板实例化
      tpl.definition.milestones.forEach((md, i) =>
        pushMs(i + 1, md.code, md.name, '', addDays(payload.planStart, md.offsetDays)),
      );
    } else {
      // 分支 2：用户覆盖（[] 天然什么都不生成 —— 即「显式清空」）；脏数据兜底修补，不抛错
      drafts.forEach((d, i) => {
        const code = (d.code || `M${i + 1}`).trim();
        const name = (d.name || `里程碑 ${i + 1}`).trim();
        const date = d.date || payload.planStart;
        pushMs(i + 1, code, name, (d.target ?? '').trim(), date);
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

    const createDiff: AuditDiffEntry[] = [
      { field: 'type', label: '项目分类', before: '', after: `${payload.type} 类` },
    ];
    if (drafts !== undefined) {
      createDiff.push({
        field: 'milestones',
        label: '里程碑',
        before: '模板默认',
        after: drafts.length ? `自定义 ${drafts.length} 条` : '清空（0 条）',
      });
    }
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

  /* ── 阶段 / 质量门 ─────────────────────────────── */

  async listStages(projectId: string): Promise<StageWithGate[]> {
    await delay(80);
    const db = getDb();
    currentUser(db);
    return deepClone(stagesWithGate(db, projectId));
  }

  /** @prd P0-03 勾选门检查项 */
  async toggleGateItem(itemId: string, checked: boolean): Promise<StageWithGate[]> {
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
    return deepClone(stagesWithGate(db, gate.projectId));
  }

  /** @prd P0-03 提交门控结论（检查项未齐备直接拒绝） */
  async decideGate(projectId: string, payload: GateDecisionPayload): Promise<StageWithGate[]> {
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

    if (payload.conclusion === '已通过' || payload.conclusion === '有条件通过') {
      advanceStage(db, projectId, gate.stageId, me);
    }
    saveDb();
    return deepClone(stagesWithGate(db, projectId));
  }

  /* ── 里程碑 ───────────────────────────────────── */

  async listMilestones(projectId: string): Promise<Milestone[]> {
    await delay(80);
    const db = getDb();
    currentUser(db);
    return deepClone(
      db.milestones.filter((m) => m.projectId === projectId).sort((a, b) => (a.currentDate < b.currentDate ? -1 : 1)),
    );
  }

  /** @prd P0-05 里程碑单向规则：延后必须走变更单 */
  async updateMilestone(id: string, payload: MilestoneUpdatePayload): Promise<Milestone> {
    await delay();
    const db = getDb();
    const ms = db.milestones.find((m) => m.id === id) ?? nf();
    assertWritable(db, ms.projectId);
    const me = assertCan(db, 'milestone.edit', ms.projectId);

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
      audit(db, me, 'milestone', id, 'update', ms.projectId, `里程碑 ${ms.code} 日期提前`, [
        { field: 'currentDate', label: '当前日期', before, after: ms.currentDate },
      ]);
    }

    if (payload.name && payload.name !== ms.name) {
      ms.name = payload.name;
    }

    // 目标 / 达成标准：纯文本字段，直接赋值 + 审计，不触发单向日期约束
    if (payload.target !== undefined && payload.target !== ms.target) {
      const before = ms.target;
      ms.target = payload.target;
      audit(db, me, 'milestone', id, 'update', ms.projectId, `里程碑 ${ms.code} 目标调整`, [
        { field: 'target', label: '目标 / 达成标准', before, after: ms.target },
      ]);
    }

    if (payload.done !== undefined && payload.done !== ms.done) {
      ms.done = payload.done;
      ms.doneAt = payload.done ? today() : null;
      ms.status = payload.done ? '已达成' : diffDays(today(), ms.currentDate) < 0 ? '已逾期' : '进行中';
      audit(db, me, 'milestone', id, 'status_change', ms.projectId, `里程碑 ${ms.code} ${payload.done ? '标记达成' : '取消达成'}`, [
        { field: 'done', label: '达成状态', before: String(!payload.done), after: String(payload.done) },
      ]);
    }

    ms.updatedAt = nowIso();
    const p = db.projects.find((x) => x.id === ms.projectId);
    if (p) {
      p.health = computeHealth(
        db.milestones.filter((m) => m.projectId === p.id),
        db.gates.filter((g) => g.projectId === p.id),
      );
    }
    saveDb();
    return deepClone(ms);
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

  /** @prd P0-06 新建 WBS 节点（自动编码） */
  async createWbsNode(projectId: string, payload: WbsNodePayload): Promise<WbsNode> {
    await delay();
    const db = getDb();
    assertWritable(db, projectId);
    const me = assertCan(db, 'wbs.edit', projectId);

    if (payload.nodeType === 'task' && (!payload.owner || !payload.estimateDays)) {
      throw new ApiError(ErrorCode.E_WBS_LEAF_INCOMPLETE);
    }

    const siblings = db.wbsNodes.filter((n) => n.projectId === projectId && n.parentId === payload.parentId);
    const parent = payload.parentId ? db.wbsNodes.find((n) => n.id === payload.parentId) : null;
    const wbsCode = nextChildCode(parent?.wbsCode ?? null, siblings.map((s) => s.wbsCode));
    const owner = payload.owner ?? '';
    const u = db.users.find((x) => x.openId === owner);
    const ts = nowIso();

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
      dueDate: payload.dueDate ?? addDays(today(), 7),
      status: payload.status ?? '待办',
      progress: payload.progress ?? 0,
      boardOrder: db.wbsNodes.filter((n) => n.projectId === projectId).length,
      isCritical: false,
      milestoneId: null,
      createdBy: me.openId,
      createdAt: ts,
      updatedAt: ts,
    };
    db.wbsNodes.push(node);
    audit(db, me, 'wbs_node', node.id, 'create', projectId, `新增 WBS 节点「${wbsCode} ${payload.name}」`);
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
    if (payload.dueDate !== undefined) node.dueDate = payload.dueDate;
    if (payload.status !== undefined && payload.status !== node.status) {
      diff.push({ field: 'status', label: '状态', before: node.status, after: payload.status });
      node.status = payload.status;
    }
    if (payload.progress !== undefined) {
      node.progress = Math.max(0, Math.min(100, payload.progress));
      node.actualDays = Number(((node.estimateDays * node.progress) / 100).toFixed(1));
    }
    if (node.nodeType === 'task' && (!node.owner || !node.estimateDays)) {
      throw new ApiError(ErrorCode.E_WBS_LEAF_INCOMPLETE);
    }
    node.updatedAt = nowIso();
    audit(db, me, 'wbs_node', id, 'update', node.projectId, `修改节点「${node.wbsCode} ${node.name}」`, diff);
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
    saveDb();
  }

  /** @prd P0-06 拖拽移动节点（防循环引用 + 重排编码） */
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

    node.parentId = newParentId;
    const parent = newParentId ? db.wbsNodes.find((n) => n.id === newParentId) : null;
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

    let report = db.reports.find((r) => r.projectId === payload.projectId && r.week === payload.week);
    const isNew = !report;
    if (!report) {
      report = {
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
    } else if (report.status === '已提交' && status === '已提交') {
      throw new ApiError(ErrorCode.E_REPORT_DUPLICATE);
    }

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
        ms.status = ms.done ? '已达成' : diffDays(today(), toDate) < 0 ? '已逾期' : '进行中';
        ms.lastChangeId = change.id;
        ms.updatedAt = nowIso();
        audit(db, me, 'milestone', ms.id, 'apply', change.projectId, `变更实施：${ms.code} 当前日期调整（基线日期保持不变）`, [
          { field: 'currentDate', label: '当前日期', before, after: toDate },
          { field: 'delayDays', label: '累计延期', after: `${ms.delayDays} 天`, before: '' },
        ]);
      }
    }

    change.status = '已实施';
    change.appliedAt = nowIso();
    const p = db.projects.find((x) => x.id === change.projectId);
    if (p) {
      p.health = computeHealth(
        db.milestones.filter((m) => m.projectId === p.id),
        db.gates.filter((g) => g.projectId === p.id),
      );
    }
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

    const myTasks = db.wbsNodes
      .filter((n) => n.owner === me.openId && n.nodeType === 'task' && n.status !== '完成')
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
