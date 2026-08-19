/**
 * 质量门服务（P0-03 · 移植自 `web/src/api/mock/index.ts` L900 / L919）
 *
 * 决策 D-A：门挂载在**里程碑**上（不是阶段），门通过 → 里程碑自动达成（§4.3）。
 *
 * ⚠ 返回值形状以 `web/src/api/contract.ts:238-239` 为准：
 *   `toggleGateItem` / `decideGate` 都返回 **`MilestoneWithGate[]`**（整表回灌），
 *   前端 `MilestonesPage` 直接用它替换本地列表。任务分解 T04-2 的文字描述
 *   （"返回该门的 QualityGate + gateItems"）与前端契约冲突，**以契约为准**。
 */

const { AppError, ErrorCode } = require('../lib/errors');
const dates = require('../lib/dates');
const wbs = require('../lib/wbs');
const mappers = require('../lib/mappers');
const enums = require('../config/enums');
const rbac = require('../middleware/rbac');
const { writeAudit } = require('../lib/audit');
const milestoneService = require('./milestone.service');

/* ═══════════════════════════════════════════════════
 * 一、基础读取
 * ═══════════════════════════════════════════════════ */

/**
 * 读检查项行，不存在直接 404。
 * @param {import('better-sqlite3').Database} db
 * @param {string} itemId
 * @returns {object} gate_checklist_items 行
 * @throws {AppError} E_NOT_FOUND
 */
function requireGateItemRow(db, itemId) {
  const row = db.prepare('SELECT * FROM gate_checklist_items WHERE id = ?').get(String(itemId || ''));
  if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, '检查项不存在', { itemId: String(itemId || '') });
  return row;
}

/**
 * 读质量门行，不存在直接 404。
 * @param {import('better-sqlite3').Database} db
 * @param {string} gateId
 * @returns {object} quality_gates 行
 * @throws {AppError} E_NOT_FOUND
 */
function requireGateRow(db, gateId) {
  const row = db.prepare('SELECT * FROM quality_gates WHERE id = ?').get(String(gateId || ''));
  if (!row) throw new AppError(ErrorCode.E_NOT_FOUND, '质量门不存在', { gateId: String(gateId || '') });
  return row;
}

/**
 * 读某门的全部检查项（API 形态，按 seq 升序）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} gateId
 * @returns {Array<object>} GateChecklistItem[]
 */
function loadGateItems(db, gateId) {
  return db
    .prepare('SELECT * FROM gate_checklist_items WHERE gate_id = ? ORDER BY seq ASC, id ASC')
    .all(String(gateId))
    .map(mappers.toApiGateItem);
}

/* ═══════════════════════════════════════════════════
 * 二、写接口
 * ═══════════════════════════════════════════════════ */

/**
 * 勾选 / 取消勾选门检查项（`mock/index.ts:900`）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} itemId
 * @param {boolean} checked
 * @returns {Array<object>} MilestoneWithGate[]
 * @throws {AppError} E_NOT_FOUND / E_PROJECT_ARCHIVED / E_FORBIDDEN
 */
function toggleGateItem(db, req, itemId, checked) {
  const tx = db.transaction(function () {
    const item = requireGateItemRow(db, itemId);
    const gate = requireGateRow(db, mappers.toStr(item.gate_id));
    const projectId = mappers.toStr(gate.project_id);

    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'gate:item:check', projectId);

    const next = checked === true || checked === 1 || checked === 'true';
    const openId = mappers.toStr(me.open_id !== undefined ? me.open_id : me.openId);
    db.prepare('UPDATE gate_checklist_items SET checked = ?, checked_by = ?, checked_at = ? WHERE id = ?')
      .run(next ? 1 : 0, next ? openId : null, next ? dates.today() : null, String(itemId));

    writeAudit(
      db, me, 'gate_item', String(itemId), 'update', projectId,
      (next ? '勾选' : '取消勾选') + '检查项「' + mappers.toStr(item.content) + '」',
      [{
        field: 'checked',
        label: '勾选状态',
        before: mappers.toBool(item.checked) ? '已勾选' : '未勾选',
        after: next ? '已勾选' : '未勾选',
      }]
    );

    return milestoneService.listMilestonesWithGate(db, projectId);
  });
  return tx();
}

/**
 * 提交门控结论（`mock/index.ts:919` · P0-03）。
 *
 * 关键分支：**「不通过」允许在检查项没勾齐时直接下结论**，其余结论必须先勾齐。
 * `GATE_PASSED_STATUSES = ['已通过','有条件通过']` 命中 → 挂载里程碑自动达成（§4.3）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} projectId
 * @param {string} gateId
 * @param {{conclusion: string, comment?: string}} payload
 * @returns {Array<object>} MilestoneWithGate[]
 * @throws {AppError} E_NOT_FOUND / E_PROJECT_ARCHIVED / E_FORBIDDEN / E_VALIDATION / E_GATE_ITEM_INCOMPLETE
 */
function decideGate(db, req, projectId, gateId, payload) {
  const p = payload || {};
  const tx = db.transaction(function () {
    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'gate:decide', projectId);

    const gate = requireGateRow(db, gateId);
    if (mappers.toStr(gate.project_id) !== String(projectId)) {
      throw new AppError(ErrorCode.E_VALIDATION, '质量门不属于当前项目', { gateId: String(gateId) });
    }

    const conclusion = String(p.conclusion === undefined || p.conclusion === null ? '' : p.conclusion);
    if (enums.GATE_CONCLUSIONS.indexOf(conclusion) < 0) {
      throw new AppError(ErrorCode.E_VALIDATION, '门控结论非法，允许值：' + enums.GATE_CONCLUSIONS.join(' / '), {
        fields: { conclusion: '非法取值' },
        allowed: enums.GATE_CONCLUSIONS.slice(),
      });
    }

    const items = loadGateItems(db, gate.id);
    const readiness = wbs.gateReady(items);
    /* 「不通过」是明确的例外分支：不要求勾齐 */
    if (!readiness.ready && conclusion !== '不通过') {
      throw new AppError(ErrorCode.E_GATE_ITEM_INCOMPLETE, undefined, {
        unchecked: readiness.unchecked.map(function (u) {
          return { id: u.id, content: u.content };
        }),
      });
    }

    /* D05：门通过（通过/有条件通过）前校验该里程碑模板交付物齐备（缺失 → 拦截并列出清单） */
    if (enums.GATE_PASSED_STATUSES.indexOf(conclusion) >= 0) {
      const msId = mappers.toStr(gate.milestone_id);
      const missing = db
        .prepare(
          "SELECT name FROM project_documents WHERE project_id = ? AND milestone_id = ? AND template_key != '' AND status = '待交付' ORDER BY template_key",
        )
        .all(projectId, msId)
        .map(function (r) { return r.name; });
      if (missing.length) {
        throw new AppError(ErrorCode.E_GATE_DELIVERABLE_INCOMPLETE, undefined, { missing: missing });
      }
    }

    const before = mappers.toStr(gate.status, '未开始');
    db.prepare(
      'UPDATE quality_gates SET status = ?, conclusion = ?, comment = ?, decided_by = ?, decided_at = ? WHERE id = ?'
    ).run(
      conclusion,
      conclusion,
      String(p.comment === undefined || p.comment === null ? '' : p.comment),
      mappers.toStr(me.open_id !== undefined ? me.open_id : me.openId),
      dates.today(),
      String(gate.id)
    );

    writeAudit(
      db, me, 'gate', String(gate.id), 'decide', projectId,
      mappers.toStr(gate.code) + ' 门控结论：' + conclusion,
      [{ field: 'status', label: '门状态', before: before, after: conclusion }]
    );

    if (enums.GATE_PASSED_STATUSES.indexOf(conclusion) >= 0) {
      /* 通过 / 有条件通过 → 挂载里程碑自动达成（幂等，内部已含 refreshMilestoneStatuses） */
      milestoneService.achieveMilestoneByGate(db, me, db.prepare('SELECT * FROM quality_gates WHERE id = ?').get(String(gate.id)));
    } else {
      milestoneService.refreshMilestoneStatuses(db, projectId);
    }

    return milestoneService.listMilestonesWithGate(db, projectId);
  });
  return tx();
}

/* ═══════════════════════════════════════════════════
 * 三、检查项管理（D05 · custom 增/改/删，模板项只读）
 * ═══════════════════════════════════════════════════ */

/**
 * 新增 custom 检查项（milestone:edit；模板检查项保持只读）。
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} gateId
 * @param {{content?: string, ownerRole?: string}} payload
 * @returns {Array<object>} MilestoneWithGate[]
 */
function addGateItem(db, req, gateId, payload) {
  const p = payload || {};
  const tx = db.transaction(function () {
    const gate = requireGateRow(db, gateId);
    const projectId = mappers.toStr(gate.project_id);
    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'milestone:edit', projectId);

    const content = mappers.toStr(p.content).trim();
    if (!content) throw new AppError(ErrorCode.E_VALIDATION, '检查项内容不能为空');

    const maxSeq = db
      .prepare('SELECT COALESCE(MAX(seq), 0) m FROM gate_checklist_items WHERE gate_id = ?')
      .get(String(gateId)).m;
    const seq = Number(maxSeq) + 1;
    const id = String(gateId) + '-C' + String(seq);
    db.prepare(
      'INSERT INTO gate_checklist_items (id, gate_id, seq, content, owner_role, checked, checked_by, checked_at, source) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?)',
    ).run(id, String(gateId), seq, content, mappers.toStr(p.ownerRole).trim() || '', 'custom');

    writeAudit(
      db, me, 'gate_item', id, 'create', projectId,
      '新增检查项「' + content + '」（' + mappers.toStr(gate.code) + '）',
      [],
    );
    return milestoneService.listMilestonesWithGate(db, projectId);
  });
  return tx();
}

/**
 * 编辑 custom 检查项（内容/负责人；template 项只读，抛 E_VALIDATION）。
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} itemId
 * @param {{content?: string, ownerRole?: string}} payload
 * @returns {Array<object>} MilestoneWithGate[]
 */
function updateGateItem(db, req, itemId, payload) {
  const p = payload || {};
  const tx = db.transaction(function () {
    const item = requireGateItemRow(db, itemId);
    if (mappers.toStr(item.source) !== 'custom') {
      throw new AppError(ErrorCode.E_VALIDATION, '模板检查项不可修改，仅可勾选');
    }
    const gate = requireGateRow(db, mappers.toStr(item.gate_id));
    const projectId = mappers.toStr(gate.project_id);
    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'milestone:edit', projectId);

    const content = p.content !== undefined && p.content !== null ? mappers.toStr(p.content).trim() : mappers.toStr(item.content);
    if (!content) throw new AppError(ErrorCode.E_VALIDATION, '检查项内容不能为空');
    const ownerRole = p.ownerRole !== undefined && p.ownerRole !== null ? mappers.toStr(p.ownerRole).trim() : mappers.toStr(item.owner_role);

    db.prepare('UPDATE gate_checklist_items SET content = ?, owner_role = ? WHERE id = ?')
      .run(content, ownerRole, String(itemId));

    writeAudit(
      db, me, 'gate_item', String(itemId), 'update', projectId,
      '编辑检查项「' + content + '」',
      [],
    );
    return milestoneService.listMilestonesWithGate(db, projectId);
  });
  return tx();
}

/**
 * 删除 custom 检查项（template 项只读，抛 E_VALIDATION）。
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} itemId
 * @returns {Array<object>} MilestoneWithGate[]
 */
function deleteGateItem(db, req, itemId) {
  const tx = db.transaction(function () {
    const item = requireGateItemRow(db, itemId);
    if (mappers.toStr(item.source) !== 'custom') {
      throw new AppError(ErrorCode.E_VALIDATION, '模板检查项不可删除，仅可勾选');
    }
    const gate = requireGateRow(db, mappers.toStr(item.gate_id));
    const projectId = mappers.toStr(gate.project_id);
    rbac.assertWritable(db, projectId);
    const me = rbac.assertCan(db, req, 'milestone:edit', projectId);

    db.prepare('DELETE FROM gate_checklist_items WHERE id = ?').run(String(itemId));
    writeAudit(
      db, me, 'gate_item', String(itemId), 'delete', projectId,
      '删除检查项「' + mappers.toStr(item.content) + '」',
      [],
    );
    return milestoneService.listMilestonesWithGate(db, projectId);
  });
  return tx();
}

module.exports = {
  requireGateItemRow,
  requireGateRow,
  loadGateItems,
  toggleGateItem,
  decideGate,
  addGateItem,
  updateGateItem,
  deleteGateItem,
};
