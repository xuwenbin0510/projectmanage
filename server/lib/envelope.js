/**
 * 统一响应信封（契约 §3.1）
 *
 * 所有 /api/* 响应体恒为 `{ code, data, message }`：
 *   - 成功：`code` 恒为**数字** 0
 *   - 失败：`code` 恒为**字符串** E_xxx
 * 禁止裸对象 / 裸数组直出（§8.3）。
 *
 * 分页只用于 listProjects / listAudit：`data` 为 `{ items, total, page, pageSize }`；
 * 其余列表接口 `data` **直接就是数组**，不要再包 `{ list, total }`，
 * 否则前端 `.map` 会直接崩。
 */
const { AppError, ErrorCode, httpStatusOf, messageOf } = require('./errors');

/**
 * 成功信封。
 * @template T
 * @param {T} data 业务数据（可为 null）
 * @param {string} [message='ok'] 提示文案
 * @returns {{code: 0, data: T, message: string}}
 */
function ok(data, message) {
  return {
    code: 0,
    data: data === undefined ? null : data,
    message: message || 'ok',
  };
}

/**
 * 失败信封。
 * @param {string} code 错误码（字符串 E_xxx）
 * @param {string} [message] 提示文案，缺省取错误码默认文案
 * @param {*} [data] 附带数据
 * @returns {{code: string, data: *, message: string}}
 */
function fail(code, message, data) {
  return {
    code: code || ErrorCode.E_INTERNAL,
    data: data === undefined ? null : data,
    message: message || messageOf(code),
  };
}

/**
 * 分页负载（仅 listProjects / listAudit 使用）。
 * 注意：返回的是 `data` 的内容，外层仍需 `ok(paged(...))`。
 * @template T
 * @param {T[]} items 当前页数据
 * @param {number} total 总条数
 * @param {number} page 页码（从 1 开始）
 * @param {number} pageSize 每页条数
 * @returns {{items: T[], total: number, page: number, pageSize: number}}
 */
function paged(items, total, page, pageSize) {
  const list = Array.isArray(items) ? items : [];
  return {
    items: list,
    total: Number.isFinite(total) ? total : list.length,
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : list.length,
  };
}

/**
 * 包裹 async 路由处理器，把 rejected promise 转交 Express 错误链路。
 * 用法：`router.get('/x', asyncHandler(async (req, res) => { ... }))`
 * @param {Function} fn 路由处理函数
 * @returns {Function}
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') out.catch(next);
    } catch (e) {
      next(e);
    }
  };
}

/**
 * 全局错误中间件（必须挂在所有路由之后）。
 * 把 AppError 转成契约信封；未知异常一律 500 + E_INTERNAL，并打完整堆栈到日志。
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 */
function errorMiddleware(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    return res.status(err.httpStatus).json(fail(err.code, err.message, err.data));
  }

  // express.json() 解析失败（请求体不是合法 JSON）
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res
      .status(httpStatusOf(ErrorCode.E_VALIDATION))
      .json(fail(ErrorCode.E_VALIDATION, '请求体不是合法的 JSON'));
  }

  // 请求体过大
  if (err && err.type === 'entity.too.large') {
    return res
      .status(httpStatusOf(ErrorCode.E_VALIDATION))
      .json(fail(ErrorCode.E_VALIDATION, '请求体过大'));
  }

  console.error('[api] unhandled error on %s %s', req.method, req.originalUrl);
  console.error(err && err.stack ? err.stack : err);

  return res
    .status(httpStatusOf(ErrorCode.E_INTERNAL))
    .json(fail(ErrorCode.E_INTERNAL, '服务器内部错误'));
}

/**
 * 404 兜底（仅用于 /api/* 未匹配到路由的情况），保持信封一致。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function apiNotFound(req, res) {
  res
    .status(httpStatusOf(ErrorCode.E_NOT_FOUND))
    .json(fail(ErrorCode.E_NOT_FOUND, '接口不存在：' + req.method + ' ' + req.originalUrl));
}

module.exports = {
  ok,
  fail,
  paged,
  asyncHandler,
  errorMiddleware,
  apiNotFound,
  // 便于路由层「一处 require」拿到抛错能力
  AppError,
  ErrorCode,
};
