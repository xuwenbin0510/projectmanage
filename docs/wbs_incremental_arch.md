# WBS / 里程碑 / 项目模块 · 增量架构设计 + 任务分解（基于方案一·极简）

> **配套文档**：`wbs_incremental_prd.md`（增量 PRD，4 项变更定义）。本文档为工程师实现提供精确落点与任务顺序。
> **基线**：方案一已落地（`wbs_simplify_arch.md` 现状），未提交。
> **范围**：仅增量改动，不推翻方案一模型（里程碑时间轴 / 任务+子任务 / 质量门挂里程碑 / 派生状态）。

---

## §0 决策回执（来自 PRD + 用户拍板）

| ID | 决策 | 落地口径 |
|----|------|----------|
| D-① | 建项里程碑带出 + 可全编辑 + 可新增 + 必备锁删 | `CreateProjectPayload.milestones?` + `createProject` 优先用传入值；向导加「里程碑规划」步 |
| D-② | 子任务继承父节点里程碑 | `openCreate` 预填 + `createWbsNode` 服务端兜底 `milestoneId = payload.milestoneId ?? parent?.milestoneId ?? null` |
| D-③ | `dueDate` 硬拦截（≤上级且≤里程碑） | 新增 `validateWbsDeadline`，在 create/update/move 落库前 fail-fast；抛 `E_WBS_DEADLINE_OVERFLOW` |
| D-④ | 关联任务计数联动 + 钻取 | `MilestonesPage` 挂载刷新 + 新增 `milestoneTasks` + 钻取 Dialog |

---

## §1 核心技术难点与解法

| # | 难点 | 解法 |
|---|------|------|
| N-1 | ① 向导步数变化要同时动 `STEPS` 常量、步骤渲染分支、`payload` 组装三处，易漏 | 集中改 `ProjectCreatePage.tsx`：① 扩 `STEPS` 数组 ② 新增步骤渲染块 ③ `payload` 组装追加 `milestones`；门与骨架生成复用 `createProject` 既有逻辑 |
| N-2 | ③ deadline 是「子 vs 父 vs 里程碑」三方跨字段校验，不是单节点规则 | 抽独立纯函数 `validateWbsDeadline(child, parent, milestone)`，与 `validateWbsPlacement` 同风格；在 3 个落库点统一调用 |
| N-3 | ④「计数不更新」根因是 store stale，不是聚合错（聚合 `milestoneTaskStats` 已正确） | 挂载刷新即解决；钻取只需新增查询函数 + Dialog，不动聚合 |
| N-4 | ② 前端预填 + 后端兜底双重继承，需保证两处口径一致 | 前端 `openCreate`/`changeParent` 预填；后端 `createWbsNode` 兜底；以服务端为准 |

**技术选型**：零新增依赖（沿用 Vite5 + React18 + MUI5 + TS5.5 + Zustand + dayjs）。本轮为增量增强，引库只扩大回归面。`tsc --noEmit` 为主验收闸。

---

## §2 数据结构与接口变更

### 2.1 契约层（`web/src/api/contract.ts`）
- `CreateProjectPayload`（`:38`）：
  - 删除第 52-55 行过时注释。
  - 增加 `milestones?: MilestoneDraft[];`
- 新增类型（紧邻 `MilestoneCreatePayload` 之后，`:75` 附近）：
  ```ts
  export interface MilestoneDraft {
    name: string;
    /** 目标日期 YYYY-MM-DD，映射到里程碑 currentDate / baselineDate */
    date: string;
    target?: string;
    /** 是否模板必备项（来自模板 definition.milestones[].required） */
    required?: boolean;
    /** 模板项的 code（如 M1）；用户新增项留空，由服务端按 M{max+1} 生成 */
    code?: string;
  }
  ```
- `WbsNodePayload`（`:102`）已含 `dueDate?` 与 `milestoneId?`，**无需改动**。

### 2.2 错误码（`web/src/types/api.ts`）
- `ErrorCode`：新增 `E_WBS_DEADLINE_OVERFLOW: 'E_WBS_DEADLINE_OVERFLOW'`。
- `ERROR_MESSAGE_ZH`：新增 `E_WBS_DEADLINE_OVERFLOW: '子任务截止日期不能超过上级任务或关联里程碑的计划日期'`。

### 2.3 实体字段（无需新增）
- `WbsNode`（`types/wbs.ts`）已有 `dueDate: string`、`milestoneId: string | null`；`Milestone` 已有 `currentDate`、`required`；`MilestoneTaskStats`（`types/project.ts`）已存在，复用。

---

## §3 后端逻辑（`web/src/api/mock/index.ts`）

### 3.1 `createProject`（当前 `@529`）
- 现有逻辑：582-640 用模板静默生成里程碑 + 内联门；647-676 生成 per-milestone WBS 骨架。
- 改动：在生成前判断 `payload.milestones?.length`：
  - **有传入** → 用传入列表替代模板静默生成：
    - 逐条 `map` 为 `Milestone`：`code = draft.code ?? 'M'+(maxExisting+1)`；`currentDate=baselineDate=draft.date`；`required = draft.required ?? false`；`name/target` 取自 draft。
    - 按 `code` 回查模板门定义（`lifecycle_templates.definition.milestones` + 门模板），命中则生成 `quality_gates` + `gate_items`；未命中（用户新增）无门。
    - WBS 骨架照旧：每里程碑 1 个顶层 `task` 绑 `milestoneId`。
  - **无传入** → 维持现状（向后兼容）。
- 末尾照旧 `refreshMilestoneStatuses`。

### 3.2 `createWbsNode`（`:1122`）
- 继承（D-②）：第 1148 行 `const milestoneId = payload.milestoneId ?? null;` → 改为 `const milestoneId = payload.milestoneId ?? parent?.milestoneId ?? null;`
- deadline 校验（D-③）：在 1140 行 `validateWbsPlacement` 之后、1143 行叶子完整性之前（或之后均可，建议放在 placement 之后），插入：
  ```ts
  const deadlineErr = validateWbsDeadline(
    { dueDate: payload.dueDate ?? null },
    parent,
    milestoneId ? db.milestones.find((m) => m.id === milestoneId && m.projectId === projectId) ?? null : null
  );
  if (deadlineErr) throw new ApiError(deadlineErr.code, deadlineErr.message, deadlineErr.data);
  ```
  - 注意：`payload.dueDate` 缺省时在 1171 行补 `addDays(today(),7)`；校验应在补默认值**之前**用传入值判断（用户显式填了超期就拦；不填则不拦，沿用默认）。故校验用 `payload.dueDate`。

### 3.3 `updateWbsNode`（`:1189`）
- 顶部统一解析 `parent`（当前仅在改类型分支 `:1206` 计算，须提升到函数开头，供 deadline 校验复用）。
- `dueDate` 赋值（`:1237`）前加 deadline 校验：
  ```ts
  if (payload.dueDate !== undefined) {
    const dlErr = validateWbsDeadline(
      { dueDate: payload.dueDate },
      node.parentId ? db.wbsNodes.find((n) => n.id === node.parentId) ?? null : null,
      node.milestoneId ? db.milestones.find((m) => m.id === node.milestoneId) ?? null : null
    );
    if (dlErr) throw new ApiError(dlErr.code, dlErr.message, dlErr.data);
    node.dueDate = payload.dueDate;
  }
  ```

### 3.4 `moveWbsNode`
- 移动后对新父重算 `validateWbsDeadline`（防止搬到更紧父级后越界）；失败抛 `E_WBS_DEADLINE_OVERFLOW`。

### 3.5 `milestonesWithGate`（`:234`）—— **无需改动**
- 每次调用已用当前 `db.wbsNodes` 实时 `milestoneTaskStats`，聚合口径正确。④ 的联动靠前端挂载刷新触发本函数重算。

---

## §4 前端页面（`web/src/pages/projects/`）

### 4.1 `ProjectCreatePage.tsx`
- `STEPS`（`:69`）：`['基本信息','分类判定','团队组建','里程碑规划','确认提交']`（4→5 步）。
- 步骤渲染：在「团队组建」与「确认提交」之间新增「里程碑规划」渲染块：
  - 读取模板默认里程碑（通过 `api` 或 store 拿当前 `type` 对应模板 `definition.milestones`）。
  - 状态 `draftMilestones: MilestoneDraft[]` 初始为模板带出项（editable name/date + required 标记）。
  - 每行：名称输入、目标日期 `type="date"` 输入、删除按钮（`required` 项 disabled + tooltip）。
  - 「+ 添加里程碑」按钮：push 一行 `required:false` 空白项。
- `handleNext`（`:233`）、进度条 `STEPS.map`（`:603`）、上一步/下一步按钮（`:618`/`:621`）随步数自适应，无需大改。
- `payload` 组装（`:286`）追加 `milestones: draftMilestones`（仅当用户编辑/新增过才带；否则不传，走兼容静默生成）。

### 4.2 `WbsPage.tsx`
- `NodeForm` 接口（`:48`）增加 `dueDate: string`；`EMPTY_FORM`（`:59`）增加 `dueDate: ''`。
- `openCreate(parentId)`（`:156`）：
  ```ts
  const parentNode = parentId ? flatNodes.find((n) => n.id === parentId) ?? null : null;
  setForm({ ...EMPTY_FORM, parentId, milestoneId: parentNode?.milestoneId ?? '' });
  ```
- `changeParent`（`:176`）：若新父有 `milestoneId` 且当前 `form.milestoneId` 为空，自动填充：
  ```ts
  const pMs = parent?.milestoneId ?? '';
  setForm((f) => ({ ...f, parentId, nodeType: keepType, milestoneId: f.milestoneId || pMs }));
  ```
- 表单区（里程碑下拉 `:428` 附近）新增 `dueDate` 的 `TextField type="date"`（值 `form.dueDate`，`onChange` 写回）。
- 提交（`:207` 起）：`dueDate: form.dueDate || undefined` 带入 `WbsNodePayload`（契约已有）。

### 4.3 `MilestonesPage.tsx`（修复 ④）
- **挂载刷新**：文件顶部新增 `useEffect(() => { if (id) void refreshMilestones(id); }, [id, refreshMilestones]);`（当前全文件无 useEffect，是 stale 根因）。
- **钻取**：
  - 新增 `milestoneTasks` 查询：从 `projectStore` 拿全部 `wbsNodes`（或新增 store getter），调 `utils/wbs.ts#milestoneTasks(nodes, msId)`。
  - 关联任务列（`:362-373`）：整格改为 `Button`/可点击，`onClick` 打开 `Dialog`；Dialog 列出行：名称 / 负责人(`ownerName`) / 进度(`ProgressBar` + `progress%`) / 状态(`status`)；零关联时禁用并显「无关联任务」；提供「前往 WBS」跳转链接。
- `refreshMilestones` 已在 `:63` 引入，复用即可。

### 4.4 `utils/wbs.ts`（新增函数）
```ts
/** 里程碑管辖的全部任务（锚点及其子树并集，去重），供钻取列表 */
export function milestoneTasks(nodes: WbsNode[], milestoneId: string): WbsNode[] {
  const childrenOf = indexChildren(nodes);
  const anchors = nodes.filter((n) => n.milestoneId === milestoneId);
  const collected = new Map<string, WbsNode>();
  const walk = (node: WbsNode, guard: number): void => {
    if (guard > 64) return;
    collected.set(node.id, node);
    for (const k of childrenOf.get(node.id) ?? []) walk(k, guard + 1);
  };
  for (const a of anchors) walk(a, 0);
  return [...collected.values()];
}
```

### 4.5 `web/src/api/mock/rules.ts`（新增函数）
```ts
export interface WbsDeadlineError { code: string; message: string; data?: unknown }
/** 子节点 dueDate 硬拦截：≤ 父 dueDate 且 ≤ 关联里程碑 currentDate */
export function validateWbsDeadline(
  child: { dueDate: string | null | undefined },
  parent: WbsNode | null,
  milestone: { currentDate?: string | null } | null
): WbsDeadlineError | null {
  const cd = child.dueDate;
  if (!cd) return null; // 未填不拦（沿用默认）
  if (parent?.dueDate && cd > parent.dueDate)
    return { code: ErrorCode.E_WBS_DEADLINE_OVERFLOW, message: '子任务截止日期不能超过上级任务', data: { child: cd, parent: parent.dueDate } };
  if (milestone?.currentDate && cd > milestone.currentDate)
    return { code: ErrorCode.E_WBS_DEADLINE_OVERFLOW, message: '子任务截止日期不能超过关联里程碑的计划日期', data: { child: cd, milestone: milestone.currentDate } };
  return null;
}
```
> 日期比较用 `YYYY-MM-DD` 字符串字典序即可（同格式），无需 dayjs。

---

## §5 程序调用流程（时序，关键两条）

### 5.1 建项带里程碑（①）
```
User → ProjectCreatePage(里程碑规划步编辑 drafts) → handleSubmit → api.createProject({...,milestones})
  → mock#createProject: 用 drafts 生成 Milestone[] + 门 + per-milestone 骨架 task
  → refreshMilestoneStatuses → 返回 Project
```

### 5.2 新建子任务继承 + deadline 校验（②③④）
```
User(WbsPage 点「+子任务」) → openCreate(parentId)
  → form.milestoneId 预填 parent.milestoneId（②）
  → 填写 dueDate → 提交
  → api.createWbsNode({parentId, milestoneId(继承), dueDate})
  → mock#createWbsNode:
       validateWbsPlacement(层级) 
       → validateWbsDeadline(子 vs 父 vs 里程碑)（③，越界抛 E_WBS_DEADLINE_OVERFLOW）
       → milestoneId = payload.milestoneId ?? parent?.milestoneId ?? null（②兜底）
       → 落库 → refreshMilestoneStatuses → saveDb
User 切到 MilestonesPage → useEffect 挂载 refreshMilestones（④联动）
  → milestonesWithGate 实时算 taskStats → 关联任务数更新
  → 点击关联任务格 → Dialog(milestoneTasks 列表)（④钻取）
```

---

## §6 任务分解（按实现顺序，含依赖）

| ID | 任务 | 优先级 | 依赖 | 主要文件 |
|----|------|--------|------|----------|
| **T-01** | 契约 + 错误码基线 | P0 | — | `api/contract.ts`(CreateProjectPayload + MilestoneDraft)、`types/api.ts`(E_WBS_DEADLINE_OVERFLOW) |
| **T-02** | 规则函数 | P0 | T-01 | `api/mock/rules.ts`(validateWbsDeadline)、`utils/wbs.ts`(milestoneTasks) |
| **T-03** | 后端引擎 | P0 | T-01,T-02 | `mock/index.ts`(createProject 收 milestones / createWbsNode 继承+deadline / updateWbsNode deadline / moveWbsNode deadline) |
| **T-04** | 前端三页改造 | P0 | T-01,T-03 | `ProjectCreatePage`(5步+里程碑步)、`WbsPage`(继承+dueDate字段)、`MilestonesPage`(挂载刷新+钻取Dialog) |
| **T-05** | 验证 + 术语收口 | P1 | T-04 | `npm run typecheck` + `npm run build` + 补充测试脚本（见 §7）；grep 禁用词零命中 |

**并行建议**：T-02 与 T-03 在 T-01 冻结后可并行；T-04 依赖 T-03 接口稳定。

---

## §7 验证与回归

### 7.1 主验收闸
- `cd pm-app/web && npm run typecheck`（`tsc --noEmit`）必须零错误。
- `npm run build` 通过。

### 7.2 测试要点（建议补 `scripts/qa_incremental.mjs`，沿用 `smoke_engine.mjs` 风格）
- **① 建项里程碑**：传 `milestones`（含编辑模板项 + 新增项）→ 断言生成碑数=传入数、新增项 `code=M{max+1}`、无门；不传 → 兼容静默生成。
- **② 继承**：在绑 M1 的 task 下建子任务 → 断言子任务 `milestoneId === M1`；父无绑 → 子默认 null。
- **③ deadline 硬拦截**：子 `dueDate` > 父 → `E_WBS_DEADLINE_OVERFLOW`；> 里程碑 `currentDate` → 同；父/里程碑为空 → 不拦；边界（仅父空、仅里程碑空）正确。
- **④ 联动 + 钻取**：建任务绑 M2 → 切 MilestonesPage（模拟挂载刷新）→ 断言 M2 `taskStats.total` 包含该任务（含子树）；`milestoneTasks(M2)` 返回该任务及其子树；无绑时返回空。
- **回归**：重跑 `smoke_engine.mjs`（103）+ `verify:simplify`（41）+ `qa_regression_simplify.mjs`（45），确认方案一成果未被破坏。

### 7.3 共享知识（工程师必读）
- SK-A：`dueDate` 缺省时不拦截（沿用 `addDays(today(),7)`），仅用户显式填值才校验。
- SK-B：deadline 比较用字符串字典序（`YYYY-MM-DD` 同格式安全）。
- SK-C：继承以**服务端 `createWbsNode` 兜底**为准，前端预填仅为体验。
- SK-D：④ 根因是 store stale，挂载刷新即解；勿误改 `milestoneTaskStats`（聚合本身正确）。

---

## §8 待确认（与 PRD §D 对齐）
- Q1 模板默认项可全编辑 vs 只读（已拍板=可全编辑，以拍板为准）。
- Q3 仅硬约束 `dueDate`，`estimateDays` 软提示。
- Q4/Q5 钻取范围与联动增强级别（均给推荐，无阻塞）。

> 本设计严格增量，不改动方案一既有数据模型与质量门挂载方式；所有新增均为可选/向后兼容字段与函数。
