/**
 * 多项目组合聚合纯函数（B12 · 全局总览）
 *
 * 设计约束（SK-B12）：
 *  - **零框架依赖**：不 require express / better-sqlite3 / 任何 service，
 *    只依赖 `lib/dates` 与 `config/enums` 这两个同样纯净的模块，
 *    因此可被 QA 脚本直接 `require` 后对数组断言，无需起服务、无需连库。
 *  - **不做 I/O**：入参已经是聚合好的 `ProjectListItem[]` / `WbsNode[]`，
 *    取数（含避免 N+1）由 `services/dashboard.service.js` 负责。
 *  - **口径与 B11 逐字一致**：逾期 = `diffDays(today, dueDate) < 0`；
 *    临期 = 非逾期且 `diffDays(today, dueDate) <= DUE_SOON_DAYS`；
 *    负责人排序沿用看板泳道心智（逾期 ↓ → 数量 ↓ → 姓名 ↑，未分配恒最后）。
 *
 * 术语：
 *  - 「在办任务」= 范围内项目的**真叶子**节点且 `status !== '完成'`（由调用方筛好再传入）
 *  - 「负荷」= 在办任务数 + 逾期数（决策 ③，展示为两段堆叠，本模块只给两个计数）
 */

const dates = require('./dates');
const enums = require('../config/enums');

/** 临期阈值（天）：与 `web/src/utils/dashboardAgg.ts#DUE_SOON_DAYS` 一致 */
const DUE_SOON_DAYS = 3;

/** 未分配负责人的 owner 取值（空串）与展示名 */
const UNASSIGNED_OWNER = '';
const UNASSIGNED_LABEL = '未分配';

/** 项目名缺失时的占位（与 `web/src/utils/dashboardAgg.ts` 一致） */
const UNNAMED_PROJECT = '未命名项目';

/* ── 内部小工具 ─────────────────────────────────────── */

/**
 * 字符串升序比较（不依赖 locale，保证前后端排序结果逐字一致）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareText(a, b) {
  const sa = String(a === null || a === undefined ? '' : a);
  const sb = String(b === null || b === undefined ? '' : b);
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;
}

/**
 * 安全取数组。
 * @param {*} v
 * @returns {Array}
 */
function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * 任务是否已逾期。
 * @param {object} node WbsNode
 * @param {string} todayStr `YYYY-MM-DD`
 * @returns {boolean}
 */
function isOverdue(node, todayStr) {
  const due = String((node && node.dueDate) || '');
  if (!due) return false;
  return dates.diffDays(todayStr, due) < 0;
}

/* ── 聚合函数 ───────────────────────────────────────── */

/**
 * 项目状态分布（环形图）。
 *
 * 段顺序恒按 `enums.PROJECT_STATUSES` 的业务顺序（草稿 → … → 已驳回），
 * **只输出计数 > 0 的段**（避免环上出现 0 值空段导致 legend 冗长）。
 * 出现枚举外的脏状态时按字典序追加在末尾，绝不静默丢弃。
 *
 * @param {Array<object>} items ProjectListItem[]
 * @returns {{segments: Array<{status: string, value: number}>, total: number}}
 */
function aggregateStatusDonut(items) {
  const counter = {};
  asArray(items).forEach(function (p) {
    const s = String((p && p.status) || '');
    if (!s) return;
    counter[s] = (counter[s] || 0) + 1;
  });

  const segments = [];
  enums.PROJECT_STATUSES.forEach(function (s) {
    if (counter[s]) {
      segments.push({ status: s, value: counter[s] });
      delete counter[s];
    }
  });
  Object.keys(counter).sort(compareText).forEach(function (s) {
    segments.push({ status: s, value: counter[s] });
  });

  const total = segments.reduce(function (n, seg) { return n + seg.value; }, 0);
  return { segments: segments, total: total };
}

/**
 * 健康度分布（红黄绿堆叠条）。
 *
 * `total` 恒等于 green + yellow + red —— 健康度非法/缺失的项目**不计入**，
 * 保证 `HealthDistBar` 算占比时分母与三段之和自洽（不会出现「和 < total」的空隙）。
 *
 * @param {Array<object>} items ProjectListItem[]
 * @returns {{green: number, yellow: number, red: number, total: number}}
 */
function aggregateHealth(items) {
  const dist = { green: 0, yellow: 0, red: 0, total: 0 };
  asArray(items).forEach(function (p) {
    const h = String((p && p.health) || '');
    if (h !== 'green' && h !== 'yellow' && h !== 'red') return;
    dist[h] += 1;
    dist.total += 1;
  });
  return dist;
}

/**
 * 按项目分组的逾期 / 临期任务计数。
 *
 * 排序：逾期 ↓ → 临期 ↓ → 项目名 ↑；**只保留有逾期或临期的项目**（无风险项目不占位）。
 *
 * @param {Array<object>} items ProjectListItem[]（提供 projectId → projectName 映射）
 * @param {Array<object>} tasks WbsNode[]（在办叶子任务）
 * @param {string} [todayStr] 今天；缺省取 `dates.today()`
 * @returns {Array<{projectId: string, projectName: string, overdue: number, dueSoon: number}>}
 */
function aggregateOverdue(items, tasks, todayStr) {
  const t = todayStr || dates.today();

  const nameById = {};
  asArray(items).forEach(function (p) {
    if (!p || !p.id) return;
    nameById[String(p.id)] = String(p.name || '') || UNNAMED_PROJECT;
  });

  const map = {};
  asArray(tasks).forEach(function (n) {
    const due = String((n && n.dueDate) || '');
    if (!due) return;
    const gap = dates.diffDays(t, due);
    if (gap > DUE_SOON_DAYS) return;

    const pid = String((n && n.projectId) || '');
    if (!map[pid]) {
      map[pid] = {
        projectId: pid,
        projectName: nameById[pid] || String((n && n.projectName) || '') || UNNAMED_PROJECT,
        overdue: 0,
        dueSoon: 0,
      };
    }
    if (gap < 0) map[pid].overdue += 1;
    else map[pid].dueSoon += 1;
  });

  return Object.keys(map)
    .map(function (k) { return map[k]; })
    .filter(function (r) { return r.overdue > 0 || r.dueSoon > 0; })
    .sort(function (a, b) {
      if (a.overdue !== b.overdue) return b.overdue - a.overdue;
      if (a.dueSoon !== b.dueSoon) return b.dueSoon - a.dueSoon;
      return compareText(a.projectName, b.projectName);
    });
}

/**
 * 负责人负荷（决策 ③：负荷 = 在办任务数 + 逾期数）。
 *
 * 排序沿用看板泳道心智（`web/src/utils/board.ts#groupByOwner`）：
 *   逾期 ↓ → 在办 ↓ → 姓名 ↑，**未分配（owner === ''）恒排最后**。
 *
 * `ownerName` 取任务上的 `ownerName`（由 mapper 反查 users 得到）；
 * 查不到姓名时回落 openId，绝不显示空白行。
 *
 * `projects` 是「该人在各项目下的任务分布」，供 P1-6 下钻抽屉直接渲染：
 * 反正要按项目去重才能算 `projectCount`，顺手把计数带出来，抽屉无需二次请求。
 *
 * @param {Array<object>} tasks WbsNode[]（在办叶子任务）
 * @param {string} [todayStr] 今天；缺省取 `dates.today()`
 * @param {Object<string, string>} [nameById] projectId → 项目名（缺省回落任务上的 projectName）
 * @returns {Array<{owner: string, ownerName: string, activeTasks: number, overdueTasks: number, projectCount: number, projects: Array<{projectId: string, projectName: string, activeTasks: number, overdueTasks: number}>}>}
 */
function aggregateOwnerLoad(tasks, todayStr, nameById) {
  const t = todayStr || dates.today();
  const names = nameById && typeof nameById === 'object' ? nameById : {};
  const map = {};

  asArray(tasks).forEach(function (n) {
    const owner = String((n && n.owner) || '');
    const key = owner || UNASSIGNED_OWNER;
    if (!map[key]) {
      map[key] = {
        owner: key,
        ownerName: owner ? (String((n && n.ownerName) || '') || owner) : UNASSIGNED_LABEL,
        activeTasks: 0,
        overdueTasks: 0,
        projects: {},
      };
    }
    const row = map[key];
    const late = isOverdue(n, t);
    row.activeTasks += 1;
    if (late) row.overdueTasks += 1;

    const pid = String((n && n.projectId) || '');
    if (pid) {
      if (!row.projects[pid]) {
        row.projects[pid] = {
          projectId: pid,
          projectName: names[pid] || String((n && n.projectName) || '') || UNNAMED_PROJECT,
          activeTasks: 0,
          overdueTasks: 0,
        };
      }
      row.projects[pid].activeTasks += 1;
      if (late) row.projects[pid].overdueTasks += 1;
    }
  });

  return Object.keys(map)
    .map(function (k) {
      const r = map[k];
      const projects = Object.keys(r.projects)
        .map(function (pid) { return r.projects[pid]; })
        .sort(function (a, b) {
          if (a.overdueTasks !== b.overdueTasks) return b.overdueTasks - a.overdueTasks;
          if (a.activeTasks !== b.activeTasks) return b.activeTasks - a.activeTasks;
          return compareText(a.projectName, b.projectName);
        });
      return {
        owner: r.owner,
        ownerName: r.ownerName,
        activeTasks: r.activeTasks,
        overdueTasks: r.overdueTasks,
        projectCount: projects.length,
        projects: projects,
      };
    })
    .sort(function (a, b) {
      const au = a.owner === UNASSIGNED_OWNER;
      const bu = b.owner === UNASSIGNED_OWNER;
      if (au !== bu) return au ? 1 : -1;              // 未分配恒最后
      if (a.overdueTasks !== b.overdueTasks) return b.overdueTasks - a.overdueTasks;
      if (a.activeTasks !== b.activeTasks) return b.activeTasks - a.activeTasks;
      return compareText(a.ownerName, b.ownerName);
    });
}

/**
 * 范围内逾期任务总数。
 * @param {Array<object>} tasks WbsNode[]（在办叶子任务）
 * @param {string} [todayStr]
 * @returns {number}
 */
function countOverdueTasks(tasks, todayStr) {
  const t = todayStr || dates.today();
  return asArray(tasks).filter(function (n) { return isOverdue(n, t); }).length;
}

/**
 * 整体进度（0~100 整数）。
 *
 * ⚠ 口径 = `ProjectListItem.progress`（**里程碑达成率**）的算术平均，
 *   与项目详情页的「WBS 加权进度」是两个口径，UI 必须在副标题标注，
 *   否则用户会质疑「总览 62% 与详情 71% 谁对」。
 *
 * @param {Array<object>} items ProjectListItem[]
 * @returns {number}
 */
function averageProgress(items) {
  const list = asArray(items);
  if (!list.length) return 0;
  const sum = list.reduce(function (n, p) {
    const v = Number(p && p.progress);
    return n + (Number.isFinite(v) ? v : 0);
  }, 0);
  return Math.round(sum / list.length);
}

module.exports = {
  DUE_SOON_DAYS,
  UNASSIGNED_OWNER,
  UNASSIGNED_LABEL,
  UNNAMED_PROJECT,
  compareText,
  isOverdue,
  aggregateStatusDonut,
  aggregateHealth,
  aggregateOverdue,
  aggregateOwnerLoad,
  countOverdueTasks,
  averageProgress,
};
