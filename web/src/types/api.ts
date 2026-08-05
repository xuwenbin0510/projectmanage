/** 统一 API 响应与错误类型（架构 7.1 / 7.2） */

export interface ApiEnvelope<T> {
  code: 0 | string;
  data: T;
  message: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

/** 错误码常量（与 server/lib/errors.js 保持一致） */
export const ErrorCode = {
  E_UNAUTHORIZED: 'E_UNAUTHORIZED',
  E_FORBIDDEN: 'E_FORBIDDEN',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_VALIDATION: 'E_VALIDATION',
  E_CLASSIFY_REASON_REQUIRED: 'E_CLASSIFY_REASON_REQUIRED',
  E_PROJECT_PO_REQUIRED: 'E_PROJECT_PO_REQUIRED',
  E_ROLE_CARDINALITY: 'E_ROLE_CARDINALITY',
  E_GATE_NOT_PASSED: 'E_GATE_NOT_PASSED',
  E_GATE_ITEM_INCOMPLETE: 'E_GATE_ITEM_INCOMPLETE',
  /** ⚠️ 契约保留位，本轮（WBS 重构 D-5）暂未实现服务端校验 */
  E_STAGE_SEQUENCE: 'E_STAGE_SEQUENCE',
  E_MS_NEED_CHANGE: 'E_MS_NEED_CHANGE',
  E_WBS_LEAF_INCOMPLETE: 'E_WBS_LEAF_INCOMPLETE',
  E_WBS_CYCLE: 'E_WBS_CYCLE',
  /* ── WBS 层级规则（重构 D-2，规则源 = lifecycle_templates.definition.wbsRules） ── */
  E_WBS_PARENT_TYPE: 'E_WBS_PARENT_TYPE',
  E_WBS_DEPTH: 'E_WBS_DEPTH',
  E_WBS_STAGE_UNBOUND: 'E_WBS_STAGE_UNBOUND',
  E_WBS_TYPE_LOCKED: 'E_WBS_TYPE_LOCKED',
  E_WIP_EXCEEDED: 'E_WIP_EXCEEDED',
  E_REPORT_RISK_INCOMPLETE: 'E_REPORT_RISK_INCOMPLETE',
  E_REPORT_DUPLICATE: 'E_REPORT_DUPLICATE',
  E_NOT_APPROVER: 'E_NOT_APPROVER',
  E_REVIEW_CLOSED: 'E_REVIEW_CLOSED',
  E_PROXY_EVIDENCE_REQUIRED: 'E_PROXY_EVIDENCE_REQUIRED',
  E_SELF_ROLE: 'E_SELF_ROLE',
  E_LAST_ADMIN: 'E_LAST_ADMIN',
  E_CHANGE_ROUTE: 'E_CHANGE_ROUTE',
  E_PROJECT_ARCHIVED: 'E_PROJECT_ARCHIVED',
  E_CLOSE_BLOCKED: 'E_CLOSE_BLOCKED',
  E_NETWORK: 'E_NETWORK',
} as const;

export type ErrorCodeKey = keyof typeof ErrorCode;

/** 错误码 → 中文提示（前端统一映射） */
export const ERROR_MESSAGE_ZH: Record<string, string> = {
  E_UNAUTHORIZED: '未登录或登录已过期，请重新登录',
  E_FORBIDDEN: '无操作权限',
  E_NOT_FOUND: '资源不存在',
  E_VALIDATION: '参数校验失败',
  E_CLASSIFY_REASON_REQUIRED: '覆盖系统分类建议时必须填写理由',
  E_PROJECT_PO_REQUIRED: 'B 类项目必须指定产品负责人（PO）',
  E_ROLE_CARDINALITY: '每个项目 PM / TL 有且仅有 1 人',
  E_GATE_NOT_PASSED: '质量门未通过，无法进入下一阶段',
  E_GATE_ITEM_INCOMPLETE: '存在未确认的检查项，不能提交门控结论',
  E_STAGE_SEQUENCE: '阶段只能顺序推进，不可跳阶',
  E_MS_NEED_CHANGE: '里程碑日期延后须走变更申请',
  E_WBS_LEAF_INCOMPLETE: '叶子节点必须填写负责人与工时估算',
  E_WBS_CYCLE: '移动会造成循环引用',
  E_WBS_PARENT_TYPE: '该节点类型不允许挂在此父节点下',
  E_WBS_DEPTH: 'WBS 层级已达上限，请先拆分或上移',
  E_WBS_STAGE_UNBOUND: '工作分区必须绑定所属生命周期阶段',
  E_WBS_TYPE_LOCKED: '该节点已有子节点，不能再修改节点类型',
  E_WIP_EXCEEDED: 'WIP 已达上限，请先完成在办任务',
  E_REPORT_RISK_INCOMPLETE: '风险条目缺少责任人或截止日',
  E_REPORT_DUPLICATE: '本周周报已存在',
  E_NOT_APPROVER: '当前步骤无需您审批',
  E_REVIEW_CLOSED: '评审已结束',
  E_PROXY_EVIDENCE_REQUIRED: '客户代表代录须填写意见或凭证链接',
  E_SELF_ROLE: '不能修改自己的角色',
  E_LAST_ADMIN: '系统至少保留一名管理员',
  E_CHANGE_ROUTE: '变更审批路径不匹配',
  E_PROJECT_ARCHIVED: '项目已结项，处于只读归档状态',
  E_CLOSE_BLOCKED: '结项被阻塞，请先处理阻塞项',
  E_NETWORK: '网络异常，请稍后重试',
};

/** 业务异常（client.ts 抛出，页面统一 catch） */
export class ApiError<D = unknown> extends Error {
  public readonly code: string;
  public readonly data: D | undefined;
  public readonly httpStatus: number;

  constructor(code: string, message?: string, data?: D, httpStatus = 400) {
    super(message || ERROR_MESSAGE_ZH[code] || '请求失败');
    this.name = 'ApiError';
    this.code = code;
    this.data = data;
    this.httpStatus = httpStatus;
  }
}

/** 判断是否为 ApiError */
export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** 从任意异常中提取可展示的中文文案 */
export function messageOf(e: unknown): string {
  if (isApiError(e)) return e.message || ERROR_MESSAGE_ZH[e.code] || '请求失败';
  if (e instanceof Error) return e.message;
  return String(e ?? '未知错误');
}
