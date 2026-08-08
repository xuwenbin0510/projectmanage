# pm-app 系统可完善 / 可新增功能清单

> 基于真实源码梳理（后端 `server.js` / `db.js` / `config.js`，前端 `web/src/**`，脚本 `web/scripts/*.mjs`，部署 `render.yaml`）。
> 全量逐条列出，按模块分组，每条标优先级（P0 必须 / P1 应该 / P2 可选）。

---

## 0. 核心结论（先看这个）

当前仓库存在**两套互不连通的系统**：

| 维度 | 前端 `web/`（新，S1 原型态） | 后端 `server.js`（旧，S2 实现态） |
|---|---|---|
| 数据源 | `VITE_USE_MOCK=true`，走 `src/api/mock`（2169 行内存引擎） | better-sqlite3 真实 SQL |
| 实体 | 15 类：项目/成员/模板/质量门/检查项/里程碑/WBS/看板配置/周报/评审/变更/审计/风险/文档/用户 | 7 张表：users / projects / milestones / tasks / reports / report_tasks / approvals |
| 接口风格 | `{code:0,data,message}` 信封 + PATCH | 裸 JSON + PUT |
| 路径 | `/auth/devlogin`、`/projects/:id/wbs`、`/reviews`、`/audit`、`/workbench` … | `/api/login`、`/api/tasks`、`/api/projects/:id/approve` … |
| 审批 | 5 套模板，含 `parallel_veto` / `serial` / `single` 三种模式 | 仅串行单链 |
| 项目类型 | `'A' \| 'B' \| 'C'` | `'A类（交付类）'` 等中文长串 |

`web/src/api/http.ts`（真实 HTTP 实现）声明的 **48 个方法中，与后端现有接口能对上的接近于零**。
`.env.development` 与 `.env.production` **均为 `VITE_USE_MOCK=true`**，即打包上线的生产包也跑 mock，数据存 `sessionStorage`，关标签页即清空。

**因此 P0 的主线只有一条：后端补齐能力 + 前后端契约对齐 + 关掉 mock。** 下列清单围绕这条主线展开。

---

## 1. 前后端联调与契约对齐

| # | 优先级 | 事项 | 核心点 |
|---|---|---|---|
| 1.1 | **P0** | 生产环境关闭 mock | `.env.production` 的 `VITE_USE_MOCK` 改 `false`；保留 `.env.development` 可切换，供无后端时演示 |
| 1.2 | **P0** | 统一响应信封 | 后端所有接口改为返回 `{code:0,data,message}`；错误返回业务码而非仅 HTTP status，前端 `request()` 已按此解析 |
| 1.3 | **P0** | 统一 HTTP 方法 | 前端更新一律用 PATCH，后端只提供 PUT；二选一并全量对齐 |
| 1.4 | **P0** | 统一路由前缀与命名 | 后端资源路径改为嵌套式（`/api/projects/:id/milestones`），与 `http.ts` 一致；现有 `/api/milestones?projectId=` 扁平风格淘汰 |
| 1.5 | **P0** | 统一认证路径 | 后端 `/api/login`→`/api/auth/feishu`、`/api/devlogin`→`/api/auth/devlogin`、`/api/me`→`/api/auth/me`，补 `/api/auth/logout` |
| 1.6 | **P0** | 统一项目类型枚举 | 前端用 `A/B/C` 单字母，后端 `APPROVAL_TEMPLATES` 用 `'A类（交付类）'` 做 key；统一为单字母，中文仅作展示 label |
| 1.7 | **P0** | 统一角色枚举 | 前端有 `po`/`cm`/`customer_rep`，后端 `ROLES` 没有；后端补齐并区分「全局角色」与「项目角色」两层 |
| 1.8 | **P0** | 补齐错误码字典 | 前端 `types/api.ts` 已定义 `E_WBS_DEPTH`/`E_GATE_NOT_PASSED`/`E_MS_NEED_CHANGE` 等，后端需按同名码返回，否则前端拿不到结构化提示 |
| 1.9 | **P1** | 契约单一真源 | `docs/api-contract.md`（89KB）与 `contract.ts` 已分叉，改为从 TS 类型或 OpenAPI 生成，避免三处维护 |
| 1.10 | **P1** | 联调冒烟脚本 | 提供一条命令拉起后端 + 前端 `VITE_USE_MOCK=false`，跑通登录→建项→WBS→周报→评审全链路 |
| 1.11 | **P2** | 保留 mock 做契约测试 | mock 引擎已实现完整业务规则，可作为后端行为的黄金参照，同一组用例双跑比对 |

---

## 2. 后端业务能力（当前缺失的实体与接口）

| # | 优先级 | 事项 | 核心点 |
|---|---|---|---|
| 2.1 | **P0** | 项目成员 | 后端仅单字段 `projects.pm`；需 `project_members` 表（项目内多角色 pm/tl/po/qa/cm/pmo/member）+ 增删查接口 |
| 2.2 | **P0** | WBS 层级树 | 后端 `tasks` 是平表无父子；需 `parent_id`/`level`/`wbs_code`/`node_type`/`sort_order`，及创建/更新/删除/移动接口与子树级联 |
| 2.3 | **P0** | 质量门与检查项 | 后端完全没有；需 `quality_gates`（挂 milestone）+ `gate_checklist_items` + 勾选/决议接口 |
| 2.4 | **P0** | 评审 | 后端只有项目级串行审批；需独立 `reviews` 实体，支持 `refType/refId` 挂任意对象、三种审批模式、审批人快照 |
| 2.5 | **P0** | 变更单 | 后端没有；需 `changes` 表 + 路由判定（里程碑日期/需求基线/工作量≥3人日 → CCB）+ 提交/审批/实施接口 |
| 2.6 | **P0** | 审计日志 | 后端没有；需 `audit_logs` 表，记录 actor/entityType/entityId/action/diff/projectId/时间，支持按项目与全局分页查询 |
| 2.7 | **P0** | 生命周期模板 | 后端 `APPROVAL_TEMPLATES` 硬编码在 `config.js`；需 `lifecycle_templates` 表存里程碑骨架、质量门定义、WBS 规则，支持后台维护 |
| 2.8 | **P0** | 工作台聚合 | 前端 `getWorkbench()` 需「我的待办/我的审批/我的项目/逾期项」聚合，后端 `/api/dashboard` 只有全局计数，不分人 |
| 2.9 | **P0** | 看板配置 | 需 `board_configs` 表存 WIP 限制，及按状态+顺序移动任务的接口 |
| 2.10 | **P0** | 项目状态流转 | 后端只有审批链改 `status`；需通用 `transition` 接口 + 状态机校验 + 结项前置检查（`checkClose`） |
| 2.11 | **P1** | 风险登记册 | 前端 `RisksPage` 已建表格 UI（编号/描述/类别/概率×影响/责任人/状态/复评日），后端与写入能力均缺 |
| 2.12 | **P1** | 文档清单 | 前端 `DocumentsPage` 已建 UI（模板/版本/状态/基线标记/链接），后端与文件存储均缺 |
| 2.13 | **P1** | 项目分类判定 | `classifyProject` 规则链完整实现在前端 `mock/rules.ts`，需下沉后端作为权威判定 |
| 2.14 | **P1** | 列表分页 | 后端所有 list 接口全量返回；前端已按 `Paged<T>{items,total,page,pageSize}` 消费，需补分页与筛选（keyword/type/status/health/pm/onlyMine） |
| 2.15 | **P1** | 周报按周唯一 | 前端 `getReport(projectId, week)` 假设一项目一周一份；后端无唯一约束，会产生重复周报 |
| 2.16 | **P2** | 度量看板数据 | `MetricsPage` 四个指标卡全是 `—`；需进度偏差、评审通过率、缺陷密度、资源负荷的聚合接口 |
| 2.17 | **P2** | 批量操作 | 任务批量改状态/批量指派/批量调期，当前只能逐条 |
| 2.18 | **P2** | 数据导出 | 项目报表、WBS、周报导出 Excel/PDF |

---

## 3. 审批流

| # | 优先级 | 事项 | 核心点 |
|---|---|---|---|
| 3.1 | **P0** | 支持并行会签与一票否决 | 后端只有串行；`REVIEW_TEMPLATES.formal` 要求 `parallel_veto`（PMO+TL+管理层+客户代表并行，任一否决即驳回） |
| 3.2 | **P0** | 支持单人决议模式 | `technical`/`code` 模板为 `single` 模式，后端无对应实现 |
| 3.3 | **P0** | 审批链绑定到评审对象 | 当前审批链只能挂项目（立项）；需支持挂里程碑、变更单、文档等 `refType` |
| 3.4 | **P0** | CCB 变更审批链 | `ccb` 模板链 `pm→tl→po→customer_rep`，其中 `po`/`customer_rep` 后端角色不存在 |
| 3.5 | **P1** | 审批人快照 | 现在按角色实时查人（`usersByRole`）；角色调整会改变历史单据的「应审人」，需下单时固化审批人列表 |
| 3.6 | **P1** | 撤回能力 | 前端 `withdrawReview` 已定义，后端无对应实现 |
| 3.7 | **P1** | 加签 / 转签 / 代批 | 权限矩阵已有 `review:proxy`，后端无实现 |
| 3.8 | **P1** | 驳回后重提保留链路 | 当前驳回把 `approval_step` 置 -1，重提从 0 开始；需支持「驳回到指定步骤」并保留已批节点 |
| 3.9 | **P1** | 审批超时与催办 | 无超时概念；需 SLA 计时 + 到期提醒 |
| 3.10 | **P2** | 条件分支审批 | 按金额/工作量自动增减审批层级，当前模板是静态数组 |
| 3.11 | **P2** | 审批意见附件 | `DecisionPayload.evidenceUrl` 前端已定义，后端与上传能力均缺 |

---

## 4. 权限与用户体系

| # | 优先级 | 事项 | 核心点 |
|---|---|---|---|
| 4.1 | **P0** | 服务端补齐项目级角色判权 | 后端 `canEditProject` 只认 `admin` 或 `p.pm === open_id`；前端权限矩阵有 24 个 action × 双层角色，服务端需一一对应实现 |
| 4.2 | **P0** | 权限矩阵单一真源 | `web/src/config/permissions.ts` 与后端 `canXxx` 函数各写一套，必然分叉；抽成共享配置或代码生成 |
| 4.3 | **P0** | 会话可撤销 | HMAC 无状态令牌有效期 7 天，改角色/离职后旧令牌仍有效且携带旧 `rl` 角色；需服务端会话表或令牌版本号 |
| 4.4 | **P0** | 令牌角色不刷新 | `signToken` 把 `role` 写进 payload，`auth()` 直接信任；管理员改角色后当事人需等 7 天或重登才生效，且可被利用 |
| 4.5 | **P1** | 首登即管理员的引导机制 | `upsertUser` 中「首个登录用户自动 admin」在公网部署下是接管入口；需改为仅 `ADMIN_OPEN_IDS` 白名单或一次性初始化令牌 |
| 4.6 | **P1** | 开发登录的生产隔离 | `/api/devlogin` 仅以「未配置 `FEISHU_APP_ID`」为开关；`render.yaml` 默认 `FEISHU_APP_ID=""`，即线上默认开放任意姓名登录且首个用户为管理员 |
| 4.7 | **P1** | 用户停用 / 离职 | 只有角色字段，无启用状态；离职人员仍可登录并作为审批人被检索 |
| 4.8 | **P1** | 用户与飞书通讯录同步 | 现在靠登录时 `upsertUser` 被动建档；未登录过的同事无法被指派为负责人或审批人 |
| 4.9 | **P2** | 部门 / 组织架构 | 无部门维度，无法按部门筛项目、按部门统计负荷 |
| 4.10 | **P2** | 用户组与角色继承 | 角色是单值字段，一人只能一个全局角色 |

---

## 5. 数据模型与查询

| # | 优先级 | 事项 | 核心点 |
|---|---|---|---|
| 5.1 | **P0** | `tasks` 表缺列 | `db.js` 建表语句没有 `name` 列，靠 `migrateTasks()` 事后 ALTER 补；建表语句应直接包含，避免新库与旧库结构分叉 |
| 5.2 | **P0** | 迁移机制脆弱 | 两处 `PRAGMA table_info` 手写探测；需版本化迁移（`schema_version` 表 + 有序迁移脚本） |
| 5.3 | **P0** | 项目缺计划起止日期 | `projects` 无 `plan_start`/`plan_end`；前端 `CreateProjectPayload` 要求且里程碑起算日依赖 `planStart` |
| 5.4 | **P0** | 项目缺健康度字段 | 前端有 `health` 红黄绿与 `computeHealth` 规则，后端无字段无计算 |
| 5.5 | **P0** | 金额类型错误 | `projects.amount` 是 TEXT，前端 `contractAmount: number` 且分类规则要做数值比较（≥阈值） |
| 5.6 | **P1** | 缺外键约束 | `tasks.ms_id`、`projects.pm`、`reports.author`、`approvals.approver_open_id` 均无 FK；`foreign_keys=ON` 但没声明等于没约束 |
| 5.7 | **P1** | 缺唯一约束 | 项目 `code`、周报 `(project_id, week)`、里程碑 `(project_id, code)` 可重复 |
| 5.8 | **P1** | 缺索引 | `tasks.owner`、`tasks.status`、`tasks.due`、`reports.author`、`projects.pm`、`projects.status` 无索引，工作台按人查会全表扫 |
| 5.9 | **P1** | `/api/dashboard` 全量拉表 | 四张表整表读进内存再 JS 过滤；改为 SQL 聚合 |
| 5.10 | **P1** | `/api/reports` N+1 | 列表里对每条 report 再查一次关联任务；改为一次 JOIN |
| 5.11 | **P1** | 时间字段无时区语义 | 全部 ISO 字符串裸存，`due` 与 `created_at` 精度不一（日期 vs 时刻），跨时区比较有歧义 |
| 5.12 | **P1** | JSON 字段裸存 TEXT | `goal`、`snap` 存 JSON 字符串，无法在 SQL 层过滤；SQLite 有 JSON1 可用 |
| 5.13 | **P2** | 软删除与回收站 | 项目删除是物理 DELETE + CASCADE，误删不可恢复 |
| 5.14 | **P2** | 乐观锁 | 无 `version`/`updated_at` 冲突检测，多人同编后写覆盖前写 |
| 5.15 | **P2** | 里程碑派生状态落库口径 | mock 用 `doneAt` + `statusOverride` 三元组派生状态，后端 `milestones` 只有 `done INTEGER`，语义丢失 |

---

## 6. 前端体验与交互

| # | 优先级 | 事项 | 核心点 |
|---|---|---|---|
| 6.1 | **P0** | 飞书免登传错 appId | `LoginPage.tsx` 调 `requestAuthCode(import.meta.env.VITE_APP_TITLE ?? 'cli_demo_appid')`，传的是应用标题「太空字节项目管理」而非 AppID；应改为调后端 `/api/appid` 取值 |
| 6.2 | **P0** | 占位页对外可见 | `MetricsPage` / `RisksPage` / `DocumentsPage` 三个页面在侧边栏可点进，内容是「本期为占位」；接通前应隐藏入口或标注状态 |
| 6.3 | **P0** | mock 提示文案上线 | 登录页有「S1 静态原型（Mock 模式）」提示块，随 `USE_MOCK` 显示；生产关 mock 后自动消失，但需确认无其它 mock 专属 UI 残留 |
| 6.4 | **P1** | 全局错误边界 | 无 React ErrorBoundary，任一页面渲染异常整个 SPA 白屏 |
| 6.5 | **P1** | 401 统一处理 | `http.ts` 的 `request()` 对 401 不做特殊处理，令牌过期后各页面各自 toast，不会跳登录页 |
| 6.6 | **P1** | 请求重复与竞态 | 各页面 `useEffect` 直接调 API，无取消无去重，快速切换项目会出现旧响应覆盖新数据 |
| 6.7 | **P1** | 无数据缓存层 | 未用 React Query/SWR，跨页面重复拉同一份项目数据 |
| 6.8 | **P1** | 表单未保存离开提示 | 建项向导、周报弹窗等长表单无 `beforeunload` / 路由拦截 |
| 6.9 | **P1** | 大列表虚拟滚动 | WBS 树与任务列表全量渲染，节点多时卡顿 |
| 6.10 | **P1** | 移动端适配 | 侧边栏 + 多列表格布局未针对飞书移动端 H5 优化，而免登场景主要在移动端 |
| 6.11 | **P2** | 无障碍 | 表格与拖拽（`@dnd-kit`）缺键盘操作与 ARIA 标注 |
| 6.12 | **P2** | 骨架屏一致性 | 部分页面有 `LoadingState`，部分直接空白 |
| 6.13 | **P2** | 全局搜索 | 无跨项目/任务/文档的统一搜索入口 |
| 6.14 | **P2** | 用户偏好持久化 | 主题模式已存 `localStorage`；列表筛选条件、列宽、展开状态未持久化 |
| 6.15 | **P2** | 代码分割 | 路由未做 `lazy`，首屏加载全部页面；`chunkSizeWarningLimit` 已调到 1600 掩盖了体积问题 |

---

## 7. 飞书集成深度

| # | 优先级 | 事项 | 核心点 |
|---|---|---|---|
| 7.1 | **P0** | 消息通知 | 全项目无任何飞书消息推送；审批待办、驳回、逾期、周报截止都应推卡片消息 |
| 7.2 | **P1** | 审批中心对接 | 可将评审/变更单同步为飞书原生审批实例，让用户在飞书审批中心处理 |
| 7.3 | **P1** | 通讯录选人组件 | 指派负责人/审批人时应调飞书选人 JSSDK，而非从本地 `users` 表下拉（本地表只有登录过的人） |
| 7.4 | **P1** | 日历集成 | 里程碑日期、评审会议写入飞书日历 |
| 7.5 | **P1** | 云文档集成 | `DocumentsPage` 的文档链接应支持挂飞书云文档，并读取标题/更新时间 |
| 7.6 | **P2** | 群机器人播报 | 项目群按周播报进度、风险、逾期清单 |
| 7.7 | **P2** | 多维表格双向同步 | 与飞书多维表格互通，便于非系统用户查看 |
| 7.8 | **P2** | 应用主页与快捷入口 | 配置飞书工作台小组件，直达「我的待办」 |

---

## 8. 工程化与测试

| # | 优先级 | 事项 | 核心点 |
|---|---|---|---|
| 8.1 | **P0** | 无测试框架 | `web/package.json` 无 `test` 脚本，无 vitest/jest；只有 9 个手写 `.mjs` 脚本 |
| 8.2 | **P0** | QA 脚本依赖源码文本匹配 | `qa_round4_optimize.mjs` 等用 `readFileSync` + 正则断言 JSX 源码（如断言 `keepOpenOnSubmit={false}` 字面量）；任何重构都会误报，脚本自身注释已记录 R5 后 5 条断言过期 |
| 8.3 | **P0** | 后端零测试 | `server.js` 无任何单测/接口测试；`test_runner.js`、`verifydb.js` 等在 `.gitignore` 中，不入库不可复现 |
| 8.4 | **P0** | 无 CI | 无 `.github/workflows`；lint / typecheck / build / 回归脚本全靠人工执行 |
| 8.5 | **P1** | 后端无 lint | `web/eslint.config.js` 只覆盖前端；根目录 `server.js`/`db.js`/`config.js` 无 lint 无格式化 |
| 8.6 | **P1** | 前端 eslint 未入库 | `web/eslint.config.js` 与 `web/package-lock.json` 处于 untracked 状态，队友拉不到 |
| 8.7 | **P1** | 工作区有未提交改动 | 10 个文件 modified（含 6 个 projects 页面）、5 项 untracked；当前 HEAD 为 `6277dc9`，与「基线 e4c372dd」不符，需先确认基线 |
| 8.8 | **P1** | 根目录 `dist/` 是陈旧全量副本 | 内含独立的 `config.js`/`db.js`/`server.js`/`public/`，与 `web/dist` 并存，易误部署；已 gitignore 但本地仍在 |
| 8.9 | **P1** | 调试脚本散落根目录 | `devcheck.js`/`resetdb.js`/`tmp_checksyntax.js`/`verifydb.js`/`verifydev.js`/`verifyfix.js` 混在业务代码同级，靠 gitignore 屏蔽 |
| 8.10 | **P1** | `emptyOutDir:false` | `vite.config.ts` 关闭了产物清理，旧 chunk 会残留在 `web/dist` 累积并可能被引用 |
| 8.11 | **P1** | 后端无 TypeScript | 前端全 TS 有类型契约，后端纯 CommonJS JS，跨层类型无法校验 |
| 8.12 | **P2** | 无 E2E | 无 Playwright/Cypress，关键链路（登录→建项→审批）无端到端保障 |
| 8.13 | **P2** | 无 pre-commit 钩子 | 无 husky/lint-staged，格式与 lint 靠自觉 |
| 8.14 | **P2** | 依赖锁不完整 | 根 `package-lock.json` 已入库，`web/package-lock.json` 未入库，前端依赖版本不可复现 |
| 8.15 | **P2** | 文档与实现分叉 | `docs/` 下 20+ 份 PRD/架构/QA 报告（`api-contract.md` 89KB、`schema.sql` 33KB）描述的是目标态，与 `db.js` 实际 7 张表差距大，需标注状态 |

---

## 9. 安全

| # | 优先级 | 事项 | 核心点 |
|---|---|---|---|
| 9.1 | **P0** | `SESSION_SECRET` 有默认值 | `config.js` 缺省 `'dev-only-change-me'`，未设环境变量时静默启用，任何人可伪造任意角色令牌；应改为缺失即启动失败 |
| 9.2 | **P0** | 无请求体大小限制 | `express.json()` 未设 `limit`，可被超大 body 打满内存 |
| 9.3 | **P0** | 无速率限制 | 登录与所有写接口无限流，可被暴力尝试 |
| 9.4 | **P0** | 无安全响应头 | 未接 helmet，缺 CSP / X-Frame-Options / HSTS；应用需内嵌飞书 iframe，须显式配置 frame-ancestors 而非放任 |
| 9.5 | **P1** | 无 CORS 策略 | 未配置 CORS，当前靠同源部署兜底；一旦前后端分域即失控 |
| 9.6 | **P1** | 输入未校验 | 所有接口直接取 `req.body` 字段落库，无类型/长度/枚举校验；前端已有 zod，后端需对等校验 |
| 9.7 | **P1** | 错误信息外泄 | `/api/login` 直接 `res.json({error: e.message})`，会把飞书接口原始错误与内部细节返回客户端 |
| 9.8 | **P1** | 令牌存 localStorage | XSS 可直接窃取；考虑 httpOnly Cookie + CSRF 令牌 |
| 9.9 | **P1** | 无越权用例覆盖 | 前端权限只管按钮显隐（文件内已注明「永远不能作为安全边界」），后端对应判权缺失项见 4.1，需配套越权测试 |
| 9.10 | **P2** | 无审计留痕覆盖敏感操作 | 角色变更、项目删除等无日志（审计表本身也缺，见 2.6） |
| 9.11 | **P2** | 依赖漏洞扫描 | 无 `npm audit` / Dependabot |

---

## 10. 可观测性与部署

| # | 优先级 | 事项 | 核心点 |
|---|---|---|---|
| 10.1 | **P0** | Render 免费盘数据即丢 | `render.yaml` 用 `plan: free` + `DB_PATH=./pm.db`，重启/重部署清空全部业务数据；需升级计划并挂载 disk 到 `/data` |
| 10.2 | **P0** | 无数据备份 | SQLite 文件无定时备份、无导出、无恢复流程 |
| 10.3 | **P0** | 无结构化日志 | 全应用仅启动时两行 `console.log`，无请求日志、无错误日志、无 requestId 串联；前端已在请求头带 `X-Request-Id`，后端未消费 |
| 10.4 | **P0** | 无全局错误处理中间件 | Express 未注册 error handler，同步抛错直接 500 空响应；`/api/login` 之外的 `db.prepare` 异常无兜底 |
| 10.5 | **P1** | 健康检查过于宽松 | `healthCheckPath: /` 命中的是前端 `index.html` 静态文件，数据库挂了也返回 200；需 `/healthz` 实检 DB |
| 10.6 | **P1** | 无优雅退出 | 未处理 SIGTERM，重启时 WAL 可能未 checkpoint |
| 10.7 | **P1** | 无监控告警 | 无 APM、无错误上报（前端也无 Sentry 类采集） |
| 10.8 | **P1** | 单进程单实例 | better-sqlite3 同步阻塞，无法水平扩展；需评估并发上限或迁移 PostgreSQL |
| 10.9 | **P2** | 无环境区分 | 无 `NODE_ENV` 分支，开发与生产行为一致（含 `/api/devlogin` 暴露判断，见 4.6） |
| 10.10 | **P2** | 静态资源无缓存策略 | `express.static` 用默认配置，无 immutable / max-age，带 hash 的构建产物未享长缓存 |
| 10.11 | **P2** | 无回滚方案 | 部署失败无版本回退流程，数据库迁移也不可逆 |

---

## 11. 建议的推进顺序

1. **第一阶段（打通）**：2.1–2.10 后端补实体 + 1.1–1.8 契约对齐 + 9.1 密钥硬校验 + 10.1 数据持久化。目标：`VITE_USE_MOCK=false` 能跑通主链路。
2. **第二阶段（可用）**：4.1–4.4 服务端判权、3.1–3.4 审批模式补齐、5.1–5.5 模型补列、10.3–10.4 日志与错误处理、8.1/8.3/8.4 测试与 CI。
3. **第三阶段（好用）**：7.1 飞书通知、2.11–2.12 风险与文档、6.4–6.10 前端健壮性与移动端、2.16 度量看板。
4. **持续**：P2 项按需插入。

---

## 12. 待主理人确认

| # | 事项 |
|---|---|
| 12.1 | 基线提交号：任务描述为 `e4c372dd`，实际 HEAD 为 `6277dc9`，且工作区有 10 个 modified + 5 个 untracked。以哪个为准？ |
| 12.2 | `web/src/api/mock/index.ts`（2169 行）实现的业务规则是否即为后端实现目标？若是，可直接作为后端验收基准。 |
| 12.3 | `docs/schema.sql`（33KB）与 `docs/api-contract.md`（89KB）是目标态设计还是历史稿？是否直接按其实现后端。 |
| 12.4 | 根目录 `dist/`（含独立 server.js/db.js/public）与 `legacy/index.html` 是否可清理。 |
| 12.5 | 上线形态：是否确定为飞书内嵌 H5（影响 6.10 移动端与 9.4 frame-ancestors 的优先级）。 |
| 12.6 | 数据库选型：继续 SQLite 还是迁 PostgreSQL（影响 10.8 与 5.x 建模方式）。 |
