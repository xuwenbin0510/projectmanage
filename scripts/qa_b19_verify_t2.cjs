'use strict';

/**
 * B19 阶段二（T03 后端权限矩阵端点）冒烟验收卡点。
 *
 * 自包含、不依赖服务器、不碰生产库：用 better-sqlite3 开 :memory: 库，
 * 跑真实 migrations.run（含 v18）→ loadCatalog，然后挂载**真实** admin.routes + meta.routes，
 * 用本地 HTTP 请求逐一验证：
 *   A1  GET /api/meta/permissions         → 200 + 角色 + 动作
 *   A2  GET /api/meta/permission-matrix   → 200 + 当前生效矩阵（与 DEFAULT_PERMISSIONS 一致）
 *   A3  GET /api/admin/permissions        → 200 + 可编辑矩阵 + 角色 + 动作
 *   A4  PUT /api/admin/permissions        → 改动即时生效（loadCatalog 刷新，rolesFor 立即跟随）
 *   A5  防锁死：PUT 取消 admin 授权被忽略（admin 仍恒 true）
 *   A6  POST /api/admin/permissions/reset → 恢复默认
 *   A7  GET/PUT /api/admin/permission-actions → 元数据读写
 *   A8  非 admin 调 PUT /api/admin/permissions → 403
 *
 * 运行：node scripts/qa_b19_verify_t2.cjs
 * 退出码：全绿 0；任一断言失败 1。
 */

const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const Module = require('module');
const migrations = require('../server/dal/migrations');
const permissionCatalog = require('../server/services/permissionCatalog');
const { ok, asyncHandler, AppError, ErrorCode } = require('../server/lib/envelope');
const { isGlobalRole } = require('../server/services/roleCatalog');

// 隔离：让路由文件 require('../../db') 拿到我们的 :memory: 库，而非真实 pm.db 文件
// （避免污染生产/开发库）。在 require 路由前完成替换。
const memDb = new Database(':memory:');
// 路由模块（auth.js 等）在加载时即 prepare 语句，必须在 require 前建好表
migrations.run(memDb);
permissionCatalog.loadCatalog(memDb);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../../db' || request === './db' || request === '../db') {
    return memDb;
  }
  return origLoad.apply(this, arguments);
};

const adminRoutes = require('../server/routes/admin.routes');
const metaRoutes = require('../server/routes/meta.routes');
const { signToken } = require('../server/lib/token');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + name);
  } else {
    failed += 1;
    failures.push(name);
    console.error('  ✗ FAIL: ' + name);
  }
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

/** 注入一个 admin 用户行（供真实 token 鉴权）；迁移与预热已在脚本顶部完成 */
function buildDb() {
  const now = new Date().toISOString();
  memDb.prepare(
    "INSERT INTO users (open_id, name, email, global_role, status, must_change_pwd, created_at, updated_at) "
    + "VALUES ('ou_admin', 'Admin', 'admin@local', 'admin', 'active', 0, ?, ?)"
  ).run(now, now);
  const adminToken = signToken(memDb.prepare("SELECT * FROM users WHERE open_id = 'ou_admin'").get());
  // 真实 guest 用户（pmo，非 admin）写入 memDb，确保 resolveUser 能查到 → 触发 403 而非 401
  memDb.prepare(
    "INSERT INTO users (open_id, name, email, global_role, status, must_change_pwd, created_at, updated_at) "
    + "VALUES ('ou_guest', 'Guest', 'guest@local', 'pmo', 'active', 0, ?, ?)"
  ).run(now, now);
  const guestToken = signToken(memDb.prepare("SELECT * FROM users WHERE open_id = 'ou_guest'").get());
  return { db: memDb, adminToken, guestToken };
}

/** 轻量 express 应用：用真实 token 走真实 requireAuth/requireGlobalRole，挂载真实路由 */
function buildApp(db, adminToken, guestToken) {
  const app = express();
  app.use(express.json());
  // 在测试 app 级拦截：把对应 token 注入 Authorization 头（真实鉴权路径）
  app.use(function (req, res, next) {
    // 根据路径前缀决定用哪个 token：/admin/* 用 adminToken，其余（含 meta）按场景
    // 这里统一：若请求带 ?asGuest=1 用 guestToken，否则 adminToken
    if (req.query && req.query.asGuest === '1') {
      req.headers['authorization'] = 'Bearer ' + guestToken;
    } else {
      req.headers['authorization'] = 'Bearer ' + adminToken;
    }
    next();
  });
  app.use(metaRoutes);
  app.use(adminRoutes);
  // 错误处理（envelope 风格）
  // eslint-disable-next-line no-unused-vars
  app.use(function (err, req, res, next) {
    const code = err && err.code ? err.code : (ErrorCode.E_INTERNAL);
    const status = code === ErrorCode.E_UNAUTHORIZED ? 401 : code === ErrorCode.E_FORBIDDEN ? 403 : 400;
    res.status(status).json({ code: String(code), message: err && err.message ? err.message : 'error' });
  });
  return app;
}

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, function () {
      const port = server.address().port;
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port: port, path: path, method: method, headers: { 'Content-Type': 'application/json' } },
        function (res) {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', function () {
            server.close();
            let json = null;
            try { json = JSON.parse(buf); } catch (e) { /* ignore */ }
            resolve({ status: res.statusCode, json: json });
          });
        }
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  });
}

async function main() {
  const { db, adminToken, guestToken } = buildDb();
  const appAdmin = buildApp(db, adminToken, guestToken);
  const appGuest = buildApp(db, adminToken, guestToken);

  section('A1 · GET /api/meta/permissions（只读元数据）');
  const m1 = await request(appAdmin, 'GET', '/meta/permissions');
  assert(m1.status === 200, 'A1.1 返回 200');
  assert(m1.json && m1.json.data && Array.isArray(m1.json.data.roles) && m1.json.data.roles.length > 0, 'A1.2 含角色列表');
  assert(m1.json.data.actions.some((a) => a.action === 'project:create'), 'A1.3 含 project:create 动作元数据');

  section('A2 · GET /api/meta/permission-matrix（当前生效矩阵）');
  const m2 = await request(appAdmin, 'GET', '/meta/permission-matrix');
  assert(m2.status === 200, 'A2.1 返回 200');
  const pm = m2.json.data.matrix;
  assert(pm['project:create'] && pm['project:create']['pm'] === true, 'A2.2 project:create 含 pm=true（默认种子一致）');
  assert(pm['project:delete'] && pm['project:delete']['admin'] === true, 'A2.3 project:delete 含 admin=true');
  // 校验 rolesFor 与矩阵同源：admin 取消在@gA 防锁死
  assert(permissionCatalog.rolesFor('project:create').roles.indexOf('pm') >= 0, 'A2.4 rolesFor(project:create) 含 pm（与矩阵同源）');

  section('A3 · GET /api/admin/permissions（可编辑矩阵）');
  const m3 = await request(appAdmin, 'GET', '/admin/permissions');
  assert(m3.status === 200, 'A3.1 返回 200');
  assert(m3.json.data.actions.length === 28, 'A3.2 返回 28 个权限动作');
  assert(m3.json.data.roles.some((r) => r.roleKey === 'admin'), 'A3.3 含 admin 角色');

  section('A4 · PUT /api/admin/permissions（改动即时生效）');
  // 取消 pm 对 project:create 的授权
  const before = permissionCatalog.rolesFor('project:create').roles.slice();
  const editMatrix = JSON.parse(JSON.stringify(m3.json.data.matrix));
  editMatrix['project:create']['pm'] = false;
  const m4 = await request(appAdmin, 'PUT', '/admin/permissions', { matrix: editMatrix });
  assert(m4.status === 200, 'A4.1 返回 200');
  // 即时生效：rolesFor 立即跟随（无需重启）
  const after = permissionCatalog.rolesFor('project:create').roles;
  assert(after.indexOf('pm') < 0, 'A4.2 rolesFor(project:create) 已不含 pm（写后即时刷新）');
  assert(before.indexOf('pm') >= 0, 'A4.3 变更前 pm 确实在列（对照有效）');

  section('A5 · 防锁死（永不取消 admin 授权）');
  const editMatrix2 = JSON.parse(JSON.stringify(m4.json.data.matrix));
  editMatrix2['project:delete']['admin'] = false; // 试图取消 admin
  const m5 = await request(appAdmin, 'PUT', '/admin/permissions', { matrix: editMatrix2 });
  assert(m5.status === 200, 'A5.1 返回 200（被忽略而非报错）');
  assert(permissionCatalog.rolesFor('project:delete').roles.indexOf('admin') >= 0, 'A5.2 admin 仍恒为 project:delete 授权（未取消）');

  section('A6 · POST /api/admin/permissions/reset（恢复默认）');
  const m6 = await request(appAdmin, 'POST', '/admin/permissions/reset');
  assert(m6.status === 200, 'A6.1 返回 200');
  assert(permissionCatalog.rolesFor('project:create').roles.indexOf('pm') >= 0, 'A6.2 重置后 pm 重新具备 project:create');
  // 与 DEFAULT_PERMISSIONS 全等
  const { DEFAULT_PERMISSIONS } = require('../server/config/permissions');
  const allActions = Object.keys(DEFAULT_PERMISSIONS);
  let identical = true;
  allActions.forEach((a) => {
    const dbRoles = permissionCatalog.rolesFor(a).roles.slice().sort();
    const constRoles = DEFAULT_PERMISSIONS[a].roles.slice().sort();
    if (JSON.stringify(dbRoles) !== JSON.stringify(constRoles)) identical = false;
  });
  assert(identical, 'A6.3 重置后 DB 矩阵与 DEFAULT_PERMISSIONS 全 28 动作一致');

  section('A7 · GET/PUT /api/admin/permission-actions（元数据读写）');
  const m7a = await request(appAdmin, 'GET', '/admin/permission-actions');
  assert(m7a.status === 200 && m7a.json.data.length === 28, 'A7.1 GET 返回 28 个动作');
  const newLabel = '新建项目（改名冒烟）';
  const m7b = await request(appAdmin, 'PUT', '/admin/permission-actions', {
    actions: [{ action: 'project:create', label: newLabel }],
  });
  assert(m7b.status === 200, 'A7.2 PUT 返回 200');
  const reRead = await request(appAdmin, 'GET', '/admin/permission-actions');
  const target = reRead.json.data.find((a) => a.action === 'project:create');
  assert(target && target.label === newLabel, 'A7.3 改名已持久化');
  // 还原
  await request(appAdmin, 'PUT', '/admin/permission-actions', { actions: [{ action: 'project:create', label: '新建项目' }] });

  section('A8 · 非 admin 调 PUT /api/admin/permissions → 403');
  const m8 = await request(appGuest, 'PUT', '/admin/permissions?asGuest=1', { matrix: m3.json.data.matrix });
  assert(m8.status === 403, 'A8.1 非 admin 返回 403');
  const m8b = await request(appGuest, 'GET', '/meta/permissions?asGuest=1');
  assert(m8b.status === 200, 'A8.2 非 admin 仍可读只读元数据（200）');

  section('结果汇总');
  console.log('\n  通过 ' + passed + ' / 失败 ' + failed);
  if (failures.length) {
    console.error('  失败项：\n   - ' + failures.join('\n   - '));
  }

  db.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('冒烟脚本异常：', e);
  process.exit(1);
});
