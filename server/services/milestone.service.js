/**
 * 里程碑服务（P0-05 / SK-2 / SK-7 / P0-M1 / P0-M2）
 *
 * 职责边界：
 *  - **SK-2 唯一真值三元组**：`done_at` + `(status_override, override_by, override_at, override_base_date)` + `planned_date`
 *  - `status` / `done` **永不落库**，读路径统一 `rules.applyMilestoneStatuses` 推导
 *  - `code` 是「派生但落库自愈」的：`rules.renumberMilestones` 幂等反写 `M1..Mn`
 *  - **任何改期 / 达成 / 取消达成都必须 `clearOverride()`**（否则 `isOverrideValid` 会把旧覆盖挂到新日期上）
 *
 * ⚠ **循环依赖纪律**：本文件**不得** `require('./project.service')`。
 *   需要的项目行自己查（`loadProjectRow`）。反向由 `project.service` 薄转发过来。
 *
 * 移植源：`web/src/api/mock/index.ts` L287 / L970 / L1027 / L1064
 */

const { AppError, ErrorCode } = require('../lib/errors');
const dates = require('../lib/dates');
const rules = require('../lib/rules');
const wbs = require('../lib/wbs');
const ids = require('../lib/ids');
const mappers = require('../lib/mappers');
const enums = require('../config/enums');
const rbac = require('../middleware/rbac');
const { writeAudit, diffEntry } = require('../lib/audit');

/* ═══════════════════════════════════════════════════
 * 一、基础读取
 * ═══════════════════════════════════════════════════ */

/**
 * 读项目行（未删除）；不存在返回 undefined。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {object|undefined}
 */
function loadProjectRow(db, projectId) {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(String(projectId || ''));
}

/**
 * 读单条里程碑行，不存在直接 404。
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {object} milestones 行
 * @throws {AppError} E_NOT_FOUND
 */
function requireMilestoneRow(db, id) {
  const row = db.prepare('SELECT * FROM milestones WHERE id = ?').get(String(id || ''));
  if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, '里程碑不存在', { milestoneId: String(id || '') });
  return row;
}

/**
 * 读项目全部里程碑（API 形态，未推导 status）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {Array<object>} Milestone[]
 */
function loadMilestones(db, projectId) {
  return db
    .prepare('SELECT * FROM milestones WHERE project_id = ?')
    .all(String(projectId))
    .map(mappers.toApiMilestone);
}

/**
 * 读项目全部 WBS 节点（API 形态，按 `compareWbsCode` 排序）。
 *
 * ⚠ 4.3 铁律：排序一律走 `compareWbsCode`，**禁止** SQL `ORDER BY wbs_code`
 *   （字典序会把 `1.10` 排到 `1.2` 前面）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {Array<object>} WbsNode[]
 */
function loadWbsNodes(db, projectId) {
  const nameOf = mappers.makeNameLookup(db);
  const rows = db.prepare('SELECT * FROM wbs_nodes WHERE project_id = ?').all(String(projectId));
  return wbs.sortByWbsCode(rows.map(function (r) { return mappers.toApiWbsNode(r, nameOf); }));
}

/**
 * 读取项目全部质量门 + 检查项，按 milestone_id / gate_id 建索引。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {{gateByMs: Object, itemsByGate: Object, gates: Array<object>}}
 */
function loadGates(db, projectId) {
  const gateRows = db
    .prepare('SELECT * FROM quality_gates WHERE project_id = ? ORDER BY created_at ASC, id ASC')
    .all(String(projectId));
  const gates = gateRows.map(mappers.toApiGate);

  const gateByMs = {};
  const gateIds = [];
  gates.forEach(function (g) {
    gateByMs[g.milestoneId] = g;
    gateIds.push(g.id);
  });

  const itemsByGate = {};
  if (gateIds.length) {
    const placeholders = gateIds.map(function () { return '?'; }).join(',');
    const itemRows = db
      .prepare('SELECT * FROM gate_checklist_items WHERE gate_id IN (' + placeholders + ') ORDER BY seq ASC, id ASC')
      .all(gateIds);
    itemRows.forEach(function (r) {
      const item = mappers.toApiGateItem(r);
      if (!itemsByGate[item.gateId]) itemsByGate[item.gateId] = [];
      itemsByGate[item.gateId].push(item);
    });
  }
  return { gateByMs: gateByMs, itemsByGate: itemsByGate, gates: gates };
}

/* ═══════════════════════════════════════════════════
 * 二、口径 Y 任务统计（D5：批次 3 接真值）
 * ═══════════════════════════════════════════════════ */

/**
 * 里程碑任务统计索引（口径 Y · SK-M4）。
 *
 * 口径：`total` / `done` 取「直接绑定 ∪ 子树真叶子」全集，
 *       `progress` 只按**真叶子**的 `estimateDays` 加权。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {Array<string>} [milestoneIds] 只算这些碑；省略则算项目全部碑
 * @returns {Object<string, {total:number,done:number,progress:number}>}
 */
function loadTaskStats(db, projectId, milestoneIds) {
  const nodes = loadWbsNodes(db, projectId);
  const list = Array.isArray(milestoneIds) && milestoneIds.length
    ? milestoneIds.slice()
    : db.prepare('SELECT id FROM milestones WHERE project_id = ?').all(String(projectId)).map(function (r) {
      return mappers.toStr(r.id);
    });

  const stats = {};
  list.forEach(function (msId) {
    stats[msId] = nodes.length ? wbs.milestoneTaskStats(nodes, msId) : rules.emptyTaskStats();
  });
  return stats;
}

/* ═══════════════════════════════════════════════════
 * 三、SK-2 唯一写入口
 * ═══════════════════════════════════════════════════ */

/**
 * ⚠️ **SK-2 里程碑派生状态的唯一入口**（移植自 `mock/index.ts:287`）。
 *
 * 输入：时间（`currentDate` / 起算日 / 今天）+ 完成度（关联任务）+ 真值（`doneAt` / `statusOverride`）
 * 输出：**只回写 `projects.health`**。
 *
 * 🔴 `status` / `done` 是派生值，**绝不 UPDATE 回 `milestones` 表**。
 *   真正落库的自愈只有 `renumberMilestones` 的 `code` 反写（见 `listMilestonesWithGate`）。
 *
 * 任何修改里程碑日期 / 达成 / 覆盖 / 任务进度的动作，落库后都必须调用本函数。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {void}
 */
function refreshMilestoneStatuses(db, projectId) {
  const project = loadProjectRow(db, projectId);
  if (!project) return;

  const list = loadMilestones(db, projectId);
  const nodes = loadWbsNodes(db, projectId);

  const statsByMs = {};
  list.forEach(function (ms) {
    statsByMs[ms.id] = nodes.length ? wbs.milestoneTaskStats(nodes, ms.id) : rules.emptyTaskStats();
  });

  rules.applyMilestoneStatuses(list, mappers.toStr(project.plan_start), dates.today(), statsByMs);

  const gates = db
    .prepare('SELECT * FROM quality_gates WHERE project_id = ?')
    .all(String(projectId))
    .map(mappers.toApiGate);

  const health = rules.computeHealth(list, gates);
  if (health !== mappers.toStr(project.health, 'green')) {
    db.prepare('UPDATE projects SET health = ? WHERE id = ?').run(health, String(projectId));
  }
}

/**
 * 里程碑 + 门 + 检查项 + 任务统计 聚合视图（里程碑页 / 概览页唯一数据源）。
 *
 * 读路径副作用（与前端 Mock 一致）：
 *  - **幂等重排** code 为 M1..Mn，发现漂移即落库自愈（P0-M2 / F-2）
 *  - 统一推导派生 status / done（SK-2）
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {Array<object>} MilestoneWithGate[]
 * @throws {AppError} E_NOT_FOUND 项目不存在
 */
function listMilestonesWithGate(db, projectId) {
  const project = loadProjectRow(db, projectId);
  if (!project) {
    throw new AppError(ErrorCode.E_NOT_FOUND, '项目不存在', { projectId: String(projectId || '') });
  }

  const list = loadMilestones(db, projectId);

  /* 幂等重排；有漂移才写库，避免每次读都产生写放大 */
  const changed = rules.renumberMilestones(list);
  if (changed.length) {
    const upd = db.prepare('UPDATE milestones SET code = ? WHERE id = ?');
    changed.forEach(function (m) { upd.run(m.code, m.id); });
  }

  const nodes = loadWbsNodes(db, projectId);
  const stats = {};
  list.forEach(function (ms) {
    stats[ms.id] = nodes.length ? wbs.milestoneTaskStats(nodes, ms.id) : rules.emptyTaskStats();
  });

  rules.applyMilestoneStatuses(list, mappers.toStr(project.plan_start), dates.today(), stats);

  const gateIdx = loadGates(db, projectId);
  return rules.sortMilestones(list).map(function (m) {
    const gate = gateIdx.gateByMs[m.id] || null;
    const gateItems = gate ? gateIdx.itemsByGate[gate.id] || [] : [];
    return mappers.toApiMilestoneWithGate(m, gate, gateItems, stats[m.id] || rules.emptyTaskStats());
  });
}

/**
 * 取单条 `MilestoneWithGate`（写操作统一用它组装返回值，保证与列表同形）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {string} milestoneId
 * @returns {object} MilestoneWithGate
 * @throws {AppError} E_NOT_FOUND
 */
function getMilestoneWithGate(db, projectId, milestoneId) {
  const one = listMilestonesWithGate(db, projectId).filter(function (m) {
    return m.id === String(milestoneId);
  })[0];
  if (!one) throw new AppError(ErrorCode.E_NOT_FOUND, '里程碑不存在', { milestoneId: String(milestoneId || '') });
  return one;
}

/* ═══════════════════════════════════════════════════
 * 四、内部小工具
 * ═══════════════════════════════════════════════════ */

/**
 * 幂等重排 code 并落库（写路径复用；改期 / 新增 / 删除后都要调）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {void}
 */
function renumberAndPersist(db, projectId) {
  const list = loadMilestones(db, projectId);
  const changed = rules.renumberMilestones(list);
  if (!changed.length) return;
  const upd = db.prepare('UPDATE milestones SET code = ? WHERE id = ?');
  changed.forEach(function (m) { upd.run(m.code, m.id); });
}

/**
 * 清空人工覆盖三元组 + 基线快照（达成 / 取消达成 / 改期 三个动作共用 · SK-7）。
 *
 * ⚠ 只拼 SQL 片段，由调用方合并到同一条 UPDATE，避免多次写同一行。
 * @returns {string} SQL SET 片段
 */
function clearOverrideSql() {
  return 'status_override = NULL, override_by = NULL, override_at = NULL, override_base_date = NULL';
}

/**
 * 生成下一个里程碑 code：`'M' + (maxSeq + 1)`。
 * `maxSeq = max(parseInt(code.replace(/^\D+/,''), 10))`，无碑时为 0。
 * @param {Array<object>} list Milestone[]
 * @returns {string}
 */
function nextMilestoneCode(list) {
  let maxSeq = 0;
  (list || []).forEach(function (m) {
    const n = parseInt(String(m.code || '').replace(/^\D+/, ''), 10);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
  });
  return 'M' + (maxSeq + 1);
}

/* ═══════════════════════════════════════════════════
 * 五、写操作
 * ═══════════════════════════════════════════════════ */

/**
 * 新建里程碑（`mock/index.ts:970`）。
 *
 * K-1：**不建质量门**（门只在建项向导显式提交时实例化）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req 已过 requireAuth
 * @param {string} projectId
 * @param {{name: string, target?: string, date: string}} payload
 * @returns {object} MilestoneWithGate
 * @throws {AppError} E_PROJECT_ARCHIVED / E_FORBIDDEN / E_VALIDATION
 */
function createMilestone(db, req, projectId, payload) {
  const p = payload || {};
  const tx = db.transaction(function () {
    /* RBAC 恒定次序：assertWritable → assertCan → 业务校验 */
    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'milestone:create', projectId);

    const name = String(p.name === undefined || p.name === null ? '' : p.name).trim();
    if (!name) {
      throw new AppError(ErrorCode.E_VALIDATION, '里程碑名称不能为空', { fields: { name: '必填' } });
    }
    const date = String(p.date === undefined || p.date === null ? '' : p.date).trim();
    if (!dates.isDate(date)) {
      throw new AppError(ErrorCode.E_VALIDATION, '里程碑日期非法，需为 YYYY-MM-DD', { fields: { date: '日期非法' } });
    }

    const list = loadMilestones(db, projectId);
    const code = nextMilestoneCode(list);
    const id = ids.genId('MS');
    const ts = dates.nowIso();

    db.prepare(
      'INSERT INTO milestones (' +
        'id, project_id, code, name, target, required, baseline_date, planned_date, ' +
        'done_at, done_by, status_override, override_by, override_at, override_base_date, ' +
        'last_change_id, created_at, updated_at' +
        ') VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)'
    ).run(
      id,
      String(projectId),
      code,
      name,
      String(p.target === undefined || p.target === null ? '' : p.target),
      date,
      date,
      ts,
      ts
    );

    /* 新碑可能插在中间 → code 必须重排（P0-M1/M2） */
    renumberAndPersist(db, projectId);
    refreshMilestoneStatuses(db, projectId);

    writeAudit(db, me, 'milestone', id, 'create', projectId, '新增里程碑「' + code + ' ' + name + '」（' + date + '）');

    return getMilestoneWithGate(db, projectId, id);
  });
  return tx();
}

/**
 * 修改里程碑（`mock/index.ts:1064` · B3 最复杂的一个）。
 *
 * 处理顺序（不可换）：
 *  ① `currentDate` 改期（SK-7 单向规则，延后 → 409 E_MS_NEED_CHANGE + changeDraft）
 *  ② `achieved`（C-G4，**不卡质量门**，见 D12）
 *  ③ `statusOverride`（SK-2 三元组 + 基线快照）
 *  ④ `name` / `target` 常规 diff
 *  ⑤ renumber → refreshMilestoneStatuses → 审计
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} id 里程碑 id
 * @param {{name?: string, target?: string, currentDate?: string, achieved?: boolean, statusOverride?: ?string}} payload
 * @returns {object} MilestoneWithGate
 * @throws {AppError} E_NOT_FOUND / E_PROJECT_ARCHIVED / E_FORBIDDEN / E_VALIDATION / E_MS_NEED_CHANGE(409)
 */
function updateMilestone(db, req, id, payload) {
  const p = payload || {};
  const tx = db.transaction(function () {
    const row = requireMilestoneRow(db, id);
    const projectId = mappers.toStr(row.project_id);

    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'milestone:edit', projectId);

    /* 取当前 API 形态（currentDate 已由 mapper 从 planned_date 转好） */
    const ms = mappers.toApiMilestone(row);
    const diff = [];
    const sets = [];
    const args = [];
    /** 是否需要清空覆盖三元组（改期 / 达成 / 取消达成 共用） */
    let needClearOverride = false;

    /* ── ① currentDate 改期（P0-05 / SK-7 单向规则） ───────── */
    if (p.currentDate !== undefined && p.currentDate !== null && String(p.currentDate) !== ms.currentDate) {
      const toDate = String(p.currentDate);
      if (!dates.isDate(toDate)) {
        throw new AppError(ErrorCode.E_VALIDATION, '里程碑日期非法，需为 YYYY-MM-DD', { fields: { currentDate: '日期非法' } });
      }
      /* 延后（diffDays(current, to) > 0）必须走变更单 */
      if (wbs.milestoneDelayNeedsChange(ms, toDate)) {
        throw new AppError(ErrorCode.E_MS_NEED_CHANGE, '里程碑日期延后须走变更申请', {
          changeDraft: {
            projectId: ms.projectId,
            changeType: 'milestone_date',
            title: ms.code + ' ' + ms.name + ' 里程碑日期调整',
            targetType: 'milestone',
            targetId: ms.id,
            payload: { fromDate: ms.currentDate, toDate: toDate },
          },
        });
      }
      /* 提前 / 同日 → 直接改，并清覆盖（基线快照失效） */
      sets.push('planned_date = ?');
      args.push(toDate);
      needClearOverride = true;
      const d = diffEntry('currentDate', '计划日期', ms.currentDate, toDate);
      if (d) diff.push(d);
    }

    /* ── ② achieved（C-G4，D12：不卡质量门） ─────────────── */
    if (p.achieved !== undefined) {
      const achieved = p.achieved === true;
      if (achieved) {
        if (!ms.doneAt) {
          const t = dates.today();
          sets.push('done_at = ?', 'done_by = ?');
          args.push(t, mappers.toStr(me.open_id !== undefined ? me.open_id : me.openId));
          diff.push({ field: 'status', label: '里程碑状态', before: ms.status, after: '已达成' });
        }
      } else if (ms.doneAt) {
        sets.push('done_at = NULL', 'done_by = NULL');
        diff.push({ field: 'status', label: '里程碑状态', before: '已达成', after: '未达成' });
      }
      needClearOverride = true;
    }

    /* ── ③ statusOverride（SK-2 三元组 + 基线快照） ──────── */
    if (p.statusOverride !== undefined) {
      if (p.statusOverride === null || p.statusOverride === '') {
        needClearOverride = true;
        const d = diffEntry('statusOverride', '人工覆盖状态', ms.statusOverride, '');
        if (d) diff.push(d);
      } else {
        const ov = String(p.statusOverride);
        if (enums.MILESTONE_OVERRIDES.indexOf(ov) < 0) {
          throw new AppError(ErrorCode.E_VALIDATION, '人工覆盖状态非法，允许值：' + enums.MILESTONE_OVERRIDES.join(' / '), {
            fields: { statusOverride: '非法取值' },
            allowed: enums.MILESTONE_OVERRIDES.slice(),
          });
        }
        /* 基线快照 = 覆盖当时的 planned_date（若本次同时改期，取改期后的值） */
        const baseDate = p.currentDate !== undefined && p.currentDate !== null && String(p.currentDate) !== ms.currentDate
          ? String(p.currentDate)
          : ms.currentDate;
        sets.push('status_override = ?', 'override_by = ?', 'override_at = ?', 'override_base_date = ?');
        args.push(
          ov,
          mappers.toStr(me.open_id !== undefined ? me.open_id : me.openId),
          dates.nowIso(),
          baseDate
        );
        needClearOverride = false; // 显式设置覆盖优先于「改期清覆盖」
        const d = diffEntry('statusOverride', '人工覆盖状态', ms.statusOverride, ov);
        if (d) diff.push(d);
      }
    }

    /* ── ④ name / target 常规 diff ─────────────────────── */
    if (p.name !== undefined && String(p.name) !== ms.name) {
      const nextName = String(p.name).trim();
      if (!nextName) {
        throw new AppError(ErrorCode.E_VALIDATION, '里程碑名称不能为空', { fields: { name: '必填' } });
      }
      sets.push('name = ?');
      args.push(nextName);
      const d = diffEntry('name', '名称', ms.name, nextName);
      if (d) diff.push(d);
    }
    if (p.target !== undefined && String(p.target) !== ms.target) {
      sets.push('target = ?');
      args.push(String(p.target));
      const d = diffEntry('target', '目标', ms.target, String(p.target));
      if (d) diff.push(d);
    }

    if (needClearOverride) sets.push(clearOverrideSql());

    /* 恒写 updated_at（即使无字段变化，也代表一次编辑动作） */
    sets.push('updated_at = ?');
    args.push(dates.nowIso());
    args.push(String(id));
    db.prepare('UPDATE milestones SET ' + sets.join(', ') + ' WHERE id = ?').run(args);

    /* 改期会改排序 ⇒ code 必须重排（P0-M1/M2） */
    renumberAndPersist(db, projectId);
    refreshMilestoneStatuses(db, projectId);

    const after = getMilestoneWithGate(db, projectId, id);
    writeAudit(
      db,
      me,
      'milestone',
      String(id),
      'update',
      projectId,
      '修改里程碑「' + after.code + ' ' + after.name + '」',
      diff
    );
    return after;
  });
  return tx();
}

/**
 * 删除里程碑（`mock/index.ts:1027`）。
 *
 * SK-12：WBS 节点的 `milestone_id` **置 NULL，不删任务**。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} id
 * @returns {null}
 * @throws {AppError} E_NOT_FOUND / E_PROJECT_ARCHIVED / E_FORBIDDEN
 */
function deleteMilestone(db, req, id) {
  const tx = db.transaction(function () {
    const row = requireMilestoneRow(db, id);
    const projectId = mappers.toStr(row.project_id);

    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'milestone:delete', projectId);

    const code = mappers.toStr(row.code);
    const name = mappers.toStr(row.name);

    /* 级联删门 + 检查项（显式删，不依赖 FK 级联开关） */
    const gateIds = db
      .prepare('SELECT id FROM quality_gates WHERE milestone_id = ?')
      .all(String(id))
      .map(function (r) { return mappers.toStr(r.id); });
    if (gateIds.length) {
      const placeholders = gateIds.map(function () { return '?'; }).join(',');
      db.prepare('DELETE FROM gate_checklist_items WHERE gate_id IN (' + placeholders + ')').run(gateIds);
      db.prepare('DELETE FROM quality_gates WHERE id IN (' + placeholders + ')').run(gateIds);
    }

    /* SK-12：任务不删，只解绑 */
    db.prepare('UPDATE wbs_nodes SET milestone_id = NULL WHERE milestone_id = ?').run(String(id));

    db.prepare('DELETE FROM milestones WHERE id = ?').run(String(id));

    renumberAndPersist(db, projectId);
    refreshMilestoneStatuses(db, projectId);

    writeAudit(db, me, 'milestone', String(id), 'delete', projectId, '删除里程碑「' + code + ' ' + name + '」');
    return null;
  });
  return tx();
}

/**
 * 质量门通过 → 其挂载里程碑自动达成（`mock/index.ts:429`）。
 *
 * **幂等**：仅当 `done_at` 为空才写日期，重复决策不改达成日。
 * 供 `gate.service.decideGate` 复用（放这里是因为它写的是里程碑行）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor users 行
 * @param {object} gateRow quality_gates 行
 * @returns {void}
 */
function achieveMilestoneByGate(db, actor, gateRow) {
  const msRow = db.prepare('SELECT * FROM milestones WHERE id = ?').get(mappers.toStr(gateRow.milestone_id));
  if (!msRow) return;
  const projectId = mappers.toStr(gateRow.project_id);

  if (!mappers.toStr(msRow.done_at)) {
    const ms = mappers.toApiMilestone(msRow);
    /* 达成前先把派生状态算出来，作为审计 diff 的 before */
    const list = loadMilestones(db, projectId);
    const project = loadProjectRow(db, projectId);
    const nodes = loadWbsNodes(db, projectId);
    const statsByMs = {};
    list.forEach(function (m) {
      statsByMs[m.id] = nodes.length ? wbs.milestoneTaskStats(nodes, m.id) : rules.emptyTaskStats();
    });
    rules.applyMilestoneStatuses(list, project ? mappers.toStr(project.plan_start) : '', dates.today(), statsByMs);
    const beforeStatus = (list.filter(function (m) { return m.id === ms.id; })[0] || ms).status;

    db.prepare(
      'UPDATE milestones SET done_at = ?, done_by = ?, updated_at = ?, ' + clearOverrideSql() + ' WHERE id = ?'
    ).run(
      dates.today(),
      mappers.toStr(actor && (actor.open_id !== undefined ? actor.open_id : actor.openId)),
      dates.nowIso(),
      ms.id
    );

    writeAudit(
      db,
      actor,
      'milestone',
      ms.id,
      'status_change',
      projectId,
      '质量门「' + mappers.toStr(gateRow.code) + ' ' + mappers.toStr(gateRow.name) + '」通过，里程碑「' +
        ms.code + ' ' + ms.name + '」自动达成',
      [{ field: 'status', label: '里程碑状态', before: beforeStatus, after: '已达成' }]
    );
  }

  refreshMilestoneStatuses(db, projectId);
}

module.exports = {
  // 读
  loadProjectRow,
  requireMilestoneRow,
  loadMilestones,
  loadWbsNodes,
  loadGates,
  loadTaskStats,
  listMilestonesWithGate,
  getMilestoneWithGate,
  // 引擎
  refreshMilestoneStatuses,
  renumberAndPersist,
  clearOverrideSql,
  nextMilestoneCode,
  achieveMilestoneByGate,
  // 写
  createMilestone,
  updateMilestone,
  deleteMilestone,
};
