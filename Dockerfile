# ── 构建阶段：装依赖 + 构建前端 ──
FROM node:22-slim AS build
WORKDIR /app

# better-sqlite3 为原生模块，构建阶段装 python3 + make + g++ 以支持 node-gyp 源码编译
# apt 源替换为华为云镜像，加速构建期依赖安装
RUN sed -i 's/deb.debian.org/mirrors.huaweicloud.com/g; s/security.debian.org/mirrors.huaweicloud.com/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's/deb.debian.org/mirrors.huaweicloud.com/g; s/security.debian.org/mirrors.huaweicloud.com/g' /etc/apt/sources.list
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm config set registry https://registry.npmmirror.com

COPY package.json ./
RUN npm install
COPY . .
# 前端构建（web/dist 在 .gitignore，不随仓库走，必须在此生成）
WORKDIR /app/web
RUN npm install && npm run build
WORKDIR /app

# ── 运行阶段：仅运行时，数据卷挂 /app/data ──
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# 数据落盘目录（pm.db + attachments）由 volume 挂载，重建镜像不丢数据
ENV DB_PATH=/app/data/pm.db
ENV ATTACHMENT_ROOT=/app/data/attachments
# 生产务必关闭开发免登（即便未配飞书也不会默认开启）
ENV ALLOW_DEV_LOGIN=false
COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "server.js"]
