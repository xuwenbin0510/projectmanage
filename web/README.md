# 太空字节 · 项目管理系统（前端）

第一阶段 **S0 + S1** 交付物：可点击运行的**静态 UI 原型**（深空暗色主题），在 `VITE_USE_MOCK=true` 下覆盖全部 **17 个 P0 接口**（里程碑 M1）。后端不动，所有数据来自前端 Mock 引擎（内存 + `sessionStorage` 持久化）。

> 需求追溯：每个页面 / 关键函数头均带 `@prd P0-xx` 标记，分支 `feat/P0-xx`、提交 `feat(P0-xx):`、PR 带 `P0-xx`。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 构建 | Vite 5 + React 18 + TypeScript（`strict`） |
| UI | MUI 5（暗色主题）+ Tailwind 3（仅布局/响应式，preflight 关闭，`important:'#root'`）+ emotion |
| 状态 | Zustand（域 stores：auth / project / wbs / flow / ui） |
| 表单 | react-hook-form + zod（周报结构化校验） |
| 交互 | @dnd-kit（看板拖拽）、@mui/x-tree-view（WBS 树）、@mui/x-date-pickers + dayjs |
| 提示 | notistack |

---

## 快速开始

```bash
# 1. 安装依赖（仅需一次）
npm install

# 2. 以 Mock 模式启动（默认即 Mock，M1 演示用）
VITE_USE_MOCK=true npm run dev
# 或简写：npm run dev:mock（等价）
# 浏览器打开 http://localhost:5173

# 3. 生产构建校验
npm run build        # tsc --noEmit && vite build，产物输出到 ../public
npm run typecheck   # 仅类型检查
```

> 登录页提供多个演示账号（管理员 / PM / 管理层 / 客户代表等），点击即可一键登录；Mock 引擎按分类加载对应的 A/B/C 生命周期演示数据。

---

## 目录结构

```
src/
├── api/                 # API 客户端（Mock / HTTP 双实现，统一 ApiClient 契约）
│   ├── contract.ts      #   所有页面调用的接口签名（单一真源）
│   ├── mock/           #   Mock 引擎：db + fixtures + rules（分类/路由/门/WIP/校验）
│   └── http.ts         #   HTTP 实现（VITE_USE_MOCK=false 时启用）
├── components/
│   ├── common/         #   通用组件（StatusChip/DataTable/Dialogs/PermissionButton…）
│   ├── layout/         #   AppLayout / ProjectLayout / Sidebar / Topbar
│   └── review/         #   ReviewStepper / DecisionDialog
├── config/             # enums（文案集中）/ routes / permissions / demoAccounts
├── stores/             # Zustand 域 stores
├── theme/              # tokens.ts（12 token 单一真源）+ muiTheme
├── types/              # 领域类型（project / wbs / report / review / change / audit / workbench）
├── utils/              # date / format / wbs（纯函数）
├── pages/              # 页面（登录/工作台/审批/度量 + projects/* + admin/*）
└── router/index.tsx    # 路由收口（守卫 + 深链防白屏 + 404）
```

---

## P0 接口覆盖（17 / 17）

| 编号 | 能力 | 页面 / 模块 |
| --- | --- | --- |
| P0-00 | 认证与会话恢复 | `LoginPage` `authStore` |
| P0-01 | 项目分类智能判定 | `ProjectCreatePage`（实时 + 覆盖理由留痕） |
| P0-02 | 新建项目（成员/角色约束） | `ProjectCreatePage` |
| P0-03 | 项目列表多维筛选 | `ProjectListPage` |
| P0-04 | 项目详情 / 概览 | `ProjectOverviewPage` |
| P0-05 | 阶段推进 + 质量门 | `ProjectOverviewPage`（阶段条 + 门检查清单） |
| P0-06 | WBS 工作分解 | `WbsPage` + `utils/wbs`（粒度告警） |
| P0-07 | 里程碑（单向规则） | `MilestonesPage`（延后强制走变更） |
| P0-08 | 结构化周报 | `ReportsPage`（rhf + zod 校验） |
| P0-09 | 评审引擎（串行/并行/代录） | `ReviewsPage` `ApprovalsPage` `ReviewStepper` |
| P0-10 | 审批决策（驳回必填意见） | `DecisionDialog` |
| P0-11 | WBS 节点增改删 | `WbsPage` `wbsStore` |
| P0-12 | 看板 + WIP 拦截 | `BoardPage`（@dnd-kit，默认进行中 ≤ 5） |
| P0-13 | 工作台聚合 | `WorkbenchPage` |
| P0-14 | 变更发起 + 路由预判 | `ChangesPage`（PM 自批 / CCB） |
| P0-15 | 变更提交 / 实施 | `ChangesPage` |
| P0-16 | 审计留痕 / 历史时间线 | `ProjectAuditPage` `AdminAuditPage` |
| P0-17 | 结项阻塞校验 / 状态机 | `ProjectOverviewPage`（checkClose 拦截） |

> 管理后台（用户角色 / 生命周期模板 / 全局审计）、风险登记、文档清单、度量看板为 **P1 二期规划占位**（`phase:'P1'`），本阶段仅提供可运行占位页。

---

## 关键设计约束

1. **12 token 单一真源**：所有颜色仅引用 `src/theme/tokens.ts`（`colorOf` / `toneColor` / `toneOf` 固定映射），组件**禁止硬编码色值**。
2. **Tailwind + MUI 共存**：Tailwind 关闭 preflight、开启 `important:'#root'`，仅用于布局与响应式；业务色一律走 MUI + token。
3. **WIP 默认 = 5**，0 表示不限；看板拖拽触发 `E_WIP_EXCEEDED` 拦截并提示。
4. **移动端 375px 四件事**：看项目、审批、改任务状态、填周报（底部 Tab + 响应式布局）。
5. **需求可追溯**：分支 / 提交 / PR / 函数头 `@prd P0-xx` 四位一体。
6. **前端权限镜像**：`PermissionButton` + `usePermission` 仅控制按钮显隐，最终裁决以服务端为准。

---

## 已知限制

- 纯前端原型：Mock 数据存于内存 + `sessionStorage`，刷新后由 fixtures 重新注入（可用管理后台「重置演示数据」）。
- 部分校验（角色基数、覆盖理由、门检查项、风险必填等）由 Mock 引擎按架构错误码拦截，与后端契约一致。
- P1 模块（风险/文档/度量/管理模板编辑）为占位，功能在二期补齐。
