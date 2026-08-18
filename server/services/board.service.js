/**
 * 看板服务（P0-07 · 移植自 `web/src/api/mock/index.ts` L452 / L1463 / L1505）
 *
 * 关键口径：
 *  - **Q-3 卡片 = 真叶子**（无子节点），**不是** `nodeType === 'task'`；WIP 计数同口径
 *  - `board_configs` **懒创建**：首次读到没有配置时落一条
 *    `{columns: BOARD_COLUMNS, wipLimits: {'进行中': DEFAULT_WIP_LIMIT}}`
 *  - **D11 唯一例外**：`updateBoardConfig` **不调 `assertWritable`**（与 Mock L1508 一致）；
 *    若要改，得 Mock / 真后端同改，不在 B3 范围
 *  - `moveTask` 返回 `BoardView`，`updateBoardConfig` 返回 `BoardConfig`（不是 BoardView）
 */

const { AppError, ErrorCode } = require('../lib/errors');
const dates = require('../lib/dates');
const wbs = require('../lib/wbs');
const mappers = require('../lib/mappers');
const enums = require('../config/enums');
const rbac = require('../middleware/rbac');
const { writeAudit } = require('../lib/audit');
const wbsService = require('./wbs.service');
const milestoneService = require('./milestone.service');

/* ═══════════════════════════════════════════════════
 * 一、看板配置（懒创建）
 * ═══════════════════════════════════════════════════ */

/**
 * `board_configs.columns` 是否与当前 `enums.BOARD_COLUMNS` 逐项一致。
 *
 * @param {*} columns DB 里反序列化出来的列数组（可能是任意脏值）
 * @returns {boolean} true = 一致，无需自愈
 */
function columnsInSync(columns) {
  const want = enums.BOARD_COLUMNS;
  if (!Array.isArray(columns) || columns.length !== want.length) return false;
  for (let i = 0; i < want.length; i += 1) {
    if (String(columns[i]) !== want[i]) return false;
  }
  return true;
}

/**
 * 读看板配置（API 形态）；不存在则**懒创建**一条默认配置后返回。
 *
 * 默认：`columns = BOARD_COLUMNS`、`wipLimits = {'进行中': DEFAULT_WIP_LIMIT}`。
 *
 * ── B11 决策 D-B11-1 · 列快照「读时自愈」 ─────────────────────
 * `columns` 落库时是「创建时刻的 `BOARD_COLUMNS` 快照」，且**没有任何 API 能改它**
 * （`updateBoardConfig` 只写 `wip_limits`）。只改 `enums.js` 常量会导致
 * 「已有项目 4 列、新建项目 5 列」。故在此做幂等自愈：
 *   - 读到的 `columns` 与 `enums.BOARD_COLUMNS` 不一致 → 就地 `UPDATE ... SET columns = ?`；
 *   - **只 SET columns 一列，`wip_limits` 分毫不动**（用户配置不可丢）；
 *   - 一致则**零写入**（第二次调用不产生 UPDATE）；
 *   - **不写审计**：这是数据修复而非用户行为；
 *   - 无 migration —— 未来任何列增删自动生效，开发/生产库版本参差也能自愈。
 * ──────────────────────────────────────────────────────────
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {object} BoardConfig
 */
function ensureBoardConfig(db, projectId) {
  const pid = String(projectId);
  let row = db.prepare('SELECT * FROM board_configs WHERE project_id = ?').get(pid);
  if (!row) {
    /* 与 Mock L458 一致：只给「进行中」预置上限，其余列不限 */
    const wipLimits = { 进行中: enums.DEFAULT_WIP_LIMIT };
    const ts = dates.nowIso();
    db.prepare(
      'INSERT INTO board_configs (project_id, columns, wip_limits, updated_at) VALUES (?, ?, ?, ?)'
    ).run(pid, JSON.stringify(enums.BOARD_COLUMNS.slice()), JSON.stringify(wipLimits), ts);
    row = db.prepare('SELECT * FROM board_configs WHERE project_id = ?').get(pid);
  }

  const config = mappers.toApiBoardConfig(row);

  /* B11 · 列快照自愈（幂等；只改 columns，不碰 wip_limits，不写审计） */
  if (!columnsInSync(config.columns)) {
    db.prepare('UPDATE board_configs SET columns = ? WHERE project_id = ?')
      .run(JSON.stringify(enums.BOARD_COLUMNS.slice()), pid);
    row = db.prepare('SELECT * FROM board_configs WHERE project_id = ?').get(pid);
    return mappers.toApiBoardConfig(row);
  }

  return config;
}

/* ═══════════════════════════════════════════════════
 * 二、读接口
 * ═══════════════════════════════════════════════════ */

/**
 * 看板视图（`mock/index.ts:452`）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {object} BoardView `{projectId, columns: [{status, cards, wipLimit}], config}`
 * @throws {AppError} E_NOT_FOUND 项目不存在
 */
function getBoard(db, projectId) {
  rbac.loadProject(db, projectId);
  const tx = db.transaction(function () {
    return getBoardInner(db, projectId);
  });
  return tx();
}

/* ═══════════════════════════════════════════════════
 * 三、写接口
 * ═══════════════════════════════════════════════════ */

/**
 * 拖拽改状态（`mock/index.ts:1463` · P0-07，WIP 超限拦截）。
 *
 * 顺序：查节点 → `assertWritable` → `assertCan('task:status')` →
 *       （**仅当状态变化时**）WIP 校验 → 落库 →
 *       `syncWbsProgressStatus` → `refreshMilestoneStatuses` → （**仅当状态变化时**）审计
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} nodeId
 * @param {string} status 目标列状态
 * @param {number} order 目标列内排序值
 * @returns {object} BoardView
 * @throws {AppError} E_NOT_FOUND / E_PROJECT_ARCHIVED / E_FORBIDDEN / E_VALIDATION / E_WIP_EXCEEDED(409)
 */
function moveTask(db, req, nodeId, status, order) {
  const tx = db.transaction(function () {
    const row = wbsService.requireNodeRow(db, nodeId);
    const projectId = mappers.toStr(row.project_id);

    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'task:status', projectId);

    const nextStatus = String(status === undefined || status === null ? '' : status);
    if (enums.TASK_STATUSES.indexOf(nextStatus) < 0) {
      throw new AppError(ErrorCode.E_VALIDATION, '任务状态非法，允许值：' + enums.TASK_STATUSES.join(' / '), {
        fields: { status: '非法取值' },
        allowed: enums.TASK_STATUSES.slice(),
      });
    }

    const config = ensureBoardConfig(db, projectId);
    const nodes = wbsService.loadNodes(db, projectId);
    const node = mappers.toApiWbsNode(row, mappers.makeNameLookup(db));
    const before = node.status;

    /* WIP 只在**状态真的改变**时校验（同列内排序不受限） */
    if (before !== nextStatus) {
      const exceeded = wbs.checkWip(nodes, config, nextStatus, String(nodeId));
      if (exceeded) {
        throw new AppError(
          ErrorCode.E_WIP_EXCEEDED,
          '「' + nextStatus + '」列 WIP 已达上限 ' + exceeded.limit + '，请先完成在办任务',
          exceeded
        );
      }
    }

    /* 进度随状态联动（PRD 强规则字面语义） */
    let progress = node.progress;
    if (nextStatus === '完成') progress = 100;
    else if (nextStatus === '待办' && node.progress === 100) progress = 0;
    const boardOrder = Number(order);
    const actualDays = Number(((Number(node.estimateDays) || 0) * progress / 100).toFixed(1));

    db.prepare(
      'UPDATE wbs_nodes SET status = ?, board_order = ?, progress = ?, actual_days = ?, updated_at = ? WHERE id = ?'
    ).run(
      nextStatus,
      Number.isFinite(boardOrder) ? boardOrder : node.boardOrder,
      progress,
      actualDays,
      dates.nowIso(),
      String(nodeId)
    );

    /* R4-P0-3：拖「进行中」但 progress=100 会被强规则收敛回「完成」 */
    syncAndRefresh(db, projectId);

    /* R4-P1-1 D3：只有状态真的变了才留痕，避免同列排序刷屏 */
    if (before !== nextStatus) {
      writeAudit(
        db, me, 'wbs_node', String(nodeId), 'status_change', projectId,
        '任务「' + node.name + '」状态由「' + before + '」变更为「' + nextStatus + '」',
        [{ field: 'status', label: '任务状态', before: before, after: nextStatus }]
      );
    }

    return getBoardInner(db, projectId);
  });
  return tx();
}

/**
 * 更新看板 WIP 配置（`mock/index.ts:1505`）。
 *
 * 🔴 **D11 唯一例外**：本方法**不调 `assertWritable`**（照抄 Mock，行为一致性优先）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} projectId
 * @param {Object<string, number>} wipLimits
 * @returns {object} BoardConfig（**不是 BoardView**）
 * @throws {AppError} E_NOT_FOUND / E_FORBIDDEN / E_VALIDATION
 */
function updateBoardConfig(db, req, projectId, wipLimits) {
  rbac.loadProject(db, projectId);
  const tx = db.transaction(function () {
    /* ⚠ 这里**故意不调** assertWritable —— 见 D11 */
    const me = rbac.assertCan(db, req, 'board:config', projectId);

    if (!wipLimits || typeof wipLimits !== 'object' || Array.isArray(wipLimits)) {
      throw new AppError(ErrorCode.E_VALIDATION, 'wipLimits 必须是 {列名: 上限} 对象', {
        fields: { wipLimits: '格式非法' },
      });
    }
    const normalized = {};
    Object.keys(wipLimits).forEach(function (k) {
      const v = Number(wipLimits[k]);
      if (!Number.isFinite(v) || v < 0) {
        throw new AppError(ErrorCode.E_VALIDATION, 'WIP 上限必须是非负数字：' + k, {
          fields: { wipLimits: k + ' 非法' },
        });
      }
      normalized[k] = Math.round(v);
    });

    ensureBoardConfig(db, projectId);
    const ts = dates.nowIso();
    db.prepare('UPDATE board_configs SET wip_limits = ?, updated_at = ? WHERE project_id = ?')
      .run(JSON.stringify(normalized), ts, String(projectId));

    writeAudit(
      db, me, 'project', String(projectId), 'update', String(projectId),
      '调整看板 WIP 限制：' + JSON.stringify(normalized)
    );

    return mappers.toApiBoardConfig(
      db.prepare('SELECT * FROM board_configs WHERE project_id = ?').get(String(projectId))
    );
  });
  return tx();
}

/* ═══════════════════════════════════════════════════
 * 四、内部工具（避免嵌套事务）
 * ═══════════════════════════════════════════════════ */

/**
 * 引擎收尾（顺序恒定，不可换）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {void}
 */
function syncAndRefresh(db, projectId) {
  wbsService.syncWbsProgressStatus(db, projectId);
  milestoneService.refreshMilestoneStatuses(db, projectId);
}

/**
 * 组装看板视图（不含 `loadProject` / 事务，供已在事务内的调用方复用）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {object} BoardView
 */
function getBoardInner(db, projectId) {
  const config = ensureBoardConfig(db, projectId);
  const nodes = wbsService.loadNodes(db, projectId);
  const leaves = wbs.leafNodesOf(nodes);
  const columns = config.columns.map(function (status) {
    const cards = leaves
      .filter(function (t) { return t.status === status; })
      .sort(function (a, b) { return a.boardOrder - b.boardOrder; });
    const limit = Number(config.wipLimits[status]);
    return { status: status, cards: cards, wipLimit: Number.isFinite(limit) ? limit : 0 };
  });
  return mappers.toApiBoardView(projectId, columns, config);
}

module.exports = {
  ensureBoardConfig,
  getBoard,
  getBoardInner,
  moveTask,
  updateBoardConfig,
};
