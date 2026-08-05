import type {
  User,
  Project,
  ProjectMember,
  LifecycleTemplate,
  ProjectStage,
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
  stages: ProjectStage[];
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
  /** 当前登录用户 openId（devlogin 写入） */
  sessionOpenId: string | null;
}

// v2：Milestone 新增必填字段 target，旧缓存缺字段会导致运行时 undefined，故升版强制刷新
const STORAGE_KEY = 'pm_mock_db_v2';

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
