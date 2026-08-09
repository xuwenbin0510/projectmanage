# B8 工时登记时机与单位修正 · QA 回归报告

> 版本：B8（语义重构：`effort_hours` 从「创建任务时预填(h)」改为「工作日志提交时登记(人日)并累计到节点」）｜基线：B7 已交付（schema v4 → v5）
> 依据：`docs/B8-增量PRD.md` §4 验收要点（R1~R5）+ `docs/B8-任务分解.md` 验收口径
> 用法：QA 按本清单逐条执行，通过填 `✅`，失败填 `❌ + 现象`，最后一栏备注环境/数据。

---

## 一、B8 新功能用例（R1~R5）

### R1 WbsPage 弹窗移除「工时(h)」+ 只读「累计实际工时（人日）」

| # | 步骤 | 预期 | 通过 |
|---|------|------|------|
| R1-1 | 打开 WBS 任务新建 / 编辑弹窗（源码核对 + 界面反验） | **无**「工时(h)」输入框（整块移除） | ☐ |
| R1-2 | 编辑叶子节点，弹窗展示「累计实际工时（人日）」 | 值 = 服务端 `effortHours`（历次已提交日志累加），helperText「由工作日志累计（只读）」 | ☐ |
| R1-3 | 编辑父节点，弹窗展示「累计实际工时（人日）」 | 值 = Σ直接子节点 + helperText「由 N 个子任务汇总（只读，由工作日志累计）」 | ☐ |
| R1-4 | 新建态弹窗 | 展示「累计实际工时（人日）：0」+「0（提交工作日志后累计）」 | ☐ |
| R1-5 | 创建 / 编辑任务提交 | 请求体**不含** `effortHours` | ☐（源码核对 handleSubmit payload） |
| R1-6 | 构造请求 PATCH/POST WBS 携带 `effortHours` | 400 `E_WBS_EFFORT_WRITE_DISABLED`，message=「工时登记已移至工作日志，WBS 不再支持填写工时」，不落库 | ☐（API 自动化） |

### R2 日志行内「本周实际工时（人日）」输入

| # | 步骤 | 预期 | 通过 |
|---|------|------|------|
| R2-1 | 新建日志，叶子行 | 每行有「本周实际工时（人日）」输入：`type=number`、min 0、step 0.5、上限 100 | ☐（源码核对） |
| R2-2 | 勾选叶子可填 | 可输入 0 / 0.5 / 整数 / 小数（≤2 位） | ☐ |
| R2-3 | 未勾选叶子 | 输入 disabled 灰显（值保留但不提交） | ☐（源码核对 disabled 条件） |
| R2-4 | 父节点行 | 输入恒禁用 | ☐（源码核对 hasChildren 条件） |
| R2-5 | lockMode 进入 | 仅锁定叶子可填，其余 disabled | ☐（源码核对 effectiveLockNodeId 条件） |
| R2-6 | 编辑已提交日志 | 勾选叶子该输入**可编辑**并回显原值（`weekActualDays`），勾选与「完成进度(%)」仍只读（冲正入口） | ☐（源码核对 + API 自动化） |
| R2-7 | 前端校验 | 提交/编辑时负数 / 超 100 / 3 位小数 → toast 提示且**不发请求** | ☐（源码核对 validateActualDays） |
| R2-8 | 后端兜底 | 构造请求 actualDays=-1 / 101 / 100.001 / 'abc' → 400 `E_VALIDATION`，不落库 | ☐（API 自动化） |

### R3 数据模型 + 提交累加

| # | 步骤 | 预期 | 通过 |
|---|------|------|------|
| R3-1 | 全新库启动服务 | `schema_migrations` 含 v5 `connect-v5-report-week-actual-days` | ☐ |
| R3-2 | `PRAGMA table_info(work_report_tasks)` | 存在 `week_actual_days REAL NOT NULL DEFAULT 0` | ☐ |
| R3-3 | `PRAGMA table_info(wbs_nodes)` | `effort_hours` 仍 REAL（语义=累计实际人日，零 DDL） | ☐ |
| R3-4 | **重复启动**同一库 | 不报错、不再重复 ALTER（幂等） | ☐ |
| R3-5 | 提交日志（勾选 A 填 0.5、勾选 B 填 2） | 节点 A 累计 +0.5、B 累计 +2、父 Σ=2.5（DB 直查 + GET /wbs） | ☐（API 自动化） |
| R3-6 | 存草稿（勾选 C 填 3） | `work_report_tasks.week_actual_days=3` 落库但节点累计**不变**（C NULL、父 Σ 不变） | ☐（API 自动化） |
| R3-7 | 出参 | `ReportTaskRow` 含 `weekActualDays`；响应无 snake_case | ☐ |

### R4 编辑冲正（旧扣新加，同事务）

| # | 步骤 | 预期 | 通过 |
|---|------|------|------|
| R4-1 | 编辑已提交日志 A 本周 0.5 → 1.5 | A 累计 = 旧扣 0.5 + 新加 1.5 = 1.5（净 +1.0），父 Σ 同步 +1.0 | ☐（API 自动化） |
| R4-2 | 编辑 A 1.5 → 0.5 | 累计回退 0.5（净 -1.0） | ☐（API 自动化） |
| R4-3 | 编辑 A 0.5 → 0 | 累计 0（净 -0.5），父 Σ 同步 | ☐（API 自动化） |
| R4-4 | 编辑草稿（改 actualDays） | **不冲正**（草稿从未累计） | ☐（API 自动化） |
| R4-5 | 冲正致累计 <0（带外扣减后编辑） | 400 `E_VALIDATION` 整体回滚：节点累计不变、报告旧行 weekActualDays 不变、无半更新 | ☐（API 自动化 + DB 直查） |
| R4-6 | 编辑周次 / 正文 / 风险 | 不影响累计（仅任务行参与冲正） | ☐ |
| R4-7 | 删除日志 | 本期无删除入口（删除扣减=规则预留，复用 applyEffortDelta 负 delta） | ☐（复核无 deleteReport） |

### R5 服务端约束 / 防绕过 / 上限

| # | 步骤 | 预期 | 通过 |
|---|------|------|------|
| R5-1 | 日志提交 / 编辑 actualDays | 0~100、≤2 位小数校验；超限 / 负数 / 非法 → 400 `E_VALIDATION`（message 含「人日」） | ☐（API 自动化） |
| R5-2 | 未勾选行携带 `actualDays` | 400 `E_VALIDATION`（拒绝，save 与 submit 同判） | ☐（API 自动化） |
| R5-3 | 父节点携带 `actualDays` | 400 `E_VALIDATION`（拒绝，防构造请求写父被 Σ 隐藏） | ☐（API 自动化） |
| R5-4 | WBS API 携带 `effortHours` | 400 `E_WBS_EFFORT_WRITE_DISABLED`（create/update 同判，叶与父同判） | ☐（API 自动化） |
| R5-5 | 累计上限 10000 | 9999.5 + 0.5 = 10000 恰好可；10000 + 1 → 400 `E_VALIDATION` 且报告整体回滚 | ☐（API 自动化） |
| R5-6 | 父节点读时 Σ 与 `effortChildCount` | 一致；每节点出参 `effortHours` / `effortChildCount` 为 number | ☐（API 自动化） |
| R5-7 | WBS 写操作不触碰 `effort_hours` | 新建节点列 NULL；有日志叶子改名后值不变；move/delete 后原父/新父列不被清 NULL | ☐（API 自动化 + DB 直查） |
| R5-8 | 叶子成为父后存储值 | 存储值保留（不再清 NULL），展示走 Σ 子；恢复叶子时值重现 | ☐（API 自动化 + DB 直查） |

---

## 二、B8 专项用例清单（qa_b8_verify.mjs 自动覆盖）

- [ ] schema v5 迁移 + `week_actual_days` 列类型/默认值/幂等
- [ ] WBS 任何写携带 `effortHours` → 400 `E_WBS_EFFORT_WRITE_DISABLED`（叶/父/create/update 同判）
- [ ] 构造绕过：改名 + effortHours 被拒且 name 不变（事务回滚）
- [ ] 日志 submit 累加：A=0.5、B=2 → 叶累计 + 父 Σ=2.5
- [ ] 草稿不累加：weekActualDays 落库但节点累计不变
- [ ] actualDays 边界：-1 / 101 / 100.001 / 'abc' → 400；100 与 0.01 合法
- [ ] 未勾选携带 actualDays → 400；父节点携带 actualDays → 400
- [ ] 编辑冲正：0.5→1.5（净 +1.0）/ 回退 / 0.5→0（净 -0.5），父 Σ 同步
- [ ] 编辑草稿不冲正
- [ ] 冲正致累计 <0 → 400 且整体回滚（节点 / 报告旧行均不变，无半更新）
- [ ] 累计上限 10000：恰好可 / 溢出回滚
- [ ] WBS 写不触碰 effort_hours：新节点 NULL、有日志叶子值不变、move/delete 不清父、成父存储保留 / 恢复叶子值重现

---

## 三、既有功能回归清单

| # | 回归项 | 步骤 | 预期 | 通过 |
|---|--------|------|------|------|
| R-1 | WBS 增删改移 | 新建任务/子任务、编辑（名称/负责人/估算/状态/类型/里程碑）、删除（含子树）、移动（改父 + 重排编码） | 行为与 B7 一致；wbsCode/level 同步；审计留痕 | ☐（smoke_b3 292） |
| R-2 | WBS 进度汇总（B3） | 改叶子 progress → 父节点进度 = 子树真叶子按 estimateDays 加权；状态自动流转 | 与 B7 一致；`estimateDays` 口径不变（R6 不做） | ☐（smoke_b3 292） |
| R-3 | 里程碑状态 | 关联任务完成度（口径 Y）/ 里程碑日期 / 门控达成 / 状态派生 | 与 B7 一致 | ☐（smoke_b3 292） |
| R-4 | 周报（B5） | 列表/详情/暂存/提交/编辑回传（selected/progressAfter 不变）、风险行校验、周报联动任务进度 | 与 B5 一致；新增 weekActualDays 字段不破坏既有断言 | ☐（smoke_b4 79 + qa_b5_verify 31 + qa_b4_edge 116） |
| R-5 | 看板拖拽 | 拖拽改状态（WIP 上限、`move-status`）、看板列配置 | 与 B7 一致；卡片数据仍来自 WBS | ☐（smoke_b3 292） |
| R-6 | 建项骨架（B4） | 新建项目（per-milestone 骨架生成） | 骨架 INSERT 无 effort_hours → 默认 NULL，不回归 | ☐（qa_b4_t01_backfill 30 + qa_b8 骨架断言） |
| R-7 | 类型/校验链路 | 叶子完整性、R-4 类型锁、W-1 深度、W-2 父子类型、截止日期硬拦截、工时估算硬拦截 | 与 B7 一致；工时通道关闭不影响既有校验次序 | ☐（smoke_b3 292） |
| R-8 | N5 越权（B4） | 跨项目引用周报 / WBS 节点 | 仍 400 `E_VALIDATION`（project_id 真源校验保留） | ☐（qa_b4_n5_spotcheck 17） |
| R-9 | 错误码/常量双端 | `E_WBS_EFFORT_WRITE_DISABLED` 前后端逐字一致；`WEEK_ACTUAL_DAYS_MAX=100`、`EFFORT_DAYS_CUM_MAX=10000` 前后端一致；`E_WBS_EFFORT_PARENT` 保留定义不再抛出 | 一致 | ☐ |

---

## 四、执行记录

| 轮次 | 日期 | 执行人 | 结果 | 备注 |
|------|------|--------|------|------|
| 1 | 2026-08-09 | 寇豆码（工程侧自测） | ✅ 全绿 | 独立测试库 `b8_qa.db`（端口 3311，未触碰 pm.db）。验证项：`web npx tsc --noEmit` EXIT=0；smoke_b4 79/79、smoke_b3 292/292、qa_b4_edge 116/116、qa_b5_verify 31/31、qa_b4_n5_spotcheck 17/17（N5 越权回归通过）；B8 专项 `qa_b8_verify.mjs` 107/107（含日志累加 / 草稿不累加 / 编辑冲正 / 累计上限 / WBS 写通道关闭 / 未勾选·父节点携带拒绝 / D9-D10 写不触碰）。重复启动同一库幂等（schema v5 不重复应用）。测试后停服并清理 b8_qa.db*（pm.db 未改动，无 git 提交）。 |

---

## 五、附注（工程侧说明）

- `scripts/qa_b7_verify.mjs` 为 B7 历史小时口径脚本，**保留作归档**（B8 后其断言与新人日语义不兼容，勿再执行）；B8 专项请运行 `scripts/qa_b8_verify.mjs`（人日口径 + 日志累加/冲正新用例）。
- `E_WBS_EFFORT_PARENT` 错误码保留定义、不再被任何业务路径抛出（兼容旧客户端/旧 QA）；`EFFORT_HOURS_MAX` 全仓删除（仅历史文档引用）。
- B8-R6（进度加权切累计实际工时）/ B8-R7（列表/看板展示累计工时列）本期不做。
