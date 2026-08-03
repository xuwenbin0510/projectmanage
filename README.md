# 太空字节项目管理工作台 · 全栈版

一个**完整的项目管理应用**：飞书免登身份 + 真实数据库（SQLite）+ 后端业务处理 + **服务端权限认证（RBAC）**。
前端单页（深空暗色主题）通过 API 与后端交互，飞书只作为身份入口和门面。

> 飞书自建应用（网页型）的本质 = 飞书工作台里一个指向你服务器的链接。飞书负责"入口"和"告诉后端是谁在登录"，
> 真正的数据库、业务逻辑、权限判断全部跑在你的服务器上。这就是一个标准全栈应用。

---

## 一、目录结构

```
pm-app/
├── server.js          # 后端主程序：Express + 飞书登录 + 鉴权中间件 + 业务API + RBAC + 静态托管
├── db.js              # 数据库层：better-sqlite3 建表（users/projects/milestones/tasks/reports/report_tasks）
├── config.js          # 读取 .env 配置
├── package.json
├── .env.example       # 配置模板（复制为 .env 后填真实值）
└── public/
    └── index.html     # 前端单页（API 驱动，含登录、权限显隐、任务↔周报双向关联）
```

## 二、本地运行 / 自测

```bash
cd pm-app
npm install
cp .env.example .env        # 开发阶段可留空 FEISHU_APP_ID，启用"开发登录"
node server.js              # 默认监听 http://localhost:3000
```

浏览器打开 http://localhost:3000 ：
- 若 `.env` 未配置 `FEISHU_APP_ID`，登录页会出现「开发登录」入口，输入姓名即可登录（首名用户自动为管理员）。
- 此模式用于本地联调，**不要用于生产**。

## 三、数据库

- 使用 SQLite，文件 `pm.db` 首次启动自动创建并建表（WAL 模式）。
- 真实 SQL 表：`users`、`projects`、`milestones`、`tasks`、`reports`、`report_tasks`、`approvals`（审批留痕）。
- 数据全公司共享，存于服务器，不依赖任何浏览器本地存储。
- 如需换成 Postgres/MySQL，只需替换 `db.js` 的驱动与建表语句，其余逻辑不变。

## 四、飞书接入（生产必做）

### 1. 开放平台创建自建应用
飞书开放平台 → 创建企业自建应用 → 记录 **App ID** 与 **App Secret**（凭证与基础信息页）。

### 2. 开通"网页应用"
应用功能 → 网页应用 → 开启，填写**主页**为你的公网 HTTPS 地址（见第五节部署后拿到的域名）。

### 3. 配置权限
权限管理 → 申请以下权限（至少）：
- `contact:user.base:readonly`（读取登录用户姓名，用于显示）
- 应用可用性：设置为"全员可用"或指定部门/人员。

### 4. 安全设置
安全设置 → 重定向 URL / 可信域名：把你的公网域名加入可信域名（H5 免登要求）。

### 5. 填写服务端配置
编辑 `.env`：
```
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxx
SESSION_SECRET=<用 openssl rand -hex 32 生成>
ADMIN_OPEN_IDS=                  # 可选：填写管理员飞书 open_id，逗号分隔；留空则首名登录者自动为管理员
```

> 登录流程：前端在飞书内调用 `tt.requestAuthCode` 获取 code → 后端用 code 换用户身份 → 签发会话令牌 →
> 之后每个 API 请求带 `Authorization: Bearer <token>`，后端校验身份并做权限判断。

## 五、部署到服务器（公网 HTTPS）

后端是一个标准 Node 服务，部署到你自己的云服务器 / 容器即可：

```bash
# 生产环境
npm install --production
node server.js        # 或 pm2/nodemon 守护
```

前面用 Nginx / Caddy 反代出 HTTPS（飞书网页应用要求 HTTPS）：

```nginx
server {
  listen 443 ssl;
  server_name pm.your-company.com;
  ssl_certificate     /path/fullchain.pem;
  ssl_certificate_key /path/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

部署完成后，把 `https://pm.your-company.com` 填回飞书网页应用的主页与可信域名，发布到工作台即可全员使用。

### 方式二：Render 一键部署（连 GitHub 仓库）

适合不想自己管服务器的情况。仓库根目录已提供 `render.yaml`（Render Blueprint）：

1. 注册 [Render](https://render.com) → **New** → **Blueprint** → 授权连接你的 GitHub 仓库 `xuwenbin0510/projectmanage`。
2. Render 自动按 `render.yaml` 建好 Web 服务：`npm install` 构建、`node server.js` 启动、监听 `0.0.0.0:$PORT`、健康检查 `/`。
3. `SESSION_SECRET` 由 Render 自动生成并保密；`FEISHU_APP_ID/SECRET` 默认留空 = **开发登录模式**（首个登录用户自动为管理员），够演示用。
4. 部署完成后得到 `https://astrbytes-pm.onrender.com` 这样的公网地址，直接浏览器打开即可用。

> 注意：Render 免费计划的磁盘是**临时的**，重启/重新部署会清空 SQLite 数据（演示无妨）。
> 需要持久化：升级付费计划 → 在 `render.yaml` 取消 `disk` 注释 → 把 `DB_PATH` 改为 `/data/pm.db`。
> 接飞书：在飞书开放平台拿到 App ID/Secret 填进 Render 的环境变量，并把重定向/可信域名设为上面的公网地址。

## 六、权限模型（RBAC，服务端强制）

| 操作 | 允许角色 |
|---|---|
| 查看所有项目/任务/周报 | 任意已登录用户（公司透明） |
| 创建项目 | 任意已登录用户 |
| 编辑项目 | **项目负责人** 或 **管理员** |
| 删除项目 | **仅管理员**（按你的制度：项目创建后不可随意删除） |
| 创建任务 | 任意已登录用户（默认成为任务负责人） |
| 编辑/删除任务 | **任务负责人**、**项目负责人** 或 **管理员** |
| 创建/编辑/删除周报 | **报告人** 或 **管理员** |

所有判断在 `server.js` 的 `canEditProject / canEditTask / canEditReport / canDeleteProject` 中执行，
前端仅做按钮显隐，服务端才是最终裁决，**绕不过去**。

## 五·附、用户管理页（角色绑定飞书用户）

应用内已内置「用户管理」Tab（**仅管理员可见**），用于把审批角色分配给飞书用户：

- 同事首次通过飞书登录即自动进入用户列表（其 `open_id` 即飞书身份，天然绑定）。
- 管理员在列表中为每个用户选择角色（项目经理 / 技术负责人 / 质量负责人 / PMO / 管理层 / 管理员 / 普通成员），点「保存」即生效。
- 审批流按角色解析审批人，因此在此处把某人设为「技术负责人」，他就能审批需要 TL 的那一步。
- 守卫：管理员不能修改自己的角色（防误锁）、不能把最后一名管理员降级（保证系统始终有管理员）。

> 角色定义与审批链模板都在后端 `config.js` 的 `ROLES` 与 `APPROVAL_TEMPLATES` 中，前后端共用同一份。

## 六·附、审批流（可配置、串行逐级）

项目审批不是简单改个状态，而是一条**按项目类别配置的串行审批链**，每一步绑定系统角色，由该角色的成员实际审批，并留痕。

### 1. 配置方式（改一处即可）
审批模板写在 `config.js` 的 `APPROVAL_TEMPLATES`，key 与前端项目类型完全一致：

```js
APPROVAL_TEMPLATES: {
  'A类（战略产品）': ['pmo', 'tl', 'management'],   // 3 级：PMO → 技术负责人 → 管理层
  'C类（基建/平台）': ['pmo', 'tl', 'management'],   // 同上（关键节点严）
  'B类（产品迭代）': ['pm', 'tl'],                    // 2 级：项目经理 → 技术负责人
  '_default':        ['pm', 'tl']
}
```

- 想加一级 / 换角色 / 调顺序，只改这个对象，**无需动其他代码**。
- 角色来自 `config.js` 的 `ROLES`（pm / tl / qa / pmo / management / admin / member）。

### 2. 审批状态机
`草稿 → 提交审批 → 审批中（逐级：PMO ✓ → TL ● → 管理层 ○）→ 已批准 → 已启动 → 已结项`
- 每一步**只有当前步骤对应角色的成员能批**（管理员可兜底，防死锁）。
- 任一环节**驳回** → 回到`已驳回`，可修改后重新提交。
- 全程在 `approvals` 表留痕：谁、什么时间、批/驳、写了什么意见。

### 3. 角色怎么来（生产）
- 开发模式：开发登录时自选角色。
- 生产：管理员在应用内「用户管理」页（仅管理员可见）直接为每个用户分配角色；也可用 `PUT /api/users/:id/role` 调接口。
- 前端项目卡实时显示审批链进度与「当前待谁审批（具体人名）」。

> 这套直接对齐你《制度 V1.0》的评审分级（正式评审=管理层+PMO+TL、一票否决；技术评审=TL 决议）与 A/C 类严、B 类中的差异。
> 制度第 8 章"审批"目前角色名是空的，模板已按评审分级默认填好，后续可在 `config.js` 微调。

## 七、API 一览

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | `/api/login` | 飞书 code 换会话 | 公开 |
| POST | `/api/devlogin` | 开发登录（无飞书凭证时） | 公开 |
| GET | `/api/me` | 当前用户 | 登录 |
| GET | `/api/appid` | 飞书 App ID | 公开 |
| GET/POST | `/api/projects` | 项目列表 / 新建（默认状态 `草稿`） | 登录 |
| GET/PUT/DELETE | `/api/projects/:id` | 项目详情 / 编辑 / 删除 | 按 RBAC |
| GET | `/api/projects/:id/approval` | 审批链视图（步骤/当前角色/审批人/留痕） | 登录 |
| POST | `/api/projects/:id/submit` | 提交审批（项目负责人或管理员） | 编辑权限 |
| POST | `/api/projects/:id/approve` | 通过当前审批步骤（当前步骤角色或管理员） | 审批权限 |
| POST | `/api/projects/:id/reject` | 驳回（当前步骤角色或管理员） | 审批权限 |
| GET/POST | `/api/milestones` | 里程碑列表 / 新建 | 按 RBAC（建/改/删需项目负责人或管理员） |
| GET/PUT/DELETE | `/api/milestones/:id` | 里程碑编辑 / 删除 | 按 RBAC |
| GET/POST | `/api/tasks` | 任务列表 / 新建 | 登录 |
| GET/PUT/DELETE | `/api/tasks/:id` | 任务编辑 / 删除 | 按 RBAC |
| GET | `/api/tasks/:id/reports` | 某任务关联周报 | 登录 |
| GET/POST | `/api/reports` | 周报列表 / 新建（含关联任务与进度快照） | 登录 |
| GET/PUT/DELETE | `/api/reports/:id` | 周报编辑 / 删除 | 按 RBAC |
| GET | `/api/dashboard` | 看板聚合数据 | 登录 |
| GET | `/api/users` | 用户姓名映射 | 登录 |
| GET | `/api/approval-config` | 审批模板 + 角色名（前端渲染审批链用） | 登录 |
| PUT | `/api/users/:id/role` | 管理员分配用户角色 | 仅管理员 |

## 八、常见问题

- **登录报错"服务端未配置飞书凭证"**：`.env` 里 `FEISHU_APP_ID` 为空时只能用开发登录；生产请填真实值。
- **飞书内打开提示重定向/域名不信任**：把公网域名加到应用"安全设置 → 可信域名"。
- **想换数据库**：改 `db.js` 一处即可，业务代码与前端无需改动。
- **数据备份**：直接备份 `pm.db` 文件（或定期导出）。
