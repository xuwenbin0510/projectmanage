# 工作台 / 待办中心 面板结构梳理与改造方案（2026-08-26）

> 范围：排查 `pm-app` 工作台（Workbench）与统一待办中心（TodoBell）现有面板结构、数据口径，
> 针对产品负责人提出的 4 个设计问题给出落地方案。
> 本次仅出方案（调研 + 设计），**不写实现代码**，待确认后由工程师落地。

---

## 一、TL;DR

4 个问题本质都是**面板口径未对齐**：

| 问题 | 结论 | 根因（实据） |
|---|---|---|
| Q1 周报提醒应体现任务 | 当前只展示项目，需下钻到命中任务 | `listReportReminders` 用 `EXISTS` 判定"有任务"但未 `SELECT` 出任务 |
| Q2 计划周期内任务独立面板 | 需新增面板 + 明确时间段 | 计划周期内任务仅存在于铃铛 `ASSIGNED`，工作台无独立面板 |
| Q3 我的任务列表是否必要 | 与计划周期内子集重叠，建议合并为单面板+筛选 | `listMyTasks`(全量) ⊃ `listMyCycleTasks`(14天窗口) |
| Q4 我的任务进度无已完成段 | **真有已完成任务，是被口径隐藏** | 后端 `myTasks` 主动滤掉 `完成`，`done` 恒为 0（设计如此，但误导） |

---

## 二、现状排查（文件:行号 + DB 实据）

### 2.1 工作台页面 `web/src/pages/WorkbenchPage.tsx`
- 顶部 6 张 StatCard：待我审批 / 逾期任务 / **本周待填周报** / 待决议质量门 / 交付物率 / 周报闭环率（L184–302）
- 图表区（B11，L305–336）：
  - `ProgressDonut` = **我的任务进度**（L319）
  - `PriorityDonut` = **任务优先级分布**（L325）
  - `OverdueBarChart` = **逾期/临期**（按项目计数聚合，L330）
  - `HealthDistBar` = 健康分布（L331）
- 区块（L338–675）：待我审批 / **周报提醒**（L386–461）/ 门控待办 / 待我确认周报 / **我的任务**（全量未完成列表，L548–630）/ 我的项目

### 2.2 统一待办中心 `web/src/hooks/useTodos.ts`
- 六源并发聚合：`APPROVAL` / `ASSIGNED`(=计划周期内) / `OVERDUE` / `BLOCKED` / `REPORT_CONFIRM`
- `REPORT_FILL` 已移除（前序改造）；`ASSIGNED` 来自 `wb.myCycleTasks`（L114）

### 2.3 数据源 `server/services/workbench.service.js`
- `listMyTasks`（L101）：**"我负责且未完成的真叶子任务（全部）"** —— 明确排除 `完成`
- `listMyCycleTasks`（L121–131）：计划周期内 = 有 `dueDate` & 未逾期 & (`startDate` 空 或 `startDate ≤ 今天+14`)
- `listReportReminders`（L183）：项目级入选 + `EXISTS` 任务门控（前序改造）

### 2.4 进度环聚合 `web/src/utils/dashboardAgg.ts`
- L65–66 明文：**"`myTasks` 已在服务端滤掉 `status==='完成'`，因此实际数据里 `done` 通常为 0"**
- `ProgressDonut.tsx`（L55）：副标题写死"共 X 个**未完成任务**"

### 2.5 DB 实据（徐文斌 `ou_222222ca4bdf5b43f81e19997c42c6c3`，`pm.db` schema v20）
| 维度 | 完成 | 待办 | 进行中 | 合计 |
|---|---|---|---|---|
| 徐文斌 各状态 | **13** | 8 | 4 | 25 |
| 徐文斌 已完成叶子 | **10** | — | — | — |
| 全库 `wbs_nodes` | 38 | 220 | 48 | 306 |

➡️ **徐文斌确有 13 个已完成任务（10 个叶子）。"我的任务进度"无已完成段是口径隐藏，不是真没有。**

---

## 三、逐题方案

### Q1 — 本周待填周报提醒应体现具体任务（而非仅项目）
**现状**：`listReportReminders` 返回 `{projectId, projectName, week, weekStart, weekEnd, filled, state}`，
前端"周报提醒"卡片（L386–461）与"本周待填周报"StatCard（L202–217）只渲染项目。命中的任务信息被 `EXISTS` 吃掉。

**方案**：
1. 后端 `listReportReminders`：对每个入选项目，额外查出"我名下、未完成叶子、计划窗口∩本周"的任务列表，作为 `tasks:[{id, wbsCode, name, startDate, dueDate, status, progress}]` 附在 reminder 上（复用 `listMyCycleTasks` 的本周窗口判定）。
2. 前端"周报提醒"卡片：每个项目下缩进展开子任务行（灰阶 + 截止/临期标），保留"去填写"入口（整项目跳周报填写）。
3. StatCard 文案可加"（含 N 项任务）"。

**影响文件**：`server/services/workbench.service.js`(`listReportReminders`)、`web/src/pages/WorkbenchPage.tsx`(周报提醒卡片)、`web/src/types/*`(Reminder 类型加 `tasks`)、`web/src/api/mock/*`(同步)。
**开放问题**：任务较多时是否折叠（建议默认展开前 3，余下"展开全部"）。

---

### Q2 — 计划周期内的任务独立面板 + 明确时间段 + 与临期划界
**现状**：计划周期内任务仅出现在铃铛 `ASSIGNED`；工作台无独立面板。图表区"逾期/临期"是**按项目的计数聚合**，不是任务清单。

**时间段定义（明确）**：
- **计划周期内（前瞻窗口）** = `owner=我` & 叶子 & 未完成 & 有 `dueDate` & 未逾期 & (`startDate` 空 或 `startDate ≤ 今天+14`)。语义 = **"未来两周内需交付或即将启动"**。
  - ⚠️ 当前 `listMyCycleTasks` 窗口是"`start ≤ +14` 且 `due ≥ 今天`"，并非严格"`due ≤ +14`"。面板标题必须显式标注口径（如"未来 14 天（至 YYYY-MM-DD）"），避免误解。
- **临期（紧急窗口）** = `dueDate ∈ [今天, 今天+3]` 且未逾期（前端 `diffDays<=3`，`WorkbenchPage.tsx:566`）。
- **边界**：计划周期内 **⊇** 临期。两者不互斥——临期是计划周期内最紧迫的子集。为免重复，在"计划周期内"面板内对临期任务打"临期"警告标；临期图保留为按项目预警聚合。

**方案**：工作台新增 **"计划周期内的任务" SectionCard**（并列于"我的任务"），数据源 = `getWorkbench.myCycleTasks`（已有，**零新增端点**）。展示：wbsCode/名称/项目/截止/临期标/进度条；点击跳 WBS。标题注明时间段。

**影响文件**：`web/src/pages/WorkbenchPage.tsx`(新增 SectionCard，复用现有行组件 / `MyTasksDrawer`)。
**开放问题**：时间段用"未来 14 天"还是"本周(周一~周日)"？（建议 14 天，与 `CYCLE_LOOKAHEAD_DAYS=14` 一致）

---

### Q3 — "我的任务"列表是否还有存在必要
**现状**："我的任务"（L548）= `listMyTasks` 全量未完成（无日期过滤，按优先级）；"计划周期内"= 其子集（有日期 + 14 天窗口）。两处有子集重叠，且"我的任务"还含**无日期 / 远期**任务（计划周期内排除的）。

**方案（二选一）**：
- **A（推荐，去重最彻底）**：保留"我的任务"**单面板**，顶部加分段筛选 `[全部 | 计划周期内 | 临期 | 逾期]`，同一数据切换视图。不再单独建面板——筛选即满足 Q2"清晰看到计划周期内"的诉求，且消除重叠。
- **B（贴合字面）**：新增独立"计划周期内的任务"面板（见 Q2）+ 保留"我的任务"全量。语义清晰，但两面板存在子集重叠（计划周期内 ⊂ 我的任务）。

**影响文件**：
- A → `WorkbenchPage.tsx`(加筛选态，复用 `myCycleTasks`/`myTasks`)
- B → 多一个 `SectionCard`

---

### Q4 — 我的任务进度为什么没有"已完成"段
**根因（实据）**：`listMyTasks`（L96）注释"未完成的真叶子任务"，服务端滤掉 `完成`；`dashboardAgg.ts:65-66` 写明 `done` 恒为 0；`ProgressDonut` 副标题写死"共 X 个未完成任务"。但 DB 显示徐文斌有 **13 完成（10 叶子）** —— 属**口径误导**，非真无。

**方案**：进度环应反映真实工作量。
1. 后端 `getWorkbench` 新增 `stats.completedTasks`（徐文斌 已完成叶子计数），或返回 `myCompletedCount`。
2. `dashboardAgg.computeTaskProgress`：`done = 该值`，`total = done + 未完成数`，**总完成度% = done/total**（即使 0 也保留"已完成"段，图例可见）。
3. `ProgressDonut` 副标题改为"共 X 个任务（含已完成 Y）"。

**影响文件**：`server/services/workbench.service.js`(`getWorkbench` stats)、`web/src/utils/dashboardAgg.ts`、`web/src/types/dashboard.ts`、`web/src/pages/WorkbenchPage.tsx`(传值)、mock 同步。
**开放问题**："总完成度%"定义为 `done/total`（推荐，直观）还是保持"未完成任务平均进度"？

---

## 四、落地顺序建议
1. **Q4**（最小改动，修正误导最优先）→ 2. **Q1**（后端带任务 + 前端展开）→ 3. **Q2/Q3**（面板/筛选，确认策略后）。

## 五、待确认决策点
1. Q2/Q3 面板策略：选 **A（单面板+筛选）** 还是 **B（独立面板）**？
2. 计划周期内时间段：**未来 14 天** 还是 **本周(周一~周日)**？
3. 总完成度%：**done/total** 还是 **未完成平均进度**？
4. Q1 任务展开默认条数（建议前 3 折叠）？

> 注：用户原话中"预期/临期任务"按现有 `OverdueBarChart`（逾期/临期）理解；若"预期"另指"即将启动/预测"，请指正，方案可补。
