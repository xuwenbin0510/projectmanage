'use strict';

/**
 * 项目类型服务（单一访问层 · 单一真相源 = `project_types` 表）
 *
 * 设计（照 `server/services/roleCatalog.js` 先例）：
 *  - 项目类型从「代码常量」下沉为「表驱动实体」，本模块是所有类型读取 / 校验 /
 *    标识生成 / 克隆的唯一出口，**零 Express 依赖**（路由层只做入参转发 + 信封）。
 *  - 读取为实时查表，不做进程内缓存（类型变更是低频后台操作，实时读简单可靠）。
 *  - 出生种子 `server/config/project-types-catalog.js` 仅迁移 v29 首次落库，
 *    后台后续改动不会被覆盖。
 *
 * 与既有表的关联（沿用既有约定，不新增第二机制）：
 *  - `projects.type` = `project_types.code`（逻辑外键，不加 DB FK）
 *  - `lifecycle_templates.project_type` = `code`，`is_active=1` 为当前生效模板
 *  - `review_templates.key` = `project:<code>`（立项）、`ccb:<code>`（变更）
 *
 * 错误码：
 *  - `E_TYPE_NOT_CONFIGURED`(409)：所选类型尚未配置生命周期模板或立项审批流（建项闸门，OQ-1）
 *  - `E_TYPE_DISABLED`(400)      ：所选类型不存在 / 已停用，不可用于新建项目
 *  - `E_VALIDATION`(400)         ：字段非法（name 空 / orderNo 非数字等）
 *  - `E_NOT_FOUND`(404)          ：PUT 目标 code 不存在 / 克隆来源不存在
 */

const { AppError, ErrorCode } = require('../lib/errors');
const dates = require('../lib/dates');
const ids = require('../lib/ids');

/** 系统生成标识的格式：T + 自增整数（与内置 A/B/C/D 天然不冲突） */
const GEN_CODE_RE = /^T(\d+)$/;

/** 契约约定的「空白起步」哨兵：`cloneFrom='__blank__'` 或省略 = 不克隆（见 web/src/api/contract.ts） */
const BLANK_SOURCE = '__blank__';

/** 立项审批 key 前缀 */
const PROJECT_REVIEW_PREFIX = 'project:';
/** 变更审批 key 前缀 */
const CCB_REVIEW_PREFIX = 'ccb:';

/* ── 行 → API 形态 ─────────────────────────────────── */

/**
 * `project_types` 行 → `ProjectTypeEntity`（**camelCase**，供路由直接信封下发）。
 * @param {object|null|undefined} row
 * @returns {object|null}
 */
function toApiProjectType(row) {
  if (!row) return null;
  return {
    code: String(row.code || ''),
    name: String(row.name || ''),
    example: String(row.example || ''),
    enabled: Number(row.enabled) === 1,
    orderNo: Number(row.order_no) || 0,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  };
}

/* ── 读取 ───────────────────────────────────────────── */

/**
 * 全部项目类型（含已停用，按 order_no 升序，其次 code 升序）。
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<object>} ProjectTypeEntity[]
 */
function listTypes(db) {
  return db
    .prepare('SELECT * FROM project_types ORDER BY order_no ASC, code ASC')
    .all()
    .map(toApiProjectType);
}

/**
 * 启用中的项目类型（按 order_no 升序）。
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<object>} ProjectTypeEntity[]
 */
function listEnabled(db) {
  return db
    .prepare('SELECT * FROM project_types WHERE enabled = 1 ORDER BY order_no ASC, code ASC')
    .all()
    .map(toApiProjectType);
}

/**
 * 按 code 取原始行（含已停用）；不存在返回 undefined。
 * @param {import('better-sqlite3').Database} db
 * @param {string} code
 * @returns {object|undefined}
 */
function getTypeRow(db, code) {
  return db.prepare('SELECT * FROM project_types WHERE code = ?').get(String(code || ''));
}

/**
 * 按 code 取类型（API 形态，含已停用）；不存在返回 null。
 * @param {import('better-sqlite3').Database} db
 * @param {string} code
 * @returns {object|null} ProjectTypeEntity | null
 */
function getType(db, code) {
  return toApiProjectType(getTypeRow(db, code));
}

/* ── 标识生成（OQ-5） ──────────────────────────────── */

/**
 * 生成下一个系统标识：扫描现有 `code` 匹配 `^T(\d+)$` 取最大 N，返回 `T{N+1}`（首个为 `T1`）。
 * 与内置 `A/B/C/D`（不匹配该正则）天然不冲突；生成后写入且永不重算。
 * @param {import('better-sqlite3').Database} db
 * @returns {string}
 */
function nextTypeCode(db) {
  const rows = db.prepare('SELECT code FROM project_types').all();
  let max = 0;
  rows.forEach(function (r) {
    const m = GEN_CODE_RE.exec(String(r.code || ''));
    if (!m) return;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return 'T' + (max + 1);
}

/* ── readiness 闸门（OQ-1 · 建项前置校验） ──────────── */

/**
 * 该类型是否有启用中的生命周期模板。
 * @param {import('better-sqlite3').Database} db
 * @param {string} code
 * @returns {boolean}
 */
function hasActiveLifecycleTemplate(db, code) {
  return !!db
    .prepare('SELECT 1 FROM lifecycle_templates WHERE project_type = ? AND is_active = 1 LIMIT 1')
    .get(String(code || ''));
}

/**
 * 是否存在某 key 的启用审批模板。
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @returns {boolean}
 */
function hasActiveReviewTemplate(db, key) {
  return !!db
    .prepare('SELECT 1 FROM review_templates WHERE key = ? AND active = 1 LIMIT 1')
    .get(String(key || ''));
}

/**
 * readiness 闸门（§5.B）：建项前必须「有启用的生命周期模板 + 有启用的 `project:<code>` 立项流」，
 * 任一缺失即抛 `E_TYPE_NOT_CONFIGURED`（409），`data.missing` 列出缺失项供前端精准提示。
 * 口径 = **阻止建项并提示**（团队指令；PRD §5.4「需先配置或使用默认」的张力见设计 R6）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} code
 * @throws {AppError} E_TYPE_NOT_CONFIGURED
 */
function assertTypeReadyForCreate(db, code) {
  const c = String(code || '');
  const missing = [];
  if (!hasActiveLifecycleTemplate(db, c)) missing.push('lifecycleTemplate');
  if (!hasActiveReviewTemplate(db, PROJECT_REVIEW_PREFIX + c)) missing.push('reviewTemplate');

  if (missing.length) {
    const hasTpl = missing.indexOf('lifecycleTemplate') >= 0;
    const hasRev = missing.indexOf('reviewTemplate') >= 0;
    const message = hasTpl && hasRev
      ? '该类型尚未配置生命周期模板与立项审批流，请先在后台完成配置后再新建项目'
      : (hasTpl
        ? '该类型尚未配置生命周期模板，请先在后台完成配置后再新建项目'
        : '该类型尚未配置立项审批流，请先在后台完成配置后再新建项目');
    throw new AppError(ErrorCode.E_TYPE_NOT_CONFIGURED, message, { code: c, missing: missing });
  }
}

/* ── 克隆辅助（POST 克隆语义 · R9 / PRD §5.3） ─────── */

/**
 * 克隆来源类型的「当前生效生命周期模板」：整包 definition 照抄，新 id、新 project_type、is_active=1。
 * 来源无生效模板时不克隆（返回 null），不抛错——克隆只搬运存在的资产。
 * @param {import('better-sqlite3').Database} db
 * @param {string} srcCode 来源类型 code
 * @param {string} newCode 新类型 code
 * @param {string} newName 新类型名称（用作新模板名）
 * @param {string} now ISO 时间戳
 * @returns {string|null} 新模板 id（无来源模板时为 null）
 */
function cloneLifecycleTemplate(db, srcCode, newCode, newName, now) {
  const tpl = db
    .prepare('SELECT * FROM lifecycle_templates WHERE project_type = ? AND is_active = 1 ORDER BY version DESC LIMIT 1')
    .get(String(srcCode));
  if (!tpl) return null;
  const newId = ids.genId('TMP');
  db.prepare(
    'INSERT INTO lifecycle_templates (id, project_type, version, name, definition, is_active, created_at) '
    + 'VALUES (?, ?, 1, ?, ?, 1, ?)',
  ).run(newId, String(newCode), String(newName).slice(0, 60), tpl.definition, now);
  return newId;
}

/**
 * 克隆来源类型的审批流：`project:<src>`→`project:<new>`、`ccb:<src>`→`ccb:<new>`（新 key，chain/assignees 照抄）。
 * 来源不存在对应 key 时跳过（如 ccb:<src> 未单独配置 → D 类等回落通用 ccb，保持现状）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} srcCode 来源类型 code
 * @param {string} newCode 新类型 code
 * @param {string} now ISO 时间戳
 * @returns {void}
 */
function cloneReviewTemplates(db, srcCode, newCode, now) {
  const pairs = [
    [PROJECT_REVIEW_PREFIX + srcCode, PROJECT_REVIEW_PREFIX + newCode],
    [CCB_REVIEW_PREFIX + srcCode, CCB_REVIEW_PREFIX + newCode],
  ];
  pairs.forEach(function (pair) {
    const src = db.prepare('SELECT * FROM review_templates WHERE key = ?').get(pair[0]);
    if (!src) return;
    db.prepare(
      'INSERT OR IGNORE INTO review_templates '
      + '(key, scope, label, mode, chain, assignees, description, active, created_at, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      pair[1],
      src.scope,
      src.label,
      src.mode,
      src.chain,
      src.assignees,
      src.description,
      src.active,
      now,
      now,
    );
  });
}

/* ── 写入 ───────────────────────────────────────────── */

/**
 * 新增项目类型（POST /admin/project-types）。
 *
 * - `code` 由系统生成（`nextTypeCode`），创建后不可改；
 * - `orderNo` 自动取「当前最大序号 + 1」（追加到列表末尾）；
 * - `cloneFrom` 时克隆来源类型的生命周期模板 + 审批流（project: / ccb:）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{name:string, example?:string, cloneFrom?:string}} input
 * @returns {object} ProjectTypeEntity
 * @throws {AppError} E_VALIDATION
 */
function createType(db, input) {
  const src = input && typeof input === 'object' ? input : {};
  const name = String(src.name || '').trim();
  if (!name) {
    throw new AppError(ErrorCode.E_VALIDATION, undefined, {
      fields: [{ field: 'name', message: '类型名称必填' }],
    });
  }
  const example = String(src.example || '').trim();
  // 「空白起步」哨兵（`'__blank__'`）视为未提供克隆来源——契约见 web/src/api/contract.ts，
  // mock 同口径（web/src/api/mock/index.ts）。此前仅真实 HTTP 后端漏了这一分支（QA F1）。
  const rawCloneFrom = src.cloneFrom ? String(src.cloneFrom).trim() : '';
  const cloneFrom = rawCloneFrom === BLANK_SOURCE ? '' : rawCloneFrom;
  if (cloneFrom && !getTypeRow(db, cloneFrom)) {
    throw new AppError(ErrorCode.E_VALIDATION, undefined, {
      fields: [{ field: 'cloneFrom', message: '克隆来源类型不存在：' + cloneFrom }],
    });
  }

  const code = nextTypeCode(db);
  const now = dates.nowIso();
  const maxRow = db.prepare('SELECT MAX(order_no) AS m FROM project_types').get();
  const orderNo = (maxRow && Number(maxRow.m) > 0 ? Number(maxRow.m) : 0) + 1;

  const tx = db.transaction(function () {
    db.prepare(
      'INSERT INTO project_types (code, name, example, enabled, order_no, created_at, updated_at) '
      + 'VALUES (?, ?, ?, 1, ?, ?, ?)',
    ).run(code, name.slice(0, 60), example.slice(0, 200), orderNo, now, now);

    if (cloneFrom) {
      cloneLifecycleTemplate(db, cloneFrom, code, name, now);
      cloneReviewTemplates(db, cloneFrom, code, now);
    }
  });
  tx();

  return getType(db, code);
}

/**
 * 更新项目类型（PUT /admin/project-types/:code）。
 * 可改 `name` / `example` / `orderNo` / `enabled`；**`code` 不可改**（只停用不删除）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} code
 * @param {{name?:string, example?:string, orderNo?:number, enabled?:boolean}} patch
 * @returns {object} ProjectTypeEntity
 * @throws {AppError} E_NOT_FOUND / E_VALIDATION
 */
function updateType(db, code, patch) {
  const c = String(code || '');
  const target = getTypeRow(db, c);
  if (!target) throw new AppError(ErrorCode.E_NOT_FOUND, '项目类型不存在', { code: c });

  const b = patch && typeof patch === 'object' ? patch : {};
  const sets = [];
  const args = [];

  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'name', message: '类型名称必填' }],
      });
    }
    sets.push('name = ?');
    args.push(name.slice(0, 60));
  }
  if (b.example !== undefined) {
    sets.push('example = ?');
    args.push(String(b.example || '').slice(0, 200));
  }
  if (b.orderNo !== undefined) {
    const n = Number(b.orderNo);
    if (!Number.isFinite(n)) {
      throw new AppError(ErrorCode.E_VALIDATION, undefined, {
        fields: [{ field: 'orderNo', message: '排序必须为数字' }],
      });
    }
    sets.push('order_no = ?');
    args.push(Math.trunc(n));
  }
  if (b.enabled !== undefined) {
    sets.push('enabled = ?');
    args.push(b.enabled ? 1 : 0);
  }

  if (!sets.length) throw new AppError(ErrorCode.E_VALIDATION, '没有可更新的字段', {});

  sets.push('updated_at = ?');
  args.push(dates.nowIso());
  args.push(c);
  db.prepare('UPDATE project_types SET ' + sets.join(', ') + ' WHERE code = ?').run(args);

  return getType(db, c);
}

/**
 * 克隆项目类型（便捷入口）：以来源类型的名称 +「（副本）」为新名称，
 * 复用 `createType` 的克隆语义（生命周期模板 + 审批流）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} srcCode 来源类型 code
 * @param {{name?:string, example?:string}} [input]
 * @returns {object} ProjectTypeEntity
 * @throws {AppError} E_NOT_FOUND / E_VALIDATION
 */
function cloneType(db, srcCode, input) {
  const src = String(srcCode || '');
  const row = getTypeRow(db, src);
  if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, '来源类型不存在', { code: src });

  const opts = input && typeof input === 'object' ? input : {};
  return createType(db, {
    name: opts.name !== undefined ? opts.name : (String(row.name || '') + '（副本）'),
    example: opts.example !== undefined ? opts.example : String(row.example || ''),
    cloneFrom: src,
  });
}

module.exports = {
  toApiProjectType,
  listTypes,
  listEnabled,
  getType,
  getTypeRow,
  nextTypeCode,
  hasActiveLifecycleTemplate,
  hasActiveReviewTemplate,
  assertTypeReadyForCreate,
  createType,
  updateType,
  cloneType,
};
