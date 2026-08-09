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

/** 允许的全局角色（与 server/config/enums.js GLOBAL_ROLES 一致，此处内联避免迁移层依赖业务层） */
const VALID_GLOBAL_ROLES = [
  'admin', 'management', 'pmo', 'pm', 'tl', 'qa', 'cm', 'po', 'member',
];

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
        const role = VALID_GLOBAL_ROLES.indexOf(u.role) >= 0 ? u.role : 'member';
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
  const pmRows = db
    .prepare("SELECT id, pm, created_by, created_at FROM projects WHERE pm IS NOT NULL AND pm <> ''")
    .all();
  const insMember = db.prepare(`
    INSERT OR IGNORE INTO project_members (id, project_id, user_open_id, project_role, assigned_by, assigned_at)
    VALUES (?, ?, ?, 'pm', ?, ?)
  `);
  pmRows.forEach(function (p) {
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      ms_id       TEXT,
      code        TEXT,
      name        TEXT,
      owner       TEXT,
      est         TEXT,
      start       TEXT,
      due         TEXT,
      status      TEXT DEFAULT '待开始',
      progress    INTEGER DEFAULT 0,
      crit        INTEGER DEFAULT 0,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      week        TEXT,
      author      TEXT,
      done        TEXT,
      plan        TEXT,
      risk        TEXT,
      risk_due    TEXT,
      res         TEXT,
      snap        TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS report_tasks (
      report_id   TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (report_id, task_id)
    );

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

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_reports_project ON reports(project_id);
    CREATE INDEX IF NOT EXISTS idx_report_tasks_task ON report_tasks(task_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_project ON approvals(project_id);
  `);

  // 遗留库可能缺 tasks.name（早期 schema 漏建）
  if (!hasColumn(db, 'tasks', 'name')) {
    db.exec('ALTER TABLE tasks ADD COLUMN name TEXT');
  }
}

/* ── 迁移 v2：B3 WBS / 看板 / 审计 ────────────────── */

/**
 * 遗留 `tasks.status` → 新契约 `TaskStatus`。
 * ⚠ 与 `server/config/enums.js` 的 `LEGACY_TASK_STATUS_MAP` 逐字一致；
 *   此处内联是沿用本文件既有约定（迁移层不依赖业务层，见 VALID_GLOBAL_ROLES）。
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
