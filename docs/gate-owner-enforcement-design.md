# 质量门「责任角色」强制校验（方案 A）— 设计 / 影响面评估

> 状态：设计稿，待拍板后进入实现
> 关联问题：当前 `quality_gates.owner_role` / `gate_checklist_items.owner_role` 不参与任何权限判定，责任角色字段形同虚设（详见对话梳理）。

---

## 1. 背景与问题

现状（已代码核实）：
- 勾检查项 `toggleGateItem`（`server/services/gate.service.js:79`）只校验 `gate:item:check` 能力。
- 提交门结论 `decideGate`（`gate.service.js:123`）只校验 `gate:decide` 能力。
- 能力判定 `canDo` → `permissionCatalog.rolesFor(action)` 读 `permission_rules` 表（DB 驱动、后台可改），**全程不读 `owner_role`**。
- `owner_role` 仅用于：前端展示、新建检查项时的默认角色种子、工作台"待我检查"的展示字段。

后果：
1. **责任与权限分离** —— 任何持有能力的角色都能代操作任意门/项，责任角色字段不具约束力。
2. **审计无法证明"责任人操作"** —— `decided_by` / `checked_by` 只记"谁做的"，无"是否即责任角色"校验。
3. **UX 过度承诺** —— 字段名"责任角色"暗示独家权限，实际没有。

---

## 2. 方案 A 目标

在现有 capability 校验**之上**叠加一层"责任角色"校验：
- 勾检查项：操作者须 == 该项 `owner_role`，或持有全局 override 角色。
- 提交门结论：操作者须 == 该门 `owner_role`，或持有全局 override 角色。
- **不新增 permission action**（不动 `permission_rules`），仅在既有能力校验后再加一道 owner 比对。
- 空 `owner_role` → 跳过 owner 校验（兼容历史数据，避免锁死）。
- **后端为唯一安全边界**；前端显隐为体验增强，即便漏改也不影响安全。

---

## 3. 角色语义与 operator（关键设计待拍板）

操作者的"有效角色" = 全局职位（`users.global_role` + `user_roles`）∪ 项目内角色（`project_members.project_role`）。复用 `rbac.globalRolesOf` + `rbac.projectRolesOf`。

owner 校验的**逻辑算子**有两种选法，影响面差异很大，需你定：

| 方案 | 规则 | 含义 | 风险 |
|---|---|---|---|
| **A1（AND）** | 须 `capability` 且（是 owner 或 override） | 在现有能力之上再加 owner 约束 | 若 `owner_role` 不在能力清单内，**owner 本人也会被锁死**，只剩 override 能操作 |
| **A2（owner 充分）** | `capability` 或 是 owner 或 override | 责任角色本身即足够权限 | owner 即使不在能力清单也能操作；非 owner 非能力者仍被拦 |

**推荐 A2**。理由：方案本意就是"责任角色能操作"，A1 会出现"指定责任人却因矩阵漏配而被自己挡在门外"的反直觉结果（见 §6 真实冲突）。A2 把能力清单保留为"谁可被卷入此门"的粗边界，owner 为精确定权。

---

## 4. override 角色集合（待拍板）

建议 override = `['admin', 'cpo', 'cto', 'management']`：
- 理由：管理三角色本就该能代操作/救火；且避免 `owner_role` 配置异常时全员锁死。

> ⚠️ **A2 下本集合实质冗余（无害但非必需）**：上述四个角色（`admin/cpo/cto/management`）当前仍都落在 `gate:decide` 能力清单内（线上实测 `gate:decide = admin,cpo,cto,management,pm,pmo,qa`），因此在 A2（`能力 或 责任人 或 override`）中它们靠"能力"即可操作任意门，override 集合不改变其行为——它只是"救火角色"的显式声明 + 为未来收窄能力清单时留的安全网。注：`tl` 现已**不在** `gate:decide`，故 tl 不再能凭能力操作任意门，只能操作 `owner_role=tl` 的门（A2 责任人路径）或被 override 角色代操作。
>
> 因此 **"override 是否含 pmo/qa"在 A2 下是伪问题**：pmo/qa 已凭能力可操作任意门，加不加到 override 行为一致。**该子问题只在 A1 下才有意义**——A1 要求"有能力 且 (责任人 或 override)"，此时 pmo/qa 若不在 override，就只能操作 `owner_role=pmo/qa` 的门；加入 override 才能操作任意门。
>
> 若坚持要让某个**不在能力清单内**的角色拥有救火权（例如让 `pm` 也能代操作任意门，尽管 pm 当前不在 `gate:decide`），则应把它加入此 override 集合——这是 override 在 A2 下唯一真正起作用的场景。

> 该集合写死在代码常量（不入 `permission_rules`）。若未来要"让某角色也能代操作"，改代码发版即可；override 本就是非常态救火语义，不建议常态化放开。如需可配置，后续可改为读一个虚拟 action（本期不做）。

---

## 5. 后端改动（权威边界）

### 5.1 新增 helper
`server/middleware/rbac.js` 增加：
```
function assertGateOwnerOrOverride(db, req, ownerRole, projectId) {
  if (!ownerRole) return;                       // 空 → 不强制（兼容历史）
  const globalRoles = globalRolesOf(db, req.user.id, req.user.global_role);
  const projectRoles = projectRolesOf(db, projectId, req.user.id);
  const mine = new Set([...globalRoles, ...projectRoles]);
  const OVERRIDE = ['admin','cpo','cto','management'];
  if ([...OVERRIDE].some(r => mine.has(r))) return;     // A2 下 override 直接通过
  if (mine.has(ownerRole)) return;                       // 是责任人
  throw new AppError(ErrorCode.E_FORBIDDEN, `仅责任角色 ${ownerRole} 可操作（或管理员代操作）`);
}
```
> A1 与 A2 的差异只在"是否先 `assertCan(capability)` 后再调本函数"以及本函数是否允许非能力者通过 —— 见 §3。

### 5.2 `toggleGateItem`（`gate.service.js:79`）
在 line 86 `assertCan('gate:item:check')` 之后增加：
```
assertGateOwnerOrOverride(db, req, mappers.toStr(item.owner_role), projectId);
```
`item.owner_role` 已由 `requireGateItemRow` 载入。

### 5.3 `decideGate`（`gate.service.js:123`）
在 line 127 `assertCan('gate:decide')` 之后增加：
```
assertGateOwnerOrOverride(db, req, mappers.toStr(gate.owner_role), projectId);
```

### 5.4 错误码
复用 `E_FORBIDDEN`（无需新码），message 明示责任角色。前端 `ProjectOverviewPage` 的 `handleToggleItem`/`handleDecide` 已有 `catch → toast.error(e)`（line 495 / 547），`E_FORBIDDEN` 走该分支即可，无需改错误协议。

---

## 6. 与当前权限矩阵的真实冲突（必读）

当前线上 `permission_rules`（`pm.db` 实测，末次编辑 2026-09-14 by admin）：
- `gate:decide`（granted=1）= `admin, cpo, cto, management, pm, pmo, qa`  ← **注意 `tl` 已不在其中**
- `gate:item:check`（granted=1）= `admin, cm, cpo, cto, management, pm, pmo, po, qa, sale, tl`  ← **注意 `member` 已不在其中，`sale` 在其中**

> 该矩阵是 DB 驱动、后台可改；本次实测与早期快照（含 `tl`/`member`、不含 `pm`/`sale`）已不同，以 `permission_rules` 实时值为准。

若采用 **A1（AND）**，以用户场景「门级角色=tl、项级角色=dev」为例（两角色恰都不在各自能力清单）：
- 门 owner=tl，但 `tl` **不在** `gate:decide` → 即便 tl 是责任人，`assertCan(gate:decide)` 直接拦下，**tl 自己无法提交自己负责的门**，只剩 admin/cpo/cto/management/pm/pmo/qa 能操作。
- 项 owner=dev，但 `dev` **不在** `gate:item:check` → dev 无法勾自己负责的项。
- 这违背"责任角色能操作"的初衷。

若采用 **A2（owner 充分）**：tl 作为门 owner、dev 作为项 owner 可直接操作（不必在能力清单）；非 owner 仍须持有能力。冲突消除。
→ **这是选 A2 的决定性理由。**（即便 `pm` 现已在 `gate:decide` 可凭能力提交，矩阵仍无法枚举"所有可能被设为 owner 的角色"，A2 的 owner 兜底始终必要。）

---

## 7. 前端改动（体验增强 + 一致性）

前端已具备全部所需上下文：
- `authStore.user.globalRoles`（全局职位并集）与 `authStore.projectRoles`（进入项目时注入）。
- `can()` 反映后台实时矩阵（`/api/meta/permission-matrix` 注入），非写死常量。

### 7.1 主 UI（`web/src/pages/projects/ProjectOverviewPage.tsx`）
- 页内计算：`myRoles = [...user.globalRoles, ...projectRoles]`；`isOverride = myRoles 与 OVERRIDE 相交`；`canOwner = myRoles.includes(ownerRole) || isOverride`。
- **勾选框** `Checkbox`（line 782）：非 `canOwner` 且非 override → `disabled`（叠加既有 `archived` 语义）。
- **提交门结论按钮**（line 690 `PermissionGate action="gate:decide"`）：在 capability 通过前提下，额外 `disabled = !canOwner`，配 Tooltip「仅责任角色 X 可提交」。
- **列表项"责任角色"**（line 804）：若当前用户即责任人 → 追加标记「（你）」高亮。

### 7.2 不改动 `can()` hook
owner 比对建议页内联（`myRoles.includes`），避免扩大 hooks 改动面。

### 7.3 Mock 一致性（`web/src/api/mock/index.ts`）
- `toggleGateItem`（line 1357）/ `decideGate`（line 1434）：在 `assertCan('gate.check'/'gate.decide')` 后补 owner_role 校验（mock 的 `me` 与 gate/item 均可得），否则 dev/mock 自测与后端行为不一致。

---

## 8. 工作台"待我检查"联动（建议同期做）

`workbench.service.js` GateTodo 当前按 `gate:decide` 能力过滤（line 336）。叠加 owner 强制后建议同步：
- 用户进入待办的条件 = 持有 `gate:decide` **且**（gate.owner_role ∈ myRoles 或 override）。
- 否则对非责任人的管理者仍展示一堆"点不动"的门，体验矛盾。
- 改动点：`listGateTodos`（约 line 317–382）。**中等改动，标记"建议同期"，非阻塞。**

---

## 9. 数据兼容 / 存量

- `owner_role` 在模板复制（`project.service.js:1049/1059`）、blank 挂门（`gate.service.js:367/374`）、前端 GateEditor（默认 `'tl'`）均会写入，存量应基本非空。
- 极少量历史空值按 §5.1 "空 → 不强制" 规则保持原行为（开放给能力持有者），**不锁死、不需回填迁移**。
- 如需强一致，可补一次性 SQL 将空 `owner_role` 置默认 `'tl'`（可选，非必需）。

---

## 10. 验证计划

- **后端接口**：用非责任人角色（如纯 tl 去决定 owner=pm 的门）→ 期望 403；用 owner=pm 的用户（A2 下）→ 通过；用 admin → 通过；owner_role 空 → 通过。
- **前端**：非责任人勾选框 disabled；责任人可勾；admin 可勾；Tooltip 文案正确。
- **Mock 模式**：同测，确保与后端一致。
- **回归**：能力持有者且为责任人的正常路径不受影响。
- **本地冒烟**：playwright 多角色 token 验证 disabled 态 + 403 拦截（沿用既有 `/tmp/pm-*.cjs` 套路）。

---

## 11. 改动文件清单（预估）

后端（必改）：
- `server/middleware/rbac.js` — 新增 `assertGateOwnerOrOverride`
- `server/services/gate.service.js` — `toggleGateItem` / `decideGate` 两处调用

前端（必改）：
- `web/src/pages/projects/ProjectOverviewPage.tsx` — Checkbox disabled、提交按钮 disabled+tooltip、责任人标记
- `web/src/api/mock/index.ts` — 两处 mock 同步

可选同期：
- `server/services/workbench.service.js` — 待我检查过滤对齐
- 一次性 SQL 回填空 owner_role（可选）

---

## 12. 待你拍板的设计点

1. **算子 A1 还是 A2？** → 推荐 **A2**（消除 §6 的"责任人被自己锁死"冲突）。这是唯一真正需要拍板的分叉。
2. ~~override 是否含 `pmo`/`qa`？~~ → **在 A2 下为伪问题**（见 §4 警示框）：pmo/qa 已凭 `gate:decide` 能力可操作任意门，加不加到 override 行为一致。故 override 集合维持 `admin/cpo/cto/management` 即可，无需另议。若未来要赋予"不在能力清单内的角色"救火权（如 pm），再把它加进此集合。
3. **是否同期改工作台待办过滤（§8）？** → 推荐同期，避免体验矛盾。
4. 以上确认后我出实现方案与任务分解（仍按 PM→架构→工程师→QA 链路）。

---

## 13. 对其他功能 / 权限控制系统的影响分析

**结论：A2 对权限引擎与其他功能零破坏，且行为严格"只增不减"。**

### 13.1 对权限控制系统本身 — 零改动
- 不新增 permission action → `permission_rules` 表、`permissionCatalog`、`canDo`、后台权限矩阵页**全部不动**。
- 不修改 `rbac.assertCan` 语义：仅新增一个**兄弟 helper** `assertGateOwnerOrOverride`，置于 `toggleGateItem`/`decideGate` 内部既有 `assertCan` **之后**。
- 其余 30+ 个 `assertCan` 调用点（项目/WBS/评审/变更/周报/后台等）完全不受影响。

### 13.2 波及范围 — 精确锁定两函数
- 仅 `toggleGateItem`（勾检查项）、`decideGate`（提交门结论）两函数新增守卫。
- 二者**仅**被 `server/routes/milestones.routes.js` 的 HTTP 路由调用（已 grep 核实：`milestone/document/project/review.service` 内相关字样均为注释引用，无内部/定时任务调用方）。
- 因此新校验依赖的 `req.user` 在路由层必有，**不会误伤自动化/调度流程**。

### 13.3 行为变化 — 只增不减（不收窄现有权限）
A2 规则 = `能力 或 责任人 或 override`：
- 当前能操作的人（持有能力者）**权限一个不少**。
- 新增：责任人（即便不在能力清单）可操作；override 可操作。
- ⇒ A2 不会让任何现有操盘者失去权限，**不会卡住既有工作流**，也就不会对"其他功能"产生负向副作用。

### 13.4 ⚠️ 概念性边界（务必心里有数）
**A2 不实现"只有责任角色能操作"的排他性。**
- 因 A2 中"能力"本身是充分条件：例如 `pm`/`qa` 持有 `gate:decide` → 即使不是某门的 `owner_role`，仍能提交（靠能力通过）。（注：`tl` 现已不在 `gate:decide`，故 tl 仅能操作 `owner_role=tl` 的门。）
- A2 保证的是"**责任人一定能动**"（修复了"责任人被锁死"隐患），但**非责任人的能力持有者照样能动**。
- 若目标是"非责任人不能动这道门"，A2 达不到，需改 A1（有自锁风险）或折中 A1.5（要求 `能力 且 (责任人 或 override)`，并以数据纪律保证 `owner_role` 必落在能力清单内避免自锁）。

### 13.5 与周边功能的交互（逐项排查）
- **工作台"待我检查"**：当前按 `gate:decide` 能力过滤。A2 下非责任人能力持有者仍能操作 → 待办展示他们**一致**（真能操作），**不矛盾**。故 §8 工作台改动为"可选"而非"必须"（对比 A1 则会矛盾、必须改）。
- **审计日志**：`decided_by`/`checked_by` 照旧记录操作者，A2 不改。可顺带加"代 <责任角色> 决议"标注（仿 `ReviewStepper`），非必需。
- **空 `owner_role`**：跳过校验，行为不变（安全）。
- **前端**：仅质量门 UI 按钮显隐变化，`can()` 本身不动，全局权限零改动。
- **Mock**：`api/mock/index.ts` 两处须同步加校验，否则 dev 自测失真（§7.3）。

---

## 14. 实现与验证记录（2026-09-14）

### 14.1 改动文件
- `server/middleware/rbac.js`：新增 `assertGateOwnerOrOverride(db, req, ownerRole, projectId, action)`，合并「能力 或 责任人 或 override」三道判定为一道；导出供 gate.service 使用。
- `server/services/gate.service.js`：`toggleGateItem`（`gate:item:check`）、`decideGate`（`gate:decide`）改调上述合并校验。
  - ⚠️ **修复一处实现缺陷**：`decideGate` 原在 `const gate` 声明之前引用了 `gate.owner_role`（TDZ → `Cannot access 'gate' before initialization`），会导致所有 `decideGate` 调用直接抛错。已把 `requireGateRow` 提前到 A2 校验之前。
- `web/src/pages/projects/ProjectOverviewPage.tsx`：提交按钮与检查项勾选改为「能力 或 责任人 或 override」同源判定；责任人显式标注「（你）」；无权限时按钮**禁用并显示 Tooltip**（而非隐藏），避免与后端 owner 放行语义不一致。
- `web/src/api/mock/index.ts`：同步 `assertGateOwnerOrOverrideMock`。
- `gate-owner-enforcement-design.md`：本设计/影响面评估文档。

### 14.2 多角色运行时自测（service 层直连真实 pm.db + HTTP 冒烟）
实测角色取自 live `users` 表，能力取自 live `permission_rules`（2026-09-14）。设门 `owner_role=tl`（tl∉gate:decide）、项1 `owner_role=dev`（dev∉gate:item:check）：

| 端点 | 角色 | 身份 | 期望 | 实际 |
|---|---|---|---|---|
| decideGate | 张磊(pm) | 能力(pm∈gate:decide) | ALLOW | ✅ ALLOW |
| decideGate | 郑志科(tl) | **责任人(tl=owner) 无能力** | ALLOW | ✅ ALLOW（A2 核心路径） |
| decideGate | 何繁(dev) | 非责任人 无能力 | BLOCK 403 | ✅ BLOCK |
| decideGate | 系统管理员 | override | ALLOW | ✅ ALLOW |
| toggleGateItem | 何繁(dev) | **责任人(dev=owner) 无能力** | ALLOW | ✅ ALLOW（A2 核心路径） |
| toggleGateItem | 郑志科(tl) | 能力(tl∈gate:item:check) | ALLOW | ✅ ALLOW |
| toggleGateItem | 林雨萱(ued) | 非责任人 无能力 | BLOCK 403 | ✅ BLOCK |
| toggleGateItem | 系统管理员 | override | ALLOW | ✅ ALLOW |

另跑 HTTP 冒烟（真实门 owner_role=qa，经 `POST /api/projects/:pid/gates/:gid/decide`）：`dev`→403、`admin`→200，确认完整路由链路（鉴权→路由→gate.service A2）在运行态生效。**8/8 全部通过。**

> 注：测试中发现 `赵延锋(member)` 因 `user_roles` 额外持有 `management`，实际具备 `gate:item:check` 能力而被放行——属正确行为，非缺陷。选 `ued` 作阻断用例以排除额外角色干扰。

