# B15 工作台数据展示区快速查询 / 编辑入口 — 简单 PRD

> 文档类型：**简单 PRD（默认模板，不含竞品分析）**
> 作者：产品（许清楚）｜主理人：齐活林
> 项目盘址：`C:/Users/xuwen/WorkBuddy/AstrBytes/pm-app/`
> 技术栈：Vite + React + TS + MUI + Tailwind；图表 `@mui/x-charts` v7；后端 Node(Express) + better-sqlite3（真实 DB）
> 前置：B10（审批+工作台接真数据）、B11（工作台仪表盘增强）、B12（全局仪表盘）、B13/B13.5（逾期下探抽屉）、B14（任务优先级+周报闭环+待办中心）已交付
> 生成日期：2026-08-18

---

## 1. 需求背景与已核实现状（全部基于实际代码，非臆测）

### 1.1 用户原话要点

工作台「数据展示区」缺少快速查询详情 / 编辑入口：只有「待我审批」可快速进入；「逾期任务」无法快速查详情、「待填周报」无快速入口、「我的任务进度」和「任务优先级分布」展示也没有详情快速查看。用户认为这几处需要优化。

### 1.2 用户已拍板方案（不可改，本 PRD 按此细化）

1. **逾期任务 StatCard 点击 → 打开「全局逾期抽屉」**：聚合所有项目的逾期 / 临期任务（非单项目），含分页 / 筛选 / 仅看我，行点击跳对应项目 WBS 页。图表柱形点击（B13 单项目抽屉）保留不变。
2. **本周待填周报 StatCard 点击 → 直达第一个未填项目的周报填写页**（缺失 > 0 时）；下方「周报提醒」区块「去填写」按钮保留。
3. **进度环点段 / 优先级环点段 → 统一汇入「我的任务明细抽屉」**：新增 `MyTasksDrawer` 组件（跨项目聚合我的任务），进度段（已完成 / 在办 / 未启动）或优先级（P0/P1/P2/P3）作为抽屉筛选条件；抽屉内看明细、行点击跳对应项目 WBS 页（有详情 + 编辑）；「我的任务」区块补「查看全部」入口打开同一抽屉。

### 1.3 已核实现状盘点（主理人勘察 + 本 PRD 撰写时逐文件复核）

| 位置 | 现状（代码事实） |
|---|---|
| `web/src/pages/WorkbenchPage.tsx` | 顶部 3 张 `StatCard`：待我审批有 `onClick → navigate(ROUTES.approvals)`；**逾期任务、本周待填周报均无 `onClick`**。`StatCard` 组件（`web/src/components/common/Widgets.tsx`）已支持 `onClick`（有则 `cursor:pointer` + hover 抬起），接线零改动。 |
| 图表区四图 | `ProgressDonut`（我的任务进度，组件 props 只有 `summary/loading`，**无任何点击能力**）、`PriorityDonut`（任务优先级分布，props **已预留 `onDrill?: (priority: Priority) => void`**，内部已把 `DonutChart.onSegmentClick` 接好，仅工作台未传）、`OverdueBarChart`（已有 `onDrill → openOverdue` 打开 B13 单项目抽屉）、`HealthDistBar`（已有 `onDrill → navigate(ROUTES.projects)`）。 |
| `web/src/components/dashboard/DonutChart.tsx` | 通用环形图，支持 `onSegmentClick`（环体点击 + 图例点击均触发；0 值段进图例也带 `onClick`）。`ProgressDonut`/`PriorityDonut` 是薄封装。 |
| `web/src/components/dashboard/OverdueTaskDrawer.tsx` | B13/B13.5 已有：**单项目**抽屉（props: `open/projectId/projectName?/initialTab/currentUserId?/onClose`）；抽屉内 `Promise.all([api.listWbs(projectId), api.listMilestones(projectId)])` **局部拉取**（不写 `wbsStore`，关闭即丢弃）；双 Tab 逾期/临期；P2 增强已含行点击跳 `ROUTES.projectWbs(projectId)`、分页（`PAGE_SIZE=8`）、状态下拉 + 关键字筛选（任务名/负责人）、优先级筛选（B14）、仅看我开关（`ownerId === currentUserId`）；列：优先级 Chip / 任务 / 负责人 / 计划完成日 / 状态 / 进度 / 所属里程碑。 |
| `web/src/utils/dashboardAgg.ts` | `buildDashboard(data)` 纯前端聚合出 `dashboard.progress`（`aggregateTaskProgress`：done=`完成`，active=`进行中+待评审`，pending=`待办+阻塞`）、`dashboard.overdue`（`aggregateOverdue`，只含逾期/临期项目，按逾期↓临期↓项目名排序）、`dashboard.health`、`dashboard.priority`（`aggregatePriorityDistribution`，P0–P3 四档，脏值兜底 `P2`）；`splitOverdueByStatus(nodes)` 返回 `{overdue, dueSoon}`（过滤 `完成`）；`comparePriority`/`sortByPriority` 为 P0 置顶排序唯一实现。 |
| 数据口径 | `GET /api/workbench` 返回 `WorkbenchData`：`stats.pendingApprovals / stats.overdueTasks / stats.missingReports`、`myProjects`、`myTasks`（`WbsNode[]`，服务端已滤 `status==='完成'`、仅 owner=我 的叶子任务，**每行含 `projectName`**）、`myApprovals`、`reportReminders`（`ReportReminder[]`：仅我参与且 `status='进行中'` 项目，含 `projectId/projectName/week/weekStart/weekEnd/filled`）。`stats.overdueTasks = countOverdue(myTasks)`，即**我负责的逾期任务数**。 |
| 路由 | `web/src/config/routes.ts`：`ROUTES.projectWbs(id)`、`ROUTES.projectReports(id)` 等已存在。 |
| 组件资产 | `DataTable`（`web/src/components/common/DataTable.tsx`）支持 `columns/rows/rowKey/onRowClick(row)/pagination(page 1 起)/loading/emptyTitle/emptyDescription/dense`，抽屉内表格复用零新依赖；`PriorityChip`（B14）已有。 |
| 枚举 | `web/src/config/enums.ts`：`PRIORITY_OPTIONS` / `PRIORITIES` / `PRIORITY_RANK`（P0=0..P3=3）/ `normalizePriority` / `priorityRankOf` 已存在。 |

### 1.4 硬性约束（必须遵守）

- **纯前端、零后端接口新增、零 schema 变更**：所有抽屉数据来自 `GET /api/workbench` 返回值（`data.myTasks`、`dashboard.*` 聚合）或复用现有 `api.listWbs(projectId)` / `api.listMilestones(projectId)` 局部拉取；不新增任何后端路由 / 查询 / 字段。
- **不动现有可用功能**：B13 单项目抽屉（图表柱形点击）、下方「周报提醒」区块「去填写」按钮、审批入口（StatCard + 区块）、B14 优先级功能（排序、Chip、优先级筛选、环图配色）全部保留。
- 日期口径一律走 `web/src/utils/date.ts`（`isOverdue` / `diffDays` / `today`），**禁止**在组件里 `new Date()` / 手撸字符串比较。
- 优先级排序 / 归一化一律走 `comparePriority` / `sortByPriority` / `normalizePriority`，禁止字符串直接比较。
- 本 PRD 交付物 = 文档；不改业务代码。

---

## 2. 产品目标

- **G1 一卡直达**：让顶部 3 张统计卡全部可点击，逾期与周报卡从「只看数字」升级为「点进去就能看/填」，消除数据展示区的「看得到、进不去」断层。
- **G2 一图下钻**：让进度环、优先级环的每个点段都能下钻到同一份「我的任务明细」，进度口径与优先级口径在抽屉内可自由切换筛选，形成「图表 → 明细 → 项目 WBS 详情/编辑」的连贯路径。
- **G3 零成本增量**：全部复用 `buildDashboard` 既有聚合与 `listWbs/listMilestones` 既有接口，不新增后端接口、不改 schema、不破坏任何现有交互，保证回归面最小。

---

## 3. 用户故事

- **US-1｜逾期可查**：作为项目经理，我希望点击工作台「逾期任务」统计卡就能看到所有相关项目的逾期 / 临期任务明细（可分页、筛选、仅看我），并能点某行直接进入该项目 WBS 页查看详情与编辑，以便不用先猜是哪个项目、再层层点进去找。
- **US-2｜周报直达**：作为需要填周报的成员，我希望点击「本周待填周报」统计卡就直接跳到第一个未填项目的周报填写页，以便少一次「项目页 → 工作日志」的点击。
- **US-3｜图可下钻**：作为 PM，我希望点击进度环的「在办/未启动」段或优先级环的「P0/P1」段，就能看到对应的我的任务明细列表，以便从「分布长什么样」下钻到「具体是哪几条任务」。
- **US-4｜明细成册**：作为 PM，我希望「我的任务」区块有「查看全部」入口，打开同一份跨项目明细抽屉，以便工作台卡片只展示前 8 条时，其余任务仍有统一入口可查、可跳转编辑。

---

## 4. 功能点清单（全量，不省略条目）

### P0（必做 · 用户拍板方案全覆盖）

| 编号 | 功能点 | 技术点（行内一句话） |
|---|---|---|
| P0-1 | 「逾期任务」StatCard 增加 `onClick` → 打开全局逾期抽屉 | `WorkbenchPage` 新增 `openGlobalOverdue()`：`setOvDrawer({ open: true, mode: 'all' })`，聚合项目列表直接取 `dashboard.overdue`（`Array<{projectId, projectName}>`），并更新该卡 `hint` 文案为「点击查看全部逾期任务」；数值口径不变（`stats.overdueTasks`，后端 `countOverdue(myTasks)`）。 |
| P0-2 | `OverdueTaskDrawer` 扩展 `all`（全局）模式 | 新增可选 prop `mode?: 'project' \| 'all'`（默认 `'project'`，B13 行为零变化）与 `projects?: Array<{projectId: string; projectName: string}>`；`all` 模式下 `load()` 改为 `Promise.all(projects.map(p => Promise.all([api.listWbs(p.projectId), api.listMilestones(p.projectId)])))` 多项目局部拉取，里程碑名映射用 `projectId::milestoneId` 复合 key 防跨项目 id 冲突，仍不写 `wbsStore`、关闭即丢弃。 |
| P0-3 | 全局抽屉行点击跳**对应项目** WBS 页 | `types/dashboard.ts` 的 `OverdueTaskRow` 追加 `projectId: string` 与 `projectName: string`（单项目模式也填充，统一渲染）；`all` 模式下 `onRowClick` 改为 `navigate(ROUTES.projectWbs(row.projectId))`；表格增加「所属项目」列（宽度 110，`hideOnMobile`），头部标题为「全部项目 · 逾期 / 临期明细」，副标题 `逾期 N · 临期 M · 涉及 K 个项目`。 |
| P0-4 | 「本周待填周报」StatCard 增加 `onClick` → 直达首个未填项目 | `WorkbenchPage` 已有 `const missing = reportReminders.filter(r => !r.filled)`；`onClick={() => { if (missing.length > 0) navigate(ROUTES.projectReports(missing[0].projectId)); }}`（`missing[0]` = 服务端按 `updated_at DESC` 排的第一个未填项目）；缺失 = 0 时点击不跳转；更新该卡 `hint` 文案为「点击前往填写」。 |
| P0-5 | `ProgressDonut` 增加 `onDrill` prop | props 追加 `onDrill?: (segment: ProgressSegment) => void`（`ProgressSegment = 'done' \| 'active' \| 'pending'`，新增于 `types/dashboard.ts`），内部透传 `DonutChart.onSegmentClick`（`(seg) => onDrill(seg.id as ProgressSegment)`），不传则不可点（与 `PriorityDonut` 现行为一致）；图例 0 值段（含「已完成」）也可点。 |
| P0-6 | 进度环点段 → 打开我的任务明细抽屉（带进度段筛选） | `WorkbenchPage` 给 `<ProgressDonut onDrill={(seg) => openMyTasks({ progress: seg })} />`；`openMyTasks` 设置 `myTasksDrawer` 状态 `{ open: true, progress?, priority? }`。 |
| P0-7 | 优先级环点段 → 打开我的任务明细抽屉（带优先级筛选） | `WorkbenchPage` 给 `<PriorityDonut onDrill={(pri) => openMyTasks({ priority: pri })} />`（`PriorityDonut` 现有 prop 直接复用，不改组件）。 |
| P0-8 | 新增 `MyTasksDrawer` 组件（跨项目我的任务明细抽屉） | 新建 `web/src/components/dashboard/MyTasksDrawer.tsx`，props `{ open, tasks: WbsNode[], initialProgress?: ProgressSegment, initialPriority?: Priority, onClose }`；`tasks` 由 `WorkbenchPage` 传 `sortedTasks`（已 `sortByPriority` P0 置顶）；抽屉骨架复用 `OverdueTaskDrawer` 模式：`Drawer anchor="right" width 420 maxWidth '92vw'` + 关闭 IconButton + `DataTable` 渲染；筛选工具栏含进度段（全部/已完成/在办/未启动，口径同 `aggregateTaskProgress`：done=`完成`，active=`进行中+待评审`，pending=`待办+阻塞`）与优先级（全部/P0/P1/P2/P3，选项走 `PRIORITY_OPTIONS`），打开时按 `initialProgress` / `initialPriority` 预置、可在抽屉内切换/清空；行字段：优先级 Chip / `wbsCode name` / 项目名 / 截止日（逾期红、临期黄，同工作台列表 `isOverdue`/`diffDays<=3` 口径）/ 状态 `StatusChip` / 进度 `ProgressBar`；不展示里程碑列（`myTasks` 无 `milestoneName` 字段，避免额外拉取）；空态区分「没有未完成任务」与「当前筛选无匹配」。 |
| P0-9 | `MyTasksDrawer` 行点击跳对应项目 WBS 页 | `DataTable.onRowClick={(row) => navigate(ROUTES.projectWbs(row.projectId))}`（项目 WBS 页有详情 + 编辑，满足「快速查询详情 / 编辑」诉求）。 |
| P0-10 | 「我的任务」区块补「查看全部」入口 | `SectionCard` `actions` 加 `<Button size="small" onClick={() => openMyTasks({})}>查看全部</Button>`，打开同一 `MyTasksDrawer`（无初始筛选）；区块内前 8 条展示与行内状态 Select 快捷改（`handleStatus`）**保持不变**。 |
| P0-11 | `WorkbenchPage` 接线与本地状态 | 扩展 `ovDrawer` 状态加 `mode`（`'project' \| 'all'`）字段（`openOverdue` 保持 `mode:'project'`）；新增 `myTasksDrawer` 状态 `{ open, progress?, priority? }`；渲染 `<OverdueTaskDrawer mode={ovDrawer.mode} ... />`（`all` 模式传 `projects={dashboard.overdue}`）与 `<MyTasksDrawer open={...} tasks={sortedTasks} initialProgress={...} initialPriority={...} onClose={...} />`；在 `web/src/components/dashboard/index.ts` barrel 导出 `MyTasksDrawer` 与类型。 |
| P0-12 | 类型扩展 | `web/src/types/dashboard.ts`：新增 `export type ProgressSegment = 'done' \| 'active' \| 'pending'`；`OverdueTaskRow` 追加 `projectId: string`、`projectName: string`（JSDoc 注明 B15 全局模式跨项目用，单项目模式亦填充）；`OverdueTaskDrawerProps` 增加 `mode`/`projects` 可选字段；新增 `MyTasksDrawerProps`（可放组件文件内或 types 文件，二选一，建议放组件文件内与 `OverdueTaskDrawerProps` 一致）。 |

### P1（重要 · 增强体验，不阻塞核心方案）

| 编号 | 功能点 | 技术点（行内一句话） |
|---|---|---|
| P1-1 | `MyTasksDrawer` 二次筛选：状态下拉 + 关键字搜索 | 状态选项取行内去重（同 B13 `statusOptions` 模式，保序去重）；关键字匹配 `name`/`wbsCode`/`projectName`，忽略大小写；任一筛选变化时 `setPage(1)` 复位分页。 |
| P1-2 | `MyTasksDrawer` 分页 | `filteredRows.length > PAGE_SIZE(8)` 时启用 `DataTable` 分页（`pagination` 对象，1 起，复用 B13 写法）。 |
| P1-3 | 全局抽屉「仅看我」数值与卡片口径差异提示 | 卡片数值 = 我负责的逾期数（`stats.overdueTasks`），全局抽屉行数 = 涉及项目全量逾期/临期（含他人，可开「仅看我」对齐）——在抽屉头部副标题或 tooltip 中注明「含他人任务，可开仅看我」，避免数字对不上造成困惑。 |
| P1-4 | 空态文案区分 | 全局抽屉：无逾期「太好了，没有逾期任务」/ 临期「未来 3 天内没有待完成的任务」/ 筛选后无匹配「当前筛选条件下没有匹配的任务」；`MyTasksDrawer` 同理区分「没有分配给我的未完成任务」与筛选后无匹配。 |
| P1-5 | 统计卡可点击视觉强化 | 逾期 / 周报卡 `hint` 文案更新（P0-1/P0-4 已含）之外，两卡 `tone` 与 hover 沿用 `StatCard` 既有 `onClick` 样式（指针 + 抬起），无需改组件。 |

### P2（可选 · 本期不做，列入 backlog）

| 编号 | 功能点 | 说明 |
|---|---|---|
| P2-1 | `MyTasksDrawer` 行内状态快捷修改 | 复用 `handleStatus`（`api.moveTask` + WIP 拦截 + `run()` 刷新）模式，抽屉内直接改状态；本期不做，避免抽屉内改动与工作台列表刷新联动复杂度。 |
| P2-2 | 全局抽屉按项目分组折叠展示 | `all` 模式按项目分组头折叠；本期用「所属项目列 + 排序」替代，交互更简单。 |

---

## 5. UI 设计稿（文字描述）

### 5.1 顶部统计卡区（3 张）

- **待我审批**（不动）：点击 → 审批中心。
- **逾期任务**：新增点击 → 全局逾期抽屉；`hint` 改「点击查看全部逾期任务」；数值 = `stats.overdueTasks`（口径不变）。
- **本周待填周报**：新增点击 → `missing.length > 0` 时直达 `ROUTES.projectReports(missing[0].projectId)`；`hint` 改「点击前往填写」；`missing === 0` 时点击不跳转。

### 5.2 图表区（四图）

- **我的任务进度环（ProgressDonut）**：新增点段交互，点「已完成 / 在办 / 未启动」段或对应图例 → 打开 `MyTasksDrawer` 且进度段筛选预置为该段；卡片 subtitle / 中心大字 / 配色不变。
- **任务优先级分布环（PriorityDonut）**：点「P0/P1/P2/P3」段或图例 → 打开 `MyTasksDrawer` 且优先级筛选预置为该档；其余不变（B14 保留）。
- **逾期 / 临期任务柱状图（OverdueBarChart）**：不动，点柱仍打开 B13 单项目抽屉。
- **健康分布条（HealthDistBar）**：不动，点击仍跳项目列表页。

### 5.3 全局逾期抽屉（`OverdueTaskDrawer` 的 `all` 模式）

- 打开方式：点「逾期任务」统计卡。
- 结构：右侧滑出 420px（`maxWidth '92vw'`），头部标题「全部项目 · 逾期 / 临期明细」，副标题 `逾期 N · 临期 M · 涉及 K 个项目`（筛选后追加 `· 筛选后 X`）；双 Tab「逾期 / 临期」；工具栏：仅看我负责开关（`currentUserId` 传入时显示）/ 状态下拉 / 优先级下拉 / 关键字搜索「搜索任务/负责人」。
- 表格列：优先级 Chip / 任务 / 负责人 / 计划完成日 / 状态 / 进度 / 所属里程碑 / **所属项目**（新增，`hideOnMobile`）；排序 P0 置顶（`comparePriority`）；分页 `PAGE_SIZE=8`。
- 行点击：跳 `ROUTES.projectWbs(row.projectId)`。
- 数据：多项目 `Promise.all` 局部拉取，关闭即丢弃；加载失败显示 `ErrorState` + 重试。

### 5.4 我的任务明细抽屉（`MyTasksDrawer`，新增）

- 打开方式（三入口统一）：进度环点段、优先级环点段、「我的任务」区块「查看全部」。
- 结构：同款右滑抽屉；头部标题「我的任务明细」，副标题 `共 N 个未完成 · 按优先级排序`；筛选工具栏：进度段 Select（全部/已完成/在办/未启动）+ 优先级 Select（全部/P0/P1/P2/P3）+ （P1）状态下拉 + 关键字搜索「搜索任务/项目」。
- 表格列：优先级 Chip / `wbsCode name` / 项目名 / 截止日（逾期红·临期黄）/ 状态 / 进度；排序 P0 置顶；分页 `PAGE_SIZE=8`（P1）。
- 行点击：跳 `ROUTES.projectWbs(row.projectId)`（WBS 页含详情 + 编辑）。
- 数据：直接使用 `WorkbenchPage` 传入的 `sortedTasks`（`data.myTasks` 快照，含 `projectName`），**零额外请求**；抽屉内不改状态（编辑走 WBS 页）。

### 5.5 「我的任务」区块

- `SectionCard` `actions` 新增「查看全部」按钮 → 打开 `MyTasksDrawer`（无初始筛选）；区块内前 8 条列表与行内状态 Select **保持不变**。

---

## 6. 关键技术点（全量，行内一句话）

- **零后端**：不新增接口 / 路由 / 表字段；所有展示数据来自 `GET /api/workbench` 既有返回值与 `api.listWbs` / `api.listMilestones` 既有接口。
- **数据快照传递**：`MyTasksDrawer` 不自己拉数据，`tasks` 由 `WorkbenchPage` 传入 `sortedTasks`（`useMemo` 缓存，`sortByPriority(data.myTasks)`），保证与工作台列表同源同序。
- **口径复用**：进度段判定复用 `aggregateTaskProgress` 的三段语义（done=`完成` / active=`进行中+待评审` / pending=`待办+阻塞`），逾期/临期判定复用 `splitOverdueByStatus` 与 `utils/date` 的 `isOverdue`/`diffDays`，排序复用 `comparePriority`/`sortByPriority`，优先级归一复用 `normalizePriority`/`PRIORITY_OPTIONS`；禁止在组件里复写口径。
- **全局抽屉聚合**：`all` 模式 `load()` 用 `Promise.all` 并行拉取 `projects`（来自 `dashboard.overdue`）各自的 `listWbs` + `listMilestones`，扁平化为带 `projectId/projectName` 的行，里程碑映射用 `projectId::milestoneId` 复合 key；局部 state 不写 `wbsStore`，关闭即丢弃，`open` 或 `projects` 变化时复位 Tab/筛选/分页（沿用 B13 `load` 副作用模式）。
- **类型扩展**：`OverdueTaskRow` 加 `projectId/projectName`；新增 `ProgressSegment`；`OverdueTaskDrawerProps` 加 `mode/projects`；`MyTasksDrawerProps` 定义在组件文件内（与 `OverdueTaskDrawerProps` 同风格）。
- **组件最小改动**：`PriorityDonut` 不改（prop 已就绪）；`ProgressDonut` 只加 `onDrill` 透传；`StatCard` 不改（已支持 `onClick`）；`DonutChart` 不改（已支持 `onSegmentClick`）。
- **路由**：全部跳转复用 `ROUTES.projectWbs(id)` / `ROUTES.projectReports(id)`，无新路由。
- **骨架复用**：两个抽屉沿用 `OwnerLoadDrawer`/`OverdueTaskDrawer` 的右滑抽屉骨架（420px / 92vw、关闭 IconButton、遮罩/×/ESC 关闭、`DataTable` 渲染），零新依赖。
- **回归红线**：B13 单项目抽屉（`mode` 缺省 `'project'`）、周报「去填写」按钮、审批入口、B14 优先级环/排序/Chip 全部不动；`OverdueTaskDrawer` 改动需保证 `mode` 缺省时行为与 B13 逐字一致。

---

## 7. 验收标准（可勾选）

### P0 验收

- [ ] 逾期任务 StatCard 可点击，点击打开「全部项目 · 逾期 / 临期明细」全局抽屉；B13 柱形点击仍打开单项目抽屉且行为不变。
- [ ] 全局抽屉默认展示所有涉及项目（`dashboard.overdue` 覆盖的项目）的逾期 / 临期任务，双 Tab 可切；仅看我开关、状态/优先级下拉、关键字搜索、分页（每页 8）均生效；筛选/分页在重新打开时复位。
- [ ] 全局抽屉每行可见所属项目列；行点击跳转到**该任务所属项目**的 WBS 页（`/projects/:id/wbs`），不是固定某项目。
- [ ] 本周待填周报 StatCard 可点击：`missing.length > 0` 时跳转 `ROUTES.projectReports(missing[0].projectId)`；`missing === 0` 时点击无跳转；下方「周报提醒」区块「去填写」按钮原样保留。
- [ ] 进度环点「在办 / 未启动 / 已完成」段（含图例）→ 打开我的任务明细抽屉且进度段筛选预置对应段；优先级环点 P0–P3 段 → 打开同一抽屉且优先级筛选预置对应档。
- [ ] 「我的任务」区块出现「查看全部」按钮，点击打开同一 `MyTasksDrawer`（无初始筛选），区块内前 8 条与行内状态 Select 行为不变。
- [ ] `MyTasksDrawer` 行点击跳 `ROUTES.projectWbs(row.projectId)`；列表 P0 置顶排序，行显示优先级 Chip / 任务 / 项目名 / 截止日（逾期红·临期黄）/ 状态 / 进度。
- [ ] 进度段与优先级筛选可在抽屉内切换 / 清空；筛选项变化时列表即时更新；空态文案区分「无任务」与「筛选无匹配」。
- [ ] 两个抽屉均右滑 420px（92vw）、关闭 IconButton / 遮罩 / ESC 可关、加载失败可重试。
- [ ] 无任何后端改动（`git diff` 不涉及 `server/**` 与 schema 文件）；`web/src/types/dashboard.ts` 与组件改动符合上表。
- [ ] 全量回归：待我审批入口、审批区块、我的项目区块、健康分布条跳转、逾期柱形 B13 抽屉、周报「去填写」、B14 优先级环图与排序均正常。

### P1 验收

- [ ] MyTasksDrawer 状态下拉 + 关键字搜索可用，筛选后分页复位到第 1 页。
- [ ] 全局抽屉副标题含「涉及 K 个项目」，且明确提示行数含他人任务、可开仅看我对齐卡片数值。
- [ ] 各抽屉空态 / 筛选无匹配文案区分清晰。
- [ ] 逾期、周报两张统计卡 `hint` 文案已更新为行动指引。

---

## 8. 待确认问题清单

1. **全局抽屉范围口径**：受「零后端」约束，全局抽屉只聚合 `dashboard.overdue`（即有**我的**逾期/临期任务）覆盖的项目，并展示这些项目的**全量**逾期/临期任务（含他人，可开「仅看我」）。若某项目只有他人逾期、我没有逾期任务，则该项目不出现在全局抽屉——该口径是否接受？（建议接受，后续如需全公司维度可另起后端聚合。）
2. **卡片数值与抽屉行数差异**：逾期卡数值 = 我负责的逾期数（后端口径 `countOverdue(myTasks)`），抽屉行数可能更大（含他人）——已按 P1-3 加提示文案，是否满足预期？
3. **MyTasksDrawer 数据实时性**：抽屉使用进入时的 `data.myTasks` 快照，不重新拉取、不在抽屉内改状态（编辑跳 WBS 页）。若希望抽屉内行内快捷改状态（P2-1）或打开时刷新，需要加 `api.getWorkbench()` 刷新逻辑，是否本期要做？
4. **进度环「已完成」段**：服务端 `myTasks` 已滤掉 `status==='完成'`，进度环「已完成」段恒为 0，点它打开抽屉显示空态。是否接受？（不影响「在办/未启动」两段主路径。）
5. **里程碑列取舍**：`MyTasksDrawer` 不展示里程碑列（`myTasks` 无 `milestoneName`，避免额外拉取）；若必须展示需按项目补 `listMilestones`，是否必要？
