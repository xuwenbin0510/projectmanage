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
 * 清理历史脏数据（幂等，可重复执行）。
 *
 * 背景（B14 QA 数据质量警示）：演示库出现过一条「幻影管理员」
 * `open_id='dev_徐文斌'`（与 `projects.pm` 脏值同源，非真实账号，
 * 全局角色被置为 admin）。它会经由 `resolveConfirmers` 的
 * `users WHERE global_role='admin'` 升级路径被纳入确认人集合，导致
 * 「作者即 admin」的周报确认人退化为 `["dev_徐文斌"]`，真实 admin 反而看不到
 * 待确认项。本函数一次性收敛：
 *
 *  1. 删除幻影用户 `dev_徐文斌` 及其全部成员关系（幂等）；
 *  2. 收敛脏 `projects.pm`：非合法 open_id 的脏值改写为种子主管理员
 *     `ou_xuwenbin01`（与「确认人权威源 = project_members」纪律一致）；
 *  3. 为「pm 合法但缺 pm 成员」的项目补一条 pm 成员，修复第 1 步删除后留下的空缺
 *     （仅补缺、不重复插入，避免覆盖已被 UI 改派的 pm 成员）。
 *
 * 注：本清理只处理已知幻影值，不泛化删除未知用户，避免误删真实数据。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} ts ISO 时间戳
 * @returns {number} 本次清理变动条数（用于日志，0 表示无脏数据）
 */
function cleanupDirtyData(db, ts) {
  const PHANTOM = 'dev_徐文斌';
  const DEFAULT_ADMIN = 'ou_xuwenbin01';

  let changed = 0;

  /* 1. 删除幻影管理员及其成员关系 */
  changed += db.prepare('DELETE FROM project_members WHERE user_open_id = ?').run(PHANTOM).changes;
  changed += db.prepare('DELETE FROM users WHERE open_id = ?').run(PHANTOM).changes;

  /* 2. 收敛脏 projects.pm（非合法 open_id → 主管理员） */
  changed += db
    .prepare(
      "UPDATE projects SET pm = ? WHERE pm IS NOT NULL AND pm <> '' AND pm NOT IN (SELECT open_id FROM users)"
    )
    .run(DEFAULT_ADMIN).changes;

  /* 3. 为「pm 合法但缺 pm 成员」的项目补缺（仅 INSERT OR IGNORE，不覆盖既有成员） */
  const gap = db
    .prepare(
      `SELECT p.id AS pid, p.pm AS pm FROM projects p
       WHERE p.pm IS NOT NULL AND p.pm <> ''
         AND p.pm IN (SELECT open_id FROM users)
         AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.project_role = 'pm')`
    )
    .all();
  if (gap.length) {
    const insMember = db.prepare(`
      INSERT OR IGNORE INTO project_members (id, project_id, user_open_id, project_role, assigned_by, assigned_at)
      VALUES (?, ?, ?, 'pm', ?, ?)
    `);
    gap.forEach(function (p) {
      insMember.run(p.pid + '-MB1', p.pid, p.pm, p.pm, ts);
    });
    changed += gap.length;
  }

  /* 4. 演示闭环打磨（非阻塞）：确保「pm 即 admin」的项目存在一名非 admin 本人的真实 TL。
   *    周报确认人在「作者即 pm（或项目无 pm）」时会升级到 `tl ∪ admin`，
   *    并恒剔除作者本人（禁止自确认，架构纪律）。
   *    若作者恰为 sole-admin 兼 pm、且项目 TL 仅有作者自己（或无'别人'当 TL），
   *    升级路径剔除作者后确认人会退化为空集 → 演示闭环断裂
   *    （本项即 QA 复验观察到的 Pmslkpu9a00dx 7 条周报确认人空集：其 pm 与 tl 都是 ou_xuwenbin01）。
   *    此处对「pm 为合法 admin、且不存在任何 tl 成员 ≠ 该 admin」的项目幂等补一名
   *    真实非幻影、非 admin 成员（ou_wudi09，研发普通成员）作为 TL，
   *    使升级路径至少落到一个真实确认人（目标态 tl={ou_xuwenbin01, ou_wudi09}，确认人=[ou_wudi09]）。
   *    仅 INSERT OR IGNORE，不覆盖既有成员、不改动确认/打回逻辑与禁止自确认纪律。 */
  const TL_FILLER = 'ou_wudi09';
  const tlGap = db
    .prepare(
      `SELECT p.id AS pid FROM projects p
       WHERE p.pm IS NOT NULL AND p.pm <> ''
         AND p.pm IN (SELECT open_id FROM users WHERE global_role = 'admin')
         AND NOT EXISTS (
           SELECT 1 FROM project_members m
           WHERE m.project_id = p.id AND m.project_role = 'tl'
             AND m.user_open_id <> p.pm
         )`
    )
    .all();
  if (tlGap.length) {
    const insTl = db.prepare(`
      INSERT OR IGNORE INTO project_members (id, project_id, user_open_id, project_role, assigned_by, assigned_at)
      VALUES (?, ?, ?, 'tl', ?, ?)
    `);
    tlGap.forEach(function (p) {
      insTl.run(p.pid + '-TL1', p.pid, TL_FILLER, TL_FILLER, ts);
    });
    changed += tlGap.length;
  }

  return changed;
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
    /* 种子落定后再做脏数据收敛（依赖 users 已就绪） */
    const cleaned = cleanupDirtyData(db, ts);
    if (cleaned) {
      console.log('[seed] cleanup removed/converged %d dirty rows', cleaned);
    }
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
