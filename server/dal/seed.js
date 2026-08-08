/**
 * 幂等种子数据
 *
 * 负责两件事（**只补不覆盖**，重复启动安全）：
 *  1. 10 个演示账号（与前端 `web/src/config/demoAccounts.ts` 一一对应）
 *     —— 开发登录 `POST /api/auth/devlogin` 依赖它们存在，否则登录页选谁都 404。
 *  2. A / B / C 三套生命周期模板 —— `GET /api/meta` 与 `createProject` 依赖。
 *
 * 规则：
 *  - 用户按 open_id 幂等：已存在**不改角色**（管理员改过的角色不能被启动流程覆盖）
 *  - 模板按 id 幂等：已存在且版本相同则跳过；版本变高则更新定义（模板演进）
 *  - `ADMIN_OPEN_IDS` 里的 open_id 若已在库中且不是 admin，则提升为 admin
 */
const cfg = require('../../config');
const { createTemplates } = require('../config/lifecycle');
const { nowIso } = require('../lib/dates');

/**
 * 演示账号（与前端 demoAccounts.ts 逐字对齐）
 * @type {{openId: string, employeeId: string, name: string, globalRole: string, dept: string}[]}
 */
const DEMO_ACCOUNTS = [
  { openId: 'ou_xuwenbin01', employeeId: 'E1001', name: '徐文斌', globalRole: 'admin', dept: '项目管理部' },
  { openId: 'ou_liming03', employeeId: 'E1003', name: '李明', globalRole: 'pm', dept: '项目管理部' },
  { openId: 'ou_zhangmin04', employeeId: 'E1004', name: '张敏', globalRole: 'pmo', dept: 'PMO' },
  { openId: 'ou_wangqiang02', employeeId: 'E1002', name: '王强', globalRole: 'tl', dept: '研发中心' },
  { openId: 'ou_chenjing05', employeeId: 'E1005', name: '陈静', globalRole: 'qa', dept: '质量部' },
  { openId: 'ou_sunyue07', employeeId: 'E1007', name: '孙悦', globalRole: 'po', dept: '产品部' },
  { openId: 'ou_zhoutao08', employeeId: 'E1008', name: '周涛', globalRole: 'management', dept: '公司管理层' },
  { openId: 'ou_zhaolei06', employeeId: 'E1006', name: '赵磊', globalRole: 'cm', dept: '配置管理组' },
  { openId: 'ou_wudi09', employeeId: 'E1009', name: '吴迪', globalRole: 'member', dept: '研发中心' },
  { openId: 'ou_zhengshuang10', employeeId: 'E1010', name: '郑爽', globalRole: 'member', dept: '研发中心' },
];

/**
 * 写入演示账号（幂等）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} ts ISO 时间戳
 * @returns {number} 新增条数
 */
function seedUsers(db, ts) {
  const exists = db.prepare('SELECT open_id FROM users WHERE open_id = ?');
  const insert = db.prepare(`
    INSERT INTO users (open_id, employee_id, name, email, dept, avatar_url, global_role, status, created_at, updated_at)
    VALUES (@open_id, @employee_id, @name, NULL, @dept, NULL, @global_role, 'active', @created_at, @updated_at)
  `);

  let added = 0;
  DEMO_ACCOUNTS.forEach(function (a) {
    if (exists.get(a.openId)) return;
    insert.run({
      open_id: a.openId,
      employee_id: a.employeeId,
      name: a.name,
      dept: a.dept,
      global_role: a.globalRole,
      created_at: ts,
      updated_at: ts,
    });
    added += 1;
  });
  return added;
}

/**
 * 把 ADMIN_OPEN_IDS 配置里的用户提升为管理员（幂等）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} ts ISO 时间戳
 * @returns {number} 实际提升条数
 */
function promoteConfiguredAdmins(db, ts) {
  if (!cfg.ADMIN_OPEN_IDS.length) return 0;
  const upd = db.prepare(
    "UPDATE users SET global_role = 'admin', updated_at = ? WHERE open_id = ? AND global_role <> 'admin'"
  );
  let n = 0;
  cfg.ADMIN_OPEN_IDS.forEach(function (openId) {
    n += upd.run(ts, openId).changes;
  });
  return n;
}

/**
 * 写入 / 升级生命周期模板（幂等）。
 * @param {import('better-sqlite3').Database} db
 * @param {string} ts ISO 时间戳
 * @returns {{added: number, upgraded: number}}
 */
function seedTemplates(db, ts) {
  const find = db.prepare('SELECT id, version FROM lifecycle_templates WHERE id = ?');
  const insert = db.prepare(`
    INSERT INTO lifecycle_templates (id, project_type, version, name, definition, is_active, created_at)
    VALUES (@id, @project_type, @version, @name, @definition, @is_active, @created_at)
  `);
  const update = db.prepare(`
    UPDATE lifecycle_templates
       SET project_type = @project_type, version = @version, name = @name,
           definition = @definition, is_active = @is_active
     WHERE id = @id
  `);

  let added = 0;
  let upgraded = 0;

  createTemplates().forEach(function (t) {
    const row = {
      id: t.id,
      project_type: t.projectType,
      version: t.version,
      name: t.name,
      definition: JSON.stringify(t.definition),
      is_active: t.isActive ? 1 : 0,
      created_at: ts,
    };
    const exist = find.get(t.id);
    if (!exist) {
      insert.run(row);
      added += 1;
      return;
    }
    if (Number(exist.version) < Number(t.version)) {
      update.run(row);
      upgraded += 1;
    }
  });

  return { added: added, upgraded: upgraded };
}

/**
 * 执行全部种子写入（在单事务内，失败整体回滚）。
 * @param {import('better-sqlite3').Database} db
 * @returns {{users: number, admins: number, templates: {added: number, upgraded: number}}}
 */
function run(db) {
  const ts = nowIso();
  let result = { users: 0, admins: 0, templates: { added: 0, upgraded: 0 } };

  const tx = db.transaction(function () {
    result = {
      users: seedUsers(db, ts),
      admins: promoteConfiguredAdmins(db, ts),
      templates: seedTemplates(db, ts),
    };
  });
  tx();

  if (result.users || result.admins || result.templates.added || result.templates.upgraded) {
    console.log(
      '[seed] users +%d, admins +%d, templates +%d (upgraded %d)',
      result.users,
      result.admins,
      result.templates.added,
      result.templates.upgraded
    );
  }
  return result;
}

module.exports = { run, DEMO_ACCOUNTS };
