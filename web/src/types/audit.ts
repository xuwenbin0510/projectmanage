/** 审计 / 风险(P1) / 文档(P1) */

export type AuditEntityType =
  | 'project'
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

/** 任务附件（C01 真实实现）：挂在 WBS 任务或里程碑上的文件 */
export interface ProjectDocument {
  id: string;
  projectId: string;
  /** 关联 WBS 任务 id；'' = 不关联 */
  nodeId: string;
  /** 关联里程碑 id；'' = 不关联 */
  milestoneId: string;
  name: string;
  /** 落盘文件名（UUID_原名） */
  fileName: string;
  /** 字节数 */
  fileSize: number;
  /** MIME 类型 */
  mimeType: string;
  /** 磁盘相对路径（以 ATTACHMENT_ROOT 为根），用于服务端下载 */
  storagePath: string;
  /** 上传人 open_id */
  uploadedBy: string;
  uploadedAt: string;
  createdAt: string;
}

/** 上传任务附件的入参 */
export interface UploadDocumentPayload {
  /** 浏览器 File 对象（http 走 FormData；mock 仅取 name/size/type） */
  file: File;
  /** 关联 WBS 任务 id（可空） */
  nodeId?: string;
  /** 关联里程碑 id（可空） */
  milestoneId?: string;
}
