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
  | 'user'
  | 'document'
  | 'review_template'
  | 'template';

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'status_change'
  | 'decide'
  | 'approve'
  | 'reject'
  | 'apply'
  /* D05：文档基线 */
  | 'baseline'
  | 'baseline_change'
  /* 用户管理：管理员重置密码 */
  | 'reset-password';

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

/** 文档记录类型：file=本地附件（C01）；link=飞书/外链文档（D02）；模板清单项未交付时 docType='' */
export type ProjectDocType = 'file' | 'link' | '';

/** 文档记录交付状态（D04）：模板项 待交付/已交付；手动记录恒 已交付 */
export type ProjectDocStatus = '待交付' | '已交付';

/** 任务附件（C01/D02/D04 真实实现）：挂在 WBS 任务或里程碑上的文件或外链文档，或模板派生的待交付清单项 */
export interface ProjectDocument {
  id: string;
  projectId: string;
  /** 关联 WBS 任务 id；'' = 不关联 */
  nodeId: string;
  /** 关联里程碑 id；'' = 不关联（模板项派生时按 milestoneCode 挂载） */
  milestoneId: string;
  name: string;
  /** 落盘文件名（UUID_原名）；link/未交付模板项为 '' */
  fileName: string;
  /** 字节数；link/未交付模板项为 0 */
  fileSize: number;
  /** MIME 类型；link/未交付模板项为 '' */
  mimeType: string;
  /** 磁盘相对路径（以 ATTACHMENT_ROOT 为根），用于服务端下载；link/未交付模板项为 '' */
  storagePath: string;
  /** D02：file=本地附件 / link=外链文档 / ''=模板清单项未交付 */
  docType: ProjectDocType;
  /** D02：外链地址（飞书文档等）；非 link 为 '' */
  url: string;
  /** D04：模板交付物标识（如 'TPL-A-1'）；'' = 手动上传/链接（非模板项） */
  templateKey: string;
  /** D04：交付状态 */
  status: ProjectDocStatus;
  /** D04：交付版本号（替换文件/链接时 +1） */
  version: number;
  /** D04：是否纳入基线（0/1，本期仅标记展示） */
  baselineFlag: number;
  /** D05：建立基线时间（ISO；未基线为 ''） */
  baselinedAt: string;
  /** D05：建立基线操作人 open_id（未基线为 ''） */
  baselinedBy: string;
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
  /** D04：模板交付物标识（命中 → 覆盖该清单项并升版） */
  templateKey?: string;
  /** D05：替换已基线交付物的变更原因（必填条件由服务端校验） */
  changeNote?: string;
}

/** 关联外链文档（飞书等）的入参（D02/D04） */
export interface CreateLinkDocumentPayload {
  /** 飞书文档 / 外链 URL（http(s)://） */
  url: string;
  /** 展示名称（可空；服务端优先级：name > 飞书自动抓取标题 > url） */
  name?: string;
  /** 关联 WBS 任务 id（可空） */
  nodeId?: string;
  /** 关联里程碑 id（可空） */
  milestoneId?: string;
  /** D04：模板交付物标识（命中 → 覆盖该清单项并升版） */
  templateKey?: string;
  /** D05：替换已基线交付物的变更原因（必填条件由服务端校验） */
  changeNote?: string;
}
