# B12 全局仪表盘 / 多项目总览 — 简单 PRD

> 文档类型：**简单 PRD（默认模板，不含竞品分析）**
> 作者：产品（许清楚）｜主理人：齐活林
> 项目盘址：`C:/Users/xuwen/WorkBuddy/AstrBytes/pm-app/`
> 技术栈：Vite + React + TS + MUI + Tailwind；图表 `@mui/x-charts` v7；后端 Node(Express) + better-sqlite3（真实 DB）；RBAC 服务端强制
> 前置：B1–B11 已全部通过 QA 验收
> 生成日期：2026-08-10

---

## 0. 现状盘点（先读代码再动笔的结论）

### 0.1 B11 已落地、B12 必须复用而非重写

| 资产 | 位置 | B12 复用方式 |
|---|---|---|
| `ChartCard` 图表外壳 | `web/src/components/dashboard/ChartCard.tsx` | 直接复用，已内置 `loading` 骨架 / `empty` 空态 / 固定绘图高 `CHART_BODY_HEIGHT=216`，保证多图等高 |
| `ChartLegend` 图例 | 同上（同文件导出） | 直接复用，支持 `onClick` 下钻 |
| `ProgressDonut` 进度环 | `web/src/components/dashboard/ProgressDonut.tsx` | **需泛化**：现 props 写死 `TaskProgressSummary` 三段（已完成/在办/未启动）+ 中心「总完成度」文案，多项目场景要复用其视觉但换语义 |
| `OverdueBarChart` 逾期柱状 | `web/src/components/dashboard/OverdueBarChart.tsx` | **几乎零改动可用**：它本来就是「按项目分组 × 逾期/临期两序列」的横向柱状，天生适配多项目，只需把 `maxRows` 默认 5 放大 |
| `HealthDistBar` 健康分布 | `web/src/components/dashboard/HealthDistBar.tsx` | **零改动可用**：换数据源即可，`onDrill(health)` 回调现成，下钻到项目列表带健康度筛选 |
| `useChartPalette()` 取色 | `web/src/theme/chartPalette.ts` | 唯一取色入口，返回真 hex（`brand` 四档色阶 / `health` 绿黄红 / `axis` / `grid` / `track`） |
| 聚合纯函数范式 | `web/src/utils/dashboardAgg.ts` | 零 React 依赖、无副作用、可被 QA 脚本直接 import 断言 —— B12 新增聚合沿用同一规格 |
| 日期口径 | `web/src/utils/date.ts` + `server/lib/dates.js` | 逾期 = `diffDays(today(), dueDate) < 0`；临期 = 非逾期且 `<= 3` 天（常量 `DUE_SOON_DAYS`），前后端逐字一致 |
| `DataTable` 表格 | `web/src/components/common/DataTable.tsx` | 项目明细表直接复用，不新造表格 |
| `HealthDot` / `StatusChip` / `ProgressBar` / `StatCard` / `UserAvatar` | `web/src/components/common/` | 项目行内的健康点、状态标签、进度条、统计卡、头像全部复用 |
| `groupByOwner()` 负责人分组 | `web/src/utils/board.ts` | 返回 `OwnerLane{owner, ownerName, cards, overdueCount}`，排序心智为「逾期数 ↓ → 任务数 ↓ → 姓名 ↑，未分配恒最后」，负责人负荷图沿用同一排序 |

### 0.2 后端现有数据能力

| 能力 | 位置 | 说明 |
|---|---|---|
| `GET /api/workbench` | `server/routes/workbench.routes.js` | 返回 `{stats, myProjects, myTasks, myApprovals, reportReminders}`，**纯个人视角** |
| `listMyTasks` | `server/services/workbench.service.js` | 只返回「我参与项目 ∩ 我是 owner ∩ status≠完成 ∩ 真叶子 ∩ 项目非已结项/已终止」的节点，B11 已追加 `projectName` 字段 |
| `listReportReminders` | 同上 | 「我参与且状态=进行中」的项目，每项目一行，`filled` = 本周存在 `work_reports.status='已提交'` |
| `listProjects(db, query, me)` | `server/services/project.service.js` | **全库项目分页查询**，已支持 `keyword/type/status/health/onlyMine/pm` 过滤，`MAX_PAGE_SIZE=200` |
| `loadListContext` | 同上 | 批量预加载 PM 姓名 / 里程碑 / 质量门，**已解决 N+1**，B12 服务端聚合直接复用这个函数 |
| `toListItem` | 同上 | 项目行 → `ProjectListItem`，含 `pmName / nextMilestoneCode / gatePassed / gateTotal / progress / milestoneDone / milestoneTotal / health / highRiskCount` |
| 健康度计算 | `server/lib/rules.js#computeHealth` | 红 = 存在未达成且已逾期的里程碑；黄 = 7 天内到期 或 有门待检；否则绿。由 `milestone.service` 回写 `projects.health` 字段 |
| 工时数据 | `GET /projects/:id/effort-report`（B9） | **单项目**接口，`EffortSummary` 含 `estimateTotal / actualTotal / diffRate / overrunCount`，`effortHours` 来自工作日志累计（单位人日） |
| 权限矩阵 | `server/config/permissions.js` | 与 `web/src/config/permissions.ts` **手工双写**，`scripts/smoke_b3.mjs` 断言两端 key 集合相等 |

### 0.3 B12 与 B11 的三条硬差异（架构选型的关键依据）

1. **数据面不同 → B11「纯前端聚合」的结论在 B12 不成立**。B11 决策不新增 `/api/dashboard`，理由是三张图的原子数据已全在 `GET /api/workbench` 里。B12 要看全公司，而 `myProjects` 只给「我参与的」、`myTasks` 只给「我负责的」，前端拿不到别人的任务；若靠前端循环调用单项目接口拼装，等于把 N+1 搬到浏览器。**B12 必须新增服务端聚合接口**。
2. **`progress` 存在两套口径，必须显式选一套**。`ProjectListItem.progress` = 里程碑达成率（`milestoneDone / milestoneTotal`，已结项恒 100），项目详情页用的是 WBS 加权完成度，两者对同一项目会给出不同百分比。多项目总览一旦展示「整体进度」，口径不说清就会被质疑数据错。
3. **`highRiskCount` 当前恒为 0**。`project.service.js#toListItem` 里有明确 TODO：risks 表尚未接入。因此本期「风险项目」只能用 `health === 'red'` 表达，不能用这个字段。

---

## 1. 产品目标

1. **给管理层一屏定论**：不进任何单个项目，就能回答「公司现在有多少在管项目、几个亮红灯、总共积压多少逾期任务」，把决策前的信息收集时间从「逐个项目点开」压到一屏。
2. **给 PMO 一个可排序的抓手**：把散落在各项目里的健康度、逾期量、周报填报情况汇总成可排序、可筛选、可下钻的清单，让 PMO 每周例会前能直接点名到具体项目和具体人。
3. **给项目经理一个横向坐标系**：PM 现在只能看自己的项目，缺少「我这个项目在公司里排第几、我的人是不是被别的项目抽走了」的横向对照，B12 提供跨项目负荷视角。
4. **不破坏 B11 已验收的成果**：工作台（`/workbench`）保持个人视角不动，全局总览是**新页面**；图表组件、聚合函数、配色规范、日期口径全部沿用 B11 既有约束，新增能力以增量方式叠加。

---

## 2. 用户故事

### 2.1 管理层（global role = `management`）

- **US-MGT-1｜一屏看盘**：作为管理层，我希望打开「全局总览」就看到在管项目数、红灯项目数、逾期任务总数、整体进度四个数字，以便在周会开场 30 秒内掌握全局态势。
  - *验收*：页面顶部 4 张 `StatCard`，数据来自服务端聚合接口，首屏无需任何筛选操作即有数值。
- **US-MGT-2｜先看坏消息**：作为管理层，我希望红灯（`health='red'`）和逾期最多的项目排在最前面，而不是按创建时间排，以便注意力自动落到出问题的地方。
  - *验收*：健康度分布图 + 逾期 Top N 柱状图默认按「风险优先」排序；项目明细表默认排序为「健康度 红→黄→绿，同档内逾期任务数降序」。
- **US-MGT-3｜点进去看细节**：作为管理层，我希望点击某个红灯项目能直接跳到该项目概览页，不用回到项目列表再搜一遍。
  - *验收*：图表色段、图例、明细表行均可点击下钻，跳转到 `ROUTES.projectOverview(id)`。

### 2.2 PMO（global role = `pmo`）

- **US-PMO-1｜按维度切分**：作为 PMO，我希望能按项目类型（A/B/C）、项目状态、健康度筛选总览，以便单独审视「A 类大项目」这一组的整体健康度。
  - *验收*：总览页顶部有筛选栏，筛选后所有图表与明细表同步刷新；筛选条件复用后端 `listProjects` 已支持的 `type / status / health / keyword` 参数，不新造查询语义。
- **US-PMO-2｜盯周报填报**：作为 PMO，我希望看到本周全公司的周报填报率以及未填报的项目清单，以便周五下午定向催办。
  - *验收*：总览含「本周周报填报率」统计（已提交项目数 / 应填报项目数），可展开未填清单，口径与 `workbench.service.js#listReportReminders` 一致（项目级，任一成员提交即算，草稿不计）。
- **US-PMO-3｜看谁扛不住**：作为 PMO，我希望看到负责人负荷排行（谁手上在办任务最多、谁逾期最多），以便在资源协调会上有据可依。
  - *验收*：负责人负荷图展示 Top N 负责人的在办任务数与逾期任务数，排序沿用 `groupByOwner` 的「逾期数 ↓ → 任务数 ↓ → 姓名 ↑」心智。

### 2.3 项目经理（project role = `pm`）

- **US-PM-1｜横向比一比**：作为 PM，我希望在总览里看到我负责的项目在全公司项目中的健康度与进度位置，以便判断自己是不是拖了后腿。
  - *验收*：明细表支持「只看我参与的」开关，复用后端已有的 `onlyMine` 参数；开关切换时图表同步重算。
- **US-PM-2｜查我的人被谁占了**：作为 PM，我希望在负责人负荷图里点开某个成员，看到他在其他项目上还背了多少任务，以便解释「为什么我的任务一直不推进」。
  - *验收*：负责人负荷条可下钻，展示该成员跨项目的任务分布（项目名 + 在办数 + 逾期数）。
- **US-PM-3｜不看归档噪音**：作为 PM，我希望已结项 / 已终止的项目默认不混进总览统计，以免历史项目把逾期数字撑大。
  - *验收*：默认统计范围排除 `已结项 / 已终止`（与 `listMyTasks` 现有过滤口径一致），可通过筛选器手动打开。

---

## 3. 需求池

> 优先级定义：**P0 = 没有它这个页面不成立**；**P1 = 有它才好用**；**P2 = 锦上添花 / 下一期**。
> 全量列出，不省略。技术点直接写在同一行。

### P0（本期必须）

| 编号 | 优先级 | 需求 | 核心点（一句话） |
|---|---|---|---|
| B12-P0-1 | P0 | 新增服务端聚合接口 | 新建 `server/services/dashboard.service.js` + `server/routes/dashboard.routes.js`，提供 `GET /api/dashboard/overview`，一次返回全部总览数据，内部复用 `project.service.loadListContext` 批量取里程碑与门以避免 N+1。 |
| B12-P0-2 | P0 | 新增全局总览页面 | 落在已存在但为占位页的 `web/src/pages/MetricsPage.tsx`（路由 `/metrics`、菜单项「度量看板」已在 `MAIN_MENU` 中且标记 `phase: 'P1'`），改造为真实页面并去掉占位标记。 |
| B12-P0-3 | P0 | 顶部四张核心统计卡 | 复用 `StatCard`：在管项目数、红灯项目数、逾期任务总数、本周周报填报率；`tone` 按阈值切 `brand / warning / danger / success`。 |
| B12-P0-4 | P0 | 项目健康度分布图 | 直接复用 `HealthDistBar`，数据源从「我的在办项目」换成「筛选范围内全部项目」，`onDrill(health)` 跳 `ROUTES.projects` 并带上 health 查询参数。 |
| B12-P0-5 | P0 | 逾期 / 临期 Top N 项目图 | 直接复用 `OverdueBarChart`，`rows` 换成服务端返回的全局 `OverdueByProject[]`，`maxRows` 从默认 5 提到 8（超出部分在明细表看）。 |
| B12-P0-6 | P0 | 项目状态分布环 | 按 `PROJECT_STATUSES` 八态聚合成环形图，复用 `ProgressDonut` 的视觉但需泛化组件（见 B12-P0-11），中心大字改为「在管项目总数」。 |
| B12-P0-7 | P0 | 项目明细表 + 行内下钻 | 复用 `DataTable`，列 = 项目名 / 类型 / 状态 / 健康度（`HealthDot`）/ PM / 进度（`ProgressBar`）/ 下一里程碑 / 已过门 N-M / 逾期任务数；整行可点，跳 `ROUTES.projectOverview(id)`。 |
| B12-P0-8 | P0 | 统计范围默认排除归档 | 默认不统计 `已结项 / 已终止` 项目，与 `workbench.service.js#listMyTasks` 的现有过滤保持同一口径，避免同一份数据在两个页面给出两个数字。 |
| B12-P0-9 | P0 | 新增 RBAC 权限项 | 在 `server/config/permissions.js` 新增 `dashboard:global`，并**同步双写** `web/src/config/permissions.ts`（两端 key 集合有 smoke 断言，漏一边会红）；菜单项 `metrics` 加 `roles` 限制。 |
| B12-P0-10 | P0 | 聚合逻辑纯函数化 | 服务端聚合算法抽成 `server/lib/` 下的无 DB 依赖纯函数，或前端侧新建 `web/src/utils/portfolioAgg.ts`，沿用 `dashboardAgg.ts` 的规格（零 React 依赖、无副作用、可被 QA 脚本 import 断言）。 |
| B12-P0-11 | P0 | 泛化 `ProgressDonut` | 现组件 props 写死 `TaskProgressSummary` 且中心文案固定「总完成度」，需抽出通用 `DonutChart`（接收 `segments[] + centerValue + centerLabel`），`ProgressDonut` 改为它的薄封装，**保证 B11 工作台调用方零改动**。 |
| B12-P0-12 | P0 | 图表取色守恒 | 新增图表一律用 `useChartPalette()` 取真 hex，禁止 import `tokens / alphaOf / colorOf`（CSS 变量与 `color-mix()` 写进 SVG presentation attribute 不会被解析，图表会黑屏）。 |
| B12-P0-13 | P0 | 空态与加载态 | 全部图表包在 `ChartCard` 内，复用其 `loading` 骨架与 `empty` 空态；无数据时不画空坐标轴。 |
| B12-P0-14 | P0 | 「整体进度」口径显式标注 | 总览采用里程碑达成率口径（沿用 `ProjectListItem.progress`），卡片副标题明写「按里程碑达成率」，避免与项目详情页的 WBS 加权口径混淆被判为数据错。 |

### P1（本期应包含）

| 编号 | 优先级 | 需求 | 核心点（一句话） |
|---|---|---|---|
| B12-P1-1 | P1 | 全局筛选栏 | 项目类型（A/B/C）+ 项目状态 + 健康度 + 关键字 + 「只看我参与的」开关，参数直通后端 `listProjects` 已支持的 `type / status / health / keyword / onlyMine`，不新造查询语义。 |
| B12-P1-2 | P1 | 负责人负荷图 | 新增 `OwnerLoadBarChart`（横向柱状，两序列：在办任务数 / 其中逾期数），结构照抄 `OverdueBarChart`，排序沿用 `groupByOwner` 的「逾期数 ↓ → 任务数 ↓ → 姓名 ↑，未分配恒最后」。 |
| B12-P1-3 | P1 | 时间范围筛选 | 顶部提供「近 30 天 / 本季度 / 全部」快捷切换，服务端按 `plan_start / plan_end` 与项目区间做交叠判定，日期计算统一走 `server/lib/dates.js`。 |
| B12-P1-4 | P1 | 未填周报清单可展开 | 周报填报率卡片可展开为清单，列出未提交项目名 + PM，每行可跳 `ROUTES.projectReports(projectId)`。 |
| B12-P1-5 | P1 | 明细表排序与分页 | 明细表支持按健康度 / 进度 / 逾期任务数 / 下一里程碑日期排序；项目数超过 `MAX_PAGE_SIZE=200` 时走分页，不一次性拉全量。 |
| B12-P1-6 | P1 | 负责人下钻抽屉 | 点击负责人条，右侧抽屉展示该成员跨项目任务分布（项目名 + 在办数 + 逾期数 + 最近截止日）。 |
| B12-P1-7 | P1 | 手动刷新 + 数据时间戳 | 页头「刷新」按钮 + 「数据截至 HH:mm」文案，让管理层知道看的是不是实时数（工作台已有同款刷新按钮，样式对齐）。 |
| B12-P1-8 | P1 | 响应式布局 | 图表区栅格 `xs:1fr / md:repeat(2,1fr) / lg:repeat(3,1fr)`；明细表在窄屏横向滚动，不做卡片化重排。 |
| B12-P1-9 | P1 | 无权限降级 | 无 `dashboard:global` 权限的用户不显示菜单入口，直接访问 `/metrics` 时降级为「仅统计我参与的项目」而非报错白屏。 |

### P2（下一期 / 锦上添花）

| 编号 | 优先级 | 需求 | 核心点（一句话） |
|---|---|---|---|
| B12-P2-1 | P2 | 趋势折线图 | 逾期任务数 / 健康度红灯数按周的历史趋势，需要新建快照表（现有 schema 只存当前态，查不到历史）。 |
| B12-P2-2 | P2 | 工时超支总览 | 跨项目汇总估算 vs 实际工时偏差，需把 B9 的单项目 `GET /projects/:id/effort-report` 扩成批量聚合。 |
| B12-P2-3 | P2 | 风险清单聚合 | 待 risks 表落地后接入，替换当前恒为 0 的 `ProjectListItem.highRiskCount`。 |
| B12-P2-4 | P2 | 评审 / 变更积压统计 | 全公司审批中评审数、待处理变更单数，数据源为 `reviews` / `changes` 表。 |
| B12-P2-5 | P2 | 里程碑甘特总览 | 多项目里程碑在同一时间轴上并排展示，识别资源撞车。 |
| B12-P2-6 | P2 | 导出与订阅 | 总览导出 PNG / PDF，或每周一自动推送摘要。 |
| B12-P2-7 | P2 | 自定义看板 | 用户可自选图表卡片与排列顺序，配置落库到用户偏好表。 |
| B12-P2-8 | P2 | 聚合结果缓存 | 项目数量上量后，服务端加短 TTL 缓存或物化视图，避免每次请求全表扫描。 |

---

## 4. UI 设计要点

### 4.1 导航入口

- **落点：复用已存在的 `/metrics` 路由与「度量看板」菜单项**。`web/src/config/routes.ts` 里 `metrics: '/metrics'` 与 `MAIN_MENU` 中的 `{ key: 'metrics', label: '度量看板', icon: 'metrics', phase: 'P1' }` 都已就位，`MetricsPage.tsx` 目前是纯占位页（4 张「—」统计卡 + 一句「P1 阶段接入」）。B12 直接把它填实，去掉 `phase: 'P1'` 标记。
- **不新建路由的理由**：菜单位、图标、路由常量、页面骨架全部现成，新建 `/portfolio` 等于把同一个概念拆成两个入口，还要额外处理旧菜单项的下线。
- **菜单可见性**：给 `metrics` 菜单项补 `roles`（候选 `['admin', 'pmo', 'management']`，是否放开给 `pm` 见待确认 6）；`mobile` 保持不开启，移动端底部 Tab 不放总览。
- **页面标题**：建议从「度量看板」改为「全局总览」，与「我的工作台」形成个人 / 公司两级心智对照（需拍板，见待确认 5）。

### 4.2 页面结构（自上而下五层）

```
┌─ PageHeader ──────────────────────────────────────────┐
│  全局总览   副标题：{日期} · 全公司 N 个在管项目      │
│                                    [刷新] 数据截至 HH:mm │
├─ 筛选栏（P1-1，一行 Chip / Select）──────────────────┤
│  类型 A|B|C   状态   健康度   时间范围   [只看我参与的] │
├─ 统计卡区（4 列，复用 StatCard）──────────────────────┤
│  在管项目   红灯项目   逾期任务   本周周报填报率        │
├─ 图表区（栅格 xs:1 / md:2 / lg:3，全部包 ChartCard）──┤
│  ① 项目状态分布环   ② 项目健康度分布   ③ 逾期 Top N     │
│  ④ 负责人负荷 Top N（P1-2，跨列占 2 格）                │
├─ 项目明细表（复用 DataTable，整行可点下钻）───────────┤
│  项目名 类型 状态 健康 PM 进度 下一里程碑 过门 逾期数    │
└───────────────────────────────────────────────────────┘
```

### 4.3 各图表的复用与新增边界

| 图表 | 复用还是新增 | 说明 |
|---|---|---|
| ① 项目状态分布环 | **泛化后复用**（B12-P0-11） | 抽 `DonutChart` 通用组件，`ProgressDonut` 降级为它的薄封装；中心大字放「在管项目总数」，色阶用 `palette.brand` 四档（量级类语义）。八个状态超过四档色时，合并展示 Top 4 + 「其他」。 |
| ② 项目健康度分布 | **零改动复用** `HealthDistBar` | 只换 `dist` 数据源，`onDrill` 从「跳项目列表」升级为「跳项目列表并带 health 筛选参数」。配色继续用 `palette.health` 绿黄红（风险类语义）。 |
| ③ 逾期 / 临期 Top N | **零改动复用** `OverdueBarChart` | 它本就按项目分组，`rows` 换成全局聚合结果即可；`maxRows` 传 8。项目名截断逻辑（`shortName`，超 8 字加省略号）已内置。 |
| ④ 负责人负荷 Top N | **新增** `OwnerLoadBarChart` | 结构照抄 `OverdueBarChart`（横向 `BarChart` + 两序列 + `ChartLegend`），y 轴换成负责人姓名，序列换成「在办任务数 / 其中逾期数」；负荷是量级类，主序列用 `palette.brand[1]`，逾期序列用 `palette.health.red`。 |

### 4.4 新增的聚合维度（相对 B11）

B11 只有三个聚合维度（我的任务三段进度 / 按项目的逾期 / 我的项目健康度）。B12 新增：

1. **按项目状态聚合** — `PROJECT_STATUSES` 八态计数，喂给状态分布环。
2. **按项目类型聚合** — A/B/C 三类的项目数与红灯数，做筛选器上的数字提示。
3. **按负责人聚合** — 跨项目按 `wbs_nodes.owner` 分组，统计在办任务数 / 逾期数 / 涉及项目数。
4. **全局逾期聚合** — 与 B11 的 `aggregateOverdue` 同算法，但输入从「我的任务」换成「筛选范围内全部项目的未完成叶子任务」。
5. **周报填报率聚合** — 分母 = 状态为「进行中」的项目数，分子 = 本周存在 `work_reports.status='已提交'` 的项目数，口径与 `listReportReminders` 完全一致。
6. **整体进度聚合** — 筛选范围内项目 `progress` 的算术平均，明确标注为里程碑达成率口径。

### 4.5 视觉与交互约束

- **配色分层照旧**：量级类（项目数、任务数、负荷）走 `palette.brand` 品牌色阶；风险类（健康度、逾期）走 `palette.health` 语义三色。一张图内只用一套色系，同页面两套可并存。
- **品牌色真 hex**：主 `#6DA8AE`、交互 `#2E7D87` / `#3D7178`、亮 `#77C1C4`、极浅 `#DAF3F7`，一律经 `useChartPalette()` 取值。
- **空态正向表达**：沿用 B11 范式，例如逾期图空态写「太好了，没有逾期任务」，而不是「暂无数据」。
- **下钻统一**：所有可点元素（图例、色段、表格行）落点一致 —— 项目维度跳 `ROUTES.projectOverview(id)`，健康度维度跳 `ROUTES.projects` 带筛选，负责人维度开抽屉。

---

## 5. 待确认问题（请用户逐条拍板）

> 标 ★ 的是不拍板就没法开工的阻塞项。

1. **★ 统计范围**：多项目总览统计**全部项目**，还是**当前用户有权限 / 参与的项目**？
   建议：`admin / pmo / management` 看全部，`pm` 及以下默认只看自己参与的，并提供「只看我参与的」开关做二次收窄。

2. **★ 时间范围筛选**：本期是否要「近 30 天 / 本季度 / 全部」的时间范围筛选？如果要，筛选的是**项目区间交叠**（`plan_start`/`plan_end` 落在范围内）还是**任务截止日落在范围内**？
   建议：本期做项目区间交叠，列为 P1；任务维度的时间切片留到 P2 趋势图一起做。

3. **★ 「负责人负荷」的定义**：按**在办任务数**（`status ∈ 进行中/待评审/待办/阻塞` 的叶子任务计数）、按**估算工时**（`estimateDays` 求和）、还是按**实际工时**（`effortHours` 求和）？
   建议：本期用「在办任务数 + 其中逾期数」两个序列，理由是任务计数在现有 `wbs_nodes` 表里直接可查、零额外聚合成本；工时口径依赖工作日志填报完整度，数据质量不稳，放 P2。

4. **★ 项目明细表 + 钻取**：是否需要在图表下方放项目列表表格，并支持点击进入单项目仪表盘（项目概览页）？
   建议：需要，且这是总览页的落地承接 —— 图表负责「发现问题」，表格负责「定位到具体项目」，两者缺一页面就只能看不能用。已列为 B12-P0-7。

5. **导航入口与命名**：确认复用已有的 `/metrics`「度量看板」菜单项（本 PRD 的建议方案），还是新建独立的「全局总览」入口？如果复用，页面标题是否改名为「全局总览」？

6. **权限开放范围**：新增的 `dashboard:global` 权限给哪些全局角色？
   注意一个现状：`management`（管理层）角色在现有权限矩阵里**几乎没有任何入口**，只在 `review:decide` 出现过一次。B12 是管理层的主要落地场景，需要顺带确认管理层的可见范围。`pm` 是否允许看到别人的项目，也需要拍板（涉及数据敏感度）。

7. **数据获取方式**：确认走**新增服务端聚合接口** `GET /api/dashboard/overview`（本 PRD 建议），还是前端多次调用现有 `listProjects` 自行拼装？
   建议：必须服务端聚合。前端拼装拿不到「别人负责的任务」，且会产生 N+1 请求。

8. **「整体进度」口径**：总览的整体进度用**里程碑达成率**（现有 `ProjectListItem.progress`）还是 **WBS 加权完成度**（项目详情页口径）？两者对同一项目会给出不同数字。
   建议：用里程碑达成率，理由是列表侧已有现成字段、零额外计算，且管理层视角看「过了几道碑」比看「任务完成百分比」更贴合决策。

9. **项目状态过滤默认值**：总览默认统计哪些状态的项目？
   建议：默认统计「已批准 / 进行中 / 挂起」，排除「草稿 / 审批中 / 已驳回 / 已结项 / 已终止」，通过筛选器可手动打开。需确认「挂起」项目算不算在管。

10. **「风险项目」的定义**：`highRiskCount` 字段当前恒为 0（risks 表未接入，代码里有明确 TODO）。本期「风险」是否就等于 `health === 'red'`？
    建议：是，本期只用健康度红灯表达风险，risks 表接入后再细化。

11. **周报填报率是否纳入本期**：这是 PMO 的高频诉求（US-PMO-2），但需要额外的跨项目周报查询。确认是本期 P0 统计卡，还是后置到 P1？

12. **数据实时性**：总览是每次进页面实时查（可能随项目量增长变慢），还是接受短 TTL 缓存 / 手动刷新？
    建议：本期实时查 + 手动刷新按钮，缓存等出现性能问题再上（已列 P2-8）。

13. **移动端**：全局总览是否需要移动端适配？
    建议：本期只保证响应式可读（图表单列堆叠、表格横向滚动），不进移动端底部 Tab。

14. **是否需要逾期任务明细清单**：除了「哪个项目逾期多」，是否还要「具体是哪几个任务、谁负责、逾期几天」的 Top N 明细列表？
    建议：本期不做独立清单，通过点击项目下钻到该项目看板 / WBS 查看；若管理层强需求可加为 P1。

---

## 6. 范围建议（一句话）

**B12 = 新建一个服务端聚合接口 `GET /api/dashboard/overview`，把 B11 已验收的三个图表组件（健康分布、逾期柱状、进度环）的数据源从「个人」换成「全公司」，补一张负责人负荷图和一张可下钻的项目明细表，落在已存在的 `/metrics` 占位页上 —— 组件复用为主，真正的新增只有「服务端聚合层 + 负责人负荷图 + 明细表 + 权限项」四件事。**

---

## 附录 A：技术约束清单（交付给架构师）

1. **禁止在图表层 import `tokens` / `alphaOf` / `colorOf`** —— 它们返回 CSS 变量与 `color-mix()`，写进 SVG presentation attribute 不会被解析，图表会渲染成黑色或不可见。唯一取色入口是 `useChartPalette()`。
2. **日期口径唯一来源**：前端 `web/src/utils/date.ts`，后端 `server/lib/dates.js`。逾期 = `diffDays(today(), dueDate) < 0`，临期 = 非逾期且 `<= DUE_SOON_DAYS(3)`。禁止在聚合代码里出现 `new Date()` 或手撸字符串比较。
3. **权限矩阵手工双写**：`server/config/permissions.js` 与 `web/src/config/permissions.ts` 的 action key 集合必须完全相等，`scripts/smoke_b3.mjs` 会断言，漏改一边直接红。
4. **聚合逻辑零框架依赖**：新增聚合函数不得 import react / MUI / store / 组件，保证可被 QA 脚本直接 import 做数值断言（沿用 `dashboardAgg.ts` 的既定规格）。
5. **避免 N+1**：服务端聚合复用 `project.service.js#loadListContext`，它已用 `IN (...)` 批量预加载 PM 姓名、里程碑、质量门。
6. **不破坏 B11**：`ProgressDonut` 泛化时必须保持现有 props 签名可用，`WorkbenchPage.tsx` 的调用处零改动。
7. **不引入第三方部署配置，不用 localStorage 替代真实后端**，数据一律走 better-sqlite3 真实库。
8. **图表库锁定 `@mui/x-charts` v7**，不新增图表库；折线图（P2 趋势）届时也用同一库的 `LineChart`。

## 附录 B：涉及的关键枚举取值

- `PROJECT_STATUSES`：草稿 / 审批中 / 已批准 / 进行中 / 挂起 / 已结项 / 已终止 / 已驳回
- `PROJECT_ARCHIVED_STATUSES`（只读归档）：已结项 / 已终止
- `HEALTHS`：green / yellow / red
- `TASK_STATUSES`：待办 / 进行中 / 待评审 / 完成 / 阻塞
- `GLOBAL_ROLES`：admin / management / pmo / pm / tl / qa / cm / po / member
- `PROJECT_TYPES`：A / B / C
- 健康度判定：红 = 存在未达成且已逾期的里程碑；黄 = 7 天内到期 或 有门待检；绿 = 其余
