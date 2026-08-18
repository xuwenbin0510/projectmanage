# B18 总览分布图点档下钻任务明细抽屉 — 简单 PRD

> 文档类型：**简单 PRD（默认模板，不含竞品分析）**
> 作者：产品（许清楚）｜主理人：齐活林
> 项目盘址：`C:/Users/xuwen/WorkBuddy/AstrBytes/pm-app/`
> 技术栈：Vite + React + TS + MUI + Tailwind；图表 `@mui/x-charts` v7；后端 Node(Express) + better-sqlite3（真实 DB）
> 前置：B17（全局总览 7 图可视化，3 张分布图仅展示）已交付；**本批为 B17 之后首次新增 1 个后端接口**（B15/B16/B17 均零新接口，本批打破）
> 生成日期：2026-08-18

---

## 1. 需求背景与已核实现状（全部基于实际代码，非臆测）

### 1.1 用户原话要点

B17 给「全局总览」页新增了 3 张分布图（任务优先级 P0-P3 / 任务状态 5 档 / 逾期时长 3 段，均只展示）。用户现在要求：**点击分布图的某个档位（柱或图例）→ 右侧滑出抽屉，展示该档对应的任务明细列表**，行点击跳对应项目 WBS 页（详情/编辑）。健康环、状态环保持原有「点击段→筛选」行为不变。

### 1.2 主理人已拍板方案（不可改，本 PRD 按此细化）

1. **新增后端接口 `GET /api/dashboard/tasks`**：复用 overview 的 scope/过滤逻辑（`type`/`status`/`health`/`keyword`/`onlyMine`/`scope` 同源同口径）+ 维度过滤参数 `priority` / `taskStatus` / `overdueBucket` + 分页（`page`/`pageSize`，同 overview 明细表模式）；返回 `{items,total,page,pageSize}`，items 为任务明细行（含项目上下文 `projectId`/`projectName`）。
2. **前端抽屉 `DistributionTaskDrawer.tsx`**（新建，参考 B15 `MyTasksDrawer` 骨架）：props `{ open, title, query(维度参数), onClose }`，打开时调用 `api.getDashboardTasks(query)` 局部拉取，`DataTable` 渲染（列：优先级/任务/项目名/负责人/截止日/状态/进度），分页，行点击 `navigate(ROUTES.projectWbs(row.projectId))`；关闭即丢弃。
3. **`CategoryBarChart` 加 `onDrill?: (key: string) => void`**：点击某档柱体或图例触发，传入该档 key（如 `'P0'` / `'进行中'` / `'8to30'`）。
4. **MetricsPage 接线**：3 张新图接 `onDrill` → 打开抽屉（title 如「P0 任务明细」/「进行中任务明细」/「逾期 8–30 天任务明细」），query 带维度参数；原 4 图交互不动。

### 1.3 已核实现状盘点（主理人勘察 + 撰写时逐文件复核）

| 位置 | 现状（代码事实） |
|---|---|
| `server/routes/dashboard.routes.js` | 仅挂 `GET /dashboard/overview`：`requireAuth` + `asyncHandler`，路由层**不加角色守卫**；「能否看公司全量」由 `dashboard.service.resolveScope` 内部按 `dashboard:global` 判定，无权限者静默降级 `scope=mine`（不抛 403）。新接口应挂同一 router、同一鉴权模式。 |
| `server/services/dashboard.service.js` | `normalizeQuery(query)`（白名单校验，非法取值降级为「不过滤」；`page≥1`、`pageSize 1..200 默认 20`、`onlyMine` 布尔归一）、`resolveScope(me, requested)`（`canDo(role,'dashboard:global')` → all/mine，否则强制 mine）、`listScopedItems`（项目行 + `loadListContext` 聚合，含 `pmName` 等）、`listScopeLeafTasks(db, projectIds)`（在办叶子，`status !== '完成'`，经 `toApiWbsNode` 含 `ownerName`）、`listScopeAllLeafTasks(db, projectIds)`（全量叶子含已完成）；`MANAGED_STATUSES=['已批准','进行中','挂起']`（决策 ⑥ 三态基线）；`getDashboardOverview` 内 `priorityDist`/`statusDist`/`overdueDuration` 三图已算好。**没有按维度过滤任务明细的接口**。 |
| `server/lib/portfolioAgg.js` | 纯函数：`aggregatePriorityDist`（P0-P3 白名单、脏值兜底 P2）、`aggregateStatusDist`（`enums.TASK_STATUSES` 五档，脏状态不计入）、`aggregateOverdueDuration(tasks, todayStr)`（仅 `isOverdue` 者；`days=diffDays(dueDate,today)`；`≤7`→days1to7 / `≤30`→days8to30 / else→daysOver30；`total=三段之和=countOverdueTasks`）、`isOverdue`（`due` 非空且 `diffDays(today,due) < 0`）、`countOverdueTasks`、`compareText`、`UNNAMED_PROJECT='未命名项目'`。 |
| `server/lib/mappers.js` | `toApiWbsNode(row, nameOf)` 返回 `id/projectId/wbsCode/name/owner/ownerName/status/dueDate/progress/priority`（`priority` 兜底 `P2`）等 20 字段；**不含 `projectName`**（项目名需在 service 层查 `projects.name` 或由 `ProjectListItem.name` 映射）。`makeNameLookup(db)` 反查 openId → 姓名。 |
| `server/config/enums.js` | `TASK_STATUSES=['待办','进行中','待评审','完成','阻塞']`；`HEALTHS=['green','yellow','red']`；`PROJECT_TYPES=['A','B','C']`；**未导出优先级**（优先级白名单内联在 `portfolioAgg.PRIORITIES` 与 `wbs.service.PRIORITIES`）。 |
| `server/config/permissions.js` | `'dashboard:global': { global: ['admin','pmo','management'] }`；`canDo(globalRole, action, projectRoles)`。 |
| `server/lib/envelope.js` | `ok(data)` 成功信封；`paged(items,total,page,pageSize)` 返回 `{items,total,page,pageSize}`；`asyncHandler` 包裹异步路由。 |
| 日期口径 | `server/lib/dates.js` 与 `web/src/utils/date.ts` 逐字一致：`today()`、`diffDays(a,b)=b-a`（天）、`isOverdue`。 |
| `web/src/pages/MetricsPage.tsx` | B17 后图表区 7 图（md 2 列 / xl 3 列）：状态环 `DonutChart`（`onSegmentClick`→状态筛选）/ 健康环 `HealthDonut`（`onDrill`→健康筛选）/ 逾期柱 `OverdueBarChart`（`onDrill`→B13 抽屉）/ 负荷柱 `OwnerLoadBarChart`（`onDrill`→OwnerLoadDrawer）/ 优先级 `CategoryBarChart` / 状态 `CategoryBarChart` / 逾期时长 `CategoryBarChart`（**后 3 图无点击**）。已 import `OwnerLoadDrawer`、`OverdueTaskDrawer`；`useDashboardOverview()` 提供 `query`（受控筛选）与有效 `scope`。 |
| `web/src/components/dashboard/CategoryBarChart.tsx` | props `{ title; subtitle?; rows: CategoryBarRow[]; loading?; empty?; emptyTitle?; emptyDescription?; unit? }`；`CategoryBarRow={key,label,value,color}`；横向 `BarChart` 每档一个 series 掩码着色；footer `ChartLegend`（`ChartLegendItem` 已支持 `onClick?`，点击即触发、可传）；**无 `onDrill` 回调**。参照 `OwnerLoadBarChart` 已有 `onItemClick` 用法（`(e, identifier) => list[identifier.dataIndex]`）。 |
| `web/src/components/dashboard/ChartCard.tsx` | `ChartLegendItem` 含可选 `onClick`；`ChartLegend` 渲染时 `cursor: pointer` + hover 反馈。 |
| `web/src/components/dashboard/MyTasksDrawer.tsx` | 右滑抽屉骨架：`<Drawer anchor="right" width:420 maxWidth:'92vw'>`、关闭 `IconButton`（遮罩/×/ESC）、内部 `DataTable`、`PAGE_SIZE=8`、行点击 `navigate(ROUTES.projectWbs(row.projectId))`、`normalizePriority`/`PRIORITY_OPTIONS`/`StatusChip`/`ProgressBar`/`PriorityChip`/`fmtDate`/`isOverdue` 均已就绪。 |
| `web/src/components/dashboard/OverdueTaskDrawer.tsx` | 抽屉内**局部拉取**（不写全局 store）、`ErrorState` + 重试、分页/筛选模式可参考。 |
| `web/src/api/http.ts` | `HttpApiClient` 实现 `getDashboardOverview`（L357，`/dashboard/overview${qs(query)}`）；新增 `getDashboardTasks` 挂同目录。 |
| `web/src/api/contract.ts` | `ApiClient` 接口（Mock / HTTP 双实现签名一致）；需新增 `getDashboardTasks`。 |
| `web/src/api/client.ts` | `USE_MOCK = String(import.meta.env.VITE_USE_MOCK ?? 'true') === 'true'` —— **默认 mock 模式**；`api` 为 `mockClient` 或 `httpClient`。 |
| `web/src/api/mock/index.ts` | `getDashboardOverview`（L2580）与服务端字段逐个对齐（手工双写），内部用 `leafNodesOf(...)` 判真叶子、`aggregateOverdueDuration`（import 自 `utils/dashboardAgg`，L97/L2647）分段；**需同步新增 `getDashboardTasks`**，否则默认 mock 模式抽屉无数据。 |
| `web/src/utils/dashboardAgg.ts` | `UNNAMED_PROJECT='未命名项目'`（L41）；`aggregatePriorityDistribution`（L214）/`aggregateStatusDist`（L289）/`aggregateOverdueDuration`（L305）纯函数可复用于 mock。 |
| `web/src/types/dashboard.ts` | 已有 `DashboardOverviewQuery`（scope/type/status/health/keyword/onlyMine/timeRange/page/pageSize/sort）、`PriorityDistribution`、`TaskStatusDistribution`、`OverdueDurationDistribution`（`days1to7/days8to30/daysOver30/total`）；**无任务明细行类型**。 |
| `web/src/config/routes.ts` | `ROUTES.projectWbs(id) => /projects/{id}/wbs` 已存在。 |
| `web/src/config/enums.ts` | `TASK_STATUSES`、`PRIORITIES`、`PRIORITY_OPTIONS`、`normalizePriority`、`priorityRankOf` 已就绪。 |

### 1.4 硬性约束（必须遵守）

- **零 schema 变更、零新依赖、零新路由文件**：新接口挂在既有 `server/routes/dashboard.routes.js`；不新增其它后端接口。
- **口径红线**：日期一律走 `server/lib/dates` 与 `web/src/utils/date`（`isOverdue` / `diffDays` / `today`）；优先级归一 `P0-P3` 白名单、脏值兜底 `P2`（与 `portfolioAgg.aggregatePriorityDist` / `wbs.service.normalizePriority` 一致）；任务状态白名单 `enums.TASK_STATUSES`；`overdueBucket` 分段与 `aggregateOverdueDuration` 逐字一致（**三段 union 必须 = `countOverdueTasks`，QA 可断言**）。
- **RBAC**：新接口与 overview 同权限模型（`dashboard:global` 控制 all/mine，其余角色强制 mine，不抛错）。
- **不动现有可用功能**：B17 的 3 张分布图（数据/样式/空态）、健康环/状态环筛选、明细表、既有抽屉全部保留；`CategoryBarChart` 的 `onDrill` 缺省不可点（不传 = 原行为）。
- **本 PRD 交付物 = 文档**；不改业务代码。

---

## 2. 产品目标

- **G1 一档到底**：从分布图的一档（柱或图例）直接看到该档任务清单，缩短「发现问题 → 定位任务」路径。
- **G2 口径自洽**：抽屉计数与服务端三图对应档位逐字一致（同一 scope/筛选/同一时刻），用户不会看到「图上 5 条、抽屉 6 条」。
- **G3 最小回归**：仅新增 1 个后端接口 + 1 个抽屉组件 + `CategoryBarChart` 一个可选回调；健康环/状态环等既有交互零改动。

---

## 3. 用户故事

- **US-1｜P0 先救**：作为 PMO，我希望点击「任务优先级分布」的 P0 档，右侧滑出该档未完成任务清单，以便立即定位最紧急积压。
- **US-2｜状态追因**：作为管理层，我希望点击「任务状态分布」的阻塞档，看到哪些任务卡住、属于哪些项目，以便判断是否需要介入。
- **US-3｜逾期追责**：作为项目经理，我希望点击「逾期时长分段」的 8–30 天档，按项目/负责人看逾期任务，以便安排补救。
- **US-4｜钻到源头**：作为用户，我希望点击抽屉里的任务行直接跳到该项目 WBS 页（详情/编辑），以便一条路径完成处置。
- **US-5｜口径不骗人**：作为用户，我希望抽屉数量与所点档位数量一致、筛选上下文与总览当前筛选一致，以便不产生「数字对不上」的困惑。

---

## 4. 功能点清单（全量，不省略条目）

### P0（必做 · 已拍板方案全覆盖）

| 编号 | 功能点 | 技术点（行内一句话） |
|---|---|---|
| P0-1 | 后端接口 `GET /api/dashboard/tasks`（新增 · 本批唯一新接口） | 挂在 `server/routes/dashboard.routes.js` 同一 router：`router.get('/dashboard/tasks', requireAuth, asyncHandler(...))`，返回 `ok(dashboardService.getDashboardTasks(db, req.query, req.user))`；鉴权模式与 overview 完全一致（`requireAuth` 即可，不加角色守卫）。 |
| P0-2 | 复用 overview 的 scope/过滤归一 | `dashboard.service` 新增 `getDashboardTasks(db, query, me)`：内部复用 `normalizeQuery(query)` 得 `q`（`scope/type/status/health/keyword/onlyMine/page/pageSize` 全部同源同口径，`sort` 忽略）+ `resolveScope(me, q.scope)` 得实际范围；非法过滤值一律降级为「不过滤」（不抛错）。 |
| P0-3 | 维度过滤参数 `priority`（P0-P3） | 入参归一：`P0-P3` 白名单（`PRIORITIES`），**非法值（如 `P9`/空串）兜底归一为 `P2`**（与 `aggregatePriorityDist` 脏值兜底逐字一致）；行匹配：`normalizePriority(node.priority) === 归一后参数`。缺省（未传）→ 不按优先级过滤。 |
| P0-4 | 维度过滤参数 `taskStatus`（5 档） | 入参白名单 `enums.TASK_STATUSES`（待办/进行中/待评审/完成/阻塞），非法 → 不过滤；命中时基数 = **范围内全量叶子任务（含已完成）**（`listScopeAllLeafTasks`），过滤 `status === taskStatus` —— 这是「完成」档能出数的唯一基数（在办基数不含完成）。 |
| P0-5 | 维度过滤参数 `overdueBucket`（3 段） | 入参白名单 `'1to7' | '8to30' | 'over30'`，非法 → 不过滤；行匹配口径与 `aggregateOverdueDuration` 逐字一致：仅 `isOverdue`（`diffDays(today,dueDate)<0`，空 dueDate 恒 false），`days=diffDays(dueDate,today)`，`≤7`→1to7 / `≤30`→8to30 / else→over30。 |
| P0-6 | 基数选择 + 维度互斥 | 维度参数三选一（UI 只传一个；服务端防御性互斥，按 `taskStatus` → `overdueBucket` → `priority` 顺序只取第一个合法维度生效，其余忽略，保证响应恒能对上某图一档计数）：`taskStatus` 生效 → 基数 = 全量叶子（含已完成）；否则 → 基数 = 在办叶子（`listScopeLeafTasks`），再按 `priority` 或 `overdueBucket` 过滤（可叠加，UI 不叠加）；均未传维度 → 返回范围内全部在办叶子任务分页。 |
| P0-7 | 任务明细行组装 | items 每行经 `toApiWbsNode` 派生 + 补 `projectName`（从范围内 `ProjectListItem[].name` 建 `projectId → name` 映射，缺失回落 `UNNAMED_PROJECT`）；行字段：`id / projectId / projectName / wbsCode / name / priority / status / dueDate / progress / ownerName`。 |
| P0-8 | 排序 + 分页 | 排序固定：优先级 `P0→P3` 升序 → 截止日升序（空 dueDate 恒最后）→ 名称升序（`compareText`），稳定 tie-break 保证分页不跳行；分页复用 `envelope.paged`：`page≥1`（默认 1）、`pageSize 1..200`（默认 20），返回 `{items,total,page,pageSize}`。 |
| P0-9 | `CategoryBarChart` 加 `onDrill?: (key: string) => void` | 参照 `OwnerLoadBarChart` 的 `onItemClick`：`(e, id) => { const r = list[id.dataIndex]; if (r && onDrill) onDrill(r.key); }`（柱体点击）；footer `ChartLegend` items 传 `onClick: onDrill ? () => onDrill(r.key) : undefined`（图例点击，0 值档也可点，打开空态抽屉）；`onDrill` 存在时 Box `cursor: 'pointer'`；**不传 = 原行为（不可点）**。 |
| P0-10 | 新建 `DistributionTaskDrawer.tsx` | props `{ open: boolean; title: string; query: DashboardTasksQuery; onClose: () => void }`；骨架复用 `MyTasksDrawer`（`<Drawer anchor="right" width:420 maxWidth:'92vw'>`、关闭 `IconButton`）；打开时 `api.getDashboardTasks({ ...query, page, pageSize: PAGE_SIZE })` 局部拉取（`PAGE_SIZE=8`，沿用抽屉惯例），关闭即丢弃、下次打开复位到第 1 页。 |
| P0-11 | 抽屉表格渲染 | `DataTable<DashboardTaskRow>` 7 列：优先级（`PriorityChip` + `normalizePriority`）/ 任务（`wbsCode + name`）/ 项目名（`projectName || UNNAMED_PROJECT`）/ 负责人（`ownerName || '未分配'`）/ 截止日（`fmtDate`，`isOverdue` 红色标注）/ 状态（`StatusChip`）/ 进度（`ProgressBar`，逾期 `danger` 否则 `brand`）；行点击 `navigate(ROUTES.projectWbs(row.projectId))`；分页（`total > PAGE_SIZE` 时启用，`onChange(page)` 重新拉取）；加载/空/错（`ErrorState` + 重试）态齐全；头部副标题 `共 N 个任务`（N = 服务端 `total`）。 |
| P0-12 | MetricsPage 接线（3 张新图） | 优先级图 `onDrill={(key) => openDist(`${key} 任务明细`, { priority: key as Priority })}`；状态图 `onDrill={(key) => openDist(`${key}任务明细`, { taskStatus: key as TaskStatus })}`；逾期时长图 `onDrill={(key) => openDist(DURATION_TITLE[key], { overdueBucket: DURATION_KEY_TO_BUCKET[key] })}`（映射表 `days1to7→'1to7'`、`days8to30→'8to30'`、`daysOver30→'over30'`，title `逾期 1–7 天任务明细` / `逾期 8–30 天任务明细` / `逾期 >30 天任务明细`）；`openDist` 组装 `query` = 当前总览筛选上下文（有效 `scope` + `type/status/health/keyword/onlyMine`，**不含 overview 的 page/pageSize/sort**）+ 维度参数；渲染 `<DistributionTaskDrawer ... />`；原 4 图交互不动。 |
| P0-13 | 前端类型 + API 契约 + mock 双写 | `web/src/types/dashboard.ts` 新增 `OverdueBucket`、`DashboardTasksQuery`（`DashboardOverviewQuery` 的筛选子集 + `priority?/taskStatus?/overdueBucket?` + `page?/pageSize?`）、`DashboardTaskRow`；`web/src/api/contract.ts` `ApiClient` 新增 `getDashboardTasks(query): Promise<Paged<DashboardTaskRow>>`；`web/src/api/http.ts` 实现 `getDashboardTasks`（`/dashboard/tasks${qs(query)}`）；`web/src/api/mock/index.ts` 新增同名方法（scope 解析 + 项目过滤 + `leafNodesOf` 判叶子 + 维度过滤 + 分页，复用 `utils/dashboardAgg` 的 `aggregateOverdueDuration`/`normalizePriority` 等口径）——默认 mock 模式（`VITE_USE_MOCK` 缺省 true）下抽屉必须有数据。 |

### P1（重要 · 增强体验，不阻塞核心方案）

| 编号 | 功能点 | 技术点（行内一句话） |
|---|---|---|
| P1-1 | 抽屉空态文案按维度区分 | 空态主文案建议「当前范围暂无该档任务」，副文案「试试调整总览筛选或切换范围」；维度不同可微调（如逾期桶「太好了，没有该档逾期任务 🎉」），不强制。 |
| P1-2 | 抽屉打开时若总览仍在加载/报错 | 抽屉不阻塞：即使总览 `loading`，点档位仍立即打开抽屉并局部拉取；总览筛选变化后再次点档位，抽屉 query 取最新上下文。 |
| P1-3 | 抽屉头部分页状态可见 | 副标题追加当前页范围（如 `第 1-8 / 共 23 条`），与 `DataTable` 分页一致（可选）。 |

### P2（可选 · 本期不做，列入 backlog）

| 编号 | 功能点 | 说明 |
|---|---|---|
| P2-1 | 抽屉内二次筛选 | 在档位集合内再做状态/关键字/「仅看我负责」二次筛选（参考 `OverdueTaskDrawer` P2-3/P2-4）；本期抽屉只展示服务端返回行，不加前端筛选。 |
| P2-2 | 抽屉内排序切换 | 按截止日 / 优先级 / 进度切换排序；本期固定服务端排序。 |
| P2-3 | 抽屉「涉及 N 个项目」统计 | 头部显示当前档跨项目数；本期不加（保持最小）。 |

---

## 5. UI 设计稿（文字描述）

### 5.1 总览图表区（B17 布局不变，仅 3 张新图可点）

- 栅格与 7 图顺序与 B17 完全一致（状态环 → 健康环 → 逾期柱 → 负荷柱 → 优先级 → 状态 → 逾期时长）。
- 交互变化：⑤⑥⑦ 三张 `CategoryBarChart` 的**柱体与 footer 图例均可点击**（hover 出现 pointer 光标），点击打开右侧抽屉；①状态环/②健康环/③逾期柱/④负荷柱交互逐字不变。
- 不传 `onDrill` 的任何其它用法保持原样（不可点）。

### 5.2 任务明细抽屉（右侧滑出）

- 位置/尺寸：右滑 `<Drawer anchor="right">`，内容区 `width: 420, maxWidth: '92vw'`，`p: 2.5`，内部纵向 flex。
- 头部：标题（`subtitle1`，如「P0 任务明细」「进行中任务明细」「逾期 8–30 天任务明细」）+ 副标题（`caption`，`共 N 个任务`）+ 关闭 `IconButton`（遮罩 / × / ESC 均可关）。
- 表格：`DataTable` dense，7 列顺序 = 优先级 / 任务 / 项目名 / 负责人 / 截止日 / 状态 / 进度；行 hover 可点，点击跳 `ROUTES.projectWbs(row.projectId)`。
- 分页：总数 > 8 时表格底部出现分页；翻页触发服务端重新拉取。
- 状态：加载骨架、空态（正向文案）、错误态（`ErrorState` + 重试按钮）。
- 关闭即丢弃：重新打开按最新 `query` 从第 1 页重新拉取。

---

## 6. 关键技术点（全量，行内一句话）

- **新接口唯一**：`GET /api/dashboard/tasks` 挂在既有 `dashboard.routes.js`；零 schema / 零新依赖 / 零新路由文件 / 不新增其它接口。
- **同源同口径**：`getDashboardTasks` 复用 `normalizeQuery` + `resolveScope` + `listScopedItems` + `listScopeLeafTasks`/`listScopeAllLeafTasks`，scope/过滤/三态基线/权限降级与 overview 逐字一致。
- **口径守恒**：`priority` 归一（脏值 P2）、`taskStatus` 白名单（含完成档基数 = 全量叶子）、`overdueBucket` 分段与 `aggregateOverdueDuration` 逐字一致；建议在 `portfolioAgg` 抽出纯函数 `overdueBucketOf(todayStr, dueDate) → '1to7'|'8to30'|'over30'|null`（`null` = 未逾期/无 dueDate），`aggregateOverdueDuration` 与 tasks 过滤共用，杜绝两处分段漂移（行为不变，QA 可回归 B17）。
- **基数规则**：`taskStatus` 命中 → 全量叶子（含已完成）；否则 → 在办叶子；保证「完成」档可出数、`priority`/`overdueBucket` 与图计数一致。
- **维度互斥**：服务端按 `taskStatus → overdueBucket → priority` 只取第一个合法维度生效，UI 只传一个；避免混合维度响应无法对上任何一档。
- **行数据**：`toApiWbsNode` 派生 `priority/status/dueDate/progress/ownerName`；`projectName` 由范围内项目名映射补齐（缺失 `未命名项目`）。
- **抽屉局部拉取**：`DistributionTaskDrawer` 内部调 `api.getDashboardTasks`，不写全局 store、关闭即丢弃（同 `OverdueTaskDrawer` 模式）。
- **可点图例**：`ChartLegendItem` 已支持 `onClick`，`CategoryBarChart` 仅需透传；柱体点击复用 `OwnerLoadBarChart` 的 `onItemClick` 模式。
- **mock 双写**：默认 `VITE_USE_MOCK=true`，`mock/index.ts` 必须新增 `getDashboardTasks` 并对齐服务端语义，否则抽屉在演示态无数据。
- **回归红线**：B17 三图数据/样式/空态、健康环/状态环筛选、明细表、`OverdueTaskDrawer`/`MyTasksDrawer`/`OwnerLoadDrawer` 全部不动；`CategoryBarChart` 不传 `onDrill` 时行为与 B17 逐字一致。

---

## 7. 验收标准（可勾选）

### P0 验收

- [ ] 新接口 `GET /api/dashboard/tasks` 挂在 `server/routes/dashboard.routes.js`（同一 router、`requireAuth`、无角色守卫）；无 schema 变更、无新依赖、无新路由文件、无其它新接口（`git diff` 后端仅涉及 `dashboard.routes.js`、`dashboard.service.js`、可选 `portfolioAgg.js`）。
- [ ] 接口复用 overview 的 scope/过滤：非特权角色传 `scope=all` 被强制降级为 `mine` 且不抛 403（`requireAuth` 未登录则 401）；`type/status/health/keyword/onlyMine` 过滤与 overview 逐字一致（`status` 仍只认在管三态，决策 ⑥）。
- [ ] `priority` 过滤：传 `P0/P1/P2/P3` 各档返回对应档任务；传脏值（如 `P9`/空串）等价于 `P2`；不传不过滤。
- [ ] `taskStatus` 过滤：传 `待办/进行中/待评审/完成/阻塞` 各档返回对应任务；传非法值不过滤；**`taskStatus=完成` 能返回已完成叶子**（基数含已完成）。
- [ ] `overdueBucket` 过滤：传 `1to7/8to30/over30` 各段返回对应逾期任务；传非法值不过滤。
- [ ] 口径断言（同一 scope/筛选/同一时刻）：`priority=Px` 的 `total` = overview `priorityDist[Px]`；`taskStatus=S` 的 `total` = overview `statusDist[S]`；`overdueBucket=B` 的 `total` = overview `overdueDuration.days*`；**三个 overdueBucket 的 `total` 之和 = `stats.overdueTasks`（= `countOverdueTasks`）**。
- [ ] 返回体为 `{ items, total, page, pageSize }`（`envelope.paged`）；items 每行含 `id/projectId/projectName/wbsCode/name/priority/status/dueDate/progress/ownerName`；`projectName` 为项目真实名（缺失回落「未命名项目」）。
- [ ] 分页正确：`page`/`pageSize` 生效（默认 20、上限 200），翻页不跳行不重复；排序固定（优先级 P0→P3 → 截止日升序 → 名称升序）。
- [ ] `CategoryBarChart` 新增 `onDrill?: (key: string) => void`：点击柱体或 footer 图例触发，回调参数为该档 key；**不传 `onDrill` 时柱体/图例不可点（原行为）**。
- [ ] 新建 `DistributionTaskDrawer`：右滑 420px/92vw、关闭 IconButton（遮罩/×/ESC）、打开时局部拉取 `getDashboardTasks`、关闭即丢弃、分页翻页重新拉取；7 列 = 优先级/任务/项目名/负责人/截止日/状态/进度；行点击跳 `ROUTES.projectWbs(row.projectId)`；加载/空/错（可重试）态齐全。
- [ ] MetricsPage 3 张新图接 `onDrill`：点优先级档 → 抽屉标题「P0 任务明细」等；点状态档 → 「进行中任务明细」等；点逾期时长档 → 「逾期 8–30 天任务明细」等；query 携带维度参数 + 当前总览筛选上下文（scope/type/status/health/keyword/onlyMine）。
- [ ] 抽屉数量与所点档位图例数量一致；总览筛选变化后重新点档位，抽屉按最新上下文取数。
- [ ] 健康环/状态环点击筛选、逾期柱/负荷柱抽屉、明细表、筛选栏行为全部不变；B17 三图数据/样式/空态不变（仅新增可点）。
- [ ] mock 模式（默认 `VITE_USE_MOCK=true`）下抽屉有数据且口径与服务端一致。

### P1 验收

- [ ] 抽屉空态为正向文案（如「当前范围暂无该档任务」），与维度对应。
- [ ] 抽屉截止日列逾期红色标注、进度条逾期 `danger` 色调，与既有抽屉视觉一致。
- [ ] 抽屉头部副标题显示 `共 N 个任务`，与表格分页总数一致。

---

## 8. 待确认问题清单（已按推荐值编写，如需改请指出）

1. **抽屉每页条数**：沿用既有抽屉惯例 `PAGE_SIZE=8`（前端常量，不改后端默认 20）；如需 10/20 只改前端一处常量。
2. **`priority` 入参脏值语义**：按「非法值兜底归一为 `P2`」（等价传 P2），与 `aggregatePriorityDist` 脏值兜底一致；与 `taskStatus`/`overdueBucket` 的「非法即不过滤」不同——如需统一为「非法即不过滤」请指出，只改一处归一逻辑。
3. **抽屉是否显示「涉及 N 个项目」**：本 PRD 不加（保持最小，P2-3 backlog）；如需本期加，仅头部副标题追加一个去重计数。
