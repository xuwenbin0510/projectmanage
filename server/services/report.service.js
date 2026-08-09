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
const wbsService = require('./wbs.service');
const milestoneService = require('./milestone.service');

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
 * 列出项目下全部周报（含历史多次提交，倒序）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {object[]} Report[]
 */
function listReports(db, projectId) {
  const rows = db
    .prepare('SELECT * FROM work_reports WHERE project_id = ? ORDER BY week DESC, created_at DESC')
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

/* ── 写 ─────────────────────────────────────────────── */

/**
 * 归一化 payload 的任务引用列表，并补齐 WBS 节点快照字段。
 *
 * D-6 数据隔离：解析到的 `wbs_nodes` 行必须属于报告所属项目（`projectId`，
 * 由服务端上下文/路径参数传入），跨项目引用一律显式抛 `E_VALIDATION`，
 * 禁止把进度回写到其他项目的 WBS 节点上。不存在的 nodeId 仍按空壳处理
 * （对齐 N4：不崩、快照字段为空），仅对「存在但属于别的项目」的节点报错。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} rawTasks payload.tasks（`{nodeId, progressAfter, selected}`）
 * @param {string} projectId 报告所属项目 id（服务端真源，勿用请求体可伪造字段）
 * @returns {{nodeId: string, nodeCode: string, nodeName: string, progressBefore: number,
 *            progressAfter: number, selected: boolean, estimateDays: number}[]}
 * @throws {AppError} `E_VALIDATION` 引用的 WBS 节点不属于本项目
 */
function resolveTaskRefs(db, rawTasks, projectId) {
  const list = Array.isArray(rawTasks) ? rawTasks : [];
  const selNode = db.prepare('SELECT * FROM wbs_nodes WHERE id = ?');
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

    return {
      nodeId: nodeId,
      nodeCode: node ? toStr(node.wbs_code) : '',
      nodeName: node ? toStr(node.name) : '',
      progressBefore: node ? toProgress(node.progress) : 0,
      progressAfter: toProgress(ref.progressAfter),
      selected: ref.selected === true || ref.selected === 1,
      estimateDays: node ? Number(node.estimate_days) || 0 : 0,
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
      id, report_id, node_id, node_code, node_name, progress_before, progress_after, selected
    ) VALUES (@id, @report_id, @node_id, @node_code, @node_name, @progress_before, @progress_after, @selected)
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
 * 新建周报（暂存或提交）。
 *
 * 同周允许多次提交（不做周次查重，用户反馈⑤）：每次调用均新建一条。
 *
 * `submit=true` 时按共享约定 §6 触发：
 *  ① 仅 `selected` 的任务回写 `wbs_nodes.progress` / `actual_days`；
 *  ② 冻结 `snapshot`（仅含 selected 节点）；
 *  ③ `syncWbsProgressStatus` → `refreshMilestoneStatuses`（次序恒定）；
 *  ④ 写 `entity_type='report'` 审计。
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

      /* ② 进度 → 状态自动流转统一收口（父节点加权回写 + 状态收敛） */
      wbsService.syncWbsProgressStatus(db, projectId);
      /* ③ 联动刷新里程碑 taskStats / 状态（次序：WBS 先，里程碑后） */
      milestoneService.refreshMilestoneStatuses(db, projectId);
    }
  });

  tx();

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

module.exports = {
  // 读
  listReports,
  getReport,
  // 写
  createReport,
  updateReport,
  // 纯函数（供路由 / 测试复用）
  validateReportPayload,
};
