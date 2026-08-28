# pm-app 飞书通讯录批量导入 + 按姓名搜索导入 · 技术方案（提案稿 v2）

> 文档版本：v2.0（提案，已与用户确认匹配模型）
> 作者：高见远（架构师）
> 适用：后端 Node + Express + better-sqlite3（schema 当前 v23）；前端 React + TS + MUI + Vite
> 约束：本方案**仅到文件/函数级，不写实现代码**，供评审与排期。
> 单端口：生产 `https://pm.astrbyte.com`、内网 `http://localhost:3000/`；Express 同端口托管 `web/dist`。

---

## 〇、事实基线与设计修正

| 项 | 已核验事实（逐条核对代码与 `pm.db`） |
|---|---|
| users 表关键列 | `open_id`(UNIQUE NOT NULL)、`union_id`、`employee_id`、`name`、`email`、`dept`、`global_role`、`status`('active'\|'disabled'\|'pending')、`must_change_pwd`、`password_hash` |
| 飞书身份真相 | `open_id` 单应用内稳定、跨应用会变；`union_id` 是同一开发者**跨应用稳定** ID；**二者都是飞书签发、可信的统一身份**。`employee_id`/邮箱/`name` 均为手填或通讯录字段，**不是**飞书签发的身份 ID，不可作为"铁证"去重键 |
| 手动建号现实 | 管理员手动建用户时**不知道**对方 `open_id`/`union_id`，通常只填邮箱+姓名；而飞书邮箱 18 人中 11 人为空 → 首次拉通讯录时往往匹配不到 `open_id`/`union_id`/邮箱，唯一可能命中的是**姓名**。这与用户首次飞书登录的认回链（email > union_id > open_id > 唯一姓名）**同构** |
| `pm.db` 实测 | 13 个用户中 12 个 `union_id`/`employee_id` 为空，但 `open_id` 均为真实飞书 ID（走过飞书登录认回）；仅系统管理员为 `local_` 占位、无飞书身份。结论：当前库不会重复，但"未来手工初始化（不填飞书身份）的用户"是重号风险点 |

> ⚠️ **v2 相对 v1 的关键修正（用户拍板）**：v1 误将 `open_id` 作为唯一幂等键、并试图用 `email`/`employee_id` 等手填字段自动去重——这会在"手动建号后再导入"场景下建重或误绑。v2 改为**两档三桶匹配模型**：飞书签发的 `open_id`/`union_id` 为"铁证"档（自动处理），手填的姓名/邮箱仅作"疑似"信号（**必须管理员逐条确认**），二者都不命中才新建。本模型与首次飞书登录认回逻辑一致，但导入允许新建且对疑似档加人工确认闸门。

---

## 一、整体设计

### 1.1 模块划分：新增 `server/lib/feishu_contacts.js` 与 `server/services/feishuImport.service.js`

- `server/lib/feishu_contacts.js`：封装「递归拉全部门 + 拉全部人员 + 按姓名搜索 + 部门名解析」，**复用 `feishu.js` 的 `getAppAccessToken()`**。
- `server/services/feishuImport.service.js`：核心 `classifyContact(contact)`（三桶分类）+ `importContacts(decisions, initialStatus)`（按分类执行）。

### 1.2 匹配模型：两档三桶（核心，必须明确）

对每条飞书联系人，按优先级分类到**唯一一桶**：

1. **铁证重复（definite）**：本地存在用户 `open_id = 该联系人 open_id` **或** `union_id = 该联系人 union_id` → 100% 同一人。
   - 处置：自动跳过；可选同步无害字段（回填真实 `open_id`/`union_id`、刷新 `name`/`dept`/`employee_id`）。**绝不改动 `status`/`global_role`/`password_hash`/`must_change_pwd`。**
   - 无需管理员确认。
2. **疑似重复（suspected）**：本地存在用户 `name` 或 `email` 与该联系人一致，但 `open_id`/`union_id` **均不一致** → 可能是同一人（手动建的没飞书身份），也可能纯重名。
   - 处置：**列出逐条交管理员确认**——`merge`（把飞书 `open_id`/`union_id` 回填到该本地账号 + 同步无害字段）或 `skip`（保留原账号、不新建飞书账号）。
   - **必须管理员确认，禁止自动合并**（防误绑）。
3. **新建（fresh）**：以上均不命中 → 新建用户，`status = initialStatus`（默认 `pending` 待授权），写默认密码 + `must_change_pwd=1`。

> 分类优先级：先判铁证（`open_id`/`union_id`）→ 再判疑似（`name`/`email`）→ 否则 `fresh`。一条联系人只入一桶。
> 注意：纯手动账号（`local_` 占位 open_id、空 union_id）**永远进不了铁证档**，只能经疑似档由管理员确认合并——这正是用户"手动建号→导入认回"场景的正确归宿。

### 1.3 新增后端接口（3 个，仅 admin）

统一守卫：`requireAuth` + `requireGlobalRole('admin')`（与现有 `createUser` 一致）。

| 方法 & 路径 | 入参 | 出参（关键字段） | 说明 |
|---|---|---|---|
| `GET /api/admin/feishu/contacts?preview=1` | 无 | `{ total, buckets:{definite[],suspected[],fresh[]}, visibilityHint }` | 调 `getFullContacts` 递归拉全量；逐条 `classifyContact` 分类；`suspected` 项带 `matchedLocalOpenId` 与 `matchedBy`('name'\|'email')；`visibilityHint` 提示"拉到 N 人，若少于预期请检查通讯录可见范围" |
| `POST /api/admin/feishu/import` | `{ initialStatus?:'pending'\|'active', suspectedDecisions?: { [feishuOpenId]: 'merge'\|'skip' } }` | `{ added, merged, skipped, failed, details:[{openId,name,result,reason?}] }` | 铁证→`skipped`（可同步无害字段）；疑似→按 `suspectedDecisions` 逐条 `merge`/`skip`；`fresh`→新建 `pending` |
| `POST /api/admin/feishu/search` | `{ query, page_size?:number }` | `{ hits: FeishuContactDTO[] }` | 调 `searchUsersByName` 模糊匹配姓名；命中人可进导入流程（同样走三桶分类） |

> 接口入参/出参均为 JSON；错误沿用现有错误码体系（`E_VALIDATION`/`E_FORBIDDEN`/`E_FEISHU_API` 等）。

### 1.4 权限模型

- 3 个接口统一套 `requireAuth` + `requireGlobalRole('admin')`，与 `createUser` 一致；非 admin 返回 **403**（`E_FORBIDDEN`）。
- 不引入新权限位、不动 RBAC 判权与权限矩阵。

### 1.5 前后端改动清单（文件/函数级汇总）

| 层 | 文件 | 改动 | 涉及函数/导出 |
|---|---|---|---|
| 后端(新) | `server/lib/feishu_contacts.js` | 新增 | `getFullContacts(token)`、`getDetailedProfile(openId, token)`、`searchUsersByName(query, token)`、`resolveDepartmentName(deptId, token)`、`walkDepartments(token)` |
| 后端(新) | `server/services/feishuImport.service.js` | 新增 | `classifyContact(contact)`、`importContacts(decisions, initialStatus)`、`backfillAndSync(localOpenId, contact)` |
| 后端(改) | `server/routes/admin.routes.js` | 注册 3 路由 | `GET /api/admin/feishu/contacts`、`POST /api/admin/feishu/import`、`POST /api/admin/feishu/search`；import 路由内调 `feishuImport.service`；不改 `createUser`/`updateUser` |
| 后端(不改) | `server/lib/feishu.js` | 不改 | 仅复用 `getAppAccessToken()` |
| 前端(改) | `web/src/api/admin.ts` | 新增封装 | `previewFeishuContacts()`、`importFeishuUsers(decisions, status)`、`searchFeishuUsers(query)` |
| 前端(改) | `web/src/pages/admin/AdminUsersPage.tsx` | 新增入口 | 「从飞书导入」按钮；挂载 `FeishuImportDialog` |
| 前端(新) | `web/src/components/FeishuImportDialog.tsx` | 新增 | 三桶展示（铁证/疑似/新建）+ 疑似逐条 merge/skip 单选 + 搜索 Tab + 结果摘要 |

> 说明：导入服务**不调用 `createUser`**（`createUser` 的 open_id 查重会在"已存在"时抛 `E_VALIDATION`，与导入"已存在→跳过"语义冲突）。`fresh` 新建复用 `admin.routes.js:428` 同款"INSERT + 默认密码 + `must_change_pwd=1`"片段（建议抽共享 helper `createLocalUser` 供 `createUser` 与导入共用）。

---

## 二、防覆盖 / 合并语义（硬约束）

- **铁证档**：仅同步无害字段（`name`/`dept`/`employee_id` + 回填 `open_id`/`union_id`），**不动 `status`/`角色`/`密码`**。
- **疑似档 merge**：把飞书 `open_id`/`union_id` 回填到本地账号并同步无害字段；**不动 `status`/`角色`/`密码`**。skip：本地账号与飞书侧均不改，不新建。
- **新建档**：`INSERT` + 默认密码 + `must_change_pwd=1`；无邮箱者 `email=NULL`（不影响飞书免登按 open_id 认回）。
- **任何档都不触达** `devlogin` / RBAC 判权 / 业务流（周报/评审/变更/里程碑/WBS/文档）/ `upsertFeishuUser` 登录链路 / `audit_logs` 写入逻辑。
- **批量稳健**：按批 50；当前 18 人无压力，设计留上限；单条失败进 `failed`，不影响其余。

---

## 三、按姓名搜索导入

- `feishu_contacts.searchUsersByName(query, token)`：`POST contact/v3/users/search`，body `{ query, page_size(默认 20), page_token? }`，解析 `items` → `FeishuContactDTO{ open_id, union_id, name, employee_no→employee_id, email, department_ids }`。
- 部门名解析（增强展示，可选）：对 `department_ids` 用 `resolveDepartmentName(deptId, token)` 取部门名；解析失败回退显示 department_id，不阻断导入。
- 前端：搜索框**防抖 300ms**；结果列表可单选/多选；选中后复用"批量导入"的 `importFeishuUsers(decisions, status)`，**先经 `classifyContact` 三桶分类、再按决策执行**，与全量预览行为完全一致。

---

## 四、前端改动（文件清单）

- `web/src/api/admin.ts`：新增
  - `previewFeishuContacts()` → `GET /api/admin/feishu/contacts?preview=1`
  - `importFeishuUsers(decisions: Record<string,'merge'|'skip'>, status?: 'pending'|'active')` → `POST /api/admin/feishu/import`
  - `searchFeishuUsers(query: string)` → `POST /api/admin/feishu/search`
- `web/src/pages/admin/AdminUsersPage.tsx`：工具栏新增「从飞书导入」按钮 → 打开 `FeishuImportDialog`；不改动现有「新增用户」与行内授权/停用动作。
- `web/src/components/FeishuImportDialog.tsx`（新增）：
  - **Tab① 全量预览（三桶）**：铁证区标注「已存在·将跳过」；疑似区每行 `merge`/`skip` 单选（**默认 `skip` 安全侧**）；新建区标注「将建 pending」。可见范围提示条。底部「确认导入」。
  - **Tab② 按姓名搜索**：输入防抖 300ms → `searchFeishuUsers` → 结果可选中 → 进入导入（同三桶）。
  - 结果摘要：新增 X / 合并 Y / 跳过 Z / 失败 W + 失败明细。
- 路由/配置：`web/src/router`、`web/src/config/routes.ts` **不改**（Dialog 局部挂载）。

---

## 五、对现有功能的影响与边界（严守）

**会变**
- 用户管理页新增「从飞书导入」入口与弹层。
- 新增 3 个 admin 接口（`/api/admin/feishu/*`）。

**绝不改（硬边界）**
- 飞书登录链路 `upsertFeishuUser`（`auth.routes.js:82`）、授权闸门判定（不自动建号）、RBAC 判权与权限矩阵、`devlogin`、项目内权限、业务流（周报/评审/变更/里程碑/WBS/文档）、`audit_logs` 写入逻辑、`users.open_id` UNIQUE 约束本身。
- 仅"触发"现有审计函数记录一条 `feishu_import` 操作，**不改其实现**。
- `createUser`/`updateUser` 函数体不变；导入服务只复用其"默认密码写入"片段。

**风险与缓解**
1. 通讯录可见范围：用户已开全量，若后续收窄会减少拉取人数 → 预览阶段 `visibilityHint` 提示，导入前二次确认。
2. search 频率/分页：低频 + 翻页 + 限流友好提示。
3. 大批量性能：按批 50；当前 18 人无压力。
4. 误绑：疑似档**默认 skip、必须管理员显式选 merge**，`users.open_id` UNIQUE 兜底并发重复插入。
5. 重名：姓名命中进入疑似档而非自动合并，由人工判别，杜绝重名误绑。

---

## 六、实现顺序

1. **后端 `feishu_contacts.js`**：`walkDepartments` + `getFullContacts`（递归拉全部门/人员）+ `getDetailedProfile` + `searchUsersByName` + `resolveDepartmentName`；复用 `getAppAccessToken()`。
2. **后端 `feishuImport.service.js`**：`classifyContact`（三桶分类，含 open_id/union_id 查询）+ `importContacts`（铁证跳过/同步、疑似按决策 merge/skip、fresh 新建）+ 共享 `createLocalUser` helper（可选）。
3. **后端 3 接口**：`admin.routes.js` 注册路由，import 路由调 `feishuImport.service`；admin 守卫。
4. **前端 API 封装**：`web/src/api/admin.ts` 三函数（import 携带 `suspectedDecisions`）。
5. **前端导入弹层**：`FeishuImportDialog.tsx`（三桶 UI + 疑似确认 + 搜索 + 结果摘要）+ `AdminUsersPage.tsx` 入口。
6. **自验证**：见第八节验收标准。

---

## 七、已确认决策（v2 拍板，无需再问）

| # | 决策点 | 结论 |
|---|---|---|
| 匹配模型 | 两档三桶：铁证(`open_id`/`union_id`)自动 / 疑似(姓名或邮箱命中但 `open_id`/`union_id` 不一致)人工确认 / 新建 `pending` | **已确认** |
| 疑似定义 | 姓名或邮箱命中，但 `open_id`/`union_id` **不一致**（用户原话"原意是不同"） | **已确认** |
| 导入默认状态 `initialStatus` | `pending`（待授权） | **已确认**（用户原话"待授权状态"） |
| 批量导入 + 按姓名搜索 | 都做 | **已确认** |
| 预览强制三桶对比 | 是（铁证/疑似/新建分区分明） | **已确认** |
| 飞书 search 接口权限点 | 编码前由后端用临时脚本验证一次（应用加 `contact:user.base:readonly` 或 `contact:contact:readonly`） | 待编码前验证 |

> 另：是否启用 schema v24 新增 `users.source`/`feishu_synced_at`（默认**不做**，避免触碰 `users.open_id` UNIQUE 约束与现有迁移链）。

---

## 八、验证 / 验收标准

1. **预览三桶正确**：`GET /api/admin/feishu/contacts` 返回 `definite`/`suspected`/`fresh`；当前库已有的飞书身份用户（徐文斌 `ou_2222...`、张磊等）入 `definite`；手动建且姓名/邮箱与某飞书人重合的入 `suspected`（带 `matchedLocalOpenId`/`matchedBy`）。
2. **铁证档不破坏**：`definite` 导入 → `result=skipped`，其 `status`/`global_role`/`password_hash`/`must_change_pwd` **零变化**（导入前后 DB 快照比对）；`open_id`/`union_id` 回填正确。
3. **疑似档默认安全**：`suspected` 未传 `merge` 决策（或默认 `skip`）→ 不新建、不改本地账号；管理员显式 `merge` → 该本地账号被回填飞书 `open_id`/`union_id` + 同步无害字段，`status`/`角色`/密码不变。
4. **新建档正确**：`fresh` 导入 → 新建 `pending`、`global_role='member'`、写默认密码 + `must_change_pwd=1`；无邮箱者 `email=NULL`。
5. **按姓名搜索**：搜索"张"能命中张磊/张雨婷等；选中走导入经同一三桶分类与决策。
6. **权限**：3 接口非 admin 调返回 **403**；admin 正常。
7. **零回归**：`devlogin`、RBAC 判权、`upsertFeishuUser` 登录链路、业务流（周报/评审/变更/里程碑/WBS/文档）、`audit_logs` 写入均不受影响；`users.open_id` UNIQUE 约束不变。

> 备注：验收 ① 以**运行时预览接口返回**作为 18 人基准。
