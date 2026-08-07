# QA 回归测试报告 · 第四轮增量优化（round4-optimize）

> QA：严过关（software-qa-engineer）｜项目：太空字节 PM 系统（pm-app）｜日期：2026-08-07
> 基线：`571b437`｜验证方式：**实际运行**（Vite SSR 加载真实源码断言引擎/纯函数，UI 层源码核验 + 说明）
> 依据：`web/docs/delta-prd-round4-optimize.md`（验收点）、`web/docs/delta-design-round4-optimize.md`（实现口径）

---

## 0. 实际执行清单（开头结论）

本轮为**独立回归验证**，未盲信工程师自述。实际执行了以下命令（全部在 `C:\Users\xuwen\WorkBuddy\AstrBytes\pm-app\web`，Vite SSR 脚本用 `dangerouslyDisableSandbox` 运行，输出正常）：

| 命令 | 结果 |
|---|---|
| `node scripts/qa_milestone_fixes.mjs` | **119/119 PASS**（回归基线） |
| `node scripts/smoke_engine.mjs` | **104/104 PASS**（引擎冒烟） |
| `node scripts/qa_regression_simplify.mjs` | **48/48 PASS**（WBS 简化回归） |
| `node scripts/qa_round3_optimize.mjs` | **60/60 PASS**（第三轮回归，**修了 5 条过期断言后全绿**，详见 §4） |
| `node scripts/qa_round4_optimize.mjs` | **95/95 PASS**（本轮专项，**新增**，可复用） |
| `npm run typecheck` | **0 错误** |
| `npm run build` | **通过**（1542 modules，dist 产出正常） |

总计实际断言 **426 条**（119+104+48+60+95），**全部通过**；另有 typecheck/build 双绿。

---

## 1. 四套回归套件结果（防前三轮功能回归）

- `qa_milestone_fixes.mjs`：通过 119，失败 0 —— 里程碑时间轴/门控/达成审计语义无回归。
- `smoke_engine.mjs`：断言 104，通过 104 —— 引擎冒烟全绿。
- `qa_regression_simplify.mjs`：QA 断言 48，通过 48（ALL PASS IS_PASS）—— WBS 简化（层级/父子类型/深度/口径 Y）无回归。
- `qa_round3_optimize.mjs`：**初跑 54/59，5 条失败**；经查明为**测试代码过期**（断言仍指向旧的 `ReportsPage.tsx` 表单内部实现与 WBS `navigate` 跳转，而 R4-P0-4 已按 PRD 将表单抽取到 `ReportFormModal.tsx` 并改页内 Modal）。按智能路由规则「测试代码 Bug → 自修」修复后 **60/60 ALL PASS**（新增 1 条「不再 navigate」断言，共 60 条）。详见 §4。

## 2. 新增专项 `qa_round4_optimize.mjs`（95 条断言，按 7 项验收点覆盖）

### 剧本 1：T01 状态自动流转六写路径（P0-3）✅ 全过

**纯函数 `syncNodeStatusFromProgress`（15 条）**
- 强规则：待办/进行中/完成/**待评审/阻塞** 的 progress=100 → `完成`（无条件，人工态也被覆盖）✅
- 弱规则：进行中/完成 progress=0 → `待办`；待办 0 → 不变 ✅
- 弱规则：待办/完成 0<p<100 → `进行中`；进行中 50 → 不变 ✅
- 人工边界：待评审/阻塞 在 progress=0 与 50 时均保留 ✅

**引擎真实 API 六写路径收口（15 条，含父链收敛）**
- ① `createWbsNode`：叶子 100 → 完成；父节点 progress 落库=100、status=完成 ✅
- ② `createWbsNode`：叶子 40 → 进行中；父节点 64（(2×100+3×40)/5）、进行中 ✅
- ③ `updateWbsNode`：叶子 40→0 → 回落待办；父节点 40、进行中 ✅
- ④ `upsertReport`（日志提交）：叶子→100 完成；父节点 100、完成 ✅
- ⑦ `deleteWbsNode`：删除 0 权重叶子后父节点进度不变 ✅
- ⑧ `moveWbsNode`：跨父移动后 t1=(2×100+3×100+4×50)/9=78、t2 变回叶子保留自身存储值 50 ✅

### 剧本 2：父节点进度条保留且=子树加权（P0-2）✅ 全过

- 纯函数 `rollupProgress`：A(2d,100%)+B(3d,0%) → 40；全叶子 100 → 父 100 ✅
- 纯函数 `rollupProgressFlat`：与树形版同算法；叶子返回自身；空集/不存在 id → 0 ✅
- 引擎：createWbsNode/updateWbsNode/日志提交/moveTask 后父节点**落库值**恒等于子树真叶子按 estimateDays 加权 ✅
- UI 源码核验：WbsPage 进度条**全节点渲染**（不在 `isLeaf &&` 条件内，D1 修复生效）；估算列仍保持 isLeaf（设计口径）✅

### 剧本 3：WBS 页内写日志锁定+连续添加（P0-4）✅ 全过

- WbsPage「写日志」不再 `navigate`，改为 `setReportLockNodeId(node.id)+setReportModalOpen(true)` 页内开 Modal；渲染 `<ReportFormModal lockNodeId={reportLockNodeId} keepOpenOnSubmit>`；提交后 `fetchWbs+refreshMilestones` ✅
- ReportFormModal：锁定节点 checkbox `checked={t.selected || locked}` + `disabled={readOnly || locked}`（不可取消）+ `LockOutlinedIcon` + tooltip「由「写日志」进入，该任务已锁定；可继续勾选其他任务」；锁定仅新建态生效 ✅
- **进度值输入不受锁影响**：`disabled={readOnly}` 不含 locked（精确核验 TextField 块）✅
- `keepOpenOnSubmit=true` → 提交后 `reset({week:weekOptions[0], ...})` 且 taskMap 保留 `selected: n.id === lockNodeId`（连续添加）✅
- ReportsPage 换用 Modal 且 `keepOpenOnSubmit={false}`（行为不变）+ `prefillNodeId/prefillLockNodeId` 旧链接兼容 ✅

### 剧本 4：里程碑不自动达成但 taskStats 联动+一键达成（P1-1）✅ 全过

- ① createWbsNode 挂子任务后 M1 `taskStats.progress`=40（实时联动）✅
- ② 日志提交把另一子任务拉到 100 → `taskStats.progress`=100、total=3、done=3（**D3 缺口已修复**：`upsertReport` 补调 `refreshMilestoneStatuses`）✅
- ③ **未点按钮不自动达成**：`doneAt===null && doneBy===null && done===false`（状态仍由时间轴判定）✅
- ④ `updateMilestone({achieved:true})` → `doneAt=today`、`doneBy=当前用户 openId`、`status=已达成`、`done=true` ✅
- ⑤ `moveTask` 拖到「完成」→ M1 `taskStats.progress`=100（看板拖拽联动，`moveTask` 补调 `refreshMilestoneStatuses`）✅

### 剧本 5：残留归零（P0-1）✅ 全过

- `ProjectCreatePage.tsx` 无「有质量门」Chip UI 文案、无「必备」UI 文案（仅注释例外）✅
- 副标题改为「最终分类（决定生命周期模板与默认里程碑）」，不再含「质量门」✅

### 剧本 6：Tooltip / 状态色 / StatusChip / 里程碑来源标识（P0-5 + P1-2）✅ 全过

- WBS 与 ReportsPage 任务树进度条均包 Tooltip「{名} {p}%（{状态}）」✅
- 两处均用 `progressToneOf`；纯函数断言：待办→neutral、进行中→**brand**（与 toneOf 的 warning 解耦）、待评审→warning、完成→success、阻塞→danger、null→neutral ✅
- WBS 节点行 `StatusChip variant="soft"` 全节点可见 ✅
- 里程碑「进行中」来源标识：`showDriven = status==='进行中' && !statusOverride`（人工覆盖时不显示）；`timeDriven = progress===0 && diffDays(startFrom,today)>=0`；灰字「时间驱动/任务驱动」+ tooltip「已到计划起算日 …」✅
- 全完成提示「关联任务已全部完成」+「标记达成」按钮走 `handleAchieve`（`updateMilestone{achieved:true}`）；顶部 Alert 补充「任务全部完成不会自动达成里程碑，需人工确认」✅

### 剧本 7：边界（已拍板）✅ 全过

- `moveTask` 拖「进行中」但 progress=100 → 强规则拉回「完成」（真实 API 验证）✅
- `moveTask` 拖 0% 到「进行中」→ 回落「待办」（真实 API 验证，防脏状态）✅

## 3. typecheck / build

- `npm run typecheck`：`tsc --noEmit` **0 错误** ✅
- `npm run build`：**通过**（vite build，1542 modules，dist 产出正常）✅

## 4. 智能路由判定

### 结论：**Send To: NoOne（全过，无源码 Bug）**

- 四套回归套件 + 本轮专项 + typecheck + build 全部通过，共 426 条断言。
- **无源码 Bug 需要转工程师修复。**
- **自修 1 处测试代码 Bug**（QA 职责内，不属源码问题）：

| 套件 | 初跑 | 失败项 | 定性 | 处理 |
|---|---|---|---|---|
| `qa_round3_optimize.mjs` | 54/59 | R3-5③ WBS「写日志」navigate 断言；R3-6/R3-7②/R3-7④ 表单内部实现断言（指向 `ReportsPage.tsx`） | **测试代码过期**：R4-P0-4 按 PRD 将表单抽取至 `ReportFormModal.tsx`、WBS 写日志改页内 Modal，旧断言仍查旧文件/旧行为 | **自修**：断言改指向 `ReportFormModal.tsx`（`REPORT_SECTION_TITLE.taskAssoc`/只读说明/`disabled={readOnly}`/`editingReport.tasks.map<ReportTaskRef>`），R3-5③ 改为断言页内 Modal（lockNodeId+keepOpenOnSubmit+不再 navigate）→ **60/60 ALL PASS** |

> 该 5 条失败**不是源码回归**：新实现（ReportFormModal 抽取 + 页内 Modal）在专项 95 条断言中已逐一验证正确（锁定/连续添加/编辑只读语义/assemble 原样回传均成立），仅旧测试指向过时。

## 5. 遗留问题 / Known Issues

1. **`qa_round3_optimize.mjs` 已被我修改**（断言目标从 `ReportsPage.tsx` 迁移到 `ReportFormModal.tsx`）。若后续重构再次移动表单文件，需同步更新该套件中的源码核验断言（已在文件注释标注 R4-P0-4）。
2. **moveTask 拖「进行中」但 progress=100 会被强规则拉回「完成」**：PRD 强规则字面语义，主理人已拍板按 PRD 执行（本轮已验证行为正确）；如需「拖回进行中自动降进度」属产品扩展，建议下轮再议（设计文档 §5-2 已记录）。
3. **P2 项未纳入本轮验收**：AdminTemplatesPage 质量门数列（主理人拍板保留）、WBS 编辑弹窗 helperText（P2-2 可选）——与第四轮 P0/P1 范围一致，不影响本轮结论。
4. 测试沙箱提示：Vite SSR 脚本需 `dangerouslyDisableSandbox` 运行（已按此前经验处理，输出完整无截断）。

---

## 6. 结论

**第四轮增量优化（T01~T04，P0×5 + P1×2）验收通过。** 六写路径状态自动流转真联动（叶子+父链收敛、落库回写）、父节点进度条保留且=子树加权、WBS 页内写日志锁定+连续添加、里程碑不自动达成但 taskStats 联动+一键达成、残留归零、Tooltip/状态色/StatusChip、来源标识与两个已拍板边界，全部符合 PRD/设计验收点；前三轮功能无回归。**路由：NoOne。**
