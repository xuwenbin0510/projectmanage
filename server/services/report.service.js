/**
 * 结构化周报（工作日志）服务（B4 · T02-3）
 *
 * 职责边界：
 *  - 纯数据层，**零 Express 依赖**；事务、校验、错误码在本层，行↔对象映射在文件内私有函数
 *  - 库内 snake_case，出参统一 camelCase（`rowToApiReport`），逐字段对齐 `web/src/types/report.ts`
 *  - 表名带 `work_` 前缀（偏差 D-1），避免与 v1 遗留 `reports` 旧 schema 冲突
 *  - **仅 `submit=true`** 触发：进度回写 + 快照冻结 + WBS 进度状态刷新 + 里程碑状态刷新 + 审计；
 *    `updateReport`（编辑）**不触发**上述任何一项（共享约定 §6）
 */

const { AppError, ErrorCode } = require('../lib/errors');
const dates = require('../lib/dates');
const ids = require('../lib/ids');
const { writeAudit } = require('../lib/audit');
const enums = require('../config/enums');
const wbsService = require('./wbs.service');
const milestoneService = require('./milestone.service');
const snapshotService = require('./snapshot.service');

/* ── 小工具 ─────────────────────────────────────────── */

/**
 * 安全转字符串（null/undefined → 默认值）。
 * @param {*} v 原始值
 * @param {string} [fallback=''] 缺省值
 * @returns {string}
 */
function toStr(v, fallback) {
  const dft = fallback === undefined ? '' : fallback;
  return v === null || v === undefined ? dft : String(v);
}

/**
 * 进度取值归一：非法值归 0，超界裁剪到 [0,100]，取整。
 * @param {*} v 原始值
 * @returns {number}
 */
function toProgress(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 宽松 JSON 解析（解析失败回落默认值）。
 * @param {*} raw 原始字符串
 * @param {*} fallback 解析失败时的返回值
 * @returns {*}
 */
function parseJson(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    const v = JSON.parse(String(raw));
    return v === null || v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

/**
 * 生成 `IN (?,?,...)` 占位串。
 * @param {number} n 占位数量
 * @returns {string}
 */
function placeholders(n) {
  return new Array(n).fill('?').join(',');
}

/* ── 提交强校验（移植自 web/src/api/mock/rules.ts#validateReport） ───── */

/**
 * 周报提交强校验：风险行必须有描述 / 责任人 / 截止日；下周计划至少 1 条。
 *
 * 纯函数，与前端 `validateReport` 文案逐字对齐，便于前后端错误提示一致。
 *
 * @param {object} payload ReportPayload
 * @returns {{ok: boolean, messages: string[], invalidRiskRows: number[]}}
 */
function validateReportPayload(payload) {
  const p = payload || {};
  const risks = Array.isArray(p.risks) ? p.risks : [];
  const planItems = Array.isArray(p.planItems) ? p.planItems : [];

  /** @type {number[]} */
  const invalidRiskRows = [];
  /** @type {string[]} */
  const messages = [];

  risks.forEach(function (r, i) {
    const row = r || {};
    const noDesc = !toStr(row.description).trim();
    const noOwner = !toStr(row.owner).trim();
    const noDue = !toStr(row.dueDate).trim();
    if (noOwner || noDue || noDesc) invalidRiskRows.push(i + 1);
    if (noDesc) messages.push('第 ' + (i + 1) + ' 条风险缺少描述');
    if (noOwner) messages.push('第 ' + (i + 1) + ' 条风险缺少责任人');
    if (noDue) messages.push('第 ' + (i + 1) + ' 条风险缺少截止日期');
  });

  const validPlans = planItems.filter(function (x) { return toStr(x).trim(); });
  if (!validPlans.length) messages.push('「下周计划」至少填写 1 条');

  return { ok: messages.length === 0, messages: messages, invalidRiskRows: invalidRiskRows };
}

/* ── 行 → API 对象映射（snake → camel） ─────────────── */

/**
 * 周报任务行 → API `ReportTaskRow`。
 * @param {object} row work_report_tasks 行
 * @returns {object}
 */
function taskRowToApi(row) {
  return {
    reportId: toStr(row.report_id),
    nodeId: toStr(row.node_id),
    nodeCode: toStr(row.node_code),
    nodeName: toStr(row.node_name),
    progressBefore: toProgress(row.progress_before),
    progressAfter: toProgress(row.progress_after),
    selected: Number(row.selected) === 1,
    // B8（R3）：本周实际工时（人日），编辑态冲正回填源
    weekActualDays: Number(row.week_actual_days) || 0,
  };
}

/**
 * 周报风险行 → API `ReportRisk`。
 * @param {object} row work_report_risks 行
 * @returns {object}
 */
function riskRowToApi(row) {
  return {
    id: toStr(row.id),
    reportId: toStr(row.report_id),
    seq: Number(row.seq) || 0,
    description: toStr(row.description),
    owner: toStr(row.owner),
    dueDate: toStr(row.due_date),
    promotedRiskId: row.promoted_risk_id === null || row.promoted_risk_id === undefined
      ? null
      : String(row.promoted_risk_id),
  };
}

/**
 * 周报主行 + 子行 → API `Report`（响应体禁 snake_case，共享约定 §2）。
 * @param {object} row work_reports 行
 * @param {object[]} [taskRows] 该周报的任务行
 * @param {object[]} [riskRows] 该周报的风险行
 * @returns {object} Report
 */
function rowToApiReport(row, taskRows, riskRows) {
  const tasks = Array.isArray(taskRows) ? taskRows : [];
  const risks = Array.isArray(riskRows) ? riskRows : [];
  const planItems = parseJson(row.plan_items, []);

  return {
    id: toStr(row.id),
    projectId: toStr(row.project_id),
    week: toStr(row.week),
    weekStart: toStr(row.week_start),
    weekEnd: toStr(row.week_end),
    author: toStr(row.author_open_id),
    authorName: toStr(row.author_name),
    status: toStr(row.status, '草稿'),
    doneNote: toStr(row.done_note),
    planItems: Array.isArray(planItems) ? planItems.map(String) : [],
    resourceNote: toStr(row.resource_note),
    tasks: tasks.map(taskRowToApi),
    risks: risks.map(riskRowToApi),
    snapshot: parseJson(row.snapshot, null),
    submittedAt: row.submitted_at === null || row.submitted_at === undefined
      ? null
      : String(row.submitted_at),
    // B14 块2：轻量闭环三列（NULL → null；语义见 migrationV7）
    confirmedBy: row.confirmed_by === null || row.confirmed_by === undefined
      ? null
      : String(row.confirmed_by),
    confirmedAt: row.confirmed_at === null || row.confirmed_at === undefined
      ? null
      : String(row.confirmed_at),
    rejectReason: row.reject_reason === null || row.reject_reason === undefined
      ? null
      : String(row.reject_reason),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  };
}

/* ── 子行批量加载 ───────────────────────────────────── */

/**
 * 按 reportId 批量加载任务行 / 风险行，返回按 report_id 分组的 map。
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} reportIds 周报 id 列表
 * @returns {{tasks: Object<string, object[]>, risks: Object<string, object[]>}}
 */
function loadChildren(db, reportIds) {
  /** @type {Object<string, object[]>} */
  const tasks = {};
  /** @type {Object<string, object[]>} */
  const risks = {};
  if (!reportIds.length) return { tasks: tasks, risks: risks };

  const ph = placeholders(reportIds.length);

  db.prepare('SELECT * FROM work_report_tasks WHERE report_id IN (' + ph + ') ORDER BY rowid')
    .all(reportIds)
    .forEach(function (r) {
      const key = String(r.report_id);
      if (!tasks[key]) tasks[key] = [];
      tasks[key].push(r);
    });

  db.prepare('SELECT * FROM work_report_risks WHERE report_id IN (' + ph + ') ORDER BY seq')
    .all(reportIds)
    .forEach(function (r) {
      const key = String(r.report_id);
      if (!risks[key]) risks[key] = [];
      risks[key].push(r);
    });

  return { tasks: tasks, risks: risks };
}

/**
 * 按 id 组装单条完整周报（含子行）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} reportId
 * @returns {?object} Report，不存在返回 null
 */
function assembleById(db, reportId) {
  const row = db.prepare('SELECT * FROM work_reports WHERE id = ?').get(String(reportId));
  if (!row) return null;
  const children = loadChildren(db, [String(reportId)]);
  return rowToApiReport(row, children.tasks[String(reportId)], children.risks[String(reportId)]);
}

/* ── 读 ─────────────────────────────────────────────── */

/**
 * 列出项目下全部周报（含历史多次提交，默认填报时间倒序）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {object[]} Report[]
 */
function listReports(db, projectId) {
  const rows = db
    .prepare('SELECT * FROM work_reports WHERE project_id = ? ORDER BY created_at DESC')
    .all(String(projectId));
  if (!rows.length) return [];

  const idList = rows.map(function (r) { return String(r.id); });
  const children = loadChildren(db, idList);

  return rows.map(function (r) {
    const key = String(r.id);
    return rowToApiReport(r, children.tasks[key], children.risks[key]);
  });
}

/**
 * 取指定周次的周报（同周可多次提交 → 返回**最新一条**，偏差 D-3）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {string} week 周编码 `'YYYY-Www'`
 * @returns {?object} Report，无则 null
 */
function getReport(db, projectId, week) {
  const row = db
    .prepare(
      'SELECT * FROM work_reports WHERE project_id = ? AND week = ? ORDER BY created_at DESC LIMIT 1'
    )
    .get(String(projectId), String(week));
  if (!row) return null;

  const key = String(row.id);
  const children = loadChildren(db, [key]);
  return rowToApiReport(row, children.tasks[key], children.risks[key]);
}

/* ── 工时统计报表（B9 · 只读聚合） ─────────────────── */

/**
 * 构造估算索引：父估算 = Σ 子树**叶子** estimateDays（读时算、不落库，与 decorateEffort 同构）。
 *
 * B9 决策 D-B9-3 / 共享约定 B9-3：父节点行的估算仅用于报表行级比较
 * （与 effortHours 的 Σ 对称），报表汇总口径仍是 Σ 叶子（B9-1）。
 * 递归深度守卫 ≤64：脏数据成环时兜底，不爆栈。
 *
 * @param {Object<string, object[]>} childrenMap parentId → 直接子节点数组（'__root__' = 根层）
 * @param {Map<string, object>} byId nodeId → 节点（API 形态）
 * @returns {{isLeaf: (node: object) => boolean, estimateOf: (nodeId: string, guard?: number) => number}}
 */
function buildEstimateIndex(childrenMap, byId) {
  const memo = new Map();
  const isLeaf = function (node) {
    return !(childrenMap.get(String(node.id)) || []).length;
  };
  const estimateOf = function (nodeId, guard) {
    if (guard > 64) return 0; // 防御性：脏数据成环时兜底
    if (memo.has(String(nodeId))) return memo.get(String(nodeId));
    const node = byId.get(String(nodeId));
    if (!node) return 0;
    const kids = childrenMap.get(String(nodeId)) || [];
    let v;
    if (kids.length) {
      v = kids.reduce(function (s, k) {
        return s + estimateOf(k.id, (guard || 0) + 1);
      }, 0);
    } else {
      v = Number(node.estimateDays) || 0;
    }
    memo.set(String(nodeId), v);
    return v;
  };
  return { isLeaf: isLeaf, estimateOf: estimateOf };
}

/**
 * 全节点扁平 → 报表明细行（父=容器汇总行、叶=任务行）。
 *
 * 每行输出 B9 §3 `EffortReportRow` 全字段；`effortHours` 直接复用
 * `wbsService.loadNodes`（decorateEffort）的装饰值：叶=累计存储、父=Σ直接子（已递归）。
 * `diffRate` 估算为 0 → null（前端「—」、排序置底）；超支判定独立于偏差率
 * （actual > estimate 即超支，估 0 且实 > 0 也计）。
 *
 * @param {object[]} nodes 同项目全部节点（decorateEffort 出参，compareWbsCode 树序）
 * @param {Object<string, object[]>} childrenMap
 * @param {{isLeaf: Function, estimateOf: Function}} estimateIndex
 * @param {Map<string, object>} milestoneMap milestoneId → {id, code, name}
 * @returns {object[]} EffortReportRow[]
 */
function buildEffortRows(nodes, childrenMap, estimateIndex, milestoneMap) {
  return nodes.map(function (n) {
    const isLeaf = estimateIndex.isLeaf(n);
    const estimateDays = estimateIndex.estimateOf(n.id, 0);
    const effortHours = Number(n.effortHours) || 0;
    const diff = effortHours - estimateDays;
    const diffRate = estimateDays > 0 ? effortHours / estimateDays - 1 : null;
    const ms = n.milestoneId ? milestoneMap.get(String(n.milestoneId)) : null;
    const milestoneId =
      n.milestoneId === null || n.milestoneId === undefined || n.milestoneId === ''
        ? null
        : String(n.milestoneId);
    return {
      id: toStr(n.id),
      parentId: n.parentId === null || n.parentId === undefined ? null : toStr(n.parentId),
      wbsCode: toStr(n.wbsCode),
      level: Number(n.level) || 1,
      nodeType: toStr(n.nodeType, 'task'),
      name: toStr(n.name),
      owner: toStr(n.owner),
      ownerName: toStr(n.ownerName),
      estimateDays: estimateDays,
      effortHours: effortHours,
      effortChildCount: Number(n.effortChildCount) || 0,
      diff: diff,
      diffRate: diffRate,
      isOverrun: effortHours > estimateDays,
      progress: Number(n.progress) || 0,
      status: toStr(n.status, '待办'),
      isLeaf: isLeaf,
      milestoneId: milestoneId,
      milestoneCode: ms ? toStr(ms.code) : '',
      milestoneName: ms ? toStr(ms.name) : '',
    };
  });
}

/**
 * 汇总卡片口径（共享约定 B9-1）：一律只算**叶子**（SK-4 = 无子节点）。
 * 偏差率 = Σ实际/Σ估算 − 1，估算总和 0 → null；超支计数 = 叶子中实际 > 估算 的行数。
 * @param {object[]} nodes 同项目全部节点（decorateEffort 出参）
 * @param {{isLeaf: Function}} estimateIndex
 * @returns {object} EffortSummary
 */
function buildEffortSummary(nodes, estimateIndex) {
  const leaves = nodes.filter(estimateIndex.isLeaf);
  const estimateTotal = leaves.reduce(function (s, n) {
    return s + (Number(n.estimateDays) || 0);
  }, 0);
  const actualTotal = leaves.reduce(function (s, n) {
    return s + (Number(n.effortHours) || 0);
  }, 0);
  return {
    estimateTotal: estimateTotal,
    actualTotal: actualTotal,
    diff: actualTotal - estimateTotal,
    diffRate: estimateTotal > 0 ? actualTotal / estimateTotal - 1 : null,
    overrunCount: leaves.filter(function (n) {
      return (Number(n.effortHours) || 0) > (Number(n.estimateDays) || 0);
    }).length,
    leafCount: leaves.length,
    parentCount: nodes.length - leaves.length,
  };
}

/**
 * 实际工时构成明细（B9 R4）：nodeId → 已提交周报贡献行（周倒序）。
 *
 * 1 条 join SQL 聚合：仅 `work_reports.status='已提交'` 且 `selected=1` 且
 * `week_actual_days > 0` 的行（草稿不累计不展示；selected=1 为防脏数据双保险）。
 * JS 按 nodeId 分组为 `Record<string, EffortBreakdownItem[]>`；无贡献的节点不出现 key。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {Object<string, object[]>}
 */
function buildEffortBreakdown(db, projectId) {
  const rows = db
    .prepare(
      'SELECT t.node_id AS nodeId,' +
        '       r.week AS week,' +
        '       r.author_name AS reporterName,' +
        '       r.submitted_at AS submittedAt,' +
        '       t.week_actual_days AS weekActualDays' +
        '  FROM work_report_tasks t' +
        '  JOIN work_reports r ON r.id = t.report_id' +
        ' WHERE r.project_id = ?' +
        "   AND r.status = '已提交'" +
        '   AND t.selected = 1' +
        '   AND t.week_actual_days > 0' +
        ' ORDER BY r.week DESC, r.submitted_at ASC'
    )
    .all(String(projectId));
  const out = {};
  rows.forEach(function (row) {
    const key = String(row.nodeId);
    if (!out[key]) out[key] = [];
    out[key].push({
      week: toStr(row.week),
      reporterName: toStr(row.reporterName),
      submittedAt:
        row.submittedAt === null || row.submittedAt === undefined
          ? null
          : String(row.submittedAt),
      weekActualDays: Number(row.weekActualDays) || 0,
    });
  });
  return out;
}

/**
 * B9（R2/R3/R4）：工时统计报表 —— 只读聚合接口，纯读侧扩展，无迁移 / 无写通道改动。
 *
 * 行 / 汇总复用 `wbsService.loadNodes`（decorateEffort 出参：effortHours / effortChildCount /
 * estimateDays / progress / ownerName / milestoneId），仅「实际工时构成」走 1 条 join SQL；
 * 父估算 = Σ 子树叶子（读时算、不落库）。无节点项目返回空结构不抛错。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {{projectId: string, summary: object, rows: object[], effortBreakdown: Object<string, object[]>}} EffortReport
 */
function getEffortReport(db, projectId) {
  const pid = String(projectId || '');
  const nodes = wbsService.loadNodes(db, pid);
  if (!nodes.length) {
    return {
      projectId: pid,
      summary: {
        estimateTotal: 0,
        actualTotal: 0,
        diff: 0,
        diffRate: null,
        overrunCount: 0,
        leafCount: 0,
        parentCount: 0,
      },
      rows: [],
      effortBreakdown: {},
    };
  }

  /* parentId → 直接子数组（'__root__' = 根层），叶子判定唯一入口 */
  const childrenMap = new Map();
  const byId = new Map();
  nodes.forEach(function (n) {
    byId.set(String(n.id), n);
    const key = n.parentId === null || n.parentId === undefined ? '__root__' : String(n.parentId);
    const arr = childrenMap.get(key);
    if (arr) arr.push(n);
    else childrenMap.set(key, [n]);
  });

  /* 里程碑 badge 一次查表带 code/name（前端零状态、零额外请求，D-B9-3 补充4） */
  const milestoneMap = new Map();
  db.prepare('SELECT id, code, name FROM milestones WHERE project_id = ?')
    .all(pid)
    .forEach(function (m) { milestoneMap.set(String(m.id), m); });

  const estimateIndex = buildEstimateIndex(childrenMap, byId);
  const rows = buildEffortRows(nodes, childrenMap, estimateIndex, milestoneMap);
  const summary = buildEffortSummary(nodes, estimateIndex);
  const effortBreakdown = buildEffortBreakdown(db, pid);

  /* 数值保留原始浮点，前端统一 toFixed(1) 展示（共享约定 B9-8） */
  return { projectId: pid, summary: summary, rows: rows, effortBreakdown: effortBreakdown };
}

/* ── 写 ─────────────────────────────────────────────── */

/**
 * 归一化 payload 的任务引用列表，并补齐 WBS 节点快照字段。
 *
 * D-6 数据隔离：解析到的 `wbs_nodes` 行必须属于报告所属项目（`projectId`，
 * 由服务端上下文/路径参数传入），跨项目引用一律显式抛 `E_VALIDATION`，
 * 禁止把进度回写到其他项目的 WBS 节点上。不存在的 nodeId 仍按空壳处理
 * （对齐 N4：不崩、快照字段为空），仅对「存在但属于别的项目」的节点报错。
 *
 * B8（R5）防绕过：`actualDays` 缺失视为 0；携带时校验 `0 ≤ v ≤ WEEK_ACTUAL_DAYS_MAX`
 * 且 ≤2 位小数（非法 → E_VALIDATION，message 含「人日」口径）；**未勾选携带** /
 * **非叶子（有子节点）携带** → E_VALIDATION（save 与 submit 同样执行，结构性非法草稿也不该产生）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} rawTasks payload.tasks（`{nodeId, progressAfter, selected, actualDays?}`）
 * @param {string} projectId 报告所属项目 id（服务端真源，勿用请求体可伪造字段）
 * @returns {{nodeId: string, nodeCode: string, nodeName: string, progressBefore: number,
 *            progressAfter: number, selected: boolean, estimateDays: number,
 *            actualDays: number, isLeaf: boolean}[]}
 * @throws {AppError} `E_VALIDATION` 引用的 WBS 节点不属于本项目 / actualDays 非法 / 未勾选或非叶子携带 actualDays
 */
function resolveTaskRefs(db, rawTasks, projectId) {
  const list = Array.isArray(rawTasks) ? rawTasks : [];
  const selNode = db.prepare('SELECT * FROM wbs_nodes WHERE id = ?');
  const countChildren = db.prepare('SELECT COUNT(*) AS c FROM wbs_nodes WHERE parent_id = ?');
  const ownerProjectId = toStr(projectId);

  return list.map(function (t) {
    const ref = t || {};
    const nodeId = toStr(ref.nodeId);
    const node = nodeId ? selNode.get(nodeId) : null;

    /* D-6 数据隔离：已存在的节点必须属于报告所属项目，跨项目引用一律拒绝 */
    if (node && toStr(node.project_id) !== ownerProjectId) {
      throw new AppError(
        ErrorCode.E_VALIDATION,
        '周报引用的 WBS 节点 ' + nodeId + ' 不属于当前项目，禁止跨项目引用',
        {
          nodeId: nodeId,
          nodeProjectId: toStr(node.project_id),
          projectId: ownerProjectId,
        },
      );
    }

    const selected = ref.selected === true || ref.selected === 1;
    /* B8（R5）：叶子口径 SK-4 = 无子节点；节点不存在按叶子处理（不崩） */
    const childCount = nodeId ? (countChildren.get(nodeId).c || 0) : 0;
    const isLeaf = childCount === 0;

    /* B8（R5）：actualDays 校验 —— 缺失视为 0；携带时 0~100 / ≤2 位小数 */
    let actualDays = 0;
    if (ref.actualDays !== undefined) {
      const v = Number(ref.actualDays);
      if (
        !Number.isFinite(v) ||
        v < 0 ||
        v > enums.WEEK_ACTUAL_DAYS_MAX ||
        Math.round(v * 100) / 100 !== v
      ) {
        throw new AppError(
          ErrorCode.E_VALIDATION,
          '本周实际工时（人日）须为 0~' + enums.WEEK_ACTUAL_DAYS_MAX + ' 的数字，最多 2 位小数',
          { nodeId: nodeId, fields: { actualDays: '非法取值' } },
        );
      }
      actualDays = v;
    }
    if (!selected && ref.actualDays !== undefined) {
      throw new AppError(
        ErrorCode.E_VALIDATION,
        '未勾选的任务不能登记本周实际工时（人日）',
        { nodeId: nodeId, actualDays: ref.actualDays },
      );
    }
    if (!isLeaf && ref.actualDays !== undefined) {
      throw new AppError(
        ErrorCode.E_VALIDATION,
        '父节点不可登记本周实际工时（人日），请在具体子任务上登记',
        { nodeId: nodeId },
      );
    }

    return {
      nodeId: nodeId,
      nodeCode: node ? toStr(node.wbs_code) : '',
      nodeName: node ? toStr(node.name) : '',
      progressBefore: node ? toProgress(node.progress) : 0,
      progressAfter: toProgress(ref.progressAfter),
      selected: selected,
      estimateDays: node ? Number(node.estimate_days) || 0 : 0,
      actualDays: actualDays,
      isLeaf: isLeaf,
    };
  });
}

/**
 * 归一化 payload 的风险列表。
 * @param {object[]} rawRisks payload.risks
 * @returns {{description: string, owner: string, dueDate: string}[]}
 */
function resolveRiskRefs(rawRisks) {
  const list = Array.isArray(rawRisks) ? rawRisks : [];
  return list.map(function (r) {
    const row = r || {};
    return {
      description: toStr(row.description),
      owner: toStr(row.owner),
      dueDate: toStr(row.dueDate),
    };
  });
}

/**
 * 写入某条周报的任务 / 风险子行（调用方负责先清空旧行）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} reportId
 * @param {object[]} taskRefs `resolveTaskRefs` 结果
 * @param {object[]} riskRefs `resolveRiskRefs` 结果
 * @returns {void}
 */
function insertChildren(db, reportId, taskRefs, riskRefs) {
  const insTask = db.prepare(`
    INSERT INTO work_report_tasks (
      id, report_id, node_id, node_code, node_name, progress_before, progress_after, selected, week_actual_days
    ) VALUES (@id, @report_id, @node_id, @node_code, @node_name, @progress_before, @progress_after, @selected, @week_actual_days)
  `);
  const insRisk = db.prepare(`
    INSERT INTO work_report_risks (
      id, report_id, seq, description, owner, due_date, promoted_risk_id
    ) VALUES (@id, @report_id, @seq, @description, @owner, @due_date, NULL)
  `);

  taskRefs.forEach(function (t, i) {
    insTask.run({
      id: reportId + '-TK' + (i + 1),
      report_id: reportId,
      node_id: t.nodeId || null,
      node_code: t.nodeCode,
      node_name: t.nodeName,
      progress_before: t.progressBefore,
      progress_after: t.progressAfter,
      selected: t.selected ? 1 : 0,
      // B8（R3）：本周实际人日；草稿行也落库（不累计）
      week_actual_days: Number(t.actualDays) || 0,
    });
  });

  riskRefs.forEach(function (r, i) {
    insRisk.run({
      id: reportId + '-RK' + (i + 1),
      report_id: reportId,
      seq: i + 1,
      description: r.description,
      owner: r.owner,
      due_date: r.dueDate,
    });
  });
}

/**
 * B8（R3/R4）：累计实际工时（人日）增量写入 —— 累加与冲正唯一入口（私有，不导出）。
 *
 * 一切累计变更在日志事务内经本函数完成，保证原子性：
 *  1. `delta === 0` → 直接返回（不写库、不碰 updated_at）；
 *  2. 节点不存在 → 静默返回（节点已删，其累计随行消亡，冲正无意义）；
 *  3. `next = COALESCE(effort_hours, 0) + delta`（兼容历史 NULL）；
 *  4. `next < 0 || next > EFFORT_DAYS_CUM_MAX` → `E_VALIDATION`（message 含人日口径；
 *     冲正扣过头 / 溢出均整体回滚，不产生半更新）；
 *  5. `UPDATE wbs_nodes SET effort_hours = ?, updated_at = ?`。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} nodeId 节点 id（空串直接跳过）
 * @param {number} delta 增量（正=累加，负=扣减）
 * @param {string} ts 事务时间戳
 * @returns {void}
 * @throws {AppError} `E_VALIDATION` 新累计超出 [0, EFFORT_DAYS_CUM_MAX]
 */
function applyEffortDelta(db, nodeId, delta, ts) {
  if (!nodeId) return;
  const d = Number(delta) || 0;
  if (d === 0) return;
  const row = db.prepare('SELECT effort_hours FROM wbs_nodes WHERE id = ?').get(String(nodeId));
  if (!row) return; // 节点已删，静默跳过
  const next = (Number(row.effort_hours) || 0) + d;
  if (next < 0 || next > enums.EFFORT_DAYS_CUM_MAX) {
    throw new AppError(
      ErrorCode.E_VALIDATION,
      '累计实际工时（人日）须为 0~' + enums.EFFORT_DAYS_CUM_MAX + '，当前操作将超出该范围',
      { nodeId: String(nodeId), delta: d, next: next },
    );
  }
  db.prepare('UPDATE wbs_nodes SET effort_hours = ?, updated_at = ? WHERE id = ?').run(next, ts, String(nodeId));
}

/**
 * 新建周报（暂存或提交）。
 *
 * 同周允许多次提交（不做周次查重，用户反馈⑤）：每次调用均新建一条。
 *
 * `submit=true` 时按共享约定 §6 触发（`snapshot` 在事务前已构建、随 insReport 落库）：
 *  ① 仅 `selected` 的任务回写 `wbs_nodes.progress` / `actual_days`；
 *  ② **B8**：`selected` 任务按 `actualDays` 累加 `wbs_nodes.effort_hours`（草稿不累加）；
 *  ③ `syncWbsProgressStatus` → `refreshMilestoneStatuses`（引擎收尾次序恒定）；
 *  ④ 写 `entity_type='report'` 审计（事务外，吞异常）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} payload ReportPayload（`projectId/week/doneNote/planItems/resourceNote/tasks/risks`）
 * @param {object} me 当前用户 users 行（`requireAuth` 注入的 `req.user`）
 * @param {boolean} submit 是否提交（false = 存草稿）
 * @returns {object} Report
 * @throws {AppError} `E_VALIDATION` 缺 projectId/week；`E_REPORT_RISK_INCOMPLETE` 提交强校验未过
 */
function createReport(db, payload, me, submit) {
  const p = payload || {};
  const actor = me || {};
  const isSubmit = submit === true;

  const projectId = toStr(p.projectId).trim();
  const week = toStr(p.week).trim();
  if (!projectId) {
    throw new AppError(ErrorCode.E_VALIDATION, undefined, {
      fields: [{ field: 'projectId', message: '缺少项目 id' }],
    });
  }
  if (!week) {
    throw new AppError(ErrorCode.E_VALIDATION, undefined, {
      fields: [{ field: 'week', message: '缺少周次（YYYY-Www）' }],
    });
  }

  /* 提交才跑强校验；存草稿允许残缺（对齐 Mock / 前端「存草稿」语义） */
  if (isSubmit) {
    const v = validateReportPayload(p);
    if (!v.ok) {
      throw new AppError(ErrorCode.E_REPORT_RISK_INCOMPLETE, v.messages.join('；'), {
        invalidRiskRows: v.invalidRiskRows,
        messages: v.messages,
      });
    }
  }

  const range = dates.weekRange(week);
  const reportId = ids.genId('RP');
  const ts = dates.nowIso();
  const status = isSubmit ? '已提交' : '草稿';

  const taskRefs = resolveTaskRefs(db, p.tasks, projectId);
  const riskRefs = resolveRiskRefs(p.risks);
  const planItems = (Array.isArray(p.planItems) ? p.planItems : [])
    .map(function (x) { return toStr(x); })
    .filter(function (x) { return x.trim(); });

  /* 仅 selected 的任务参与进度回写与快照冻结 */
  const applied = taskRefs.filter(function (t) { return t.selected && t.nodeId; });
  /** @type {Object<string, number>} */
  const snapshot = {};
  applied.forEach(function (t) { snapshot[t.nodeId] = t.progressAfter; });

  const insReport = db.prepare(`
    INSERT INTO work_reports (
      id, project_id, week, week_start, week_end, author_open_id, author_name,
      status, done_note, plan_items, resource_note, snapshot, submitted_at,
      created_at, updated_at
    ) VALUES (
      @id, @project_id, @week, @week_start, @week_end, @author_open_id, @author_name,
      @status, @done_note, @plan_items, @resource_note, @snapshot, @submitted_at,
      @created_at, @updated_at
    )
  `);
  const updNodeProgress = db.prepare(
    'UPDATE wbs_nodes SET progress = @progress, actual_days = @actual_days, updated_at = @ts WHERE id = @id'
  );

  const tx = db.transaction(function () {
    insReport.run({
      id: reportId,
      project_id: projectId,
      week: week,
      week_start: range.start,
      week_end: range.end,
      author_open_id: toStr(actor.open_id),
      author_name: toStr(actor.name),
      status: status,
      done_note: toStr(p.doneNote),
      plan_items: JSON.stringify(planItems),
      resource_note: toStr(p.resourceNote),
      snapshot: isSubmit ? JSON.stringify(snapshot) : null,
      submitted_at: isSubmit ? ts : null,
      created_at: ts,
      updated_at: ts,
    });

    insertChildren(db, reportId, taskRefs, riskRefs);

    if (isSubmit) {
      /* ① 回写勾选任务的进度与实际工时 */
      applied.forEach(function (t) {
        updNodeProgress.run({
          id: t.nodeId,
          progress: t.progressAfter,
          actual_days: Number(((t.estimateDays * t.progressAfter) / 100).toFixed(1)),
          ts: ts,
        });
      });

      /* ② B8（R3）：提交日志 → 累加实际工时（人日）到节点（草稿不累加；0 为 no-op）。
           插入点：进度回写之后、引擎收尾之前 —— 与 ① 不同列、次序无关，引擎收尾次序不破坏 */
      applied.forEach(function (t) {
        applyEffortDelta(db, t.nodeId, t.actualDays, ts);
      });

      /* ③ 进度 → 状态自动流转统一收口（父节点加权回写 + 状态收敛） */
      wbsService.syncWbsProgressStatus(db, projectId);
      /* ④ 联动刷新里程碑 taskStats / 状态（次序：WBS 先，里程碑后） */
      milestoneService.refreshMilestoneStatuses(db, projectId);
    }
  });

  tx();

  /* D03：周报提交 → 全量真叶子任务快照（事务外 + try/catch 隔离：快照失败只丢环比，不阻塞提交） */
  if (isSubmit) {
    try {
      snapshotService.captureProjectTaskSnapshot(db, projectId, week, reportId);
    } catch (e) {
      // 快照失败仅影响环比积累，周报本体已落库（与审计「绝不回滚业务」同一哲学）
    }
  }

  /* ④ 审计写在事务外：writeAudit 内部吞异常，绝不回滚业务（lib/audit.js 铁律） */
  if (isSubmit) {
    writeAudit(
      db,
      actor,
      'report',
      reportId,
      'create',
      projectId,
      '提交 ' + week + ' 周报，冻结 ' + applied.length + ' 条任务进度快照',
      [{ field: 'status', label: '周报状态', before: '草稿', after: '已提交' }],
    );
  }

  return assembleById(db, reportId);
}

/**
 * 编辑已有周报（按 id 原地更新）。
 *
 * 仅更新正文与子行；**不改 status、不回写进度、不冻结快照、不写审计**（共享约定 §6）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id 周报 id
 * @param {object} payload ReportPayload
 * @param {object} me 当前用户 users 行
 * @returns {object} Report
 * @throws {AppError} `E_NOT_FOUND` 周报不存在；`E_FORBIDDEN` 非作者本人且非 admin（偏差 D-2）
 */
function updateReport(db, id, payload, me) {
  const reportId = toStr(id).trim();
  const p = payload || {};
  const actor = me || {};

  const row = db.prepare('SELECT * FROM work_reports WHERE id = ?').get(reportId);
  if (!row) {
    throw new AppError(ErrorCode.E_NOT_FOUND, '周报不存在或已被删除', { id: reportId });
  }

  /* D-2 安全加固：仅作者本人或全局 admin 可编辑，防止越权改他人工作日志 */
  const isAuthor = toStr(row.author_open_id) === toStr(actor.open_id);
  const isAdmin = toStr(actor.global_role) === 'admin';
  if (!isAuthor && !isAdmin) {
    throw new AppError(ErrorCode.E_FORBIDDEN, '只能编辑本人提交的工作日志', { id: reportId });
  }

  /* B8（R4）：冲正开关 —— 已提交日志编辑才先扣旧后加新；草稿编辑不触累计 */
  const wasSubmitted = toStr(row.status) === '已提交';
  /* 旧行在 delTasks 之前读出（week_actual_days 是冲正数据源） */
  const oldTaskRows = db
    .prepare('SELECT * FROM work_report_tasks WHERE report_id = ?')
    .all(reportId);

  const ts = dates.nowIso();
  /* 编辑路径同样执行 D-6 校验：以库内 work_reports 行的 project_id 为真源 */
  const taskRefs = resolveTaskRefs(db, p.tasks, toStr(row.project_id));
  const riskRefs = resolveRiskRefs(p.risks);
  const planItems = (Array.isArray(p.planItems) ? p.planItems : [])
    .map(function (x) { return toStr(x); })
    .filter(function (x) { return x.trim(); });

  const updReport = db.prepare(`
    UPDATE work_reports
       SET done_note = @done_note,
           plan_items = @plan_items,
           resource_note = @resource_note,
           updated_at = @updated_at
     WHERE id = @id
  `);
  const delTasks = db.prepare('DELETE FROM work_report_tasks WHERE report_id = ?');
  const delRisks = db.prepare('DELETE FROM work_report_risks WHERE report_id = ?');

  const tx = db.transaction(function () {
    /* B8（R4）：已提交日志先扣旧后加新（同事务，任一失败整体回滚）；净效果 = 每节点 new - old。
       插入点：正文/子行重建之前 —— 冲正失败不产生半更新，编辑周次/正文/风险不影响累计 */
    if (wasSubmitted) {
      oldTaskRows.forEach(function (t) {
        applyEffortDelta(db, toStr(t.node_id), -(Number(t.week_actual_days) || 0), ts);
      });
      taskRefs
        .filter(function (t) { return t.selected && t.nodeId; })
        .forEach(function (t) {
          applyEffortDelta(db, t.nodeId, t.actualDays, ts);
        });
    }

    updReport.run({
      id: reportId,
      done_note: toStr(p.doneNote),
      plan_items: JSON.stringify(planItems),
      resource_note: toStr(p.resourceNote),
      updated_at: ts,
    });
    delTasks.run(reportId);
    delRisks.run(reportId);
    insertChildren(db, reportId, taskRefs, riskRefs);
  });

  tx();

  return assembleById(db, reportId);
}

/* ═══════════════════════════════════════════════════
 * B14 块2 · 周报轻量闭环（草稿 → 已提交 → 已确认）
 *
 * 确认人解析权威实现（架构 §1.3）：
 *   - 权威角色源 = `project_members(project_role='pm')`，**绝不读脏列 `projects.pm`**；
 *   - 作者 ∈ pm 集合 或 项目无 pm → 升级到 `project_members(project_role='tl')` ∪
 *     `users(global_role='admin')`（作者本人始终被排除，天然禁止自确认）；
 *   - 多 pm 取并集（任一可确认）。
 * 状态机仅由 `confirmReport` / `rejectReport` 驱动，前端不得直改 status。
 * ═══════════════════════════════════════════════════ */

/**
 * 解析某条周报的「可确认人」集合（架构 §1.3 权威算法）。
 *
 * ⚠ 数据源纪律：只读结构化的 `project_members` 与 `users`，
 *   **不读** `projects.pm`（历史脏值，形如 `dev_徐文斌`，不可信）。
 * ⚠ 作者本人一律从结果里剔除（作者不能确认/打回自己的周报）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId 项目 id
 * @param {string} authorOpenId 周报作者 openId
 * @returns {Set<string>} 可确认人 openId 集合（已排除作者本人）
 */
function resolveConfirmers(db, projectId, authorOpenId) {
  const pid = toStr(projectId).trim();
  const author = toStr(authorOpenId).trim();
  const result = new Set();
  if (!pid) return result;

  /* 1. 权威 pm 集合（结构化角色源） */
  const pmRows = db
    .prepare(
      "SELECT user_open_id FROM project_members WHERE project_id = ? AND project_role = 'pm'"
    )
    .all(pid);
  const pmSet = new Set(pmRows.map(function (r) { return toStr(r.user_open_id); }).filter(Boolean));

  /* 2. 作者即 pm（或项目无 pm）→ 升级到 tl ∪ admin 兜底；否则确认人 = pm 集合 */
  const authorIsPm = author && pmSet.has(author);
  if (authorIsPm || pmSet.size === 0) {
    const tlRows = db
      .prepare(
        "SELECT user_open_id FROM project_members WHERE project_id = ? AND project_role = 'tl'"
      )
      .all(pid);
    tlRows.forEach(function (r) {
      const v = toStr(r.user_open_id);
      if (v) result.add(v);
    });
    const adminRows = db
      .prepare("SELECT open_id FROM users WHERE global_role = 'admin'")
      .all();
    adminRows.forEach(function (r) {
      const v = toStr(r.open_id);
      if (v) result.add(v);
    });
  } else {
    pmSet.forEach(function (v) { result.add(v); });
  }

  /* 3. 作者本人恒排除（禁止自确认） */
  if (author) result.delete(author);
  return result;
}

/**
 * 确认周报：`已提交` → `已确认`，写 `confirmed_by` / `confirmed_at`。
 *
 * 前置校验（顺序恒定，fail-fast）：
 *  1. 周报存在（否则 404）；
 *  2. 当前状态必须是 `已提交`（否则 409 状态冲突，用 `E_VALIDATION` 带说明）；
 *  3. `me.open_id ∈ resolveConfirmers(...)`（否则 403，作者天然被排除）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id 周报 id
 * @param {object} me 当前用户 users 行（`req.user`）
 * @returns {object} Report（确认后）
 * @throws {AppError} E_NOT_FOUND / E_VALIDATION / E_FORBIDDEN
 */
function confirmReport(db, id, me) {
  const reportId = toStr(id).trim();
  const actor = me || {};
  const meOpenId = toStr(actor.open_id);

  const tx = db.transaction(function () {
    const row = db.prepare('SELECT * FROM work_reports WHERE id = ?').get(reportId);
    if (!row) {
      throw new AppError(ErrorCode.E_NOT_FOUND, '周报不存在或已被删除', { id: reportId });
    }
    if (toStr(row.status) !== '已提交') {
      throw new AppError(
        ErrorCode.E_VALIDATION,
        '仅「已提交」的周报可确认，当前状态为「' + toStr(row.status, '草稿') + '」',
        { id: reportId, status: toStr(row.status) }
      );
    }

    const confirmers = resolveConfirmers(db, toStr(row.project_id), toStr(row.author_open_id));
    if (!meOpenId || !confirmers.has(meOpenId)) {
      throw new AppError(ErrorCode.E_FORBIDDEN, '您不是该周报的确认人', { id: reportId });
    }

    const ts = dates.nowIso();
    db.prepare(
      'UPDATE work_reports SET status = ?, confirmed_by = ?, confirmed_at = ?, reject_reason = NULL, updated_at = ? WHERE id = ?'
    ).run('已确认', meOpenId, ts, ts, reportId);

    writeAudit(
      db, actor, 'report', reportId, 'update', toStr(row.project_id),
      '确认 ' + toStr(row.week) + ' 周报',
      [{ field: 'status', label: '周报状态', before: '已提交', after: '已确认' }]
    );
  });
  tx();

  return assembleById(db, reportId);
}

/**
 * 打回周报：`已提交` → `草稿`，写 `reject_reason`（必填），清空 confirmed_* 。
 *
 * 前置校验（顺序恒定，fail-fast）：
 *  1. `reason` 非空（否则 400 `E_VALIDATION`，架构 §5 结论 #2 必填）；
 *  2. 周报存在（否则 404）；
 *  3. 当前状态必须是 `已提交`（否则 409）；
 *  4. `me.open_id ∈ resolveConfirmers(...)`（否则 403）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id 周报 id
 * @param {string} reason 打回原因（必填，去空白后非空）
 * @param {object} me 当前用户 users 行
 * @returns {object} Report（打回后，回到草稿）
 * @throws {AppError} E_VALIDATION / E_NOT_FOUND / E_FORBIDDEN
 */
function rejectReport(db, id, reason, me) {
  const reportId = toStr(id).trim();
  const rejectReason = toStr(reason).trim();
  const actor = me || {};
  const meOpenId = toStr(actor.open_id);

  /* 先做无副作用的入参校验，避免打开事务 */
  if (!rejectReason) {
    throw new AppError(ErrorCode.E_VALIDATION, '打回必须填写原因', {
      fields: [{ field: 'reason', message: '打回原因必填' }],
    });
  }

  const tx = db.transaction(function () {
    const row = db.prepare('SELECT * FROM work_reports WHERE id = ?').get(reportId);
    if (!row) {
      throw new AppError(ErrorCode.E_NOT_FOUND, '周报不存在或已被删除', { id: reportId });
    }
    if (toStr(row.status) !== '已提交') {
      throw new AppError(
        ErrorCode.E_VALIDATION,
        '仅「已提交」的周报可打回，当前状态为「' + toStr(row.status, '草稿') + '」',
        { id: reportId, status: toStr(row.status) }
      );
    }

    const confirmers = resolveConfirmers(db, toStr(row.project_id), toStr(row.author_open_id));
    if (!meOpenId || !confirmers.has(meOpenId)) {
      throw new AppError(ErrorCode.E_FORBIDDEN, '您不是该周报的确认人', { id: reportId });
    }

    const ts = dates.nowIso();
    /* 打回回到「草稿」，作者可修改后重新提交；清 confirmed_*，保留 reject_reason 供作者查看 */
    db.prepare(
      'UPDATE work_reports SET status = ?, reject_reason = ?, confirmed_by = NULL, confirmed_at = NULL, updated_at = ? WHERE id = ?'
    ).run('草稿', rejectReason, ts, reportId);

    writeAudit(
      db, actor, 'report', reportId, 'update', toStr(row.project_id),
      '打回 ' + toStr(row.week) + ' 周报：' + rejectReason,
      [{ field: 'status', label: '周报状态', before: '已提交', after: '草稿' }]
    );
  });
  tx();

  return assembleById(db, reportId);
}

/**
 * 列出「待当前用户确认」的周报（B14 块2 唯一新增服务端查询，架构 §5 结论 #8）。
 *
 * 服务端逐条 `resolveConfirmers` 过滤：仅返回 `status='已提交'` 且
 * `userOpenId ∈ resolveConfirmers(projectId, author)` 的周报（含完整子行）。
 * 由服务端过滤保证「确认人解析」单一真源，前端不重复实现。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} userOpenId 当前用户 openId
 * @returns {object[]} Report[]（按 submitted_at 倒序）
 */
function listPendingConfirmation(db, userOpenId) {
  const meOpenId = toStr(userOpenId).trim();
  if (!meOpenId) return [];

  const rows = db
    .prepare(
      "SELECT * FROM work_reports WHERE status = '已提交' ORDER BY submitted_at DESC, created_at DESC"
    )
    .all();
  if (!rows.length) return [];

  /* 逐条按确认人集合过滤（作者本人已在 resolveConfirmers 内排除） */
  const pending = rows.filter(function (r) {
    const confirmers = resolveConfirmers(db, toStr(r.project_id), toStr(r.author_open_id));
    return confirmers.has(meOpenId);
  });
  if (!pending.length) return [];

  const idList = pending.map(function (r) { return String(r.id); });
  const children = loadChildren(db, idList);
  return pending.map(function (r) {
    const key = String(r.id);
    return rowToApiReport(r, children.tasks[key], children.risks[key]);
  });
}

module.exports = {
  // 读
  listReports,
  getReport,
  // 工时统计报表（B9 · 只读聚合）
  getEffortReport,
  // 写
  createReport,
  updateReport,
  // B14 块2 · 周报轻量闭环
  resolveConfirmers,
  confirmReport,
  rejectReport,
  listPendingConfirmation,
  // 纯函数（供路由 / 测试复用）
  validateReportPayload,
};
