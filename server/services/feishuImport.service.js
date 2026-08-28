/**
 * 飞书通讯录导入服务（两档三桶匹配模型 v2）。
 *
 * ⚠ 硬边界（与 user 表/登录链路/授权闸门/RBAC/业务流完全隔离）：
 *  - 铁证档：仅回填 union_id/name/dept/employee_id，**绝不**改 status/角色/密码/open_id。
 *  - 疑似档 merge：回填飞书 open_id/union_id + 同步无害字段（open_id 变更时级联更新业务引用表，
 *    与 admin.routes 的 open_id 改名逻辑同源）；**绝不**改 status/角色/密码。
 *  - 新建档：INSERT + 默认密码 + must_change_pwd=1；**绝不**触达 devlogin/RBAC/业务流/audit 写入逻辑。
 *  - 任何档都不调用 upsertFeishuUser、不改 users.open_id 的 UNIQUE 约束本身。
 */

const db = require('../../db');
const { nowIso } = require('../lib/dates');
const { hashPasswordSync } = require('../lib/password');
const { DEFAULT_PASSWORD } = require('../dal/seed');

/**
 * open_id 引用级联清单（与 admin.routes.js 的 USER_REFERENCE_CHECKS 同源）。
 * 仅在「疑似档 merge 导致 open_id 由占位值变为飞书真实 id」时用于保持引用完整性。
 */
const OPEN_ID_REFERENCE_CHECKS = [
  { table: 'project_members', col: 'user_open_id' },
  { table: 'approvals', col: 'approver_open_id' },
  { table: 'audit_logs', col: 'actor_open_id' },
  { table: 'reviews', col: 'initiator_open_id' },
  { table: 'review_steps', col: 'assignee_open_id' },
  { table: 'review_approvals', col: 'actor_open_id' },
  { table: 'work_reports', col: 'author_open_id' },
];

/**
 * 部门名拼接：飞书一个用户可挂多个部门，用 "/" 拼成单字符串存储（上限 60 字）。
 * 过滤空值，避免产生 "//" 或空串。
 */
function joinDeptNames(names) {
  if (!Array.isArray(names)) return '';
  return names
    .map(function (n) { return String(n || '').trim(); })
    .filter(Boolean)
    .join('/')
    .slice(0, 60);
}

/* ── 三桶分类 ───────────────────────────────────────── */

/**
 * 分类单条飞书联系人。
 * 优先级：铁证(open_id/union_id 命中) → 疑似(姓名或邮箱命中但 open_id/union_id 不一致) → 新建。
 * @param {object} contact 归一化 DTO {openId,unionId,name,email,employeeId,departmentNames}
 * @returns {{bucket:'definite'|'suspected'|'fresh', matchedLocalOpenId?:string, matchedBy?:'open_id'|'union_id'|'name'|'email', localUser?:object}}
 */
function classifyContact(contact) {
  const openId = String(contact.openId || '');
  const unionId = String(contact.unionId || '');
  const name = String(contact.name || '').trim();
  const email = String(contact.email || '').trim().toLowerCase();

  // 1) 铁证：本应用内 open_id 命中，或跨应用 union_id 命中
  if (openId) {
    const byOpen = db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId);
    if (byOpen) {
      return { bucket: 'definite', matchedLocalOpenId: byOpen.open_id, matchedBy: 'open_id', localUser: byOpen };
    }
  }
  if (unionId) {
    const byUnion = db.prepare("SELECT * FROM users WHERE union_id IS NOT NULL AND union_id <> '' AND union_id = ?").get(unionId);
    if (byUnion) {
      return { bucket: 'definite', matchedLocalOpenId: byUnion.open_id, matchedBy: 'union_id', localUser: byUnion };
    }
  }

  // 2) 疑似：姓名或邮箱命中（open_id/union_id 已确认不命中 → 必然不一致）
  if (name) {
    const byName = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
    if (byName) {
      return { bucket: 'suspected', matchedLocalOpenId: byName.open_id, matchedBy: 'name', localUser: byName };
    }
  }
  if (email) {
    const byEmail = db.prepare('SELECT * FROM users WHERE email IS NOT NULL AND email <> \'\' AND LOWER(email) = ?').get(email);
    if (byEmail) {
      return { bucket: 'suspected', matchedLocalOpenId: byEmail.open_id, matchedBy: 'email', localUser: byEmail };
    }
  }

  // 3) 新建
  return { bucket: 'fresh' };
}

/**
 * 批量分类（供预览/搜索结果展示）。
 * @param {Array<object>} contacts 归一化 DTO 数组
 * @returns {Array<object>} 每项附加 bucket / matchedLocalOpenId / matchedBy
 */
function classifyContacts(contacts) {
  return (contacts || []).map(function (c) {
    const r = classifyContact(c);
    return Object.assign({}, c, {
      bucket: r.bucket,
      matchedLocalOpenId: r.matchedLocalOpenId || null,
      matchedBy: r.matchedBy || null,
    });
  });
}

/* ── 各档执行 ─────────────────────────────────────── */

/**
 * 铁证档：回填无害字段（不含 open_id / status / 角色 / 密码）。
 * ⚠ 关键修正：飞书给空值时【绝不】覆盖本地已有值，只同步飞书非空字段。
 * 否则无部门归属的飞书联系人会把本地原有部门清空（已修复的线上 bug）。
 */
function backfillHarmless(localOpenId, contact, now) {
  const local = db.prepare('SELECT union_id, name, dept, employee_id FROM users WHERE open_id = ?').get(localOpenId);
  if (!local) return;
  const incomingUnion = String(contact.unionId || '').trim();
  const incomingName = String(contact.name || '').trim();
  const incomingDept = joinDeptNames(contact.departmentNames);
  const incomingEmp = String(contact.employeeId || '').trim();
  const finalUnion = incomingUnion || local.union_id || null;
  const finalName = incomingName ? incomingName.slice(0, 40) : local.name;
  const finalDept = incomingDept ? incomingDept : local.dept;
  const finalEmp = incomingEmp ? incomingEmp.slice(0, 40) : local.employee_id;
  db.prepare(
    'UPDATE users SET union_id = ?, name = ?, dept = ?, employee_id = ?, updated_at = ? WHERE open_id = ?',
  ).run(
    finalUnion,
    finalName,
    finalDept,
    finalEmp,
    now,
    localOpenId,
  );
}

/** 疑似档 merge：把飞书标识回填到本地账号 + 同步无害字段；open_id 变更时级联更新引用表。
 *  同样遵守：飞书给空值时不覆盖本地已有 name/dept/employee_id。 */
function mergeLocal(localOpenId, contact, now) {
  const newOpenId = String(contact.openId);
  const openIdChanged = newOpenId !== localOpenId;
  const local = db.prepare('SELECT union_id, name, dept, employee_id FROM users WHERE open_id = ?').get(localOpenId);
  const incomingUnion = String(contact.unionId || '').trim();
  const incomingName = String(contact.name || '').trim();
  const incomingDept = joinDeptNames(contact.departmentNames);
  const incomingEmp = String(contact.employeeId || '').trim();
  const finalUnion = incomingUnion || (local && local.union_id) || null;
  const finalName = incomingName ? incomingName.slice(0, 40) : (local && local.name);
  const finalDept = incomingDept ? incomingDept : (local && local.dept);
  const finalEmp = incomingEmp ? incomingEmp.slice(0, 40) : (local && local.employee_id);
  const tx = db.transaction(function () {
    if (openIdChanged) {
      OPEN_ID_REFERENCE_CHECKS.forEach(function (ref) {
        db.prepare('UPDATE ' + ref.table + ' SET ' + ref.col + ' = ? WHERE ' + ref.col + ' = ?').run(newOpenId, localOpenId);
      });
      db.prepare('UPDATE user_roles SET user_open_id = ? WHERE user_open_id = ?').run(newOpenId, localOpenId);
    }
    db.prepare(
      'UPDATE users SET open_id = ?, union_id = ?, name = ?, dept = ?, employee_id = ?, updated_at = ? WHERE open_id = ?',
    ).run(
      newOpenId,
      finalUnion,
      finalName,
      finalDept,
      finalEmp,
      now,
      localOpenId,
    );
  });
  tx();
}

/** 新建档：插入新用户（默认密码 + 待改密 + member 角色 + 指定状态） */
function createLocalUserFromContact(contact, status, now) {
  const openId = String(contact.openId);
  const email = String(contact.email || '').trim().toLowerCase() || null;
  const finalStatus = status === 'active' ? 'active' : 'pending';
  const tx = db.transaction(function () {
    db.prepare(
      'INSERT INTO users (open_id, union_id, employee_id, name, email, dept, global_role, status, created_at, updated_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      openId,
      contact.unionId || null,
      String(contact.employeeId || '').slice(0, 40),
      String(contact.name || '').trim().slice(0, 40),
      email,
      joinDeptNames(contact.departmentNames),
      'member',
      finalStatus,
      now,
      now,
    );
    const hashed = hashPasswordSync(DEFAULT_PASSWORD);
    db.prepare('UPDATE users SET password_hash = ?, must_change_pwd = 1, updated_at = ? WHERE open_id = ?').run(hashed, now, openId);
  });
  tx();
}

/* ── 导入主流程 ─────────────────────────────────────── */

/**
 * 执行导入：对每条联系人分类后按决策执行。
 * @param {Array<object>} contacts 归一化 DTO 数组（通常由 getFullContacts / searchUsersByName 提供）
 * @param {Object<string,'merge'|'skip'>} [decisions] 疑似档决策表，键=飞书 open_id
 * @param {'pending'|'active'} [initialStatus='pending'] 新建档初始状态
 * @returns {{added:number, merged:number, skipped:number, failed:number, details:Array<object>}}
 */
function importContacts(contacts, decisions, initialStatus) {
  const result = { added: 0, merged: 0, skipped: 0, failed: 0, details: [] };
  const now = nowIso();
  const dec = decisions || {};
  (contacts || []).forEach(function (contact) {
    const openId = String(contact.openId || '');
    const name = contact.name || openId;
    try {
      const c = classifyContact(contact);
      if (c.bucket === 'definite') {
        backfillHarmless(c.matchedLocalOpenId, contact, now);
        result.skipped += 1;
        result.details.push({ openId: openId, name: name, result: 'skipped', bucket: 'definite', synced: true });
      } else if (c.bucket === 'suspected') {
        const decision = dec[openId] === 'merge' ? 'merge' : 'skip';
        if (decision === 'merge') {
          mergeLocal(c.matchedLocalOpenId, contact, now);
          result.merged += 1;
          result.details.push({ openId: openId, name: name, result: 'merged', bucket: 'suspected', matchedLocalOpenId: c.matchedLocalOpenId, matchedBy: c.matchedBy });
        } else {
          result.skipped += 1;
          result.details.push({ openId: openId, name: name, result: 'skipped', bucket: 'suspected', matchedLocalOpenId: c.matchedLocalOpenId, matchedBy: c.matchedBy, reason: '管理员未选择合并（默认跳过）' });
        }
      } else {
        createLocalUserFromContact(contact, initialStatus, now);
        result.added += 1;
        result.details.push({ openId: openId, name: name, result: 'added', bucket: 'fresh', status: initialStatus === 'active' ? 'active' : 'pending' });
      }
    } catch (e) {
      result.failed += 1;
      result.details.push({ openId: openId, name: name, result: 'failed', reason: (e && e.message) || String(e) });
    }
  });
  return result;
}

module.exports = {
  classifyContact,
  classifyContacts,
  importContacts,
  // 供单测/复用
  backfillHarmless,
  mergeLocal,
  createLocalUserFromContact,
};
