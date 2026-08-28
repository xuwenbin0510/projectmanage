/**
 * 版本化数据库迁移（契约 §5）
 *
 * 取代原来散落在 db.js 里的「手写 PRAGMA table_info 探测 + ALTER」：
 *   - `schema_migrations` 记录已应用版本，重复启动幂等
 *   - 每个迁移在**单个事务**内执行，失败整体回滚，不会留半截 schema
 *   - 需要重建表时按 SQLite 官方 12 步流程：先关外键 → 事务内重建 → 恢复外键
 *
 * ⚠ 列名禁用 SQLite 关键字（决策 D-10）：
 *   里程碑的「当前计划日期」列名是 `planned_date`，对外 API 字段是 `currentDate`。
 */

/* ── 内省辅助 ─────────────────────────────────────── */

/**
 * 判断表是否存在。
 * @param {import('better-sqlite3').Database} db
 * @param {string} table 表名
 * @returns {boolean}
 */
function tableExists(db, table) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return !!row;
}

/**
 * 取表的列名列表；表不存在时返回空数组。
 * @param {import('better-sqlite3').Database} db
 * @param {string} table 表名
 * @returns {string[]}
 */
function columnsOf(db, table) {
  if (!tableExists(db, table)) return [];
  return db.prepare('PRAGMA table_info(' + table + ')').all().map(function (c) {
    return c.name;
  });
}

/**
 * 判断列是否存在。
 * @param {import('better-sqlite3').Database} db
 * @param {string} table 表名
 * @param {string} column 列名
 * @returns {boolean}
 */
function hasColumn(db, table, column) {
  return columnsOf(db, table).indexOf(column) >= 0;
}

/** 合法角色键（单一来源 = server/config/roles-catalog.js 的 ROLE_CATALOG；此处内联避免迁移层依赖业务层） */
const { ROLE_CATALOG } = require('../config/roles-catalog');
const VALID_ROLE_KEYS = ROLE_CATALOG.map(function (r) { return r[0]; });

/** 权限矩阵默认源（server/config/permissions.js 的 DEFAULT_PERMISSIONS）：v18 种子唯一写入源 */
const { DEFAULT_PERMISSIONS } = require('../config/permissions');

/** 允许的项目状态（与 enums.PROJECT_STATUSES 一致） */
const VALID_PROJECT_STATUSES = [
  '草稿', '审批中', '已批准', '进行中', '挂起', '已结项', '已终止', '已驳回',
];

/**
 * 遗留项目类别（中文）→ 新契约 ProjectType（A / B / C）。
 * 旧值形如 'A类（交付类）' / 'B类（产品迭代）' / 'C类（基建类）'，取首字母即可。
 * @param {string|null|undefined} legacyType
 * @returns {'A'|'B'|'C'}
 */
function normalizeProjectType(legacyType) {
  const s = String(legacyType || '').trim().toUpperCase();
  if (s.charAt(0) === 'A') return 'A';
  if (s.charAt(0) === 'C') return 'C';
  return 'B';
}

/**
 * 遗留金额（TEXT，可能带「万」等后缀）→ 数值（万元）。
 * @param {*} raw
 * @returns {number}
 */
function normalizeAmount(raw) {
  if (raw === null || raw === undefined) return 0;
  const m = String(raw).match(/-?\d+(\.\d+)?/);
  if (!m) return 0;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 遗留 goal（可能是 `{text,progress,target}` 对象 JSON / 纯文本）→ 新契约 `string[]` 的 JSON 串。
 * @param {*} raw
 * @returns {string} JSON 字符串
 */
function normalizeGoal(raw) {
  if (raw === null || raw === undefined || raw === '') return '[]';
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch (e) {
      return JSON.stringify([String(raw)]);
    }
  }
  if (Array.isArray(v)) {
    return JSON.stringify(v.map(function (x) {
      return typeof x === 'string' ? x : String(x && x.text ? x.text : JSON.stringify(x));
    }).filter(Boolean));
  }
  if (v && typeof v === 'object') {
    const text = v.text || v.target || '';
    return JSON.stringify(text ? [String(text)] : []);
  }
  return JSON.stringify([String(v)]);
}

/* ── 迁移 v1：Connect v1 基线 ─────────────────────── */

/**
 * v1 = 「遗留基线表」+「新契约表结构」一次到位。
 *
 * 拆解：
 *  1. 遗留表（tasks / reports / report_tasks / approvals）—— 原 db.js 的 DDL 平移过来，
 *     供 @deprecated 老路由与 devcheck / test_runner 继续使用（决策 D-9）。
 *  2. users 重建：role → global_role，补 email / dept / avatar_url / status / updated_at
 *  3. lifecycle_templates 新建
 *  4. projects 重建：补分类/健康度/计划区间/模板/软删等列，type 中文 → A/B/C
 *  5. project_members 新建（并从遗留 projects.pm 回填一条 pm 成员）
 *  6. milestones 重建：code/target/required/baseline_date/planned_date/done_at/... （done、status 为派生值，不落库）
 *  7. quality_gates / gate_checklist_items 新建
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳
 */
function migrationV1(db, now) {
  /* ---------- 1. projects（先建/重建，后续表都外键指向它） ---------- */

  const legacyProjects = tableExists(db, 'projects') && !hasColumn(db, 'projects', 'health')
    ? db.prepare('SELECT * FROM projects').all()
    : null;

  if (legacyProjects || !tableExists(db, 'projects')) {
    if (legacyProjects) db.exec('DROP TABLE projects');
    db.exec(`
      CREATE TABLE projects (
        id                       TEXT PRIMARY KEY,
        code                     TEXT,
        name                     TEXT NOT NULL,
        type                     TEXT NOT NULL DEFAULT 'B',
        classify_input           TEXT,
        classify_suggested       TEXT,
        classify_override_reason TEXT,
        customer                 TEXT,
        contract_amount          REAL NOT NULL DEFAULT 0,
        amount                   TEXT,
        background               TEXT,
        goal                     TEXT NOT NULL DEFAULT '[]',
        status                   TEXT NOT NULL DEFAULT '草稿',
        health                   TEXT NOT NULL DEFAULT 'green',
        plan_start               TEXT,
        plan_end                 TEXT,
        actual_end               TEXT,
        approval_step            INTEGER NOT NULL DEFAULT -1,
        template_id              TEXT,
        pm                       TEXT,
        approved_by              TEXT,
        created_by               TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL,
        deleted_at               TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
      CREATE INDEX IF NOT EXISTS idx_projects_type ON projects(type);
      CREATE INDEX IF NOT EXISTS idx_projects_deleted ON projects(deleted_at);
    `);

    if (legacyProjects && legacyProjects.length) {
      const ins = db.prepare(`
        INSERT INTO projects (
          id, code, name, type, customer, contract_amount, amount, background, goal,
          status, health, approval_step, pm, approved_by, created_by, created_at, updated_at
        ) VALUES (
          @id, @code, @name, @type, @customer, @contract_amount, @amount, @background, @goal,
          @status, @health, @approval_step, @pm, @approved_by, @created_by, @created_at, @updated_at
        )
      `);
      legacyProjects.forEach(function (p) {
        const status = VALID_PROJECT_STATUSES.indexOf(p.status) >= 0 ? p.status : '草稿';
        ins.run({
          id: p.id,
          code: p.code || null,
          name: p.name || '(未命名项目)',
          type: normalizeProjectType(p.type),
          customer: p.customer || null,
          contract_amount: normalizeAmount(p.amount),
          amount: p.amount === undefined ? null : p.amount,
          background: p.background || null,
          goal: normalizeGoal(p.goal),
          status: status,
          health: 'green',
          approval_step: Number.isFinite(p.approval_step) ? p.approval_step : -1,
          pm: p.pm || null,
          approved_by: p.approved_by || null,
          created_by: p.created_by || null,
          created_at: p.created_at || now,
          updated_at: p.updated_at || p.created_at || now,
        });
      });
    }
  }

  /* ---------- 2. users ---------- */

  const legacyUsers = tableExists(db, 'users') && !hasColumn(db, 'users', 'global_role')
    ? db.prepare('SELECT * FROM users').all()
    : null;

  if (legacyUsers || !tableExists(db, 'users')) {
    if (legacyUsers) db.exec('DROP TABLE users');
    db.exec(`
      CREATE TABLE users (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        open_id     TEXT UNIQUE NOT NULL,
        union_id    TEXT,
        employee_id TEXT,
        name        TEXT NOT NULL,
        email       TEXT,
        dept        TEXT,
        avatar_url  TEXT,
        global_role TEXT NOT NULL DEFAULT 'member',
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(global_role);
    `);

    if (legacyUsers && legacyUsers.length) {
      const ins = db.prepare(`
        INSERT INTO users (id, open_id, employee_id, name, global_role, status, created_at, updated_at)
        VALUES (@id, @open_id, @employee_id, @name, @global_role, 'active', @created_at, @updated_at)
      `);
      legacyUsers.forEach(function (u) {
        const role = VALID_ROLE_KEYS.indexOf(u.role) >= 0 ? u.role : 'member';
        ins.run({
          id: u.id,
          open_id: u.open_id,
          employee_id: u.employee_id || null,
          name: u.name || u.open_id,
          global_role: role,
          created_at: u.created_at || now,
          updated_at: u.created_at || now,
        });
      });
    }
  }

  /* ---------- 3. lifecycle_templates ---------- */

  db.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_templates (
      id           TEXT PRIMARY KEY,
      project_type TEXT NOT NULL,
      version      INTEGER NOT NULL DEFAULT 1,
      name         TEXT NOT NULL,
      definition   TEXT NOT NULL,
      is_active    INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lifecycle_templates_type
      ON lifecycle_templates(project_type, is_active);
  `);

  /* ---------- 4. project_members ---------- */

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_members (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_open_id TEXT NOT NULL,
      project_role TEXT NOT NULL,
      assigned_by  TEXT,
      assigned_at  TEXT NOT NULL,
      UNIQUE (project_id, user_open_id, project_role)
    );
    CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_open_id);
  `);

  // 从遗留 projects.pm 回填一条 pm 成员，保证老数据在新契约下也能显示负责人
  // ⚠️ 数据纪律（架构 §1.3 / SK-B14-2）：只回填「合法 open_id」的 pm；
  //    脏值（如历史 "dev_徐文斌"，非真实账号）一律跳过，禁止生成指向幽灵账号的成员行。
  const pmRows = db
    .prepare("SELECT id, pm, created_by, created_at FROM projects WHERE pm IS NOT NULL AND pm <> ''")
    .all();
  const validUserStmt = db.prepare('SELECT 1 FROM users WHERE open_id = ?');
  const insMember = db.prepare(`
    INSERT OR IGNORE INTO project_members (id, project_id, user_open_id, project_role, assigned_by, assigned_at)
    VALUES (?, ?, ?, 'pm', ?, ?)
  `);
  pmRows.forEach(function (p) {
    if (!p.pm || !validUserStmt.get(p.pm)) return; // 脏 pm 值不回填（避免幽灵 pm 成员）
    insMember.run(p.id + '-MB1', p.id, p.pm, p.created_by || null, p.created_at || now);
  });

  /* ---------- 5. milestones（重建） ---------- */

  const legacyMilestones = tableExists(db, 'milestones') && !hasColumn(db, 'milestones', 'planned_date')
    ? db.prepare('SELECT * FROM milestones').all()
    : null;

  if (legacyMilestones || !tableExists(db, 'milestones')) {
    if (legacyMilestones) db.exec('DROP TABLE milestones');
    // 说明：status / done 是**派生值**（rules.deriveMilestoneStatus），不落库，
    //      避免出现「库里写 已达成、算出来 已逾期」的双真源。
    db.exec(`
      CREATE TABLE milestones (
        id                 TEXT PRIMARY KEY,
        project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        code               TEXT,
        name               TEXT NOT NULL,
        target             TEXT,
        required           INTEGER NOT NULL DEFAULT 0,
        baseline_date      TEXT,
        planned_date       TEXT,
        done_at            TEXT,
        done_by            TEXT,
        status_override    TEXT,
        override_by        TEXT,
        override_at        TEXT,
        override_base_date TEXT,
        last_change_id     TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);
      CREATE INDEX IF NOT EXISTS idx_milestones_planned ON milestones(project_id, planned_date);
    `);

    if (legacyMilestones && legacyMilestones.length) {
      const ins = db.prepare(`
        INSERT INTO milestones (
          id, project_id, code, name, required, baseline_date, planned_date,
          done_at, created_at, updated_at
        ) VALUES (
          @id, @project_id, @code, @name, 0, @baseline_date, @planned_date,
          @done_at, @created_at, @updated_at
        )
      `);
      // 遗留表无 code，按项目内顺序补 M1/M2/...
      const seqByProject = {};
      legacyMilestones.forEach(function (m) {
        const pid = m.project_id;
        seqByProject[pid] = (seqByProject[pid] || 0) + 1;
        ins.run({
          id: m.id,
          project_id: pid,
          code: 'M' + seqByProject[pid],
          name: m.name || '(未命名里程碑)',
          baseline_date: m.due || null,
          planned_date: m.due || null,
          done_at: Number(m.done) === 1 ? (m.created_at || now) : null,
          created_at: m.created_at || now,
          updated_at: m.created_at || now,
        });
      });
    }
  }

  /* ---------- 6. quality_gates / gate_checklist_items ---------- */

  db.exec(`
    CREATE TABLE IF NOT EXISTS quality_gates (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
      code         TEXT NOT NULL,
      name         TEXT NOT NULL,
      owner_role   TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT '未开始',
      conclusion   TEXT,
      comment      TEXT,
      decided_by   TEXT,
      decided_at   TEXT,
      created_at   TEXT NOT NULL,
      UNIQUE (project_id, milestone_id)
    );
    CREATE INDEX IF NOT EXISTS idx_quality_gates_project ON quality_gates(project_id);

    CREATE TABLE IF NOT EXISTS gate_checklist_items (
      id         TEXT PRIMARY KEY,
      gate_id    TEXT NOT NULL REFERENCES quality_gates(id) ON DELETE CASCADE,
      seq        INTEGER NOT NULL DEFAULT 0,
      content    TEXT NOT NULL,
      owner_role TEXT,
      checked    INTEGER NOT NULL DEFAULT 0,
      checked_by TEXT,
      checked_at TEXT,
      source     TEXT NOT NULL DEFAULT 'template'
    );
    CREATE INDEX IF NOT EXISTS idx_gate_items_gate ON gate_checklist_items(gate_id, seq);
  `);

  /* ---------- 7. 遗留基线表（原 db.js DDL，供 @deprecated 老路由使用 · D-9） ---------- */
  // 注：tasks / reports / report_tasks 三张旧表已在 v20 清理迁移中彻底移除
  // （分别被 wbs_nodes / work_reports / work_report_tasks 取代，且 legacy 对应路由已删除），
  // 此处不再重建，避免历史垃圾表复生。

  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      step_index       INTEGER NOT NULL,
      step_role        TEXT NOT NULL,
      approver_open_id TEXT,
      approver_name    TEXT,
      action           TEXT NOT NULL,
      comment          TEXT,
      created_at       TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_project ON approvals(project_id);
  `);
}

/* ── 迁移 v2：B3 WBS / 看板 / 审计 ────────────────── */

/**
 * 遗留 `tasks.status` → 新契约 `TaskStatus`。
 * ⚠ 与 `server/config/enums.js` 的 `LEGACY_TASK_STATUS_MAP` 逐字一致；
 *   此处内联是沿用本文件既有约定（迁移层不依赖业务层，见 VALID_ROLE_KEYS）。
 */
const LEGACY_TASK_STATUS_TO_TASK_STATUS = {
  待开始: '待办',
  未开始: '待办',
  待办: '待办',
  进行中: '进行中',
  待评审: '待评审',
  评审中: '待评审',
  已完成: '完成',
  完成: '完成',
  阻塞: '阻塞',
  已阻塞: '阻塞',
};

/**
 * v2 = 批次 3 所需的三张表 + 遗留 `tasks` 的**单向**搬运。
 *
 * 拆解：
 *  1. `wbs_nodes`     WBS 节点（看板卡片同源，SK-4 叶子 = 无子节点）
 *  2. `board_configs` 看板列 / WIP 配置（每项目一行，懒创建）
 *  3. `audit_logs`    审计流水（主理人 Q1 决策：与 B3 同批建表）
 *  4. `tasks` → `wbs_nodes` 单向搬运（**不删** tasks，@deprecated 老路由还在用 · D-9）
 *
 * 幂等性：
 *  - 三张表一律 `CREATE TABLE IF NOT EXISTS`
 *  - 搬运只在「wbs_nodes 为空 且 tasks 有行」时执行一次
 *
 * ⚠ 列名禁用 SQLite 关键字（D-10）：对外 `boardOrder` ↔ 库内 `board_order`。
 * ⚠ 本函数由 `run()` 包在事务里执行，**不得**自行 BEGIN / COMMIT。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳
 */
function migrationV2(db, now) {
  /* ---------- 1. wbs_nodes ---------- */

  db.exec(`
    CREATE TABLE IF NOT EXISTS wbs_nodes (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_id     TEXT,
      wbs_code      TEXT NOT NULL DEFAULT '1',
      level         INTEGER NOT NULL DEFAULT 1,
      node_type     TEXT NOT NULL DEFAULT 'task',
      name          TEXT NOT NULL,
      description   TEXT,
      owner         TEXT,
      estimate_days REAL NOT NULL DEFAULT 0,
      actual_days   REAL NOT NULL DEFAULT 0,
      start_date    TEXT,
      due_date      TEXT,
      status        TEXT NOT NULL DEFAULT '待办',
      progress      INTEGER NOT NULL DEFAULT 0,
      board_order   INTEGER NOT NULL DEFAULT 0,
      is_critical   INTEGER NOT NULL DEFAULT 0,
      milestone_id  TEXT,
      created_by    TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wbs_nodes_project ON wbs_nodes(project_id);
    CREATE INDEX IF NOT EXISTS idx_wbs_nodes_parent ON wbs_nodes(parent_id);
    CREATE INDEX IF NOT EXISTS idx_wbs_nodes_milestone ON wbs_nodes(milestone_id);
    CREATE INDEX IF NOT EXISTS idx_wbs_nodes_board ON wbs_nodes(project_id, status, board_order);
  `);

  /* ---------- 2. board_configs ---------- */

  db.exec(`
    CREATE TABLE IF NOT EXISTS board_configs (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      columns    TEXT NOT NULL DEFAULT '[]',
      wip_limits TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
  `);

  /* ---------- 3. audit_logs（主理人 Q1 决策：B3 同批建表） ---------- */

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id             TEXT PRIMARY KEY,
      project_id     TEXT,
      entity_type    TEXT NOT NULL,
      entity_id      TEXT NOT NULL,
      action         TEXT NOT NULL,
      actor_open_id  TEXT,
      actor_name     TEXT,
      summary        TEXT,
      diff           TEXT NOT NULL DEFAULT '[]',
      before_json    TEXT,
      after_json     TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_project ON audit_logs(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
  `);

  /* ---------- 4. tasks → wbs_nodes 单向搬运（幂等） ---------- */

  const existing = db.prepare('SELECT COUNT(*) AS c FROM wbs_nodes').get();
  if (existing && existing.c > 0) return; // 已有 WBS 数据：跳过搬运
  if (!tableExists(db, 'tasks')) return;

  const legacyTasks = db
    .prepare('SELECT rowid AS rid, * FROM tasks ORDER BY project_id, created_at, rowid')
    .all();
  if (!legacyTasks.length) return;

  // 合法里程碑：(project_id, id) 组合，防止把脏 ms_id 搬成悬空外键
  const msKeys = new Set(
    db.prepare('SELECT id, project_id FROM milestones').all().map(function (m) {
      return m.project_id + '|' + m.id;
    })
  );

  const insNode = db.prepare(`
    INSERT INTO wbs_nodes (
      id, project_id, parent_id, wbs_code, level, node_type, name, description,
      owner, estimate_days, actual_days, start_date, due_date, status, progress,
      board_order, is_critical, milestone_id, created_by, created_at, updated_at
    ) VALUES (
      @id, @project_id, NULL, @wbs_code, 1, 'task', @name, '',
      @owner, @estimate_days, @actual_days, @start_date, @due_date, @status, @progress,
      @board_order, @is_critical, @milestone_id, NULL, @created_at, @updated_at
    )
  `);

  /** 每个项目内的顺序号（补 wbs_code 与 board_order） */
  const seqByProject = {};

  legacyTasks.forEach(function (t) {
    const pid = t.project_id;
    seqByProject[pid] = (seqByProject[pid] || 0) + 1;
    const seq = seqByProject[pid];

    const rawCode = String(t.code === null || t.code === undefined ? '' : t.code).trim();
    const progress = Number.isFinite(Number(t.progress)) ? Math.max(0, Math.min(100, Number(t.progress))) : 0;
    const estimateDays = normalizeAmount(t.est);
    const msId = t.ms_id && msKeys.has(pid + '|' + t.ms_id) ? t.ms_id : null;
    const status = LEGACY_TASK_STATUS_TO_TASK_STATUS[String(t.status || '').trim()] || '待办';

    insNode.run({
      id: t.id,
      project_id: pid,
      wbs_code: rawCode || String(seq),
      name: t.name || '(未命名任务)',
      owner: t.owner || null,
      estimate_days: estimateDays,
      actual_days: Number(((estimateDays * progress) / 100).toFixed(1)),
      start_date: t.start || null,
      due_date: t.due || null,
      status: status,
      progress: progress,
      board_order: seq - 1,
      is_critical: Number(t.crit) === 1 ? 1 : 0,
      milestone_id: msId,
      created_at: t.created_at || now,
      updated_at: t.created_at || now,
    });
  });

  console.log('[migrations] v2 迁移遗留任务 %d 条 → wbs_nodes', legacyTasks.length);
}

/* ── v3：结构化周报（B4 · T02-1） ───────────────────── */

/**
 * 迁移 v3：建结构化周报三张表。
 *
 * 表名统一带 `work_` 前缀（偏差 D-1）：v1 遗留 `reports` 表是扁平旧 schema
 * （week/author/done/plan/risk/risk_due/res/snap），与新的「主表 + 任务行 + 风险行」
 * 结构不兼容。新建表另起名，避免迁移冲突与 legacy 路由误读；对外 API 路径仍是
 * `/projects/:projectId/reports`，调用方无感。
 *
 * ⚠ `run()` 已统一开事务并处理 `PRAGMA foreign_keys`，此处**不要**自行 BEGIN。
 * 全部 `IF NOT EXISTS`，重复执行安全。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳（本迁移不需要，保持签名一致）
 * @returns {void}
 */
function migrationV3(db, now) { // eslint-disable-line no-unused-vars
  /* ---------- 1. work_reports（周报主表） ---------- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_reports (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      week           TEXT NOT NULL,
      week_start     TEXT,
      week_end       TEXT,
      author_open_id TEXT NOT NULL,
      author_name    TEXT NOT NULL DEFAULT '',
      status         TEXT NOT NULL DEFAULT '草稿',
      done_note      TEXT NOT NULL DEFAULT '',
      plan_items     TEXT NOT NULL DEFAULT '[]',
      resource_note  TEXT NOT NULL DEFAULT '',
      snapshot       TEXT,
      submitted_at   TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_reports_proj_week
      ON work_reports(project_id, week, created_at);
  `);

  /* ---------- 2. work_report_tasks（周报任务进度行） ---------- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_report_tasks (
      id              TEXT PRIMARY KEY,
      report_id       TEXT NOT NULL REFERENCES work_reports(id) ON DELETE CASCADE,
      node_id         TEXT,
      node_code       TEXT NOT NULL DEFAULT '',
      node_name       TEXT NOT NULL DEFAULT '',
      progress_before INTEGER NOT NULL DEFAULT 0,
      progress_after  INTEGER NOT NULL DEFAULT 0,
      selected        INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_work_report_tasks_report
      ON work_report_tasks(report_id);
  `);

  /* ---------- 3. work_report_risks（周报风险行） ---------- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_report_risks (
      id               TEXT PRIMARY KEY,
      report_id        TEXT NOT NULL REFERENCES work_reports(id) ON DELETE CASCADE,
      seq              INTEGER NOT NULL DEFAULT 0,
      description      TEXT NOT NULL DEFAULT '',
      owner            TEXT NOT NULL DEFAULT '',
      due_date         TEXT NOT NULL DEFAULT '',
      promoted_risk_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_work_report_risks_report
      ON work_report_risks(report_id);
  `);

  console.log('[migrations] v3 建结构化周报表 work_reports / work_report_tasks / work_report_risks');
}

/* ── v4：WBS 工时字段（B7 · T01） ──────────────────── */

/**
 * 迁移 v4：`wbs_nodes` 新增工时列 `effort_hours`（B7 R1）。
 *
 * 口径（方案 A「强制汇总」，见 docs/B7-任务分解.md）：
 *  - 列可空，默认 NULL；**叶子**存实际值（缺省按 0），**父节点恒 NULL**（写路径负责清）。
 *  - 展示值一律由 `server/lib/wbs.js#decorateEffort` 读时递归求和，不落缓存列。
 *  - 存量行不回填（NULL → 展示按 0，Q3 推荐）。
 *
 * 幂等：`hasColumn` 守卫（沿用 v1 `tasks.name` 追加列范式）；重复执行安全。
 *
 * ⚠ `run()` 已统一开事务，此处**不要**自行 BEGIN。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳（本迁移不需要，保持签名一致）
 * @returns {void}
 */
function migrationV4(db, now) { // eslint-disable-line no-unused-vars
  if (!tableExists(db, 'wbs_nodes')) return;
  if (!hasColumn(db, 'wbs_nodes', 'effort_hours')) {
    db.exec('ALTER TABLE wbs_nodes ADD COLUMN effort_hours REAL');
  }
  console.log('[migrations] v4 为 wbs_nodes 增加 effort_hours 列（工时设置 B7）');
}

/* ── v5：周报实际工时列（B8 · T01） ──────────────────── */

/**
 * 迁移 v5：`work_report_tasks` 新增「本周实际工时（人日）」列 `week_actual_days`（B8 R3）。
 *
 * 口径（B8）：
 *  - 该列 = 该日志行本周实际人日（0 ≤ v ≤ 100、≤2 位小数，NOT NULL DEFAULT 0）；
 *    草稿行也落库但**不累计**。
 *  - `wbs_nodes.effort_hours` **零 DDL**——列名沿用 v4，语义改为「累计实际工时（人日）」：
 *    唯一写入方 = 工作日志 submit / 已提交日志编辑（report.service），WBS 写路径不再触碰。
 *  - 存量处置：pm.db 已清空、无存量业务数据 → 无需单位换算 / 回填（B8 PRD Q4 规则预留）。
 *
 * 幂等：`hasColumn` 守卫（沿用 v1 `tasks.name` / v4 追加列范式）；重复执行安全。
 *
 * ⚠ `run()` 已统一开事务，此处**不要**自行 BEGIN。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳（本迁移不需要，保持签名一致）
 * @returns {void}
 */
function migrationV5(db, now) { // eslint-disable-line no-unused-vars
  if (!tableExists(db, 'work_report_tasks')) return;
  if (!hasColumn(db, 'work_report_tasks', 'week_actual_days')) {
    db.exec('ALTER TABLE work_report_tasks ADD COLUMN week_actual_days REAL NOT NULL DEFAULT 0');
  }
  console.log('[migrations] v5 为 work_report_tasks 增加 week_actual_days 列（本周实际人日，B8）');
}

/* ── v6：评审 + 变更（B10 · T01） ────────────────────── */

/**
 * 迁移 v6：评审三表 + 空 changes 表（B10 D1）。
 *
 * 表：
 *  1. `reviews`          评审主表（对齐 `web/src/types/review.ts#Review`，
 *                        除 projectName 外全部落库；projectName 读时 join）
 *  2. `review_steps`     评审步骤（对齐 ReviewStep）
 *  3. `review_approvals` 审批留痕（对齐 Approval）
 *  4. `changes`          变更单（Q5 推荐：仅 DDL，本期无服务；
 *                        close-check 的 kind:'change' 查此表恒返回空，后续变更单直接复用）
 *
 * 幂等：全部 `CREATE TABLE IF NOT EXISTS` + 索引 `IF NOT EXISTS`（沿用 v2/v3 范式）。
 * ⚠ 列名避开 SQLite 关键字（D-10）：无 key/order/group/select 等。
 * ⚠ `run()` 已统一开事务并处理 `PRAGMA foreign_keys`，此处**不要**自行 BEGIN。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳（本迁移不需要，保持签名一致）
 * @returns {void}
 */
function migrationV6(db, now) { // eslint-disable-line no-unused-vars
  /* ---------- 1. reviews ---------- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      ref_type          TEXT NOT NULL DEFAULT 'project',
      ref_id            TEXT NOT NULL DEFAULT '',
      review_type       TEXT NOT NULL,
      title             TEXT NOT NULL,
      template_key      TEXT NOT NULL DEFAULT '',
      mode              TEXT NOT NULL DEFAULT 'serial',
      status            TEXT NOT NULL DEFAULT '审批中',
      current_step      INTEGER NOT NULL DEFAULT 0,
      initiator_open_id TEXT NOT NULL,
      initiator_name    TEXT NOT NULL DEFAULT '',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      closed_at         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_project   ON reviews(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_reviews_status    ON reviews(status);
    CREATE INDEX IF NOT EXISTS idx_reviews_initiator ON reviews(initiator_open_id);
  `);

  /* ---------- 2. review_steps ---------- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_steps (
      id               TEXT PRIMARY KEY,
      review_id        TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      step_index       INTEGER NOT NULL,
      role             TEXT NOT NULL,
      assignee_open_id TEXT,
      assignee_name    TEXT NOT NULL DEFAULT '',
      required         INTEGER NOT NULL DEFAULT 1,
      status           TEXT NOT NULL DEFAULT 'pending',
      decided_by       TEXT,
      decided_by_name  TEXT NOT NULL DEFAULT '',
      decided_at       TEXT,
      comment          TEXT NOT NULL DEFAULT '',
      UNIQUE (review_id, step_index)
    );
    CREATE INDEX IF NOT EXISTS idx_review_steps_review ON review_steps(review_id, step_index);
  `);

  /* ---------- 3. review_approvals ---------- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_approvals (
      id            TEXT PRIMARY KEY,
      review_id     TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      project_id    TEXT NOT NULL,
      step_index    INTEGER NOT NULL,
      step_role     TEXT NOT NULL,
      actor_open_id TEXT NOT NULL,
      actor_name    TEXT NOT NULL DEFAULT '',
      action        TEXT NOT NULL,
      comment       TEXT NOT NULL DEFAULT '',
      evidence_url  TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_approvals_review ON review_approvals(review_id, created_at);
  `);

  /* ---------- 4. changes（仅 DDL） ---------- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS changes (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      change_type      TEXT NOT NULL,
      title            TEXT NOT NULL,
      content          TEXT NOT NULL DEFAULT '',
      impact_analysis  TEXT NOT NULL DEFAULT '',
      effort_days      REAL NOT NULL DEFAULT 0,
      target_type      TEXT NOT NULL DEFAULT '',
      target_id        TEXT NOT NULL DEFAULT '',
      status           TEXT NOT NULL DEFAULT '草稿',
      route            TEXT NOT NULL DEFAULT 'pm_only',
      created_by       TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_changes_project ON changes(project_id);
  `);

  console.log('[migrations] v6 建评审表 reviews / review_steps / review_approvals + changes（B10）');
}

/* ── 迁移 v7：任务优先级 + 周报轻量闭环（B14） ─────── */

/**
 * v7 = B14 两块存储支撑，纯 `ADD COLUMN`，不重建表、不动既有数据语义。
 *
 * 拆解：
 *  1. `wbs_nodes.priority`     TEXT NOT NULL DEFAULT 'P2'（P0/P1/P2/P3，块1）
 *     + 历史行显式回填 P2（DEFAULT 只保证新行，回填保证「读出来一定有值」）
 *     + `idx_wbs_nodes_priority` 便于「按优先级排序/分布统计」走索引
 *  2. `work_reports.confirmed_by` / `confirmed_at` / `reject_reason`（块2）
 *     三列均可为 NULL —— NULL 表示「尚未确认 / 尚未驳回」，
 *     与「已确认」状态由 `status` 单一驱动，列只承载谁/何时/为何。
 *
 * ⚠ 安全性：全部 `hasColumn` 前置守卫，重复启动幂等；
 *   NOT NULL 列必须带 DEFAULT，否则既有行 ALTER 会失败。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳（本迁移不写业务时间，仅保持签名一致）
 * @returns {void}
 */
function migrationV7(db, now) { // eslint-disable-line no-unused-vars
  /* ---------- 1. wbs_nodes.priority（块1 任务优先级） ---------- */
  if (tableExists(db, 'wbs_nodes')) {
    if (!hasColumn(db, 'wbs_nodes', 'priority')) {
      db.exec("ALTER TABLE wbs_nodes ADD COLUMN priority TEXT NOT NULL DEFAULT 'P2'");
    }
    // 历史行回填：DEFAULT 只覆盖新插入行，旧行若为 NULL / 空串一并归一到 P2
    db.exec("UPDATE wbs_nodes SET priority = 'P2' WHERE priority IS NULL OR TRIM(priority) = ''");
    // 非法值兜底（防御历史脏数据，只允许四档）
    db.exec(
      "UPDATE wbs_nodes SET priority = 'P2' WHERE priority NOT IN ('P0', 'P1', 'P2', 'P3')"
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_wbs_nodes_priority ON wbs_nodes(priority)');
  }

  /* ---------- 2. work_reports 确认三列（块2 周报轻量闭环） ---------- */
  if (tableExists(db, 'work_reports')) {
    if (!hasColumn(db, 'work_reports', 'confirmed_by')) {
      db.exec('ALTER TABLE work_reports ADD COLUMN confirmed_by TEXT');
    }
    if (!hasColumn(db, 'work_reports', 'confirmed_at')) {
      db.exec('ALTER TABLE work_reports ADD COLUMN confirmed_at TEXT');
    }
    if (!hasColumn(db, 'work_reports', 'reject_reason')) {
      db.exec('ALTER TABLE work_reports ADD COLUMN reject_reason TEXT');
    }
    // 「待我确认」查询按 (project_id, status) 过滤，补一条组合索引
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_work_reports_status ON work_reports(project_id, status)'
    );
  }

  console.log('[migrations] v7 任务优先级 priority + 周报确认三列 confirmed_by/at + reject_reason（B14）');
}

/* ── 迁移 v8：任务附件（C01 · 方案 A） ─────────────────── */

/**
 * v8 = 任务附件表 `project_documents`（C01 第一个真实实现的文档域）。
 *
 * 方案 A：把「任务附件」作为现有文档模块的第一个真正实现——
 * 在 WBS 任务（node_id）或里程碑（milestone_id）上挂二进制文件，
 * 上传到自有服务器磁盘（ATTACHMENT_ROOT 按 projectId 分目录），列表 / 预览 / 删除。
 *
 * 存储约定（与服务层 `server/services/document.service.js` 对齐）：
 *  - `storage_path` = `projectId/UUID_原名`，落盘相对 ATTACHMENT_ROOT
 *  - `file_size` 为字节数（REAL，便于与 20MB 上限比较）
 *  - `node_id` / `milestone_id` 可空（空串表示挂在项目级，非必填关联）
 *  - 本项目不引入生命周期模板派生 + 基线管控（后续单独讨论）
 *
 * 幂等：全部 `CREATE TABLE IF NOT EXISTS` + 索引 `IF NOT EXISTS`（沿用 v2/v3 范式）。
 * ⚠ `run()` 已统一开事务并处理 `PRAGMA foreign_keys`，此处**不要**自行 BEGIN。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳（本迁移不需要，保持签名一致）
 * @returns {void}
 */
function migrationV8(db, now) { // eslint-disable-line no-unused-vars
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_documents (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      node_id       TEXT NOT NULL DEFAULT '',
      milestone_id  TEXT NOT NULL DEFAULT '',
      name          TEXT NOT NULL,
      file_name     TEXT NOT NULL,
      file_size     REAL NOT NULL DEFAULT 0,
      mime_type     TEXT NOT NULL DEFAULT '',
      storage_path  TEXT NOT NULL,
      uploaded_by   TEXT NOT NULL DEFAULT '',
      uploaded_at   TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_documents_project
      ON project_documents(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_documents_node
      ON project_documents(project_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_project_documents_milestone
      ON project_documents(project_id, milestone_id);
  `);

  console.log('[migrations] v8 建任务附件表 project_documents（C01）');
}

/* ── 迁移 v9：project_documents 加 doc_type（D02 · 飞书文档关联） ── */

/**
 * v9 = `project_documents` 增加 `doc_type`（'file' | 'link'）与 `url`（外链文档地址）。
 *
 * D02 起文档域支持两类记录：
 *  - `file`：C01 的二进制附件（storage_path 落盘，默认值保持兼容）
 *  - `link`：粘贴的飞书/外链文档（storage_path=''，url 存飞书链接，点击新标签页打开）
 *
 * 幂等：`hasColumn` 守卫（沿用 v1 `tasks.name` 追加列范式），重复执行安全。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳（本迁移不需要，保持签名一致）
 * @returns {void}
 */
function migrationV9(db, now) { // eslint-disable-line no-unused-vars
  if (!hasColumn(db, 'project_documents', 'doc_type')) {
    db.exec("ALTER TABLE project_documents ADD COLUMN doc_type TEXT NOT NULL DEFAULT 'file'");
  }
  if (!hasColumn(db, 'project_documents', 'url')) {
    db.exec("ALTER TABLE project_documents ADD COLUMN url TEXT NOT NULL DEFAULT ''");
  }
  console.log('[migrations] v9 project_documents 加 doc_type + url（file/link，D02 飞书文档关联）');
}

/* ── 迁移 v10：全量任务快照表（D03 · 周报全量快照环比） ── */

/**
 * v10 = `progress_snapshots` 全量任务快照表。
 *
 * D03 目标：精确环比不能只看周报勾选任务（work_report_tasks 覆盖不全），
 * 需要「每项目每周一次**全量真叶子任务快照**」——周报提交时采集，环比 = 上周快照 vs 前周快照。
 *
 * 设计约定（与服务层 `server/services/snapshot.service.js` 对齐）：
 *  - `object_type` 本期仅 'task'（里程碑用既有 done_at 双周对比，无需快照，避免过度设计）；
 *  - `UNIQUE(object_type, object_id, week)`：每周每对象一条，同周重提 → ON CONFLICT 覆盖为最新；
 *  - `report_id` 记录触发快照的周报，可追溯；
 *  - 不做历史回填：快照从启用周开始积累（口径纯净，不混入勾选数据）。
 *
 * 幂等：`CREATE TABLE IF NOT EXISTS` + 索引 `IF NOT EXISTS`（沿用 v2/v3 范式）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳（本迁移不需要，保持签名一致）
 * @returns {void}
 */
function migrationV10(db, now) { // eslint-disable-line no-unused-vars
  db.exec(`
    CREATE TABLE IF NOT EXISTS progress_snapshots (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      object_type TEXT NOT NULL DEFAULT 'task',
      object_id   TEXT NOT NULL,
      week        TEXT NOT NULL,
      progress    INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT '',
      captured_at TEXT NOT NULL,
      report_id   TEXT,
      UNIQUE(object_type, object_id, week)
    );
    CREATE INDEX IF NOT EXISTS idx_progress_snapshots_project_week
      ON progress_snapshots(project_id, week);
    CREATE INDEX IF NOT EXISTS idx_progress_snapshots_object
      ON progress_snapshots(object_type, object_id);
  `);
  console.log('[migrations] v10 建全量任务快照表 progress_snapshots（D03）');
}

/* ── 迁移 v11：project_documents 加模板派生/版本/基线列（D04） ── */

/**
 * v11 = `project_documents` 增加模板派生与版本管控四列。
 *
 * D04 起文档域支持「模板派生交付物清单」：
 *  - `template_key`：模板交付物标识（如 'TPL-A-1'）；'' = 手动上传/链接（非模板项）
 *  - `status`：模板项 待交付 / 已交付；手动记录恒 '已交付'
 *  - `version`：交付版本号（替换文件/链接时 +1）
 *  - `baseline_flag`：0=未纳入基线 1=已纳入（本期仅标记展示，锁定/变更留痕下一期）
 *
 * 幂等：`hasColumn` 守卫（沿用 v1 `tasks.name` 追加列范式），重复执行安全。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳（本迁移不需要，保持签名一致）
 * @returns {void}
 */
function migrationV11(db, now) { // eslint-disable-line no-unused-vars
  if (!hasColumn(db, 'project_documents', 'template_key')) {
    db.exec("ALTER TABLE project_documents ADD COLUMN template_key TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'project_documents', 'status')) {
    db.exec("ALTER TABLE project_documents ADD COLUMN status TEXT NOT NULL DEFAULT '已交付'");
  }
  if (!hasColumn(db, 'project_documents', 'version')) {
    db.exec('ALTER TABLE project_documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  }
  if (!hasColumn(db, 'project_documents', 'baseline_flag')) {
    db.exec('ALTER TABLE project_documents ADD COLUMN baseline_flag INTEGER NOT NULL DEFAULT 0');
  }
  console.log('[migrations] v11 project_documents 加 template_key/status/version/baseline_flag（D04 模板派生）');
}

/* ── 迁移 v12：交付物基线时间/操作人（D05） ── */

/**
 * v12 = `project_documents` 加基线建立时间与操作人（配合 baseline_flag）。
 *
 * D05 起已交付模板项可「建立基线」（baseline_flag=1 + baselined_at/by）；
 * 替换已基线项时强制填写变更原因并写审计（baseline_flag 保留，baselined_at 更新）。
 *
 * 幂等：`hasColumn` 守卫。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳
 * @returns {void}
 */
function migrationV12(db, now) { // eslint-disable-line no-unused-vars
  if (!hasColumn(db, 'project_documents', 'baselined_at')) {
    db.exec('ALTER TABLE project_documents ADD COLUMN baselined_at TEXT');
  }
  if (!hasColumn(db, 'project_documents', 'baselined_by')) {
    db.exec('ALTER TABLE project_documents ADD COLUMN baselined_by TEXT');
  }
  console.log('[migrations] v12 project_documents 加 baselined_at/baselined_by（D05 基线）');
}

/* ── 迁移 v13：变更单流程补全（D08） ── */

/**
 * v13 = `changes` 加变更单流程所需列：
 *   - code        变更单编号（CHG-xxx）
 *   - review_id   关联评审 id（ccb/pm 审批链复用 reviews 引擎）
 *   - applied_at  实施时间
 *   - payload     结构化变更载荷 JSON（milestone_date: {fromDate,toDate} 等）
 *
 * 幂等：`hasColumn` 守卫。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳
 * @returns {void}
 */
function migrationV13(db, now) { // eslint-disable-line no-unused-vars
  if (!hasColumn(db, 'changes', 'code')) {
    db.exec("ALTER TABLE changes ADD COLUMN code TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'changes', 'review_id')) {
    db.exec('ALTER TABLE changes ADD COLUMN review_id TEXT');
  }
  if (!hasColumn(db, 'changes', 'applied_at')) {
    db.exec('ALTER TABLE changes ADD COLUMN applied_at TEXT');
  }
  if (!hasColumn(db, 'changes', 'payload')) {
    db.exec('ALTER TABLE changes ADD COLUMN payload TEXT');
  }
  console.log('[migrations] v13 changes 加 code/review_id/applied_at/payload（D08 变更流程）');
}

/**
 * v14：审批流程可配置（管理后台阶段二）。
 *
 * 新增 `review_templates` 表，把原先硬编码的两处审批配置迁入 DB：
 *   - config.APPROVAL_TEMPLATES（A/B/C/_default 项目立项链，scope='project'）
 *   - enums.REVIEW_TEMPLATES（formal/technical/code/ccb/pm_only/project 业务评审，scope='business'）
 *
 * 幂等 seed（INSERT OR IGNORE），老库升级自动补齐，不覆盖用户后续改动。
 */
function migrationV14(db, now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_templates (
      key         TEXT PRIMARY KEY,
      scope       TEXT NOT NULL DEFAULT 'business',        -- project | business
      label       TEXT NOT NULL,
      mode        TEXT NOT NULL DEFAULT 'serial',          -- serial | parallel_veto | single
      chain       TEXT NOT NULL DEFAULT '[]',              -- JSON 角色数组
      description TEXT NOT NULL DEFAULT '',
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
  `);

  const seed = [
    // ── 项目类（scope=project）：立项审批链，key = project:<type> ──
    ['project:A', 'project', 'A 类项目立项审批', 'serial', ['pmo', 'tl', 'management'], 'A 类项目立项审批串行链：PMO → TL → 管理层'],
    ['project:B', 'project', 'B 类项目立项审批', 'serial', ['pm', 'tl'], 'B 类项目立项审批串行链：PM → TL'],
    ['project:C', 'project', 'C 类项目立项审批', 'serial', ['pmo', 'tl', 'management'], 'C 类项目立项审批串行链：PMO → TL → 管理层'],
    ['project:_default', 'project', '立项审批（默认）', 'serial', ['pm', 'tl'], '未匹配到具体项目类型时的立项审批兜底链'],
    // ── 业务类（scope=business）：与 enums.REVIEW_TEMPLATES 一一对应 ──
    ['formal', 'business', '正式评审', 'parallel_veto', ['pmo', 'tl', 'management', 'customer_rep'], '立项/需求/设计/验收 → 管理层 + PMO + TL + 客户代表，一票否决'],
    ['technical', 'business', '技术评审', 'single', ['tl'], '由技术负责人（TL）单人决议并留痕'],
    ['code', 'business', '代码评审', 'single', ['tl'], '≥1 人 Approve 即可通过'],
    ['ccb', 'business', 'CCB 变更评审', 'serial', ['pm', 'tl', 'po', 'customer_rep'], '基线变更 → PM → TL → PO → 客户代表 串行逐级'],
    ['pm_only', 'business', 'PM 审批', 'single', ['pm'], '非基线小变更 → PM 单人决议并留痕'],
    ['project', 'business', '立项审批', 'serial', ['pmo', 'management'], '立项审批串行链：PMO → 管理层'],
  ];

  const ins = db.prepare(
    'INSERT OR IGNORE INTO review_templates (key, scope, label, mode, chain, description, active, created_at, updated_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
  );
  const tx = db.transaction(function () {
    seed.forEach(function (s) {
      ins.run(s[0], s[1], s[2], s[3], JSON.stringify(s[4]), s[5], now, now);
    });
  });
  tx();
  console.log('[migrations] v14 review_templates 表 + 10 条内置审批流 seed（审批流程可配置）');
}

/**
 * v15：职位目录 + 用户多全局职位（E1.5）。
 *
 * 背景（E1.5 已签方案）：
 *   公司存在「一人多职位」现实——例如某人既是 PMO 又是技术负责人，
 *   既要看全公司 PMO 视野，又要以 TL 身份参与具体项目。原 `users.global_role`
 *   单值无法表达，本迁移引入：
 *
 *   1. `roles` 职位目录表：所有职位集中管理（名称 / 视野 scope[global|project]
 *      / 启停 / 排序 / 描述）。scope=global 的职位可被指派为用户的「全局职位」；
 *      scope=project 的职位仅用于项目内成员角色（与 project_members 已支持的多角色结构呼应）。
 *   2. `user_roles` 用户额外全局职位表：在 `users.global_role`（主职位，保留作兜底
 *      与向后兼容）之外，挂接零到多个 scope=global 的职位。读取时合并为
 *      `[主职位, ...额外职位]` 去重数组，权限判定取并集。
 *
 * 幂等：
 *   - 表用 `CREATE TABLE IF NOT EXISTS`；
 *   - 默认职位用 `INSERT OR IGNORE`（以 role_key 为主键），老库升级自动补齐，不覆盖用户后续改动；
 *   - 不改动 `users` 表结构（global_role 单列保留）。
 */
function migrationV15(db, now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      role_key   TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      scope      TEXT NOT NULL DEFAULT 'global',   -- global | project
      enabled    INTEGER NOT NULL DEFAULT 1,
      description TEXT NOT NULL DEFAULT '',
      order_no   INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_roles (
      id           TEXT PRIMARY KEY,
      user_open_id TEXT NOT NULL,
      role_key     TEXT NOT NULL,
      assigned_by  TEXT,
      assigned_at  TEXT NOT NULL,
      UNIQUE (user_open_id, role_key)
    );
    CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_open_id);
    CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_key);
  `);

  /**
   * 默认职位目录（单一来源：server/config/roles-catalog.js 的 ROLE_CATALOG，
   * INSERT OR IGNORE 不覆盖已有角色；仅空库首次迁移时写入出生种子）。
   * order_no 仅控制后台列表展示顺序。
   */
  const defaultRoles = ROLE_CATALOG;

  const insRole = db.prepare(
    'INSERT OR IGNORE INTO roles (role_key, name, scope, enabled, description, order_no) '
    + 'VALUES (?, ?, ?, 1, ?, ?)',
  );
  const tx = db.transaction(function () {
    defaultRoles.forEach(function (r) {
      insRole.run(r[0], r[1], r[2], r[3], r[4]);
    });
  });
  tx();
  console.log('[migrations] v15 roles 职位目录 + user_roles 多职位表 + 默认职位 seed（E1.5）');
}

/**
 * v16：邮箱密码登录（2026-08-23）。
 *
 * 新增 users 列：
 *   - password_hash      TEXT     密码哈希（scrypt）
 *   - must_change_pwd    INTEGER  NOT NULL DEFAULT 1  首次登录/重置后强制改密
 *
 * 老用户：password_hash 为空 → 仍可登录，但前端检测到 must_change_pwd=1 强制改密。
 * 新用户：若通过飞书登录首次创建，默认 must_change_pwd=0（飞书免登不需要密码）。
 */
function migrationV16(db, now) { // eslint-disable-line no-unused-vars
  if (!hasColumn(db, 'users', 'password_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  }
  if (!hasColumn(db, 'users', 'must_change_pwd')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_pwd INTEGER NOT NULL DEFAULT 1');
  }
  console.log('[migrations] v16 users 加 password_hash / must_change_pwd（邮箱密码登录）');
}

/**
 * v17：users 表增加 union_id 列，用于飞书跨应用账号认回。
 * 飞书同一租户下 union_id 不变，open_id 随应用变化；登录时按 union_id/email 认回已有账号。
 */
function migrationV17(db, now) { // eslint-disable-line no-unused-vars
  if (!hasColumn(db, 'users', 'union_id')) {
    db.exec('ALTER TABLE users ADD COLUMN union_id TEXT');
  }
  console.log('[migrations] v17 users 加 union_id（飞书跨应用账号认回）');
}

/**
 * v18：权限矩阵可配置化 · 数据底座（B19 阶段一 · T01）
 *
 * 把原本写死在 server/config/permissions.js 的 `PERMISSIONS` 常量，
 * 下沉为数据库两张表，使权限矩阵可通过管理后台配置（阶段二/三），
 * 而不改任何业务 route / service 判定逻辑（canDo 仅切换数据源）。
 *
 * 表：
 *  1. `permission_rules`  action × role_key 的授权矩阵（稀疏，只存 granted=1），
 *     主键 (action, role_key)；**不建外键**到 roles 表，避免删角色级联丢配置；
 *     运行时软忽略不存在/停用的角色（见 server/services/permissionCatalog.js）。
 *  2. `permission_actions`  action 元数据（中文 label / 分组 / 排序 / 启用 / 内置标记），
 *     主键 action；本阶段 action 集合固定，不开放后台增删。
 *
 * 种子（单一真相源 = DEFAULT_PERMISSIONS 常量）：
 *  - permission_actions：28 个 action 的 label/分组（下沉自前端 PERM_GROUPS，order_no 按出现顺序）。
 *  - permission_rules：遍历 DEFAULT_PERMISSIONS，对每个 action 的 roles 数组逐条 INSERT OR IGNORE。
 *    不手抄 SQL，保证与代码认知的权限点集合完全一致（code↔DB 对账，见下方安全断言）。
 *
 * 幂等：建表 `CREATE TABLE IF NOT EXISTS`；种子 `INSERT OR IGNORE`（以 (action,role_key) 为主键）。
 * ⚠ `run()` 已统一开事务并处理 `PRAGMA foreign_keys`，此处**不要**自行 BEGIN。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳
 * @returns {void}
 */
function migrationV18(db, now) {
  /* ---------- 1. permission_rules（授权矩阵） ---------- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS permission_rules (
      action     TEXT NOT NULL,
      role_key   TEXT NOT NULL,
      granted    INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      PRIMARY KEY (action, role_key)
    );
  `);

  /* ---------- 2. permission_actions（action 元数据） ---------- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS permission_actions (
      action      TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      group_key   TEXT,
      group_label TEXT,
      description TEXT,
      order_no    INTEGER,
      enabled     INTEGER,
      builtin     INTEGER NOT NULL DEFAULT 1
    );
  `);

  /**
   * 28 个 action 的展示元数据（label / 分组）。
   * 与 web/src/pages/admin/AdminPermissionsPage.tsx 的 PERM_GROUPS 逐条一致；
   * order_no 按出现顺序（0-based）。本阶段 action 集合固定，不开放后台增删。
   * 元组：[action, label, group_key, group_label]
   */
  const ACTION_META = [
    // 项目
    ['project:create', '新建项目', 'project', '项目'],
    ['project:edit', '编辑项目', 'project', '项目'],
    ['project:delete', '删除项目', 'project', '项目'],
    ['project:transition', '项目状态流转', 'project', '项目'],
    ['project:close', '项目结项', 'project', '项目'],
    ['project:member:assign', '项目成员分配', 'project', '项目'],
    // 质量门 / 里程碑
    ['gate:decide', '质量门决议', 'gate_milestone', '质量门 / 里程碑'],
    ['gate:item:check', '门检查项检查', 'gate_milestone', '质量门 / 里程碑'],
    ['gate:item:add', '门检查项新增', 'gate_milestone', '质量门 / 里程碑'],
    ['milestone:create', '里程碑新建', 'gate_milestone', '质量门 / 里程碑'],
    ['milestone:edit', '里程碑编辑', 'gate_milestone', '质量门 / 里程碑'],
    ['milestone:delete', '里程碑删除', 'gate_milestone', '质量门 / 里程碑'],
    // WBS / 看板 / 任务
    ['wbs:edit', 'WBS 编辑', 'wbs_board', 'WBS / 看板 / 任务'],
    ['wbs:delete', 'WBS 删除', 'wbs_board', 'WBS / 看板 / 任务'],
    ['task:status', '任务状态更新', 'wbs_board', 'WBS / 看板 / 任务'],
    ['board:config', '看板配置', 'wbs_board', 'WBS / 看板 / 任务'],
    // 周报 / 评审 / 变更
    ['report:write', '周报填写', 'report_review', '周报 / 评审 / 变更'],
    ['review:start', '发起评审', 'report_review', '周报 / 评审 / 变更'],
    ['review:decide', '评审决议', 'report_review', '周报 / 评审 / 变更'],
    ['review:proxy', '评审代理', 'report_review', '周报 / 评审 / 变更'],
    ['change:create', '变更创建', 'report_review', '周报 / 评审 / 变更'],
    ['change:submit', '变更提交', 'report_review', '周报 / 评审 / 变更'],
    // 全局 / 管理
    ['dashboard:global', '全局仪表盘', 'global_admin', '全局 / 管理'],
    ['admin:user:role', '用户角色管理', 'global_admin', '全局 / 管理'],
    ['admin:audit:view', '审计查看', 'global_admin', '全局 / 管理'],
    ['admin:template', '生命周期模板管理', 'global_admin', '全局 / 管理'],
    ['admin:permission:config', '权限矩阵配置', 'global_admin', '全局 / 管理'],
    ['admin:feishu:import', '飞书通讯录导入', 'global_admin', '全局 / 管理'],
    ['report:manage', '工作日志管理（删除他人）', 'report_review', '周报 / 评审 / 变更'],
    ['document:upload', '文档上传', 'global_admin', '全局 / 管理'],
    ['document:delete', '文档删除', 'global_admin', '全局 / 管理'],
  ];

  // ── code↔DB 对账 ──
  // permission_actions 必须覆盖 DEFAULT_PERMISSIONS 认知的全部 action（漏建 → 该 action 静默无权限）；
  // 也不应含代码已删除的 action（脏数据）。
  const dpActions = Object.keys(DEFAULT_PERMISSIONS);
  const metaActions = ACTION_META.map(function (x) { return x[0]; });
  const missing = dpActions.filter(function (a) { return metaActions.indexOf(a) < 0; });
  if (missing.length) {
    throw new Error('[migrations] v18 permission_actions 缺失 action（请补充 ACTION_META）：' + missing.join(', '));
  }
  const orphan = metaActions.filter(function (a) { return dpActions.indexOf(a) < 0; });
  if (orphan.length) {
    throw new Error('[migrations] v18 permission_actions 含代码未定义 action（请清理 ACTION_META）：' + orphan.join(', '));
  }

  /* ---------- 3. 种子 permission_actions（INSERT OR IGNORE，幂等） ---------- */
  const insAction = db.prepare(
    'INSERT OR IGNORE INTO permission_actions '
    + '(action, label, group_key, group_label, description, order_no, enabled, builtin) '
    + 'VALUES (?, ?, ?, ?, ?, ?, 1, 1)'
  );
  const txMeta = db.transaction(function () {
    ACTION_META.forEach(function (m, i) {
      insAction.run(m[0], m[1], m[2], m[3], m[1], i);
    });
  });
  txMeta();

  /* ---------- 4. 种子 permission_rules（唯一源 = DEFAULT_PERMISSIONS，逐条 INSERT OR IGNORE） ---------- */
  const insRule = db.prepare(
    "INSERT OR IGNORE INTO permission_rules (action, role_key, granted, updated_at, updated_by) VALUES (?, ?, 1, ?, 'seed')"
  );
  const txRules = db.transaction(function () {
    dpActions.forEach(function (action) {
      const rule = DEFAULT_PERMISSIONS[action];
      (rule.roles || []).forEach(function (roleKey) {
        insRule.run(action, roleKey, now);
      });
    });
  });
  txRules();

  console.log('[migrations] v18 permission_rules + permission_actions 表 + %d 条授权种子（RBAC 可配置化·数据底座）', dpActions.length);
}

/* ── 迁移 v19：风险登记册表 ───────────────────────── */

/**
 * 迁移 v19 —— 风险登记册（本期新增功能域）。
 *
 * 口径铁律（与前端 Mock `toListItem` 逐字一致）：
 *  - `risk_value = probability * impact`，落库去重算，读路径不再现场乘
 *  - 高风险阈值 `risk_value >= 12`（service 层 `countHighRisks` 复用同一常量）
 *  - `code` 形如 `RISK-序号`，由 service 层自增生成（UNIQUE 约束防撞）
 *  - 归档态拦截由 service 层 `rbac.assertWritable` 负责，此处不设业务约束
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳
 */
function migrationV19(db, now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS risks (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      code         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      category     TEXT NOT NULL DEFAULT '',
      probability  INTEGER NOT NULL DEFAULT 1,
      impact       INTEGER NOT NULL DEFAULT 1,
      risk_value   INTEGER NOT NULL DEFAULT 1,
      strategy     TEXT NOT NULL DEFAULT '',
      owner        TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT '待评估',
      review_date  TEXT,
      created_by   TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      UNIQUE (project_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_risks_project ON risks(project_id);
  `);

  console.log('[migrations] v19 risks 表（风险登记册）');
}

/* ── 迁移 v20：清理历史遗留死表 ──────────────────────── */

/**
 * 彻底移除三张已被新体系取代的旧表：
 *  - `tasks`         → 已被 `wbs_nodes` 取代（任务看板同源）
 *  - `reports`       → 已被 `work_reports` 取代（结构化周报）
 *  - `report_tasks`  → 已被 `work_report_tasks` 取代
 * 这三张表仅被 @deprecated 的 legacy.routes.js 引用，对应端点已删除；
 * devcheck.js / test_runner.js 不依赖它们。DROP IF EXISTS 幂等，安全重跑。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳（本迁移不需要）
 */
function migrationV20(db, now) { // eslint-disable-line no-unused-vars
  db.exec(`
    DROP TABLE IF EXISTS report_tasks;
    DROP TABLE IF EXISTS tasks;
    DROP TABLE IF EXISTS reports;
  `);
  console.log('[migrations] v20 已清理历史遗留死表 tasks / reports / report_tasks');
}

/* ── 迁移 v21：站内通知表 ─────────────────────────── */

/**
 * 迁移 v21 —— 站内通知（本期新增功能域，配合顶栏铃铛）。
 *
 * 口径铁律：
 *  - 一条通知只指向一个接收人（user_open_id），群发由调用方循环 insert
 *  - `type` 取值：REVIEW_CREATED / REVIEW_DECIDED / CHANGE_CREATED /
 *    CHANGE_SUBMITTED / CHANGE_APPLIED / CHANGE_DECIDED（由 notification.service 常量约束）
 *  - `ref_type` / `ref_id` 指向关联业务对象（review / change），前端点击跳详情
 *  - `is_read` 0/1；软未读由索引 (user_open_id, is_read, created_at) 支撑未读计数
 *  - 避免自通知：写入前由 service 层 resolveRecipients 过滤发起人自身
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳
 */
function migrationV21(db, now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id           TEXT PRIMARY KEY,
      user_open_id TEXT NOT NULL,
      project_id   TEXT NOT NULL DEFAULT '',
      type         TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      body         TEXT NOT NULL DEFAULT '',
      ref_type     TEXT NOT NULL DEFAULT '',
      ref_id       TEXT NOT NULL DEFAULT '',
      is_read      INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user
      ON notifications(user_open_id, is_read, created_at);
  `);

  console.log('[migrations] v21 notifications 表（站内通知）');
}

/* ── 迁移 v22：模板交付物删除记忆表 ─────────────────── */

/**
 * 迁移 v22 —— 记录用户「有意删除」的模板派生交付物 key。
 *
 * 背景：deriveTemplateDocs 的「保证清单常驻」逻辑原本只以「行是否还在」判重，
 * 用户删除后行消失 → 列表派生判定为「缺失」→ 整组复活（D-BUG：删了又复现）。
 * 本表记下被删 key，派生时跳过，使删除生效。
 * 自定义项（CUS- 前缀）删除即真删，不写本表。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳
 */
function migrationV22(db, now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS removed_template_docs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id   TEXT NOT NULL,
      template_key TEXT NOT NULL,
      removed_by   TEXT NOT NULL DEFAULT '',
      removed_at   TEXT NOT NULL,
      UNIQUE(project_id, template_key)
    );
    CREATE INDEX IF NOT EXISTS idx_removed_tpl_docs
      ON removed_template_docs(project_id, template_key);
  `);
  console.log('[migrations] v22 removed_template_docs 表（模板交付物删除记忆）');
}

/* ── 迁移 v23：认证授权闸门（users.status 三态 + email 索引） ── */

/**
 * 迁移 v23 —— 扩展 users.status 枚举为三态（active / disabled / pending）。
 *
 * 背景：飞书登录授权闸门（需求②）要求"未授权人员一律拒绝，不自动建号"，
 * 并以单一真相源 `status === 'active'` 作为登录闸门（密码 / 飞书 / requireAuth 口径统一）。
 *
 * 因 users.status 为 TEXT 列，无需 ALTER 表结构，仅需：
 *  1) 防御性 backfill：任何非三态合法值的脏数据一律归正为 active（生产存量全为 active/disabled，本步为空操作）；
 *  2) 飞书按 email 认回账号的高频路径加索引（小库可省，推荐加）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now ISO 时间戳
 */
function migrationV23(db, now) {
  // 1) 防御：任何非三态合法值的脏数据一律归正为 active
  db.exec(
    "UPDATE users SET status = 'active' WHERE status NOT IN ('active', 'disabled', 'pending')",
  );
  // 2) 飞书登录按 email 认回的高频路径加索引
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
  console.log('[migrations] v23 扩展 users.status 枚举（active/disabled/pending），加 email 索引');
}

/**
 * v24 — 身份模型收口：全库责任人/操作人统一改用系统稳定身份键 `users.id`。
 *
 * 历史缺陷：14 张表、19 个用户引用列全部把飞书 `open_id`（会变、按应用隔离）当外键，
 * 导致导入数据带的 open_id 与 users 表免登建号的 open_id 不同源 → 大面积「已移除」。
 * 修复策略：新增 `xxx_user_id` 列（INTEGER，存 users.id），并把既有数据回填；
 * 此后系统内部只认、只存 `users.id`，open_id 退为飞书免登/导入边界的同步属性。
 *
 * 幂等：列已存在则跳过 ALTER；回填仅 UPDATE 仍为空（NULL）的行，已回填行不受影响。
 * 来源列形态分两类：
 *   - open_id 型：直接 `users.open_id = 来源列` 解析；
 *   - 姓名型（risks.owner / work_report_risks.owner 历史存的是姓名）：`users.name = 来源列` 解析。
 * 本地库已在更早的离线脚本回填完毕，本迁移在生产库首次启动时补齐列并补填残余空值。
 */
function migrationV24(db, now) {
  const ADD = [
    ['risks', 'owner_user_id'],
    ['risks', 'created_by_user_id'],
    ['changes', 'created_by_user_id'],
    ['review_steps', 'assignee_user_id'],
    ['review_steps', 'decided_by_user_id'],
    ['review_approvals', 'actor_user_id'],
    ['reviews', 'initiator_user_id'],
    ['project_members', 'member_user_id'],
    ['project_members', 'assigned_by_user_id'],
    ['user_roles', 'role_user_id'],
    ['user_roles', 'assigned_by_user_id'],
    ['notifications', 'user_id'],
    ['audit_logs', 'actor_user_id'],
    ['work_reports', 'author_user_id'],
    ['work_report_risks', 'owner_user_id'],
    ['permission_rules', 'updated_by_user_id'],
    ['projects', 'created_by_user_id'],
    ['wbs_nodes', 'owner_user_id'],
    ['wbs_nodes', 'created_by_user_id'],
    ['quality_gates', 'decided_by_user_id'],
    ['project_documents', 'baselined_by_user_id'],
    ['project_documents', 'uploaded_by_user_id'],
  ];
  ADD.forEach(function (pair) {
    const t = pair[0], col = pair[1];
    if (!hasColumn(db, t, col)) {
      db.exec('ALTER TABLE ' + t + ' ADD COLUMN ' + col + ' INTEGER');
    }
  });

  // (table, uidCol, sourceCol, 'open'|'name')
  const BACKFILL = [
    ['risks', 'owner_user_id', 'owner', 'name'],
    ['risks', 'created_by_user_id', 'created_by', 'open'],
    ['changes', 'created_by_user_id', 'created_by', 'open'],
    ['review_steps', 'assignee_user_id', 'assignee_open_id', 'open'],
    ['review_steps', 'decided_by_user_id', 'decided_by', 'open'],
    ['review_approvals', 'actor_user_id', 'actor_open_id', 'open'],
    ['reviews', 'initiator_user_id', 'initiator_open_id', 'open'],
    ['project_members', 'member_user_id', 'user_open_id', 'open'],
    ['project_members', 'assigned_by_user_id', 'assigned_by', 'open'],
    ['user_roles', 'role_user_id', 'user_open_id', 'open'],
    ['user_roles', 'assigned_by_user_id', 'assigned_by', 'open'],
    ['notifications', 'user_id', 'user_open_id', 'open'],
    ['audit_logs', 'actor_user_id', 'actor_open_id', 'open'],
    ['work_reports', 'author_user_id', 'author_open_id', 'open'],
    ['work_report_risks', 'owner_user_id', 'owner', 'name'],
    ['permission_rules', 'updated_by_user_id', 'updated_by', 'open'],
    ['projects', 'created_by_user_id', 'created_by', 'open'],
    ['wbs_nodes', 'owner_user_id', 'owner', 'open'],
    ['wbs_nodes', 'created_by_user_id', 'created_by', 'open'],
    ['quality_gates', 'decided_by_user_id', 'decided_by', 'open'],
    ['project_documents', 'baselined_by_user_id', 'baselined_by', 'open'],
    ['project_documents', 'uploaded_by_user_id', 'uploaded_by', 'open'],
  ];
  BACKFILL.forEach(function (b) {
    const t = b[0], uid = b[1], src = b[2], kind = b[3];
    const userKey = kind === 'name' ? 'users.name' : 'users.open_id';
    db.exec(
      'UPDATE ' + t + ' SET ' + uid + ' = (SELECT id FROM users WHERE ' + userKey + ' = ' + t + '.' + src + ') ' +
      'WHERE ' + uid + ' IS NULL AND ' + src + ' IS NOT NULL AND ' + src + ' <> \'\''
    );
  });

  console.log('[migrations] v24 身份收口：补 user_id 列并回填既有人/操作人引用');
}

/**
 * v25 · 权限矩阵补 3 个「后台配置类」action（单一真相源收口）
 *  - admin:permission:config：权限矩阵编辑器（GET/PUT /api/admin/permissions、reset、permission-actions）
 *  - admin:feishu:import：飞书通讯录导入（contacts / import / search）
 *  - report:manage：删除 / 管理他人工作日志草稿（仅作者本人或具备本权限者）
 * 三者默认仅授 admin（防权限提升）；后续可在「权限矩阵」页放开给其它角色。
 * INSERT OR IGNORE 幂等：全新库由 v18 已种入 DEFAULT_PERMISSIONS（本批次同步扩充），此处兜底补种。
 */
function migrationV25(db, now) {
  const NEW_ACTIONS = [
    ['admin:permission:config', '权限矩阵配置', 'global_admin', '全局 / 管理'],
    ['admin:feishu:import', '飞书通讯录导入', 'global_admin', '全局 / 管理'],
    ['report:manage', '工作日志管理（删除他人）', 'report_review', '周报 / 评审 / 变更'],
  ];
  const insAction = db.prepare(
    'INSERT OR IGNORE INTO permission_actions '
    + '(action, label, group_key, group_label, description, order_no, enabled, builtin) '
    + 'VALUES (?, ?, ?, ?, ?, ?, 1, 1)'
  );
  const insRule = db.prepare(
    "INSERT OR IGNORE INTO permission_rules (action, role_key, granted, updated_at, updated_by) VALUES (?, 'admin', 1, ?, 'seed:v25')"
  );
  const tx = db.transaction(function () {
    NEW_ACTIONS.forEach(function (m, i) {
      insAction.run(m[0], m[1], m[2], m[3], m[1], 1000 + i);
      insRule.run(m[0], now);
    });
  });
  tx();
  console.log('[migrations] v25 权限矩阵补 3 个后台配置 action（admin:permission:config / admin:feishu:import / report:manage）');
}

/* ── 迁移注册表 ───────────────────────────────────── */

/**
 * 有序迁移列表。**只追加，不修改已发布项**。
 * @type {{version: number, name: string, up: Function}[]}
 */
const MIGRATIONS = [
  { version: 1, name: 'connect-v1-baseline', up: migrationV1 },
  { version: 2, name: 'connect-v2-wbs-board-audit', up: migrationV2 },
  { version: 3, name: 'connect-v3-reports', up: migrationV3 },
  { version: 4, name: 'connect-v4-wbs-effort-hours', up: migrationV4 },
  { version: 5, name: 'connect-v5-report-week-actual-days', up: migrationV5 },
  { version: 6, name: 'connect-v6-reviews-transition', up: migrationV6 },
  { version: 7, name: 'connect-v7-priority-report-confirm', up: migrationV7 },
  { version: 8, name: 'connect-v8-documents', up: migrationV8 },
  { version: 9, name: 'connect-v9-doc-link', up: migrationV9 },
  { version: 10, name: 'connect-v10-progress-snapshots', up: migrationV10 },
  { version: 11, name: 'connect-v11-template-docs', up: migrationV11 },
  { version: 12, name: 'connect-v12-doc-baseline', up: migrationV12 },
  { version: 13, name: 'connect-v13-change-flow', up: migrationV13 },
  { version: 14, name: 'connect-v14-review-templates', up: migrationV14 },
  { version: 15, name: 'connect-v15-roles-directory', up: migrationV15 },
  { version: 16, name: 'connect-v16-password-login', up: migrationV16 },
  { version: 17, name: 'connect-v17-union-id', up: migrationV17 },
  { version: 18, name: 'connect-v18-rbac-config', up: migrationV18 },
  { version: 19, name: 'connect-v19-risks', up: migrationV19 },
  { version: 20, name: 'connect-v20-drop-legacy-tables', up: migrationV20 },
  { version: 21, name: 'connect-v21-notifications', up: migrationV21 },
  { version: 22, name: 'connect-v22-removed-template-docs', up: migrationV22 },
  { version: 23, name: 'connect-v23-auth-gate', up: migrationV23 },
  { version: 24, name: 'connect-v24-user-id-columns', up: migrationV24 },
  { version: 25, name: 'connect-v25-admin-config-actions', up: migrationV25 },
];

/**
 * 执行所有未应用的迁移（幂等）。
 * @param {import('better-sqlite3').Database} db
 * @returns {number[]} 本次实际应用的版本号
 */
function run(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map(function (r) {
      return r.version;
    })
  );

  const done = [];
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  );

  MIGRATIONS.forEach(function (m) {
    if (applied.has(m.version)) return;

    // 重建表需要临时关闭外键（SQLite 官方 12 步流程）。
    // PRAGMA foreign_keys 在事务内无效，必须先于 BEGIN 设置。
    const fkOn = db.pragma('foreign_keys', { simple: true }) === 1;
    if (fkOn) db.pragma('foreign_keys = OFF');

    const now = new Date().toISOString();
    const tx = db.transaction(function () {
      m.up(db, now);
      record.run(m.version, m.name, now);
    });

    try {
      tx();
      done.push(m.version);
      console.log('[migrations] applied v%d %s', m.version, m.name);
    } finally {
      if (fkOn) db.pragma('foreign_keys = ON');
    }
  });

  return done;
}

/**
 * 当前 schema 版本（未初始化返回 0）。
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
function currentVersion(db) {
  if (!tableExists(db, 'schema_migrations')) return 0;
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return (row && row.v) || 0;
}

module.exports = {
  run,
  currentVersion,
  MIGRATIONS,
  // 导出内省工具，供 seed / 其他 DAL 复用
  tableExists,
  columnsOf,
  hasColumn,
};
