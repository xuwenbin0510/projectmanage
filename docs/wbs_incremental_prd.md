# WBS / 里程碑 / 项目模块 · 增量 PRD（基于方案一·极简）

> **文档性质**：增量变更定义（只描述相对「方案一」的 4 项改动），非全盘重设计。
> **基线**：`pm-app/docs/wbs_simplify_prd.md` + `wbs_simplify_arch.md`（方案一已 QA 回归通过，未提交）。
> **落地方式**：本 PRD + 配套 `wbs_incremental_arch.md` 作为 B 方案（PM→架构→工程师→QA）的标准输入，由工程师照文档实现。
> **术语白名单**（延续方案一 SK-10，不引入新概念）：里程碑 / 质量门 / 任务 / 子任务。

---

## A. 变更总览表

| # | 变更 | 类型 | 影响面 | 是否 breaking |
|---|------|------|--------|---------------|
| ① | 新建项目加回「里程碑规划」步：模板默认里程碑带出、名称/日期可编辑、可新增、必备项锁删 | 增强 | `ProjectCreatePage`、契约 `CreateProjectPayload`、`mock/index.ts#createProject` | 否（向后兼容：不传 `milestones` 时仍按模板静默生成） |
| ② | WBS 新建下级任务/子任务时，默认继承父节点已绑定的里程碑 | 增强 | `WbsPage#openCreate`、`mock/index.ts#createWbsNode` | 否 |
| ③ | 子节点 `dueDate` 硬拦截：≤ 上级任务 `dueDate` 且 ≤ 关联里程碑 `currentDate`，否则报错不让存 | 增强（校验） | `mock/index.ts#createWbsNode`/`updateWbsNode`/`moveWbsNode`、`rules.ts`(新增 `validateWbsDeadline`)、`WbsPage`(加 `dueDate` 字段) | 否（新增错误码 `E_WBS_DEADLINE_OVERFLOW`） |
| ④ | 里程碑关联任务计数实时联动 + 钻取入口 | Bug 修复 + 增强 | `MilestonesPage`(挂载刷新 + 钻取 Dialog)、`utils/wbs.ts`(新增 `milestoneTasks`)、`wbsStore`(改动后触发里程碑刷新) | 否 |

---

## B. 各项详细规则

### ① 新建项目：里程碑可配置（带出 + 可全编辑 + 可新增 + 锁删）

**用户故事**：作为项目经理，新建项目时我希望看到模板默认里程碑并可直接调整名称/日期，也能按需新增里程碑；必备里程碑受保护不可删除（仅可改期），非必备项可删。

**行为规则**：
- 向导由当前 4 步（`基本信息 / 分类判定 / 团队组建 / 确认提交`）改为 **5 步**，在第 4 步前插入「里程碑规划」（`STEPS` 见 `ProjectCreatePage.tsx:69`）。
- 「里程碑规划」步内容：
  - 展示模板默认里程碑列表（从 `lifecycle_templates` 读取，按 `definition.milestones[]` 带出 `name` / `date` / `target` / `required` / `code`），**名称与日期默认可编辑**（已确认决策：带出 + 可全编辑）。
  - 每个条目提供「名称」「目标日期」输入框（日期用 `YYYY-MM-DD`）。
  - 提供「+ 添加里程碑」按钮：新增一行空白条目（`required:false`，`code` 由服务端按 `M{max+1}` 生成）。
  - 删除按钮：模板 `required:true` 的条目 **禁用删除**并 tooltip「模板必备里程碑不可删除，仅可改期」；非必备项可删。
- 提交时（`ProjectCreatePage.tsx:286` 的 `payload`）携带 `milestones: MilestoneDraft[]` 传给 `createProject`。
- **向后兼容**：若 `payload.milestones` 为空/不传，`createProject` 维持现状（按模板静默生成），不影响存量流程。

**契约改动**（`api/contract.ts`）：
- `CreateProjectPayload` 增加 `milestones?: MilestoneDraft[]`（可选）。
- 新增 `interface MilestoneDraft { name: string; date: string; target?: string; required?: boolean; code?: string }`。
- 删除 `CreateProjectPayload` 第 52-55 行那段「3 步向导不再配置里程碑」的注释（已过时）。

**后端改动**（`mock/index.ts#createProject`，当前 `@529`）：
- 若 `payload.milestones?.length` 存在，则用它替代模板静默生成：
  - 逐条映射为 `Milestone` 记录；`code` 取 draft.code（模板项）或 `M{max+1}`（用户新增）。
  - `currentDate` / `baselineDate` = draft.date；`required` = draft.required ?? false。
  - 质量门：按 `code` 回查模板门定义，命中则内联生成对应 `quality_gates` + `gate_items`（复用现有门模板逻辑）；用户新增项（`code` 无匹配）无门（与 `createMilestone` 行为一致）。
  - WBS 骨架：每个里程碑仍生成 1 个顶层 `task` 节点并绑 `milestoneId`（保持方案一 per-milestone 骨架）。
- 末尾照旧调 `refreshMilestoneStatuses`。

**待确认（见 §D-Q1）**：模板默认项是否「可全编辑」还是「只读仅可新增」。当前按**已确认决策=可全编辑**实现；若落地时用户改口要冻结默认项，仅需给 draft 加 `locked` 标志并禁用输入框。

---

### ② WBS 下级任务继承上级里程碑

**用户故事**：作为任务负责人，在已绑定里程碑的任务下新建子任务/任务时，希望子节点自动带上父节点的里程碑，不必每层重选。

**行为规则**：
- 新建节点时，`milestoneId` 默认值 = **父节点的 `milestoneId`**；父无绑定则默认空（表单留空，用户可手动选）。
- 前端 `openCreate(parentId)`（`WbsPage.tsx:156`）：`setForm({ ...EMPTY_FORM, parentId, milestoneId: parentNode?.milestoneId ?? '' })`。
- `changeParent`（`:176`）：若切换后的父节点有 `milestoneId` 且当前表单 `milestoneId` 为空，自动填充为父的 `milestoneId`（避免切换父级后丢失继承）。
- 后端 `createWbsNode`（`mock/index.ts:1148`）：`const milestoneId = payload.milestoneId ?? parent?.milestoneId ?? null;`（服务端兜底继承，防止前端绕过）。
- 子任务仍可手动改绑/解绑（表单下拉保留），继承只是默认值。

---

### ③ 子节点 `dueDate` 硬拦截

**用户故事**：作为任务负责人，填写工时/deadline 时，若下级任务的截止日期超过上级任务或所关联里程碑的计划日期，系统应直接拦截，避免排期混乱。

**行为规则**（已确认：硬拦截）：
- 保存节点（新建 / 更新 / 移动）时校验：
  - 若节点有父节点且父节点 `dueDate` 非空 → 节点 `dueDate` 必须 **≤ 父节点 `dueDate`**。
  - 若节点 `milestoneId` 非空且对应里程碑 `currentDate` 非空 → 节点 `dueDate` 必须 **≤ 里程碑 `currentDate`**。
  - 任一不满足 → 抛 `E_WBS_DEADLINE_OVERFLOW`（错误提示：「子任务截止日期不能超过上级任务或关联里程碑的计划日期」）。
- **边界口径（推荐）**：
  - 父节点 `dueDate` 为空 → 跳过父级比对（仅比对里程碑）。
  - 节点为根任务（无父）且未关联里程碑 → 不拦截（无参照系）。
  - 关联里程碑 `currentDate` 为空（未设目标日期）→ 跳过里程碑比对。
  - **仅校验 `dueDate` 字段**（硬约束主口径）；`estimateDays` 工时估算**仅作软提示/告警**，不硬性拦截（用户原话混用两词，按 `dueDate` 为权威约束）。

**实现落点**：
- `api/mock/rules.ts` 新增纯函数 `validateWbsDeadline(child, parent, milestone): { code, message, data } | null`，返回 `E_WBS_DEADLINE_OVERFLOW` 或 `null`（风格对齐现有 `validateWbsPlacement`，见 `rules.ts:414` 的 `WbsPlacementError`）。
- `createWbsNode`（`:1122`）：在 1140 行 placement 校验之后、`dueDate` 落库（`:1171`）之前调用 `validateWbsDeadline`，抛错则 fail-fast。
- `updateWbsNode`（`:1189`）：在 `:1237` 赋值 `dueDate` 前校验（需先解析 `parent`，当前 update 内 `parent` 仅在改类型分支计算，须提升到函数顶部统一计算）。
- `moveWbsNode`：移动到新父下时，对新父重算 `validateWbsDeadline`（防止搬到更紧的父级后越界）。
- 前端 `WbsPage`：`NodeForm`（`WbsPage.tsx:48`）增加 `dueDate: string` 字段 + `EMPTY_FORM` 增加 `dueDate: ''`；表单加 `TextField type="date"`（参考里程碑日期控件）；提交时把 `dueDate` 带入 `WbsNodePayload`（契约已有 `dueDate?`，无需改契约）。

---

### ④ 里程碑关联任务：计数联动 + 钻取

**根因（已核实，非聚合逻辑问题）**：
- `milestoneTaskStats`（`utils/wbs.ts:114`）聚合口径**正确**——收集所有 `milestoneId` 匹配节点的**子树叶子**（含下级子任务），子任务绑不绑都计入。
- 真正 bug：`MilestonesPage` **整个文件无 `useEffect` 挂载刷新**（grep 证实），`refreshMilestones` 仅在自身增删/达成时调用。从 `WbsPage` 绑完任务切过来，store 是旧的 → 关联任务数不更新。且无钻取入口（关联任务列 `:362-373` 不可点）。

**修复规则**：
- **联动**：`MilestonesPage` 挂载时调用 `refreshMilestones(projectId)`（`useEffect(() => { refreshMilestones(projectId) }, [projectId])`）。因 `milestonesWithGate`（`mock/index.ts:234`）每次都用当前 `db.wbsNodes` 实时重算 `taskStats`，挂载刷新即可拿到最新计数。
  - 增强（可选更稳）：`wbsStore` 的 `createNode`/`updateNode`/`deleteNode`/`moveNode` 成功后，调 `useProjectStore.getState().refreshMilestones(projectId)` 主动失效，避免跨页 stale。
- **钻取**：
  - `utils/wbs.ts` 新增 `milestoneTasks(nodes: WbsNode[], milestoneId: string): WbsNode[]` —— 返回所有 `milestoneId` 匹配节点及其子树并集（去重），即该里程碑「管辖」的全部任务（父+子），供列表展示。
  - `MilestonesPage` 关联任务列（`:362`）改为可点击：点击打开 `Dialog`，列出 `milestoneTasks` 返回的任务，每行显示 `名称 / 负责人 / 进度(ProgressBar) / 状态`，并提供「前往 WBS 查看」跳转。
  - 零关联时显示「无关联任务」并禁用钻取。

---

## C. 术语一致性

- 全部新增/修改文案仅使用：里程碑 / 质量门 / 任务 / 子任务。
- 禁止词（沿用 SK-10）：工作分区、工作包、生命周期阶段、归属阶段、阶段推进、锚点。
- 里程碑规划步引导语建议：「模板已带出默认里程碑，可调整名称与日期，也可新增；带 ⛔ 的必备里程碑不可删除。」

## D. 待用户确认的开放问题（≤5 条，均给推荐）

| ID | 问题 | 推荐答案 | 影响 |
|----|------|----------|------|
| **Q1** | 模板默认里程碑是否「可全编辑」还是「只读仅可新增」？ | **可全编辑**（已在上轮 AskUserQuestion 拍板：带出+可全编辑）。原话「默认的也不能修改」与拍板冲突，以拍板为准；若改口冻结，加 `locked` 标志即可。 | 决定 ① 的输入框可编辑性 |
| **Q2** | 父节点无里程碑绑定时，子任务默认？ | 默认空、表单留空，用户手动选（已在 ② 明确）。 | 低 |
| **Q3** | deadline 校验是否同时约束 `estimateDays` 推算的结束日？ | **否**，仅硬约束 `dueDate` 字段；`estimateDays` 仅软提示。 | 低 |
| **Q4** | 钻取展示范围：仅叶子任务 or 含父任务？ | **含父+子**（展示该里程碑管辖的全部节点树），更直观。 | 低 |
| **Q5** | 关联任务计数联动是否额外做「WBS 改动主动失效」？ | 挂载刷新（Fix 1）已足够；「主动失效」（Fix 2）作为增强可选。 | 低 |

## E. 一句话总结推荐

> 新建项目加回「里程碑规划」步（模板带出、可全编辑/新增、必备锁删）；WBS 下级任务自动继承上级里程碑；子节点 `dueDate` 硬拦截（≤上级任务且≤关联里程碑）；修复里程碑关联任务计数挂载刷新并加钻取——4 项改动均向后兼容、不破坏方案一既有模型。

**IS_READY: YES**（5 项确认点均已给推荐答案，无阻塞级歧义；Q1 以已拍板决策为准）。
