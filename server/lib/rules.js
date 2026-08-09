/**
 * 纯业务规则（服务端为准；与前端 `web/src/api/mock/rules.ts` 逐条对齐）
 *
 * 这里只放**无副作用的纯函数**：不碰 db、不抛 HTTP 错误。
 * 需要落库 / 报错的逻辑一律放 services 层。
 *
 * ⚠ SK-2：`Milestone.status` / `done` 是**派生值**，唯一真值是
 *   `done_at` + `status_override` 三元组 + `planned_date`。
 *   数据库里不存 status / done，读路径每次推导。
 */
const { diffDays, today } = require('./dates');
const { DEFAULT_WBS_RULES, GATE_PASSED_STATUSES } = require('../config/enums');

/* ── 里程碑排序 ───────────────────────────────────── */

/**
 * 里程碑确定性比较（SK-M1 · 排序与编号的唯一真源）。
 * 排序键：`currentDate` 升序 → `createdAt` 升序 → `id` 数字感知自然序。
 *
 * 🚫 禁止把 `code` 作为比较键 —— code 由 renumber 按本函数结果反写，
 *    引入 code 会形成 sort → code → sort 循环依赖。
 *
 * @param {{currentDate: string, createdAt: string, id: string}} a
 * @param {{currentDate: string, createdAt: string, id: string}} b
 * @returns {number}
 */
function compareMilestones(a, b) {
  const ad = a.currentDate || '';
  const bd = b.currentDate || '';
  if (ad !== bd) return ad < bd ? -1 : 1;
  const ac = a.createdAt || '';
  const bc = b.createdAt || '';
  if (ac !== bc) return ac < bc ? -1 : 1;
  return String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
}

/**
 * 里程碑确定性排序（返回新数组，不改原数组）。
 * @param {Array} list
 * @returns {Array}
 */
function sortMilestones(list) {
  return (list || []).slice().sort(compareMilestones);
}

/**
 * 里程碑编号重排：按 compareMilestones 排序后重排为 M1..Mn。
 * **幂等**；只改内存对象的 code，是否落库由调用方决定。
 * @param {Array} list 同项目全部里程碑（API 形态，含 code）
 * @returns {Array} 发生变化的里程碑（供调用方决定要不要 UPDATE）
 */
function renumberMilestones(list) {
  const changed = [];
  sortMilestones(list).forEach(function (m, i) {
    const next = 'M' + (i + 1);
    if (m.code !== next) {
      m.code = next;
      changed.push(m);
    }
  });
  return changed;
}

/* ── 里程碑状态推导（§2.5 · 五级优先链） ─────────────── */

/**
 * 人工覆盖是否仍然有效（SK-7）：覆盖时快照了 currentDate，一旦改期即自动作废。
 * @param {{statusOverride: ?string, overrideBaseDate: ?string, currentDate: string}} ms
 * @returns {boolean}
 */
function isOverrideValid(ms) {
  return !!ms.statusOverride && ms.overrideBaseDate === ms.currentDate;
}

/**
 * 里程碑「起算日」（§2.5.4）：同项目里程碑定序后取上一碑的 currentDate；首碑取 planStart。
 * @param {Array} list 同项目全部里程碑（无需预排序）
 * @param {{id: string}} ms 目标里程碑
 * @param {string} planStart 项目计划开始日
 * @returns {string}
 */
function milestoneStartFrom(list, ms, planStart) {
  const sorted = sortMilestones(list);
  const idx = sorted.findIndex(function (m) { return m.id === ms.id; });
  if (idx <= 0) return planStart || '';
  return sorted[idx - 1].currentDate || planStart || '';
}

/**
 * 里程碑状态五级优先链（自上而下命中即定）：
 *  P1 覆盖有效 → statusOverride
 *  P2 doneAt 非空 → 已达成
 *  P3 today > currentDate → 已逾期
 *  P4 完成度 > 0 或 today >= startFrom → 进行中
 *  P5 其余 → 未开始
 *
 * @param {Object} ms 里程碑（API 形态）
 * @param {{today: string, startFrom: string, stats: {progress: number}}} ctx
 * @returns {string} MilestoneStatus
 */
function deriveMilestoneStatus(ms, ctx) {
  if (isOverrideValid(ms)) return ms.statusOverride;
  if (ms.doneAt) return '已达成';
  if (ms.currentDate && diffDays(ctx.today, ms.currentDate) < 0) return '已逾期';
  const progress = ctx.stats && Number.isFinite(ctx.stats.progress) ? ctx.stats.progress : 0;
  if (progress > 0) return '进行中';
  if (ctx.startFrom && diffDays(ctx.startFrom, ctx.today) >= 0) return '进行中';
  return '未开始';
}

/**
 * 一次性推导整组里程碑的 status / done（就地写回 API 形态对象）。
 * 这是后端「派生状态的唯一写入口」，对应前端 refreshMilestoneStatuses。
 *
 * @param {Array} list 同项目全部里程碑（API 形态）
 * @param {string} planStart 项目计划开始日
 * @param {string} todayStr 今天
 * @param {Object<string, {total: number, done: number, progress: number}>} statsByMs 里程碑 id → 任务统计
 * @returns {Array} 原数组（已就地更新 status / done）
 */
function applyMilestoneStatuses(list, planStart, todayStr, statsByMs) {
  const stats = statsByMs || {};
  (list || []).forEach(function (ms) {
    const s = stats[ms.id] || emptyTaskStats();
    ms.status = deriveMilestoneStatus(ms, {
      today: todayStr,
      startFrom: milestoneStartFrom(list, ms, planStart),
      stats: s,
    });
    ms.done = ms.status === '已达成';
  });
  return list;
}

/**
 * 空的里程碑任务统计（B1 尚无 WBS 数据时的缺省值）。
 * @returns {{total: number, done: number, progress: number}}
 */
function emptyTaskStats() {
  return { total: 0, done: 0, progress: 0 };
}

/* ── 健康度 ───────────────────────────────────────── */

/**
 * 健康度：红 = 存在未达成且已逾期的里程碑；黄 = 7 天内到期 或 有门待检；否则绿。
 * @param {Array} milestones 里程碑（API 形态，需已推导 done）
 * @param {Array} gates 质量门（API 形态）
 * @returns {'green'|'yellow'|'red'}
 */
function computeHealth(milestones, gates) {
  const list = milestones || [];
  const gs = gates || [];
  const t = today();

  const overdue = list.some(function (m) {
    return !m.done && m.currentDate && diffDays(t, m.currentDate) < 0;
  });
  if (overdue) return 'red';

  const dueSoon = list.some(function (m) {
    if (m.done || !m.currentDate) return false;
    const d = diffDays(t, m.currentDate);
    return d >= 0 && d <= 7;
  });
  const gatePending = gs.some(function (g) { return g.status === '待检查'; });
  if (dueSoon || gatePending) return 'yellow';
  return 'green';
}

/**
 * 已「过门」的门数量（概览页「已过 N/M 道门」口径）。
 * @param {Array} gates
 * @returns {number}
 */
function countPassedGates(gates) {
  return (gates || []).filter(function (g) {
    return GATE_PASSED_STATUSES.indexOf(g.status) >= 0;
  }).length;
}

/* ── WBS 规则 ─────────────────────────────────────── */

/**
 * 取项目实际生效的 WBS 规则：DEFAULT_WBS_RULES 兜底 + 模板差异覆盖。
 * @param {Object|null} [template] 生命周期模板（API 形态）
 * @returns {{maxDepth: number, skeleton: string, childTypes: Object}}
 */
function resolveWbsRules(template) {
  const base = {
    maxDepth: DEFAULT_WBS_RULES.maxDepth,
    skeleton: DEFAULT_WBS_RULES.skeleton,
    childTypes: Object.assign({}, DEFAULT_WBS_RULES.childTypes),
  };
  const override = template && template.definition && template.definition.wbsRules;
  if (!override) return base;
  return {
    maxDepth: override.maxDepth === undefined || override.maxDepth === null
      ? base.maxDepth : override.maxDepth,
    skeleton: override.skeleton === undefined || override.skeleton === null
      ? base.skeleton : override.skeleton,
    childTypes: Object.assign({}, base.childTypes, override.childTypes || {}),
  };
}

module.exports = {
  compareMilestones,
  sortMilestones,
  renumberMilestones,
  isOverrideValid,
  milestoneStartFrom,
  deriveMilestoneStatus,
  applyMilestoneStatuses,
  emptyTaskStats,
  computeHealth,
  countPassedGates,
  resolveWbsRules,
};
