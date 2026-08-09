/**
 * 日期纯函数（对齐前端 `web/src/utils/date.ts`）
 *
 * 后端不引入 dayjs：全部用原生 Date + 「日期字符串按 UTC 零点解析」实现，
 * 保证 `diffDays` 结果与前端逐字一致（前端 dayjs 在同一天粒度上等价）。
 *
 * 约定：
 *  - 「日期」字段恒为 `YYYY-MM-DD`
 *  - 「时间戳」字段恒为 ISO8601（`new Date().toISOString()`，带 Z）
 */

/** 日期格式长度（YYYY-MM-DD） */
const DATE_LEN = 10;

/**
 * 把日期字符串规整为 UTC 零点毫秒数；非法输入返回 NaN。
 * @param {string} s 日期或 ISO 时间字符串
 * @returns {number}
 */
function toUtcDay(s) {
  const str = String(s === null || s === undefined ? '' : s).slice(0, DATE_LEN);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * 毫秒数 → `YYYY-MM-DD`（按 UTC 取值，与 toUtcDay 对称）。
 * @param {number} ms
 * @returns {string}
 */
function fromUtcDay(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + mo + '-' + da;
}

/**
 * 今天（服务器本地时区的 `YYYY-MM-DD`）。
 * ⚠ 部署在 UTC 机器（如 Render）上会比东八区早 8 小时切日；
 *   如需按业务时区判定逾期，设置容器 TZ=Asia/Shanghai 即可，无需改代码。
 * @returns {string}
 */
function today() {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return y + '-' + mo + '-' + da;
}

/**
 * 现在（ISO8601 时间戳）。
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * a 与 b 相差天数（b - a）。任一非法日期返回 0（与前端 NaN 比较恒 false 的效果一致）。
 * @param {string} a 起始日期
 * @param {string} b 结束日期
 * @returns {number}
 */
function diffDays(a, b) {
  const da = toUtcDay(a);
  const dbv = toUtcDay(b);
  if (!Number.isFinite(da) || !Number.isFinite(dbv)) return 0;
  return Math.round((dbv - da) / 86400000);
}

/**
 * 日期加天数。
 * @param {string} base 基准日期 `YYYY-MM-DD`
 * @param {number} days 天数（可为负）
 * @returns {string}
 */
function addDays(base, days) {
  const d = toUtcDay(base);
  if (!Number.isFinite(d)) return String(base || '');
  const n = Number.isFinite(days) ? Math.round(days) : 0;
  return fromUtcDay(d + n * 86400000);
}

/**
 * 判断是否是合法的 `YYYY-MM-DD`。
 * @param {*} s
 * @returns {boolean}
 */
function isDate(s) {
  return Number.isFinite(toUtcDay(s));
}

/**
 * 里程碑日期等比压缩（SK-M7 · 与前端 `fitMilestoneDatesEx` 逐字对齐）。
 *
 * 规则：
 *  1. 首碑（offset === 0）可与 planStart 同日
 *  2. 非首碑不得被压到 planStart
 *  3. 严格单调不减，同日顺延 1 天
 *  4. 末碑恰好落在 planEnd（等比压缩的天然性质）
 *  5. 极端周期兜底：超出 planEnd 即封顶并标记 stacked
 *
 * 本函数**永不抛异常**：空数组 / 负周期 / 全零 offset 一律降级返回。
 *
 * @param {string} planStart 计划开始日
 * @param {string} planEnd 计划结束日
 * @param {number[]} offsets 模板相对偏移天数（返回值与入参同索引对齐）
 * @returns {{dates: string[], compressed: boolean, ratio: number, planDays: number, templateSpan: number, stacked: boolean}}
 */
function fitMilestoneDatesEx(planStart, planEnd, offsets) {
  const list = Array.isArray(offsets) ? offsets : [];
  if (!list.length) {
    return { dates: [], compressed: false, ratio: 1, planDays: 0, templateSpan: 0, stacked: false };
  }

  const planDays = Math.max(0, diffDays(planStart, planEnd));
  const safeOffsets = list.map(function (o) {
    return Math.max(0, Number.isFinite(o) ? o : 0);
  });
  const templateSpan = Math.max.apply(null, safeOffsets);

  if (templateSpan === 0) {
    return {
      dates: safeOffsets.map(function () { return addDays(planStart, 0); }),
      compressed: false,
      ratio: 1,
      planDays: planDays,
      templateSpan: 0,
      stacked: safeOffsets.length > 1,
    };
  }

  const compressed = planDays < templateSpan;
  const ratio = compressed ? planDays / templateSpan : 1;

  // 按 offset 升序处理，tie-break 原索引，保证确定性
  const order = safeOffsets
    .map(function (off, i) { return { off: off, i: i }; })
    .sort(function (a, b) { return a.off !== b.off ? a.off - b.off : a.i - b.i; });

  const dayOf = new Array(safeOffsets.length).fill(0);
  let prev = -1;
  let stacked = false;

  order.forEach(function (item) {
    let d = Math.round(item.off * ratio);
    if (item.off > 0 && d === 0) d = 1;          // 规则 2
    if (d <= prev) d = prev + 1;                  // 规则 3
    if (d > planDays) {                           // 规则 5
      d = planDays;
      if (d <= prev) stacked = true;
    }
    dayOf[item.i] = d;
    prev = Math.max(prev, d);
  });

  return {
    dates: dayOf.map(function (d) { return addDays(planStart, d); }),
    compressed: compressed,
    ratio: ratio,
    planDays: planDays,
    templateSpan: templateSpan,
    stacked: stacked,
  };
}

/**
 * 里程碑日期等比压缩（薄封装，只要日期数组）。
 * @param {string} planStart
 * @param {string} planEnd
 * @param {number[]} offsets
 * @returns {string[]}
 */
function fitMilestoneDates(planStart, planEnd, offsets) {
  return fitMilestoneDatesEx(planStart, planEnd, offsets).dates;
}

module.exports = {
  today,
  nowIso,
  diffDays,
  addDays,
  isDate,
  fitMilestoneDates,
  fitMilestoneDatesEx,
};
