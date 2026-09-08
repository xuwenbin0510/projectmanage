/**
 * 服务入口（Connect v1 · 已瘦身为「装配」角色）
 *
 * 启动顺序：
 *   1. `require('./config')`  —— 密钥硬校验，SESSION_SECRET 缺失 / 仍是默认值 → process.exit(1)（D-7）
 *   2. `require('./db')`      —— 连接 SQLite（WAL）→ 跑版本化迁移 → 幂等播种
 *   3. 中间件 → 路由 → 错误兜底 → 静态前端 → SPA fallback → listen
 *
 * 业务逻辑一律不在本文件：路由在 `server/routes/`，规则在 `server/lib/` 与 `server/services/`。
 */

const path = require('path');
const express = require('express');

const cfg = require('./config');           // ① 配置硬校验（可能 process.exit(1)）
const db = require('./db');                // ② 连接 + 迁移 + 播种（副作用导入）
const apiRoutes = require('./server/routes/index.routes');
const { errorMiddleware } = require('./server/lib/envelope');
const { initSnapshotScheduler } = require('./server/services/snapshotScheduler');

const app = express();

/* ── 中间件 ─────────────────────────────────────────── */

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

/* ── API 路由（内部已完成 /api 兜底 404） ─────────────── */

app.use('/api', apiRoutes);

/* ── 错误兜底（必须在所有路由之后） ───────────────────── */

app.use(errorMiddleware);

/* ── 静态前端 + SPA fallback ─────────────────────────── */

const WEB_DIST = path.join(__dirname, 'web', 'dist');
/* index.html 必须 no-cache：JS chunk 文件名带内容 hash 可永久缓存，
 * 但若 index.html 被浏览器缓存，发版后用户拿到的还是旧 hash 引用 → 一直跑旧 bundle。
 * 此前两次「发版后功能不生效、硬刷新才好」（新建按钮 2026-09-07 / 角色下拉 2026-09-08）均由此起。 */
app.use(
  express.static(WEB_DIST, {
    setHeaders: function setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.get('*', function spaFallback(req, res) {
  /* 走到这里说明不是 /api（/api 已被上面的 apiNotFound 拦下），直接回 index.html */
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(WEB_DIST, 'index.html'), function (err) {
    if (err) {
      res.status(404).type('text/plain').send('前端资源未构建：请先在 web/ 目录执行 npm run build');
    }
  });
});

/* ── 启动 ───────────────────────────────────────────── */

const server = app.listen(cfg.PORT, '0.0.0.0', function onListen() {
  console.log('[PM] 服务已启动: http://0.0.0.0:' + cfg.PORT);
  console.log('[PM] 飞书凭证: ' + (cfg.FEISHU_APP_ID ? '已配置' : '未配置'));
  console.log('[PM] 免密登录(ALLOW_DEV_LOGIN): ' + (cfg.ALLOW_DEV_LOGIN ? '开启' : '关闭'));
  if (typeof apiRoutes.warnDeprecated === 'function') apiRoutes.warnDeprecated();
  /* D03 到点快照：启动补偿（上周/前周缺失项目补拍）+ 每周一 00:10 定时全量快照 */
  initSnapshotScheduler(db);
});

/* 优雅退出：容器滚动更新时不要吞掉在途请求 */
['SIGTERM', 'SIGINT'].forEach(function (sig) {
  process.on(sig, function onSignal() {
    console.log('[PM] 收到 ' + sig + '，正在关闭服务…');
    server.close(function () { process.exit(0); });
  });
});

module.exports = app;
