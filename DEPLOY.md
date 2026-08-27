# pm-app 生产部署文档（阿里云 ECS · Docker · Nginx）

> 适用环境：**阿里云 ECS** + 已安装 **Docker / docker compose** + 已安装 **Nginx**（HTTPS 终止与反向代理）。  
> 本方案沿用你既往的 Docker 工作流，取代此前「tar 包 + npm + pm2」的旧方案。  
> 代码已推到 GitHub `main`（当前 HEAD `90541d90`，含 D 类模板 / WBS 文档关联 / 质量门编码自动生成 / 飞书标题修复等全部本轮修复）。

---

## 0. 部署架构

```
浏览器 ──HTTPS(:443)──▶ 阿里云ECS
                          ├─ Nginx (反向代理 + SSL 终止)
                          │      proxy_pass → 127.0.0.1:3000
                          └─ Docker 容器 pm-app (node server.js)
                                  ├─ 前端 web/dist（镜像内构建）
                                  ├─ API  /api
                                  └─ SQLite  /app/data/pm.db  ──▶ 卷 pm-data（持久化）
                                              /app/data/attachments（上传附件，同卷）
```

- 容器只把 `3000` 暴露给**宿主机回环**；公网仅开放 `80/443`，由 Nginx 反代。
- 数据库文件与上传附件都落在 `/app/data` 卷，**重建镜像不丢数据**。

---

## 1. 阿里云安全组（控制台）

入方向放行：

| 端口   | 协议  | 来源          | 说明                |
| ---- | --- | ----------- | ----------------- |
| 22   | TCP | 你的 IP（建议限定） | SSH               |
| 80   | TCP | 0.0.0.0/0   | HTTP→HTTPS 重定向    |
| 443  | TCP | 0.0.0.0/0   | HTTPS 对外          |
| 3000 | —   | **不开放**     | 仅宿主机内部，Nginx 回环访问 |

---

## 2. 安装 Docker 与 Nginx（ECS 上，一次性）

**Alibaba Cloud Linux 3 / CentOS：**

```bash
sudo curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
sudo dnf -y install nginx && sudo systemctl enable --now nginx
```

**Ubuntu：**

```bash
sudo curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
sudo apt-get update && sudo apt-get install -y nginx
```

免 sudo 执行 docker（可选）：

```bash
sudo usermod -aG docker $USER   # 执行后重登生效
```

---

## 3. 取代码

```bash
git clone <你的仓库地址> pm-app
cd pm-app
# 若已 clone：git pull origin main
```

> ⚠ `web/dist` 在 `.gitignore`，不随仓库走。Docker 构建阶段会自动 `cd web && npm install && npm run build` 生成，**无需手动 build**。

---

## 4. 准备 `.env`（关键：SESSION_SECRET 必填）

```bash
cp .env.example .env
# 生成随机密钥并填入 .env 的 SESSION_SECRET：
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`.env` 关键变量（详见 `.env.example`）：

| 变量                                    | 必填 | 说明                                                                    |
| ------------------------------------- | -- | --------------------------------------------------------------------- |
| `SESSION_SECRET`                      | ✅  | 会话签名密钥。**缺失或仍是默认值，服务直接 `process.exit(1)` 拒绝启动**（`config.js` D-7 硬校验）。 |
| `ALLOW_DEV_LOGIN`                     | ✅  | 生产必须 `false`。未配飞书时该项**默认会开启**免登，必须显式关闭。                               |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | ❌  | 不配则走邮箱+密码登录。                                                          |
| `ADMIN_OPEN_IDS`                      | ❌  | 逗号分隔飞书 open_id，首次以此登录即获管理员。                                           |

`DB_PATH` / `ATTACHMENT_ROOT` 由 `docker-compose.yml` 固定为 `/app/data`，**无需在 `.env` 设置**。

---

## 5. 构建并启动容器

```bash
docker compose up -d --build
docker logs -f pm-app
```

启动日志应见：

```
[db] ready ... schema v22
[PM] 服务已启动: http://0.0.0.0:3000
[PM] 免密登录(ALLOW_DEV_LOGIN): false
```

卷 `pm-data` 自动创建，`pm.db` 与 `attachments` 落在其内。

---

## 6. Nginx 反向代理 + HTTPS

1. 将仓库内 `nginx/pm-app.conf` 内容写入 `/etc/nginx/conf.d/pm-app.conf`。
2. 改两处 `server_name pm.yourdomain.com` → 你的域名。
3. 准备证书（二选一）：
   - **阿里云免费 DV 证书**：控制台申请 → 下载 **Nginx 格式** → 上传到 `/etc/nginx/cert/pm-app.pem` 与 `pm-app.key`。
   - 或 **certbot**：`sudo certbot --nginx -d 你的域名`。
4. 校验并重载：
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

> 域名 DNS：在阿里云 DNS 把 `A 记录` 指向 ECS 公网 IP。

---

## 7. 验证上线

```bash
curl -I https://你的域名/                      # 200，返回 index.html
curl -I https://你的域名/api/dashboard/overview  # 401（鉴权生效，属正常）
```

浏览器打开 `https://你的域名` → 登录方式：

- **飞书免登**（已配飞书凭证时）；或
- **系统管理员邮箱/密码**：`admin@astrbyte.com` / `AstrBytes@2026`，**首次登录请改密**。

---

## 8. 日常发版（更新到最新 main）

```bash
cd pm-app
git pull origin main
docker compose up -d --build     # 重建镜像；卷内 pm.db 不动，迁移自动跑
```

> ⚠ 不要手动 `docker exec` 改库；数据库迁移由 `server.js` 启动时自动执行（含 risks 表等 v22 迁移）。  
> ⚠ 改了代码却不生效？确认走的是 `git pull` + `rebuild`，不要用旧 tar 包覆盖。

---

## 9. 备份与回滚

**备份数据库 + 附件（卷）：**

```bash
docker run --rm -v pm-app_pm-data:/data -v $PWD/backup:/backup \
  alpine tar czf /backup/pm-$(date +%F).tar.gz -C /data .
```

建议写入 cron，每日一次。

**回滚：**

- 保留旧镜像 tag，或 `git checkout <旧commit>` 后 `docker compose up -d --build` 重建。
- 数据卷 `pm-data` 独立于镜像，回滚不影响已有数据。

---

## 10. 排错速查

| 现象              | 原因                              | 处理                                                |
| --------------- | ------------------------------- | ------------------------------------------------- |
| 容器起不来 / 立刻退出    | `SESSION_SECRET` 缺失或仍是默认值       | `docker logs pm-app` 看 `[FATAL]`，补 `.env`         |
| 页面空白 / 报「前端未构建」 | `web/dist` 没生成                  | 确保走 `docker compose up -d --build`（构建阶段会自动 build） |
| 上传附件失败          | Nginx `client_max_body_size` 太小 | 配置已设 `20m`；如需更大改 `nginx/pm-app.conf`              |
| `SQLITE_BUSY`   | 多实例写同一库                         | 保持单容器单实例，勿多副本                                     |
| 改了代码不生效         | 用了旧包 / 没 rebuild                | 走 `git pull` + `rebuild`                          |
| 502 Bad Gateway | Nginx 反代但容器未起 / 端口错             | `docker ps` 确认 `pm-app` 在跑、`127.0.0.1:3000` 可达    |

---

## 11. 与旧方案的区别（说明）

| 项     | 旧方案（tar 包 + npm + pm2） | 本方案（Docker + Nginx）                            |
| ----- | ---------------------- | ---------------------------------------------- |
| 交付形态  | 自包含 tar.gz 上传解压        | 镜像构建，沿用你既有 Docker 工作流                          |
| 前端构建  | 服务器手动 `npm run build`  | 镜像构建阶段自动 build                                 |
| 进程守护  | pm2                    | Docker `restart: unless-stopped` + healthcheck |
| 数据持久化 | 服务器本地文件                | Docker 卷 `pm-data`（重建镜像不丢）                     |
| HTTPS | 视服务器配置                 | ECS 上 Nginx 统一终止 SSL                           |

---

### 附：文件清单（本仓库新增）

- `Dockerfile` — 多阶段构建（编译 better-sqlite3 + 构建前端）
- `docker-compose.yml` — 服务定义 + `pm-data` 卷 + 健康检查
- `.dockerignore` — 排除依赖/密钥/本地数据进镜像
- `.env.example` — 生产环境变量模板
- `nginx/pm-app.conf` — Nginx 反向代理 + HTTPS 示例
- `DEPLOY.md` — 本文档
