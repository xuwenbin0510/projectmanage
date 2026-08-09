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
  E_MS_NEED_CHANGE: 'E_MS_NEED_CHANGE',
  /** 模板必备里程碑锁删（Q-2 / C-G5） */
  E_MS_REQUIRED_LOCKED: 'E_MS_REQUIRED_LOCKED',
  E_WBS_LEAF_INCOMPLETE: 'E_WBS_LEAF_INCOMPLETE',
  E_WBS_CYCLE: 'E_WBS_CYCLE',
  /* ── WBS 层级规则（简化后仅剩 2 条，规则源 = lifecycle_templates.definition.wbsRules） ── */
  E_WBS_PARENT_TYPE: 'E_WBS_PARENT_TYPE',
  E_WBS_DEPTH: 'E_WBS_DEPTH',
  E_WBS_TYPE_LOCKED: 'E_WBS_TYPE_LOCKED',
  E_WIP_EXCEEDED: 'E_WIP_EXCEEDED',
  /** 子任务截止日期超过上级任务或关联里程碑的计划日期（用户反馈③ · 硬拦截） */
  E_WBS_DEADLINE_OVERFLOW: 'E_WBS_DEADLINE_OVERFLOW',
  /** 工时估算超过起止区间可用天数（用户反馈④b · 硬拦截） */
  E_WBS_ESTIMATE_OVERFLOW: 'E_WBS_ESTIMATE_OVERFLOW',
  /** 有子节点的节点禁止手填工时（B7 R4 · 方案 A 强制汇总；B8 保留定义、不再抛出） */
  E_WBS_EFFORT_PARENT: 'E_WBS_EFFORT_PARENT',
  /** WBS 写通道关闭（B8 D4）：工时唯一写入方 = 工作日志，携带 effortHours → 400 */
  E_WBS_EFFORT_WRITE_DISABLED: 'E_WBS_EFFORT_WRITE_DISABLED',
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
  /* ── 后端专有码（server/lib/errors.js）：前端只消费、不主动产生 ── */
  /** 501 · 接口尚未实现（Connect v1 降级桩返回，页面应降级为空态而非白屏） */
  E_NOT_IMPLEMENTED: 'E_NOT_IMPLEMENTED',
  /** 500 · 服务器内部错误（未捕获异常经 errorMiddleware 兜底） */
  E_INTERNAL: 'E_INTERNAL',
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
  E_GATE_NOT_PASSED: '质量门未通过，里程碑不能标记达成',
  E_GATE_ITEM_INCOMPLETE: '存在未确认的检查项，不能提交门控结论',
  E_MS_NEED_CHANGE: '里程碑日期延后须走变更申请',
  E_MS_REQUIRED_LOCKED: '模板必备里程碑不可删除，仅可改期',
  E_WBS_LEAF_INCOMPLETE: '子任务必须填写负责人与工时估算',
  E_WBS_CYCLE: '移动会造成循环引用',
  E_WBS_PARENT_TYPE: '子任务下不能再挂节点，请挂到任务下',
  E_WBS_DEPTH: '任务层级已达上限（最多 4 层），请先拆分或上移',
  E_WBS_TYPE_LOCKED: '该节点已有子节点，不能再修改节点类型',
  E_WIP_EXCEEDED: 'WIP 已达上限，请先完成在办任务',
  E_WBS_DEADLINE_OVERFLOW: '子任务截止日期不能超过上级任务或关联里程碑的计划日期',
  E_WBS_ESTIMATE_OVERFLOW: '工时估算不得超过起止区间的可用天数',
  E_WBS_EFFORT_PARENT: '有子节点的节点工时由子任务自动汇总，不可手填',
  E_WBS_EFFORT_WRITE_DISABLED: '工时登记已移至工作日志，WBS 不再支持填写工时',
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
  E_NOT_IMPLEMENTED: '该功能尚未上线',
  E_INTERNAL: '服务器内部错误',
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
