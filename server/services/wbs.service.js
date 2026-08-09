/**
 * WBS 树服务（P0-06 · 移植自 `web/src/api/mock/index.ts` L1166~L1451）
 *
 * 职责边界：
 *  - 事务 / 校验 / 错误码在本层；纯算法在 `server/lib/wbs.js`；行↔对象在 `server/lib/mappers.js`
 *  - **RBAC 恒定次序**：查实体拿 projectId → `assertWritable` → `assertCan` → 业务校验
 *  - **引擎收尾次序恒定**：`syncWbsProgressStatus(projectId)` → `refreshMilestoneStatuses(projectId)`（不可换）
 *  - 排序一律 `compareWbsCode`，**禁止** SQL `ORDER BY wbs_code`（字典序会把 `1.10` 排到 `1.2` 前）
 *  - `level = wbsCode.split('.').length`，每次改 code 必须同步改 level
 *
 * ⚠ D13：`moveWbsNode` 返回**整个项目的节点数组**（create / update 返回单节点），
 *   前端靠这个数组整树刷新，顺手"统一成单节点"会让树刷新失效。
 */

const { AppError, ErrorCode } = require('../lib/errors');
const dates = require('../lib/dates');
const rules = require('../lib/rules');
const wbs = require('../lib/wbs');
const ids = require('../lib/ids');
const mappers = require('../lib/mappers');
const rbac = require('../middleware/rbac');
const { writeAudit, diffEntry } = require('../lib/audit');
const enums = require('../config/enums');
const milestoneService = require('./milestone.service');

/** 未传截止日期时的默认工期（天） */
const DEFAULT_DUE_OFFSET_DAYS = 7;

/* ═══════════════════════════════════════════════════
 * 一、基础读取
 * ═══════════════════════════════════════════════════ */

/**
 * 读项目全部 WBS 节点（API 形态，按 `compareWbsCode` 排序，B7 带工时汇总字段）。
 *
 * B7（D-B7-1）单点收口：所有 WBS 读接口（listWbs / create/update/delete 返回值 /
 * move 全量数组 / syncWbsProgressStatus 内部读取）统一经 `decorateEffort` 装饰，
 * 出参自动带 `effortHours`（叶=存储值、父=Σ直接子节点）+ `effortChildCount`。
 * **不动** `milestoneService.loadWbsNodes`（里程碑/周报统计不需要 effort 字段）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {Array<object>} WbsNode[]
 */
function loadNodes(db, projectId) {
  return wbs.decorateEffort(milestoneService.loadWbsNodes(db, projectId));
}

/**
 * B7（R2/R4）工时数值校验：有子节点禁止手填；叶子校验 `0 ≤ v ≤ EFFORT_HOURS_MAX`。
 *
 * - `p.effortHours === undefined` → 直接放行（未提交该字段不校验）
 * - `isParent` → 抛 `E_WBS_EFFORT_PARENT`（400，方案 A 强制汇总）
 * - 叶子数值非法（非数字 / <0 / >上限）→ 抛 `E_VALIDATION`（400）
 *
 * @param {object} p 请求体
 * @param {boolean} isParent 该节点是否已有子节点
 * @param {?string} nodeId 节点 id（错误 data 用；新建态可传 null）
 * @param {number} childCount 直接子节点数
 * @returns {void}
 * @throws {AppError} E_WBS_EFFORT_PARENT / E_VALIDATION
 */
function assertEffortHours(p, isParent, nodeId, childCount) {
  if (p.effortHours === undefined) return;
  if (isParent) {
    throw new AppError(
      ErrorCode.E_WBS_EFFORT_PARENT,
      '有子节点的节点工时由子任务自动汇总，不可手填',
      { nodeId: nodeId, childCount: childCount }
    );
  }
  const v = Number(p.effortHours);
  if (!Number.isFinite(v) || v < 0 || v > enums.EFFORT_HOURS_MAX) {
    throw new AppError(
      ErrorCode.E_VALIDATION,
      '工时须为 0~' + enums.EFFORT_HOURS_MAX + ' 的数字（可含 0.5 小数）',
      { fields: { effortHours: '非法取值' } }
    );
  }
}

/**
 * 读单个节点行，不存在直接 404。
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {object} wbs_nodes 行
 * @throws {AppError} E_NOT_FOUND
 */
function requireNodeRow(db, id) {
  const row = db.prepare('SELECT * FROM wbs_nodes WHERE id = ?').get(String(id || ''));
  if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, 'WBS 节点不存在', { nodeId: String(id || '') });
  return row;
}

/**
 * 取项目生效的生命周期模板（WBS 规则解析用）；找不到返回 null，调用方回落 `DEFAULT_WBS_RULES`。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {object|null} LifecycleTemplate | null
 */
function projectTemplateOf(db, projectId) {
  const p = db.prepare('SELECT template_id FROM projects WHERE id = ?').get(String(projectId || ''));
  if (!p || !p.template_id) return null;
  const row = db.prepare('SELECT * FROM lifecycle_templates WHERE id = ?').get(String(p.template_id));
  return row ? mappers.toApiTemplate(row) : null;
}

/**
 * 解析项目的 WBS 规则（模板覆盖 → 默认值）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {{maxDepth:number, skeleton:string, childTypes:Object}}
 */
function wbsRulesOf(db, projectId) {
  return rules.resolveWbsRules(projectTemplateOf(db, projectId));
}

/**
 * 读单条里程碑（API 形态）；id 为空或不存在返回 null。
 * @param {import('better-sqlite3').Database} db
 * @param {?string} milestoneId
 * @returns {object|null} Milestone | null
 */
function findMilestone(db, milestoneId) {
  if (!milestoneId) return null;
  const row = db.prepare('SELECT * FROM milestones WHERE id = ?').get(String(milestoneId));
  return row ? mappers.toApiMilestone(row) : null;
}

/**
 * 把 `wbs.js` 校验函数返回的 `{code,message,data}` 转成 `AppError` 抛出。
 * @param {?{code:string,message:string,data:Object}} err
 * @returns {void}
 * @throws {AppError}
 */
function throwIfInvalid(err) {
  if (!err) return;
  throw new AppError(ErrorCode[err.code] || err.code, err.message, err.data);
}

/* ═══════════════════════════════════════════════════
 * 二、R4-P0-3 进度 / 状态引擎
 * ═══════════════════════════════════════════════════ */

/**
 * R4-P0-3 单点收口：进度→状态自动流转 + 父节点回写（`mock/index.ts:318`）。
 *
 * 流程：
 *  ① 自底向上回写每个节点 progress —— 叶子保留自身存储值，
 *     父节点 = 子树真叶子按 `estimateDays` 加权（`rollupProgressFlat`，与视图层同算法）；
 *  ② 每节点 `status = syncNodeStatusFromProgress(status, progress)` 纯函数收敛；
 *  ③ **仅实际变化时**才 UPDATE（不写审计，避免派生噪音）。
 *
 * 🔴 与 `refreshMilestoneStatuses` 的调用次序恒定：本函数**先**，里程碑刷新**后**。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {void}
 */
function syncWbsProgressStatus(db, projectId) {
  const nodes = loadNodes(db, projectId);
  if (!nodes.length) return;
  const ts = dates.nowIso();
  const upd = db.prepare(
    'UPDATE wbs_nodes SET progress = ?, status = ?, actual_days = ?, updated_at = ? WHERE id = ?'
  );
  nodes.forEach(function (n) {
    const next = wbs.rollupProgressFlat(nodes, n.id);
    const nextStatus = wbs.syncNodeStatusFromProgress(n.status, next);
    if (n.progress !== next || n.status !== nextStatus) {
      const actualDays = Number(((Number(n.estimateDays) || 0) * next / 100).toFixed(1));
      upd.run(next, nextStatus, actualDays, ts, n.id);
      /* 同步内存副本，供同一事务内后续计算使用 */
      n.progress = next;
      n.status = nextStatus;
      n.actualDays = actualDays;
      n.updatedAt = ts;
    }
  });
}

/**
 * 重命名子树 WBS 编码（`mock/index.ts:2167` 的迭代版）。
 *
 * 只**产出变更计划**，不直接写库，便于调用方合并成一次批量 UPDATE。
 *
 * @param {Array<object>} nodes 全项目节点（API 形态）
 * @param {object} node 子树根
 * @param {string} newCode 子树根的新编码
 * @param {Array<{id:string, wbsCode:string, level:number}>} out 输出计划（原地追加）
 * @returns {Array<{id:string, wbsCode:string, level:number}>} out
 */
function renameSubtreePlan(nodes, node, newCode, out) {
  const plan = out || [];
  plan.push({ id: node.id, wbsCode: newCode, level: newCode.split('.').length });
  const children = wbs.sortByWbsCode(
    nodes.filter(function (n) { return n.parentId === node.id; })
  );
  children.forEach(function (c, i) {
    renameSubtreePlan(nodes, c, newCode + '.' + (i + 1), plan);
  });
  return plan;
}

/**
 * 落库执行编码重排计划（同时同步 level）。
 * @param {import('better-sqlite3').Database} db
 * @param {Array<{id:string, wbsCode:string, level:number}>} plan
 * @param {string} ts
 * @returns {void}
 */
function applyRenamePlan(db, plan, ts) {
  const upd = db.prepare('UPDATE wbs_nodes SET wbs_code = ?, level = ?, updated_at = ? WHERE id = ?');
  (plan || []).forEach(function (p) { upd.run(p.wbsCode, p.level, ts, p.id); });
}

/* ═══════════════════════════════════════════════════
 * 三、读接口
 * ═══════════════════════════════════════════════════ */

/**
 * 项目 WBS 全量列表（按 `compareWbsCode` 排序）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {Array<object>} WbsNode[]
 * @throws {AppError} E_NOT_FOUND 项目不存在
 */
function listWbs(db, projectId) {
  rbac.loadProject(db, projectId);
  return loadNodes(db, projectId);
}

/* ═══════════════════════════════════════════════════
 * 四、写接口
 * ═══════════════════════════════════════════════════ */

/**
 * 新建 WBS 节点（`mock/index.ts:1176` · 校验顺序**逐字照抄**）。
 *
 * 顺序（不可换）：
 *  1. `assertWritable` → `assertCan('wbs:edit')`
 *  2. 解析父节点（跨项目引用直接拒）
 *  3. W-1 深度 / W-2 父子类型（fail-fast，**先于**叶子完整性）
 *  4. 叶子完整性（新节点必然是叶子）
 *  5. 关联里程碑（默认继承父节点）+ 同项目校验
 *  6. `nextChildCode`
 *  7. 有效截止日期（默认 +7 天）+ 截止日期硬拦截
 *  8. 工时估算硬拦截
 *  9. INSERT
 * 10. 审计 `'create'`
 * 11. `syncWbsProgressStatus` → `refreshMilestoneStatuses`
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} projectId
 * @param {object} payload WbsNodePayload
 * @returns {object} WbsNode
 * @throws {AppError} E_PROJECT_ARCHIVED / E_FORBIDDEN / E_NOT_FOUND / E_VALIDATION /
 *                    E_WBS_DEPTH / E_WBS_PARENT_TYPE / E_WBS_LEAF_INCOMPLETE /
 *                    E_WBS_DEADLINE_OVERFLOW / E_WBS_ESTIMATE_OVERFLOW
 */
function createWbsNode(db, req, projectId, payload) {
  const p = payload || {};
  const tx = db.transaction(function () {
    /* 1. RBAC */
    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'wbs:edit', projectId);

    const nodes = loadNodes(db, projectId);
    const parentId = p.parentId === undefined || p.parentId === '' ? null : p.parentId;

    /* 2. 父节点先解析（跨项目引用直接拒） */
    const parent = parentId
      ? nodes.filter(function (n) { return n.id === String(parentId); })[0] || null
      : null;
    if (parentId && !parent) {
      /* 可能是别的项目的节点：先全库找一次，给出更准确的错误码 */
      const foreign = db.prepare('SELECT project_id FROM wbs_nodes WHERE id = ?').get(String(parentId));
      if (!foreign) throw new AppError(ErrorCode.E_NOT_FOUND, '父节点不存在', { parentId: String(parentId) });
      throw new AppError(ErrorCode.E_VALIDATION, '父节点不属于当前项目', { parentId: String(parentId) });
    }

    /* 3. W-1 深度 / W-2 父子类型 —— fail-fast，先于叶子完整性 */
    const nodeType = p.nodeType === undefined || p.nodeType === null || p.nodeType === '' ? 'task' : String(p.nodeType);
    throwIfInvalid(wbs.validateWbsPlacement({ nodeType: nodeType, parent: parent }, wbsRulesOf(db, projectId)));

    /* 4. 叶子完整性：新建节点必然还没有子节点，一律按叶子口径校验负责人 / 估算 */
    if (!p.owner || !p.estimateDays) {
      throw new AppError(ErrorCode.E_WBS_LEAF_INCOMPLETE, undefined, {
        fields: {
          owner: p.owner ? '' : '必填',
          estimateDays: p.estimateDays ? '' : '必填',
        },
      });
    }

    /* 4.5 B7：新节点恒叶子 → 工时数值校验（0 ≤ v ≤ EFFORT_HOURS_MAX） */
    assertEffortHours(p, false, null, 0);

    /* 5. 关联里程碑：显式传入用传入值；未传则默认继承上级节点的里程碑 */
    const milestoneId = p.milestoneId !== undefined
      ? (p.milestoneId === '' ? null : p.milestoneId)
      : (parent ? parent.milestoneId : null);
    rbac.assertSameProjectMilestone(db, projectId, milestoneId);

    /* 6. 自动编码 */
    const siblings = nodes.filter(function (n) { return n.parentId === parentId; });
    const wbsCode = wbs.nextChildCode(
      parent ? parent.wbsCode : null,
      siblings.map(function (s) { return s.wbsCode; })
    );

    /* 7. 有效截止日期（未传则默认 +7 天）+ 截止日期硬拦截 */
    const effectiveDue = p.dueDate === undefined || p.dueDate === null || p.dueDate === ''
      ? dates.addDays(dates.today(), DEFAULT_DUE_OFFSET_DAYS)
      : String(p.dueDate);
    const milestone = findMilestone(db, milestoneId);
    throwIfInvalid(wbs.validateWbsDeadline({ dueDate: effectiveDue, parent: parent, milestone: milestone }));

    /* 8. 工时估算硬拦截 */
    const startDate = p.startDate === undefined || p.startDate === null || p.startDate === ''
      ? dates.today()
      : String(p.startDate);
    throwIfInvalid(wbs.validateWbsEstimate({
      estimateDays: Number(p.estimateDays) || 0,
      startDate: startDate,
      dueDate: effectiveDue,
    }));

    /* 9. 落库 */
    const id = ids.genId('W');
    const ts = dates.nowIso();
    const progress = Math.max(0, Math.min(100, Number(p.progress) || 0));
    db.prepare(
      'INSERT INTO wbs_nodes (' +
        'id, project_id, parent_id, wbs_code, level, node_type, name, description, owner, ' +
        'estimate_days, actual_days, effort_hours, start_date, due_date, status, progress, board_order, ' +
        'is_critical, milestone_id, created_by, created_at, updated_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      String(projectId),
      parentId ? String(parentId) : null,
      wbsCode,
      wbsCode.split('.').length,
      nodeType,
      String(p.name === undefined || p.name === null ? '' : p.name),
      String(p.description === undefined || p.description === null ? '' : p.description),
      String(p.owner),
      Number(p.estimateDays) || 0,
      // B7：新节点恒叶子 → 存实际值，缺省按 0 落库（与 estimate_days NOT NULL DEFAULT 0 一致）
      Number(p.effortHours) || 0,
      startDate,
      effectiveDue,
      String(p.status === undefined || p.status === null || p.status === '' ? '待办' : p.status),
      progress,
      nodes.length,
      p.isCritical ? 1 : 0,
      milestoneId ? String(milestoneId) : null,
      mappers.toStr(me.open_id !== undefined ? me.open_id : me.openId),
      ts,
      ts
    );

    /* B7（D-B7-3）：父节点此前若是叶子存过值 → 成为父即清 NULL，防「存了值但没算」脏态 */
    if (parentId) {
      db.prepare(
        'UPDATE wbs_nodes SET effort_hours = NULL WHERE id = ? AND effort_hours IS NOT NULL'
      ).run(String(parentId));
    }

    /* 10. 审计 */
    writeAudit(
      db, me, 'wbs_node', id, 'create', projectId,
      '新增 WBS 节点「' + wbsCode + ' ' + String(p.name || '') + '」'
    );

    /* 11. 引擎收尾（顺序不可换） */
    syncWbsProgressStatus(db, projectId);
    milestoneService.refreshMilestoneStatuses(db, projectId);

    /* B7：返回装饰后的单节点（effortHours/effortChildCount 与 listWbs 口径一致） */
    const afterNodes = loadNodes(db, projectId);
    return afterNodes.filter(function (n) { return n.id === id; })[0]
      || mappers.toApiWbsNode(requireNodeRow(db, id), mappers.makeNameLookup(db));
  });
  return tx();
}

/**
 * 修改 WBS 节点（`mock/index.ts:1263`）。
 *
 * R-4 类型锁：已有子节点的节点不可改 `nodeType`；无子节点时改类型须重新满足父子白名单。
 * SK-13 叶子完整性：**仅对真叶子**（无子节点）要求负责人 + 估算。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} id
 * @param {object} payload Partial<WbsNodePayload>
 * @returns {object} WbsNode
 * @throws {AppError} E_NOT_FOUND / E_PROJECT_ARCHIVED / E_FORBIDDEN / E_WBS_TYPE_LOCKED /
 *                    E_WBS_PARENT_TYPE / E_WBS_DEPTH / E_WBS_DEADLINE_OVERFLOW /
 *                    E_WBS_ESTIMATE_OVERFLOW / E_WBS_LEAF_INCOMPLETE / E_VALIDATION
 */
function updateWbsNode(db, req, id, payload) {
  const p = payload || {};
  const tx = db.transaction(function () {
    const row = requireNodeRow(db, id);
    const projectId = mappers.toStr(row.project_id);

    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'wbs:edit', projectId);

    const nameOf = mappers.makeNameLookup(db);
    const nodes = loadNodes(db, projectId);
    const node = mappers.toApiWbsNode(row, nameOf);

    const diff = [];
    const sets = [];
    const args = [];

    /* 变更后的有效值（供跨字段复检使用） */
    let effType = node.nodeType;
    let effOwner = node.owner;
    let effEstimate = node.estimateDays;
    let effStart = node.startDate;
    let effDue = node.dueDate;
    let effProgress = node.progress;
    let effMilestoneId = node.milestoneId;

    /* ── R-4 类型锁 ──────────────────────────────────── */
    const children = nodes.filter(function (n) { return n.parentId === node.id; });

    /* ── B7 工时：父节点提交抛 E_WBS_EFFORT_PARENT；叶子校验后写列 ── */
    if (p.effortHours !== undefined) {
      assertEffortHours(p, children.length > 0, node.id, children.length);
      if (children.length === 0) {
        const effEffort = Number(p.effortHours) || 0;
        if (effEffort !== node.effortHours) {
          sets.push('effort_hours = ?');
          args.push(effEffort);
          diff.push({
            field: 'effortHours',
            label: '工时(h)',
            before: String(node.effortHours),
            after: String(effEffort),
          });
        }
      }
    }

    if (p.nodeType !== undefined && String(p.nodeType) !== node.nodeType) {
      if (children.length > 0) {
        throw new AppError(ErrorCode.E_WBS_TYPE_LOCKED, undefined, {
          nodeId: node.id,
          childCount: children.length,
        });
      }
      const parent = node.parentId
        ? nodes.filter(function (n) { return n.id === node.parentId; })[0] || null
        : null;
      throwIfInvalid(wbs.validateWbsPlacement(
        { nodeType: String(p.nodeType), parent: parent },
        wbsRulesOf(db, projectId)
      ));
      effType = String(p.nodeType);
      sets.push('node_type = ?');
      args.push(effType);
      diff.push({ field: 'nodeType', label: '节点类型', before: node.nodeType, after: effType });
    }

    /* ── 常规字段 ────────────────────────────────────── */
    if (p.name !== undefined && String(p.name) !== node.name) {
      sets.push('name = ?');
      args.push(String(p.name));
      diff.push({ field: 'name', label: '名称', before: node.name, after: String(p.name) });
    }
    if (p.description !== undefined) {
      sets.push('description = ?');
      args.push(String(p.description === null ? '' : p.description));
    }
    if (p.owner !== undefined && String(p.owner) !== node.owner) {
      effOwner = String(p.owner);
      sets.push('owner = ?');
      args.push(effOwner);
      diff.push({ field: 'owner', label: '负责人', before: node.ownerName, after: effOwner ? nameOf(effOwner) : '' });
    }
    if (p.estimateDays !== undefined && Number(p.estimateDays) !== node.estimateDays) {
      effEstimate = Number(p.estimateDays) || 0;
      sets.push('estimate_days = ?');
      args.push(effEstimate);
      diff.push({
        field: 'estimateDays',
        label: '估算人日',
        before: String(node.estimateDays),
        after: String(effEstimate),
      });
    }
    if (p.startDate !== undefined) {
      effStart = String(p.startDate === null ? '' : p.startDate);
      sets.push('start_date = ?');
      args.push(effStart);
    }

    /* ── milestoneId 先算出有效值（截止日期校验要用） ── */
    if (p.milestoneId !== undefined) {
      effMilestoneId = p.milestoneId === null || p.milestoneId === '' ? null : String(p.milestoneId);
    }

    /* ── 截止日期硬拦截 ─────────────────────────────── */
    if (p.dueDate !== undefined) {
      const nextDue = String(p.dueDate === null ? '' : p.dueDate);
      const ms = findMilestone(db, effMilestoneId);
      const parentNode = node.parentId
        ? nodes.filter(function (n) { return n.id === node.parentId; })[0] || null
        : null;
      throwIfInvalid(wbs.validateWbsDeadline({ dueDate: nextDue, parent: parentNode, milestone: ms }));
      effDue = nextDue;
      sets.push('due_date = ?');
      args.push(effDue);
    }

    /* ── 工时估算硬拦截：与起止/截止任一变更后统一复检 ── */
    throwIfInvalid(wbs.validateWbsEstimate({
      estimateDays: effEstimate,
      startDate: effStart,
      dueDate: effDue,
    }));

    if (p.status !== undefined && String(p.status) !== node.status) {
      sets.push('status = ?');
      args.push(String(p.status));
      diff.push({ field: 'status', label: '状态', before: node.status, after: String(p.status) });
    }
    if (p.progress !== undefined) {
      effProgress = Math.max(0, Math.min(100, Number(p.progress) || 0));
      sets.push('progress = ?', 'actual_days = ?');
      args.push(effProgress, Number(((effEstimate || 0) * effProgress / 100).toFixed(1)));
    }

    /* ── milestoneId 落库（任意节点均可挂；跨项目引用拒） ── */
    if (p.milestoneId !== undefined && effMilestoneId !== node.milestoneId) {
      rbac.assertSameProjectMilestone(db, projectId, effMilestoneId);
      sets.push('milestone_id = ?');
      args.push(effMilestoneId);
      diff.push({
        field: 'milestoneId',
        label: '关联里程碑',
        before: node.milestoneId || '',
        after: effMilestoneId || '',
      });
    }

    if (p.isCritical !== undefined && Boolean(p.isCritical) !== node.isCritical) {
      sets.push('is_critical = ?');
      args.push(p.isCritical ? 1 : 0);
      diff.push({
        field: 'isCritical',
        label: '关键路径',
        before: node.isCritical ? '是' : '否',
        after: p.isCritical ? '是' : '否',
      });
    }

    /* ── SK-13 叶子完整性：仅对真叶子要求负责人 + 估算 ── */
    if (wbs.isLeafNode(nodes, node.id) && (!effOwner || !effEstimate)) {
      throw new AppError(ErrorCode.E_WBS_LEAF_INCOMPLETE, undefined, {
        nodeId: node.id,
        fields: {
          owner: effOwner ? '' : '必填',
          estimateDays: effEstimate ? '' : '必填',
        },
      });
    }

    sets.push('updated_at = ?');
    args.push(dates.nowIso());
    args.push(String(id));
    db.prepare('UPDATE wbs_nodes SET ' + sets.join(', ') + ' WHERE id = ?').run(args);

    writeAudit(
      db, me, 'wbs_node', String(id), 'update', projectId,
      '修改节点「' + node.wbsCode + ' ' + (p.name !== undefined ? String(p.name) : node.name) + '」',
      diff
    );

    /* 引擎收尾（顺序不可换） */
    syncWbsProgressStatus(db, projectId);
    milestoneService.refreshMilestoneStatuses(db, projectId);

    /* B7：返回装饰后的单节点（父=Σ直接子节点，叶=存储值；与 listWbs 口径一致） */
    const afterNodes = loadNodes(db, projectId);
    return afterNodes.filter(function (n) { return n.id === String(id); })[0]
      || mappers.toApiWbsNode(requireNodeRow(db, id), mappers.makeNameLookup(db));
  });
  return tx();
}

/**
 * 删除 WBS 节点及其整棵子树（`mock/index.ts:1371`）。
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} id
 * @returns {null}
 * @throws {AppError} E_NOT_FOUND / E_PROJECT_ARCHIVED / E_FORBIDDEN
 */
function deleteWbsNode(db, req, id) {
  const tx = db.transaction(function () {
    const row = requireNodeRow(db, id);
    const projectId = mappers.toStr(row.project_id);

    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'wbs:delete', projectId);

    const nodes = loadNodes(db, projectId);
    const node = mappers.toApiWbsNode(row, mappers.makeNameLookup(db));

    /* 迭代收集整棵子树（含自身） */
    const toDelete = [String(id)];
    const seen = {};
    seen[String(id)] = true;
    let grew = true;
    while (grew) {
      grew = false;
      nodes.forEach(function (n) {
        if (n.parentId && seen[n.parentId] && !seen[n.id]) {
          seen[n.id] = true;
          toDelete.push(n.id);
          grew = true;
        }
      });
    }

    const placeholders = toDelete.map(function () { return '?'; }).join(',');
    db.prepare('DELETE FROM wbs_nodes WHERE id IN (' + placeholders + ')').run(toDelete);

    /* B7（D-B7-3）：删子树后清其原父 effort_hours（防历史脏数据残留，一行成本） */
    if (node.parentId) {
      db.prepare(
        'UPDATE wbs_nodes SET effort_hours = NULL WHERE id = ? AND effort_hours IS NOT NULL'
      ).run(node.parentId);
    }

    writeAudit(
      db, me, 'wbs_node', String(id), 'delete', projectId,
      '删除节点「' + node.wbsCode + ' ' + node.name + '」及其 ' + (toDelete.length - 1) + ' 个子节点'
    );

    /* 引擎收尾（顺序不可换） */
    syncWbsProgressStatus(db, projectId);
    milestoneService.refreshMilestoneStatuses(db, projectId);
    return null;
  });
  return tx();
}

/**
 * 拖拽移动节点（`mock/index.ts:1399`）：防循环 + 父子类型 + 子树整体深度校验 + 重排编码。
 *
 * 🔴 D13：返回**整个项目的节点数组**（按 `compareWbsCode` 排序），不是单节点。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} id 被移动节点 id
 * @param {?string} newParentId 目标父节点（null = 挂到根层）
 * @param {number} index 在目标父下的插入位置
 * @returns {Array<object>} WbsNode[] 全项目节点
 * @throws {AppError} E_NOT_FOUND / E_PROJECT_ARCHIVED / E_FORBIDDEN / E_WBS_CYCLE /
 *                    E_WBS_DEPTH / E_WBS_PARENT_TYPE / E_VALIDATION
 */
function moveWbsNode(db, req, id, newParentId, index) {
  const tx = db.transaction(function () {
    const row = requireNodeRow(db, id);
    const projectId = mappers.toStr(row.project_id);

    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'wbs:edit', projectId);

    const nodes = loadNodes(db, projectId);
    const node = nodes.filter(function (n) { return n.id === String(id); })[0];
    const targetParentId = newParentId === undefined || newParentId === null || newParentId === ''
      ? null
      : String(newParentId);

    /* 循环引用检查：新父节点不能是自身，也不能是自身后代 */
    if (targetParentId === String(id) || wbs.isDescendant(nodes, String(id), targetParentId)) {
      throw new AppError(ErrorCode.E_WBS_CYCLE, undefined, { nodeId: String(id), parentId: targetParentId });
    }

    /* 目标父节点归属校验 */
    const parent = targetParentId
      ? nodes.filter(function (n) { return n.id === targetParentId; })[0] || null
      : null;
    if (targetParentId && !parent) {
      const foreign = db.prepare('SELECT project_id FROM wbs_nodes WHERE id = ?').get(targetParentId);
      if (!foreign) throw new AppError(ErrorCode.E_NOT_FOUND, '目标父节点不存在', { parentId: targetParentId });
      throw new AppError(ErrorCode.E_VALIDATION, '目标父节点不属于当前项目', { parentId: targetParentId });
    }

    /* W-2 父子类型 + W-1 子树整体深度（把深树搬到深处绕过 maxDepth 的路径被显式拦截） */
    const subDepth = wbs.subtreeRelativeDepth(nodes, node.id);
    throwIfInvalid(wbs.validateWbsPlacement(
      { nodeType: node.nodeType, parent: parent, subtreeDepth: subDepth },
      wbsRulesOf(db, projectId)
    ));

    /* 落库改父 + 内存同步 */
    const ts = dates.nowIso();
    const oldParentId = node.parentId;
    db.prepare('UPDATE wbs_nodes SET parent_id = ?, updated_at = ? WHERE id = ?')
      .run(targetParentId, ts, String(id));
    node.parentId = targetParentId;

    /* B7（D-B7-3）：移动改变父子结构 → 原父与新父一并清 effort_hours（成为父即清） */
    const parentIdsToClear = [];
    if (oldParentId) parentIdsToClear.push(oldParentId);
    if (targetParentId) parentIdsToClear.push(targetParentId);
    if (parentIdsToClear.length) {
      db.prepare(
        'UPDATE wbs_nodes SET effort_hours = NULL WHERE id IN (' +
        parentIdsToClear.map(function () { return '?'; }).join(',') +
        ') AND effort_hours IS NOT NULL'
      ).run(parentIdsToClear);
    }

    /* 目标父下的兄弟按 compareWbsCode 排序后插入指定位置，整体重排编码 */
    const siblings = wbs.sortByWbsCode(
      nodes.filter(function (n) { return n.parentId === targetParentId && n.id !== String(id); })
    );
    /* index 省略 ⇒ 追加到末尾（等价于 `nextChildCode` 的 max+1 语义，见 T02-3 step 3） */
    const pos = index === undefined || index === null || index === ''
      ? siblings.length
      : Math.max(0, Math.min(Number(index) || 0, siblings.length));
    siblings.splice(pos, 0, node);

    const prefix = parent ? parent.wbsCode + '.' : '';
    const plan = [];
    siblings.forEach(function (s, i) {
      renameSubtreePlan(nodes, s, prefix + (i + 1), plan);
    });
    applyRenamePlan(db, plan, ts);

    const after = requireNodeRow(db, id);
    writeAudit(
      db, me, 'wbs_node', String(id), 'update', projectId,
      '移动节点「' + node.name + '」至 ' + mappers.toStr(after.wbs_code)
    );

    /* R4-P0-3：移动改变父子结构 → 父链回写 + 状态收敛 */
    syncWbsProgressStatus(db, projectId);
    milestoneService.refreshMilestoneStatuses(db, projectId);

    /* 🔴 D13：返回全项目节点数组 */
    return loadNodes(db, projectId);
  });
  return tx();
}

module.exports = {
  // 读
  loadNodes,
  requireNodeRow,
  projectTemplateOf,
  wbsRulesOf,
  listWbs,
  // 引擎
  syncWbsProgressStatus,
  renameSubtreePlan,
  applyRenamePlan,
  // 写
  createWbsNode,
  updateWbsNode,
  deleteWbsNode,
  moveWbsNode,
};
