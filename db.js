// 数据库层：使用 better-sqlite3 建立真实 SQL 表
// 所有时间字段存 ISO 字符串；JSON 字段（goal / snap）以 TEXT 存储。
const path = require('path');
const Database = require('better-sqlite3');
const cfg = require('./config');

const db = new Database(cfg.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  open_id     TEXT UNIQUE NOT NULL,
  employee_id TEXT,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  code        TEXT,
  name        TEXT NOT NULL,
  type        TEXT,
  customer    TEXT,
  amount      TEXT,
  background  TEXT,
  goal        TEXT,            -- JSON: {text, progress, target}
  status      TEXT DEFAULT '进行中',
  pm          TEXT,            -- 项目负责人 open_id
  approved_by TEXT,
  created_by  TEXT,            -- 创建人 open_id
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS milestones (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  due         TEXT,
  done        INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ms_id       TEXT,            -- 关联里程碑 id，可空
  code        TEXT,
  owner       TEXT,            -- 任务负责人 open_id
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
  author      TEXT,            -- 报告人 open_id
  done        TEXT,
  plan        TEXT,
  risk        TEXT,
  risk_due    TEXT,
  res         TEXT,
  snap        TEXT,            -- JSON: {taskId: progress} 当时进度快照
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
  action           TEXT NOT NULL,   -- submit | approve | reject | reset
  comment          TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_reports_project ON reports(project_id);
CREATE INDEX IF NOT EXISTS idx_report_tasks_task ON report_tasks(task_id);
CREATE INDEX IF NOT EXISTS idx_approvals_project ON approvals(project_id);
`);

// 迁移：projects 增加 approval_step 列（SQLite 不支持 IF NOT EXISTS，需手动探测）
(function migrate() {
  const cols = db.prepare("PRAGMA table_info(projects)").all().map(function (c) { return c.name; });
  if (cols.indexOf('approval_step') < 0) {
    db.prepare('ALTER TABLE projects ADD COLUMN approval_step INTEGER DEFAULT -1').run();
  }
})();

// 迁移：tasks 增加 name 列（任务名称，早期 schema 漏建导致名称全空/编辑报错/周报读不到）
(function migrateTasks() {
  const cols = db.prepare("PRAGMA table_info(tasks)").all().map(function (c) { return c.name; });
  if (cols.indexOf('name') < 0) {
    db.prepare('ALTER TABLE tasks ADD COLUMN name TEXT').run();
  }
})();

module.exports = db;
