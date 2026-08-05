-- =============================================================================
--  太空字节项目管理系统 · 数据库 Schema v1.0
--  目标位置：server/dal/schema.sql（由 server/dal/connection.js 启动时 exec 执行）
--  方言    ：SQLite（better-sqlite3）；已刻意规避 SQLite 专有语法，便于 P2 切 Postgres
--  对应文档：docs/架构设计-重构v1.md 第 3.1 节
--
--  【迁移策略】Q5 已确认 pm.db 无真实业务数据 → 一期采用「重建」而非「增量迁移」：
--    1. 备份旧 pm.db 为 pm.db.legacy-YYYYMMDD
--    2. 全量执行本文件（幂等：全部 IF NOT EXISTS）
--    3. 执行 server/dal/seed.js 写入 lifecycle_templates + 演示用户
--
--  【已实测】本文件已在 better-sqlite3 内存库执行通过：20 表 + 22 idx + 8 uq，
--            并通过 10 条约束冒烟用例（详见 docs/架构设计-附录A-落地物料.md 第四之二节）
--
--  【保留字提醒】里程碑「当前计划日期」字段名为 planned_date，**不要**写成 current_date ——
--            CURRENT_DATE 是 SQL 保留字，SQLite 建索引会报 non-deterministic functions，
--            Postgres 必须双引号包裹。前端 DTO 对应 plannedDate。
--
--  【约定】（详见架构文档 7.6）
--    - 所有时间字段存 ISO 8601 TEXT；纯日期字段用 'YYYY-MM-DD'
--    - 所有 JSON 字段存 TEXT，由 Repository 层统一 parse/stringify
--    - 所有布尔字段存 INTEGER 0/1，由 Repository 层转 boolean
--    - 列名 snake_case，Repository 出口转 camelCase
--    - 业务 ID = 前缀 + base36（P/M/W/G/GI/R/RV/RS/A/CR/AL/PMB/LT/ST/BR）
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- =============================================================================
-- 1. users —— 用户与全局角色（♻️ 沿用旧表，新增 email/dept/avatar_url/status）
--    PRD: P0-10 / P0-11 / P0-12
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  open_id      TEXT NOT NULL UNIQUE,                       -- 飞书 open_id，全系统用户主键（业务层用它，不用自增 id）
  employee_id  TEXT,                                       -- 工号，飞书返回则写入
  name         TEXT NOT NULL,
  email        TEXT,
  dept         TEXT,                                       -- 部门全路径，如 '研发中心/嵌入式组'
  avatar_url   TEXT,
  global_role  TEXT NOT NULL DEFAULT 'member'
               CHECK (global_role IN ('admin','management','pmo','pm','tl','qa','cm','po','member')),
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','disabled')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- =============================================================================
-- 2. lifecycle_templates —— 生命周期模板（A/B/C 三套，建项目时实例化）
--    PRD: P0-02；definition 结构见 docs/lifecycle/*.json
-- =============================================================================
CREATE TABLE IF NOT EXISTS lifecycle_templates (
  id           TEXT PRIMARY KEY,                           -- LT-A-1
  project_type TEXT NOT NULL CHECK (project_type IN ('A','B','C')),
  version      INTEGER NOT NULL DEFAULT 1,
  name         TEXT NOT NULL,
  definition   TEXT NOT NULL,                              -- JSON: {stages,milestones,docs,roles,granularity,boardDefaults}
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);
-- 同一类型同一时刻只允许一个 active 版本（部分唯一索引；Postgres 语法一致）
CREATE UNIQUE INDEX IF NOT EXISTS uq_tpl_active
  ON lifecycle_templates(project_type) WHERE is_active = 1;

-- =============================================================================
-- 3. projects —— 项目主表（♻️ 保留 approval_step 兼容旧契约）
--    PRD: P0-01 / P0-04 / P0-17
-- =============================================================================
CREATE TABLE IF NOT EXISTS projects (
  id                      TEXT PRIMARY KEY,                -- P + base36
  code                    TEXT NOT NULL UNIQUE,            -- 对外展示编号 P-0012
  name                    TEXT NOT NULL,
  type                    TEXT NOT NULL CHECK (type IN ('A','B','C')),
  classify_input          TEXT,                            -- JSON 判定输入 {contractAmount,hasHardware,hasCustomerAcceptance,isInternalIteration,isInfra}
  classify_suggested      TEXT CHECK (classify_suggested IN ('A','B','C')),
  classify_override_reason TEXT,                           -- type != classify_suggested 时必填（服务层强制）
  customer                TEXT,
  contract_amount         REAL,                            -- 单位：万元
  background              TEXT,
  goal                    TEXT,                            -- JSON string[]：目标条目
  status                  TEXT NOT NULL DEFAULT '草稿'
                          CHECK (status IN ('草稿','审批中','已批准','进行中','挂起','已结项','已终止','已驳回')),
  current_stage_id        TEXT REFERENCES project_stages(id) ON DELETE SET NULL,
  health                  TEXT NOT NULL DEFAULT 'green' CHECK (health IN ('green','yellow','red')),
  plan_start              TEXT,
  plan_end                TEXT,
  actual_end              TEXT,
  approval_step           INTEGER NOT NULL DEFAULT 0,      -- ♻️ 旧契约兼容字段，由 Review 引擎同步写入
  template_id             TEXT REFERENCES lifecycle_templates(id),
  created_by              TEXT NOT NULL,                   -- users.open_id
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT                             -- 软删（O7 建议，待确认；列表查询统一 WHERE deleted_at IS NULL）
);

-- =============================================================================
-- 4. project_members —— 项目级角色任命（🆕 项目角色不进 token，每次查库解析）
--    PRD: P0-04 / P0-10
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_members (
  id           TEXT PRIMARY KEY,                           -- PMB + base36
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_open_id TEXT NOT NULL REFERENCES users(open_id),
  project_role TEXT NOT NULL
               CHECK (project_role IN ('pm','tl','po','qa','cm','pmo','member')),
  assigned_by  TEXT NOT NULL,
  assigned_at  TEXT NOT NULL
);

-- =============================================================================
-- 5. project_stages —— 阶段实例（模板实例化产物，seq 顺序推进）
--    PRD: P0-02
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_stages (
  id          TEXT PRIMARY KEY,                            -- ST + base36
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,                            -- 1..n
  code        TEXT NOT NULL,                               -- S1..Sn
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT '未开始'
              CHECK (status IN ('未开始','进行中','已完成')),
  started_at  TEXT,
  finished_at TEXT
);

-- =============================================================================
-- 6. quality_gates —— 质量门（阶段末硬门控，1 阶段 : 1 门）
--    PRD: P0-03
-- =============================================================================
CREATE TABLE IF NOT EXISTS quality_gates (
  id          TEXT PRIMARY KEY,                            -- G + base36
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage_id    TEXT NOT NULL UNIQUE REFERENCES project_stages(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,                               -- QG1..QG6
  name        TEXT NOT NULL,
  -- ⚠️ 相对架构文档 3.1 的细化：B 类「需求就绪门」门主为 po，故放开至 5 种角色
  owner_role  TEXT NOT NULL CHECK (owner_role IN ('qa','tl','pmo','pm','po')),
  status      TEXT NOT NULL DEFAULT '未开始'
              CHECK (status IN ('未开始','待检查','已通过','有条件通过','不通过')),
  conclusion  TEXT,                                        -- 结论正文
  comment     TEXT,                                        -- 「有条件通过」时的遗留项说明（服务层强制必填）
  decided_by  TEXT,
  decided_at  TEXT,
  created_at  TEXT NOT NULL
);

-- =============================================================================
-- 7. gate_checklist_items —— 门检查项（template 项不可删，custom 可追加）
--    PRD: P0-03
-- =============================================================================
CREATE TABLE IF NOT EXISTS gate_checklist_items (
  id         TEXT PRIMARY KEY,                             -- GI + base36
  gate_id    TEXT NOT NULL REFERENCES quality_gates(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  content    TEXT NOT NULL,
  owner_role TEXT,                                         -- 空 = 门 owner_role 兜底
  checked    INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0,1)),
  checked_by TEXT,
  checked_at TEXT,
  source     TEXT NOT NULL DEFAULT 'template'
             CHECK (source IN ('template','custom'))       -- source='template' 时禁止 DELETE（Repository 白名单拦截）
);

-- =============================================================================
-- 8. milestones —— 里程碑（单向约束核心表）
--    PRD: P0-05 / P0-14
--    ⚠️ baseline_date 建表后任何路径不可 UPDATE（Repository 字段白名单强制）
--    ⚠️ planned_date 仅 change.service.applyDateChange() 可写
--    ⚠️ WBS 重构 D-1（方案 B）：里程碑锚定到生命周期阶段 —— 新增 stage_id / anchor
--    ⚠️ WBS 重构：原 `CHECK (planned_date >= baseline_date)` 已删除。
--       方向规则的真实语义是「延期(晚于基线)必须走变更单，提前(早于基线)可直接改」，
--       DB 层硬拦提前与服务层实现冲突（PRD 三层矛盾之一），故下沉由服务层单点裁决。
-- =============================================================================
CREATE TABLE IF NOT EXISTS milestones (
  id             TEXT PRIMARY KEY,                         -- M + base36
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,                            -- M1..M7
  name           TEXT NOT NULL,
  stage_id       TEXT REFERENCES project_stages(id) ON DELETE SET NULL,
                                                           -- 所属生命周期阶段；NULL = 未锚定（B/C 类模板缺省、存量数据）
  anchor         TEXT CHECK (anchor IN ('start','mid','end')),
                                                           -- 阶段内锚点位置；stage_id 为 NULL 时必为 NULL
  baseline_date  TEXT NOT NULL,                            -- 原始基线，永不修改
  planned_date   TEXT NOT NULL,                            -- 当前计划；建表时 = baseline_date
  delay_days     INTEGER NOT NULL DEFAULT 0,               -- planned_date - baseline_date（服务层派生写入；正数=延期，负数=提前）
  status         TEXT NOT NULL DEFAULT '未开始'
                 CHECK (status IN ('未开始','进行中','已达成','已逾期')),
  done           INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  done_at        TEXT,
  last_change_id TEXT REFERENCES changes(id),              -- 最近一次改动 planned_date 的变更单
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);

-- =============================================================================
-- 9. wbs_nodes —— WBS 树（原 tasks 表升级；自引用；看板 = 叶子节点按 status 分组视图）
--    PRD: P0-06 / P0-07
--    ⚠️ WBS 重构 D-1（方案 B）：node_type='stage' 的节点（前端文案「工作分区」）
--       通过 lifecycle_stage_id 绑定到 project_stages，形成「阶段为脊」的结构。
--    ⚠️ WBS 重构 D-2：层级规则（父子类型 / 最大深度 / 是否必须绑阶段）由
--       lifecycle_templates.definition.wbsRules 驱动，DDL 不表达，服务层 R11 强制。
-- =============================================================================
CREATE TABLE IF NOT EXISTS wbs_nodes (
  id           TEXT PRIMARY KEY,                           -- W + base36
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id    TEXT REFERENCES wbs_nodes(id) ON DELETE CASCADE,  -- NULL = 根节点
  wbs_code     TEXT NOT NULL,                              -- '1.2.3'，服务端生成 + 移动后重排
  level        INTEGER NOT NULL,                           -- 1..n，= wbs_code 段数
  node_type    TEXT NOT NULL DEFAULT 'task'
               CHECK (node_type IN ('stage','package','task')),
  lifecycle_stage_id TEXT REFERENCES project_stages(id) ON DELETE SET NULL,
                                                           -- 仅 node_type='stage' 可有值；其余类型服务层强制置 NULL
  name         TEXT NOT NULL,
  description  TEXT,
  owner        TEXT,                                       -- users.open_id；叶子必填（服务层强制）
  estimate_days REAL,                                      -- 人日；叶子必填（服务层强制）
  actual_days  REAL,
  start_date   TEXT,
  due_date     TEXT,
  status       TEXT NOT NULL DEFAULT '待办'
               CHECK (status IN ('待办','进行中','待评审','完成','阻塞')),
  progress     INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  board_order  INTEGER NOT NULL DEFAULT 0,                 -- 看板同列内排序
  is_critical  INTEGER NOT NULL DEFAULT 0 CHECK (is_critical IN (0,1)),
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);

-- =============================================================================
-- 10. board_configs —— 看板列与 WIP 配置（1 项目 : 1 行）
--     PRD: P0-07
-- =============================================================================
CREATE TABLE IF NOT EXISTS board_configs (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  columns    TEXT NOT NULL,                                -- JSON: [{key:'待办',label:'待办'},...]
  wip_limits TEXT NOT NULL,                                -- JSON: {"进行中":5}；0 = 不限
  updated_at TEXT NOT NULL
);

-- =============================================================================
-- 11. reports —— 结构化周报（四段式）
--     PRD: P0-08
-- =============================================================================
CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,                          -- R + base36
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  week          TEXT NOT NULL,                             -- ISO 周：'2026-W11'
  week_start    TEXT NOT NULL,                             -- 周一 YYYY-MM-DD
  week_end      TEXT NOT NULL,                             -- 周日 YYYY-MM-DD
  author        TEXT NOT NULL,                             -- users.open_id
  status        TEXT NOT NULL DEFAULT '草稿' CHECK (status IN ('草稿','已提交')),
  done_note     TEXT,                                      -- ① 本周完成：任务清单外的补充说明
  plan_items    TEXT,                                      -- ② 下周计划：JSON string[]
  resource_note TEXT,                                      -- ④ 资源/协作需求
  snapshot      TEXT,                                      -- JSON：提交时冻结的进度快照（③风险另存 report_risks）
  submitted_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- =============================================================================
-- 12. report_tasks —— 周报 ① 段关联任务及进度冻结（♻️ 旧表升级为指向 wbs_nodes）
--     PRD: P0-08
-- =============================================================================
CREATE TABLE IF NOT EXISTS report_tasks (
  report_id        TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  node_id          TEXT NOT NULL REFERENCES wbs_nodes(id) ON DELETE CASCADE,
  progress_before  INTEGER,
  progress_after   INTEGER,
  PRIMARY KEY (report_id, node_id)
);

-- =============================================================================
-- 13. report_risks —— 周报 ③ 段风险条目（owner / due_date 必填，制度硬要求）
--     PRD: P0-08
-- =============================================================================
CREATE TABLE IF NOT EXISTS report_risks (
  id               TEXT PRIMARY KEY,
  report_id        TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  description      TEXT NOT NULL,
  owner            TEXT NOT NULL,                          -- NOT NULL：制度「风险必须有责任人」
  due_date         TEXT NOT NULL,                          -- NOT NULL：制度「风险必须有解决时限」
  promoted_risk_id TEXT REFERENCES risks(id)               -- P1：升级进风险登记册后回填
);

-- =============================================================================
-- 14. reviews —— 统一评审引擎主表（formal / technical / code / ccb / project 五合一）
--     PRD: P0-09 / P0-14
-- =============================================================================
CREATE TABLE IF NOT EXISTS reviews (
  id           TEXT PRIMARY KEY,                           -- RV + base36
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ref_type     TEXT NOT NULL
               CHECK (ref_type IN ('project','stage','gate','milestone','change','doc','pr')),
  ref_id       TEXT,                                       -- 被评审实体 id；ref_type='project' 时 = project_id
  review_type  TEXT NOT NULL
               CHECK (review_type IN ('formal','technical','code','ccb','project')),
  title        TEXT NOT NULL,
  template_key TEXT,                                       -- 复用 config/approval-templates.js 的 key（♻️ 兼容旧模板）
  mode         TEXT NOT NULL CHECK (mode IN ('serial','parallel_veto','single')),
  status       TEXT NOT NULL DEFAULT '草稿'
               CHECK (status IN ('草稿','审批中','已通过','已驳回','已撤回')),
  current_step INTEGER NOT NULL DEFAULT 0,                 -- 仅 serial 模式使用
  initiator    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  closed_at    TEXT
);

-- =============================================================================
-- 15. review_steps —— 评审步骤（serial 按 step_index 推进；parallel_veto 全部 current）
--     PRD: P0-09
-- =============================================================================
CREATE TABLE IF NOT EXISTS review_steps (
  id               TEXT PRIMARY KEY,                       -- RS + base36
  review_id        TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  step_index       INTEGER NOT NULL,
  role             TEXT NOT NULL
                   CHECK (role IN ('pmo','tl','management','customer_rep','pm','po','qa','cm')),
  assignee_open_id TEXT,                                   -- 可空：空则按 role 在 project_members / users 中解析
  required         INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','current','approved','rejected','skipped')),
  decided_by       TEXT,
  decided_at       TEXT,
  comment          TEXT
);

-- =============================================================================
-- 16. approvals —— 审批留痕流水（♻️ 保留旧表名与语义，新增 review_id / evidence_url）
--     PRD: P0-09 / P0-15
-- =============================================================================
CREATE TABLE IF NOT EXISTS approvals (
  id             TEXT PRIMARY KEY,                         -- A + base36
  review_id      TEXT REFERENCES reviews(id) ON DELETE CASCADE,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_index     INTEGER,
  step_role      TEXT,
  actor_open_id  TEXT NOT NULL,
  actor_name     TEXT NOT NULL,
  action         TEXT NOT NULL
                 CHECK (action IN ('submit','approve','reject','withdraw','proxy_approve')),
  comment        TEXT,
  evidence_url   TEXT,                                     -- 客户代表代录凭证外链（O6：一期存外链不做上传）
  created_at     TEXT NOT NULL
);

-- =============================================================================
-- 17. changes —— 变更单（里程碑延后 / 需求基线变更的唯一合法通道）
--     PRD: P0-14 / P0-05
-- =============================================================================
CREATE TABLE IF NOT EXISTS changes (
  id              TEXT PRIMARY KEY,                        -- CR + base36
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,                           -- 项目内展示编号 CR-001
  change_type     TEXT NOT NULL
                  CHECK (change_type IN ('milestone_date','requirement_baseline','scope','other')),
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  impact_analysis TEXT NOT NULL,                           -- 制度硬要求：变更必须有影响分析
  effort_days     REAL NOT NULL DEFAULT 0,                 -- 影响工作量（人日），>= 3 触发 CCB
  target_type     TEXT CHECK (target_type IN ('milestone','requirement','scope')),
  target_id       TEXT,
  payload         TEXT,                                    -- JSON: {fromDate,toDate} 等应用参数
  route           TEXT NOT NULL CHECK (route IN ('pm_only','ccb')),
  status          TEXT NOT NULL DEFAULT '草稿'
                  CHECK (status IN ('草稿','审批中','已批准','已驳回','已实施')),
  review_id       TEXT REFERENCES reviews(id),
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  applied_at      TEXT
);

-- =============================================================================
-- 18. audit_logs —— 全实体审计（制度「可追溯」落地表，只写不改不删）
--     PRD: P0-15
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,                          -- AL + base36
  project_id    TEXT,                                      -- 非项目实体（如 user）可为 NULL，故不加外键
  entity_type   TEXT NOT NULL
                CHECK (entity_type IN ('project','stage','gate','gate_item','milestone','wbs_node',
                                       'report','review','change','user','member','board')),
  entity_id     TEXT NOT NULL,
  action        TEXT NOT NULL
                CHECK (action IN ('create','update','delete','status_change','decide','approve','reject','apply','login')),
  actor_open_id TEXT NOT NULL,
  actor_name    TEXT NOT NULL,
  before        TEXT,                                      -- JSON 快照
  after         TEXT,                                      -- JSON 快照
  diff          TEXT,                                      -- JSON 仅变化字段 {field:{from,to}}
  summary       TEXT NOT NULL,                             -- 人话描述，前端时间线直接展示
  request_id    TEXT,                                      -- 关联 X-Request-Id
  created_at    TEXT NOT NULL
);

-- =============================================================================
-- 19. risks —— 风险登记册（P1：一期建表不开放 UI，周报风险可升级至此）
--     PRD: P1-01
-- =============================================================================
CREATE TABLE IF NOT EXISTS risks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code        TEXT,
  description TEXT NOT NULL,
  category    TEXT,
  probability INTEGER CHECK (probability BETWEEN 1 AND 5),
  impact      INTEGER CHECK (impact BETWEEN 1 AND 5),
  risk_value  INTEGER,                                     -- probability * impact
  strategy    TEXT,
  owner       TEXT,
  status      TEXT,
  review_date TEXT
);

-- =============================================================================
-- 20. documents —— 文档清单（P1：一期建表不开放 UI，模板已在 lifecycle definition 中声明）
--     PRD: P1-03
-- =============================================================================
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage_id      TEXT REFERENCES project_stages(id) ON DELETE SET NULL,
  template_key  TEXT,
  name          TEXT NOT NULL,
  status        TEXT,
  version       TEXT,
  baseline_flag INTEGER NOT NULL DEFAULT 0 CHECK (baseline_flag IN (0,1)),
  url           TEXT,
  owner         TEXT
);

-- =============================================================================
--  索引（架构文档 3.1 节尾部清单）
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_pm_project     ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_pm_user        ON project_members(user_open_id);
CREATE INDEX IF NOT EXISTS idx_stage_project  ON project_stages(project_id, seq);
CREATE INDEX IF NOT EXISTS idx_gate_project   ON quality_gates(project_id);
CREATE INDEX IF NOT EXISTS idx_gate_stage     ON quality_gates(stage_id);
CREATE INDEX IF NOT EXISTS idx_item_gate      ON gate_checklist_items(gate_id, seq);
CREATE INDEX IF NOT EXISTS idx_ms_project     ON milestones(project_id, planned_date);
CREATE INDEX IF NOT EXISTS idx_ms_stage       ON milestones(stage_id);
CREATE INDEX IF NOT EXISTS idx_wbs_project    ON wbs_nodes(project_id, wbs_code);
CREATE INDEX IF NOT EXISTS idx_wbs_parent     ON wbs_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_wbs_lcstage    ON wbs_nodes(lifecycle_stage_id);
CREATE INDEX IF NOT EXISTS idx_wbs_milestone  ON wbs_nodes(milestone_id);
CREATE INDEX IF NOT EXISTS idx_wbs_owner      ON wbs_nodes(owner, status);
CREATE INDEX IF NOT EXISTS idx_wbs_board      ON wbs_nodes(project_id, status, board_order);
CREATE INDEX IF NOT EXISTS idx_report_project ON reports(project_id, week);
CREATE INDEX IF NOT EXISTS idx_rrisk_report   ON report_risks(report_id, seq);
CREATE INDEX IF NOT EXISTS idx_review_project ON reviews(project_id, status);
CREATE INDEX IF NOT EXISTS idx_review_ref     ON reviews(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_step_review    ON review_steps(review_id, step_index);
CREATE INDEX IF NOT EXISTS idx_step_assignee  ON review_steps(assignee_open_id, status);
CREATE INDEX IF NOT EXISTS idx_step_role      ON review_steps(role, status);
CREATE INDEX IF NOT EXISTS idx_approval_proj  ON approvals(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_change_project ON changes(project_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_entity   ON audit_logs(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_project  ON audit_logs(project_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_report    ON reports(project_id, week, author);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wbs_code  ON wbs_nodes(project_id, wbs_code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_member    ON project_members(project_id, user_open_id, project_role);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stage_seq ON project_stages(project_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ms_code   ON milestones(project_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gate_code ON quality_gates(project_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_change_code ON changes(project_id, code);

-- =============================================================================
--  ⚠️ 服务层必须自行保证、DDL 无法表达的约束（对应架构文档 3.4 节）
--    R1  每项目 pm / tl 各有且仅有 1 人               → project.service.assignRoles()
--    R2  B 类项目必须有 po 才能提交立项               → project.service.transition()
--    R3  milestones.baseline_date 永不 UPDATE         → Repository 字段白名单
--    R4  milestones.planned_date 仅变更单可写         → change.service.applyDateChange()
--    R5  gate_checklist_items.source='template' 不可删 → gate.service.removeItem()
--    R6  阶段顺序推进 + 当前门通过才可 advance         → lifecycle.service.advanceStage()
--    R7  wbs_nodes 叶子必须有 owner + estimate_days    → wbs.service.createNode/update()
--    R8  wbs_nodes 移动不得成环                        → wbs.service.move() 祖先链校验
--    R9  WIP 上限                                     → board.service.assertWip()
--    R10 一票否决 / 结项拦截 / 结项后只读              → review.service / project.service / rbac 中间件
--    R11 WBS 父子类型 / 最大深度 / 根层类型            → wbs.service.validatePlacement()（读 wbsRules）
--    R12 node_type='stage' 必绑 lifecycle_stage_id     → 同上；A/C 强制，B 由 wbsRules.requireStageBinding=false 放行
--    R13 里程碑方向：晚于基线必须走变更单，早于基线直改  → milestone.service.reschedule()
--        （原 DB CHECK (planned_date >= baseline_date) 已删，见第 8 表注释）
-- =============================================================================

-- =============================================================================
--  ⚙️ 迁移脚本片段 —— v2 → v3（WBS / 阶段 / 里程碑关系重构）
--     SQLite 不支持 DROP CONSTRAINT，删 CHECK 必须「重建表」；
--     加列可用 ALTER TABLE ADD COLUMN（SQLite 支持，且新列必须可空 / 有常量默认值）。
--     ⚠️ 执行前务必先备份 .db 文件（回滚窗口 = 备份文件本身）。
-- =============================================================================
-- PRAGMA wal_checkpoint(TRUNCATE);          -- 1) 落盘 WAL，确保备份文件自洽
-- .backup 'pm.db.bak-YYYYMMDD'              -- 2) 冷备（回滚窗口）
-- PRAGMA foreign_keys = OFF;                -- 3) 重建表期间关外键（SQLite 要求在事务外设置）
-- BEGIN IMMEDIATE;
--
-- -- 3.1 wbs_nodes：仅加列，无需重建
-- ALTER TABLE wbs_nodes ADD COLUMN lifecycle_stage_id TEXT REFERENCES project_stages(id) ON DELETE SET NULL;
--
-- -- 3.2 milestones：需删 CHECK → 重建表
-- CREATE TABLE milestones__new (
--   id             TEXT PRIMARY KEY,
--   project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
--   code           TEXT NOT NULL,
--   name           TEXT NOT NULL,
--   stage_id       TEXT REFERENCES project_stages(id) ON DELETE SET NULL,
--   anchor         TEXT CHECK (anchor IN ('start','mid','end')),
--   baseline_date  TEXT NOT NULL,
--   planned_date   TEXT NOT NULL,
--   delay_days     INTEGER NOT NULL DEFAULT 0,
--   status         TEXT NOT NULL DEFAULT '未开始'
--                  CHECK (status IN ('未开始','进行中','已达成','已逾期')),
--   done           INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
--   done_at        TEXT,
--   last_change_id TEXT REFERENCES changes(id),
--   created_at     TEXT NOT NULL,
--   updated_at     TEXT NOT NULL,
--   deleted_at     TEXT
-- );
-- INSERT INTO milestones__new
--   (id, project_id, code, name, stage_id, anchor, baseline_date, planned_date,
--    delay_days, status, done, done_at, last_change_id, created_at, updated_at, deleted_at)
-- SELECT
--    id, project_id, code, name, NULL,     NULL,   baseline_date, planned_date,
--    delay_days, status, done, done_at, last_change_id, created_at, updated_at, deleted_at
-- FROM milestones;                          -- 存量一律 stage_id / anchor = NULL（Q-1 安全默认，由 PM 手工补锚）
-- DROP TABLE milestones;
-- ALTER TABLE milestones__new RENAME TO milestones;
--
-- -- 3.3 重建索引（DROP TABLE 会连带删除其索引）
-- CREATE INDEX IF NOT EXISTS idx_ms_project ON milestones(project_id, planned_date);
-- CREATE INDEX IF NOT EXISTS idx_ms_stage   ON milestones(stage_id);
-- CREATE UNIQUE INDEX IF NOT EXISTS uq_ms_code ON milestones(project_id, code);
-- CREATE INDEX IF NOT EXISTS idx_wbs_lcstage   ON wbs_nodes(lifecycle_stage_id);
-- CREATE INDEX IF NOT EXISTS idx_wbs_milestone ON wbs_nodes(milestone_id);
--
-- COMMIT;
-- PRAGMA foreign_key_check;                 -- 4) 必须返回空结果集，否则立刻用备份回滚
-- PRAGMA foreign_keys = ON;
-- PRAGMA wal_checkpoint(TRUNCATE);          -- 5) 再次落盘
-- =============================================================================
