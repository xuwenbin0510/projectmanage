# 增量 PRD · 第三轮 6 项优化（round3-optimize）

> 本文档基于对以下关键文件的 Read 核实后产出（非凭记忆）：
> `src/pages/projects/MilestonesPage.tsx`、`src/pages/projects/WbsPage.tsx`、`src/pages/projects/ReportsPage.tsx`、`src/pages/projects/ProjectCreatePage.tsx`、`src/pages/projects/ProjectOverviewPage.tsx`、
> `src/api/mock/index.ts`（引擎：createProject / createMilestone / deleteMilestone / updateMilestone / upsertReport / updateReport）、`src/api/mock/rules.ts`（compareMilestones / sortMilestones）、`src/api/mock/fixtures/reports.ts`、
> `src/api/contract.ts`（ReportPayload / MilestoneUpdatePayload）、`src/stores/projectStore.ts` / `flowStore.ts`、`src/types/project.ts` / `wbs.ts` / `report.ts`、`src/config/enums.ts`（REPORT_SECTION_TITLE）。

---

## 1) 产品目标

- **G1 一致性**：消除「必备 / 质量门」残留 UI 与「基线日期」歧义，使项目生命周期语义与 K-1（质量门下线）决策一致，用户看到的就是当前真实规则。
- **G2 可追踪**：WBS 节点上下文就近聚合「到期时间 + 工作日志数量 + 日志详情 + 新建日志入口」，降低任务复盘与补记成本。
- **G3 防误改**：工作日志编辑收敛为纯文本修改，任务关联 / 进度 / 责任人只读，保证数据一致与审计可信。

## 2) 用户故事（6 条）

1. 作为项目经理，我希望里程碑列表不再出现「必备」标记，以便聚焦计划日期与达成状态（模板血缘在后台保留，模板预设后续再做）。
2. 作为项目经理，我希望里程碑列表的日期列明确叫「计划日期（到期）」并展示当前生效计划日，以便不再把基线日期误认为到期日。
3. 作为项目成员，我希望 WBS 每个任务节点都直接显示截止日期，以便不点开表单即可判断排期；并且插入里程碑后列表按计划日期升序且编号连续，以便时间轴不混乱。
4. 作为项目经理，我希望在 WBS 节点上直接看到已关联的工作日志数量、查看日志详情，并能从节点一键新建日志自动关联本任务，以便在任务上下文快速复盘与补记。
5. 作为项目成员，我希望新建 / 编辑日志时任务关联区有标题提示，以便明确该区域用途与勾选语义。
6. 作为项目经理，我希望编辑工作日志时只能改文本内容，任务关联与进度只读、风险责任人自动代入并只读展示，以便防止误改导致数据混乱。

## 3) 需求池（P0 / P1）

### P0（本轮必须交付）

| # | 需求 | 验收标准 |
|---|---|---|
| R3-1 | 里程碑「必备」标记 UI 全量下线（列表 / 编辑弹窗 / 删除确认 / 创建向导 / 概览页），引擎字段保留 | ① MilestonesPage 名称列不再出现「必备」Chip；② 编辑弹窗不再显示「模板必备」Chip；③ 删除确认不再按 required 分文案，所有碑统一为「关联 WBS 节点会解绑（不删除任务）」；④ 创建向导不再显示「必备」Chip / 「X 个必备」计数，删除按钮不再因 required 禁用；⑤ ProjectOverviewPage 不再显示「必备」Chip；⑥ 引擎 `ms.required` 仍随创建写入（血缘语义），列表接口字段不变 |
| R3-2 | 里程碑列表日期列改「计划日期（到期）」展示 currentDate，基线日期从列表列移除、降级为内部字段 | ① 列表仅一列日期：「计划日期（到期）」，展示 `currentDate`，点击改期交互与单向约束不变；② 「基线日期」列删除；③ 改期 / 编辑弹窗中基线日期以辅助说明出现，文案为「基线日期（创建时原始日期，仅作对比，不是到期日）」；④ 顶部 Alert 文案同步为「计划日期（到期）为当前生效计划，提前可直接改，延后须走变更单；基线日期仅用于审计对比」 |
| R3-3 | WBS 每个节点行（task 与 subtask）显示截止日期 | ① 所有节点行内新增「截止 YYYY-MM-DD」，无 dueDate 显示「截止 —」；② 表单已支持的 dueDate 编辑不受影响 |
| R3-4 | 修复插入里程碑排序（bug③）：插入 M2 不得排在 M5 后 | ① 在 M1 与 M3 之间插入计划日期的里程碑后，里程碑页列表必须按 currentDate 升序（M1 < M2 < M3 < …）；② 编号重排为连续 M1..Mn 且与升序一致；③ 离开再进入 / 刷新后顺序与编号不变（幂等）；④ WBS「关联里程碑」下拉与里程碑页顺序一致，新碑立即出现 |
| R3-5 | WBS 节点日志聚合：数量徽标 + 详情弹窗 + 新建入口 | ① 每个节点行显示「日志 n」徽标（n = 该节点被勾选关联的日志条数，n=0 也显示弱化样式）；② 点击徽标弹「工作日志详情」，按 createdAt 升序展示该节点全部关联日志（周次 / 状态 / 填报人 / 提交时间 / doneNote / planItems / risks（责任人姓名+截止）/ resourceNote，附该任务进度 before→after）；③ 行内「写日志」入口（report:write 权限且未归档可用）→ 跳转工作日志页自动打开新建弹窗并预勾选该任务；④ 计数与日志「关联任务数」口径一致（selected=true） |
| R3-6 | 新建 / 编辑日志任务关联区加标题 | 任务树容器上方固定标题「任务关联（勾选本日志涉及的任务，可同步更新进度）」；编辑已提交日志时该区只读并有说明 |
| R3-7 | 日志编辑仅允许文本修改，任务 / 进度 / 责任人只读 | ① 编辑态可修改：doneNote、planItems、resourceNote、risks 的 description（纯文本）；② 编辑态只读：任务关联树（勾选）、progressAfter、风险责任人、风险截止日、周次；③ 风险责任人自动代入为姓名（从 `report.risks[].owner` 解析成员姓名，解析不到显示 openId 原文）；④ 编辑提交时 payload.tasks 必须原样回传原始 report.tasks（selected / progressAfter 不变），否则引擎会重建并清空关联；⑤ 周次不随编辑变更 |

### P1（建议本轮一并做）

| # | 需求 | 验收标准 |
|---|---|---|
| R3-8 | 工作日志详情弹窗责任人显示姓名（当前直接显示 openId） | 详情与编辑态责任人统一展示为成员姓名；解析不到时显示 openId 原文 |
| R3-9 | 创建向导 / 里程碑页过时文案清理 | ① 向导 Alert 不再提「配套质量门」「必备锁删」；② 里程碑页顶部 Alert 文案按 R3-2 ④ 更新；③ 全局无「必备里程碑」残留文案 |
| R3-10 | 「计划日期（到期）」列对经变更单调整过的碑标记「已变更」 | currentDate ≠ baselineDate 时列内追加弱标记「已变更」+ tooltip「基线 原日期 → 计划 现日期（变更单 xxx）」；逾期标红逻辑保留 |
| R3-11 | MilestonesPage 死代码清理 | 移除 E_MS_REQUIRED_LOCKED、E_GATE_NOT_PASSED 的错误处理分支（引擎已不再抛出，属死分支） |

## 4) 六项决策结论（A~F）

### A. 必备标记去留 —— **仅 UI 去标识，引擎字段保留**（同意主理人建议）

已核实引擎引用情况：

- `createProject` 仍写 `required: md.required`（血缘语义），但**不再承担任何拦截逻辑**：
  - `deleteMilestone` 已不锁删必备（不再抛 `E_MS_REQUIRED_LOCKED`，注释明确「不再因必备锁删」）；
  - `updateMilestone` 不校验 required；
  - **WBS 骨架生成不依赖 required**（`createProject` 遍历全部 `createdMilestones` 生成骨架，非只遍历必备碑）。
- 结论：**保留字段、去 UI 是安全的**。UI 删除清单见 R3-1。`required` 留作模板血缘，供后续「模板预设」完善时使用，本轮不删类型与引擎字段。

### B. 基线日期列 —— **列头改「计划日期（到期）」，展示 currentDate；baselineDate 降级为内部字段**（同意主理人建议）

已核实现状：里程碑列表**同时存在**「基线日期」（baselineDate）与「当前计划」（currentDate）两列，歧义源头在此。

- 改法：删除「基线日期」列；保留日期列并重命名为「计划日期（到期）」，仍展示 `currentDate`，点击改期交互不变；「偏差」列保留（相对基线的延期 / 提前天数仍展示）。
- `baselineDate` 仅在改期弹窗 / 编辑弹窗中作辅助说明（文案见 R3-2 ③），不再作为列表列。
- **P1 拍板**：经变更单导致 currentDate 与 baselineDate 不一致时，在「计划日期（到期）」列追加弱标记「已变更」+ tooltip（R3-10）；逾期标红逻辑保留。理由是「已变更」提示让用户知道该日期不是最初承诺日，配合变更单号可审计。

### C. WBS 到期时间 + 插入排序 —— 展示 dueDate + 定义排序验收标准

- 展示：所有节点行内「截止 YYYY-MM-DD」，无则「截止 —」（R3-3）。
- 排序 bug③ 验收标准见 R3-4。
- **工程排查提示（已核实）**：页面层（`.tsx`）**没有任何 sortMilestones / compareMilestones 调用**，所有列表顺序依赖 `projectStore.milestones`（来自 `listMilestones` 引擎排序）。关键嫌疑点：**WbsPage 的 useEffect 只 fetchWbs、从不刷新里程碑**——用户若直接进入 WBS 页、或创建里程碑后回到 WBS 页，下拉用的是陈旧 store 数据（新碑缺失或顺序过期）。要求：WbsPage 挂载时同步 `refreshMilestones`，或在消费处统一 `sortMilestones(milestones)` 兜底；并全局排查禁止按 code 排序的列表。

### D. WBS 日志聚合 —— 徽标 + 就近详情弹窗 + 跳转式新建入口（拍板入口形态）

- 入口形态（拍板）：**不把完整日志表单复制到 WBS 页**（避免双份表单维护），「写日志」采用**跳转工作日志页并自动打开新建弹窗、预勾选该任务**的方式（路由 query / 临时 store 传 nodeId）。理由：复用 ReportsPage 既有完整表单与校验，改动最小、口径一致。
- 详情：就近弹窗展示，按 createdAt 升序列出该节点全部关联日志的完整文本内容（R3-5 ②）。
- 计数口径：与日志「关联任务数」一致（tasks 中含该 nodeId 且 selected=true），避免数字对不上。

### E. 新建日志任务关联区 title —— 文案如下（拍板）

- 标题：**「任务关联（勾选本日志涉及的任务，可同步更新进度）」**
- 编辑态追加说明：**「编辑已提交日志时该区域只读」**
- 实现：任务树容器上方固定 subtitle（不与「本周完成」标题共用），编辑态禁用勾选与进度输入（配合 F）。

### F. 日志编辑限制 —— 只读责任人代入来源 + 仅文本可改（拍板）

- **责任人代入来源（拍板）**：`report.risks[].owner`（**用户 openId**，新建时从项目成员下拉选择的责任人）。**不是** ownerRole（报告模型只有 `owner=openId`，无 ownerRole 字段；ownerRole 仅存在于质量门），**也不是**当前用户角色（责任人应保持当初填写的人，而非编辑者）。
- 展示方式：从项目成员（members）解析 openId → userName 展示为只读姓名（Chip / 纯文本）；解析不到显示 openId 原文，不阻塞。
- 编辑边界：允许改 doneNote / planItems / resourceNote / risks 的 description（文本）；**禁止**改任务关联树、进度、风险责任人、风险截止日、周次（R3-7）。
- **工程约束**：`updateReport` 引擎用 `payload.tasks` 整体重建 `report.tasks`，编辑提交必须把**原始 report.tasks 原样回传**（selected / progressAfter 不变），否则关联会被清空；`updateReport` 不更新 week，周次天然保持。

## 5) 待确认问题

无（本轮 6 项反馈均已落到需求池与边界决策；如后续模板预设功能立项，再单独评审 required 的去留与展示）。
