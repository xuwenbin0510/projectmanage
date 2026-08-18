# 审批上线（评审全流程 + 项目状态机流转）+ 工作台接真数据（B10）· 增量 PRD

> **文档性质**：增量变更定义（相对 B9 已交付「工时统计报表」后的**新功能**），非全盘重设计。
> **基线**：B9 已交付——工时报表上线、414+ 断言全绿。**前端审批页 / 工作台页 / 评审页已写好**（契约已定，后端补齐后大概率零改动）；`web/src/api/mock/index.ts` 为完整契约参考；后端 `reviews` 7 接口 + `transition` + `close-check` 全桩；`workbench` 真实路由但审批/周报部分为降级常量。
> **已确认需求（用户拍板「审批 + 工作台一起做」）**：① 审批功能上线（评审 reviews 全流程 + 项目状态机流转 transition）；② 工作台接真实数据。
> **落地方式**：本 PRD 作为 PM→架构→工程师→QA 的标准输入。**纯文档产出，不写代码、不碰数据库。**
> **默认主题**：浅色；品牌青交互色 `#2E7D87`、装饰色 `#6DA8AE`（同 B7/B8/B9）。

---

## 0. 产品目标（一句）

把「评审与立项审批」从**纯前端演示（Mock）**升级为**真实后端闭环**：任何人发起评审即按模板生成审批链、逐级审批留痕、终态联动项目状态，同时让「我的工作台」把「待我审批 / 待填周报 / 我的任务 / 我的项目」全部换成真数据，一屏看清该做什么。

## 1. 用户故事

| # | 用户故事 |
|---|---------|
| US1 | 作为项目经理 / TL，我想在项目内「评审审批」页发起评审（选类型 + 填标题），系统按模板自动生成审批链（逐级串行或并行一票否决），以便把立项 / 设计 / 验收等评审流程固化下来。 |
| US2 | 作为审批人（PMO / 管理层 / TL / PO / 客户代表），我想在「审批中心」看到所有待我审批的评审，一键通过 / 驳回（驳回必填意见），每一步都留痕，以便快速处理又不失责。 |
| US3 | 作为评审发起人，我想在评审仍「审批中」时撤回误发的评审，以便纠正错误发起。 |
| US4 | 作为 PM / 管理员，我想按状态机流转项目（草稿→审批中→已批准→进行中→挂起→已结项/已终止），且结项前系统提示未过门 / 未达成碑 / 未闭环评审，以便保证结项前质量门与里程碑闭环。 |
| US5 | 作为普通成员，我想在工作台一眼看到「待我审批 N 项 / 逾期任务 N 个 / 本周待填周报 N 份」及对应的列表与提醒，点击直达处理，以便不漏事、不误期。 |
| US6 | 作为后端使用方，我希望评审与工作台数据由服务端真实聚合返回（不依赖 Mock 内存库），结构字段齐全、口径一致，前端零改动切换。 |

## 2. 需求池（P0 / P1）与落点

| ID | 需求 | 优先级 | 主要落点 |
|----|------|--------|---------|
| B10-R1 | **评审上线（reviews 全系真实接口）**：`listReviews` / `listMyApprovals` / `getReview` / `createReview` / `approveReview` / `rejectReview` / `withdrawReview` 7 接口真实实现（替换 `stubs.routes.js` 桩） | P0 | 新建 `server/services/review.service.js` + `server/routes/reviews.routes.js`；`server/dal/migrations.js` v6 建表 |
| B10-R1.1 | **发起评审按模板生成审批链**：`createReview` 按评审类型取链（`project` 类型按项目类别 A/B/C 取 legacy `APPROVAL_TEMPLATES`，其余按 `REVIEW_TEMPLATES`，见 Q1），角色→用户绑定（assignees 覆盖 > 项目成员角色 > 全局角色 > 兜底）；mode=parallel_veto 时全部步骤 current | P0 | `review.service.js#createReview` + `#buildSteps`（对齐 Mock L1982-2034 / buildSteps L416-452） |
| B10-R1.2 | **逐级推进与终态**：serial 模式通过后推进 currentStep、末步通过→`已通过`；parallel_veto 全票通过→`已通过`；任一驳回→`已驳回`（其余 pending/current 置 skipped）；通过后按 refType 联动（project→已批准、gate→过门+里程碑达成、change→变更批准，本期 change 表未建可留空，见 Q5） | P0 | `review.service.js#decide`（对齐 Mock L2077-2148）+ `onReviewApproved`（L466-494） |
| B10-R1.3 | **留痕**：每次 submit/approve/reject/withdraw 写一条审批记录（`review_approvals` 表）+ 审计日志（entity_type=`review`，含 status diff） | P0 | `review_approvals` 表 + `lib/audit.writeAudit` |
| B10-R1.4 | **状态机与 RBAC 校验**：仅 `审批中` 可批/驳/撤（否则 `E_REVIEW_CLOSED`）；当前步骤轮到该角色成员（或 admin 兜底）才可批/驳（否则 `E_NOT_APPROVER`）；仅发起人（或 admin）可撤回（否则 `E_FORBIDDEN`）；`customer_rep` 步骤必须填意见或凭证（`E_PROXY_EVIDENCE_REQUIRED`）；发起评审要求项目可写（归档态 `E_PROJECT_ARCHIVED`）+ `review:start` 权限 | P0 | `review.service.js` 校验层（错误码已存在于 `server/lib/errors.js`） |
| B10-R2 | **项目状态机流转 transition 真实化**：`POST /projects/:id/transition` 替换桩——按 `PROJECT_TRANSITIONS` 校验（非法流转 `E_VALIDATION`）、归档态（已结项/已终止）无出边天然拦截、`→已结项` 前执行结项前置检查（有阻塞项 `E_CLOSE_BLOCKED` + blockers 数据）、写项目状态变更审计 | P0 | 新建 `server/services/project-flow.service.js`（或并入 `project.service.js`）+ `server/routes/projects.routes.js` 或独立路由；对齐 Mock L887-917 |
| B10-R2.1 | **结项前置检查真实化**：`GET /projects/:projectId/close-check` 替换桩，返回 `CloseBlocker[]`（未过门 / 未达成碑 / 审批中评审；变更阻塞本期视 changes 表是否建而定，见 Q5），对齐 Mock rules.ts `closeBlockers` L218-250 | P0 | 读 `quality_gates` + `milestones`（派生 done）+ `reviews`（B10-R1 建表后）+ `changes`（可选） |
| B10-R3 | **工作台接真数据**：`GET /api/workbench` 补齐 `stats.pendingApprovals` / `stats.missingReports` / `myApprovals` / `reportReminders`（`myProjects` / `myTasks` / `overdueTasks` 已是真实） | P0 | `server/routes/workbench.routes.js` + `server/services/workbench.service.js`（新增评审 / 周报聚合） |
| B10-R3.1 | **待我审批**：`pendingApprovals` = 我可决策评审数；`myApprovals` = 我可决策评审**完整对象列表**（含 steps，供 `ReviewStepper` 渲染），与 `review.service.canDecide(me)` 同一口径 | P0 | `workbench.service.js` 复用评审可决策判定 |
| B10-R3.2 | **周报提醒**：`reportReminders` = 我参与且 `status='进行中'` 的项目，本周（`weekCode(today)`）是否有 `work_reports.status='已提交'` 记录 → `filled`；`missingReports` = 其中未填数量（口径见 Q2） | P0 | `workbench.service.js` 查 `work_reports`（周报真实表 B4/B5 已就绪）+ 需在 `server/lib/dates.js` 补 `weekCode`（对齐前端 `web/src/utils/date.ts#weekCode`） |
| B10-R4 | **变更单审批 / 评审类型扩展 / 导出**：变更审批依赖 `changes` 表与服务（当前全桩）；评审类型后续可扩展（如安全评审）；评审列表导出 | P1（默认**本期不做或最小化**） | 仅标注，不做落点 |

**权限口径（沿用现有 `server/config/permissions.js`）**：发起评审 `review:start`（全局 admin/pmo；项目内 pm/tl）；审批决策 `review:decide`（全局 admin/pmo/management/tl；项目内 pm/tl/po/pmo）；客户代表代录 `review:proxy`（全局 admin；项目内 pm）；项目流转 `project:transition`（全局 admin/pmo；项目内 pm）；结项 `project:close`（全局 admin/pmo；项目内 pm）。

## 3. 关键交互说明

### 3.1 审批中心（ApprovalsPage）三按钮的权限 / 状态矩阵

前端已定：行内按钮按「`actionable`（在待我审批列表）→ 显示 通过 / 驳回；非 actionable 且 `审批中` → 显示 撤回」渲染；**服务端是安全边界，必须按矩阵拦截**（前端仅控制显隐）。

| 场景 | 通过（approve） | 驳回（reject） | 撤回（withdraw） |
|------|----------------|----------------|------------------|
| 评审状态 = `审批中`，当前步骤轮到我的角色（serial 当前步 / parallel 我的票未投） | ✅ 可操作；serial 通过→推进或终审；parallel 通过→记一票 | ✅ 可操作；驳回→整单 `已驳回`，其余步骤置 skipped | —（发起人才可撤，见下行） |
| 评审状态 = `审批中`，我是发起人且当前步骤**不**轮到我 | —（按钮不显示） | —（按钮不显示） | ✅ 可操作；→ `已撤回`（若当前步骤恰轮到自己，优先按审批人处理） |
| 评审状态 = `审批中`，既非当前步骤审批人、也非发起人（含 admin 兜底外） | ❌ 服务端拒绝 `E_NOT_APPROVER` | ❌ 服务端拒绝 `E_NOT_APPROVER` | ❌ 服务端拒绝 `E_FORBIDDEN`（仅发起人可撤） |
| 评审状态 = `已通过 / 已驳回 / 已撤回` | ❌ `E_REVIEW_CLOSED`（409） | ❌ `E_REVIEW_CLOSED`（409） | ❌ `E_REVIEW_CLOSED`（409） |
| 当前步骤角色 = `customer_rep` | 必须填意见或凭证链接，否则 `E_PROXY_EVIDENCE_REQUIRED`（400） | 同上（且驳回本就必填意见） | — |
| 项目为归档态（已结项/已终止） | 评审终态不受影响（按评审状态校验）；**发起新评审**被 `E_PROJECT_ARCHIVED` 拦截 | 同左 | 同左 |

> 备注：前端「撤回」按钮对非发起人也会渲染（`!actionable && 审批中`），属已知 UI 行为，服务端必须按「仅发起人/admin」拦截（对齐 Mock L2053）；admin 兜底策略见 Q1。
> 待办 Tab 数量 = `listMyApprovals()` 返回条数；「其他进行中」Tab = `listReviews()` 中 `initiator=我 && 不在待办 && status≠已撤回`（前端本地过滤，后端无需特判）。

### 3.2 发起评审（ReviewsPage）

- 入口：项目详情「评审审批」Tab，`review:start` 权限按钮 + 归档态禁用；表单字段 = 评审类型（formal/technical/code/ccb/project）+ 标题（必填），`refType='project'`、`refId=projectId`（前端已固定）。
- `createReview` 返回 `Review`（含生成好的 `steps[]` 与首条 `submit` 审批记录），前端立即刷新列表并用 `ReviewStepper` 展示审批链。
- 审批链展示：`ReviewStepper` 读 `review.steps[]`（role/assigneeName/status/decidedAt/comment），后端出参必须字段齐全（含 `assigneeOpenId` / `assigneeName` / `decidedByName` / `decidedAt` / `comment`），否则前端步骤状态/名字渲染为空。

### 3.3 工作台（WorkbenchPage）卡片与列表

| 区块 | 数据源（前端已写死） | 后端必须保证 |
|------|---------------------|-------------|
| 顶部 3 张 StatCard | `stats.pendingApprovals` / `stats.overdueTasks` / `stats.missingReports` | **必须返回数字**，缺字段会渲染 NaN（工作台路由注释已警示）；`overdueTasks` 已真实，本期补齐另两项 |
| 待我审批卡片（≤5 条） | `myApprovals`（Review[] 完整对象，用 `ReviewStepper`） | 与「待我审批」同一口径；字段齐全（title/projectName/initiatorName/status/steps） |
| 周报提醒（每项目一条） | `reportReminders[]`（projectId/projectName/week/weekStart/weekEnd/filled） | `week` = 本周编码（如 `2026-W33`），`weekStart/weekEnd` = 该周周一~周日，`filled` = 本周已提交；前端按 `projectId` 去重渲染，**每项目一行** |
| 我的任务 / 我的项目 | `myTasks` / `myProjects` | 已真实（B3/B4），本期不动 |

- 交互：待我审批卡片点击→审批中心；周报「去填写」→项目工作日志页；任务状态下拉→`moveTask`（沿用 WIP 拦截）；项目卡片点击→项目概览。后端无需新增 UI 逻辑，仅保证数据正确。

## 4. 验收要点

| ID | 验收要点 |
|----|---------|
| B10-R1 | ① `GET /api/reviews`（可选 projectId）返回全部评审（倒序）；② `GET /api/reviews/my-approvals` 只返回我当前可决策的评审；③ `GET /api/reviews/:id` 返回完整 Review（含 steps/approvals）；④ 前端 ApprovalsPage / ReviewsPage 切真实后端**零改动可用**（对照 Mock 契约逐字段）。 |
| B10-R1.1 | ① 发起评审返回 Review，steps 按模板 chain 生成且角色→用户绑定正确（项目成员优先、全局角色次之、兜底兜住）；② `project` 类型按项目类别取链（若按 Q1 推荐）；③ parallel_veto 全部步骤 current、serial 仅第 0 步 current；④ 首条审批记录 action=`submit`、stepIndex=-1。 |
| B10-R1.2 | ① serial：每一步通过后 currentStep+1、下一人变 current；末步通过→`已通过`+closedAt；② parallel_veto：单票通过不结束，全票通过→`已通过`；③ 任一驳回→`已驳回`，其余未决步骤置 skipped；④ `refType='project'` 终审通过→项目 `审批中`→`已批准` + 项目审计；`refType='gate'` 通过→门 `已通过` + 挂载里程碑达成（若有）。 |
| B10-R1.3 | ① 每次决策在 `review_approvals` 落一条（action/actor/stepRole/comment/evidenceUrl/createdAt）；② 审计日志 entity_type=`review` 含 create/approve/reject/withdraw/update 事件，状态变更带 diff。 |
| B10-R1.4 | ① 非当前步骤审批人批/驳 → 403 `E_NOT_APPROVER`；② 非发起人撤 → 403 `E_FORBIDDEN`；③ 已终态评审再操作 → 409 `E_REVIEW_CLOSED`；④ customer_rep 步缺意见且缺凭证 → 400 `E_PROXY_EVIDENCE_REQUIRED`；⑤ 归档项目发起评审 → 403 `E_PROJECT_ARCHIVED`；⑥ 无 `review:start` 权限发起 → 403。 |
| B10-R2 | ① 非法流转（如 草稿→进行中）→ 400 提示「不允许从 X 流转到 Y」；② 归档态（已结项/已终止）无出边，任何 transition 被拒；③ 进行中→已结项 有未过门/未达成碑/审批中评审 → 409 `E_CLOSE_BLOCKED` 且 data.blockers 为 `CloseBlocker[]`；④ 流转成功写项目状态变更审计（含 before/after）。 |
| B10-R2.1 | ① `GET /projects/:id/close-check` 返回阻塞项列表：未过门（`kind:'gate'`）/未达成碑（`kind:'milestone'`）/审批中评审（`kind:'review'`）；② 无阻塞返回 `[]`；③ 与 `transition→已结项` 同一口径（同一函数）。 |
| B10-R3 | ① `stats.pendingApprovals` = 我可决策评审数（与 myApprovals.length 一致）；② `myApprovals` 返回完整 Review 对象，工作台 `ReviewStepper` 正常渲染；③ `stats.missingReports` = 未填周报项目数；④ 返回结构字段齐全（stats 三数字 + 四数组），前端无 NaN。 |
| B10-R3.2 | ① `reportReminders` 每「我参与且进行中」项目一行，`week` 为本周编码、`weekStart/weekEnd` 为周一~周日；② 本周存在 `status='已提交'` 的 work_reports → `filled=true`（草稿不计）；③ 周报已提交后刷新工作台，该项变 `filled`、`missingReports` 减一。 |
| B10-R4 | （本期不做）无变更审批 / 新评审类型 / 导出入口；PRD 标注 P1。 |

## 5. 待确认问题（≤5，均给推荐）

| ID | 问题 | 推荐答案 | 影响 |
|----|------|----------|------|
| Q1 | **审批链模板来源与角色绑定方式**：评审链用哪套模板？`project`（立项审批）类型是否按项目类别 A/B/C 取 legacy `APPROVAL_TEMPLATES`（A:[pmo,tl,management] / B:[pm,tl] / C:[pmo,tl,management]），还是统一用 `REVIEW_TEMPLATES.project`（[pmo,management]）？`customer_rep` 虚拟角色怎么绑人？admin 是否兜底可批任意步骤？ | **推荐**：`reviewType==='project'` 时用 `APPROVAL_TEMPLATES[project.type]`（沿用 legacy 真实审批制度，A/C 三级、B 两级），其余类型用 `REVIEW_TEMPLATES`（/api/meta 已下发，前端零改动）；`customer_rep` 本期无客户联系人字段 → 沿用 Mock 兜底（ROLE_FALLBACK_ORDER 首位）且**发起评审支持 `assignees` 覆盖**（契约已支持，前端 ReviewsPage 暂未传，P1 补 UI）；**admin 兜底可批/驳任意当前步骤**（对齐 legacy `canApproveStep` 与权限矩阵，需在 `canDecide` 加 admin 分支——注意与 Mock 的差异，见下）。 | 决定审批链形态与可决策集合；admin 兜底会使 admin 的「待我审批」含全部审批中评审，属预期 |
| Q2 | **missingReports / reportReminders 统计口径**：是「我参与且进行中的项目」（Mock 口径），还是「我负责任务所在的项目」？`filled` 按项目级（任何一人提交即算）还是个人级？ | **推荐**：与 Mock 完全一致——`reportReminders` = 我参与（project_members 含我）且 `status='进行中'` 的项目，每项目一行，`filled` = 该项目本周存在 `status='已提交'` 的周报（项目级、任一成员提交即算）；`missingReports` = 未填行数。理由：与 Mock/前端零漂移、语义简单可预期（周报本就是项目级协同产物）；「我负责任务所在项目」作为 P1 细化项，避免纯挂名成员也被提醒的问题后续再评估。 | 决定工作台周报区数据形态 |
| Q3 | **transition 状态机完整状态列表与「审批中→已批准/已驳回」双通道**：`PROJECT_TRANSITIONS`（8 状态、边已在 enums 定义）是否即为完整状态机？`审批中→已批准/已驳回` 既可走 `project` 评审通过联动、又可走 transition 直转，如何防双写冲突？ | **推荐**：完整状态机 = `PROJECT_TRANSITIONS`（已定义，不做增减）；transition 支持全部合法边；**特例**：`审批中→已批准/已驳回` 若该项目存在「审批中」的 `project` 类型评审 → 拒绝直转（`E_VALIDATION`「存在审批中的立项评审，请走评审流程」），由评审终审联动流转；无该评审（如 legacy 老数据）→ 允许 admin/pmo 直转兜底。归档态无出边即天然拦截。 | 决定状态迁移路径与评审/流转的关系 |
| Q4 | **legacy 老审批流与新 reviews 并存还是停用**：`legacy.routes.js` 的 `GET /projects/:id/approval` / submit / approve / reject 是否继续保留？ | **推荐**：**停用新入口、保留老路由待批次清理**——老路由是 `@deprecated` 且 `devcheck.js` / `test_runner.js` 仍在打，直接删会让自检全红；本期**不在新前端暴露老入口**（前端已切新契约），老路由保持原样兜住自检，随 D-9 批次计划一并删除；新增逻辑全部落在 reviews / transition。 | 决定老审批流去留与回归策略 |
| Q5 | **close-check 的变更阻塞**：`changes` 表与服务尚未建（全桩），结项检查里的 `kind:'change'` 阻塞怎么处理？ | **推荐**：本期**跳过 change 阻塞**（查不到 changes 表则忽略，返回空），`CloseBlocker` 的 change 类型留待变更单功能（B10-R4/P1）落地后补；`kind:'review'` 依赖 B10-R1 建 reviews 表后即生效。若架构师认为成本可接受，也可在 v6 迁移一并建空 `changes` 表（仅 DDL，不实现服务），close-check 直接查表（返回空），后续变更单直接复用——**推荐后者**（一次建表，避免二次迁移）。 | 决定结项检查覆盖范围与迁移规模 |

## 6. 一句话总结

> B10（已确认「审批 + 工作台一起做」）：后端真实实现评审 7 接口（发起按模板生成审批链 → 逐级推进 → 终态联动项目/门/变更，全流程留痕 + RBAC/状态机校验）与项目状态机流转 transition（含归档态拦截、结项前置检查真实化），并把工作台 `pendingApprovals` / `myApprovals` / `missingReports` / `reportReminders` 全部接真数据（周报基于 work_reports 真实表）；前端 ApprovalsPage / ReviewsPage / WorkbenchPage 已就绪、零改动。变更单审批 / 评审类型扩展 / 导出为 P1 默认不做。4 类待确认项（模板与角色绑定、周报口径、transition 双通道、legacy 去留）均有明确推荐，无阻塞级歧义。

**IS_READY: YES**（用户已确认「审批 + 工作台一起做」；5 项待确认均有明确推荐，无阻塞级歧义）。
