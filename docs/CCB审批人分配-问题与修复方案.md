# CCB 审批人分配问题：排查结论与修复方案

> 排查日期：2026-09-10 ｜ 状态：**方案评估，未改任何代码**
> 触发问题：延后里程碑计划日期走 CCB 审批，需「公司管理层」审批，但审批人一直是徐文斌

---

## 〇、一句话方案（先看这个）

**给审批模板的每个节点加一个「审批人」字段**，取值二选一：`按角色自动绑定` 或 `指定到具体人`。**就这一个能力。**

| 你的三个诉求 | 怎么满足 | 是否要写新代码 |
|---|---|---|
| 针对**不同项目类型** | 模板本来就按 key 分档（`project:A/B/C` 已在用）；只需给 `ccb` 补上同款 `ccb:<类型>` 回落 | 是，**一行** |
| 每类项目**审批节点可以不同** | 模板本来就存 `chain`（节点列表），每条模板各自定义 | 否，**已有** |
| 每个节点**可指定审批人** | `review_templates` 加 `assignees` 列（与 `chain` 等长），后台每节点一个下拉 | 是，**核心改动** |

**不需要的东西**（均为排查过程中展开的备选，**全部不采用**，勿再纠缠）：新增「或签」审批模式、引擎级「发起人回避／链内去重」规则、复杂多级降级策略。

**配置 ≠ 开发**：具体把哪个节点指定给谁，是**上线后在管理后台点几下**的事，不是开发内容。因此**不必等指定名单确定即可开工**。

**本质一句话**：不是"修好管理层那一步"，而是"**让每个审批节点都能被人显式指定**"——管理层只是受益节点之一。

---

## 一、结论

**问题属实，且范围比现象更广。** 根因是审批引擎在绑定「全局角色」时固定取 `users` 表中 **id 最小**的用户，导致同一个角色永远落到同一人；叠加「提交时无法指定审批人」，用户完全无从干预。

受影响的不只是里程碑改期：**所有 CCB 变更、全部立项审批、正式评审**都走同一套绑定规则，其中「公司管理层」这一角色固定为徐文斌（PMO 亦仅他一人）。

---

## 二、问题定义

### 2.1 现象

- 线上 7 条 CCB 变更评审，最近 6 条（2026-09-08 ~ 09-10）审批链完全同构：

| 时间 | 项目 | PM | PMO | 公司管理层 |
|---|---|---|---|---|
| 09-08 ~ 09-10（6 条） | Pmts0r98o00z1 | 赵延锋 | **徐文斌** | **徐文斌** |
| 09-03（1 条，旧模板） | proj_02199be3 | 王玮 | tl=**徐文斌** / po=郸子怿 | **徐文斌**（pmo 步） |

### 2.2 根因（代码定位）

`server/services/review.service.js` → `buildSteps()`（L228-298）的角色绑定优先级：

```
assignees[idx] 覆盖
  > 项目成员（project_members.project_role === role）
  > 全局角色（roles.scope === 'global'）
  > 全局兜底池（roleCatalog.globalFallbacks()，按 order_no）
```

其中**全局角色**分支的实现是：

```js
db.prepare('SELECT open_id, global_role FROM users ORDER BY id ASC').all()
  .forEach(function (u) {
    const role = toStr(u.global_role);
    if (role && globalByRole[role] === undefined) globalByRole[role] = toStr(u.open_id);
  });
```

即 **按 `users.id` 升序取第一条命中该角色的用户**，取到即锁定，无任何轮转、无发起人回避、无多候选人概念。

对本系统实际数据：

- `management`（公司管理层）主职 3 人：徐文斌(id=27)、秦岭(id=29)、王玮(id=30) → **取 id 最小者 = 徐文斌**；秦岭、王玮永远不会被选中。
- `pmo`（PMO）：`users.global_role` 中无人，仅徐文斌在 `user_roles` 里附加 → **唯一命中 = 徐文斌**。

因此审批人与发起项目、发起人无关，本质是「**谁最早入库谁当审批人**」。

### 2.3 证据

| 证据 | 方式 | 结果 |
|---|---|---|
| 线上真实审批记录 | 拉取 `pm-data` 库副本（db+wal+shm）到本地只读查询 | 7 条 CCB，后 6 条 PMO/管理层均为徐文斌 |
| 全项目推演 | 复刻 `buildSteps` 逻辑，对 11 个项目按当前模板计算 | **11/11** 个项目的 `pmo`、`management` 两步均为徐文斌 |
| 全模板推演 | 遍历全部 active 模板 | 见 3.2，问题覆盖 CCB / 立项 / 正式评审 |

---

## 三、影响面

### 3.1 全局角色候选池 vs 实际选中者

| 角色 | 候选（users.id 升序） | buildSteps 实际选中 | 问题 |
|---|---|---|---|
| `management` 公司管理层 | 24 赵延锋、**27 徐文斌**、29 秦岭、30 王玮、35 张雨婷 | **徐文斌** | 5 名候选长期只用 1 人 |
| `pmo` PMO | **27 徐文斌** | **徐文斌** | 唯一候选人 |
| `cto` 技术负责人 | **24 赵延锋**、27 徐文斌、29 秦岭 | **赵延锋** | 3 名候选只用 1 人 |
| `cho` HR 负责人 | **35 张雨婷** | 张雨婷 | 唯一候选人 |
| `admin` 系统管理员 | **48 系统管理员** | 系统管理员 | — |
| `cpo` 产品负责人 | （无） | 走全局兜底池 | 无候选人，静默兜底 |

### 3.2 各审批模板 → 实际审批人（线上数据推演）

| 模板 | 模式 | 链 | 实际审批人 | 问题 |
|---|---|---|---|---|
| `ccb` CCB 变更评审 | serial | pm → pmo → management | 项目PM → **徐文斌 → 徐文斌** | 后两步同一人，串行形同虚设 |
| `project:A/B/C` 立项审批 | serial | pmo → cto → management | **徐文斌 → 赵延锋 → 徐文斌** | 首尾同一人 |
| `project` / `project:_default` 立项审批 | serial | pmo → management | **徐文斌 → 徐文斌** | **连续两步同一人** |
| `formal` 正式评审 | parallel_veto | pmo → sale → cto → management | **徐文斌** → 项目销售 → 赵延锋 → **徐文斌** | **一人握两张否决票**（一票否决模式下尤其严重） |
| `technical` / `code` | single | tl | 项目成员（正常） | — |
| `pm_only` PM 审批 | single | pm | 项目 PM（正常） | — |

> `formal` 的严重性高于用户最初反馈：`parallel_veto` 是「任一票否决即驳回」，而 pmo 与 management 两票都归徐文斌一人，等于**一人可投两票否决权**。

### 3.3 受影响的业务流程

1. **变更单**：`milestone_date`（里程碑改期）、`requirement_baseline`（需求基线）→ 必走 CCB；工作量 ≥ 3 人日的变更 → 走 CCB。
2. **立项审批**：A / B / C 类项目全部。
3. **正式评审**：立项/需求/设计/验收类（含 `management`、`pmo`、`cto` 步）。
4. **不受影响**：`pm_only`、`technical`、`code`（绑定项目成员，走 project 分支）。

---

## 四、修复方案

### 方案 A：模板固定指定审批人（治理正确 · P0）

**决策依据（D1）**：原设计本意是「任一名管理层审批即可」，但**由发起人指定审批人等于运动员挑裁判**，与变更控制的目的相悖。应采用**模板固定**：由管理员在审批模板中**事先**指定该步审批人，事前约定、可审计、可复现。

**技术方案：复用现成的 `assignees` 覆盖通道**

`buildSteps(db, reviewId, projectId, chain, assignees)` 本身已支持「按步覆盖审批人」（`assignees[idx]` 优先于角色绑定），**无需新增引擎语义**，只需让模板能携带 `assignees`：

| 层 | 改动点 |
|---|---|
| DB | `review_templates` 增列 `assignees TEXT NOT NULL DEFAULT '[]'`（与 `chain` 等长的 JSON 数组，元素为 `open_id`，`null` 表示该步按角色绑定） |
| `review.service.js#getReviewTemplate` | 读取并解析 `assignees` |
| `review.service.js#createReview` | `assignees = p.assignees \|\| tpl.assignees \|\| []`（显式传入仍最高优先，保持既有语义） |
| `admin.routes.js` | `toApiReviewTemplate` 输出 `assignees`；POST / PUT 白名单增加 `assignees`，校验：长度必须等于 `chain`、人必须存在于 `users` 且启用 |
| `AdminReviewTemplatesPage.tsx` | 编辑弹窗每步增加「指定审批人」下拉（默认项「按角色自动绑定」）；`TplForm` 增 `assignees: (string \| null)[]` |
| 审计 | 模板修改走既有 admin 审计留痕（谁把管理层审批人改成了谁，可追溯） |

**关键设计：兜底降级（不可以静默卡死）**

指定人一旦离职/停用，硬绑会让流程永久卡住。因此：

| 场景 | 行为 |
|---|---|
| 指定人不存在 / 已停用 | 回退该步角色绑定，并在审批步骤上标注「模板指定人已失效」 |
| 指定人 = 发起人 | **允许通过**（D3：`pmo` 由本人兼任，自批是业务常态）；仅在审批步骤/记录上标注「发起人自审」留痕，**不拦截、不换人** |
| 同一人被链中多步命中 | **不做去重**（D3：`pmo` 全库仅 1 名候选人，去重会把它顶成「待指派」，反而更糟） |

> **D3 决策（2026-09-11）**：PMO 由徐文斌本人兼任，且**发起人自批被明确接受**。因此原 B1（发起人回避）与 B2（链内去重）**若全局启用会与业务冲突**（`pmo` 剔除本人后无人可补 → 落入兜底池），**降级为不启用**。兜底降级仅保留「指定人失效 → 回退角色绑定」这一条。

**明确不采用**：提交时由发起人临时指定审批人（已否决，见 D1）。

**粒度选择（D2）**：「模板级」指的是**配置存在哪一层**（写进 `review_templates.assignees` 列，而非挂到项目记录上），它和「分几档」是**两个独立的维度**，不要混为一谈：

| 维度 | 含义 |
|---|---|
| 配置层级 | 挂在模板表（模板级）↔ 挂在项目记录（项目级） |
| 分档粒度 | 只配 **1 条**通用模板 ↔ 配 **多条**按类型的模板 |

**关键澄清**：模板级默认只有一条 `ccb`（线上 `review_templates` 中 `key='ccb'` 仅一行，`chain=["pm","pmo","management"]`，全公司 13 个项目共用），此时它**等价于「全公司一人」**。但模板级**本身支持分档**——`project` scope 已有 4 条（`project:A` / `project:B` / `project:C` / `project:_default`），`createReview`（`review.service.js:340`）的查找逻辑就是 `project:<类型> → project:_default` 回落链。给 `ccb` 接同款回落链属于**照抄现成模式**，不是新造轮子。

线上档位依据（非删除项目）：**A 类 2 个、B 类 7 个、C 类 3 个、D 类 1 个**（注意 D 类目前连 `project:D` 都没有，走 `_default`）。

| 粒度 | 机制 | 评价 |
|---|---|---|
| 模板级 · 单条 | 只配 1 条 `ccb`，全公司固定一人 | 最省事；13 个项目都由同一位领导批，只是从「id 最小的徐文斌」变成「有意指定的某人」。**这是初始状态，不必是终态** |
| 模板级 · 按类型分档 | `ccb:A` / `ccb:B` / `ccb:C`（未配的回落 `ccb`） | **推荐**。沿用 `project:A/B/C` 现成回落机制，改动小；将来想细分，后台加一条即生效，零代码改动 |
| 项目级 | `projects` 新增「分管领导」字段 + 项目设置入口 | 最贴合「分管」语义；但项目表当前只有 `pm`、`approved_by`，**无分管领导字段**，且管理层是全局角色、不进 `project_members`，需新增字段与设置入口 |

**推荐做法**：模板级 + 给 `ccb` 接回落链（`ccb:<类型> → ccb`）。初始只配一条 `ccb` 即可跑通（效果＝全公司一人），需要细分时后台加一条 `ccb:A` 就覆盖 A 类，**零代码改动**。

**硬边界（必须让用户知情）**：模板级只能精确到「类别」，**无法区分同类别下的不同项目**。若 B 类那 7 个项目实际分属不同领导，模板级表达不了，必须上项目级。

**影响面**：仅「被配置了 `assignees` 的模板」改变行为；未配置的模板**完全不变**（向后兼容）。
**风险**：低（新增列 + 复用既有覆盖通道，不动绑定优先级）。

---

### 方案 B：引擎级默认分配优化（合理性）—— ⚠ D3 后已降级为不启用

> **状态（2026-09-11）**：因 D3 决策「PMO 由本人兼任、且接受发起人自批」，**B1 与 B2 均不启用**。原因见下，此节保留供将来复盘。

**原目标**：即使用户不指定，默认分配也应合理。

**原改动点**：`buildSteps()` 增加发起人上下文（`initiatorOpenId` / `initiatorUserId`），并引入三条规则：

| 规则 | 内容 | 原拟解决的问题 | D3 后的结论 |
|---|---|---|---|
| B1 发起人回避 | 全局角色候选多人时先剔除发起人再取第一条 | 自己批自己 | **不启用**。`pmo` 全库仅徐文斌 1 名候选人，剔除后无人可补 → 步骤落入全局兜底池，指派错人 |
| B2 链内去重 | 候选人与前序步骤重复则顺延下一候选 | pmo/management 同一人；formal 两票同一人 | **不启用**。同上，`pmo` 无「下一候选」可顺延，去重只会把它顶成「待指派」 |
| B3 轮转 / 负载（可选） | 按「当前待审数量最少」选取 | 长期固定一人 | 维持不做（分配不可预测） |

**结论**：一人身兼多角色（徐文斌同时具 `management` 主职 + `pmo` 附加 + `cto` 附加）在此系统里是**设计常态而非缺陷**，用引擎规则去「错开」它必然与业务冲突。**审批人应当由模板显式指定（方案 A），而不是让引擎去猜。**

**若将来仍想要自动错开**：仅对「候选人数 ≥ 2」的角色启用窄化去重（`management` 有 5 候选，适用；`pmo` 有 1 候选，自动跳过）。记为 P2 可选，本次不做。

**必须同步的点（若日后启用 B）**

- `web/src/api/mock/index.ts#buildSteps`（L555）——前端 mock 模式的同源实现，不同步会造成 mock 与真机行为漂移。
- `scripts/qa_b10_spotcheck.mjs` —— 含 buildSteps 行为的断言。
- `docs/B10-任务分解.md` 中「角色绑定优先级」约定条款需同步修订。

**影响面**：**全部评审类型**（formal / technical / code / ccb / pm_only / project）。
**风险**：中。已有评审的 `review_steps` 是生成时快照，不受影响；但**新发起的所有评审**都会改变审批人。

---

### 方案 C：仅配置层调整（治标）

- 管理后台「审批模板」把 `ccb` 链由 `["pm","pmo","management"]` 改为 `["pm","management"]` —— **可消除「连续两步同一人」的冗余**，但管理层那一步**仍然是徐文斌**。
- 想让管理层落到秦岭/王玮：只能靠调整 `users.id` 顺序或让徐文斌卸任该角色 —— **不可维护，属 hack**。
- **结论：配置层只能减少冗余步骤，解决不了「固定一人」。**

---

### 方案对比

| 维度 | A 模板固定指定人 | B 引擎级优化 | C 配置层 |
|---|---|---|---|
| 解决「一直是徐文斌」 | 是（事前指定） | 是（默认即合理） | **否** |
| 解决「自己批自己」 | **允许**（D3：PMO 兼任者自批是常态），仅留痕 | — （B1 不启用） | 否 |
| 解决「一人两票」 | 由模板**显式指定他人**规避 | — （B2 不启用） | 部分（去掉冗余步） |
| 契合变更治理（不由发起人定） | **是** | 是 | 是 |
| 改动范围 | 模板配置 + 引擎读取模板 | 审批引擎全链路 | 后台配置 |
| Mock / QA 同步成本 | 低 | **中高** | 无 |
| 风险 | 低 | 中 | 极低 |
| 建议优先级 | **P0** | P1（作为 A 的兜底实现） | 可随手做 |

---

## 五、推荐路线

1. **P0 — 方案 A（模板固定指定审批人）+ `ccb:<类型>` 回落链**：给 `review_templates` 增加 `assignees`，管理后台按步固定审批人；同时给 `ccb` 接上 `ccb:<类型> → ccb` 回落（D2 定档为按项目类别）。兜底降级**仅保留「指定人失效 → 回退角色绑定」**。改动收敛在「模板配置 + 引擎读取模板」，不动角色绑定优先级，向后兼容。
2. **P1 — 已取消**：原「B1 发起人回避 + B2 链内去重」因 D3 决策（PMO 由本人兼任、接受发起人自批）**不启用**。「一人身兼多角色」由模板显式指定他人来规避，不靠引擎规则猜。
3. **P2 — 若确需「任一名管理层审批即可」**：给该步配多个候选人 + 新增 any-of（或签）模式。这是对原始设计意图的忠实实现，属引擎级改动，按需再定。

---

## 六、待决策点

| # | 问题 | 状态 / 影响 |
|---|---|---|
| D1 | 「公司管理层审批」的业务语义 | **已决（2026-09-10）**：采用**模板固定指定分管领导**，**不由发起人指定**。原始「任一名即可」的实现缺口（引擎无「或签」模式，退化为取第一人）记录为 P2 |
| D2 | 「模板固定」的粒度 | **已决（2026-09-11）**：**按项目类别分档**（`<场景>:<类型>`），不做项目级。设计见第七节 |
| D3 | `pmo` 是否由徐文斌一人兼任？若发起人正是他，链条怎么走？ | **已决（2026-09-11）**：`pmo` 由本人兼任，**发起人自批被明确接受**。→ 原 B1/B2 降级为不启用；兜底仅保留「指定人失效 → 回退角色绑定」；自审只在审批记录留痕、不拦截 |
| D4 | 本次修复范围 | **已决（2026-09-11）**：立项审批（`project:*`）+ 变更单（`ccb:*`）两类场景纳入；`formal` 正式评审**延后至后续轮次，本次不做**（其「一人握两票」问题留待彼时一并治理） |

---

## 七、模板级分档设计（D2 定档：按项目类别）

### 7.1 目标形态：2 场景 × 4 类 + 兜底

| 场景 | 触发点 | 分档后模板 key | 现状 |
|---|---|---|---|
| 项目**创建**（立项审批） | `project-flow.service.js:181` | `project:A` / `project:B` / `project:C` / `project:D`，兜底 `project:_default` | **已有 A/B/C/_default**，D 缺 |
| 项目**修改**（变更单 CCB） | `change.service.js:250` | `ccb:A` / `ccb:B` / `ccb:C` / `ccb:D`，兜底 `ccb` | **只有通用 `ccb`**，需接回落链 |

其余场景（`formal` / `technical` / `code` / `pm_only`）**不分档**，保持现状。合计新增约 5 条模板（`ccb:A\|B\|C\|D` + 可选 `project:D`），**全部可在管理后台创建，无需改代码**。

解析规则（照抄 `review.service.js:340` 对 project 的写法）：

```js
const dbTpl = getReviewTemplate(db, 'ccb:' + type) || getReviewTemplate(db, 'ccb');
```

### 7.2 每个节点能否单独指定人 —— 能，且逐节点独立

**引擎已支持，且是「按链位置」对应**（`review.service.js:264-266`）：

```js
return roleList.map(function (role, idx) {
  let openId = mappers.toStr(assigneeList[idx] || '');  // ① 位置优先：指定到人
  if (!openId) openId = membersByRole[role] || '';       // ② 按角色自动绑定
  ...
});
```

所以每个节点是**二选一**，互不影响：

| 节点配置 | 存的值 | 效果 |
|---|---|---|
| 按角色自动 | `null` | 沿用现有绑定规则（项目成员 → 全局角色 → 兜底池） |
| 指定到人 | `open_id` | 固定指派给这个人 |

数据形态示例（假设 `ccb:B` 模板）：

```
chain     = ["pm", "pmo", "management"]
assignees = [null, null, "ou_wangwei"]    // PM 自动、PMO 自动、管理层指定王玮
```

**为什么继续用「位置数组」而非「角色→人 映射」**（修正 4.1 中的原提法）：引擎现有实现就是索引制（`assigneeList[idx]`），Mock 亦同构（`assignees?.[idx]`）。改角色映射要同时动引擎 + Mock + QA 三处，收益仅是「链改序时不错位」。索引制的错位风险用**后台侧三条约束**即可封死：

| 约束 | 规则 |
|---|---|
| 长度对齐 | 保存时把 `assignees` 规范化为与 `chain` 等长（不足补 `null`、超出截断） |
| 候选人校验 | 第 i 位的 `open_id` 必须是第 i 位角色的有效候选人（`users.global_role` 或 `user_roles` 命中该角色），否则 `E_VALIDATION` |
| 改链即置空 | `chain` 第 i 位角色发生变化时，该位 `assignees` 自动置 `null`（防止「换了角色却留着不相干的人」） |

### 7.3 管理后台交互（`AdminReviewTemplatesPage.tsx`）

把现在的「角色链」编辑升级为**逐节点两列**：

| 节点 | 角色（下拉） | 审批人（下拉） |
|---|---|---|
| 1 | `pm` | 按角色自动 ▾ |
| 2 | `pmo` | 按角色自动 ▾ |
| 3 | `management` | 王玮 ▾ |

- 角色下拉选项 = `ALLOWED_CHAIN_ROLES`（复用 `admin.routes.js:517`）
- 审批人下拉首项固定为「按角色自动」（存 `null`），其后为**该角色的有效候选人**
- 需新增只读接口 `GET /api/meta/role-candidates?role=<key>`：后端按 `buildSteps` 同款规则计算候选池，保证「下拉里能选的人」=「引擎真能派的人」

### 7.4 改动清单

| 层 | 文件 | 改动 |
|---|---|---|
| DB | `server/dal/migrations.js` | `review_templates` 增列 `assignees TEXT`（JSON 数组，`NULL` = 全按角色） |
| 引擎 | `server/services/review.service.js` | ① `getReviewTemplate` 读 `assignees`；② `createReview` 以 `p.assignees \|\| tpl.assignees` 传入 `buildSteps`；③ **新增 `ccb:<类型>` 回落**（照抄 L340） |
| 后台 | `server/routes/admin.routes.js` | ① `toApiReviewTemplate` 输出 `assignees`；② create/update 字段白名单加 `assignees` + 上述三条校验 |
| 元数据 | 新增 `GET /api/meta/role-candidates` | 按角色返回候选人（供下拉取数） |
| 前端 | `web/src/types/project.ts` | `ReviewTemplateConfig` 与 Create/Update payload 增 `assignees` |
| 前端 | `web/src/pages/admin/AdminReviewTemplatesPage.tsx` | 角色链编辑 → 逐节点「角色 + 审批人」 |
| Mock | `web/src/api/mock/index.ts`、`web/src/api/mock/fixtures/reviews.ts` | 模板增 `assignees`；`buildSteps` 行为对齐真机 |
| QA | `scripts/qa_b10_spotcheck.mjs` | 扩展现有 S4 `assignees` 断言 |

**降级规则（仅一条）**：指定人不存在或已停用 → 回退该节点角色绑定，并在审批步骤标注「模板指定人已失效」。**发起人自审（D3）允许通过**，仅留痕标注，不换人、不拦截。

### 7.5 能力缺口：无「或签」模式（**非本次范围**）

`mode` 只有 `serial` / `parallel_veto` / `single`。若某节点希望表达「3 位管理层任一批了即通过」，现引擎**无法表达**，只能退化为「指定到 1 个人」。要忠实实现需新增 `any_of` 模式（P2）。**在或签落地前，「公司管理层」这一步只能落 1 人。**

---

## 八、回归与验证清单（改动落地时执行）

- [ ] `scripts/qa_b10_spotcheck.mjs` 全绿（含 S4 assignees 覆盖断言）
- [ ] mock 与真机行为一致性（`web/src/api/mock/index.ts#buildSteps`）
- [ ] 浏览器冒烟：后台把 `ccb` 的管理层步骤固定为某人 → 发起里程碑改期变更 → 提交审批 → 审批页显示为**指定人** → 审批通过 → 实施 → 里程碑 `planned_date` 正确变更
- [ ] 各模板分别验证：`ccb` / `project:A|B|C` / `formal` / `pm_only` / `technical`
- [ ] 边界：模板指定人不存在 / 已停用 / 等于发起人 → 均回退角色绑定并显式标注（**不得卡死**）
- [ ] 边界：`assignees` 长度与 `chain` 不一致 → 报 `E_VALIDATION`
- [ ] 未配置 `assignees` 的模板行为与改动前逐字段一致（向后兼容）
- [ ] 审计留痕可见、通知收件人正确
- [ ] 存量数据不受影响（已生成 `review_steps` 为快照）

---

## 附录：涉及文件清单

**后端**
- `server/services/review.service.js`（`buildSteps` / `createReview`）— 核心
- `server/services/change.service.js`（`submitChange`）
- `server/routes/change.routes.js`、`server/routes/meta.routes.js`、`server/routes/reviews.routes.js`
- `server/services/roleCatalog.js`（角色视野解析，如需新增分配策略）
- `server/config/enums.js`（`REVIEW_TEMPLATES` 回落配置）

**前端**
- `web/src/pages/projects/ChangesPage.tsx`、`web/src/stores/flowStore.ts`
- `web/src/api/http.ts`、`web/src/api/contract.ts`、`web/src/api/mock/index.ts`

**文档 / 测试**
- `docs/B10-任务分解.md`、`docs/B10-增量PRD.md`
- `scripts/qa_b10_spotcheck.mjs`
