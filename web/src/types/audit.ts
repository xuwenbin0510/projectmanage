/** 审计 / 风险(P1) / 文档(P1) */

export type AuditEntityType =
  | 'project'
  | 'stage'
  | 'gate'
  | 'gate_item'
  | 'milestone'
  | 'wbs_node'
  | 'report'
  | 'review'
  | 'change'
  | 'user';

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'status_change'
  | 'decide'
  | 'approve'
  | 'reject'
  | 'apply';

export interface AuditDiffEntry {
  field: string;
  label: string;
  before: string;
  after: string;
}

export interface AuditLog {
  id: string;
  projectId: string;
  projectName: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  actorOpenId: string;
  actorName: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  diff: AuditDiffEntry[];
  summary: string;
  createdAt: string;
}

/** P1 风险登记册（一期仅建类型与占位页） */
export interface Risk {
  id: string;
  projectId: string;
  code: string;
  description: string;
  category: string;
  probability: number;
  impact: number;
  riskValue: number;
  strategy: string;
  owner: string;
  status: string;
  reviewDate: string;
}

/** P1 文档清单（一期仅建类型与占位页） */
export interface ProjectDocument {
  id: string;
  projectId: string;
  stageId: string;
  templateKey: string;
  name: string;
  status: string;
  version: string;
  baselineFlag: boolean;
  url: string;
  owner: string;
}
