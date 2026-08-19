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
  /** D03：全量任务快照（周报提交时采集，供任务进度环比） */
  progressSnapshots: ProgressSnapshotMock[];
  /** 当前登录用户 openId（devlogin 写入） */
  sessionOpenId: string | null;
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
