# QA 回归验证报告 — WBS / 阶段 / 里程碑关系重构（方案B）

- **验证层级**：独立复核（QA 严过关 / software-qa-engineer），不照抄工程师结论；工程师寇豆码自检 IS_PASS: YES，本报告独立验证
- **验证方法**：esbuild 打包**真实** `mock/index.ts` / `rules.ts` / `fixtures` 到 node 实跑引擎（59 项断言）+ 前端源码静态核查（WbsPage / MilestonesPage / ProjectCreatePage / wbsStore）+ 构建门 + 全仓 grep
- **最终结论**：✅ **IS_PASS: YES**（V-01~V-20 全部 PASS，回归未破坏上轮四改动）
- **ROUTE: NoOne**
- **日期**：2026-08-05

---

## 一、自检清单 V-01~V-20 逐项结果

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| **V-01** | 新建 A 类项目 → 6 个已绑定工作分区 | ✅ PASS | esbuild 实跑 `createProject('A')`：6 个根节点全 `nodeType='stage'`、wbsCode=1..6、`lifecycleStageId`=P-{id}-S1..S6；里程碑 M1~M7 落锚正确（M1→S1/end、M6→S6/mid、M7→S6/end，S6 双里程碑成立） |
| **V-02** | 新建 B 类项目 | ✅ PASS | 骨架 5 个根工作分区（Q-2 per-stage 全量）；B 类 `requireStageBinding=false` → 未绑阶段建工作分区放行（实跑） |
| **V-03** | 新建 C 类项目 | ✅ PASS | 骨架 5 个根工作分区；C 类里程碑 Q-1 安全默认不预置锚（stageId/anchor 全 null，留待补选） |
| **V-04** | task 下点「＋」/ 强行建子 | ✅ PASS | `allowedChildTypes(task)` 返回 `[]`（页面下拉无选项）；实跑 `createWbsNode(parentId=task)` → `E_WBS_PARENT_TYPE`；stage→package→task 正常建链 |
| **V-05** | 根下建 task | ✅ PASS | A/B/C 三类实跑均 → `E_WBS_PARENT_TYPE`（D-2 一致强制） |
| **V-06** | 建第 5 层节点 | ✅ PASS | 构造 level=4 父节点后建子 → `E_WBS_DEPTH`，`data{resultDepth:5, maxDepth:4}` 载荷正确（R-1 先于 R-2 判定，见 rules.ts:374-382） |
| **V-07** | A 类未绑阶段建分区 | ✅ PASS | A → `E_WBS_STAGE_UNBOUND`；B 类同操作放行（实跑） |
| **V-08** | 3 层子树移到第 3 层下 | ✅ PASS | `subtreeRelativeDepth=2` 正确；`moveWbsNode(3层子树→L3节点)` → `E_WBS_DEPTH`（子树整体判定）；空 stage 移入 package → `E_WBS_PARENT_TYPE`；合法移动成功且 wbsCode 重排 |
| **V-09** | 有子节点改类型 | ✅ PASS | `updateWbsNode(pkg, {nodeType:'task'})` → `E_WBS_TYPE_LOCKED`；同值 nodeType 不触发锁（UI 编辑态安全） |
| **V-10** | task 挂里程碑并刷新 | ✅ PASS | `createWbsNode` payload 带 `milestoneId` → 落库；`listWbs` 读回一致（不再硬编码 null，index.ts:1037/1067） |
| **V-11** | 挂别的项目里程碑 | ✅ PASS | 跨项目 `milestoneId` → `E_VALIDATION`；跨项目 `lifecycleStageId` → `E_VALIDATION`；stage 挂 milestone 强制 null |
| **V-12** | 里程碑提前 5 天 | ✅ PASS | 提前直接生效（200），`delayDays` 为负，审计含「日期提前」（实跑 + 审计查询断言） |
| **V-13** | 里程碑延后 5 天 | ✅ PASS | → `E_MS_NEED_CHANGE` + `data.changeDraft{changeType:'milestone_date', targetId, payload.toDate}` 预填正确；纯函数 `milestoneDelayNeedsChange` 延后=true / 提前=false |
| **V-14** | 里程碑页所属阶段 | ✅ PASS | 引擎：`updateMilestone` 补选 stageId/anchor 落库；stageId=null 时 anchor 强制 null；跨项目 stageId → `E_VALIDATION`。前端：MilestonesPage「所属阶段」列 Chip+anchor 徽标（启动/中段/收口）、未归属灰「补选」下拉（:168-234） |
| **V-15** | 删空/非空工作分区 | ✅ PASS | 已绑定非空 → `E_VALIDATION{reason:'stage_not_empty'}`；空绑定分区删除成功且节点消失 |
| **V-16** | 存量种子项目打开 WBS | ✅ PASS | 5 个存量根 stage 全部 `lifecycleStageId=null`（实跑 seed 扫描）；`nodeWarnings` 给「未绑定生命周期阶段，点击编辑补选」黄色告警（utils/wbs.ts:71-73），WbsPage WarningAmberIcon 渲染（:298-302）；`tsc`/`vite build` 全绿无类型错误 |
| **V-17** | 全仓 grep | ✅ PASS | `E_MS_NO_ADVANCE` 仅命中 `docs/wbs_redesign_prd.md`、`docs/wbs_redesign_arch.md`（历史引用）；`E_WBS_PARENT_TYPE` 在 `rules.ts:337,390` 与 `types/api.ts:38,73` 均已实装 |
| **V-18** | 契约一致性 | ✅ PASS | `api-contract.md:1160,1264-1295` §7 已改写为「提前直接生效 / 延后 E_MS_NEED_CHANGE + changeDraft」与 mock 逐条对齐；`:928` `E_STAGE_SEQUENCE` 标注「契约已定义，实现未落地（计划下轮）」；`:619-621` 事务描述含「WBS 阶段骨架节点」；错误码表 4 码齐备 |
| **V-19** | 缓存升版 | ✅ PASS | `db.ts:47` `STORAGE_KEY='pm_mock_db_v3'`；`load()` 读 v3 key，旧 v2 缓存自然失效重建 seed，无 undefined 风险；全仓 src 无 v1/v2 残留（仅 docs 历史文档提及） |
| **V-20** | 全量层级重扫 | ✅ PASS | `createSeedDb()` 43 节点，按 `resolveWbsRules` 逐项目结构校验（R-1/R-2）**0 违规**；P0012 修正验证：1.4「数据接入模块」已提为根级 package、1.4.1 为 task 挂其下、1.3.1 已修为 task 挂 1.3 下、`isCritical` 同步 `1.2||1.4`（1.4=true / 1.3.1=false） |

> 说明：V-20 的「0 违规」指结构合法性（R-1 深度 / R-2 父子类型）。R-6（stage 绑阶段）对存量 5 个根 stage 不适用——架构 §5.1 明确存量 `lifecycle_stage_id` 一律置 NULL 由 UI 黄色告警引导补选（即 V-16），非违规。

---

## 二、引擎实跑证据（esbuild 打包真实源码）

- 方法：`.qa_wbs_engine.ts` import 真实 `@/api/mock/index`（`mockClient`）、`rules.ts`、`fixtures`、`db`，esbuild `--alias:@=./src` 打包，node 实跑（sessionStorage shim）。
- 结果：**59 项断言全部 PASS，0 失败**。覆盖：骨架预生成（A/B/C）、层级校验四错误码、move 子树整体深度、类型锁、删除保护、里程碑方向、WBS 挂里程碑、三态语义、种子扫描、分类回归。
- 临时脚本与产物已删除，未污染仓库。

---

## 三、前端静态核查（读源码接线）

| 项 | 文件:行 | 状态 |
|---|---|---|
| 文案「工作分区」（Alert/按钮/空态/枚举） | `enums.ts:154-158`；`WbsPage.tsx:342,352,360` | ✅ 全页无「阶段」误用文案（仅「生命周期阶段」正确引用） |
| 归属阶段选择器（仅 stage 显、A/C 必填/B 选填） | `WbsPage.tsx:429-450`（label 随 `rules.requireStageBinding`） | ✅ |
| 关联里程碑选择器（仅 package/task 显、写 milestoneId） | `WbsPage.tsx:452-468`（提交 :229 `milestoneId`） | ✅ |
| 类型下拉按父动态过滤（task 下无选项 + 空态提示） | `WbsPage.tsx:153,409-419`（`allowedChildTypes`） | ✅ |
| 前端预校验（复用引擎纯函数） | `WbsPage.tsx:207-218`（`validateWbsPlacement`） | ✅ |
| 未绑定 stage 黄条 + 阶段 Chip + 里程碑旗标 Chip | `utils/wbs.ts:71-73`；`WbsPage.tsx:282-302`（WarningAmber + stage Chip + FlagOutlined ⚑） | ✅ |
| memberOptions 一人多角色去重（上轮 P1-2 不回归） | `WbsPage.tsx:128-135` `Array.from(new Map(members.map(...)).values())` | ✅ 未被破坏 |
| 里程碑页「所属阶段」列 + 补选持久化 | `MilestonesPage.tsx:168-234`（`handleBindStage` → `api.updateMilestone({stageId, anchor})` :61-73） | ✅ |
| 改期弹窗方向文案（提前绿 / 延后橙） | `MilestonesPage.tsx:387-397`（severity success/warning） | ✅ |
| 向导第 4 步模板预填带 stageCode/anchor | `ProjectCreatePage.tsx:213-214`（`d.anchorStage ?? null`，B/C 无则 null） | ✅ |
| 每行「归属阶段+锚点」下拉 | `ProjectCreatePage.tsx:762-806`（tplStages = 模板 stage code） | ✅ |
| 留空不阻断向导 | `ProjectCreatePage.tsx:290-294`（仅校验名称/日期） | ✅ |
| 新增里程碑默认 null + 提示补选 | `ProjectCreatePage.tsx:373-375,774` | ✅ |
| 确认页展示 | `ProjectCreatePage.tsx:872-888` | ✅ |
| wbsStore 透传新字段 | `wbsStore.ts:59-86`（payload 直传 `api.createWbsNode/updateWbsNode`） | ✅ |

---

## 四、回归（上轮创建流程四改动 + 修复项，不得破坏）

| 项 | 验证 | 状态 |
|---|---|---|
| 分类优先级链（改动 D） | esbuild 打包真实 `rules.ts` 穷举 **80 组合**（5 档金额 × 16 特征组合）：mismatch=0、reasons 重复=0、空串=0；阈值 `>=100` 边界正确（99→B、100→A） | ✅ |
| A 合同额受控输入 | `ProjectCreatePage.tsx:468-469` `value={form.contractAmount \|\| ''}` / `Number(...)\|\|0` | ✅ 接线未变 |
| B&C 一人多角色复合键 | `ProjectCreatePage.tsx:283,317,328,624,894`（`${openId}::${role}` / chip key） | ✅ 接线未变 |
| 里程碑三态 | 实跑：undefined→模板 7 条 / []→显式清空 0 条 / 非空→完全覆盖 1 条（含 stageCode→真实 stageId 落库）；无 []→undefined 归一 | ✅ 未回归 |
| D 分类 helperText | `ProjectCreatePage.tsx:472`「大额但特征不明时建议 A 类，自研迭代优先」 | ✅ |
| 上轮 P1-1 ReportsPage 风险责任人去重 | `ReportsPage.tsx:99-100` `ownerOptions` Map 去重 | ✅ 保留 |
| 上轮 P2-1 OverviewPage 人数 | `ProjectOverviewPage.tsx:472` `new Set(members.map(m=>m.userOpenId)).size` | ✅ 保留 |
| `STORAGE_KEY` v3 | `db.ts:47`；全仓 grep v1/v2 仅命中 docs 历史文档，src 零残留 | ✅ |
| `E_MS_NO_ADVANCE` | 全仓 grep 仅 `docs/wbs_redesign_prd.md` / `docs/wbs_redesign_arch.md` 历史引用；`types/api.ts` 已删净 | ✅ |
| `tsc --noEmit` | **EXIT 0**（0 error） | ✅ |
| `vite build` | **1537 modules / 4.36s / BUILD_EXIT=0**（vite.config.ts `emptyOutDir:false` 未动） | ✅ |

---

## 五、问题清单

| 级别 | 问题 | 影响 | 处置 |
|---|---|---|---|
| P0 | 无 | — | — |
| P1 | 无 | — | — |
| P2-1 | `docs/lifecycle/*.json`（草拟版）未按架构 F-06 补 `wbsRules` 字段，仅加了「非运行时生效模板」`_note` 标注 | 纯文档，运行时模板 `fixtures/templates.ts` 已含 `wbsRules`；标注已明示勿据此写代码，不构成数据/行为风险 | 记录，无需代码改动 |
| P2-2 | V-16 描述「可一键补选」，实现为「点击编辑 → 在编辑表单选择归属阶段」，无独立一键按钮 | UX 便利性差异，功能可达 | 记录，非本轮验收阻断项 |

> 注：`E_WBS_DEPTH` 在创建路径上当前规则（`childTypes.task=[]` 必为叶）下实际最大层级为 3，深度上限 4 主要防护 move 子树整体深度与存量/未来数据——R-1 判定已实装且 move 路径实测拦截有效（V-08），符合设计意图（maxDepth 为上限而非必须达成的深度）。

---

## 六、结论

- **IS_PASS: YES** — V-01~V-20 全部通过；引擎 59 项断言 0 失败；前端三页接线完整；构建门（tsc / vite build）全绿；上轮创建流程四改动全部回归通过。
- **ROUTE: NoOne**（无需回修工程师 / 无需改测试自身）。
- 遗留 2 项 P2 均为文档/UX 级记录项，不影响交付。
