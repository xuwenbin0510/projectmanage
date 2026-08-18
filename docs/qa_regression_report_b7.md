# B7 工时设置 · QA 回归报告

> 版本：B7（方案 A 强制汇总）｜基线：B6 已交付（schema v3 → v4）
> 依据：`docs/B7-增量PRD.md` §4 验收要点（R1~R5）+ `docs/B7-任务分解.md` 验收口径
> 用法：QA 按本清单逐条执行，通过填 `✅`，失败填 `❌ + 现象`，最后一栏备注环境/数据。

---

## 一、B7 新功能用例（R1~R5）

### R1 数据模型：migrationV4 幂等 + 列类型 + 父 NULL

| # | 步骤 | 预期 | 通过 |
|---|------|------|------|
| R1-1 | 全新库启动服务（`DB_PATH=./xxx.db`），查 `schema_migrations` | 含 v4 `connect-v4-wbs-effort-hours` | ✅ |
| R1-2 | `PRAGMA table_info(wbs_nodes)` | 存在 `effort_hours REAL`（可空，默认 NULL） | ✅ |
| R1-3 | **重复启动**同一库 | 不报错、不再重复 ALTER（幂等），`schema_migrations` 仍只有一条 v4 | ✅ |
| R1-4 | 建项生成骨架节点后 `SELECT effort_hours FROM wbs_nodes WHERE 有子节点` | 父节点列为 NULL（骨架根叶子→0，成为父后清 NULL） | ✅ |
| R1-5 | 存量叶子（未填过工时）`SELECT effort_hours` | NULL（展示按 0，不回填） | ✅ |

> R1-3 补充验证：除常规重启外，另模拟「列已存在、迁移未记录」中断场景（删 v4 记录后重启）——`hasColumn` 守卫跳过 ALTER，无 duplicate column 错误，v4 重新记录；全库直查 8 个有子节点父，`effort_hours` 恒 NULL。

### R2 叶子可填「工时(h)」：输入边界 + 双重校验

| # | 步骤 | 预期 | 通过 |
|---|------|------|------|
| R2-1 | 编辑叶子节点，弹窗出现「工时(h)」输入框 | `type=number`、min 0、step 0.5、上限 1000 | ✅（源码核对） |
| R2-2 | 填 `0.5` 保存 | 成功；树重建后回显 0.5 | ✅（API 自动化） |
| R2-3 | 填整数（如 `40`）保存 | 成功；回显 40 | ✅（API 自动化） |
| R2-4 | 填 `0`（或清空）保存 | 成功；按 0 落库并回显 0 | ✅（API 自动化） |
| R2-5 | 填负数（如 `-1`）保存 | 前端 `toast.warning` 提示且**不发请求** | ✅（源码核对 handleSubmit） |
| R2-6 | 填超上限（如 `1001`）保存 | 前端 `toast.warning` 提示且**不发请求** | ✅（源码核对 handleSubmit） |
| R2-7 | 构造请求直接 PATCH 叶子 `{ effortHours: -1 }` | 400 `E_VALIDATION`，不落库 | ✅（API 自动化） |
| R2-8 | 构造请求直接 PATCH 叶子 `{ effortHours: 1001 }` | 400 `E_VALIDATION`，不落库 | ✅（API 自动化） |
| R2-9 | 构造请求直接 PATCH 叶子 `{ effortHours: "abc" }` | 400 `E_VALIDATION`，不落库 | ✅（API 自动化） |
| R2-10 | 编辑已有工时的叶子再打开 | 回显 = 存储值（不丢） | ✅（改名后回显仍 0.5） |

### R3 父节点只读汇总 + 文案

| # | 步骤 | 预期 | 通过 |
|---|------|------|------|
| R3-1 | 编辑有子节点的父节点，「工时(h)」为 disabled 灰显 | 值 = Σ直接子节点存储值（服务端装饰） | ✅（源码核对 + API 值=Σ） |
| R3-2 | helperText 显示「由 N 个子任务汇总」 | N = 直接子节点数（`effortChildCount`） | ✅（源码核对） |
| R3-3 | 悬停 Tooltip | 完整文案「由 N 个子任务汇总：子任务工时之和，不可手填」 | ✅（源码核对） |
| R3-4 | 保存父节点（改名称等） | 请求体**不含** `effortHours`（可抓包/日志确认） | ✅（源码核对 handleSubmit 条件展开；后端直调父带 effortHours 被拒） |

### R4 服务端强制（防绕过）

| # | 步骤 | 预期 | 通过 |
|---|------|------|------|
| R4-1 | 直接调后端 PATCH 有子节点 id `{ effortHours: 999 }` | 400 `E_WBS_EFFORT_PARENT`，message=「有子节点的节点工时由子任务自动汇总，不可手填」 | ✅（API 自动化，message 逐字一致） |
| R4-2 | R4-1 后 `SELECT effort_hours`（该父节点） | 仍为 NULL，未落库 | ✅（DB 直查） |
| R4-3 | 直接调后端 POST 建子节点（父 id 下），父列 `SELECT effort_hours` | 建子后父列清 NULL（此前若存过 0） | ✅（DB 直查） |
| R4-4 | 构造绕过前端改 payload 给父节点带 effortHours | 后端拒绝（R4-1 已覆盖） | ✅（改名+effortHours 同时提交，事务回滚 name 不变） |

### R5 实时重算（同事务）+ 出参

| # | 步骤 | 预期 | 通过 |
|---|------|------|------|
| R5-1 | 叶子 A 工时 0.5 → PATCH 改 2.5 | 保存后父/祖父节点 `effortHours` 立即 = 新 Σ（GET /wbs 校验） | ✅（0.5+2.5→5） |
| R5-2 | 新增一个子节点（工时 3） | 父节点 Σ 实时 +3 | ✅（5+3→8，effortChildCount 2→3） |
| R5-3 | 删除一个子节点（工时 2） | 父节点 Σ 实时 -2 | ✅（8-3→5，effortChildCount 3→2，父列仍 NULL） |
| R5-4 | move 子节点到另一父下 | 原父 Σ 减、新父 Σ 增；原父/新父 `effort_hours` 列均为 NULL | ✅（E 1→0、G 0→1、R 16→6；两父列 NULL） |
| R5-5 | GET /projects/:id/wbs 每个节点 | 含 `effortHours: number` + `effortChildCount: number`，且父 = Σ直接子节点、叶 = 存储值 | ✅（API 自动化 + 全量无 snake_case） |
| R5-6 | create/update 单节点返回、move 全量数组返回 | 均带 `effortHours` / `effortChildCount`，与 listWbs 口径一致 | ✅（create/update/move 均断言） |
| R5-7 | 失败回滚（如叶子缺负责人触发 E_WBS_LEAF_INCOMPLETE） | 事务内不产生半更新（工时/进度均不变） | ✅（工时 7+清 owner → E_WBS_LEAF_INCOMPLETE，effort_hours 未变） |

---

## 二、既有功能回归清单

| # | 回归项 | 步骤 | 预期 | 通过 |
|---|--------|------|------|------|
| R-1 | WBS 增删改移 | 新建任务/子任务、编辑（名称/负责人/估算/状态/类型/里程碑）、删除（含子树）、移动（改父 + 重排编码） | 行为与 B6 一致；wbsCode/level 同步；审计留痕 | ✅（smoke_b3 292 + qa_b7 R5） |
| R-2 | WBS 进度汇总（B3） | 改叶子 progress → 父节点进度 = 子树真叶子按 estimateDays 加权；状态自动流转（100→完成等） | 与 B6 一致；`estimateDays` 口径不变（R6 本期不做） | ✅（smoke_b3 292） |
| R-3 | 里程碑状态 | 关联任务完成度（口径 Y）/ 里程碑日期 / 门控达成 / 状态派生（未开始/进行中/已达成/已逾期） | 与 B6 一致 | ✅（smoke_b3 292） |
| R-4 | 周报（B5） | 列表/详情/暂存/提交/编辑回传（selected/progressAfter 不变）、风险行校验、周报联动任务进度 | 与 B5 一致 | ✅（smoke_b4 79 + qa_b5_verify 31 + qa_b4_edge 116） |
| R-5 | 看板拖拽 | 拖拽改状态（WIP 上限、`move-status`）、看板列配置 | 与 B6 一致；卡片数据仍来自 WBS（新字段不破坏） | ✅（smoke_b3 292） |
| R-6 | 建项骨架（B4） | 新建项目（per-milestone 骨架生成；`estimate_days=0` 根节点） | 骨架 INSERT 无 effort_hours → 默认 NULL，不回归 | ✅（qa_b4_t01_backfill 30 + qa_b7 骨架断言） |
| R-7 | 类型/校验链路 | 叶子完整性（负责人+估算）、R-4 类型锁、W-1 深度、W-2 父子类型、截止日期硬拦截 | 与 B6 一致；新字段不干扰既有校验次序 | ✅（smoke_b3 292 + qa_b7 R5-7） |
| R-8 | 错误码/文案双端 | `E_WBS_EFFORT_PARENT` 前后端逐字一致；`EFFORT_HOURS_MAX=1000` 前后端一致 | 一致 | ✅（server errors.js ↔ web types/api.ts；server enums.js ↔ web enums.ts） |

---

## 三、执行记录

| 轮次 | 日期 | 执行人 | 结果 | 备注 |
|------|------|--------|------|------|
| 1 | 2026-08-09 | 严过关（QA） | ✅ 全绿 | 独立测试库 `b7_qa.db`（端口 3311，未触碰 pm.db）。回归脚本：smoke_b4 79/79、smoke_b3 292/292、qa_b4_edge 116/116、qa_b5_verify 31/31、qa_b4_n5_spotcheck 17/17、qa_b4_t01_backfill 30/30；B7 专项 `qa_b7_verify.mjs` 75/75；`web npx tsc --noEmit` EXIT=0。测试后停服并清理 b7_qa.db*（pm.db 未改动，无 git 提交）。 |

---

## 四、附注（QA 独立结论）

- 首跑 smoke_b4 出现 3 个周报审计失败，定位为**执行方式问题**（脚本 `openDb()` 直查依赖 `DB_PATH` 环境变量，未传时误查 pm.db），按脚本文档约定「同 DB_PATH 起服务 + 跑脚本」复跑即 79/79 全绿，非源码缺陷。
- `qa_b7_verify.mjs` 首跑 2 个失败为**测试断言算术错误**（move F→G 后 G 成为父，存储值 10 被清 NULL、展示 ΣF=1，故父 R=6 而非 15），已自修测试脚本后 75/75 全绿，非源码缺陷。
- 遗留观察（非阻塞）：`assertEffortHours` 对 `p.effortHours` 采用 `Number()` 强转，`true`/`false`/`''`/`null` 会被归一为 0/1 通过校验；与架构文档 `Number(p.effortHours)` 口径一致，且前端 `type=number` 不会产出这类值，风险可接受。R6（进度工时加权）/R7（列表/看板展示）本期不做，符合 PRD Q1/Q2 推荐。
