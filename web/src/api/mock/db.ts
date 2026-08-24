import type {
  User,
  Project,
  ProjectMember,
  LifecycleTemplate,
  QualityGate,
  GateChecklistItem,
  Milestone,
} from '@/types/project';
import type { WbsNode, BoardConfig } from '@/types/wbs';
import type { Report } from '@/types/report';
import type { Review } from '@/types/review';
import type { Change } from '@/types/change';
import type { AuditLog, Risk, ProjectDocument } from '@/types/audit';
import { createSeedDb } from './fixtures';
import type { ReviewTemplateConfig, Role } from '@/types/project';
import { PERMISSIONS } from '@/config/permissions';

/** B19 阶段二：权限矩阵 mock 数据载体（与后端 permission_rules / permission_actions 同构） */
export interface PermissionRuleMock {
  action: string;
  roleKey: string;
  granted: boolean;
}

export interface PermissionActionMock {
  action: string;
  label: string;
  group_key: string;
  group_label: string;
  description: string;
  order_no: number;
  enabled: boolean;
  builtin: boolean;
}

/** D03：全量任务快照（mock 内存版，周报提交时采集，UNIQUE 语义由 mock 逻辑保证） */
export interface ProgressSnapshotMock {
  id: string;
  projectId: string;
  objectId: string;
  week: string;
  progress: number;
  status: string;
}

/**
 * 审批流程模板默认 seed（阶段二：审批流程可配置）。
 * 与服务端 migrationV14 的 10 条内置 seed 逐条对齐：
 *  - scope='project'：project:A/B/C/_default（立项审批链，key = project:<type>）
 *  - scope='business'：formal/technical/code/ccb/pm_only/project（业务评审）
 */
export const DEFAULT_REVIEW_TEMPLATES: ReviewTemplateConfig[] = [
  { key: 'project:A', scope: 'project', label: 'A 类项目立项审批', mode: 'serial', chain: ['pmo', 'tl', 'management'], description: 'A 类项目立项审批串行链：PMO → TL → 管理层', active: true, createdAt: '', updatedAt: '' },
  { key: 'project:B', scope: 'project', label: 'B 类项目立项审批', mode: 'serial', chain: ['pm', 'tl'], description: 'B 类项目立项审批串行链：PM → TL', active: true, createdAt: '', updatedAt: '' },
  { key: 'project:C', scope: 'project', label: 'C 类项目立项审批', mode: 'serial', chain: ['pmo', 'tl', 'management'], description: 'C 类项目立项审批串行链：PMO → TL → 管理层', active: true, createdAt: '', updatedAt: '' },
  { key: 'project:_default', scope: 'project', label: '立项审批（默认）', mode: 'serial', chain: ['pm', 'tl'], description: '未匹配到具体项目类型时的立项审批兜底链', active: true, createdAt: '', updatedAt: '' },
  { key: 'formal', scope: 'business', label: '正式评审', mode: 'parallel_veto', chain: ['pmo', 'tl', 'management', 'customer_rep'], description: '立项/需求/设计/验收 → 管理层 + PMO + TL + 客户代表，一票否决', active: true, createdAt: '', updatedAt: '' },
  { key: 'technical', scope: 'business', label: '技术评审', mode: 'single', chain: ['tl'], description: '由技术负责人（TL）单人决议并留痕', active: true, createdAt: '', updatedAt: '' },
  { key: 'code', scope: 'business', label: '代码评审', mode: 'single', chain: ['tl'], description: '≥1 人 Approve 即可通过', active: true, createdAt: '', updatedAt: '' },
  { key: 'ccb', scope: 'business', label: 'CCB 变更评审', mode: 'serial', chain: ['pm', 'tl', 'po', 'customer_rep'], description: '基线变更 → PM → TL → PO → 客户代表 串行逐级', active: true, createdAt: '', updatedAt: '' },
  { key: 'pm_only', scope: 'business', label: 'PM 审批', mode: 'single', chain: ['pm'], description: '非基线小变更 → PM 单人决议并留痕', active: true, createdAt: '', updatedAt: '' },
  { key: 'project', scope: 'business', label: '立项审批', mode: 'serial', chain: ['pmo', 'management'], description: '立项审批串行链：PMO → 管理层', active: true, createdAt: '', updatedAt: '' },
];

/**
 * E1.5：默认职位目录 seed（与服务端 migrationV15 的默认职位逐条对齐）。
 * role_key / name / scope / order_no 一致，保证 mock 与真实后端行为同构。
 */
export const DEFAULT_ROLES: Role[] = [
  { roleKey: 'admin', name: '系统管理员', scope: 'global', enabled: true, description: '拥有全部权限，系统至少保留一名', orderNo: 1 },
  { roleKey: 'management', name: '公司管理层', scope: 'global', enabled: true, description: '公司层面决策与跨项目审批', orderNo: 2 },
  { roleKey: 'pmo', name: 'PMO', scope: 'global', enabled: true, description: '项目管理办公室，全局项目治理与审批', orderNo: 3 },
  { roleKey: 'pm', name: '项目经理', scope: 'global', enabled: true, description: '可指派为全局或项目内项目经理', orderNo: 4 },
  { roleKey: 'tl', name: '技术负责人', scope: 'global', enabled: true, description: '可指派为全局或项目内技术负责人', orderNo: 5 },
  { roleKey: 'qa', name: '质量负责人', scope: 'global', enabled: true, description: '可指派为全局或项目内质量负责人', orderNo: 6 },
  { roleKey: 'cm', name: '配置管理员', scope: 'global', enabled: true, description: '可指派为全局或项目内配置管理', orderNo: 7 },
  { roleKey: 'po', name: '产品经理', scope: 'global', enabled: true, description: '可指派为全局或项目内产品经理', orderNo: 8 },
  { roleKey: 'member', name: '普通成员', scope: 'global', enabled: true, description: '默认成员，仅项目内参与者视野', orderNo: 9 },
];

/**
 * 内存 Mock 数据库（S1 静态原型唯一数据源）
 * @prd 全局
 * - 支持读写，写入后持久化到 sessionStorage，刷新不丢
 * - `resetDb()` 可恢复演示初始态
 */
export interface MockDb {
  users: User[];
  projects: Project[];
  members: ProjectMember[];
  templates: LifecycleTemplate[];
  gates: QualityGate[];
  gateItems: GateChecklistItem[];
  milestones: Milestone[];
  wbsNodes: WbsNode[];
  boardConfigs: BoardConfig[];
  reports: Report[];
  reviews: Review[];
  changes: Change[];
  auditLogs: AuditLog[];
  risks: Risk[];
  documents: ProjectDocument[];
  /** 阶段二：审批流程模板（管理后台可配置） */
  reviewTemplates: ReviewTemplateConfig[];
  /** E1.5：职位目录（管理后台可配置，默认 seed 与后端一致） */
  roles: Role[];
  /** D03：全量任务快照（周报提交时采集，供任务进度环比） */
  progressSnapshots: ProgressSnapshotMock[];
  /** 当前登录用户 openId（devlogin 写入） */
  sessionOpenId: string | null;
  /** B19 阶段二：权限矩阵规则（action → roleKey → granted） */
  permissionRules: PermissionRuleMock[];
  /** B19 阶段二：权限动作元数据 */
  permissionActions: PermissionActionMock[];
}

/**
 * B19 阶段二：权限动作默认元数据（与后端 migrationV18 的 ACTION_META 同源）。
 * 分组 label 与前端 PERM_GROUPS（AdminPermissionsPage）保持一致，便于矩阵页渲染。
 */
export const DEFAULT_PERMISSION_ACTIONS: PermissionActionMock[] = [
  { action: 'project:create', label: '新建项目', group_key: 'project', group_label: '项目', description: '创建新项目', order_no: 10, enabled: true, builtin: true },
  { action: 'project:edit', label: '编辑项目', group_key: 'project', group_label: '项目', description: '编辑项目基本信息', order_no: 11, enabled: true, builtin: true },
  { action: 'project:delete', label: '删除项目', group_key: 'project', group_label: '项目', description: '删除项目', order_no: 12, enabled: true, builtin: true },
  { action: 'project:transition', label: '项目状态流转', group_key: 'project', group_label: '项目', description: '推进/回退项目阶段', order_no: 13, enabled: true, builtin: true },
  { action: 'project:close', label: '项目结项', group_key: 'project', group_label: '项目', description: '结项项目', order_no: 14, enabled: true, builtin: true },
  { action: 'project:member:assign', label: '项目成员分配', group_key: 'project', group_label: '项目', description: '分配项目成员', order_no: 15, enabled: true, builtin: true },
  { action: 'gate:decide', label: '质量门决议', group_key: 'gate', group_label: '质量门 / 里程碑', description: '决议质量门通过/不通过', order_no: 20, enabled: true, builtin: true },
  { action: 'gate:item:check', label: '门检查项检查', group_key: 'gate', group_label: '质量门 / 里程碑', description: '勾选门检查项', order_no: 21, enabled: true, builtin: true },
  { action: 'gate:item:add', label: '门检查项新增', group_key: 'gate', group_label: '质量门 / 里程碑', description: '新增门检查项', order_no: 22, enabled: true, builtin: true },
  { action: 'milestone:create', label: '里程碑新建', group_key: 'milestone', group_label: '质量门 / 里程碑', description: '新建里程碑', order_no: 23, enabled: true, builtin: true },
  { action: 'milestone:edit', label: '里程碑编辑', group_key: 'milestone', group_label: '质量门 / 里程碑', description: '编辑里程碑', order_no: 24, enabled: true, builtin: true },
  { action: 'milestone:delete', label: '里程碑删除', group_key: 'milestone', group_label: '质量门 / 里程碑', description: '删除里程碑', order_no: 25, enabled: true, builtin: true },
  { action: 'wbs:edit', label: 'WBS 编辑', group_key: 'wbs', group_label: 'WBS / 看板 / 任务', description: '编辑 WBS 节点', order_no: 30, enabled: true, builtin: true },
  { action: 'wbs:delete', label: 'WBS 删除', group_key: 'wbs', group_label: 'WBS / 看板 / 任务', description: '删除 WBS 节点', order_no: 31, enabled: true, builtin: true },
  { action: 'task:status', label: '任务状态更新', group_key: 'task', group_label: 'WBS / 看板 / 任务', description: '更新任务状态', order_no: 32, enabled: true, builtin: true },
  { action: 'board:config', label: '看板配置', group_key: 'board', group_label: 'WBS / 看板 / 任务', description: '配置看板列与 WIP', order_no: 33, enabled: true, builtin: true },
  { action: 'report:write', label: '周报填写', group_key: 'report', group_label: '周报 / 评审 / 变更', description: '填写/提交周报', order_no: 40, enabled: true, builtin: true },
  { action: 'review:start', label: '发起评审', group_key: 'review', group_label: '周报 / 评审 / 变更', description: '发起评审', order_no: 41, enabled: true, builtin: true },
  { action: 'review:decide', label: '评审决议', group_key: 'review', group_label: '周报 / 评审 / 变更', description: '决议评审', order_no: 42, enabled: true, builtin: true },
  { action: 'review:proxy', label: '评审代理', group_key: 'review', group_label: '周报 / 评审 / 变更', description: '代理评审', order_no: 43, enabled: true, builtin: true },
  { action: 'change:create', label: '变更创建', group_key: 'change', group_label: '周报 / 评审 / 变更', description: '创建变更单', order_no: 44, enabled: true, builtin: true },
  { action: 'change:submit', label: '变更提交', group_key: 'change', group_label: '周报 / 评审 / 变更', description: '提交变更单', order_no: 45, enabled: true, builtin: true },
  { action: 'dashboard:global', label: '全局仪表盘', group_key: 'global', group_label: '全局 / 管理', description: '查看公司全量仪表盘', order_no: 50, enabled: true, builtin: true },
  { action: 'admin:user:role', label: '用户角色管理', group_key: 'admin', group_label: '全局 / 管理', description: '管理用户与职位', order_no: 51, enabled: true, builtin: true },
  { action: 'admin:audit:view', label: '审计查看', group_key: 'admin', group_label: '全局 / 管理', description: '查看审计日志', order_no: 52, enabled: true, builtin: true },
  { action: 'admin:template', label: '生命周期模板管理', group_key: 'admin', group_label: '全局 / 管理', description: '管理生命周期模板', order_no: 53, enabled: true, builtin: true },
  { action: 'document:upload', label: '文档上传', group_key: 'document', group_label: '全局 / 管理', description: '上传项目文档', order_no: 54, enabled: true, builtin: true },
  { action: 'document:delete', label: '文档删除', group_key: 'document', group_label: '全局 / 管理', description: '删除项目文档', order_no: 55, enabled: true, builtin: true },
];

/** B19 阶段二：默认权限规则（从前端 PERMISSIONS 常量种入，与后端 DEFAULT_PERMISSIONS 同源） */
export function defaultPermissionRules(): PermissionRuleMock[] {
  const rules: PermissionRuleMock[] = [];
  Object.keys(PERMISSIONS).forEach(function (action) {
    const rule = PERMISSIONS[action];
    (rule.roles || []).forEach(function (roleKey: string) {
      rules.push({ action, roleKey, granted: true });
    });
  });
  return rules;
}

// v4：方案一（极简）彻底删除「阶段」实体 ——
//   · 删除 MockDb.stages / ProjectStage / Project.currentStageId
//   · Milestone 删除 stageId / anchor，新增 required / doneAt / doneBy / statusOverride 等派生字段
//   · WbsNode 删除 lifecycleStageId，nodeType 收敛为 task / subtask
//   · QualityGate.stageId 外键改为 milestoneId
// 旧缓存（v3 及更早）缺上述字段会导致运行时 undefined，故升版强制丢弃重建（SK-9）
const STORAGE_KEY = 'pm_mock_db_v4';

let instance: MockDb | null = null;

function load(): MockDb | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MockDb;
    if (!parsed || !Array.isArray(parsed.projects)) return null;
    /* 阶段二：旧缓存（v4）无 reviewTemplates → 兜底注入默认审批模板，避免运行时 undefined */
    if (!Array.isArray(parsed.reviewTemplates)) {
      parsed.reviewTemplates = DEFAULT_REVIEW_TEMPLATES.map((t) => ({ ...t }));
    }
    /* E1.5：旧缓存无 roles → 兜底注入默认职位目录 */
    if (!Array.isArray(parsed.roles)) {
      parsed.roles = DEFAULT_ROLES.map((r) => ({ ...r }));
    }
    /* B19：旧缓存无权限矩阵 → 兜底注入默认规则 + 动作元数据 */
    if (!Array.isArray(parsed.permissionRules)) {
      parsed.permissionRules = defaultPermissionRules();
    }
    if (!Array.isArray(parsed.permissionActions)) {
      parsed.permissionActions = DEFAULT_PERMISSION_ACTIONS.map((a) => ({ ...a }));
    }
    return parsed;
  } catch {
    return null;
  }
}

function persist(db: MockDb): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    /* 配额溢出时静默忽略，内存态仍然有效 */
  }
}

/** 取（惰性初始化）Mock 数据库 */
export function getDb(): MockDb {
  if (instance) return instance;
  instance = load() ?? createSeedDb();
  return instance;
}

/** 写入后调用，落 sessionStorage */
export function saveDb(): void {
  if (instance) persist(instance);
}

/** 重置为演示初始态 */
export function resetDb(): MockDb {
  instance = createSeedDb();
  persist(instance);
  return instance;
}

/** 清空持久化（登出时可选调用，不清业务数据仅清会话） */
export function clearMockSession(): void {
  const db = getDb();
  db.sessionOpenId = null;
  saveDb();
}
