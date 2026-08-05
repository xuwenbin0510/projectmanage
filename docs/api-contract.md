# 接口契约 · API Contract v1.0

> 太空字节项目管理系统 · 重构 v1
> 配套：`docs/架构设计-重构v1.md`（3.3 接口清单 / 3.4 业务规则 / 7.1 响应格式 / 7.2 错误码）、`docs/schema.sql`、`docs/permissions-matrix.md`
> **本文件是前后端唯一契约基准**：
> - **T02/T19（前端 Mock）** 按本文件造数据 → 保证 Mock 与真实同形
> - **T21~T32（后端）** 按本文件出响应 → 保证不跑偏
> - **T33（联调）** 按本文件逐个 diff → 差异清零即为通过
>
> 版本：v1.0 · 架构师 高见远

---

## 0. 全局约定（**先读完这章再看接口**）

### 0.1 响应包络

**所有**接口（含错误）一律返回同一包络，不存在裸数组 / 裸对象：

```jsonc
// ✅ 成功（单对象）
{ "code": 0, "data": { /* 业务对象 */ }, "message": "ok" }

// ✅ 成功（列表 / 分页）
{ "code": 0, "data": { "items": [ /* ... */ ], "total": 128, "page": 1, "pageSize": 20 }, "message": "ok" }

// ✅ 成功（无返回体的动作，如删除）
{ "code": 0, "data": null, "message": "ok" }

// ❌ 失败（HTTP 状态码同步设置，见 0.5）
{ "code": "E_GATE_NOT_PASSED", "data": { "blockers": ["…"] }, "message": "质量门未通过，无法进入下一阶段" }
```

| 规则 | 说明 |
|---|---|
| `code` | 成功恒为**数字 `0`**；失败恒为**字符串错误码**（`E_` 前缀）。前端判定用 `res.code === 0`，**不要**用 truthy |
| `data` | 成功时为业务数据；失败时是**结构化上下文**（`blockers` / `fields` / `changeDraft` …），前端据此渲染具体提示，**不要**只弹 `message` |
| `message` | 面向用户的中文短句。**前端优先用本地 `errorMap[code]` 的文案**，`message` 仅作兜底（保证后端改文案不影响前端） |
| 列表 | 恒为 `{items,total,page,pageSize}`。**即使不分页也要包 `items`**，禁止直接返回数组 |

### 0.2 命名与类型

| 项 | 约定 |
|---|---|
| 字段命名 | **API 层全 camelCase**。DB 是 snake_case，由 `dal/base.repo.js` 出口统一转换。前端永远见不到下划线 |
| 布尔 | 真正的 `true/false`（DB 存 0/1，Repository 转换）。**禁止**给前端返回 `0/1` |
| JSON 字段 | 真正的对象/数组（DB 存 TEXT，Repository `JSON.parse`）。**禁止**返回 JSON 字符串 |
| 日期 | 纯日期字段 `"2026-03-20"`；时间戳字段 ISO 8601 带时区 `"2026-03-20T14:32:10+08:00"` |
| 金额 | `contractAmount` 单位**万元**，number 类型，如 `150` = 150 万 |
| 空值 | 用 `null`，**不要**用 `""` 或 `0` 占位（`0` 在 WIP、工作量等字段有真实语义） |
| 枚举 | 中文枚举（状态类）保持中文原文，如 `"进行中"`；英文枚举（角色/模式/类型）保持小写英文，如 `"pm"`、`"parallel_veto"`。**不要混用** |

> ⚠️ **保留字提醒**：里程碑「当前计划日期」字段名是 **`plannedDate`**（DB `planned_date`），**不是** `currentDate`。详见附录 A 的 D-3。

### 0.3 派生字段规则（**最容易两边跑偏的地方，务必对齐**）

DB 里 `owner`、`author`、`createdBy`、`decidedBy`、`actorOpenId` 等存的都是 **`open_id`**。前端要显示人名，因此后端**必须同时返回派生的显示字段**：

| 存储字段 | 伴随派生字段 | 示例 |
|---|---|---|
| `owner` | `ownerName` | `"owner": "ou_li", "ownerName": "李四"` |
| `author` | `authorName` | 同上 |
| `createdBy` | `createdByName` | 同上 |
| `decidedBy` | `decidedByName` | 同上 |
| `assigneeOpenId` | `assigneeName` | 同上 |
| `currentStageId` | `currentStage: {id,code,name,seq}` | 概览页直接用，避免二次请求 |

**规则**：
1. 派生字段**只读**，前端提交时**不要**回传（后端忽略）。
2. 派生字段命名恒为 `<原字段>Name`，对象型为去掉 `Id` 后缀。
3. 人已离职/删除时 `ownerName` 返回 `"(已移除)"`，**不返回 null**，避免前端到处判空。

### 0.4 请求约定

| 项 | 约定 |
|---|---|
| 鉴权头 | `Authorization: Bearer <token>`。缺失/过期 → `401 E_UNAUTHORIZED` |
| 请求 ID | **所有写请求**必须带 `X-Request-Id: <uuid v4>`（前端生成）。后端日志与 `audit_logs.request_id` 记录同一值 |
| 幂等 | `POST .../submit`、`.../decide`、`.../advance`、`.../close`、`.../move` 按 `X-Request-Id` 去重：**重复提交返回上一次的结果与 `code:0`**，不报错、不重复执行 |
| Content-Type | `application/json; charset=utf-8` |
| 分页 | `?page=1&pageSize=20`。`page` 从 **1** 开始；`pageSize` 上限 100，超出按 100 处理 |
| 通用筛选 | `?projectId=&status=&type=&owner=&q=`。`q` 为模糊搜索（名称/编号），后端做 `LIKE %q%` |
| 排序 | `?sortBy=updatedAt&sortOrder=desc`。默认各接口注明 |
| 数组参数 | 逗号分隔：`?status=进行中,阻塞`（**不用** `status[]=`） |

### 0.5 错误响应形态

```jsonc
// 通用形态
{ "code": "<ERROR_CODE>", "data": <结构化上下文 | null>, "message": "<中文提示>" }
```

| HTTP | 语义 | 典型错误码 |
|---|---|---|
| 400 | 参数/业务校验失败 | `E_VALIDATION`、`E_WBS_LEAF_INCOMPLETE`、`E_WBS_PARENT_TYPE`、`E_WBS_DEPTH`、`E_WBS_STAGE_UNBOUND`、`E_WBS_TYPE_LOCKED` |
| 401 | 未登录/过期 | `E_UNAUTHORIZED` |
| 403 | 已登录但无权限 / 被规则硬拦截 | `E_FORBIDDEN`、`E_GATE_NOT_PASSED`、`E_PROJECT_ARCHIVED` |
| 404 | 资源不存在 | `E_NOT_FOUND` |
| 409 | 状态冲突（**可重试/可换路径**） | `E_MS_NEED_CHANGE`、`E_WIP_EXCEEDED`、`E_REPORT_DUPLICATE`、`E_CLOSE_BLOCKED` |
| 500 | 服务端异常 | `E_INTERNAL` |

**409 的语义约定**：409 表示「你想做的事本身合法，但当前状态下要换个路径或调整后再来」，前端应给出**可操作的引导**（如「去发起变更单」按钮），而非单纯报错。这是本系统区别于普通 CRUD 的关键交互点。

**参数校验错误的固定 shape**：

```jsonc
{
  "code": "E_VALIDATION",
  "data": {
    "fields": [
      { "field": "name",           "message": "项目名称不能为空" },
      { "field": "contractAmount", "message": "合同额必须为非负数" }
    ]
  },
  "message": "参数校验失败"
}
```
> 前端 `react-hook-form` 直接把 `fields` 映射到表单项报错，**不要**只弹 Toast。

### 0.6 结项只读拦截（全局中间件，所有写接口共有）

项目 `status ∈ {已结项, 已终止}` 时，**该项目下所有写操作**统一返回：

```jsonc
// HTTP 403
{
  "code": "E_PROJECT_ARCHIVED",
  "data": { "projectId": "P1a2b", "projectStatus": "已结项", "closedAt": "2026-06-30T18:00:00+08:00" },
  "message": "项目已结项，处于只读归档状态"
}
```
> 本响应**不再在每个接口里重复列出**，请默认所有写接口都可能返回它。

### 0.7 权限拒绝的固定 shape

```jsonc
// HTTP 403
{
  "code": "E_FORBIDDEN",
  "data": { "required": "stage:advance", "yourGlobalRole": "member", "yourProjectRoles": ["member"] },
  "message": "无操作权限"
}
```
> `data` 带上缺失的权限点，便于联调期排查，**不会泄露敏感信息**。

### 0.8 接口总览（46 行清单 → 61 个具体操作）

| # | 域 | 章节 | 操作数 |
|---|---|---|---|
| 1 | 认证与元数据 | §1 | 6 |
| 2 | 用户管理 | §2 | 2 |
| 3 | 工作台与仪表盘 | §3 | 2 |
| 4 | 项目 | §4 | 9 |
| 5 | 阶段与推进 | §5 | 4 |
| 6 | 质量门 | §6 | 5 |
| 7 | 里程碑 | §7 | 4 |
| 8 | WBS | §8 | 7 |
| 9 | 看板 | §9 | 3 |
| 10 | 周报 | §10 | 5 |
| 11 | 评审与审批 | §11 | 9 |
| 12 | 变更控制 | §12 | 4 |
| 13 | 审计 | §13 | 2 |
| | **合计** | | **62** |

---

## 1. 认证与元数据

### 1.1 `POST /api/login` ♻️ 飞书免登

**请求**
```json
{ "code": "3a5b7c9d1e2f4g6h" }
```

**成功 200**
```json
{
  "code": 0,
  "data": {
    "token": "eyJ1aWQiOjEsIm9pZCI6Im91X3ppNGZhbiJ9.9f8c2b1a...",
    "expiresAt": "2026-03-27T10:00:00+08:00",
    "user": {
      "id": 1,
      "openId": "ou_zhangsan",
      "employeeId": "AB0231",
      "name": "张三",
      "email": "zhangsan@astrbytes.com",
      "dept": "研发中心/嵌入式组",
      "avatarUrl": "https://s1-imfile.feishucdn.com/static-resource/v1/xxx",
      "globalRole": "pm",
      "status": "active"
    },
    "isNewUser": false
  },
  "message": "ok"
}
```

**错误**
| HTTP | code | 场景 | data |
|---|---|---|---|
| 400 | `E_VALIDATION` | 缺 `code` | `{fields:[{field:"code",...}]}` |
| 401 | `E_FEISHU_AUTH` | 飞书换取 user_access_token 失败 | `{feishuCode: 20005, feishuMsg: "code expired"}` |
| 403 | `E_USER_DISABLED` | 用户已被停用 | `{openId:"ou_x"}` |

> `isNewUser=true` 表示首次登录自动建号，默认 `globalRole="member"`，前端可提示「请联系管理员分配角色」。

### 1.2 `POST /api/devlogin` ♻️ 开发登录

> **仅当 `NODE_ENV !== 'production'` 或 `ALLOW_DEV_LOGIN=true` 时开放**，生产环境返回 404，避免成为后门。

**请求**
```json
{ "name": "李四", "globalRole": "pmo" }
```

**成功 200** — 同 `1.1` 的 `data` 结构。

**错误**
| HTTP | code | 场景 |
|---|---|---|
| 404 | `E_NOT_FOUND` | 生产环境已关闭该入口 |
| 400 | `E_VALIDATION` | `globalRole` 不在 9 种角色内 |

### 1.3 `GET /api/me` ♻️ 当前用户

**成功 200**
```json
{
  "code": 0,
  "data": {
    "user": {
      "id": 1, "openId": "ou_zhangsan", "employeeId": "AB0231", "name": "张三",
      "email": "zhangsan@astrbytes.com", "dept": "研发中心/嵌入式组",
      "avatarUrl": "https://…", "globalRole": "pm", "status": "active"
    },
    "permissions": [
      "meta:read", "user:read", "project:create", "project:read", "audit:read"
    ],
    "projectRoles": {
      "P1a2b": ["pm"],
      "P3c4d": ["member"]
    },
    "dataScope": "MEMBER"
  },
  "message": "ok"
}
```

| 字段 | 说明 |
|---|---|
| `permissions` | **全局权限**字符串数组（不含项目级叠加）。前端 `PermissionGate` 的全局判定源 |
| `projectRoles` | `{projectId: [projectRole,…]}`。前端进入某项目时与全局权限做并集 |
| `dataScope` | `ALL` / `MEMBER`，前端可据此决定是否展示「全部项目」筛选项 |

> ⚠️ 项目级角色**不在 token 里**，本接口每次实时查库。任命后前端只需重新拉一次 `/api/me` 即可生效，**无需重新登录**。

### 1.4 `GET /api/appid` ♻️ 飞书 AppId

**成功 200**（公开，无需登录）
```json
{ "code": 0, "data": { "appId": "cli_a1b2c3d4e5f6", "enabled": true }, "message": "ok" }
```
> `enabled=false` 表示未配置飞书环境变量，前端应直接展示开发登录表单（T04 逻辑分叉点）。

### 1.5 `GET /api/meta` 🆕 全局元数据

> **前端启动时拉一次并缓存到 `metaStore`**。所有下拉选项、状态色映射、权限矩阵、模板信息都从这里来，**禁止前端硬编码枚举**。

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "enums": {
      "projectType":    [ {"value":"A","label":"A类（交付类）"}, {"value":"B","label":"B类（产品迭代）"}, {"value":"C","label":"C类（基建类）"} ],
      "projectStatus":  ["草稿","审批中","已批准","进行中","挂起","已结项","已终止","已驳回"],
      "health":         [ {"value":"green","label":"正常"}, {"value":"yellow","label":"关注"}, {"value":"red","label":"风险"} ],
      "stageStatus":    ["未开始","进行中","已完成"],
      "gateStatus":     ["未开始","待检查","已通过","有条件通过","不通过"],
      "milestoneStatus":["未开始","进行中","已达成","已逾期"],
      "wbsNodeType":    [ {"value":"stage","label":"阶段"}, {"value":"package","label":"工作包"}, {"value":"task","label":"任务"} ],
      "taskStatus":     ["待办","进行中","待评审","完成","阻塞"],
      "reviewType":     [ {"value":"formal","label":"正式评审"}, {"value":"technical","label":"技术评审"}, {"value":"code","label":"代码评审"}, {"value":"ccb","label":"变更委员会"}, {"value":"project","label":"项目审批"} ],
      "reviewMode":     [ {"value":"serial","label":"串行"}, {"value":"parallel_veto","label":"并行一票否决"}, {"value":"single","label":"单人决议"} ],
      "changeType":     [ {"value":"milestone_date","label":"里程碑日期"}, {"value":"requirement_baseline","label":"需求基线"}, {"value":"scope","label":"范围"}, {"value":"other","label":"其它"} ],
      "changeRoute":    [ {"value":"pm_only","label":"仅项目经理审批"}, {"value":"ccb","label":"变更控制委员会"} ]
    },
    "roles": {
      "global":  [ {"value":"admin","label":"系统管理员"}, {"value":"management","label":"管理层"}, {"value":"pmo","label":"PMO"}, {"value":"pm","label":"项目经理"}, {"value":"tl","label":"技术负责人"}, {"value":"qa","label":"质量/测试"}, {"value":"cm","label":"配置管理员"}, {"value":"po","label":"产品负责人"}, {"value":"member","label":"普通成员"} ],
      "project": [ {"value":"pm","label":"项目经理"}, {"value":"tl","label":"技术负责人"}, {"value":"po","label":"产品负责人"}, {"value":"qa","label":"质量"}, {"value":"cm","label":"配置管理"}, {"value":"pmo","label":"PMO"}, {"value":"member","label":"成员"} ]
    },
    "permissionPoints": ["meta:read","user:read","user:role:assign","project:create","…共37个"],
    "statusColorMap": {
      "已通过":"success","已达成":"success","完成":"success","green":"success",
      "待检查":"warning","进行中":"warning","yellow":"warning",
      "不通过":"danger","已逾期":"danger","已驳回":"danger","阻塞":"danger","red":"danger",
      "未开始":"neutral","草稿":"neutral","待办":"neutral"
    },
    "lifecycleTemplates": [
      { "id":"LT-A-1","projectType":"A","version":1,"name":"A类（交付类）标准生命周期 v1",
        "stageCount":6,"gateCount":6,"milestoneCount":7,
        "granularity":{"maxLeafDays":5},
        "boardDefaults":{"wipLimits":{"进行中":5}} },
      { "id":"LT-B-1","projectType":"B","version":1,"name":"B类（产品迭代）轻量生命周期 v1",
        "stageCount":4,"gateCount":4,"milestoneCount":6,
        "granularity":{"maxLeafDays":2},
        "boardDefaults":{"wipLimits":{"进行中":3}} },
      { "id":"LT-C-1","projectType":"C","version":1,"name":"C类（基建类）施工生命周期 v1",
        "stageCount":5,"gateCount":5,"milestoneCount":6,
        "granularity":{"maxLeafDays":5},
        "boardDefaults":{"wipLimits":{"进行中":5}} }
    ],
    "errorMessages": {
      "E_GATE_NOT_PASSED": "质量门未通过，无法进入下一阶段",
      "E_WBS_PARENT_TYPE": "该节点类型不允许挂在此父节点下",
      "E_WBS_DEPTH": "WBS 层级已达上限，请先拆分或上移",
      "E_WBS_STAGE_UNBOUND": "工作分区必须绑定所属生命周期阶段",
      "E_WBS_TYPE_LOCKED": "该节点已有子节点，不能再修改节点类型"
    }
  },
  "message": "ok"
}
```

> `errorMessages` 是**兜底**：前端本地 `errorMap` 优先，本地没有的新错误码用这里的文案，避免后端加错误码时前端弹英文码。

### 1.6 `GET /api/approval-config` ♻️ 兼容别名

> 旧前端使用。返回 `meta` 的审批模板子集，**新代码不要用**，T33 后可下线。

**成功 200**
```json
{
  "code": 0,
  "data": {
    "A类（交付类）": ["pmo", "management"],
    "B类（产品迭代）": ["pmo"],
    "C类（基建类）": ["pmo", "management"]
  },
  "message": "ok"
}
```

---

## 2. 用户管理

### 2.1 `GET /api/users` ♻️ 用户列表

**请求** `GET /api/users?role=tl&q=李&page=1&pageSize=20`

| 参数 | 必填 | 说明 |
|---|---|---|
| `role` | 否 | 按全局角色过滤，多值逗号分隔 |
| `q` | 否 | 姓名/工号/邮箱模糊搜索 |
| `status` | 否 | `active` / `disabled`，默认只返回 `active` |
| `page` / `pageSize` | 否 | 默认 1 / 20；传 `pageSize=0` 返回全部（供下拉选人用） |

**成功 200**
```json
{
  "code": 0,
  "data": {
    "items": [
      { "id": 7, "openId": "ou_lisi", "employeeId": "AB0455", "name": "李四",
        "email": "lisi@astrbytes.com", "dept": "研发中心/结构组",
        "avatarUrl": "https://…", "globalRole": "tl", "status": "active" }
    ],
    "total": 1, "page": 1, "pageSize": 20
  },
  "message": "ok"
}
```

### 2.2 `PUT /api/users/:id/role` ♻️ 分配全局角色

**请求** `PUT /api/users/7/role`
```json
{ "globalRole": "pmo" }
```

**成功 200**
```json
{
  "code": 0,
  "data": { "id": 7, "openId": "ou_lisi", "name": "李四", "globalRole": "pmo", "previousRole": "tl" },
  "message": "ok"
}
```

**错误**
| HTTP | code | 场景 | data |
|---|---|---|---|
| 403 | `E_SELF_ROLE` | 修改自己的角色 | `{userId:7}` |
| 403 | `E_LAST_ADMIN` | 系统仅剩 1 名管理员且正在降级他 | `{adminCount:1}` |
| 403 | `E_FORBIDDEN` | 调用者非 admin | 见 §0.7 |
| 404 | `E_NOT_FOUND` | 用户不存在 | `null` |

```jsonc
// E_LAST_ADMIN 示例（403）
{ "code":"E_LAST_ADMIN", "data":{"adminCount":1}, "message":"系统至少保留一名管理员，无法降级" }
```

---

## 3. 工作台与仪表盘

### 3.1 `GET /api/workbench` 🆕 我的工作台（P0-13）

> **首页唯一数据源**，一次返回四块，避免首页发 5 个请求。

**请求** `GET /api/workbench?week=2026-W11`（`week` 可选，默认当前 ISO 周）

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "summary": {
      "pendingApprovals": 3,      // 待我审批
      "overdueTasks": 2,          // 我负责且已逾期
      "reportsDue": 1,            // 本周待填周报的项目数
      "myProjects": 4
    },
    "myProjects": [
      {
        "id": "P1a2b", "code": "P-0012", "name": "XX型号地面测试设备",
        "type": "A", "status": "进行中", "health": "yellow",
        "myProjectRoles": ["pm"],
        "currentStage": { "id":"STc3", "code":"S4", "name":"开发与首件调试", "seq":4 },
        "stageProgress": { "current": 4, "total": 6 },
        "gate": { "id":"Gd4", "code":"QG4", "name":"编码与测试门", "status":"待检查" },
        "progress": 62,
        "nextMilestone": { "code":"M4", "name":"首件调试完成", "plannedDate":"2026-03-30", "daysLeft": 12, "delayDays": 10 },
        "openTaskCount": 8, "overdueTaskCount": 1
      }
    ],
    "myTasks": [
      { "id":"We5f", "projectId":"P1a2b", "projectCode":"P-0012", "wbsCode":"1.2.3",
        "name":"电源模块联调", "status":"进行中", "progress":40,
        "dueDate":"2026-03-18", "overdue": true, "estimateDays": 3 }
    ],
    "myApprovals": [
      { "reviewId":"RVa1", "projectId":"P1a2b", "projectCode":"P-0012",
        "title":"CR-003 里程碑延后变更", "reviewType":"ccb", "mode":"serial",
        "stepIndex":1, "stepRole":"tl", "initiatorName":"张三",
        "createdAt":"2026-03-16T09:12:00+08:00", "waitingDays": 2 }
    ],
    "reportReminders": [
      { "projectId":"P1a2b", "projectCode":"P-0012", "projectName":"XX型号地面测试设备",
        "week":"2026-W11", "weekEnd":"2026-03-15", "status":"未填写", "draftId": null }
    ]
  },
  "message": "ok"
}
```

| 关键派生字段 | 计算规则 |
|---|---|
| `stageProgress` | `{current: 当前阶段 seq, total: 阶段总数}` |
| `nextMilestone.daysLeft` | `plannedDate - 今天`，可为负（已逾期） |
| `myTasks.overdue` | `dueDate < 今天 && status !== '完成'` |
| `myApprovals.waitingDays` | 该步骤变为 `current` 至今的天数，前端按 >3 天标红 |
| `reportReminders.status` | `未填写` / `草稿未提交`；已提交的项目不出现在列表里 |

`myTasks` 排序：`overdue desc, dueDate asc`；`myApprovals` 排序：`waitingDays desc`。

### 3.2 `GET /api/dashboard` ♻️ 聚合统计

**请求** `GET /api/dashboard?type=A&scope=all`

**成功 200**
```json
{
  "code": 0,
  "data": {
    "projectCount": { "total": 18, "byType": { "A": 7, "B": 8, "C": 3 },
      "byStatus": { "草稿": 2, "审批中": 1, "进行中": 12, "挂起": 1, "已结项": 2 },
      "byHealth": { "green": 11, "yellow": 5, "red": 2 } },
    "milestone": { "total": 96, "achieved": 61, "overdue": 5, "delayed": 9, "onTimeRate": 0.86 },
    "gate": { "total": 84, "passed": 47, "conditional": 6, "failed": 2, "pending": 29 },
    "task": { "total": 742, "done": 460, "inProgress": 173, "blocked": 12, "overdue": 21 },
    "review": { "pending": 14, "avgApprovalHours": 26.4 },
    "change": { "total": 23, "ccb": 9, "pmOnly": 14, "pending": 3 },
    "report": { "week": "2026-W11", "expected": 12, "submitted": 9, "rate": 0.75 }
  },
  "message": "ok"
}
```
> 非 `ALL` 数据范围的用户，统计口径自动收敛为「我参与的项目」，前端无需传参。

---

## 4. 项目

### 4.0 Project 对象标准形态

> 后续接口凡返回 `project`，形态均如下。**列表接口返回精简版**（不含 `background`/`goal`/`classifyInput`），详情接口返回全量。

```jsonc
{
  "id": "P1a2b",
  "code": "P-0012",
  "name": "XX型号地面测试设备",
  "type": "A",
  "classifyInput": { "contractAmount": 150, "hasHardware": true, "hasCustomerAcceptance": true,
                     "isInternalIteration": false, "isInfra": false },
  "classifySuggested": "A",
  "classifyOverrideReason": null,
  "customer": "XX研究所",
  "contractAmount": 150,
  "background": "客户现有测试设备老化…",
  "goal": ["2026年6月前完成交付并通过验收", "测试精度优于 0.5%"],
  "status": "进行中",
  "currentStageId": "STc3",
  "currentStage": { "id": "STc3", "code": "S4", "name": "开发与首件调试", "seq": 4 },
  "health": "yellow",
  "planStart": "2026-01-05",
  "planEnd": "2026-06-30",
  "actualEnd": null,
  "approvalStep": 2,
  "templateId": "LT-A-1",
  "createdBy": "ou_zhangsan",
  "createdByName": "张三",
  "createdAt": "2026-01-03T10:20:00+08:00",
  "updatedAt": "2026-03-16T15:41:00+08:00"
}
```

### 4.1 `POST /api/projects/classify-suggest` 🆕 分类建议（P0-01）

> **纯计算，不落库**。前端在新建向导里边勾边调（可 debounce 300ms）。

**请求**
```json
{
  "contractAmount": 150,
  "hasHardware": true,
  "hasCustomerAcceptance": true,
  "isInternalIteration": false,
  "isInfra": false
}
```

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "suggested": "A",
    "suggestedLabel": "A类（交付类）",
    "reasons": [
      { "rule": "contractAmount>100", "hit": true,  "text": "合同额 150 万元 > 100 万元" },
      { "rule": "hasHardware",        "hit": true,  "text": "包含硬件交付" },
      { "rule": "hasCustomerAcceptance", "hit": true, "text": "存在客户验收环节" },
      { "rule": "isInternalIteration","hit": false, "text": "非自研迭代" },
      { "rule": "isInfra",            "hit": false, "text": "非基建施工" }
    ],
    "conflict": false,
    "priorityNote": "冲突时优先级 A > C > B",
    "template": {
      "id": "LT-A-1", "name": "A类（交付类）标准生命周期 v1",
      "stageCount": 6, "gateCount": 6,
      "milestones": [
        { "code":"M1","name":"项目启动","required":true,"hint":"立项评审通过之日" },
        { "code":"M2","name":"需求基线冻结","required":true,"hint":"QG2 通过之日" },
        { "code":"M3","name":"设计评审通过","required":true,"hint":"QG3 通过之日" },
        { "code":"M4","name":"首件调试完成","required":true,"hint":"首件功能自测通过之日" },
        { "code":"M5","name":"集成测试通过","required":true,"hint":"QG5 通过之日" },
        { "code":"M6","name":"客户验收通过","required":true,"hint":"客户验收报告签署之日" },
        { "code":"M7","name":"项目结项","required":true,"hint":"QG6 通过、项目转归档之日" }
      ],
      "requiredRoles": ["pm","tl"],
      "granularity": { "maxLeafDays": 5 }
    }
  },
  "message": "ok"
}
```

> `reasons` 里**命中与未命中的规则都返回**，前端可以完整展示判定依据（PRD 要求「显示依据」）。`conflict=true` 时表示同时命中 A 与 C 的触发条件，已按优先级取 A，前端应给出提示。

### 4.2 `GET /api/projects` ♻️ 项目列表

**请求** `GET /api/projects?type=A&status=进行中,挂起&health=yellow,red&owner=ou_zhangsan&q=测试&page=1&pageSize=20&sortBy=updatedAt&sortOrder=desc`

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "items": [
      {
        "id":"P1a2b", "code":"P-0012", "name":"XX型号地面测试设备",
        "type":"A", "status":"进行中", "health":"yellow",
        "customer":"XX研究所", "contractAmount":150,
        "currentStage": { "code":"S4", "name":"开发与首件调试", "seq":4 },
        "stageProgress": { "current":4, "total":6 },
        "progress": 62,
        "pm": { "openId":"ou_zhangsan", "name":"张三" },
        "tl": { "openId":"ou_lisi", "name":"李四" },
        "planStart":"2026-01-05", "planEnd":"2026-06-30",
        "nextMilestone": { "code":"M4","name":"首件调试完成","plannedDate":"2026-03-30","daysLeft":12 },
        "updatedAt":"2026-03-16T15:41:00+08:00"
      }
    ],
    "total": 7, "page": 1, "pageSize": 20
  },
  "message": "ok"
}
```

> 列表项**内联 `pm`/`tl` 对象**（从 `project_members` join 得到），避免前端为了显示负责人再发 N 个请求。这是列表接口唯一允许的「反规范化」。

### 4.3 `POST /api/projects` ♻️ 新建项目（含模板实例化）

> **单事务**：项目 + 阶段 + 门 + 检查项 + 里程碑（含 `stage_id`/`anchor` 锚定） + 看板配置 + **WBS 阶段骨架节点** + 角色任命，任一失败整体回滚。
>
> **WBS 骨架预生成（WBS 重构 D-3 丙）**：按模板 `wbsRules.skeleton === 'per-stage'` 为每个阶段生成一个 `nodeType:'stage'` 根级节点（前端文案「工作分区」），`wbsCode` 为根级顺序号 `'1'..'n'`、`level=1`、`lifecycleStageId` 绑定对应 `project_stages.id`；`skeleton:'none'` 时不生成。新建 A 类项目即得 6 个已绑定的工作分区，空态不再出现。

**请求**
```jsonc
{
  "name": "XX型号地面测试设备",
  "type": "A",
  "classifyInput": { "contractAmount":150, "hasHardware":true, "hasCustomerAcceptance":true,
                     "isInternalIteration":false, "isInfra":false },
  "classifySuggested": "A",
  "classifyOverrideReason": null,      // type !== classifySuggested 时必填
  "customer": "XX研究所",
  "contractAmount": 150,
  "background": "客户现有测试设备老化…",
  "goal": ["2026年6月前完成交付并通过验收", "测试精度优于 0.5%"],
  "planStart": "2026-01-05",
  "planEnd": "2026-06-30",
  "templateId": "LT-A-1",
  "members": [
    { "userOpenId": "ou_zhangsan", "projectRole": "pm" },
    { "userOpenId": "ou_lisi",     "projectRole": "tl" },
    { "userOpenId": "ou_wangwu",   "projectRole": "qa" }
  ],
  "milestoneDates": {                  // 必须覆盖模板中所有 required=true 的里程碑
    "M1":"2026-01-10","M2":"2026-01-31","M3":"2026-02-28",
    "M4":"2026-03-20","M5":"2026-05-10","M6":"2026-06-15","M7":"2026-06-30"
  }
}
```

**成功 201**
```jsonc
{
  "code": 0,
  "data": {
    "project": { /* §4.0 全量形态，status="草稿" */ },
    "instantiated": {
      "stages": 6, "gates": 6, "checklistItems": 38, "milestones": 7,
      "boardConfig": true, "wbsRoot": "Wr00", "wbsSkeleton": 6
    },
    "warnings": []
  },
  "message": "ok"
}
```

**错误**
| HTTP | code | 场景 | data |
|---|---|---|---|
| 400 | `E_CLASSIFY_REASON_REQUIRED` | `type !== classifySuggested` 但没填理由 | `{type:"C", suggested:"A"}` |
| 400 | `E_PROJECT_PO_REQUIRED` | B 类项目 `members` 里没有 `po` | `{type:"B", requiredRoles:["pm","tl","po"], missing:["po"]}` |
| 400 | `E_ROLE_CARDINALITY` | pm 或 tl 数量不等于 1 | `{role:"pm", count:2, expected:1}` |
| 400 | `E_VALIDATION` | 里程碑日期缺失 | `{fields:[{field:"milestoneDates.M5",message:"里程碑「集成测试通过」日期必填"}]}` |
| 403 | `E_FORBIDDEN` | 无 `project:create` | 见 §0.7 |

```jsonc
// E_CLASSIFY_REASON_REQUIRED 示例（400）
{ "code":"E_CLASSIFY_REASON_REQUIRED",
  "data":{ "type":"C", "suggested":"A", "reasons":["合同额 150 万元 > 100 万元","包含硬件交付"] },
  "message":"手动调整分类必须填写覆盖理由" }
```

### 4.4 `GET /api/projects/:id` ♻️ 项目详情

**请求** `GET /api/projects/P1a2b?include=members,stages,milestones`

| `include` 可选值 | 说明 |
|---|---|
| `members` | 内联项目成员列表 |
| `stages` | 内联阶段 + 门摘要（等价 §5.1） |
| `milestones` | 内联里程碑列表（等价 §7.1） |
| 不传 | 只返回项目本体 + `myProjectRoles` + `myPermissions` |

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "project": { /* §4.0 全量形态 */ },
    "myProjectRoles": ["pm"],
    "myPermissions": ["project:read","project:update","stage:advance","milestone:create","wbs:edit","review:proxy","…"],
    "members": [
      { "id":"PMB1","userOpenId":"ou_zhangsan","userName":"张三","dept":"研发中心/嵌入式组",
        "avatarUrl":"https://…","projectRole":"pm","assignedBy":"ou_admin","assignedByName":"管理员",
        "assignedAt":"2026-01-03T10:20:00+08:00" }
    ],
    "stats": {
      "taskTotal": 42, "taskDone": 26, "progress": 62,
      "milestoneTotal": 7, "milestoneAchieved": 3, "milestoneDelayed": 1,
      "gatePassed": 3, "gateTotal": 6,
      "openChanges": 1, "pendingReviews": 2
    }
  },
  "message": "ok"
}
```

> **`myPermissions` 是全局 ∪ 项目角色的合并结果**，前端直接消费，**禁止自行做并集运算**（详见 `permissions-matrix.md` 第七章）。

### 4.5 `PUT /api/projects/:id` ♻️ 编辑项目

**请求**（部分更新，只传要改的字段）
```json
{ "name": "XX型号地面测试设备（改）", "customer": "XX研究所", "health": "red", "planEnd": "2026-07-15" }
```

**成功 200** — `data` 为更新后的 §4.0 全量对象。

**字段白名单**：`name` `customer` `contractAmount` `background` `goal` `health` `planStart` `planEnd`。
**禁止修改**（传了静默忽略并记审计告警）：`type` `code` `status` `currentStageId` `templateId` `approvalStep` `createdBy`。

> 类型 `type` 一经建立不可改 —— 改类型等于换生命周期模板，会让已生成的阶段/门/里程碑失去意义。确需改类型请终止后重建（已在附录 O 列表中记录，PMO 认可此约束）。

### 4.6 `DELETE /api/projects/:id` ♻️ 删除项目（软删）

**成功 200**
```json
{ "code": 0, "data": { "id": "P1a2b", "deletedAt": "2026-03-17T09:00:00+08:00" }, "message": "ok" }
```

**错误**
| HTTP | code | 场景 |
|---|---|---|
| 403 | `E_FORBIDDEN` | 非 admin |
| 409 | `E_PROJECT_NOT_DRAFT` | 项目已不是 `草稿` 状态（有实际数据，只能终止不能删） |

```jsonc
{ "code":"E_PROJECT_NOT_DRAFT",
  "data":{"status":"进行中","suggestion":"transition","suggestionLabel":"请改用「终止项目」"},
  "message":"仅草稿状态项目可删除" }
```

### 4.7 `GET /api/projects/:id/members` 🆕 项目成员

**成功 200**
```json
{
  "code": 0,
  "data": {
    "items": [
      { "id":"PMB1","userOpenId":"ou_zhangsan","userName":"张三","dept":"研发中心/嵌入式组",
        "avatarUrl":"https://…","projectRole":"pm",
        "assignedBy":"ou_admin","assignedByName":"管理员","assignedAt":"2026-01-03T10:20:00+08:00" }
    ],
    "total": 5, "page": 1, "pageSize": 100,
    "requiredRoles": ["pm","tl"],
    "missingRoles": []
  },
  "message": "ok"
}
```

### 4.8 `PUT /api/projects/:id/members` 🆕 任命项目角色

> **全量覆盖语义**：传入的数组即为最终成员列表，未出现的成员会被移除。

**请求**
```json
{
  "members": [
    { "userOpenId": "ou_zhangsan", "projectRole": "pm" },
    { "userOpenId": "ou_lisi",     "projectRole": "tl" },
    { "userOpenId": "ou_lisi",     "projectRole": "qa" },
    { "userOpenId": "ou_zhaoliu",  "projectRole": "member" }
  ]
}
```

**成功 200**
```json
{
  "code": 0,
  "data": {
    "items": [ /* 同 §4.7 */ ],
    "added": ["ou_zhaoliu"], "removed": ["ou_wangwu"], "unchanged": ["ou_zhangsan","ou_lisi"]
  },
  "message": "ok"
}
```

**错误**
| HTTP | code | 场景 | data |
|---|---|---|---|
| 400 | `E_ROLE_CARDINALITY` | pm/tl 不是恰好 1 人 | `{role:"tl",count:0,expected:1}` |
| 400 | `E_PROJECT_PO_REQUIRED` | B 类移除了唯一 PO | `{type:"B",missing:["po"]}` |
| 404 | `E_NOT_FOUND` | 某 `userOpenId` 不存在 | `{unknownUsers:["ou_xxx"]}` |

> 同一人可担任多个项目角色（如 `tl` 兼 `qa`），权限取并集。

### 4.9 `POST /api/projects/:id/transition` 🆕 项目状态机流转（P0-17）

**请求**
```json
{ "action": "suspend", "reason": "客户方场地未就绪，暂停 2 周" }
```

| `action` | 允许的源状态 | 目标状态 | 备注 |
|---|---|---|---|
| `submit` | `草稿` / `已驳回` | `审批中` | 自动拉起立项评审（见 §11.8） |
| `suspend` | `进行中` | `挂起` | `reason` 必填 |
| `resume` | `挂起` | `进行中` | `reason` 选填 |
| `terminate` | `草稿`/`审批中`/`已批准`/`进行中`/`挂起` | `已终止` | `reason` 必填，**不可逆** |

**成功 200**
```json
{
  "code": 0,
  "data": { "id":"P1a2b", "status":"挂起", "previousStatus":"进行中",
            "transitionedAt":"2026-03-17T09:30:00+08:00", "reason":"客户方场地未就绪，暂停 2 周",
            "reviewId": null },
  "message": "ok"
}
```

**错误**
| HTTP | code | 场景 | data |
|---|---|---|---|
| 400 | `E_INVALID_TRANSITION` | 状态机不允许 | `{from:"已结项",action:"suspend",allowedActions:[]}` |
| 400 | `E_VALIDATION` | `suspend`/`terminate` 未填 reason | `{fields:[…]}` |
| 400 | `E_PROJECT_PO_REQUIRED` | B 类 `submit` 时无 PO | `{missing:["po"]}` |

---

## 5. 阶段与推进

### 5.1 `GET /api/projects/:id/stages` 🆕 阶段 + 门状态（P0-02）

> **项目概览页的阶段条数据源**。一次返回全部阶段与门摘要。

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "currentStageId": "STc3",
    "items": [
      { "id":"STa1","seq":1,"code":"S1","name":"立项","status":"已完成",
        "startedAt":"2026-01-05T09:00:00+08:00","finishedAt":"2026-01-12T17:00:00+08:00",
        "gate": { "id":"Ga1","code":"QG1","name":"立项门","ownerRole":"pmo","status":"已通过",
                  "itemTotal":7,"itemChecked":7,
                  "decidedBy":"ou_pmo","decidedByName":"钱七","decidedAt":"2026-01-12T16:30:00+08:00" } },
      { "id":"STc3","seq":4,"code":"S4","name":"开发与首件调试","status":"进行中",
        "startedAt":"2026-02-20T09:00:00+08:00","finishedAt":null,
        "gate": { "id":"Gd4","code":"QG4","name":"编码与测试门","ownerRole":"qa","status":"待检查",
                  "itemTotal":6,"itemChecked":4,
                  "decidedBy":null,"decidedByName":null,"decidedAt":null } },
      { "id":"STe5","seq":5,"code":"S5","name":"集成测试与出厂","status":"未开始",
        "startedAt":null,"finishedAt":null,
        "gate": { "id":"Ge5","code":"QG5","name":"出厂/验收准备门","ownerRole":"qa","status":"未开始",
                  "itemTotal":6,"itemChecked":0,"decidedBy":null,"decidedByName":null,"decidedAt":null } }
    ],
    "canAdvance": false,
    "advanceBlockers": [
      "质量门 QG4「编码与测试门」尚未出具结论（当前：待检查）",
      "检查项未完成：代码评审 100% 完成；遗留问题已闭环或有明确关闭计划",
      "检查项未完成：配置项已全部入库并打版本标签"
    ],
    "nextStage": { "id":"STe5","seq":5,"code":"S5","name":"集成测试与出厂" }
  },
  "message": "ok"
}
```

> **`canAdvance` + `advanceBlockers` 由后端算好直接给**，前端「进入下一阶段」按钮的 disabled 与 Tooltip 直接绑定这两个字段，**禁止前端自行推断**（T08 完成判定）。

### 5.2 `POST /api/projects/:id/advance` 🆕 推进到下一阶段（P0-02 / P0-03）

**请求**
```json
{ "confirm": true, "comment": "QG4 已通过，进入集成测试阶段" }
```

**成功 200**
```json
{
  "code": 0,
  "data": {
    "from": { "id":"STc3","seq":4,"code":"S4","name":"开发与首件调试","status":"已完成" },
    "to":   { "id":"STe5","seq":5,"code":"S5","name":"集成测试与出厂","status":"进行中" },
    "projectStatus": "进行中",
    "advancedAt": "2026-03-20T11:00:00+08:00"
  },
  "message": "ok"
}
```

**错误 —— ⚠️ 这是全系统最重要的硬拦截**
```jsonc
// HTTP 403
{
  "code": "E_GATE_NOT_PASSED",
  "data": {
    "stageId": "STc3", "stageName": "开发与首件调试",
    "gateId": "Gd4", "gateCode": "QG4", "gateName": "编码与测试门", "gateStatus": "待检查",
    "blockers": [
      { "type":"gate_status", "text":"质量门尚未出具结论（当前：待检查）" },
      { "type":"checklist_item", "itemId":"GI43", "text":"代码评审 100% 完成；遗留问题已闭环或有明确关闭计划", "ownerRole":"tl" },
      { "type":"checklist_item", "itemId":"GI44", "text":"配置项已全部入库并打版本标签", "ownerRole":"cm" }
    ]
  },
  "message": "质量门未通过，无法进入下一阶段"
}
```

| HTTP | code | 场景 |
|---|---|---|
| 403 | `E_GATE_NOT_PASSED` | 当前阶段门 ∉ {已通过, 有条件通过} |
| 400 | `E_STAGE_SEQUENCE` | 已是最后一个阶段（`{seq:6,total:6}`）—— ⚠️ **契约已定义，实现未落地（计划下轮，WBS 重构 D-5）**；当前实际以 `E_GATE_NOT_PASSED` 拦截越阶推进 |
| 403 | `E_FORBIDDEN` | 无 `stage:advance` |

> `blockers` 是**结构化数组**（不是字符串数组），前端可以点击 `checklist_item` 直接跳到该检查项。§5.1 的 `advanceBlockers` 为便于展示用的字符串版，两者并存。

### 5.3 `GET /api/projects/:id/close-check` 🆕 结项预检（P0-17）

> **只读、无副作用**。结项按钮点击前先调它，把阻塞项摊开给用户看。

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "closable": false,
    "blockers": [
      { "type":"gate",      "refId":"Gf6","text":"质量门 QG6「结项门」未通过（当前：待检查）" },
      { "type":"milestone", "refId":"M7", "text":"里程碑 M7「项目结项」未达成（计划 2026-06-30）" },
      { "type":"change",    "refId":"CR5","text":"变更单 CR-005 仍在审批中" },
      { "type":"review",    "refId":"RVb2","text":"评审「出厂检验报告评审」仍在审批中" }
    ],
    "warnings": [
      { "type":"task", "text":"仍有 3 个任务未完成（不阻塞结项，将随项目一并归档）" },
      { "type":"report","text":"2026-W24 周报未提交" }
    ],
    "checklist": [
      { "key":"allGatesPassed",   "label":"全部质量门已通过",   "passed": false, "detail":"5/6" },
      { "key":"allMilestonesDone","label":"全部里程碑已达成",   "passed": false, "detail":"6/7" },
      { "key":"noOpenChanges",    "label":"无审批中的变更单",   "passed": false, "detail":"1 个" },
      { "key":"noOpenReviews",    "label":"无审批中的评审",     "passed": false, "detail":"1 个" }
    ]
  },
  "message": "ok"
}
```

> **`blockers` 阻塞结项，`warnings` 不阻塞**。这个区分很重要 —— 制度要求「门、里程碑、变更必须闭环」，但不要求「所有任务都做完」（任务可能因范围缩减而作废）。

### 5.4 `POST /api/projects/:id/close` 🆕 结项（P0-17）

**请求**
```json
{ "actualEnd": "2026-06-28", "summary": "项目按期交付，客户验收一次通过，遗留 2 项售后事项已移交运维。", "confirm": true }
```

**成功 200**
```json
{
  "code": 0,
  "data": { "id":"P1a2b", "status":"已结项", "actualEnd":"2026-06-28",
            "closedAt":"2026-06-30T18:00:00+08:00", "readonly": true },
  "message": "ok"
}
```

**错误**
```jsonc
// HTTP 409 —— 与 close-check 的 blockers 同构
{
  "code": "E_CLOSE_BLOCKED",
  "data": { "blockers": [ { "type":"gate","refId":"Gf6","text":"质量门 QG6「结项门」未通过（当前：待检查）" } ] },
  "message": "存在未闭环事项，无法结项"
}
```

> 结项成功后该项目下**所有写接口**立即返回 `E_PROJECT_ARCHIVED`（§0.6）。

---

## 6. 质量门（P0-03）

### 6.1 `GET /api/gates?projectId=` 🆕 门列表

**成功 200**
```json
{
  "code": 0,
  "data": {
    "items": [
      { "id":"Ga1","projectId":"P1a2b","stageId":"STa1","stageSeq":1,"stageName":"立项",
        "code":"QG1","name":"立项门","ownerRole":"pmo","status":"已通过",
        "itemTotal":7,"itemChecked":7,
        "conclusion":"符合立项条件，同意进入需求阶段","comment":null,
        "decidedBy":"ou_pmo","decidedByName":"钱七","decidedAt":"2026-01-12T16:30:00+08:00" }
    ],
    "total": 6, "page": 1, "pageSize": 20
  },
  "message": "ok"
}
```

### 6.2 `GET /api/gates/:id` 🆕 门详情 + 检查项

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "id":"Gd4","projectId":"P1a2b","stageId":"STc3","stageSeq":4,"stageName":"开发与首件调试",
    "code":"QG4","name":"编码与测试门","ownerRole":"qa","status":"待检查",
    "conclusion":null,"comment":null,"decidedBy":null,"decidedByName":null,"decidedAt":null,
    "itemTotal":6,"itemChecked":4,
    "canDecide": false,
    "decideBlockers": ["存在 2 项未确认的检查项"],
    "items": [
      { "id":"GI41","seq":1,"content":"单元测试覆盖率 ≥60%，关键模块 ≥80%，报告已归档",
        "ownerRole":"qa","checked":true,
        "checkedBy":"ou_wangwu","checkedByName":"王五","checkedAt":"2026-03-18T14:00:00+08:00",
        "source":"template","canCheck": false, "canDelete": false },
      { "id":"GI43","seq":3,"content":"代码评审全部完成；遗留问题已闭环或有明确关闭计划",
        "ownerRole":"tl","checked":false,
        "checkedBy":null,"checkedByName":null,"checkedAt":null,
        "source":"template","canCheck": false, "canDelete": false },
      { "id":"GI47","seq":7,"content":"本项目专属：EMC 预测试已通过",
        "ownerRole":"qa","checked":false,
        "checkedBy":null,"checkedByName":null,"checkedAt":null,
        "source":"custom","canCheck": true, "canDelete": true }
    ]
  },
  "message": "ok"
}
```

| 派生字段 | 规则 |
|---|---|
| `canCheck` | 当前用户是该项 `ownerRole`（或 admin）→ `true`。前端据此禁用复选框 |
| `canDelete` | `source==='custom'` 且有 `gate:item:add` 权限 → `true`。**`template` 项恒为 `false`**（Q6 约束） |
| `canDecide` | 当前用户是门 `ownerRole`（或 admin）且 `itemChecked === itemTotal` |
| `decideBlockers` | `canDecide=false` 的原因清单 |

### 6.3 `PUT /api/gates/:id/items/:itemId` 🆕 勾选/取消检查项

**请求**
```json
{ "checked": true }
```

**成功 200**
```json
{
  "code": 0,
  "data": {
    "item": { "id":"GI43","checked":true,"checkedBy":"ou_lisi","checkedByName":"李四",
              "checkedAt":"2026-03-19T10:05:00+08:00" },
    "gate": { "id":"Gd4","status":"待检查","itemTotal":6,"itemChecked":5,
              "canDecide":false,"decideBlockers":["存在 1 项未确认的检查项"] }
  },
  "message": "ok"
}
```

> **响应同时回传门的最新汇总**，前端不必再拉一次详情。

**错误**
| HTTP | code | 场景 | data |
|---|---|---|---|
| 403 | `E_FORBIDDEN` | 当前用户不是该项 `ownerRole` | `{required:"gate:item:check", itemOwnerRole:"tl", yourProjectRoles:["qa"]}` |
| 409 | `E_GATE_DECIDED` | 门已出结论，不可再改勾选 | `{gateStatus:"已通过"}` |

### 6.4 `POST /api/gates/:id/items` 🆕 追加项目专属检查项

**请求**
```json
{ "content": "本项目专属：EMC 预测试已通过", "ownerRole": "qa" }
```

**成功 201**
```json
{
  "code": 0,
  "data": {
    "item": { "id":"GI47","gateId":"Gd4","seq":7,"content":"本项目专属：EMC 预测试已通过",
              "ownerRole":"qa","checked":false,"source":"custom","canCheck":true,"canDelete":true },
    "gate": { "id":"Gd4","itemTotal":7,"itemChecked":4 }
  },
  "message": "ok"
}
```

> 追加项 `seq` 自动接在末尾，`source` 强制为 `"custom"`（请求里传 `source` 会被忽略）。

**错误**：`409 E_GATE_DECIDED`（门已决议不可追加）、`403 E_FORBIDDEN`。

### 6.5 `POST /api/gates/:id/decide` 🆕 出具门控结论

**请求**
```json
{
  "status": "有条件通过",
  "conclusion": "主体功能达标，同意进入集成测试阶段",
  "comment": "遗留项：EMC 正式测试需在 M5 前补充完成，责任人李四，时限 2026-04-30"
}
```

| `status` 取值 | 语义 | 对推进的影响 |
|---|---|---|
| `已通过` | 全部达标 | 允许 advance |
| `有条件通过` | 有遗留项但可放行 | 允许 advance，**`comment` 必填**（写明遗留项、责任人、时限） |
| `不通过` | 打回 | 禁止 advance，阶段保持 `进行中` |

**成功 200**
```json
{
  "code": 0,
  "data": {
    "gate": { "id":"Gd4","status":"有条件通过",
              "conclusion":"主体功能达标，同意进入集成测试阶段",
              "comment":"遗留项：EMC 正式测试需在 M5 前补充完成，责任人李四，时限 2026-04-30",
              "decidedBy":"ou_wangwu","decidedByName":"王五","decidedAt":"2026-03-20T10:30:00+08:00" },
    "stage": { "id":"STc3","status":"进行中" },
    "canAdvance": true
  },
  "message": "ok"
}
```

**错误**
| HTTP | code | 场景 | data |
|---|---|---|---|
| 400 | `E_GATE_ITEM_INCOMPLETE` | 仍有未勾选检查项 | `{unchecked:[{itemId:"GI43",content:"…",ownerRole:"tl"}]}` |
| 400 | `E_VALIDATION` | `有条件通过` 未填 `comment` | `{fields:[{field:"comment",message:"「有条件通过」必须写明遗留项、责任人与时限"}]}` |
| 403 | `E_FORBIDDEN` | 非门 `ownerRole` | `{required:"gate:decide", gateOwnerRole:"qa"}` |
| 409 | `E_GATE_DECIDED` | 已决议且不允许重复决议 | `{gateStatus:"已通过", decidedAt:"…"}` |

> **`不通过` 后允许重新决议**（整改后再检），`已通过`/`有条件通过` 后如需推翻，需 PMO 走变更流程 —— 一期先返回 `E_GATE_DECIDED`，由 admin 兜底处理。

---

---

## 7. 里程碑（P0-05）

> **单向约束核心域（WBS 重构后对齐实现）**：`planned_date` **提前可直接改**（`delayDays` 可为负，写审计「日期提前」）；**延后必须经变更单驱动写入**（直接 `PUT` 延后 → `E_MS_NEED_CHANGE` 并回传预填变更单草稿）。**不存在「提前被拒」路径**（旧的「不可提前」死码已随 WBS 重构删除）。`baseline_date` 任何路径不可写。这是与 §12 变更强耦合的关键交互点。

### 7.1 `GET /api/milestones` ♻️ 里程碑列表

**请求** `GET /api/milestones?projectId=P1a2b&status=进行中,已逾期&code=M3&q=首件&page=1&pageSize=20`

| 参数 | 必填 | 说明 |
|---|---|---|
| `projectId` | 是 | 项目 ID |
| `status` | 否 | 多值逗号分隔：`未开始,进行中,已达成,已逾期` |
| `code` | 否 | 精确里程碑编号，如 `M3` |
| `q` | 否 | 名称模糊搜索 |

**成功 200**
```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "id": "M3", "projectId": "P1a2b", "code": "M3", "name": "设计评审通过",
        "plannedDate": "2026-02-28", "baselineDate": "2026-02-28", "delayDays": 0,
        "stageId": "STc3", "anchor": "end",
        "status": "已达成", "achievedAt": "2026-02-26T17:00:00+08:00",
        "lastChangeId": null, "changeCount": 0,
        "category": "required", "source": "template"
      },
      {
        "id": "M4", "projectId": "P1a2b", "code": "M4", "name": "首件调试完成",
        "plannedDate": "2026-03-30", "baselineDate": "2026-03-20", "delayDays": 10,
        "stageId": null, "anchor": null,
        "status": "进行中", "achievedAt": null,
        "lastChangeId": "CR-003", "changeCount": 1, "delayReason": "客户场地未就绪",
        "category": "required", "source": "template"
      }
    ],
    "total": 7, "page": 1, "pageSize": 20
  },
  "message": "ok"
}
```

| 派生/计算字段 | 规则 |
|---|---|
| `delayDays` | `plannedDate − baselineDate`（天，可正/0/负）。负 = 提前 |
| `status` | 有 `achievedAt` → `已达成`；`plannedDate < 今天` 且无 `achievedAt` → `已逾期`；其余 → `进行中`/`未开始` |
| `baselineDate` | 首次写入值，**任何路径不可改**（Repository 白名单丢弃 + 审计告警） |
| `stageId` / `anchor` | **WBS 重构新增**：里程碑锚定的生命周期阶段 id + 阶段内锚点（`start`/`mid`/`end`）；`stageId===null` 表示未归属（UI 灰色可补选），`anchor` 随 `stageId` 同生同灭 |
| 前端展示 | `M4 · 03-30 (+10 变更#CR-003)` 由前端拼装，`delayDays` + `lastChangeId` 已给足原料 |

> ⚠️ **命名映射（WBS 重构 T-08）**：API/TS 层里程碑当前计划日期字段为 **`currentDate`**（mock 实现），契约文档统一写作 **`plannedDate`**（DB `planned_date`），二者同指一列。S2 落库时须显式转换，勿混用。

### 7.2 `POST /api/milestones` ♻️ 新建里程碑（写入 baseline_date）

> 仅用于新增**自定义可选里程碑**（模板必需里程碑由实例化自动建）。新建即把 `plannedDate` 同步写入 `baselineDate`，`delayDays=0`。

**请求**
```json
{
  "projectId": "P1a2b",
  "code": "M8", "name": "客户复验",
  "plannedDate": "2026-07-10",
  "category": "optional",
  "note": "应客户要求新增复验里程碑"
}
```

**成功 201**
```json
{
  "code": 0,
  "data": {
    "milestone": {
      "id": "M8", "projectId": "P1a2b", "code": "M8", "name": "客户复验",
      "plannedDate": "2026-07-10", "baselineDate": "2026-07-10", "delayDays": 0,
      "status": "未开始", "achievedAt": null, "lastChangeId": null, "changeCount": 0,
      "category": "optional", "source": "custom"
    },
    "warnings": []
  },
  "message": "ok"
}
```

**错误**
| HTTP | code | 场景 | data |
|---|---|---|---|
| 400 | `E_VALIDATION` | 缺 `code`/`name`/`plannedDate` | `{fields:[…]}` |
| 409 | `E_MS_DUP_CODE` | 编号重复 | `{code:"M8"}` |
| 403 | `E_FORBIDDEN` | 无 `milestone:create` | 见 §0.7 |

### 7.3 `PUT /api/milestones/:id` ♻️ 编辑（含单向拦截）

> 仅 `name`/`category`/`note` 与 `plannedDate` 可改。`plannedDate` 走单向规则，**这是全系统第二重要的硬拦截**（仅次于 §5.2 质量门）。

**请求**
```json
{ "name": "首件调试完成（复验）", "plannedDate": "2026-03-30" }
```

**成功 200** — `data.milestone` 为 §7.1 单对象形态（`delayDays` 等重新计算）。

**错误 —— 单向约束（核心）**
```jsonc
// HTTP 200 —— 试图「提前」（requested < 当前 planned）→ 直接生效
// 提前允许直接改，delayDays 可为负，写审计「日期提前」（无「提前被拒」路径）

// HTTP 409 —— 试图「延后」（requested > 当前 planned）→ 必须走变更单
{
  "code": "E_MS_NEED_CHANGE",
  "data": {
    "milestoneId":"M3", "currentDate":"2026-03-20", "requestedDate":"2026-03-30",
    "baselineDate":"2026-03-20", "diffDays": 10,
    "changeDraft": {
      "changeType":"milestone_date",
      "targetId":"M3", "targetCode":"M3",
      "payload": { "from":"2026-03-20", "to":"2026-03-30" },
      "reason": "里程碑延后 10 天",
      "impactAnalysis": "影响后续集成测试与出厂节点排期",
      "effortDays": 10
    }
  },
  "message": "里程碑延后需走变更流程，已为您预填变更单草稿"
}
```

> **方向判定表**（`requested` vs 当前 `plannedDate`）：
>
> | 输入 | 判定 | 响应 |
> |---|---|---|
> | 提前（requested < current） | 直接生效 | `200` + 审计「里程碑 Mx 日期提前」，`delay_days` 可为负 |
> | 相同（requested === current） | 空操作 | `200`，不报错、不记审计 |
> | 延后（requested > current） | 拒绝 | `400/409 E_MS_NEED_CHANGE` + `data.changeDraft` 预填变更单 |
> | `baselineDate` | 任何路径不可写 | 维持既有 |
>
> 前端判定：收到 `E_MS_NEED_CHANGE` 时**自动跳转「变更申请」页并填入 `data.changeDraft`**（见 §12.2），形成「改期 → 变更」闭环；**提前路径直接成功**，弹绿色提示「已提前并记录审计」，不进变更流程。
>
> **补锚 / 改锚**（`stageId` + `anchor`）不触发方向判定，走普通审计；`stageId` 须属于同一项目。

### 7.4 `DELETE /api/milestones/:id` ♻️ 删除里程碑

**成功 200**
```json
{ "code": 0, "data": { "id": "M8", "deletedAt": "2026-03-17T09:00:00+08:00" }, "message": "ok" }
```

**错误**
| HTTP | code | 场景 | data |
|---|---|---|---|
| 400 | `E_MS_DELETE_REQUIRED` | 删除模板必需里程碑 | `{category:"required", name:"首件调试完成"}` |
| 409 | `E_MS_LINKED_WBS` | 有 WBS 任务关联此里程碑 | `{refNodes:["We5f","We6g"]}` |
| 403 | `E_FORBIDDEN` | 非项目 PM/admin | 见 §0.7 |

---

## 8. WBS（P0-06 / P0-07）

> **单表自引用树**（`wbs_nodes`：`parent_id` + `wbs_code` + `level`）。服务端负责编码生成与重排；看板（§9）与树（本域）共用同一批叶子节点。旧 `/api/tasks` 作兼容别名保留（§8.6–§8.7）。

### 8.0 层级校验规则 R-1~R-6（WBS 重构 D-2 · 模板驱动）

> 规则源 = `lifecycle_templates.definition.wbsRules`，经 `resolveWbsRules(template)` 与 `DEFAULT_WBS_RULES` 合并后生效（三类项目层级规则**一致强制**；差异仅 `requireStageBinding`：A/C=true、B=false）。`validateWbsPlacement` 为引擎与前端共用同一纯函数。

| 规则 | 内容 | 违反错误码 |
|---|---|---|
| **R-1 深度** | 节点层级 ≤ `maxDepth`（缺省 4；`level` 从 1 起算） | `E_WBS_DEPTH` |
| **R-2 父子类型** | `nodeType ∈ childTypes[parent.nodeType ?? 'root']`（白名单：root→stage/package、stage→package/task、package→task、task→[] 必为叶） | `E_WBS_PARENT_TYPE` |
| **R-3 编码** | `wbs_code` 由服务端生成，前端只读 | `E_WBS_CODE_FROZEN` |
| **R-4 类型锁** | 已有子节点的节点**不可改** `nodeType` | `E_WBS_TYPE_LOCKED` |
| **R-5 叶子完整** | `task` 必填 `owner` + `estimateDays` | `E_WBS_LEAF_INCOMPLETE` |
| **R-6 stage 绑定** | `nodeType==='stage'` 且 `requireStageBinding=true` 时必填 `lifecycleStageId`（B 类 false 可空） | `E_WBS_STAGE_UNBOUND` |

**跨项目引用**：`lifecycleStageId` / `milestoneId` / `parentId` 所引用的对象必须属于同一 `projectId`，否则 `E_VALIDATION`（mock 引擎与 S2 一致）。

**移动独有（§8.5）**：目标父类型合法（R-2）且**移动后整棵子树**深度不超限（R-1 子树整体判定，`subtreeRelativeDepth`），否则 `E_WBS_PARENT_TYPE` / `E_WBS_DEPTH`。

### 8.1 `GET /api/wbs` 🆕 WBS 树（嵌套）

> **特例说明**：本接口返回「项目 WBS 单棵层级资源」，不使用 §0.1 的 `items` 分页包络（扁平列表接口仍遵守）。`GET /api/tasks`（§8.6）才是扁平分页列表别名。

**请求** `GET /api/wbs?projectId=P1a2b&nodeType=task&status=进行中&owner=ou_lisi&q=联调`

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "rootId": "Wr00",
    "tree": {
      "id":"Wr00","parentId":null,"wbsCode":"0","level":0,
      "name":"XX型号地面测试设备","nodeType":"stage","status":null,
      "lifecycleStageId": null, "milestoneId": null,
      "ownerOpenId":null,"ownerName":null,"assigneeOpenId":null,"assigneeName":null,
      "estimateDays":null,"actualDays":null,"progress":62,
      "startDate":null,"dueDate":null,"leaf":false,"childCount":3,"descendantTaskCount":30,
      "children": [
        {
          "id":"Wp12","parentId":"Wr00","wbsCode":"1","level":1,"name":"硬件研制","nodeType":"package",
          "status":null,"ownerOpenId":"ou_lisi","ownerName":"李四",
          "lifecycleStageId": null, "milestoneId": null,
          "assigneeOpenId":null,"assigneeName":null,
          "estimateDays":null,"actualDays":null,"progress":55,"leaf":false,"childCount":2,
          "children": [
            {
              "id":"We5f","parentId":"Wp12","wbsCode":"1.2.3","level":2,"name":"电源模块联调",
              "nodeType":"task","status":"进行中",
              "lifecycleStageId": null, "milestoneId":"M4",
              "ownerOpenId":"ou_lisi","ownerName":"李四",
              "assigneeOpenId":"ou_zhangsan","assigneeName":"张三",
              "estimateDays":3,"actualDays":1,"progress":40,
              "startDate":"2026-03-10","dueDate":"2026-03-18",
              "milestoneId":"M4","milestoneName":"首件调试完成",
              "overdue": true, "leaf": true
            }
          ]
        }
      ]
    },
    "taskStats": { "total":30, "done":18, "inProgress":9, "blocked":1, "overdue":2 }
  },
  "message": "ok"
}
```

| 派生字段 | 规则 |
|---|---|
| `ownerName` / `assigneeName` | 同 §0.3，人已移除返回 `"(已移除)"` |
| `leaf` | `nodeType==='task'` 且 `childCount===0` |
| `overdue` | `task` + `dueDate < 今天` + `status!=='完成'` |
| `wbsCode` | 服务端生成（父子层级 + 同级序号），前端**只读** |

### 8.2 `POST /api/wbs` 🆕 新建节点（自动编码 + 粒度校验）

**请求**
```json
{
  "projectId": "P1a2b", "parentId": "Wp12", "name": "电源模块联调", "nodeType": "task",
  "ownerOpenId": "ou_lisi", "assigneeOpenId": "ou_zhangsan",
  "estimateDays": 3, "startDate": "2026-03-10", "dueDate": "2026-03-18",
  "milestoneId": "M4"
}
```

**成功 201** — `data.node` 为 §8.1 扁平节点形态（含服务端生成的 `wbsCode:"1.2.3"`、`level:2`）。

**错误**
| HTTP | code | 场景 | data |
|---|---|---|---|
| 400 | `E_VALIDATION` | 缺 `parentId`/`name`/`nodeType`；或 `parentId`/`lifecycleStageId`/`milestoneId` 跨项目引用 | `{fields:[…]}` |
| 400 | `E_WBS_PARENT_TYPE` | 子类型不在父节点白名单（R-2，含 `task` 下挂子节点、根下挂 `task`） | `{parentNodeType, childNodeType, allowed[]}` |
| 400 | `E_WBS_DEPTH` | 超过 `maxDepth`（R-1） | `{depth, maxDepth}` |
| 400 | `E_WBS_STAGE_UNBOUND` | `stage` 未绑 `lifecycleStageId` 且 `requireStageBinding=true`（R-6） | `{nodeType:"stage"}` |
| 400 | `E_WBS_LEAF_INCOMPLETE` | 叶子任务缺 `owner` 或 `estimateDays`（R-5，位置在结构校验之后） | `{missing:["ownerOpenId","estimateDays"]}` |
| 400 | `E_WBS_GRANULARITY` | 叶子 `estimateDays` 超模板上限 | `{estimateDays:8, maxLeafDays:5}` |
| 403 | `E_FORBIDDEN` | 无 `wbs:edit` | 见 §0.7 |

**请求 payload 扩展（WBS 重构）**
```json
{
  "projectId": "P1a2b", "parentId": "Wr00", "name": "设计工作分区", "nodeType": "stage",
  "lifecycleStageId": "STc3",     // 仅 nodeType='stage' 有意义；A/C 必填、B 可空
  "milestoneId": null             // 仅 package/task 可挂；跨项目引用一律 E_VALIDATION
}
```

### 8.3 `PUT /api/wbs/:id` 🆕 编辑节点

**请求**（部分更新）
```json
{ "name": "电源模块联调（修订）", "estimateDays": 4, "dueDate": "2026-03-20", "ownerOpenId": "ou_lisi" }
```

**成功 200** — `data.node` 为更新后扁平节点。

> `wbsCode`/`parentId`/`level` 为系统字段：请求带 `parentId` 视为无效（改父用 §8.5 `/move`），其余忽略静默。

**错误**：`E_WBS_LEAF_INCOMPLETE`、`E_WBS_GRANULARITY`、`E_WBS_TYPE_LOCKED`（R-4：有子节点改 `nodeType`）、`E_WBS_PARENT_TYPE`（改类型后对其父重校验）、`E_VALIDATION`（`lifecycleStageId`/`milestoneId` 跨项目引用）、`E_FORBIDDEN`（同 §8.2）。

### 8.4 `DELETE /api/wbs/:id` 🆕 删除（级联需确认）

> 有子节点时必须显式 `cascade:true`，否则返回 `E_WBS_HAS_CHILDREN`。

**请求** `DELETE /api/wbs/Wp12` + Body `{ "cascade": true }`

**成功 200**
```json
{ "code": 0, "data": { "id":"Wp12", "deletedCount": 5, "deletedAt":"2026-03-17T09:00:00+08:00" }, "message": "ok" }
```

**错误**
| HTTP | code | 场景 |
|---|---|---|
| 409 | `E_WBS_HAS_CHILDREN` | 有子节点未确认级联 |
| 400 | `E_VALIDATION` | 删除**已绑定 `lifecycleStageId` 且非空**的工作分区（`{reason:'stage_not_empty', childCount}`，骨架保护） |
| 403 | `E_FORBIDDEN` | 无 `wbs:edit` |

### 8.5 `POST /api/wbs/:id/move` 🆕 移动并重排编码

> 支持跨父移动；服务端重算被移动子树及受影响兄弟的 `wbsCode`，并递增 `treeVersion`。

**请求**
```json
{ "targetParentId": "Wp13", "targetIndex": 1 }
```

**成功 200**
```json
{
  "code": 0,
  "data": {
    "moved": false,
    "movedId": "We5f", "newWbsCode": "1.3.2", "treeVersion": 12,
    "affectedCodes": ["1.2.1","1.2.2","1.3.1","1.3.2"]
  },
  "message": "ok"
}
```

**错误**
| HTTP | code | 场景 | data |
|---|---|---|---|
| 400 | `E_WBS_MOVE_CYCLE` | 移动到自己的子孙下 | `{targetParentId:"We5f"}` |
| 400 | `E_WBS_PARENT_TYPE` | 目标父类型不在白名单（R-2，含 `stage` 移入非根） | `{targetParentId, parentNodeType, nodeType, allowed[]}` |
| 400 | `E_WBS_DEPTH` | 移动后**整棵子树**深度超限（R-1 子树整体判定） | `{targetLevel, subtreeDepth, resultDepth, maxDepth}` |
| 403 | `E_FORBIDDEN` | 无 `wbs:edit` | 见 §0.7 |

### 8.6 `GET /api/tasks` ♻️ 兼容别名（扁平任务列表）

> 旧前端使用。等价于 `/api/wbs` 但返回**扁平分页列表**（不嵌套），`nodeType` 默认 `task`。**新代码不要用**。

**请求** `GET /api/tasks?projectId=P1a2b&status=进行中&owner=ou_lisi&page=1&pageSize=20`

**成功 200** — `data.{items,total,page,pageSize}`，`items` 为 §8.1 扁平任务节点数组。

### 8.7 `POST /api/tasks` ♻️ 兼容别名（新建任务）

> 旧前端使用，等价于 `POST /api/wbs`（`nodeType` 强制 `task`）。**新代码不要用**，T33 后可下线。错误码同 §8.2。

---

## 9. 看板（P0-07）

> 看板 = 同一批叶子节点按 `status` 分组的双视图之一。四列固定：`待办`/`进行中`/`待评审`/`完成`。WIP 上限可配。

### 9.1 `GET /api/board` 🆕 看板四列 + WIP 配置

**请求** `GET /api/board?projectId=P1a2b`

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "columns": [
      { "status":"待办",  "wipLimit":null, "items":[ /* 扁平任务节点 */ ], "count":3, "wipExceeded":false },
      { "status":"进行中","wipLimit":5,    "items":[ /* 扁平任务节点 */ ], "count":5, "wipExceeded":false },
      { "status":"待评审","wipLimit":null, "items":[ /* 扁平任务节点 */ ], "count":2, "wipExceeded":false },
      { "status":"完成",  "wipLimit":null, "items":[ /* 扁平任务节点 */ ], "count":12,"wipExceeded":false }
    ],
    "wipConfig": { "进行中":5 },
    "taskStats": { "total":22, "done":12, "inProgress":5, "blocked":1 }
  },
  "message": "ok"
}
```

> `items` 内为 §8.1 的扁平任务节点（含 `wbsCode`/`ownerName`/`overdue`）。`wipLimit=null` 表示该列不限流。

### 9.2 `POST /api/board/move` 🆕 拖拽改状态（WIP 超限 409）

**请求**
```json
{ "taskId": "We5f", "fromStatus": "进行中", "toStatus": "待评审", "targetIndex": 0 }
```

**成功 200**
```json
{
  "code": 0,
  "data": {
    "task": { "id":"We5f","wbsCode":"1.2.3","name":"电源模块联调","status":"待评审",
              "ownerName":"李四","progress":40 },
    "board": {
      "进行中": { "count":4, "wipLimit":5, "wipExceeded":false },
      "待评审": { "count":3, "wipLimit":null, "wipExceeded":false }
    }
  },
  "message": "ok"
}
```

**错误 —— WIP 硬拦截（典型 409 场景）**
```jsonc
// HTTP 409 —— 目标列已达 WIP 上限，引导用户先腾列
{
  "code": "E_WIP_EXCEEDED",
  "data": { "status":"进行中", "limit":5, "current":5, "wouldBe":6 },
  "message": "「进行中」列已达 WIP 上限（5），请先推进其它任务"
}
```

| HTTP | code | 场景 |
|---|---|---|
| 409 | `E_WIP_EXCEEDED` | 目标列超限（见上） |
| 400 | `E_WBS_INVALID_STATUS` | `toStatus` 不在枚举 |
| 403 | `E_FORBIDDEN` | 无 `task:status` |

### 9.3 `PUT /api/board/config` 🆕 设置 WIP 上限

**请求**
```json
{ "wipLimits": { "进行中": 5, "待评审": 3 } }
```

**成功 200**
```json
{ "code": 0, "data": { "wipLimits": { "进行中":5, "待评审":3 }, "appliedAt": "2026-03-17T09:00:00+08:00" }, "message": "ok" }
```

**错误**
| HTTP | code | 场景 |
|---|---|---|
| 400 | `E_VALIDATION` | `wipLimits` 值非正整数 |
| 403 | `E_FORBIDDEN` | 非项目 PM/TL（`board:config`） |

---

## 10. 周报（P0-08）

> 四段校验（风险 owner/due 必填、计划任务 actualDone 必填、progress 范围、summary 非空）+ 提交后进度冻结为 `snapshot`。

### 10.1 `GET /api/reports` ♻️ 周报列表/历史

**请求** `GET /api/reports?projectId=P1a2b&week=2026-W11&status=已提交&page=1&pageSize=20`

**成功 200**
```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "id":"RP01","projectId":"P1a2b","week":"2026-W11","weekStart":"2026-03-09","weekEnd":"2026-03-15",
        "authorOpenId":"ou_zhangsan","authorName":"张三","status":"已提交",
        "progress":62,"riskCount":1,"submittedAt":"2026-03-15T17:00:00+08:00"
      }
    ],
    "total": 4, "page": 1, "pageSize": 20
  },
  "message": "ok"
}
```

### 10.2 `GET /api/reports/draft` 🆕 取草稿 + 自动带出本周任务

**请求** `GET /api/reports/draft?projectId=P1a2b&week=2026-W11`

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "exists": true,
    "draft": {
      "id":"RP01","projectId":"P1a2b","week":"2026-W11","weekStart":"2026-03-09","weekEnd":"2026-03-15",
      "authorOpenId":"ou_zhangsan","authorName":"张三",
      "summary":"本周完成电源联调，进度 62%","progress":62,
      "tasks":[
        {"id":"RT1","wbsId":"We5f","wbsCode":"1.2.3","taskName":"电源模块联调","status":"进行中","progress":40,
         "plannedForWeek":true,"actualDone":false,"remark":""},
        {"id":"RT2","wbsId":"We6g","wbsCode":"1.2.4","taskName":"结构件装配","status":"完成","progress":100,
         "plannedForWeek":true,"actualDone":true,"remark":"提前完成"}
      ],
      "risks":[
        {"id":"RR1","level":"high","content":"EMC 测试设备未到位","ownerOpenId":"ou_lisi","ownerName":"李四","dueDate":"2026-03-25"}
      ],
      "nextPlan":"下周进入集成测试","status":"草稿"
    },
    "suggestedTasks":[
      {"wbsId":"We7h","wbsCode":"1.3.1","taskName":"软件联调","status":"进行中","progress":30}
    ]
  },
  "message": "ok"
}
```

> `exists:false` 时 `draft:null`，`suggestedTasks` 仍返回（前端展示空表单并带出建议任务）。`suggestedTasks` = 本周未入周报的 WBS 叶子任务。

### 10.3 `POST /api/reports` ♻️ 保存草稿（新建）

**请求**
```json
{
  "projectId":"P1a2b","week":"2026-W11","summary":"本周完成电源联调，进度 62%","progress":62,
  "tasks":[ {"wbsId":"We5f","plannedForWeek":true,"actualDone":false,"remark":""} ],
  "risks":[ {"level":"high","content":"EMC 测试设备未到位","ownerOpenId":"ou_lisi","dueDate":"2026-03-25"} ],
  "nextPlan":"下周进入集成测试"
}
```

**成功 201** — `data.report` 为 §10.2 `draft` 形态（`status:"草稿"`）。

**错误**
| HTTP | code | 场景 | data |
|---|---|---|---|
| 400 | `E_VALIDATION` | 缺 `summary`/`progress` 或风险行缺字段 | `{fields:[…]}` |
| 409 | `E_REPORT_DUPLICATE` | 该周已有周报 | `{existingId:"RP01", week:"2026-W11"}` |
| 403 | `E_FORBIDDEN` | 非项目成员 | 见 §0.7 |

### 10.4 `PUT /api/reports/:id` ♻️ 保存草稿（更新）

**请求** — 同 §10.3。**成功 200** 返回更新后草稿。**错误**：`E_VALIDATION`、`E_REPORT_DUPLICATE`、`E_FORBIDDEN`，外加：

| HTTP | code | 场景 |
|---|---|---|
| 400 | `E_REPORT_SUBMITTED` | 已提交不可改（须重开流程） |

### 10.5 `POST /api/reports/:id/submit` 🆕 提交（四段校验 + 快照冻结）

**请求** `{ "confirm": true }`

**成功 200**
```json
{
  "code": 0,
  "data": {
    "report": {
      "id":"RP01","status":"已提交","submittedAt":"2026-03-15T17:00:00+08:00",
      "progress":62,"snapshot":"<冻结的本周进度 JSON>","snapshotVersion":1
    },
    "taskProgressAfter": [ {"wbsId":"We5f","progress_before":35,"progress_after":40} ]
  },
  "message": "ok"
}
```

**错误**
```jsonc
// HTTP 400 —— 风险行缺 owner/due（data.rows 带行号定位）
{
  "code":"E_REPORT_RISK_INCOMPLETE",
  "data":{ "rows":[ { "rowIndex":0, "missing":["ownerOpenId","dueDate"] } ] },
  "message":"风险项第 1 行缺少责任人或截止日"
}
```
| HTTP | code | 场景 | data |
|---|---|---|---|
| 400 | `E_REPORT_RISK_INCOMPLETE` | 风险行缺 owner/due | `{rows:[{rowIndex,missing:[…]}]}` |
| 400 | `E_REPORT_TASK_INCOMPLETE` | 计划任务未填 actualDone | `{rows:[{wbsId,taskName}]}` |
| 400 | `E_VALIDATION` | summary/progress 非法 | `{fields:[…]}` |
| 409 | `E_REPORT_DUPLICATE` | 该周已提交 | `{existingId:"RP01"}` |
| 403 | `E_FORBIDDEN` | 非作者 | 见 §0.7 |

---

## 11. 评审与审批（P0-09）

> **统一 Review 引擎**：`mode ∈ {serial, parallel_veto, single}`。现有 `/api/projects/:id/{submit,approval,approve,reject}` 作为本引擎的**兼容别名**（§11.6–§11.9），契约不破。

### 11.1 `GET /api/reviews` 🆕 评审列表 / 我的待审

**请求** `GET /api/reviews?projectId=P1a2b&status=审批中&mine=true&reviewType=ccb&page=1&pageSize=20`

| 参数 | 必填 | 说明 |
|---|---|---|
| `projectId` | 否 | 按项目过滤 |
| `status` | 否 | `审批中`/`已通过`/`已驳回`/`已撤回` |
| `mine` | 否 | `true` = 仅返回当前用户待审步骤 |
| `reviewType` | 否 | 多值逗号分隔 |

**成功 200**
```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "id":"RVa1","projectId":"P1a2b","projectCode":"P-0012",
        "title":"CR-003 里程碑延后变更","refType":"change","refId":"CR-003",
        "reviewType":"ccb","mode":"serial",
        "status":"审批中","currentStep":1,"totalSteps":4,
        "initiatorOpenId":"ou_zhangsan","initiatorName":"张三",
        "createdAt":"2026-03-16T09:12:00+08:00","waitingDays":2,
        "myStepRole": "tl"
      }
    ],
    "total": 1, "page": 1, "pageSize": 20
  },
  "message": "ok"
}
```

### 11.2 `POST /api/reviews` 🆕 发起评审（formal/technical/code/ccb）

**请求**
```json
{
  "projectId":"P1a2b","refType":"stage","refId":"STc3","reviewType":"formal",
  "title":"设计评审","mode":"parallel_veto",
  "reviewers":[ {"role":"tl"}, {"role":"qa"}, {"role":"po"} ],
  "dueDate":"2026-03-25"
}
```

**成功 201**
```jsonc
{
  "code": 0,
  "data": {
    "review": {
      "id":"RVa1","status":"审批中","mode":"parallel_veto",
      "steps":[
        {"seq":1,"role":"tl","status":"待审批","approverOpenId":null,"approverName":null},
        {"seq":2,"role":"qa","status":"待审批","approverOpenId":null,"approverName":null},
        {"seq":3,"role":"po","status":"待审批","approverOpenId":null,"approverName":null}
      ],
      "currentRole":"tl","pendingRoles":["tl","qa","po"]
    }
  },
  "message": "ok"
}
```

**错误**
| HTTP | code | 场景 | data |
|---|---|---|---|
| 400 | `E_VALIDATION` | 缺 `refType`/`refId`/`reviewType`/`title` | `{fields:[…]}` |
| 400 | `E_REVIEW_REF_NOT_FOUND` | `refType+refId` 不存在 | `{refType:"stage",refId:"STx9"}` |
| 403 | `E_FORBIDDEN` | 无 `review:start` | 见 §0.7 |

### 11.3 `GET /api/reviews/:id` 🆕 评审详情（步骤 + 留痕）

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "review": {
      "id":"RVa1","projectId":"P1a2b","projectCode":"P-0012","title":"设计评审",
      "refType":"stage","refId":"STc3","reviewType":"formal","mode":"parallel_veto",
      "status":"已通过","initiatorName":"张三","createdAt":"2026-03-16T09:12:00+08:00",
      "closedAt":"2026-03-19T09:30:00+08:00"
    },
    "steps":[
      {"seq":1,"role":"tl","status":"已通过","approverOpenId":"ou_lisi","approverName":"李四",
       "action":"approve","comment":"方案可行","decidedAt":"2026-03-18T10:00:00+08:00","evidenceUrl":null,"isProxy":false},
      {"seq":2,"role":"qa","status":"已通过","approverOpenId":"ou_wangwu","approverName":"王五",
       "action":"approve","comment":"测试覆盖达标","decidedAt":"2026-03-18T14:00:00+08:00","evidenceUrl":null,"isProxy":false},
      {"seq":3,"role":"po","status":"已通过","approverOpenId":"ou_zhaoliu","approverName":"赵六",
       "action":"approve","comment":"认可需求范围","decidedAt":"2026-03-19T09:00:00+08:00","evidenceUrl":null,"isProxy":false}
    ],
    "myStep": { "seq":1, "role":"tl", "canDecide": true }
  },
  "message": "ok"
}
```

> `myStep` 仅当当前用户轮到且评审进行中时返回；否则为 `null`。`isProxy=true` 表示客户代表代录（见 §11.4）。

### 11.4 `POST /api/reviews/:id/decide` 🆕 通过/否决（含客户代表代录）

**请求**（常规）
```json
{ "action":"approve", "comment":"方案可行", "role":"tl" }
```
**请求**（客户代表代录 —— 用 `role` 显式指定身份 + 必须附证据）
```json
{ "action":"approve", "role":"customer_rep", "comment":"客户已线下签字", "evidenceUrl":"https://cdn.astrbytes.com/sign/CR-003.pdf" }
```

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "review": { "id":"RVa1","status":"已通过","mode":"parallel_veto","currentRole":null,"pendingRoles":[] },
    "step": { "seq":1,"role":"tl","status":"已通过","approverName":"李四","action":"approve" },
    "refEffect": { "refType":"stage","refId":"STc3","status":"进行中" }
  },
  "message": "ok"
}
```

**否决（veto）的引擎行为**
- `parallel_veto`：任一 `rejected` → review `已驳回`，`refEffect` 把被评审实体**回退到修改态**。
- `serial`：当前步骤 `reject` → review `已驳回`，后续步骤终止。
- `single`：唯一角色 `reject` → `已驳回`。

**错误**
```jsonc
// HTTP 403 —— 当前用户不是该步骤角色
{ "code":"E_NOT_APPROVER",
  "data":{ "stepRole":"tl","yourProjectRoles":["qa"],"reviewMode":"parallel_veto" },
  "message":"您不是当前审批步骤的角色（tl）" }

// HTTP 400 —— 客户代表代录必须传 evidenceUrl
{ "code":"E_PROXY_EVIDENCE_REQUIRED",
  "data":{ "role":"customer_rep" },
  "message":"客户代表代录必须附线下签字证据" }
```
| HTTP | code | 场景 |
|---|---|---|
| 403 | `E_NOT_APPROVER` | 非当前步骤角色/admin |
| 400 | `E_PROXY_EVIDENCE_REQUIRED` | `customer_rep` 代录缺证据 |
| 400 | `E_VALIDATION` | `veto` 未填 `comment` |
| 409 | `E_REVIEW_DECIDED` | 该步骤已决议 |
| 403 | `E_FORBIDDEN` | 无 `review:decide` 兜底 |

### 11.5 `POST /api/reviews/:id/withdraw` 🆕 撤回（发起人）

**请求** `{ "reason": "需求变更，评审作废" }`

**成功 200**
```json
{ "code": 0, "data": { "review": { "id":"RVa1", "status":"已撤回" }, "refEffect": { "refType":"stage","refId":"STc3","status":"未开始" } }, "message": "ok" }
```

**错误**
| HTTP | code | 场景 |
|---|---|---|
| 400 | `E_REVIEW_NOT_WITHDRAWABLE` | 已出结论不可撤回（`{status:"已通过"}`） |
| 403 | `E_FORBIDDEN` | 非发起人/admin |

### 11.6 `POST /api/projects/:id/submit` ♻️ 兼容别名（立项审批拉起）

> 旧前端发起立项评审。等价于「`transition:submit` + 以 `refType=project` 创建 review」。

**请求** `{ "reviewType":"project", "title":"P-0012 立项审批" }`

**成功 201**
```json
{ "code": 0, "data": { "review": { "id":"RVp1", "status":"审批中" }, "project": { "id":"P1a2b", "status":"审批中" } }, "message": "ok" }
```

### 11.7 `GET /api/projects/:id/approval` ♻️ 兼容别名（审批状态）

**成功 200**
```json
{ "code": 0, "data": { "status":"审批中", "reviewId":"RVp1", "currentStep":1, "steps": [ /* 同 §11.3 steps */ ] }, "message": "ok" }
```

### 11.8 `POST /api/projects/:id/approve` ♻️ 兼容别名（审批通过）

**请求** `{ "comment": "同意" }` → 代理到当前步骤 `decide:approve`。

**成功 200**
```json
{ "code": 0, "data": { "review": { "id":"RVp1", "status":"已通过" }, "project": { "id":"P1a2b", "status":"已批准" } }, "message": "ok" }
```
> `project.status` 随评审结果在 `已批准` / `审批中` / `已驳回` 间变化。

### 11.9 `POST /api/projects/:id/reject` ♻️ 兼容别名（审批驳回）

**请求** `{ "comment": "预算超标" }` → 代理到当前步骤 `decide:reject`。

**成功 200**
```json
{ "code": 0, "data": { "review": { "id":"RVp1", "status":"已驳回" }, "project": { "id":"P1a2b", "status":"已驳回" } }, "message": "ok" }
```

> §11.6–§11.9 的错误码复用：`E_NOT_APPROVER`、`E_PROXY_EVIDENCE_REQUIRED`、`E_REVIEW_DECIDED`、`E_VALIDATION`、`E_FORBIDDEN`。**新代码应直接调 §11.2–§11.4 引擎接口**，这些兼容别名 T33 后下线。

---

## 12. 变更控制（P0-14）

> 新建即**自动路由**：`changeType ∈ {milestone_date, requirement_baseline}` 或 `effortDays ≥ 3` → CCB（`pm→tl→po→customer_rep`）；否则 `pm_only`。批准后由 `onReviewClosed` 自动应用（里程碑日期写入 `planned_date`，记录 `last_change_id`）。

### 12.1 `GET /api/changes` 🆕 变更清单

**请求** `GET /api/changes?projectId=P1a2b&status=审批中&changeType=milestone_date&page=1&pageSize=20`

**成功 200**
```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "id":"CR-003","projectId":"P1a2b","projectCode":"P-0012","title":"里程碑 M3 延后变更",
        "changeType":"milestone_date","route":"ccb","status":"审批中",
        "creatorOpenId":"ou_zhangsan","creatorName":"张三",
        "createdAt":"2026-03-16T09:20:00+08:00","reviewId":"RVa1",
        "appliedAt":null,"effortDays":10
      }
    ],
    "total": 3, "page": 1, "pageSize": 20
  },
  "message": "ok"
}
```

### 12.2 `POST /api/changes` 🆕 新建变更（自动路由）

> 兼容 §7.3 的 `E_MS_NEED_CHANGE` 预填草稿：前端直接把 `data.changeDraft` 原样 POST 过来即可。

**请求**
```json
{
  "projectId":"P1a2b","title":"里程碑 M3 延后变更","changeType":"milestone_date",
  "targetId":"M3","payload":{"from":"2026-03-20","to":"2026-03-30"},
  "reason":"客户场地未就绪","impactAnalysis":"影响集成测试排期","effortDays":10
}
```

**成功 201**
```jsonc
{
  "code": 0,
  "data": {
    "change": { "id":"CR-003", "status":"草稿", "route":"ccb", "reviewId":null },
    "routeResult": {
      "route":"ccb",
      "chain":["pm","tl","po","customer_rep"],
      "reasons":["里程碑日期变更强制走 CCB", "effortDays(10) ≥ 3"]
    }
  },
  "message": "ok"
}
```

**错误**
| HTTP | code | 场景 | data |
|---|---|---|---|
| 400 | `E_VALIDATION` | 缺 `projectId`/`title`/`changeType`/`targetId`/`payload` | `{fields:[…]}` |
| 400 | `E_CHANGE_ROUTE` | `other` 类且无 `effortDays`/影响分析，无法路由 | `{reason:"other 类变更需提供 effortDays 或影响分析以确定路由"}` |
| 400 | `E_CHANGE_TARGET_NOT_FOUND` | `targetId` 不存在 | `{targetId:"M3", changeType:"milestone_date"}` |
| 403 | `E_FORBIDDEN` | 无 `change:create` | 见 §0.7 |

### 12.3 `GET /api/changes/:id` 🆕 变更详情

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "change": {
      "id":"CR-003","projectId":"P1a2b","title":"里程碑 M3 延后变更",
      "changeType":"milestone_date","route":"ccb","status":"已实施",
      "creatorOpenId":"ou_zhangsan","creatorName":"张三",
      "targetId":"M3","payload":{ "from":"2026-03-20", "to":"2026-03-30" },
      "reason":"客户场地未就绪","impactAnalysis":"影响集成测试排期","effortDays":10,
      "reviewId":"RVa1","reviewStatus":"已通过","appliedAt":"2026-03-22T10:00:00+08:00"
    },
    "review": { "id":"RVa1","status":"已通过","steps": [ /* 同 §11.3 */ ] },
    "timeline": [
      { "at":"2026-03-16T09:20:00+08:00","action":"create","byName":"张三" },
      { "at":"2026-03-16T09:30:00+08:00","action":"submit","byName":"张三" },
      { "at":"2026-03-22T10:00:00+08:00","action":"applied","byName":"系统" }
    ]
  },
  "message": "ok"
}
```

### 12.4 `POST /api/changes/:id/submit` 🆕 提交审批（拉起 PM 或 CCB）

**请求** `{ "comment": "请审批" }`

**成功 200**
```jsonc
{
  "code": 0,
  "data": {
    "change": { "id":"CR-003", "status":"审批中", "reviewId":"RVa1" },
    "review": {
      "id":"RVa1","status":"审批中","mode":"serial","currentRole":"pm",
      "steps":[
        {"seq":1,"role":"pm","status":"待审批",…},
        {"seq":2,"role":"tl","status":"待审批",…},
        {"seq":3,"role":"po","status":"待审批",…},
        {"seq":4,"role":"customer_rep","status":"待审批",…}
      ]
    }
  },
  "message": "ok"
}
```

> 提交后回到 §11 评审引擎推进；CCB 全链通过后 `change.service.onReviewClosed` 自动写入里程碑 `planned_date` 并置 `status:"已实施"`。

**错误**
| HTTP | code | 场景 |
|---|---|---|
| 400 | `E_CHANGE_INVALID_STATE` | 非草稿不可提交（`{status:"审批中"}`） |
| 403 | `E_FORBIDDEN` | 非创建人/PM |

---

## 13. 审计（P0-15）

> DAL 层 `withAudit()` 装饰器自动落 before/after diff。全局日志仅 admin/pmo 可查。

### 13.1 `GET /api/audit?entityType=&entityId=` 🆕 实体变更历史时间线

**请求** `GET /api/audit?entityType=project&entityId=P1a2b&page=1&pageSize=20`

**成功 200**
```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "id":1,"entityType":"project","entityId":"P1a2b","action":"update",
        "actorOpenId":"ou_zhangsan","actorName":"张三",
        "summary":"修改 健康度: yellow → red","before":{ "health":"yellow" },"after":{ "health":"red" },
        "requestId":"req-abc-123","createdAt":"2026-03-16T15:41:00+08:00"
      }
    ],
    "total": 42, "page": 1, "pageSize": 20
  },
  "message": "ok"
}
```

### 13.2 `GET /api/audit/logs` 🆕 全局审计（分页/筛选）

**请求** `GET /api/audit/logs?actor=ou_zhangsan&action=update&entityType=project&from=2026-03-01&to=2026-03-31&page=1&pageSize=50`

**成功 200** — 同 §13.1 的 `items` 形态（含 `total/page/pageSize`），仅范围扩大为全实体。

**错误**
| HTTP | code | 场景 |
|---|---|---|
| 403 | `E_FORBIDDEN` | 非 admin/pmo（全局日志） |

---

## 14. 错误码总表（code → HTTP → data 关键字段）

> 联调（T33）按此表逐码核对。所有错误响应形态均为 `{code, data, message}`（见 §0.5）。

| 错误码 | HTTP | 触发场景 | `data` 关键字段 |
|---|---|---|---|
| `E_VALIDATION` | 400 | 参数/业务校验失败 | `fields:[{field,message}]` |
| `E_UNAUTHORIZED` | 401 | 未登录/过期 | `null` |
| `E_FEISHU_AUTH` | 401 | 飞书换 token 失败 | `{feishuCode, feishuMsg}` |
| `E_USER_DISABLED` | 403 | 用户已停用 | `{openId}` |
| `E_FORBIDDEN` | 403 | 无操作权限（见 §0.7） | `{required, yourGlobalRole, yourProjectRoles}` |
| `E_PROJECT_ARCHIVED` | 403 | 项目已结项/终止（见 §0.6） | `{projectId, projectStatus, closedAt}` |
| `E_GATE_NOT_PASSED` | 403 | 质量门未过（见 §5.2） | `{stageId, gateId, blockers[]}` |
| `E_GATE_DECIDED` | 409 | 门已决议不可改 | `{gateStatus, decidedAt?}` |
| `E_GATE_ITEM_INCOMPLETE` | 400 | 门结论前检查项未勾完 | `{unchecked:[{itemId,content,ownerRole}]}` |
| `E_NOT_APPROVER` | 403 | 非当前审批步骤角色 | `{stepRole, yourProjectRoles, reviewMode}` |
| `E_PROXY_EVIDENCE_REQUIRED` | 400 | 客户代表代录缺证据 | `{role:"customer_rep"}` |
| `E_STAGE_SEQUENCE` | 400 | 已是最后阶段 | `{seq, total}` |
| `E_INVALID_TRANSITION` | 400 | 状态机不允许 | `{from, action, allowedActions[]}` |
| `E_CLASSIFY_REASON_REQUIRED` | 400 | 改分类未填理由 | `{type, suggested, reasons[]}` |
| `E_PROJECT_PO_REQUIRED` | 400 | B 类缺 PO | `{type, requiredRoles, missing[]}` |
| `E_ROLE_CARDINALITY` | 400 | pm/tl 不是恰好 1 人 | `{role, count, expected}` |
| `E_PROJECT_NOT_DRAFT` | 409 | 仅草稿可删 | `{status, suggestion:"transition"}` |
| `E_SELF_ROLE` | 403 | 改自己角色 | `{userId}` |
| `E_LAST_ADMIN` | 403 | 降级最后一名管理员 | `{adminCount}` |
| `E_MS_NEED_CHANGE` | 409 | 里程碑延后须走变更（见 §7.3）；**提前不再有拦截码** | `{milestoneId, diffDays, changeDraft{…}}` |
| `E_MS_DUP_CODE` | 409 | 里程碑编号重复 | `{code}` |
| `E_MS_DELETE_REQUIRED` | 400 | 删模板必需里程碑 | `{category, name}` |
| `E_MS_LINKED_WBS` | 409 | 里程碑被 WBS 关联 | `{refNodes[]}` |
| `E_WBS_LEAF_INCOMPLETE` | 400 | 叶子任务缺 owner/estimateDays（R-5） | `{missing[]}` |
| `E_WBS_GRANULARITY` | 400 | 叶子粒度超限 | `{estimateDays, maxLeafDays}` |
| `E_WBS_PARENT_TYPE` | 400 | 子类型不在父节点白名单（R-2） | `{parentNodeType, childNodeType, allowed[]}` |
| `E_WBS_DEPTH` | 400 | 超过层级上限（R-1，含 move 子树整体判定） | `{depth, maxDepth}` |
| `E_WBS_STAGE_UNBOUND` | 400 | stage 未绑生命周期阶段（R-6） | `{nodeType:"stage"}` |
| `E_WBS_TYPE_LOCKED` | 400 | 有子节点改 nodeType（R-4） | `{nodeId, childCount}` |
| `E_WBS_CODE_FROZEN` | 400 | 试图改系统字段 wbsCode 等 | `{field}` |
| `E_WBS_HAS_CHILDREN` | 409 | 删有子节点未级联 | `{childCount}` |
| `E_WBS_MOVE_CYCLE` | 400 | 移动到自身子孙 | `{targetParentId}` |
| `E_WIP_EXCEEDED` | 409 | 看板 WIP 超限（见 §9.2） | `{status, limit, current, wouldBe}` |
| `E_REPORT_RISK_INCOMPLETE` | 400 | 风险行缺 owner/due | `{rows:[{rowIndex, missing[]}]}` |
| `E_REPORT_TASK_INCOMPLETE` | 400 | 计划任务未填 actualDone | `{rows:[{wbsId, taskName}]}` |
| `E_REPORT_DUPLICATE` | 409 | 同周周报已存在 | `{existingId, week}` |
| `E_REPORT_SUBMITTED` | 400 | 已提交不可改 | `{status}` |
| `E_REVIEW_REF_NOT_FOUND` | 400 | 评审引用实体不存在 | `{refType, refId}` |
| `E_REVIEW_DECIDED` | 409 | 该步骤已决议 | `{stepSeq, action}` |
| `E_REVIEW_NOT_WITHDRAWABLE` | 400 | 已出结论不可撤回 | `{status}` |
| `E_CHANGE_ROUTE` | 400 | 无法确定审批路由 | `{reason}` |
| `E_CHANGE_TARGET_NOT_FOUND` | 400 | 变更目标不存在 | `{targetId, changeType}` |
| `E_CHANGE_INVALID_STATE` | 400 | 非草稿不可提交 | `{status}` |
| `E_NOT_FOUND` | 404 | 资源不存在 | `null` |
| `E_INTERNAL` | 500 | 服务端异常 | `null` |

---

## 15. Mock ↔ 真实一致性 Diff 检查清单（T33 联调基准）

> 工程师在 T33 逐项核对，差异清零即视为通过。前端 Mock（T02/T19）与后端（T21~T32）**必须**同时满足：

- [ ] **包络一致**：所有响应为 `{code,data,message}`；成功 `code===0`（数字），失败为字符串错误码；无裸数组/裸对象。
- [ ] **字段命名**：API 层全 camelCase，前端与 Mock 均**不出现下划线**（DB snake_case 已在 `dal/base.repo.js` 转换）。
- [ ] **派生字段**：`ownerName`/`authorName`/`createdByName`/`decidedByName`/`assigneeName` 存在且只读；对象型 `currentStage` 带 `{id,code,name,seq}`；人缺失返回 `"(已移除)"` 非 `null`。
- [ ] **类型真实**：布尔为 `true/false`（非 0/1）；JSON 字段为对象/数组（非字符串）；空值为 `null`（非 `""`/`0`）。
- [ ] **列表包络**：扁平列表接口（里程碑/周报/评审/变更/审计/用户/项目/门）均返回 `{items,total,page,pageSize}`；**WBS 树（§8.1）为 `tree` 特例**。
- [ ] **分页参数**：`page` 从 1；`pageSize` 上限 100;数组参数逗号分隔（`?status=进行中,阻塞`）。
- [ ] **日期格式**：纯日期 `"2026-03-20"`；时间戳 `"2026-03-20T14:32:10+08:00"`（带 `+08:00`）。
- [ ] **保留字**：里程碑日期字段一律 `plannedDate`（DB `planned_date`），**禁止**写成 `currentDate`/`current_date`（D-3）。
- [ ] **硬拦截形态**：
  - [ ] `E_GATE_NOT_PASSED`（§5.2）→ `data.blockers[]` 结构化 `{type,itemId?,text,ownerRole?}`。
  - [ ] `E_MS_NEED_CHANGE`（§7.3）→ `data.changeDraft{changeType,targetId,payload{from,to},…}`。
  - [ ] `E_WIP_EXCEEDED`（§9.2）→ `data.{status,limit,current,wouldBe}`。
  - [ ] `E_REPORT_RISK_INCOMPLETE`（§10.5）→ `data.rows[{rowIndex,missing[]}]`。
  - [ ] `E_CLOSE_BLOCKED`（§5.4）→ `data.blockers[]`（与 §5.3 `close-check` 同构）。
- [ ] **权限/归档形态**：`E_FORBIDDEN` 带 `{required, yourGlobalRole, yourProjectRoles}`；`E_PROJECT_ARCHIVED` 带 `{projectId, projectStatus, closedAt}`。
- [ ] **幂等**：所有写请求 Mock 与后端均消费 `X-Request-Id`，重复提交返回首次结果（Mock 也需模拟）。
- [ ] **枚举一致性**：状态/角色/类型枚举值与 `/api/meta` 完全一致，前端无硬编码。

---

## 16. 版本与变更记录

| 版本 | 日期 | 作者 | 说明 |
|---|---|---|---|
| v1.0 | 2026-03 | 高见远（架构师） | 初版。覆盖 13 域 / 62 个具体操作，含成功/错误码/data 形态与列表分页形态。与 `架构设计-重构v1.md` §3.3/§3.4/§7 对齐，作为 S3 联调 diff 基准与 Mock↔真实一致性唯一保险 |

> **配套文件**：`docs/schema.sql`（DDL，实测 10/10）、`docs/permissions-matrix.md`（RBAC 37 点）、`docs/lifecycle/*.json`（A/B/C 三套生命周期模板）、`docs/架构设计-附录A-落地物料.md`（字段字典 + 实例化算法 + delta 说明）。本契约的字段名/类型如有调整，需同步更新 `schema.sql` 与 `lifecycle` 模板，并在本章追加变更记录。

