# B17 全局总览可视化优化 — 简单 PRD

> 文档类型：**简单 PRD（默认模板，不含竞品分析）**
> 作者：产品（许清楚）｜主理人：齐活林
> 项目盘址：`C:/Users/xuwen/WorkBuddy/AstrBytes/pm-app/`
> 技术栈：Vite + React + TS + MUI + Tailwind；图表 `@mui/x-charts` v7；后端 Node(Express) + better-sqlite3（真实 DB）
> 前置：B12（全局总览）、B13/B13.5（逾期下探抽屉）、B14（任务优先级+周报闭环+待办中心）、B15（工作台明细入口）已交付；**本批为 B15/B16 之后首次含小后端增量**（B15/B16 均纯前端）
> 生成日期：2026-08-18

---

## 1. 需求背景与已核实现状（全部基于实际代码，非臆测）

### 1.1 用户原话要点

用户对「全局总览」页（路由 `/metrics`，B12 产物）可视化不满意：

1. 「项目健康分布」用**单行堆叠条形**不合理——一眼看不出占比与风险量级。
2. **任务统计维度报表少**（例如没有按优先级分布），希望补充任务维度报表。

### 1.2 用户已拍板方案（不可改，本 PRD 按此细化）

1. **P0-1 健康分布改环形图**：单行堆叠条 → **环形图**，复用 `DonutChart`，绿/黄/红三段语义色；中心显示风险项目数（= red 或 red+yellow，二选一拍板见待确认 2）；点击段保留筛选下钻 `onDrill(health)`。
2. **P0-2 新增任务优先级分布**：横向条形，P0/P1/P2/P3 四档，配色同 B14（P0 红 / P1 橙 / P2 品牌蓝 / P3 灰）；脏值兜底 P2。
3. **P0-3 新增任务状态分布**：横向条形，待办 / 进行中 / 待评审 / 阻塞 / 完成 5 档。
4. **P0-4 新增逾期时长分段**：横向条形，逾期 1–7 天 / 8–30 天 / >30 天 三段；基于 dueDate 与 today 计算，仅统计未完成任务。
5. **下钻口径**：本期新增 3 图**只展示**（Tooltip 显示数量 / 占比），不做明细抽屉、不做筛选联动。
6. **布局**：图表区 4 图（md 2 列）→ 7 图（md 2 列 / xl 3 列）；原 4 图（状态环 / 健康 / 逾期柱 / 负荷柱）位置与交互不变，新增 3 图补齐。

### 1.3 已核实现状盘点（主理人勘察 + 撰写时逐文件复核）

| 位置 | 现状（代码事实） |
|---|---|
| `web/src/pages/MetricsPage.tsx` | 图表区 4 图（`gridTemplateColumns: { xs:'1fr', md:'repeat(2,1fr)' }`）：`DonutChart`（项目状态分布，`onSegmentClick`→状态筛选）/ `HealthDistBar`（健康分布，`onDrill(health)`→健康筛选）/ `OverdueBarChart`（逾期柱，`onDrill`→B13 抽屉）/ `OwnerLoadBarChart`（负荷柱，`onDrill`→OwnerLoadDrawer）。全部数据来自 `useDashboardOverview()` 的 `GET /api/dashboard/overview`。 |
| `web/src/components/dashboard/DonutChart.tsx` | 通用环形图：`segments[]`（支持逐段 `color`）、`centerValue` / `centerLabel`、`onSegmentClick`（环体 + 图例点击均触发；0 值段进图例不进环体）、`unit`、加载 / 空态。健康环可直接复用。 |
| `web/src/components/dashboard/HealthDistBar.tsx` | 单行堆叠横条（绿/黄/红 3 series + 图例 + 占比文字）。**B11 工作台 `WorkbenchPage` 仍在用（L206，`onDrill={() => navigate(ROUTES.projects)}`）**，总览替换后组件必须保留，只从 MetricsPage 移除引用。 |
| `web/src/components/dashboard/ChartCard.tsx` | `ChartCard` / `ChartLegend` / `CHART_BODY_HEIGHT=216`；新图统一套用，保证等高与加载 / 空态范式。 |
| `web/src/theme/chartPalette.ts` | `useChartPalette()` 唯一取色入口，返回真 hex：`health.green/yellow/red`、`brand`（四档，`brandMain=brand[1]`、`brandStrong=brand[0]`）、`track`、`axis` 等；另导出 `hexAlpha(hex, opacity)` 可生成 8 位 hex 半透明色（SVG 安全）。 |
| `server/services/dashboard.service.js` | `getDashboardOverview(db, query, me)` 已实现：`listScopedItems` → `listScopeLeafTasks(db, projectIds)`（SELECT 全量 `wbs_nodes` 按项目分组后 `leafNodesOf` 判真叶子，**滤掉 `status==='完成'`**，返回在办叶子任务，每行经 `toApiWbsNode` 含 `priority` / `status` / `dueDate`），目前仅用于 `aggregateOverdue` / `aggregateOwnerLoad` / `countOverdueTasks`；**优先级 / 状态 / 逾期时长分布未聚合**。 |
| `server/lib/portfolioAgg.js` | 现有纯函数：`aggregateStatusDonut` / `aggregateHealth` / `aggregateOverdue` / `aggregateOwnerLoad` / `countOverdueTasks` / `averageProgress` / `isOverdue`（内部）/ `compareText`；零框架依赖（仅 require `lib/dates` + `config/enums`），可被 QA 脚本直接 import。 |
| 日期口径 | `server/lib/dates.js` 与 `web/src/utils/date.ts` 逐字一致：逾期 = `diffDays(today, dueDate) < 0`（`portfolioAgg.isOverdue` 内部实现）；`diffDays(a, b) = b - a`（天）。 |
| 优先级枚举（后端） | `server/services/wbs.service.js`：`PRIORITIES=['P0','P1','P2','P3']`、`DEFAULT_PRIORITY='P2'`、`normalizePriority(raw)`（白名单，脏值→P2）；**`server/config/enums.js` 未导出优先级**（该文件只有项目 / 任务状态等枚举）。 |
| 优先级枚举（前端） | `web/src/config/enums.ts`：`PRIORITY_OPTIONS`（P0 红 error / P1 橙 warning / P2 蓝 info / P3 灰 default）、`PRIORITIES`、`PRIORITY_RANK`、`normalizePriority`、`DEFAULT_PRIORITY='P2'`。 |
| 任务状态枚举 | 前端 `TASK_STATUSES=['待办','进行中','待评审','完成','阻塞']`（`web/src/config/enums.ts`）；后端 `server/config/enums.js#TASK_STATUSES` 同值。注意看板列序 `BOARD_COLUMNS=['待办','进行中','阻塞','待评审','完成']` 与任务状态枚举不同，**本图档序按 `TASK_STATUSES`**。 |
| 类型 | `web/src/types/dashboard.ts`：已有 `PriorityDistribution`（`P0/P1/P2/P3/total`，B14 环图数据源）与 `HealthDistribution`（`green/yellow/red/total`）；`DashboardOverview` 目前无优先级 / 状态 / 逾期时长分布字段。 |
| Mock API | `web/src/api/mock/index.ts#getDashboardOverview`（L2574）与服务端**字段逐个对齐**（手工双写），内部同样用 `leafNodesOf(...).filter(n => n.status !== '完成')` 得到在办任务；**需同步补 3 个新字段**，否则前端 mock 模式新图数据为 undefined。 |
| 接口调用 | `web/src/api/http.ts#getDashboardOverview(query): Promise<DashboardOverview>`（L357）复用同一接口，无需改动，仅类型扩展。 |

### 1.4 硬性约束（必须遵守）

- **零 schema 变更、零新依赖、零新路由、不新增接口**：overview 返回体加 3 个字段即可（`priorityDist` / `statusDist` / `overdueDuration`），前端复用同一接口。
- **口径红线**：日期一律走 `server/lib/dates` 与 `web/src/utils/date`（`isOverdue` / `diffDays`），禁止在聚合 / 组件里 `new Date()` 或手撸字符串比较；优先级后端兜底归一（脏值 P2），前端展示走 `normalizePriority` / `PRIORITY_OPTIONS`；任务状态以后端枚举为准。
- **图表层颜色**：一律经 `useChartPalette()` 取真 hex，禁止 import `tokens` / `alphaOf` / `colorOf`；半透明色用 `hexAlpha` 预乘（8 位 hex，SVG 安全）。
- **不动现有可用功能**：B12 总览原 4 图交互、筛选栏、明细表、`OwnerLoadDrawer` / `OverdueTaskDrawer` 全部保留；`HealthDistBar` 组件保留（工作台 B11 在用）；工作台 / B13 / B14 / B15 不受影响。
- **本 PRD 交付物 = 文档**；不改业务代码。

---

## 2. 产品目标

- **G1 一图看懂健康**：健康分布从「单行堆叠条」升级为「环形图」，绿黄红三段一眼可辨，中心大字直给风险量级，点击仍可下钻筛选。
- **G2 任务维度报表补全**：新增优先级 / 状态 / 逾期时长 3 张任务维度分布图，让管理层在总览一屏内看到「积压任务的构成」。
- **G3 小后端增量最小化**：不新增接口 / 路由 / schema，仅 overview 加 3 字段 + 3 个聚合纯函数；前端复用既有 `ChartCard` / `DonutChart` / 取色规范，回归面最小。

---

## 3. 用户故事

- **US-1｜健康一眼懂**：作为管理层，我希望健康分布是环形图且中心直接显示需关注项目数，以便不用看堆叠条就能判断「多少项目亮红灯 / 预警」。
- **US-2｜积压构成可见**：作为 PMO，我希望看到范围内任务按优先级、按状态、按逾期时长的分布，以便判断「积压是卡在 P0 还是普遍待评审、逾期是否已经烂尾」。
- **US-3｜口径不打架**：作为用户，我希望每张新图的副标题写清口径（在办 / 含已完成 / 已逾期），以便不同图的总数对不上时不困惑。
- **US-4｜不破坏既有路径**：作为项目经理，我希望原有 4 图的位置与交互（筛选下钻、抽屉）保持不变，以便升级后依然用熟悉的路径定位问题。

---

## 4. 功能点清单（全量，不省略条目）

### P0（必做 · 用户拍板方案全覆盖）

| 编号 | 功能点 | 技术点（行内一句话） |
|---|---|---|
| P0-1 | 健康分布改环形图（新建 `HealthDonut`） | 新建 `web/src/components/dashboard/HealthDonut.tsx` 薄封装（props `{ dist: HealthDistribution; loading?: boolean; onDrill?: (health: Health) => void }`），内部映射绿/黄/红三段（`palette.health.green/yellow/red`，label 正常 / 预警 / 风险）复用到 `DonutChart`；`centerValue` = red + yellow（推荐，拍板见待确认 2）、`centerLabel`「需关注项目」；`onSegmentClick` 透传 `onDrill(seg.id as Health)`（环体 + 图例 0 值段均可点）；`empty={dist.total===0}` 空态「当前范围暂无在办项目 / 切换范围或调整筛选条件试试」；在 `components/dashboard/index.ts` barrel 导出。 |
| P0-2 | 任务优先级分布横向条形（只展示） | 由通用 `CategoryBarChart`（P0-5）承载；数据源 `data.priorityDist`，4 档按 `PRIORITIES` 序（P0→P3），label 取 `PRIORITY_OPTIONS[].label`（P0 最高 / P1 高 / P2 中 / P3 低），配色同 B14：P0 `palette.health.red` / P1 `palette.health.yellow` / P2 `palette.brandMain` / P3 `palette.track`；副标题 `共 N 个未完成任务`（N=`total`）；空态「暂无进行中的任务 / 没有需要按优先级排期的任务」；无下钻。 |
| P0-3 | 任务状态分布横向条形（只展示） | `CategoryBarChart` 承载；5 档按 `TASK_STATUSES` 序（待办 / 进行中 / 待评审 / 阻塞 / 完成），配色建议 待办 `palette.track` / 进行中 `palette.brand[1]` / 待评审 `palette.health.yellow` / 阻塞 `palette.health.red` / 完成 `palette.health.green`；**口径 = 范围内全部叶子任务（含已完成，推荐）**，后端聚合输入为「全量叶子任务」数组（见 P0-7），副标题 `共 N 个任务（含已完成）`；若拍板改「在办」口径则完成档恒 0、副标题注明（见待确认 1）；空态「当前范围暂无任务」。 |
| P0-4 | 逾期时长分段横向条形（只展示） | `CategoryBarChart` 承载；3 段按严重度序「逾期 1–7 天 / 逾期 8–30 天 / 逾期 >30 天」，配色红系递进（`hexAlpha(palette.health.red, 0.5)` / `hexAlpha(palette.health.red, 0.75)` / `palette.health.red`）；**口径：仅在办叶子任务中 `isOverdue`（`diffDays(today, dueDate) < 0`）者**，天数 `days = diffDays(dueDate, today)`，分段 `1 ≤ days ≤ 7` / `8 ≤ days ≤ 30` / `days ≥ 31`（dueDate 为空或未逾期不计）；副标题 `共 N 个逾期任务`（N = 三段之和 = `countOverdueTasks`，与顶部「逾期任务」卡一致）；空态「太好了，没有逾期任务 🎉 / 所有任务都在计划节奏内」。 |
| P0-5 | 新建通用 `CategoryBarChart` 组件 | 新建 `web/src/components/dashboard/CategoryBarChart.tsx`：props `{ title; subtitle?; rows: Array<{ key: string; label: string; value: number; color: string }>; loading?; empty?; emptyTitle?; emptyDescription?; unit? }`；内部 `ChartCard` + 横向 `BarChart`（y 轴 band = `rows[].label`，x 轴数量），**每档一个 series、`data` 仅对应档位索引有值、其余 `null`**（`BarSeriesType.data` 为 `(number|null)[]` 且单 series 只有单一 `color`，故用掩码多 series 实现逐档着色）；`valueFormatter` 显示 `N 个 · P%`（P = round(N/Σ)*100）；footer 用 `ChartLegend` 显示各档数量（0 值档也显示）；空态不画坐标轴；不提供下钻回调。 |
| P0-6 | 布局 4 图 → 7 图（md 2 列 / xl 3 列） | `MetricsPage` 图表区 `gridTemplateColumns` 改为 `{ xs:'1fr', md:'repeat(2,1fr)', xl:'repeat(3,1fr)' }`；顺序 状态环 → 健康环 → 逾期柱 → 负荷柱 → 优先级 → 状态 → 逾期时长；原 4 图相对顺序与交互不变（健康图替换为 `HealthDonut`，其余 3 图 props 不动），新增 3 图追加在末尾。 |
| P0-7 | 后端聚合：3 个纯函数 + overview 3 字段 | `server/lib/portfolioAgg.js` 新增并 export：`aggregatePriorityDist(tasks)`（`P0–P3` 白名单归一、脏值记 P2，规则与 `wbs.service.normalizePriority` 一致，聚合层内联实现以保持零框架依赖；返回 `{P0,P1,P2,P3,total}`）、`aggregateStatusDist(allLeafTasks)`（按 `enums.TASK_STATUSES` 五档计数，脏状态不计入；返回 `{待办,进行中,待评审,阻塞,完成,total}`，total=五档之和）、`aggregateOverdueDuration(tasks, todayStr)`（仅 `isOverdue` 者按 `diffDays(dueDate, today)` 分段；返回 `{days1to7,days8to30,daysOver30,total}`）；`dashboard.service.getDashboardOverview` 计算并返回 `priorityDist` / `statusDist` / `overdueDuration` 三字段（`statusDist` 输入为**全量叶子任务（含已完成）**，实现上在 `listScopeLeafTasks` 已 SELECT 的全量 `wbs_nodes` 里保留完成叶子，零额外 SQL；若拍板在办口径则直接复用现有 `tasks`）。 |
| P0-8 | 前端类型扩展 + mock 同步双写 | `web/src/types/dashboard.ts`：新增 `TaskStatusDistribution`（`待办/进行中/待评审/阻塞/完成` + `total`）与 `OverdueDurationDistribution`（`days1to7/days8to30/daysOver30` + `total`）；`DashboardOverview` 追加 `priorityDist: PriorityDistribution`（复用既有类型）/ `statusDist` / `overdueDuration`；`web/src/api/mock/index.ts#getDashboardOverview` 同步从 `db.wbsNodes` 聚合计算并返回 3 字段（口径对齐服务端），避免 mock 模式缺字段。 |

### P1（重要 · 增强体验，不阻塞核心方案）

| 编号 | 功能点 | 技术点（行内一句话） |
|---|---|---|
| P1-1 | 新 3 图空态文案区分 | `CategoryBarChart` 的 `emptyTitle/emptyDescription` 由各图传入：优先级「暂无进行中的任务」、状态「当前范围暂无任务」、逾期时长「太好了，没有逾期任务 🎉」，避免统一「暂无数据」的无信息空态。 |
| P1-2 | 健康环副标题口径标注 | `HealthDonut` subtitle 恒为 `${dist.total} 个在办项目`（沿用 HealthDistBar 文案），与中心「需关注项目」数值（red+yellow）区分开，防止用户把两个数混为一谈。 |
| P1-3 | 优先级分布图例与 tooltip 同源同值 | 图例数量取 `PRIORITY_OPTIONS[].label` + 数值（如「P0 最高 3」），tooltip 显示 `N 个 · P%`，两处数字同源同值，QA 可断言。 |

### P2（可选 · 本期不做，列入 backlog）

| 编号 | 功能点 | 说明 |
|---|---|---|
| P2-1 | 新 3 图下钻 | 优先级分布点某档 → 打开任务明细（参考 B15 `MyTasksDrawer` 模式，需新增后端按优先级 / 状态 / 逾期时长的任务列表能力）；本期按已拍板「只展示」不做。 |
| P2-2 | 健康环中心值切换 | 若拍板中心只显示 red（与顶部「红灯项目」卡同口径），`HealthDonut` 只需改 `centerValue` / `centerLabel`，组件与配色不动。 |

---

## 5. UI 设计稿（文字描述）

### 5.1 图表区总布局（7 图）

- 栅格：`xs:1fr（单列堆叠）→ md:2 列 → xl:3 列`；全部 `ChartCard` 等高（`CHART_BODY_HEIGHT=216`）。
- 顺序：① 项目状态分布（品牌色环，不动）② 项目健康度分布（新健康环，绿黄红）③ 逾期 / 临期任务（逾期柱，不动）④ 负责人负荷（负荷柱，不动）⑤ 任务优先级分布（新条形）⑥ 任务状态分布（新条形）⑦ 逾期时长分段（新条形）。
- 交互：① 点击段 → 状态筛选（不动）；② 点击段 / 图例 → 健康度筛选（沿用现有 `onDrill` 行为）；③ 点击柱 → B13 逾期抽屉（不动）；④ 点击柱 → OwnerLoadDrawer（不动）；⑤⑥⑦ 无点击交互（仅 tooltip 显示数量 / 占比）。
- 说明：md 2 列下前两行与原 4 图逐格一致；xl 3 列下整体重排但顺序保持。

### 5.2 健康度分布环形图（②）

- 环形三段：正常（绿）/ 预警（黄）/ 风险（红），图例显示三档数量（0 值档也显示，`DonutChart` 默认行为）。
- 中心大字：`red + yellow`（需关注项目数，拍板见待确认 2），中心小字「需关注项目」；中心色：有 red 用 `health.red`，仅 yellow 用 `health.yellow`，全绿用 `brandStrong`。
- 副标题：`{total} 个在办项目`。
- 与左侧「项目状态分布」品牌色环并排时，绿黄红语义色与品牌青蓝形成明确区分，视觉可辨。

### 5.3 任务优先级分布（⑤）

- 横向条形 4 档（自上而下 P0 → P3）：P0 红 / P1 橙 / P2 品牌蓝 / P3 灰。
- 副标题：`共 N 个未完成任务`；图例：`P0 最高 3` 等；tooltip：`N 个 · P%`。

### 5.4 任务状态分布（⑥）

- 横向条形 5 档（待办 / 进行中 / 待评审 / 阻塞 / 完成）：待办灰 / 进行中品牌蓝 / 待评审黄 / 阻塞红 / 完成绿。
- 副标题：`共 N 个任务（含已完成）`（若拍板在办口径则改为 `共 N 个在办任务` 并注明不含已完成）。

### 5.5 逾期时长分段（⑦）

- 横向条形 3 段（逾期 1–7 天 / 8–30 天 / >30 天），红系递进（浅红 → 中红 → 深红）。
- 副标题：`共 N 个逾期任务`；tooltip：`N 个 · P%`。

---

## 6. 关键技术点（全量，行内一句话）

- **零新接口 / 路由 / schema**：仅 `GET /api/dashboard/overview` 返回体加 `priorityDist` / `statusDist` / `overdueDuration` 3 字段，前端 `http.ts` 复用同一调用。
- **状态分布「含已完成」输入**：`listScopeLeafTasks` 目前滤掉 `status==='完成'`；为让「完成」档展示真实数值，后端在 `getDashboardOverview` 内保留「全量叶子任务」数组（`wbs_nodes` 已全量 SELECT，零额外 SQL），`aggregateStatusDist` 以它为输入；若拍板在办口径则回退用现有 `tasks` 数组，图表与类型不动。
- **BarChart 逐档着色**：`BarSeriesType.data` 为 `(number|null)[]` 且单 series 只有单一 `color`；`CategoryBarChart` 用「每档一个 series，`data` 仅对应档位索引有值、其余 `null`」的掩码模式实现逐档颜色。
- **取色守恒**：所有新图颜色经 `useChartPalette()` 取真 hex；半透明用 `hexAlpha`（`#RRGGBBAA`，SVG 安全）；禁止 import `tokens` / `alphaOf` / `colorOf`。
- **口径一致**：优先级归一后端内联 `P0–P3` 白名单（脏值 P2）且前端展示走 `normalizePriority` / `PRIORITY_OPTIONS`；逾期 = `diffDays(today, dueDate) < 0`（`server/lib/dates` + `web/src/utils/date`）；`overdueDuration.total` 必须等于 `countOverdueTasks`（QA 可断言）。
- **组件复用**：健康环复用 `DonutChart`（薄封装 `HealthDonut`）；新 3 图共用 `CategoryBarChart` + `ChartCard` / `ChartLegend`；不新造图表库。
- **回归红线**：`HealthDistBar` 组件保留（`WorkbenchPage` L206 仍用），仅从 `MetricsPage` 移除引用；总览原 4 图 props / 交互、筛选栏、明细表、两个抽屉不动；工作台 / B13 / B14 / B15 不受影响。
- **mock 双写**：`web/src/api/mock/index.ts#getDashboardOverview` 手工对齐服务端字段，需同步补 3 字段，否则 mock 模式新图数据为 undefined。

---

## 7. 验收标准（可勾选）

### P0 验收

- [ ] 总览图表区出现 7 图，栅格 `xs 1 列 / md 2 列 / xl 3 列`；顺序为 状态环 → 健康环 → 逾期柱 → 负荷柱 → 优先级 → 状态 → 逾期时长。
- [ ] 健康分布为环形图（绿 / 黄 / 红三段语义色），中心显示需关注项目数（red+yellow；若拍板仅 red 则以拍板值为准）与「需关注项目」小字；点击环段或图例可切换健康度筛选（行为与 B12 一致），再点一次取消。
- [ ] 原 4 图中状态环点击筛选、逾期柱点击打开 B13 抽屉、负荷柱点击打开 OwnerLoadDrawer、筛选栏与明细表全部行为不变。
- [ ] 任务优先级分布：4 档横向条形，配色 P0 红 / P1 橙 / P2 品牌蓝 / P3 灰；脏优先级（如 'P9' / 空）计入 P2 档；副标题「共 N 个未完成任务」。
- [ ] 任务状态分布：5 档横向条形（待办 / 进行中 / 待评审 / 阻塞 / 完成），完成档展示范围内已完成叶子任务的真实数值（若拍板在办口径则完成档恒 0 且副标题标注口径）。
- [ ] 逾期时长分段：3 段（逾期 1–7 天 / 8–30 天 / >30 天），仅未完成任务、基于 dueDate 与 today 计算；三段之和 = 顶部「逾期任务」卡数值。
- [ ] 新增 3 图 tooltip 均显示数量与占比（`N 个 · P%`），无任何点击下钻 / 抽屉 / 筛选联动。
- [ ] 各新图空态 / 加载态走 `ChartCard` 骨架与正向文案（如「太好了，没有逾期任务 🎉」），空数据不画坐标轴。
- [ ] 无 schema 变更、无新依赖、无新路由、无新接口（`git diff` 仅涉及 `server/lib/portfolioAgg.js`、`server/services/dashboard.service.js`、`web/src/types/dashboard.ts`、`web/src/api/mock/index.ts`、`MetricsPage`、dashboard 组件目录与 barrel）；overview 返回体仅新增 3 字段。
- [ ] mock 模式（无后端）下总览页 7 图均有数据，不出现 undefined 空图。
- [ ] 工作台（/workbench）健康分布条 `HealthDistBar` 渲染与交互不变；B13 / B14 / B15 全部回归正常。

### P1 验收

- [ ] 健康环副标题显示「{total} 个在办项目」，与中心「需关注项目」数值口径可区分。
- [ ] 三张新图图例数量与 tooltip 占比同源同值；空态文案各自区分。
- [ ] 新图均等高（`CHART_BODY_HEIGHT=216`），加载时显示骨架，样式与既有 4 图一致。

---

## 8. 待确认问题清单

1. **状态分布是否含「已完成」**：按「5 档含完成」的字面需求，本 PRD 主方案为统计**范围内全部叶子任务（含已完成）**，后端仅需在 `getDashboardOverview` 内保留已 SELECT 的完成叶子任务（零额外 SQL、零 schema 变更）；备选为沿用现有「在办叶子任务」（完成档恒 0，副标题注明）。请拍板。
2. **健康环中心值**：`red + yellow`（需关注项目数，推荐，信息量大于顶部「红灯项目」卡）还是仅 `red`（与顶部红灯卡同口径）？请拍板，组件只需改 `centerValue` / `centerLabel`。
3. **优先级分布分母口径**：优先级分布按「在办叶子任务」（推荐，与 B14 工作台优先级环一致，不含已完成）还是全部叶子任务？本 PRD 按在办编写。
4. **状态分布各档配色**：本 PRD 建议 待办灰 / 进行中品牌蓝 / 待评审黄 / 阻塞红 / 完成绿（语义与 `StatusChip` 一致）；若希望统一品牌色阶或其它方案请指出，默认按建议执行。
5. **7 图顺序**：新增 3 图追加在原有 4 图之后（位置 5 / 6 / 7）；若希望插入其它位置（如优先级靠前）请指出，默认按追加顺序执行。
