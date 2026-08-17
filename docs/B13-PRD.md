# B13 逾期/临期任务下探抽屉 — 简单 PRD

> 文档类型：**简单 PRD（默认模板，不含竞品分析）**
> 作者：产品（许清楚）｜主理人：齐活林
> 项目盘址：`C:/Users/xuwen/WorkBuddy/AstrBytes/pm-app/`
> 技术栈：Vite + React + TS + MUI + Tailwind；图表 `@mui/x-charts` v7；后端 Node(Express) + better-sqlite3（真实 DB）
> 前置：B10（审批+工作台接真数据）、B11（工作台仪表盘增强）、B12（全局仪表盘）已交付
> 生成日期：2026-08-17

---

## 0. 现状盘点（先读代码再动笔的结论）

### 0.1 现有前端资产 / 组件（必须复用，禁止新造）

| 资产 | 位置 | B13 复用方式 |
|---|---|---|
| `OwnerLoadDrawer` 抽屉 | `web/src/components/dashboard/OwnerLoadDrawer.tsx` | **直接复用骨架与样式**：`<Drawer anchor="right">`、宽 420px、头部标题+关闭按钮、内部 `DataTable`。本需求的新抽屉 `OverdueTaskDrawer` 照此骨架实现 |
| `OverdueBarChart` 逾期柱状 | `web/src/components/dashboard/OverdueBarChart.tsx` | **补点击回调即可**：当前 `props` 无 `onDrill`，`rows: OverdueByProject[]`（已含 `projectId`）；参考 `HealthDistBar` 的 `onDrill` 模式加 `onDrill?: (projectId: string) => void` |
| `HealthDistBar` 健康分布 | 同上目录 | **参考其 `onDrill` 用法**：MetricsPage L385 `onDrill={(h)=>setQuery(...)}`、WorkbenchPage L142 `onDrill={()=>navigate(ROUTES.projects)}` 已是现成范例 |
| `DataTable` 表格 | `web/src/components/common/DataTable.tsx` | 抽屉内任务清单直接复用（支持 `columns` / `rowKey` / `loading` / `empty*` / `dense` / `onRowClick`） |
| `StatusChip` / `ProgressBar` / `HealthDot` | `web/src/components/common/` | 任务行的状态、进度渲染复用 |
| `api.listWbs(projectId)` | `web/src/api/client.ts`（经 `wbsStore.ts` L53 调用） | 任务明细数据源：`GET /api/projects/:projectId/wbs` 的前端封装，返回扁平 `WbsNode[]` |
| `useProjectStore.refreshMilestones(projectId)` | `web/src/stores/projectStore.ts` | 里程碑名映射数据源：`GET /api/projects/:projectId/milestones` 的前端封装 |
| 日期口径 | `web/src/utils/date.ts` | 逾期 = `diffDays(today(), dueDate) < 0`；临期 = `0 <= diffDays(...) <= 3`（`DUE_SOON_DAYS=3`），与 `dashboardAgg.ts` / 后端逐字一致，**唯一真相来源** |

### 0.2 后端现有接口（复用，无需新增）

| 能力 | 位置 | 说明 |
|---|---|---|
| `GET /api/projects/:projectId/wbs` | `server/routes/wbs.routes.js` L33 | 返回该项目**全部**扁平 WBS 节点（`WbsNode[]`），含 `wbsCode/name/owner/ownerName/dueDate/status/progress/milestoneId` 等全部所需字段。**本需求任务明细的唯一数据源** |
| `GET /api/projects/:projectId/milestones` | `server/routes/projects.routes.js`（写在读接口，不搬家） | 返回里程碑列表，用于把 `WbsNode.milestoneId` 解析成里程碑名 |
| `GET /api/dashboard/overview`（B12） | `server/routes/dashboard.routes.js` L27 | 返回 `overdue: OverdueByProject[]`，每项含 `projectId / projectName / overdue / dueSoon`，是抽屉打开时的入参与头部计数来源 |
| `GET /api/workbench`（B11） | `server/routes/workbench.routes.js` L31 | 前端 `buildDashboard` 聚合出 `overdue`（工作台视角），同样提供 `projectId` 与计数 |

### 0.3 三个关键事实（决定 B13 判定的依据）

1. **不需要新后端接口**：任务明细可由 `GET /api/projects/:projectId/wbs` 直接取（前端已有 `api.listWbs` 封装），里程碑名由 `GET /api/projects/:projectId/milestones` 取；来源报表（B11/B12）已给 `projectId` 与计数，无需服务端再聚合。前端按 `dueDate` 口径过滤出逾期/临期即可，聚合成本为零。
2. **`WbsNode` 只有 `milestoneId`、没有 `milestoneName`**：抽屉"所属里程碑"列需把 id 解析成名称（复用 0.2 的里程碑接口）。这是本需求唯一一处"名称解析"工作，纯前端可完成。
3. **`OverdueBarChart` 两处调用目前均无 `onDrill`**：WorkbenchPage.tsx L138、MetricsPage.tsx L387。两页均已渲染 Drawer（MetricsPage L414 已有 `OwnerLoadDrawer`），可并列新增 `<OverdueTaskDrawer>`。

---

## 1. 产品目标

让 PMO / 项目经理从「项目级逾期数字」一步下探到「具体是哪些任务、谁负责、卡在哪个里程碑」，把仪表盘从"看数"升级为"可行动（actionable）的起点"——减少在多个页面间来回跳转定位问题任务的摩擦；交付上保持**零后端新增接口**的轻量增量，并严格沿用 B11/B12 已验收的组件、日期口径与配色规范。

---

## 2. 用户故事

- **US-1｜全局下探**：作为 PMO，我希望点击全局仪表盘里某个项目的逾期/临期数字，右侧滑出抽屉看到该项目所有逾期/临期任务清单（含负责人与里程碑），以便快速定位风险源头并指派跟进，而不必先跳进项目页。
- **US-2｜工作台顺手跟进**：作为项目经理，我希望在工作台点击我项目下的逾期项目条，右侧滑出抽屉看明细、且**不离开当前工作台视图**，以便在处置其它事务时顺手跟进。
- **US-3｜先救最急的**：作为项目成员，我希望在抽屉里用「逾期 / 临期」Tab 切换、默认聚焦「逾期」，以便优先处理已超期任务。

---

## 3. 需求池

### P0（必做）

| 编号 | 需求 | 一句话说明 |
|---|---|---|
| P0-1 | 新增 `OverdueTaskDrawer` 抽屉组件（MUI `Drawer anchor="right"`，宽 420px） | 复用 `OwnerLoadDrawer` 骨架/样式/关闭交互，右侧滑出展示单项目逾期/临期任务 |
| P0-2 | 为 `OverdueBarChart` 增加 `onDrill?: (projectId: string) => void` | 参考 `HealthDistBar` 的 `onDrill` 模式，在 BarChart 上绑定点击取 `projectId`，让项目条可下探 |
| P0-3 | MetricsPage（B12 overdue 报表）接入 `onDrill` 打开抽屉 | 全局仪表盘项目行点击 → 右侧滑出 `OverdueTaskDrawer` |
| P0-4 | WorkbenchPage（B11 OverdueBarChart）接入 `onDrill` 打开同一抽屉 | 工作台项目条点击 → 右侧滑出同一抽屉 |
| P0-5 | 抽屉内「逾期 / 临期」Tab 切换筛选，默认「逾期」 | 切换仅改变下方清单数据集，不发新请求 |
| P0-6 | 抽屉数据复用 `GET /api/projects/:projectId/wbs`（前端 `api.listWbs`） | 前端按口径过滤（`status !== '完成'` 且 逾期/临期），不下发新接口 |

### P1（重要）

| 编号 | 需求 | 一句话说明 |
|---|---|---|
| P1-1 | 里程碑名解析 | 抽屉"所属里程碑"列用 `milestoneId` 经 `GET /api/projects/:projectId/milestones` 映射为名称；未挂碑显示「未关联」 |
| P1-2 | 抽屉头部上下文 | 头部展示项目名 + 副标题"逾期 X · 临期 Y"，计数来自来源报表或抽屉本地重算 |
| P1-3 | 六字段齐全渲染 | 任务名(WBS code+name)、负责人(ownerName)、计划完成日(dueDate)、状态(StatusChip)、进度(ProgressBar)、所属里程碑(milestoneName) |
| P1-4 | 加载/空态 | 抽屉打开显示 loading；某 Tab 无数据走 `DataTable` 空态（如"该项目暂无已逾期任务"） |
| P1-5 | 数据口径唯一真相 | 过滤用 `@/utils/date` 的 `diffDays`/`today`（与 `dashboardAgg.ts`、后端逐字一致），禁止手写日期比较；过滤掉 `status === '完成'` |

### P2（可选）

| 编号 | 需求 | 一句话说明 |
|---|---|---|
| P2-1 | 任务行点击跳 WBS 页 | 行点击跳 `ROUTES.projectWbs(projectId)` 并锚定该任务（参考 `OwnerLoadDrawer` 行点击跳项目概览） |
| P2-2 | 虚拟滚动/分页 | 抽屉清单超阈值（如 50 条）时启用虚拟滚动，保护大项目性能 |
| P2-3 | 抽屉内二次筛选 | 支持按负责人/里程碑细筛（复用 `BoardFilter` 思路，纯前端） |
| P2-4 | 口径对齐开关 | 工作台下探时提供"仅看我负责"开关，与来源报表（myTasks）口径对齐 |

---

## 4. UI 设计稿

### 4.1 抽屉布局（文字描述）

- **容器**：MUI `<Drawer anchor="right" open onClose>`，宽 420px（`maxWidth: '92vw'`），与 `OwnerLoadDrawer` 一致；点击遮罩 / 关闭按钮 / ESC 关闭，回到原报表视图（不打断、不跳路由）。
- **顶部（Header）**：左侧项目名（`subtitle1` 加粗，`noWrap`）+ 副标题"逾期 X · 临期 Y"；右侧 `IconButton` 关闭（CloseIcon）。
- **中部（Filter Tabs）**：MUI `<Tabs>` 两选项「逾期」「临期」，默认「逾期」；切换仅过滤下方清单，不发请求。
- **下部（Task List）**：复用 `DataTable`（dense），每行一条任务，按 §4.2 字段渲染；逾期行 `dueDate` 用 `error.main` 着色、临期用 `warning` 着色（沿用 `isOverdue`/`diffDays` 既有表现）。
- **行点击（P2-1）**：可跳该项目 WBS 页并锚定任务。

### 4.2 字段表

| 字段名 | 来源（接口 / 字段） | 说明 |
|---|---|---|
| 任务名 | `WbsNode.wbsCode` + `WbsNode.name` | 拼接展示，如「1.2.3 星载天线集成」 |
| 负责人 | `WbsNode.ownerName`（`owner` 为 openId） | 展示姓名；未分配显示「未分配」 |
| 计划完成日 | `WbsNode.dueDate` | `YYYY-MM-DD`，`fmtDate` 格式化；逾期红 / 临期黄 |
| 状态 | `WbsNode.status` | `StatusChip` 渲染（待办/进行中/阻塞/待评审/完成） |
| 进度 | `WbsNode.progress` | 0~100，`ProgressBar` 渲染 |
| 所属里程碑 | `WbsNode.milestoneId` → 里程碑名 | 经 `GET /api/projects/:projectId/milestones` 映射；未挂碑显示「未关联」 |

---

## 5. 关键技术约束（务必遵循，避免返工）

- **数据口径（唯一真相）**：逾期 = `diffDays(today, due_date) < 0`；临期 = `0 <= diffDays(today, due_date) <= 3`。`today` 由 `@/utils/date#today()` 提供（全局统一，禁止在抽屉里 `new Date()` / 手写字符串比较）。前端口径须与 B12 后端一致：过滤 `status === '完成'`（只计在办）。
- **后端接口判断：不需要新增后端接口**。理由：① 任务明细复用 `GET /api/projects/:projectId/wbs`（`wbs.routes.js` L33，前端 `api.listWbs` 已封装）；② 里程碑名复用 `GET /api/projects/:projectId/milestones`（`projects.routes.js`，前端 `useProjectStore.refreshMilestones`）；③ 来源报表（B11 workbench / B12 overview）已提供 `projectId` 与 `overdue/dueSoon` 计数，无需服务端再聚合。前端按 `dueDate` 过滤即可，聚合成本为零。
- **前端参考**：复用 `OwnerLoadDrawer.tsx` 的 Drawer 骨架/样式/关闭交互；`OverdueBarChart` 补点击回调参考 `HealthDistBar` 的 `onDrill` 模式（MetricsPage L385、WorkbenchPage L142 已有用法）。
- **不新增 mock**：`web/.env.*` 均为 `VITE_USE_MOCK=false`，抽屉数据一律走真实接口。
- **技术栈**：延续 Vite + React + MUI + Tailwind；不换框架、不引入新重型依赖（抽屉用现有 MUI `Drawer` + `DataTable` 即可）。
- **集成点**：WorkbenchPage.tsx L138、MetricsPage.tsx L387 的 `<OverdueBarChart>` 当前均无 `onDrill`，需补；两页均已有 Drawer 渲染位（MetricsPage L414 已有 `OwnerLoadDrawer`），可并列新增 `<OverdueTaskDrawer>`。

---

## 6. 待确认问题清单

1. **下探口径一致性**：WorkbenchPage 的逾期计数来自 `myTasks`（仅"我"的任务），而 `GET /api/projects/:projectId/wbs` 返回该项目**全部**任务（含他人）。抽屉应展示"项目全量逾期/临期任务"还是"仅我所负责/参与的"？建议默认**项目全量**（更利于 PM 介入），待确认。
2. **里程碑名解析方式**：`WbsNode` 仅含 `milestoneId`。确认复用 `GET /api/projects/:projectId/milestones` 建 id→name 映射（纯前端、零后端改动）；或要求后端在 WBS 返回直接带 `milestoneName`（属轻微后端改动，需评估）。建议前者。
3. **全局 `wbsStore` 复用问题**：`wbsStore` 为单项目全局 store（`fetchWbs` 会覆盖当前 `projectId` 状态）。抽屉建议**直接调用 `api.listWbs(projectId)` 局部拉取**，避免污染其它页面的 wbs 状态；请架构师确认。
4. **分页 / 虚拟滚动**：单项目 WBS 节点可能上百条，逾期/临期分 Tab 后通常数量有限。是否初期即做虚拟滚动？建议先不做（P2），超阈值再补。
5. **`today()` 取值对齐**：需求固定 `today=2026-08-17` 为演示基准；需确认 `utils/date#today()` 未被 mock 覆盖、与种子数据基准日一致，保证抽屉过滤与报表数字同口径。
6. **行点击行为**：任务行是否可点击跳该项目 WBS 页并锚定任务（参考 `OwnerLoadDrawer` 跳项目概览）？建议作为 P2-1。
