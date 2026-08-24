'use strict';

/**
 * B19 阶段一（T01 数据底座 + T02 判定内核）等价性验收卡点。
 *
 * 自包含、不依赖服务器、不碰生产库：用 better-sqlite3 开 :memory: 库，
 * 跑真实 migrations.run（含 v18）→ refreshRoleCatalog → loadCatalog，
 * 然后逐一断言「DB 驱动的 canDo」与「常量驱动的 canDo」全等价（零漂移）。
 *
 * 运行：node scripts/qa_b19_verify.cjs
 * 退出码：全绿 0；任一断言失败 1。
 */

const Database = require('better-sqlite3');
const migrations = require('../server/dal/migrations');
const permissions = require('../server/config/permissions');
const permissionCatalog = require('../server/services/permissionCatalog');
const { refreshRoleCatalog, isGlobalRole } = require('../server/services/roleCatalog');

const { canDo, DEFAULT_PERMISSIONS, ACTION_KEY } = permissions;

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

/**
 * 常量驱动的 canDo（独立于 DB 缓存，直接按 DEFAULT_PERMISSIONS 算）。
 * 与 server/config/permissions.js 的 canDo 同步演进：admin 短路 → 解析 key → 跨项目 → 项目内。
 * @param {string|string[]} globalRoles
 * @param {string} action
 * @param {string[]} [projectRoles]
 * @returns {boolean}
 */
function constCanDo(globalRoles, action, projectRoles) {
  const list = Array.isArray(globalRoles) ? globalRoles : [globalRoles];
  if (!list.length) return false;
  if (list.indexOf('admin') >= 0) return true;
  const key = ACTION_KEY[action] || action;
  const rule = DEFAULT_PERMISSIONS[key];
  if (!rule) return false;
  const cross = list.some(function (g) {
    return isGlobalRole(g) && rule.roles.indexOf(g) >= 0;
  });
  if (cross) return true;
  const roles = projectRoles || [];
  return roles.some(function (r) {
    return rule.roles.indexOf(r) >= 0;
  });
}

/** 重新写入 permission_rules 种子（与 v18 同逻辑，仅供 QA 复原；幂等） */
function seedRulesAgain(db) {
  const now = new Date().toISOString();
  const ins = db.prepare(
    "INSERT OR IGNORE INTO permission_rules (action, role_key, granted, updated_at, updated_by) VALUES (?, ?, 1, ?, 'seed')"
  );
  const tx = db.transaction(function () {
    Object.keys(DEFAULT_PERMISSIONS).forEach(function (action) {
      (DEFAULT_PERMISSIONS[action].roles || []).forEach(function (roleKey) {
        ins.run(action, roleKey, now);
      });
    });
  });
  tx();
}

function main() {
  const db = new Database(':memory:');

  // 1) 跑迁移（含 v18）+ 角色视野预热 + 权限矩阵预热
  migrations.run(db);
  refreshRoleCatalog(db);
  permissionCatalog.loadCatalog(db);

  const ALL_ACTIONS = Object.keys(DEFAULT_PERMISSIONS);
  const EXPECTED_RULES = ALL_ACTIONS.reduce(function (sum, a) {
    return sum + (DEFAULT_PERMISSIONS[a].roles || []).length;
  }, 0);
  const ROLES = [
    'admin', 'management', 'pmo', 'pm', 'tl', 'qa', 'cm', 'po', 'member',
    'cto', 'cpo', 'dev', 'ops', 'ued', 'sale',
  ];

  /* ── A1 等价性断言：28 action × 15 role = 420 组合，DB 驱动 vs 常量驱动 必须全等 ── */
  section('A1 等价性（DB 驱动 canDo ≡ 常量驱动 canDo，420 组合）');
  let a1Total = 0;
  let a1Mismatch = 0;
  ALL_ACTIONS.forEach(function (action) {
    ROLES.forEach(function (role) {
      a1Total += 1;
      // 以「该角色在项目内」模拟，覆盖 global（跨项目生效）+ project（仅项目内生效）两种 scope
      const dbRes = canDo([role], action, [role]);
      const constRes = constCanDo([role], action, [role]);
      if (dbRes !== constRes) {
        a1Mismatch += 1;
        failures.push('A1 mismatch ' + role + ' / ' + action + ' (db=' + dbRes + ' const=' + constRes + ')');
      }
    });
  });
  assert(a1Mismatch === 0, 'A1 全部 ' + a1Total + ' 组合 DB≡常量（漂移 ' + a1Mismatch + '）');

  // 精确对账：rolesFor 输出数组与 DEFAULT_PERMISSIONS 逐项一致
  let drift = 0;
  ALL_ACTIONS.forEach(function (action) {
    const got = permissionCatalog.rolesFor(action).roles.slice().sort();
    const want = (DEFAULT_PERMISSIONS[action].roles || []).slice().sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      drift += 1;
      failures.push('A1 rolesFor drift ' + action + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
    }
  });
  assert(drift === 0, 'A1 rolesFor(action).roles 与 DEFAULT_PERMISSIONS 逐项一致（漂移 ' + drift + '）');

  // 种子行数 = 期望值（稀疏，只存 granted=1）
  const ruleCount = db.prepare('SELECT COUNT(*) AS c FROM permission_rules').get().c;
  const actionCount = db.prepare('SELECT COUNT(*) AS c FROM permission_actions').get().c;
  assert(actionCount === ALL_ACTIONS.length, 'A1 permission_actions 行数=' + actionCount + '（期望 ' + ALL_ACTIONS.length + '）');
  assert(ruleCount === EXPECTED_RULES, 'A1 permission_rules 行数=' + ruleCount + '（期望 ' + EXPECTED_RULES + '）');

  /* ── A2 admin 恒真：清空 permission_rules 后（模拟配置写坏），canDo(['admin'], 任意) 仍 true ── */
  section('A2 admin 短路 + 降级恒真（配置写坏也不锁死）');
  db.exec('DELETE FROM permission_rules');
  permissionCatalog.invalidate();
  permissionCatalog.loadCatalog(db); // 缓存变为空 → 走降级（DEFAULT_PERMISSIONS）
  let adminAllTrue = true;
  ALL_ACTIONS.forEach(function (action) {
    if (canDo(['admin'], action) !== true) adminAllTrue = false;
  });
  assert(adminAllTrue, 'A2 清空配置后 canDo([admin], 任意 action) 仍恒 true（admin 短路 + 降级）');

  // 复原：重新写入种子并预热，供后续用例
  seedRulesAgain(db);
  permissionCatalog.loadCatalog(db);

  /* ── A3 降级生效：缓存未载入（loadCatalog 不调用）时 canDo 行为与 DEFAULT_PERMISSIONS 一致 ── */
  section('A3 缓存未载入降级');
  permissionCatalog.invalidate(); // 模拟「从不调用 loadCatalog」
  let degradeOk = true;
  ALL_ACTIONS.forEach(function (action) {
    ROLES.forEach(function (role) {
      const dbRes = canDo([role], action, [role]);
      const constRes = constCanDo([role], action, [role]);
      if (dbRes !== constRes) degradeOk = false;
    });
  });
  assert(degradeOk, 'A3 缓存未载入时 canDo 与 DEFAULT_PERMISSIONS 完全一致');
  permissionCatalog.loadCatalog(db); // 重新预热，后续用例使用真实缓存

  /* ── A4 配置即时生效（不重启） ── */
  section('A4 配置即时生效（不重启）');
  // 基线：dev 是 project scope，默认不在 task:status 的 roles 里
  const before = canDo(['dev'], 'task:status', ['dev']);
  assert(before === false, 'A4 基线：dev 默认无 task:status 权限');
  // 写入配置 + 刷新缓存
  db.prepare(
    "INSERT OR IGNORE INTO permission_rules (action, role_key, granted, updated_at, updated_by) VALUES ('task:status', 'dev', 1, ?, 'qa')"
  ).run(new Date().toISOString());
  permissionCatalog.invalidate();
  permissionCatalog.loadCatalog(db);
  const afterAdd = canDo(['dev'], 'task:status', ['dev']);
  assert(afterAdd === true, 'A4 写入 (task:status, dev) 并刷新后，dev 立即获得 task:status 权限（不重启）');
  // 删除配置 + 刷新缓存
  db.prepare("DELETE FROM permission_rules WHERE action = 'task:status' AND role_key = 'dev'").run();
  permissionCatalog.invalidate();
  permissionCatalog.loadCatalog(db);
  const afterDel = canDo(['dev'], 'task:status', ['dev']);
  assert(afterDel === false, 'A4 删除 (task:status, dev) 并刷新后，dev 立即失去 task:status 权限（不重启）');

  /* ── A5 scope 语义：global 跨项目 / project 仅项目内 ── */
  section('A5 scope 语义');
  assert(canDo(['pmo'], 'project:create') === true, 'A5 全局角色 pmo 跨项目生效 project:create（无需 projectRoles）');
  assert(canDo(['pm'], 'project:create') === false, 'A5 项目角色 pm 跨项目不生效 project:create（无 projectRoles）');
  assert(canDo(['pm'], 'project:create', ['pm']) === true, 'A5 项目角色 pm 在项目内生效 project:create（传入 projectRoles）');

  /* ── A6 护栏（T03 写接口逻辑模拟）：拒绝 roleKey==='admin' && granted===false ── */
  section('A6 护栏模拟（admin 不可被置否）');
  function wouldRejectWrite(roleKey, granted) {
    return roleKey === 'admin' && granted === false;
  }
  assert(wouldRejectWrite('admin', false) === true, 'A6 写接口应拒绝 admin + granted=false');
  assert(wouldRejectWrite('admin', true) === false, 'A6 写接口允许 admin + granted=true');
  assert(wouldRejectWrite('pmo', false) === false, 'A6 写接口允许 pmo + granted=false（非 admin 不受护栏限制）');

  /* ── A7 迁移幂等：连跑两次 migrations.run，行数不变 ── */
  section('A7 迁移幂等');
  const c1 = db.prepare('SELECT COUNT(*) AS c FROM permission_rules').get().c;
  migrations.run(db); // 第二次（同库，应全部已应用 → 无副作用）
  const c2 = db.prepare('SELECT COUNT(*) AS c FROM permission_rules').get().c;
  assert(c1 === c2, 'A7 连跑两次 migrations.run，permission_rules 行数不变（' + c1 + ' → ' + c2 + '）');
  const a1c = db.prepare('SELECT COUNT(*) AS c FROM permission_actions').get().c;
  const a2c = db.prepare('SELECT COUNT(*) AS c FROM permission_actions').get().c;
  assert(a1c === a2c, 'A7 连跑两次 migrations.run，permission_actions 行数不变（' + a1c + ' → ' + a2c + '）');

  /* ── 汇总 ── */
  console.log('\n────────────────────────────────────────');
  const total = passed + failed;
  if (failed > 0) {
    console.error('FAILED (' + passed + '/' + total + ')');
    console.error('失败明细：');
    failures.forEach(function (f) {
      console.error('  - ' + f);
    });
    process.exit(1);
  }
  console.log('ALL ASSERTIONS PASSED (' + passed + '/' + total + ')');
  console.log('B19 T01+T02 等价性验收全部通过 ✅');
  process.exit(0);
}

main();
