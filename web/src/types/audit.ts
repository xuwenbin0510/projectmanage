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

/** 文档记录类型：file=本地附件（C01）；link=飞书/外链文档（D02） */
export type ProjectDocType = 'file' | 'link';

/** 任务附件（C01/D02 真实实现）：挂在 WBS 任务或里程碑上的文件或外链文档 */
export interface ProjectDocument {
  id: string;
  projectId: string;
  /** 关联 WBS 任务 id；'' = 不关联 */
  nodeId: string;
  /** 关联里程碑 id；'' = 不关联 */
  milestoneId: string;
  name: string;
  /** 落盘文件名（UUID_原名）；link 记录为 '' */
  fileName: string;
  /** 字节数；link 记录为 0 */
  fileSize: number;
  /** MIME 类型；link 记录为 '' */
  mimeType: string;
  /** 磁盘相对路径（以 ATTACHMENT_ROOT 为根），用于服务端下载；link 记录为 '' */
  storagePath: string;
  /** D02：file=本地附件 / link=外链文档 */
  docType: ProjectDocType;
  /** D02：外链地址（飞书文档等）；file 记录为 '' */
  url: string;
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

/** 关联外链文档（飞书等）的入参（D02） */
export interface CreateLinkDocumentPayload {
  /** 飞书文档 / 外链 URL（http(s)://） */
  url: string;
  /** 展示名称（可空；服务端优先级：name > 飞书自动抓取标题 > url） */
  name?: string;
  /** 关联 WBS 任务 id（可空） */
  nodeId?: string;
  /** 关联里程碑 id（可空） */
  milestoneId?: string;
}
