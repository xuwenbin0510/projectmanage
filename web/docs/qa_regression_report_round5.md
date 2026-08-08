# QA 回归测试报告 · R5（WBS 面板三条交互优化）

- **测试角色**：严过关（Yan）· QA 工程师
- **被测轮次**：R5 增量开发（R5-P0-1 提交后关窗 / R5-P0-2 创建下级上级锁定 / R5-P0-3 账实一致 + 源头拦截）
- **被测范围**：纯前端 mock 走查版 `web/`（Vite + React + TS + MUI + Tailwind），引擎层本轮零改动
- **约束遵守**：✅ 全程只写测试脚本，**未修改任何产品源码**（`ReportFormModal.tsx` / `WbsPage.tsx` / 引擎文件均保持工程交付原状，仅新增 `web/scripts/qa_round5_wbs.mjs`）
- **运行节点**：Node `C:\Users\xuwen\.workbuddy\binaries\node\versions\22.22.2\node.exe`
- **测试轮次**：第 1 轮（脚本静态编写 + 全量运行即全绿，无需进入第 2 轮）

---

## 一、运行结果总表

| 脚本 | 用途 | 断言总数 | 通过 | 失败 | 结论 |
|---|---|---|---|---|---|
| `scripts/smoke_engine.mjs` | 引擎层冒烟（R5 零改动证明） | 104 | 104 | 0 | ✅ ALL PASS |
| `scripts/qa_round4_optimize.mjs` | R4 回归（确认 R5 未破坏 R4 功能） | 95 | 90 | 5 | ⚠️ 5 失败，均为 **R4 脚本断言过期**（非 R5 缺陷） |
| `scripts/qa_round5_wbs.mjs` | **R5 三条 P0 回归（本轮交付物）** | 178 | 178 | 0 | ✅ ALL PASS |

> 说明：R5 测试脚本 178 条断言**全部通过**，直接覆盖三条 P0 的全部验收标准（AC-1.x / AC-2.x / AC-3.x）、硬约束、引擎端到端链路及测试敏感度自证。
> `qa_round4_optimize.mjs` 的 5 条失败发生在 `R4-P0-4`，经逐条源码核验，均为 R5 **有意改变**前 R4 源码契约导致的过期断言，详见第四节。

---

## 二、R5 测试脚本断言分布（`qa_round5_wbs.mjs`）

| 被测文件 / 领域 | 通过 | 失败 | 覆盖重点 |
|---|---|---|---|
| `ReportFormModal.tsx` | 84 | 0 | buildNewTaskRefs 真实执行（账实一致契约）、父行禁用/checked 未动、doSave 关窗分支、effectiveLockNodeId 降级、源头痛点文案 |
| `WbsPage.tsx` | 54 | 0 | keepOpenOnSubmit={false}、lockParent 状态机、上级 Select 锁定逐字文案、openCreate/openEdit 赋值点恰好 2 处、写日志按钮 disabledReason 四分支 |
| `ReportsPage.tsx` | 1 | 0 | 入口 keepOpenOnSubmit={false} 现状不变（RG-2） |
| 引擎端到端 | 31 | 0 | 真实 MockApiClient 走账实一致主链路（RG-1）+ 负向对照 R4 老写法 + AC-3.9 存量不清洗 |
| 硬约束 | 8 | 0 | 引擎红线无 R5 痕迹、SK-4 叶子口径唯一入口、全仓无 keepOpenOnSubmit={true} |
| **合计** | **178** | **0** | |

---

## 三、三条 P0 覆盖与结果

### R5-P0-3 账实一致（★最高优先级）
- **验证手法（不依赖浏览器）**：
  1. **源码契约抽取执行**：从 `ReportFormModal.tsx` 抽取 `buildNewTaskRefs` 函数体原文，剥离 TS 类型注解后，用 `new Function('latestNodesOf','parentIdSet','taskMap', body)` 注入真实 `parentIdSet` 依赖**真实执行**，断言跑出来的结果而非字符串包含（§1）。
  2. **引擎端到端**：真实 `MockApiClient` 走 `createProject`→`createWbsNode`→`submitReport`，复算 `rollupProgressFlat` 独立口径校验（§7）。
  3. **负向对照**：用 R4 老写法（父节点 payload 填 60 并勾选）跑同一链路，证明会复现账实不符（详情 60 ≠ WBS 65），**自证新测试对缺陷敏感**（§7 负向对照，7-23~7-27）。
- **核心断言全部通过**：
  - 父节点 `selected === false`（AC-3.5）
  - 父节点 `progressAfter === 提交前存储进度`（输入 60 → 回传 35）（AC-3.5）
  - 叶子行为不变（用户输入 90 如实落库）
  - 父节点进度 = 叶子加权 `(1*90+1*40)/2 = 65`，≡ `rollupProgressFlat`（AC-3.7）
  - 账实一致：父节点进度未被用户输入 60 污染（AC-3.6）
  - `lockNodeId` 指向非叶 → `effectiveLockNodeId === null` 降级（AC-3.8）
  - 父节点「日志 N」徽标不增长（AC-3.10）、日志详情不展示被丢弃手填值（AC-3.6）

### R5-P0-1 提交 / 存草稿后关窗
- **源码解析断言全部通过**：
  - `WbsPage.tsx` 的 `<ReportFormModal .../>` 传 `keepOpenOnSubmit={false}`（AC-1.1），无隐式 true（AC-1.2）
  - `doSave` 在 `keepOpenOnSubmit===false` 走 `else` 分支调 `onClose()`（AC-1.1/1.2）
  - 关窗前先执行 `onSubmitted(saved)`（fetchWbs + refreshMilestones 保留）（AC-1.4）
  - `WbsPage` 无任何 `navigate(` 调用、未引入 `useNavigate`（AC-1.3）
  - 失败分支仅 `toast.error`，**不调 `onClose()` / `onSubmitted` / reset**（AC-1.5）
  - `open` effect 依赖 `[open]` → 每次重开按最新 lockNodeId 重建 taskMap（AC-1.6/1.7）
  - `ReportsPage` 入口 `keepOpenOnSubmit={false}` 现状不变（RG-2）

### R5-P0-2 创建下级上级锁定
- **源码解析断言全部通过**：
  - 新增 `lockParent` state；`openCreate(parentId)` 有 parentId → `setLockParent(true)`（AC-2.1）
  - 顶部「新建任务」`openCreate("")` → `lockParent=false`（AC-2.7）
  - `openEdit(node)` → `setLockParent(false)`（AC-2.8）
  - 上级节点 Select `disabled={lockParent}`（AC-2.1），`label` 逐字命中「上级节点（已锁定）」/「上级节点」（AC-2.2）
  - helperText 逐字命中统一文案表「由「创建下级任务」进入，上级节点已锁定；如需调整层级，请到该节点「编辑」中修改上级」（AC-2.2）
  - `value`/`onChange` 原样保留；提交 payload 的 `parentId` 直取 `form.parentId`，严格等于入口节点 id（AC-2.3）
  - 里程碑继承锁定范式一字未动；`allowedChildTypes(parent,rules)[0]` 收敛节点类型（AC-2.4/2.5）
  - `setLockParent` 赋值点恰好 2 处（openCreate / openEdit），`NodeForm` 未新增字段（AC-2.8 / 红线）

### R5-P0-3 源头拦截（写日志按钮）
- **源码解析断言全部通过**（`WbsPage.renderNode` 写日志按钮 disabledReason 四分支）：
  - 归档 → `disabledReason='项目已归档'`
  - 有 children 的父节点 → `disabledReason='该任务已有下级，请在具体子任务上记录工作日志'`（与设计 §8.2 文案表**逐字一致**）
  - 叶子 → `disabledReason=''`（可点）
  - Q1 裁定：父节点按钮「禁用置灰」而非条件不渲染（行布局不跳动）

---

## 四、`qa_round4_optimize.mjs` 5 条失败甄别（关键结论）

> **判定：5 条失败均为「R4 脚本断言过期」，不是 R5 源码缺陷。** 不修改历史 R4 脚本（非本轮交付物，且修改会掩盖 R5 的有意变更）。

逐条证据（当前 R5 源码已核验）：

| 失败断言（R4 旧契约） | R5 实际源码（verified） | 结论 |
|---|---|---|
| R4-P0-4② `disabled={readOnly \|\| locked}`（精确子串） | `ReportFormModal.tsx:286` `disabled={readOnly \|\| locked \|\| hasChildren}` — R5 新增 `\|\| hasChildren`，父行禁用（R5-P0-3 父行保护） | 过期：R5 **正确扩展**了禁用范围，锁定叶子仍 checked+disabled |
| R4-P0-4② tooltip「由「写日志」进入，该任务已锁定；可继续勾选其他任务」 | R5 改文案为 §8.2 新口径（父行/降级提示） | 过期：文案随 R5-P0-3 重新设计 |
| R4-P0-4② `const locked = !editingReport && lockNodeId === n.id` | `ReportFormModal.tsx:279` `const locked = !editingReport && effectiveLockNodeId === n.id` | 过期：R5 改走 `effectiveLockNodeId`（AC-3.8 降级机制） |
| R4-P0-4③ 进度输入 `disabled={readOnly}`（锁不影响进度） | `ReportFormModal.tsx:325` `disabled={readOnly \|\| hasChildren}` — 父行进度也禁用 | 过期：R5 **有意**让父行进度不可编辑（R5-P0-3） |
| R4-P0-4④ `keepOpenOnSubmit=true` 分支 + `selected: n.id === lockNodeId` | `ReportFormModal.tsx:245` 保留备用分支但 `WbsPage.tsx:703` 传 `false`；`selected` 改走 `effectiveLockNodeId`（L255） | 过期：R5-P0-1 **有意**改为提交后关窗 |

**功能回归结论**：R4 的核心意图（页内 Modal 替代 navigate、锁定叶子 checked+disabled、ReportsPage Modal 化）在 R5 中**全部保留**；唯一被翻转的是「连续添加」UX 策略（keepOpenOnSubmit true→false），这正是 R5-P0-1 的需求本身。无功能回退。

---

## 五、智能路由判定（Routing Decision）

| 判定项 | 结果 |
|---|---|
| 源码是否存在 Bug（R5 范围内） | ❌ 未发现 |
| 测试代码是否存在 Bug（R5 脚本） | ❌ 178/178 通过，无自修需要 |
| 5 条 R4 失败是否需转工程修 | ❌ 否（属断言过期，非缺陷） |
| **最终路由** | **NoOne（全部通过，直接交付成功报告）** |

> 依据：R5 三条 P0 的 178 条断言全绿，R5 源码契约、设计文案表逐字比对、引擎端到端账实一致均验证通过，且负向对照证明测试对缺陷敏感。无需进入第 2 轮测试。

---

## 六、AC 验证状态矩阵（脚本已验证 vs 浏览器人工走查）

> **S = 脚本已验证**（本论测试可确认逻辑/源码契约正确）；**B = 仅能浏览器人工走查**（视觉/动画/悬停/实际交互残留等无法纯 node 断言）。

### R5-P0-1 关窗（AC-1.x）
| AC | 内容 | 状态 | 说明 |
|---|---|---|---|
| AC-1.1 | 提交/存草稿后关窗（keepOpenOnSubmit=false） | S+B | 源码契约已验证；实际关窗动画需人工 |
| AC-1.2 | 存草稿同样关窗 | S | doSave 共用、存草稿 toast 已验证 |
| AC-1.3 | 提交后不路由跳转、停留 WBS | S+B | 无 navigate 已验证；滚动位置不重置（RG-8）需人工 |
| AC-1.4 | 关窗前先刷新（fetchWbs+refreshMilestones） | S | onSubmitted 调用保留已验证 |
| AC-1.5 | 失败不关窗、仅 toast、内容保留 | S+B | catch 不调 onClose 已验证；实际触发引擎错误看不关窗需人工（RG-6） |
| AC-1.6/1.7 | 每次重开按最新 lockNodeId 重建（无残留） | S+B | open effect [open] 依赖已验证；连续填两条看无残留需人工（RG-7） |

### R5-P0-2 上级锁定（AC-2.x）
| AC | 内容 | 状态 | 说明 |
|---|---|---|---|
| AC-2.1 | lockParent + openCreate 设 true + Select disabled | S | 源码已验证 |
| AC-2.2 | label/helperText 锁定文案逐字 | S | 与设计 §8.2 逐字比对 |
| AC-2.3 | value/onChange 原样、parentId 直取 | S | 源码已验证 |
| AC-2.4 | 里程碑继承锁范式不变 | S | 源码已验证 |
| AC-2.5 | nodeType 收敛 allowedChildTypes[0] | S | 源码已验证 |
| AC-2.6 | validateWbsPlacement 不变 | S | 源码已验证 |
| AC-2.7 | 顶部新建 lockParent=false | S | 源码已验证 |
| AC-2.8 | openEdit 设 false | S | 源码已验证 |

### R5-P0-3 账实一致 + 源头拦截（AC-3.x）
| AC | 内容 | 状态 | 说明 |
|---|---|---|---|
| AC-3.1 | 父节点写日志按钮禁用置灰 | S+B | disabledReason 已验证；置灰视觉需人工（Q1） |
| AC-3.2 | 父节点按钮 Tooltip 文案 | S+B | 文案逐字已验证；Tooltip 悬停需人工 |
| AC-3.3 | 弹窗父行禁用可见（不隐藏） | S+B | disabled/render 已验证；禁用置灰视觉需人工 |
| AC-3.4 | 弹窗父行 Tooltip 文案 | S+B | 文案逐字已验证；Tooltip 悬停需人工 |
| AC-3.5 | payload: 父 selected=false、progressAfter=提交前存储值 | S | buildNewTaskRefs 真实执行 + 引擎端到端 |
| AC-3.6 | 账实一致（详情/快照不污染） | S | 引擎端到端已验证 |
| AC-3.7 | 父进度=rollupProgressFlat 加权 | S | 引擎端到端 + 独立复算一致 |
| AC-3.8 | lockNodeId 非叶降级 | S | effectiveLockNodeId 降级已验证 |
| AC-3.9 | 存量日志编辑不清洗 | S | 引擎端到端已验证 |
| AC-3.10 | 父「日志 N」不增长 | S | 徽标不增长已验证 |
| AC-3.11 | 全根任务有子节点仍可从叶子填报 | S | 能定位叶子行已验证 |

---

## 七、RG-1 ~ RG-10 回归点检 → 具体点击步骤映射

> 下表将设计 T4 回归点检表逐条映射为可执行的人工走查点击步骤。**加粗 RG-1 / RG-4 / RG-6 / RG-7 为重点项**，其底层逻辑已由 `qa_round5_wbs.mjs` 脚本验证（见「脚本验证」列），人工走查仅复核视觉/交互层。

| RG | 点检项 | 脚本验证 | 人工走查点击步骤 |
|---|---|---|---|
| **RG-1** | **账实一致主链路：叶子 30%→90% 提交** | ✅ §7（7-5~7-22） | 1. 打开某项目的 WBS 面板，确认一棵含父 P + 两叶子 A(30%)/B(40%) 的树，父显示 35%；2. 点叶子 A 行「写日志」→ 弹窗打开（上级/父行禁用置灰）；3. 在 A 行勾选并填「完% = 90」、其他行不勾；4. 提交；5. 关窗后看父 P 进度条变为 **65%**；6. 打开父 P 的日志详情，确认**不含** A 之外的被污染行，且 A 详情显示 90%（与 WBS 一致）；7. 父 P 行「日志 N」徽标**不增长** |
| RG-2 | ReportsPage 新建日志（无上下文） | ✅ §5-22 | 1. 进工作日志页，点「新建日志」；2. 选节点后提交；3. 确认弹窗关闭（现状不变）、父行禁用可见 |
| RG-3 | 历史存量日志（已关联父节点） | ✅ §7（7-28~7-31） | 1. 找一条历史日志（其关联列表含某父节点）；2. 点「编辑」；3. 确认父节点关联行仍在、照常展示（不被清洗）、「日志 N」保留历史计数 |
| **RG-4** | **旧链接 `prefillNodeId` 指向父节点** | ✅ §2（effectiveLockNodeId 降级） | 1. 通过旧链接（prefillNodeId=某父节点 id）打开工作日志新建；2. 确认弹窗打开、**不预勾**该父节点；3. 任务区 caption 提示「该任务已有下级，请到具体子任务记录进度」；4. 上级/父行禁止操作 |
| RG-5 | 全根任务均有子节点 | ✅ §4（能定位叶子行） | 1. 构造/选取一棵所有根任务都有子节点的项目；2. 从任意叶子行「写日志」与顶部「新建日志」均正常可填报 |
| **RG-6** | **提交失败（引擎抛错）** | ✅ §5-18（catch 不调 onClose） | 1. 在填报弹窗勾选并填值；2. 制造提交失败（如断网/Mock 抛错）；3. 确认弹窗**不关闭**、已填内容**保留**、仅出现错误 toast（RG-6 视觉层复核） |
| **RG-7** | **连续填报两条不同叶子** | ✅ §5-21（open effect [open]） | 1. 点叶子 A「写日志」→ 勾 A 提交；2. 关闭后点叶子 B「写日志」；3. 确认本次预勾**仅为 B**，无 A 的残留勾选/锁定闪烁（RG-7 残留复核） |
| RG-8 | 滚动位置 | S（AC-1.3 无 navigate） | 1. 深层树滚到底部，点底部某叶子「写日志」；2. 提交关窗后确认滚动位置**不重置**到顶部 |
| RG-9 | 看板/里程碑/工作台 | ✅ 硬约束 §8（引擎零改动） | 1. 比对 R4 与 R5 同一项目在「看板」「里程碑 taskStats」「工作台我的任务」的进度与状态流转，确认一致（本轮零引擎改动即证明） |
| RG-10 | 权限与归档 | ✅ §4-10~4-12 | 1. 无 `report:write` 权限用户登录，确认不渲染「写日志」按钮；2. 归档项目确认按钮渲染条件与行为不变 |

---

## 八、需人工走查清单（脚本无法断言，必须浏览器复核）

1. **弹窗关闭动画**（淡出）：AC-1.1/1.2 关窗动画顺滑、无卡顿/闪烁（D-3 裁定 onClose 刻意不清 lockNodeId 防锁图标闪烁，需肉眼确认）。
2. **Tooltip 悬停**：AC-3.2 父节点写日志按钮 Tooltip、AC-3.4 弹窗父行 Tooltip 悬停可见且文案正确（文案已逐字验证，仅悬停交互需复核）。
3. **禁用置灰视觉**：AC-3.1/AC-3.3 父节点按钮与弹窗父行的「禁用置灰」样式（逻辑 disabled 已验证，置灰配色需肉眼确认 Q1 裁定「禁用置灰而非隐藏」）。
4. **连续填报无残留**：RG-7 实际连续提交两条后第二次预勾仅新节点（逻辑层已验证，交互残留需复核）。
5. **提交失败不关窗**：RG-6 实际触发引擎错误时弹窗不关、内容保留（catch 分支已验证，真实失败场景需复核）。
6. **滚动位置不重置**：RG-8 深树底部填报关窗后滚动位置保持（无 navigate 已验证，位置保持需复核）。
7. **RG-9 跨页一致性**：看板/里程碑/工作台进度与状态在 R4→R5 间无漂移（引擎零改动佐证，建议抽样比对）。

---

## 九、结论

- **R5 三条 P0 验收标准（AC-1.x / AC-2.x / AC-3.x）全部由脚本验证通过**（178/178），账实一致这一最高优先级缺陷修复经「源码契约真实执行 + 引擎端到端 + 负向对照」三重验证，且测试对缺陷敏感。
- **`qa_round4_optimize.mjs` 的 5 条失败为 R4 脚本断言过期**，非 R5 源码缺陷；R4 核心功能在 R5 中保留，仅「连续添加」UX 策略按 R5-P0-1 需求有意翻转。
- **智能路由结论：NoOne** —— 未发现源码 Bug，测试脚本无自修需要，全部通过，直接交付。
- **遗留动作（非缺陷、建议性）**：若团队希望 R4 脚本在未来也保持全绿，可另起一轮清理将 5 条过期断言更新为 R5 新契约（不在本轮 R5 QA 范围内，不修改历史脚本以免掩盖有意变更）。
- **人工走查**：AC 中标注 B 的视觉/动画/悬停/真实交互残留项（见第六节、第八节）需浏览器走查，对应 RG-1/RG-4/RG-6/RG-7 等重点项已给出具体点击步骤。

**交付物**：
1. ✅ 测试脚本 `web/scripts/qa_round5_wbs.mjs`（178 断言，全绿）
2. ✅ 本报告 `web/docs/qa_regression_report_round5.md`
