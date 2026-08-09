/**
 * 统一错误码 + 业务异常（契约 §3.6）
 *
 * ⚠ 取值必须与前端 `web/src/types/api.ts` 的 ErrorCode 逐字一致；
 *   后端额外补两个前端不会主动产生的码：E_NOT_IMPLEMENTED / E_INTERNAL。
 *
 * ⚠ E_NETWORK 由前端 http 层在 fetch 抛错时自造，**后端永不返回**。
 *   这里保留常量只为对齐清单，httpStatus 标记为 503 仅作占位。
 */

/** 错误码常量表 */
const ErrorCode = {
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
  E_MS_REQUIRED_LOCKED: 'E_MS_REQUIRED_LOCKED',
  E_WBS_LEAF_INCOMPLETE: 'E_WBS_LEAF_INCOMPLETE',
  E_WBS_CYCLE: 'E_WBS_CYCLE',
  E_WBS_PARENT_TYPE: 'E_WBS_PARENT_TYPE',
  E_WBS_DEPTH: 'E_WBS_DEPTH',
  E_WBS_TYPE_LOCKED: 'E_WBS_TYPE_LOCKED',
  E_WIP_EXCEEDED: 'E_WIP_EXCEEDED',
  E_WBS_DEADLINE_OVERFLOW: 'E_WBS_DEADLINE_OVERFLOW',
  E_WBS_ESTIMATE_OVERFLOW: 'E_WBS_ESTIMATE_OVERFLOW',
  E_WBS_EFFORT_PARENT: 'E_WBS_EFFORT_PARENT',
  /* B8（D4）：WBS 写通道关闭 —— 工时唯一写入方 = 工作日志；携带 effortHours → 400 */
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

  /* ── 后端专有（前端 ERROR_MESSAGE_ZH 无对应项，靠 message 兜底展示） ── */
  E_NOT_IMPLEMENTED: 'E_NOT_IMPLEMENTED',
  E_INTERNAL: 'E_INTERNAL',
};

/**
 * 错误码 → HTTP 状态码（契约 §3.6）
 * - 400 参数/业务校验类
 * - 401 未登录
 * - 403 越权
 * - 404 资源不存在
 * - 409 状态冲突类
 * - 501 未实现（降级桩）
 * - 500 服务器内部错误
 */
const CODE_HTTP = {
  [ErrorCode.E_UNAUTHORIZED]: 401,

  [ErrorCode.E_FORBIDDEN]: 403,
  [ErrorCode.E_NOT_APPROVER]: 403,
  [ErrorCode.E_SELF_ROLE]: 403,

  [ErrorCode.E_NOT_FOUND]: 404,

  [ErrorCode.E_VALIDATION]: 400,
  [ErrorCode.E_CLASSIFY_REASON_REQUIRED]: 400,
  [ErrorCode.E_PROJECT_PO_REQUIRED]: 400,
  [ErrorCode.E_ROLE_CARDINALITY]: 400,
  [ErrorCode.E_WBS_CYCLE]: 400,
  [ErrorCode.E_WBS_PARENT_TYPE]: 400,
  [ErrorCode.E_WBS_DEPTH]: 400,
  [ErrorCode.E_WBS_LEAF_INCOMPLETE]: 400,
  [ErrorCode.E_WBS_DEADLINE_OVERFLOW]: 400,
  [ErrorCode.E_WBS_ESTIMATE_OVERFLOW]: 400,
  [ErrorCode.E_WBS_EFFORT_PARENT]: 400,
  [ErrorCode.E_WBS_EFFORT_WRITE_DISABLED]: 400,
  [ErrorCode.E_REPORT_RISK_INCOMPLETE]: 400,
  [ErrorCode.E_PROXY_EVIDENCE_REQUIRED]: 400,
  [ErrorCode.E_CHANGE_ROUTE]: 400,

  [ErrorCode.E_GATE_NOT_PASSED]: 409,
  [ErrorCode.E_GATE_ITEM_INCOMPLETE]: 409,
  [ErrorCode.E_MS_NEED_CHANGE]: 409,
  [ErrorCode.E_MS_REQUIRED_LOCKED]: 409,
  [ErrorCode.E_WBS_TYPE_LOCKED]: 400,
  [ErrorCode.E_WIP_EXCEEDED]: 409,
  [ErrorCode.E_REPORT_DUPLICATE]: 409,
  [ErrorCode.E_REVIEW_CLOSED]: 409,
  [ErrorCode.E_LAST_ADMIN]: 409,
  [ErrorCode.E_PROJECT_ARCHIVED]: 403,
  [ErrorCode.E_CLOSE_BLOCKED]: 409,

  [ErrorCode.E_NOT_IMPLEMENTED]: 501,
  [ErrorCode.E_INTERNAL]: 500,

  // 占位：后端永不返回
  [ErrorCode.E_NETWORK]: 503,
};

/**
 * 错误码 → 默认中文提示。
 * 与前端 ERROR_MESSAGE_ZH 保持一致，作为「后端没给 message 时」的兜底；
 * 业务代码应尽量传更具体的 message（例如带上具体字段名）。
 */
const ERROR_MESSAGE_ZH = {
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

/**
 * 取错误码对应的 HTTP 状态码。
 * @param {string} code 错误码
 * @param {number} [fallback=400] 未登记时的兜底状态码
 * @returns {number}
 */
function httpStatusOf(code, fallback) {
  const def = typeof fallback === 'number' ? fallback : 400;
  return CODE_HTTP[code] || def;
}

/**
 * 取错误码的默认中文提示。
 * @param {string} code 错误码
 * @returns {string}
 */
function messageOf(code) {
  return ERROR_MESSAGE_ZH[code] || '请求失败';
}

/**
 * 业务异常。路由/服务层一律 `throw new AppError(...)`，
 * 由 errorMiddleware 统一转成 `{ code, data, message }` 信封 + 正确的 HTTP 状态码。
 */
class AppError extends Error {
  /**
   * @param {string} code 错误码（ErrorCode 之一）
   * @param {string} [message] 展示文案，缺省取 ERROR_MESSAGE_ZH
   * @param {*} [data] 附带的结构化数据（例如阻塞项列表）
   * @param {number} [httpStatus] 显式覆盖 HTTP 状态码（一般不用）
   */
  constructor(code, message, data, httpStatus) {
    super(message || messageOf(code));
    this.name = 'AppError';
    this.code = code || ErrorCode.E_INTERNAL;
    this.data = data === undefined ? null : data;
    this.httpStatus = httpStatusOf(this.code, httpStatus);
    if (Error.captureStackTrace) Error.captureStackTrace(this, AppError);
  }
}

/* ── 常用快捷构造器（减少路由层噪音） ─────────────────── */

/** 参数校验失败（400） */
function validation(message, data) {
  return new AppError(ErrorCode.E_VALIDATION, message, data);
}

/** 未登录（401） */
function unauthorized(message) {
  return new AppError(ErrorCode.E_UNAUTHORIZED, message);
}

/** 越权（403） */
function forbidden(message) {
  return new AppError(ErrorCode.E_FORBIDDEN, message);
}

/** 资源不存在（404） */
function notFound(message) {
  return new AppError(ErrorCode.E_NOT_FOUND, message);
}

/** 未实现（501）—— 降级桩专用 */
function notImplemented(message) {
  return new AppError(ErrorCode.E_NOT_IMPLEMENTED, message);
}

module.exports = {
  ErrorCode,
  CODE_HTTP,
  ERROR_MESSAGE_ZH,
  AppError,
  httpStatusOf,
  messageOf,
  validation,
  unauthorized,
  forbidden,
  notFound,
  notImplemented,
};
