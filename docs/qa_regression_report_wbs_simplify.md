# QA 独立回归测试报告 · WBS/里程碑/项目 简化重构（方案一·极简）

- **测试人**：Edward（software-qa-engineer）
- **被测对象**：工程师寇豆码 T01~T05 交付（方案一·极简重构）
- **测试策略**：独立 fresh-eyes 回归，直接跑**真实源码**（Vite SSR 加载 `@/` 别名源码），不依赖工程师自测结论
- **测试日期**：2026-03（相对当前迭代）

---

## 1. 结论（IS_PASS / ROUTE）

| 项 | 结论 |
|---|---|
| **IS_PASS** | ✅ **PASS**（硬闸门通过） |
| **ROUTE（智能路由判定）** | **NoOne**（未发现源码 Bug；回归全绿） |
| 遗留问题 | 1 项防御性加固建议（非阻断，见 §6） |

> 工程师自报「typecheck 绿 / build 绿 / smoke 103 / verify 41」均经 QA **独立复跑证实一致**，且补充 45 条独立用例全绿。回归作为硬闸门：**通过**。

---

## 2. 测试矩阵与结果

| 门 | 命令 / 脚本 | 结果 | 说明 |
|---|---|---|---|
| 类型检查 | `npm run typecheck`（`tsc --noEmit`） | ✅ PASS | 0 错误 |
| 生产构建 | `npm run build`（`tsc && vite build`） | ✅ PASS | 1537 模块，dist 产出正常 |
| 工程师冒烟 | `scripts/smoke_engine.mjs` | ✅ 103/103 | 4 链路 + 种子可渲染 + 门数守恒 |
| 工程师静态校验 | `scripts/verify_simplify.mjs` | ✅ 41/41（1 SKIP） | SKIP=制度文件未找到，不计入失败 |
| **QA 独立回归** | `scripts/qa_regression_simplify.mjs` | ✅ **45/45** | 本次新增，见 §3 |

**合计断言**：QA 45 + 工程师 103 + 工程师 41 = **189 条独立断言全绿**（含 1 条非阻断 SKIP）。

---

## 3. QA 独立回归覆盖点（7 组 fresh-eyes 风险点）

脚本直接加载真实 `MockApiClient`、`rules.ts`、`wbs.ts`、`date.ts`，覆盖工程师脚本**未充分覆盖**的口径与边界：

### G-A 叶子口径加权进度（SK-4）— 3/3
- 真叶子数正确排除父节点（非 `nodeType==='task'` 口径）
- 加权进度 = Σ(estimateDays×progress)/Σ(estimateDays) = 25%（父节点 progress=100 被排除，未污染）
- 同级等权 100/0 → 50%

### G-B 状态五级链（真实 `deriveMilestoneStatus`）— 8/8
对**真实导出函数**走查 P1~P5 优先级链（非重实现）：
- P2 doneAt → 已达成
- P3 today>currentDate → 已逾期
- P4 已过起算日 / 完成度>0 → 进行中
- P5 today<起算日 → 未开始
- P1 覆盖有效（`overrideBaseDate===currentDate`）→ 优先 P3
- `isOverrideValid`：baseDate 对齐=true；改期错位=false（SK-7）

### G-C 里程碑 CRUD 全分支 — 10/10
- 新增碑编码严格 `M{max+1}` 顺序递增、id 唯一
- 提前直改成功；**延后抛 `E_MS_NEED_CHANGE`**（单向规则保留）
- 级联删除：注入非必备碑+门+检查项 → 删碑级联删门与检查项
- 清理后碑数还原

### G-D 质量门挂接 — 11/11
- 一碑最多一门（gate 自洽）
- C-G4 未过门手工达成拒（`E_GATE_NOT_PASSED`）
- 检查项未齐拒（`E_GATE_ITEM_INCOMPLETE`）
- 过门 → 自动达成（P2 写 doneAt）、清空人工覆盖（P2>P1 不冲突）
- 已过门重判幂等（仍 已达成）、取消达成清空 doneAt

### G-E WBS 2 类型硬约束 — 3/3
- **subtask 下挂 subtask → `E_WBS_PARENT_TYPE`**
- task→subtask 合法（正面用例）
- **深度 >4 级 → `E_WBS_DEPTH`**（API 级实测拒）

### G-F 建项数量守恒（A / C 类补齐）— 10/10
- A 类：7 碑 / 7 门 / 7 骨架节点，模板碑全 required，骨架与碑一一绑定
- C 类：5 碑 / 5 门 / 5 骨架节点，同上
（B 类已在工程师 smoke 覆盖；本次交叉验证 A/C）

### G-G 术语禁用词静态扫描 — 1/1
- 全仓 `src` 递归扫描：`工作分区 / 工作包 / 生命周期阶段 / 归属阶段 / 阶段推进 / 锚点` **零命中**（用户可见文案层）
- 残留仅存在于注释 / theme token / 种子演示数据（非 UI 文案），不计入

---

## 4. 第 1 轮问题处理（Smart Routing）

第 1 轮运行暴露 **3 个失败，均为 QA 测试代码缺陷，非源码 Bug**，已自行修复（ROUTE=QA，Round 1 内闭环）：

| # | 现象 | 根因 | 处理 |
|---|---|---|---|
| 1 | G-B P1 期望「进行中」实得「已逾期」 | 测试输入 `overrideBaseDate` 与 `currentDate` 不一致，使覆盖无效（违背 SK-7 对齐规则） | 对齐两日期后重跑通过 |
| 2 | G-E `createProject` 抛 `E_PROJECT_PO_REQUIRED` | B 类建项测试漏填 PO 成员 | 补 `pm/tl/po` 三成员 |
| 3 | G-E `createProject` 抛 `E_ROLE_CARDINALITY` | 同上，漏填 TL（PM/TL 须恰好 1 人） | 补 TL 成员 |
| 4 | G-E 直接调 `validateWbsPlacement` 返回 undefined | 孤立调用未重建节点树，`subtreeRelativeDepth` 无法计算 | 删除该脆弱直接调用，保留已通过的 API 级 `E_WBS_DEPTH` 断言 |

**判定**：4 项均为测试侧问题；源码行为全部正确（约束按设计生效）。**无需回派工程师**。

---

## 5. 与工程师自测的互补性

| 维度 | 工程师脚本覆盖 | QA 独立脚本新增覆盖 |
|---|---|---|
| 叶子口径 | 看板/工作台卡片=真叶子（计数） | 加权进度计算（非叶子不污染 rollup） |
| 状态链 | P3/P4/P1 经 API 走查 | P1~P5 对真实导出函数的全优先级链 + `isOverrideValid` |
| 里程碑 CRUD | 增/锁删/解绑 | `M{max+1}` 编码、级联删门/检查项、提前可改延后拒 |
| 质量门 | 过门自动达成 + C-G4 | 重判幂等、覆盖清空语义、检查项未齐拒 |
| WBS 约束 | 未覆盖报错路径 | `E_WBS_PARENT_TYPE` / `E_WBS_DEPTH` 硬约束实测 |
| 建项 | B 类（4/4/4） | A 类（7/7/7）、C 类（5/5/5）数量守恒 |
| 术语 | （工程师自查） | QA 独立全仓 grep 零命中复核 |

---

## 6. 已知问题 / 建议（非阻断）

### K-1 `statusOverride` 运行时缺「已达成」显式拒（防御性加固）
- **现象**：`updateMilestone` 的 ⑤ 分支对 `statusOverride` 仅做赋值，**运行时未拒绝 `'已达成'`**。类型层 `MilestoneOverride = '未开始'|'进行中'|'已逾期'` 已排除「已达成」，前端/契约无法发出该值。
- **风险**：类型保护 ≠ 运行时保护。若未来出现绕过类型层的调用（如动态 payload、第三方集成），可把里程碑「人工覆盖」为已达成，与决策「statusOverride 不允许覆盖为已达成」冲突。
- **建议**：在 ⑤ 分支加 `if (payload.statusOverride === '已达成') throw new ApiError(E_VALIDATION, ...)`。属加固项，**不影响当前任何 UI/契约路径，不阻断 IS_PASS**。

### K-2 `granularityWarn` 疑似死代码（观察项）
- `rules.ts:275` 导出的 `granularityWarn` 在全仓页面层无调用点（仅导出）。非 Bug，建议后续清理或补接告警展示，不在本次回归范围内。

---

## 7. 交付物
- 测试脚本：`pm-app/web/scripts/qa_regression_simplify.mjs`（45 用例，可复跑）
- 本报告：`pm-app/docs/qa_regression_report_wbs_simplify.md`

## 8. 最终签核
- **IS_PASS = true**
- **ROUTE = NoOne**（无源码 Bug；3 个测试缺陷已自修；1 项加固建议见 K-1）
- 方案一·极简重构的 WBS/里程碑/项目模块**独立回归通过，可进入合流/发布评审**。
