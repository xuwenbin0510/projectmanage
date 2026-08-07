# QA 回归报告 · 第三轮优化（round3-optimize）

> QA：严过关（software-qa-engineer）｜日期：2026-08-07｜范围：R3-1 ~ R3-11 + 前两轮回归
> 验证方式：**实际运行**（Vite SSR 加载真实源码引擎 + store + 纯函数）+ 源码核验 + 全量回归套件。

## 0) 实际跑了什么（命令清单）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `node scripts/qa_milestone_fixes.mjs` | ✅ 119/119 |
| 2 | `node scripts/smoke_engine.mjs` | ✅ 104/104 |
| 3 | `node scripts/qa_regression_simplify.mjs` | ✅ 48/48 |
| 4 | `npm run typecheck` | ✅ 0 错误 |
| 5 | `npm run build`（tsc --noEmit && vite build） | ✅ 通过（1539 modules，4.94s） |
| 6 | **`node scripts/qa_round3_optimize.mjs`（本轮新增独立脚本）** | ✅ **59/59** |

新增脚本 `scripts/qa_round3_optimize.mjs` 通过 Vite SSR 直接加载真实源码（`src/api/mock/index.ts` 引擎、`src/stores/projectStore.ts`、`src/utils/reportAgg.ts`、`src/utils/member.ts`），逐条验证 R3-1~R3-11 验收点；纯 UI 类验收（Chip/文案/disabled）以源码 diff + 全局 grep 核验（与本项目既有 QA 方法一致，React 组件未做 DOM 渲染）。

---

## 1) 回归套件结果

- `qa_milestone_fixes.mjs`：**119/119 通过**（含 SK-M5 钻取条目数铁律、SK-M7 日期压缩、F-4 极端周期兜底、G 变更单回写重排）
- `smoke_engine.mjs`：**104/104 通过**（Q-1 阶段实体清除、K-1 不生成门、SK-7 覆盖三元组、Q-3 叶子口径）
- `qa_regression_simplify.mjs`：**48/48 通过**（术语禁用词零命中、WBS 2 类型硬约束、建项数量守恒）
- `npm run typecheck`：0 错误
- `npm run build`：通过
- **前两轮功能无回归**。

---

## 2) 剧本验证结果（R3-1 ~ R3-11）

### ✅ R3-1 / R3-9 · 「必备」UI 全量下线
- MilestonesPage 名称列无「必备」Chip（diff 核验）；编辑弹窗无「模板必备」；删除确认统一文案「确定删除「{code} {name}」？关联 WBS 节点会解绑（不删除任务）。该操作不可撤销。」（MilestonesPage.tsx L684）
- ProjectCreatePage：删「必备」Chip、删 `disabled={m.required}`、删「模板必备里程碑不可删除」提示；确认页计数改为「{n} 个里程碑 · 创建后可在里程碑页自由增删改」（L665）；向导 Alert 去「配套质量门」「必备锁删」（L695-697）
- ProjectOverviewPage 无「必备」Chip
- **全局 grep**：五个页面 JSX 可见「必备」文案 = 0（仅注释保留）；引擎 `ms.required=true` 仍随创建写入（血缘保留，R3-1⑥ PASS）

### ✅ R3-2 / R3-10 · 列表日期列 + 已变更标记
- MilestonesPage 仅一列日期「计划日期（到期）」（L349），展示 `currentDate`，「基线日期」列已删
- 引擎验证：创建即基线 `currentDate===baselineDate`；提前改期后 `currentDate` 更新、`baselineDate` 不变 → `changed = currentDate !== baselineDate` 成立（R3-10 弱标记数据源）
- 源码核验：`changed` 为 true 时渲染「已变更」Chip + tooltip「基线 X → 计划 Y（变更单 Z）」（L355-368）；逾期标红（outOfRange / delayDays）保留
- 改期/编辑弹窗基线说明文案「基线日期（创建时原始日期，仅作对比，不是到期日）」到位；顶部 Alert 按 R3-2④ 更新

### ✅ R3-3 / R3-4 ★ 排序 bug 回归（重点）
- **R3-4 真 bug 已修复**：
  - 在 M1(03-01) 与 M3(03-10) 之间插入 03-03 新碑 → `listMilestones` 立即返回 8 个，顺序 `M1@03-01 → M2@03-03 → M3@03-05 → … → M8@03-31`，**新碑立即出现、currentDate 升序、编号连续 M1..Mn**（不再排到 M5 后）✅
  - 重复读取顺序与编号不变（幂等）✅
  - 复现 bug 场景：store 置为不含新碑的陈旧快照 → `refreshMilestones(projectId)` 后新碑进入 store，且顺序 = 引擎 `listMilestones`（与里程碑页一致）✅
  - 源码核验：WbsPage 挂载 effect 含 `refreshMilestones(id)`（L123）+ `fetchReports(id)`（L125）；全项目无按 code 排序里程碑的调用点 ✅
- **R3-3**：引擎节点均携带 `dueDate`；WbsPage 每节点行渲染「截止 {fmtDate(node.dueDate)}」（`fmtDate` 空值回退 `—`）✅

### ✅ R3-5 · WBS 节点日志聚合
- `reportCountByNode`：nodeA 关联 2 条 / nodeB 1 条 / 未勾选行 0 条，**与 ReportsPage「关联任务数」（`tasks.filter(t=>t.selected).length`）口径一致**（selected=true 唯一口径）✅
- `nodeReportsOf`：createdAt 升序、每条含该节点 selected 行（进度 before→after 有源）✅
- 源码核验：徽标 n=0 弱化样式仍可点击（outlined）；「写日志」→ `navigate(ROUTES.projectReports(id), { state: { prefillNodeId: node.id } })`；ReportsPage 消费 `prefillNodeId` + `prefilledRef` 防重复触发 + 自动开新建弹窗并预勾选 ✅
- 详情弹窗展示周次/状态/填报人/提交时间/doneNote/planItems/risks（责任人姓名+截止）/resourceNote + `progressBefore → progressAfter` ✅

### ✅ R3-6 / R3-7 ★ 编辑不丢关联（重点）
- **R3-7 关键回归**：编辑提交（payload.tasks = 原始 `report.tasks` 原样回传）后，`nodeId/progressAfter/selected` 与编辑前**完全一致**、任务行数不变 ✅
- 可改：doneNote / planItems / resourceNote / 风险 description ✅
- 只读保留：周次不随编辑变更（引擎不更新 week）、风险 owner / dueDate 保留 ✅
- 同周多次提交互不影响（r2 的 doneNote 与 progressAfter=60 独立保持）✅
- 反证：非原样回传（从当前 nodes 重建）会清空关联 → 证明「原样回传」机制必要 ✅
- 源码核验：编辑态任务勾选/进度 `disabled`（`readOnly = Boolean(editingReport)`）、周次/责任人/截止日隐藏 input 保持注册、风险行删除/新增在编辑态禁用 ✅
- R3-6：任务关联区固定标题 `REPORT_SECTION_TITLE.taskAssoc`（enums.ts L308）+ 编辑态只读说明 ✅

### ✅ R3-8 · 责任人姓名
- `memberNameOf(members, openId)`：已知 openId → userName；未知 → 回退 openId 原文；空成员/空 openId 不抛异常 ✅
- WbsPage 详情 / ReportsPage 详情与编辑态均走 `memberNameOf(members, rk.owner)` ✅

### ✅ R3-11 · 死分支清理
- 引擎验证：删除 required 碑不再抛 `E_MS_REQUIRED_LOCKED`（删除成功、编号连续）；标记达成不再抛 `E_GATE_NOT_PASSED` ✅
- 源码核验：MilestonesPage `handleAchieve`/`handleDelete` 已无死 catch 分支；ProjectOverviewPage `handleAchieve` 同；`blockersFromError` 保留 `E_GATE_ITEM_INCOMPLETE`（decideGate 仍会抛，契约保留正确）✅

---

## 3) 智能路由判定

**Routing Decision: NoOne（全过，无需转工程师）**

- 源码 Bug：0（R3-4 排序、R3-7 关联保留、R3-5 计数一致性均验证通过）
- 测试代码 Bug：1（`qa_round3_optimize.mjs` 初版断言中 r1 未带风险行导致「风险 description 可改」断言落空；已自修为 r1 携带风险行，属 QA 自修，非源码问题）
- 遗留问题：无阻断性遗留

---

## 4) 观察项（非阻塞，建议后续处理，供 PM/主理人决策）

1. **「质量门」残留 UI（PRD G1 目标相关，但不在本轮 R3-1~R3-11 验收点内）**：
   - `ProjectCreatePage.tsx` L729：向导里程碑行 `{m.gate && <Chip label="有质量门">}`——模板定义仍带 gate（`templates.ts` 16 处），K-1 后引擎建项**不生成门**，用户看到「有质量门」与实际不符。
   - `ProjectCreatePage.tsx` L530：固定副标题「最终分类（决定生命周期模板与质量门）」仍提质量门。
   - 建议：若按 G1「消除必备/质量门残留 UI」目标推进，可在后续小轮清理；本轮未列入验收点，故不阻断。
2. `MilestonesPage.tsx` L360：`dateTip = outOfRange ? rangeTip : changedTip`——当碑**既已变更又超出 planEnd** 时，tooltip 只显示越界提示、不显示「已变更」变更单信息（「已变更」Chip 仍显示，影响极小）。
3. 注释陈旧（不影响行为）：`mock/index.ts` L987 deleteMilestone 注释仍写「必备碑 → E_MS_REQUIRED_LOCKED」；`types/project.ts` L216 注释仍写「锁删」——实际行为已自由删除，建议顺手更新注释。

---

## 5) 结论

- 第三轮优化 6 项（R3-1~R3-11）**全部验收通过**；前两轮回归套件全绿；typecheck/build 通过。
- 重点验证：**R3-4 排序 bug 已修复**（根因 = WbsPage 挂载不刷新里程碑，修复 = 挂载 `refreshMilestones`，实测新碑立即出现/升序/连续/幂等/与里程碑页一致）；**R3-7 编辑不丢关联**（tasks 原样回传，selected/progressAfter/week/责任人/截止日全保留）；**R3-5 日志聚合计数一致**（selected=true 口径与「关联任务数」同源）。
- 新增回归脚本：`scripts/qa_round3_optimize.mjs`（59 断言，可复用为后续回归）。
