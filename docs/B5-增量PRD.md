# 工作日志（B5）· 增量 PRD

> **文档性质**：增量变更定义（只描述相对 B4 交付后的 5 项改动），非全盘重设计。
> **基线**：B4 已交付 —— `web/src/pages/projects/ReportsPage.tsx` + `components/report/ReportFormModal.tsx` + `WbsPage.tsx`（节点行「写日志」入口，`lockNodeId` 锁定）+ `server/routes/reports.routes.js` + `server/services/report.service.js`（work_reports / work_report_tasks / work_report_risks；提交回写 WBS 进度，含 N5 跨项目 nodeId 越权修复）。
> **落地方式**：本 PRD 作为 PM→架构→工程师→QA 的标准输入。**纯文档产出，不写代码、不碰数据库。**
> **范围**：工作日志（ReportsPage / ReportFormModal / WbsPage 写日志入口 / report.service.js / reports.routes.js）+ 测试数据清理脚本；其余页面不在本轮改动范围。
> **默认主题**：浅色（`themeContext.tsx#DEFAULT_THEME_MODE='light'`）；品牌青展示色 `#6DA8AE`、交互加深 `#2E7D87`（见 `theme/tokens.ts`）。

---

## 0. 产品目标（一句）

让工作日志「写得更准、找得更快、看得更舒服」：WBS 入口写日志时锁定单一任务并只读带入进度（杜绝进度数据混乱），列表补全进度文案与「填报时间」排序，统一浅色品牌视觉，并安全清空测试数据回归干净基线。

## 1. 用户故事

| # | 用户故事 |
|---|---------|
| US1 | 作为任务负责人，从 WBS 任务/子任务点「写日志」时，我希望日志只关联当前任务、进度由系统只读带入，避免误关联其他任务或手填进度导致数据混乱。 |
| US2 | 作为填报人，新建日志看到「完%」时，我希望进度字段有完整明确的标题（如「完成进度(%)）」），与后端字段语义一致，不会误解含义。 |
| US3 | 作为项目经理，我希望日志列表有「填报时间」列并支持排序（默认倒序），以便快速定位最新填报/最新提交的日志。 |
| US4 | 作为日常使用者，我希望工作日志列表与详情/编辑弹窗视觉统一、清爽美观（浅色主题 + 品牌青），信息层级清楚，空态/加载态友好。 |
| US5 | 作为管理员，我希望一键安全清空全部测试业务数据（保留演示账号与系统模板），让应用回到干净可演示基线。 |

## 2. 需求池（P0 / P1）与落点

| ID | 需求 | 优先级 | 主要落点 |
|----|------|--------|---------|
| B5-R1 | WBS 入口写日志：**仅可关联当前任务** + **进度只读带入** | P0（已确认） | `ReportFormModal.tsx`（锁定逻辑集中于此，WBS 页与 ReportsPage 旧链接共享）、`WbsPage.tsx` 文案 |
| B5-R2 | 进度字段文案补全：「完%」→「完成进度(%))」，前后端一致性核查 | P0 | `ReportFormModal.tsx` label；对照 `report.service.js` / `types/report.ts` 字段语义 |
| B5-R3 | 列表增加「填报时间」列 + 排序（默认倒序） | P0 | `ReportsPage.tsx`、`report.service.js#listReports`（默认排序） |
| B5-R4 | 列表页 + 详情/编辑弹窗视觉走查（浅色主题 + 品牌青对齐） | P1 | `ReportsPage.tsx`、`ReportFormModal.tsx`、`components/common` 复用组件 |
| B5-R5 | 清理测试数据（安全执行方案，保留 users + lifecycle_templates） | P0（已确认） | 新增运维脚本（如 `scripts/reset-business-data.js`），不碰用户数据 |

---

## 3. 关键交互说明

### 3.1 WBS 入口写日志：任务全锁定 + 进度只读（B5-R1，已确认）

**现状**（B4）：WBS 叶子节点「写日志」→ 页内打开 `ReportFormModal`，`lockNodeId=当前节点`；仅当前节点 checkbox `checked+disabled`，**其他任务仍可勾选**，且当前节点「完%」输入框**可编辑**（弹窗内注释明确「仅锁定关联关系，进度值输入保持可编辑」）。

**B5 改为**（在 `ReportFormModal` 内集中实现，两个入口行为一致）：

1. **任务树全锁定**：`effectiveLockNodeId` 非空（即从 WBS 入口进入）时：
   - 当前节点：checkbox `checked + disabled`，不可取消；
   - **其他所有节点**：checkbox `disabled`（不可勾选）；
   - 锁图标 + tooltip 保留：`由「写日志」进入，仅可关联当前任务`。
2. **进度只读带入**：任务树内**所有**「完成进度(%)」输入框 `disabled`（灰显）；当前节点值 = WBS 该节点当前进度（`taskMap` 初始化即 `n.progress`，叶子为实际值），不可手填；其他节点因不可勾选，其进度输入一并禁用，防误改。
3. **文案更新**（禁止再出现「可继续勾选其他任务」）：
   - 区域 caption 改为：`由「写日志」进入，仅关联当前任务；进度由系统带入，不可修改`；
   - 行级锁 tooltip 同步改为：`由「写日志」进入，仅可关联当前任务`。
4. **边界保持**：
   - `lockNodeId` 指向非叶子（仅 ReportsPage 旧链接可能触发）：维持降级为不锁定（`effectiveLockNodeId=null`），caption 提示 `该任务已有下级，请到具体子任务记录进度`；
   - 父节点行「写日志」按钮维持禁用（R5-P0-3 现状，不回归）；
   - 编辑态不受影响：编辑已有日志仍按现状（任务区只读、`payload.tasks` 原样回传）。
5. **后端**：本期**不做**新增字段/强校验（前端锁定即可保证正常路径）；`resolveTaskRefs` 仍按 `selected` 过滤回写，未勾选节点进度不回写，与 B4 一致（防绕过加固见 §6-Q3，P1 可选）。

### 3.2 进度字段文案补全（B5-R2）

- `ReportFormModal.tsx` 任务树行内 `<TextField label="完%">`（约 `:321`）改为 `label="完成进度(%)"`。
- **一致性核查**：后端字段为 `work_report_tasks.progress_before / progress_after` ↔ API `progressBefore / progressAfter`（0~100 整数，`report.service.js#toProgress` 归一裁剪）；前端详情 Chip 展示 `before% → after%`。确认口径一致，不引入第二套文案（如「进度/%」混用）。
- 全项目（工作日志相关组件）不得残留「完%」字样（验收以 grep 为准）。

### 3.3 列表「填报时间」列与排序交互（B5-R3）

- **新增列**：「填报时间」= `createdAt`（新建时刻，草稿/已提交均有值）；展示格式 `YYYY-MM-DD HH:mm`（`fmtDateTime`），空值显示 `—`；加 `title` 展示完整时间。
- **默认排序**：按填报时间**倒序**（desc）。推荐做法：`report.service.js#listReports` 默认 `ORDER BY created_at DESC`（一行改动，与前端默认一致）；前端列表默认排序状态同样为 填报时间 desc。
- **排序交互**：点击「填报时间」表头在 升序/降序 间切换，表头显示排序箭头；其余列行为不变。实现可在 `ReportsPage` 内做页面级排序状态（不改共享 `DataTable` 组件，最小改动）；如后续多列都要排序，再扩展 `DataTable` 可选 `sortable`。
- 草稿（`submittedAt=null`）也能按填报时间正常排序展示；现有「提交时间」列保留（时间口径见 §6-Q1）。

### 3.4 查看页视觉要点（B5-R4）

范围：ReportsPage **列表页** + **详情弹窗** + **新建/编辑弹窗**，不改全站主题（浅色已是全局默认）。

- **列表页**：
  - 表头浅灰底、字号统一、列宽/`nowrap` 对齐；行 hover 浅青（`alphaOf(tokens.brand.primary, 0.06)`）；
  - 时间列（填报时间/提交时间）统一 `fmtDateTime`；空态/加载态沿用 `EmptyState` / `LoadingState`（骨架行高统一），文案保持友好；
  - 「关联任务」「风险项」Chip 尺寸统一（height 20）。
- **详情弹窗**：
  - 顶部 meta 行：状态 Chip + 填报人 + 填报时间 + 提交时间（caption 次要色）；
  - 四段信息用 `REPORT_SECTION_TITLE` 统一标题，标题加品牌青装饰（如左侧竖条/圆点）；正文 `pre-wrap`、间距统一（spacing 1.5~2）；
  - 关联任务行：节点名 + 进度 Chip（`before% → after%`）；风险行：描述 + 责任人 + 截止日 Chip。
- **新建/编辑弹窗**：
  - 各 section 间距统一（Stack spacing 2）；任务关联区容器沿用 `tokens.border.subtle` + 圆角 1.5 + 最大高 320 滚动；
  - 锁定节点行：复选框 `checked+disabled` + 锁图标 + 品牌青 tint 背景（`alphaOf(brand, 0.05)`）；
  - 「完成进度(%)」输入框禁用态灰显（B5-R2 联动）；进度条与输入框列对齐；
  - 风险行卡片样式统一（p 1 / border subtle / radius 1.5）。
- **主题约束**：所有面板/弹窗用浅色 token（`bg.card` / `bg.elevated`），**禁止深色覆写**；主按钮/链接/选中用交互色 `#2E7D87`（白字对比度 4.77:1 ✅），`#6DA8AE` 仅用于装饰/展示。

### 3.5 测试数据清理安全执行方案（B5-R5，已确认）

**目标**：清空全部业务数据（100 项目 / 246 里程碑 / 457 WBS 节点 / 57 看板配置 / 63 质量门 / 133 检查项 / 1139 审计日志 / 5 工作日志 / 200 项目成员 / 审批与遗留报告等），**保留** `users`（11 个演示账号）、`lifecycle_templates`（3 条）、`schema_migrations`。

**安全执行步骤（破坏性运维，务必按序）**：

1. **停写**：停止/确认无业务写入（或停服窗口执行）。
2. **备份**：先 `PRAGMA wal_checkpoint(TRUNCATE)` 落盘 WAL，再用 `sqlite3 pm.db ".backup 'pm.db.bak-YYYYMMDD'"`（或 better-sqlite3 `db.backup()`）生成冷备 —— **回滚窗口 = 备份文件本身**。
3. **清空**：在**单个事务**内执行。两种等价方案：
   - 方案 A（推荐，简单）：事务内 `PRAGMA foreign_keys=OFF` → 按下列依赖顺序逐表 `DELETE` → 事务末 `PRAGMA foreign_key_check` 必须返回空 → 恢复 `PRAGMA foreign_keys=ON`；
   - 方案 B（FK 保持 ON）：严格按「子表 → 父表」顺序 DELETE（下述顺序已按依赖排好）。
4. **序列/索引**：业务表主键均为 TEXT 前缀 ID，无自增序列，无需重置；`users.id`（AUTOINCREMENT）保留不动。可选 `VACUUM` 收缩文件。
5. **验证**（脚本自动断言）：`users=11`、`lifecycle_templates=3`、`schema_migrations≥3`、所有业务表 `COUNT(*)=0`、`PRAGMA foreign_key_check` 为空、备份文件存在。
6. **回滚**：恢复备份文件即可（替换 pm.db 并重新 checkpoint）。

**清空顺序（子→父，含 legacy 与 B4 表；脚本内对每张表做 `sqlite_master` 存在性守卫）**：

1. `approvals`（新旧审批流水）
2. `review_steps` → `reviews`（若存在）
3. `audit_logs`
4. `work_report_tasks` → `work_report_risks` → `work_reports`（B4 工作日志）
5. `report_tasks` → `reports` → `tasks`（legacy 遗留表，@deprecated 路由仍读）
6. `board_configs`
7. `gate_checklist_items` → `quality_gates`
8. `changes`（引用 reviews / milestones，先删）
9. `project_members`
10. `risks`、`documents`（若存在）
11. `wbs_nodes`（自引用 CASCADE；先于 milestones / project_stages）
12. `milestones`、`project_stages`（若存在）
13. `projects`

> 注：`work_report_tasks.node_id` 无外键（B4 建表未加 REFERENCES wbs_nodes），清空顺序上放在 `work_reports` 前即可，无 FK 阻塞。

---

## 4. 验收要点

| ID | 验收要点 |
|----|---------|
| B5-R1 | ① WBS 叶子「写日志」→ 弹窗任务树仅当前节点可关联（checked+disabled），其余节点 checkbox 全 disabled；② 当前节点「完成进度(%)」disabled 且值 = WBS 当前进度，不可手填；③ 提交后该节点进度按带入值回写，WBS/里程碑联动不回归；④ 区域文案无「可继续勾选其他任务」残留；⑤ 父节点「写日志」仍禁用；⑥ 编辑已有日志行为不回归；⑦ 旧链接（prefillNodeId→lockNodeId）行为一致，指向非叶子仍降级。 |
| B5-R2 | ① 新建/编辑弹窗 label =「完成进度(%))」，工作日志相关组件 grep 无「完%」残留；② 与后端 `progress_before/progress_after`（0~100 整数）语义一致；详情 Chip `before% → after%` 保留。 |
| B5-R3 | ① 列表新增「填报时间」列（createdAt，`YYYY-MM-DD HH:mm`，空值 —）；② 默认按填报时间倒序；③ 点击表头可在升/降间切换且有箭头；④ 草稿（submittedAt=null）正常展示与排序；⑤ 现有「提交时间」列不回归。 |
| B5-R4 | ① 列表/详情/编辑弹窗均为浅色主题，无深色覆写；② 主按钮/链接用 `#2E7D87`，`#6DA8AE` 仅装饰；③ 表头/间距/时间格式统一；④ 空态/加载态存在且友好；⑤ 详情四段层级清楚；⑥ 锁定节点行有品牌色 tint + 锁图标。 |
| B5-R5 | ① 执行前生成备份文件；② 清理后 users=11、lifecycle_templates=3、schema_migrations 保留，全部业务表=0；③ `PRAGMA foreign_key_check` 为空；④ 应用可启动、11 个演示账号可登录、项目列表为空、模板仍可新建项目；⑤ 回滚 = 还原备份。 |

---

## 5. 待确认问题（≤5，均给推荐）

| ID | 问题 | 推荐答案 | 影响 |
|----|------|----------|------|
| Q1 | 「填报时间」取 `createdAt`（新建时刻）？与现有「提交时间」（`submittedAt`）**并存**还是替换？ | **并存**：填报时间=createdAt，提交时间=submittedAt（草稿显示 —）；若嫌两列重复，可只保留「填报时间」作唯一时间列（需再确认）。 | 决定列表列结构 |
| Q2 | ReportsPage 旧链接（`location.state.prefillNodeId`）是否也应用 B5-R1 的**全锁定**语义？ | **是**：共享 ReportFormModal，行为一致，不另做分支（旧链接仅 WBS 旧跳转兼容）。 | 决定锁定逻辑作用域 |
| Q3 | 是否需要**后端强制**「lockNodeId 场景仅允许 selected 当前节点」（防前端绕过）？ | **本期否**（前端锁定即可，最小改动）；P1 可选：POST 新增可选 `lockNodeId` 字段，服务端校验 `selected ⊆ {lockNodeId}`。 | 决定是否加契约字段 |
| Q4 | B5-R4 视觉走查是否仅限 ReportsPage 列表 + 详情/编辑弹窗？ | **是**：不改全站主题（浅色已是全局默认），仅本轮覆盖范围。 | 决定改动边界 |
| Q5 | B5-R5 清理后是否重建演示项目/演示数据？ | **否**：仅清空，保留 users + 模板；不重建演示项目（用户已明确「全清业务数据」）。 | 决定清理脚本输出 |

---

## 6. 一句话总结

> 工作日志 B5：WBS 入口写日志改为「仅可关联当前任务 + 进度只读带入」（防进度混乱）、进度文案补全为「完成进度(%)」、列表新增可排序的「填报时间」列（默认倒序）、列表/详情/编辑弹窗按浅色品牌青统一视觉，并以「先备份→单事务按依赖顺序清空→校验」的安全方案清掉全部测试数据、保留 11 个演示账号与系统模板。

**IS_READY: YES**（2 项已确认方案 #1/#5；其余 3 项均有明确推荐与验收口径，无阻塞级歧义）。
