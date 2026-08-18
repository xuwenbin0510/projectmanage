/**
 * ESM resolve hook（仅用于 QA 验证脚本本地运行）。
 *
 * dayjs 1.11.x 是 CJS 包且无 `exports` 字段，Node ESM 默认要求补 `.js` 后缀，
 * 否则 `import 'dayjs/plugin/isoWeek'` 会报 ERR_MODULE_NOT_FOUND。
 * 本 hook 对 `dayjs/...` 无扩展名的 specifier 自动补 `.js`，
 * 使 `node --experimental-strip-types` 能直接 import 真实的 `web/src/utils/date.ts`。
 * 不修改任何被测源码。
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('dayjs/') && !/\.(c|m)?js(\?.*)?$/.test(specifier)) {
    try {
      return await next(specifier + '.js', context);
    } catch (_e) {
      /* 回退到原始解析，交给 Node 报更清晰的错误 */
    }
  }
  return next(specifier, context);
}
