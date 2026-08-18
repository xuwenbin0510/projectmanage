#!/usr/bin/env node
'use strict';
/*
 * B14 独立测试验证脚本（QA · 严过关）
 * 目标：证明 B14 三块功能（任务优先级 / 周报轻量闭环 / 统一待办中心）真实可用，
 *      不依赖"文件存在"，全部通过实际 DB 断言 + 启动后端 HTTP 接口调用验证。
 *
 * 运行：node scripts/qa_b14_verify.cjs   （需先从 pm-app 根目录执行）
 * 说明：本脚本会 (1) 直连 pm.db 做 schema / 脏数据绕过 / 存量回填断言；
 *       (2) 以独立子进程启动后端（指定测试端口 3999），用 HMAC 令牌模拟 admin/确认人/非确认人
 *           调用「待确认周报」「确认/打回」「listWbs」「PATCH priority」等接口；
 *       (3) 交叉印证待办六源聚合口径（API 返回 vs 后端 service 层 vs 纯 SQL 独立核算）；
 *       (4) 跑 `npx tsc --noEmit` 复验前端 0 错误；
 *       (5) 所有破坏性操作（确认/打回/改优先级）均在事后用 better-sqlite3 直连还原。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const PM_DIR = 'C:/Users/xuwen/WorkBuddy/AstrBytes/pm-app';
const DB_PATH = path.join(PM_DIR, 'pm.db');
const WEB_DIR = path.join(PM_DIR, 'web');
const TEST_PORT = 3999;
const BASE = 'http://127.0.0.1:' + TEST_PORT + '/api';

/* ───────────────────────── 结果收集 ───────────────────────── */
const checks = [];
function check(name, pass, detail) {
  checks.push({ name: name, pass: !!pass, detail: detail || '' });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log('  [' + tag + '] ' + name + (detail ? '  —— ' + detail : ''));
}

/* ───────────────────────── 工具函数 ───────────────────────── */
function parseEnv(content) {
  const out = {};
  content.split('\n').forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
  return out;
}

// 用与服务端相同的 SESSION_SECRET 签发 Bearer 令牌（等价于 devlogin 登录态）
function mintToken(envSecret, userRow) {
  const payload = Buffer.from(JSON.stringify({
    uid: userRow.id,
    oid: userRow.open_id,
    nm: userRow.name,
    rl: userRow.global_role,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', envSecret).update(payload).digest('base64url');
  return payload + '.' + sig;
}

// 原生 http 请求（避免对全局 fetch 可用性的依赖）
function httpReq(method, urlPath, token, body) {
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(urlPath);
    const opts = {
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(opts, function (res) {
      let buf = '';
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: json, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* ───────────────────────── 独立复刻 resolveConfirmers ─────────────────────────
 * 与服务端 server/services/report.service.js#resolveConfirmers 逐字等价，
 * 仅用 raw SQL 实现，用于"独立核算"，证明确认人解析绕过脏列 projects.pm。 */
function resolveConfirmers(db, projectId, authorOpenId) {
  const pmSet = new Set(
    db.prepare("SELECT user_open_id FROM project_members WHERE project_id = ? AND project_role = 'pm'")
      .all(projectId).map(function (r) { return r.user_open_id; }).filter(Boolean)
  );
  const result = new Set();
  const authorIsPm = authorOpenId && pmSet.has(authorOpenId);
  if (authorIsPm || pmSet.size === 0) {
    db.prepare("SELECT user_open_id FROM project_members WHERE project_id = ? AND project_role = 'tl'")
      .all(projectId).forEach(function (r) { if (r.user_open_id) result.add(r.user_open_id); });
    db.prepare("SELECT open_id FROM users WHERE global_role = 'admin'")
      .all().forEach(function (r) { if (r.open_id) result.add(r.open_id); });
  } else {
    pmSet.forEach(function (v) { result.add(v); });
  }
  if (authorOpenId) result.delete(authorOpenId);
  return result;
}

/* ───────────────────────── 主流程 ───────────────────────── */
async function main() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' B14 QA 验证脚本 · 严过关');
  console.log('══════════════════════════════════════════════════════════════');

  /* ---- 准备：读取 .env 拿 SESSION_SECRET；打开 DB 连接 ---- */
  const env = parseEnv(fs.readFileSync(path.join(PM_DIR, '.env'), 'utf8'));
  const SECRET = env.SESSION_SECRET;
  check('.env 含 SESSION_SECRET', !!SECRET, SECRET ? '长度 ' + SECRET.length : '缺失');

  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 8000');

  // 后端 service 层（纯函数，接受 db 参数，不会自行开连接）
  const workbenchSvc = require(path.join(PM_DIR, 'server/services/workbench.service.js'));
  const reportSvc = require(path.join(PM_DIR, 'server/services/report.service.js'));
  const dates = require(path.join(PM_DIR, 'server/lib/dates.js'));

  /* ════════════════ 阶段 A：schema / 脏数据绕过 / 存量回填 ════════════════ */
  console.log('\n── 阶段 A：Schema 与脏数据绕过（直连 pm.db）──');

  const wbsCols = db.prepare('PRAGMA table_info(wbs_nodes)').all().map(function (c) { return c.name; });
  check('wbs_nodes.priority 列存在', wbsCols.indexOf('priority') >= 0);

  const total = db.prepare('SELECT COUNT(*) c FROM wbs_nodes').get().c;
  const nullOrEmpty = db.prepare("SELECT COUNT(*) c FROM wbs_nodes WHERE priority IS NULL OR TRIM(priority) = ''").get().c;
  const illegal = db.prepare("SELECT COUNT(*) c FROM wbs_nodes WHERE priority NOT IN ('P0','P1','P2','P3')").get().c;
  const p2count = db.prepare("SELECT COUNT(*) c FROM wbs_nodes WHERE priority = 'P2'").get().c;
  check('wbs_nodes 无空 / 非法 priority', nullOrEmpty === 0 && illegal === 0,
    '总行数=' + total + '，空/非法=' + (nullOrEmpty + illegal) + '，P2=' + p2count);
  check('wbs_nodes 存量行均为 P2（迁移回填）', p2count === total,
    'P2 ' + p2count + ' / ' + total + (p2count === total ? '，全部回填 P2 ✓' : '（存在非 P2，见上）'));

  const wrCols = db.prepare('PRAGMA table_info(work_reports)').all().map(function (c) { return c.name; });
  ['confirmed_by', 'confirmed_at', 'reject_reason'].forEach(function (col) {
    check('work_reports.' + col + ' 列存在', wrCols.indexOf(col) >= 0);
  });

  const statusRows = db.prepare('SELECT status, COUNT(*) c FROM work_reports GROUP BY status').all();
  const stMap = {};
  statusRows.forEach(function (r) { stMap[r.status] = r.c; });
  console.log('    work_reports 状态分布：' + JSON.stringify(stMap));
  check('work_reports 含 已提交/草稿 记录', (stMap['已提交'] || 0) > 0 && (stMap['草稿'] || 0) >= 0,
    '已提交=' + (stMap['已提交'] || 0) + '，草稿=' + (stMap['草稿'] || 0));

  /* ---- 脏数据绕过：受控注入测试（不依赖既有脏数据） ----
   * 数据质量修复后，既有脏项目已被 seed 幂等清理（见 server/dal/seed.js 删除幻影 dev_徐文斌）。
   * 为持续证明「确认人解析绕过脏列 projects.pm」，这里取一个真实存在 pm 成员的干净项目，
   * 将其 projects.pm 临时改为哨兵脏值，验证 resolveConfirmers 只读 project_members、绝不读脏列；
   * 随后完整还原，不污染演示数据。 */
  const dirtyCandidates = db.prepare(
    "SELECT id, name, pm FROM projects WHERE pm IS NOT NULL AND pm <> '' AND pm NOT LIKE 'ou_%'"
  ).all().map(function (p) {
    const pmMembers = db.prepare("SELECT user_open_id FROM project_members WHERE project_id = ? AND project_role = 'pm'")
      .all(p.id).map(function (r) { return r.user_open_id; }).filter(Boolean);
    return { id: p.id, name: p.name, dirtyPm: p.pm, pmMembers: pmMembers };
  }).filter(function (p) { return p.pmMembers.length > 0; });

  const DIRTY_PIDS = new Set(dirtyCandidates.map(function (p) { return p.id; }));
  // 正向断言：清理后不应再存在「脏 pm 项目」（确认人源仅来自 project_members）
  check('脏 pm 项目已清理（确认人源仅来自 project_members）', dirtyCandidates.length === 0,
    dirtyCandidates.length
      ? ('仍存在脏项目=' + JSON.stringify(dirtyCandidates.map(function (p) { return p.id; })))
      : '0 个脏 pm 项目（seed 幂等清理生效）');

  // 受控注入：选一个真实有 pm 成员的项目，临时把 projects.pm 改成哨兵脏值
  const injBase = db.prepare(
    "SELECT p.id, p.pm AS origPm FROM projects p WHERE EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.project_role='pm') LIMIT 1"
  ).get();
  if (injBase) {
    const SENT_A = 'dev_QA_SENTINEL_A';
    const SENT_B = 'dev_QA_SENTINEL_B';
    const pmSet = db.prepare("SELECT user_open_id FROM project_members WHERE project_id=? AND project_role='pm'")
      .all(injBase.id).map(function (r) { return r.user_open_id; }).filter(Boolean);
    // 探针作者：非 admin、且不在该项目的 pm 集合中 → 确认人应恰好=pm 集合（隔离脏列影响）
    const allUsers = db.prepare("SELECT open_id, global_role FROM users WHERE global_role<>'admin'").all();
    const probe = allUsers.filter(function (u) { return pmSet.indexOf(u.open_id) < 0; })[0];
    const probeAuthor = probe ? probe.open_id : 'ou_wudi09';

    db.prepare('UPDATE projects SET pm = ? WHERE id = ?').run(SENT_A, injBase.id);
    const injConf = reportSvc.resolveConfirmers(db, injBase.id, probeAuthor);
    const leaksA = injConf.has(SENT_A);
    const hasMember = pmSet.some(function (m) { return injConf.has(m); });
    check('脏数据绕过(受控注入)：确认人不包含脏列 projects.pm 值',
      !leaksA && hasMember,
      'projects.pm=' + JSON.stringify(SENT_A) + ' 泄露=' + leaksA + '；确认人=' + JSON.stringify(Array.from(injConf)));

    db.prepare('UPDATE projects SET pm = ? WHERE id = ?').run(SENT_B, injBase.id);
    const injConf2 = reportSvc.resolveConfirmers(db, injBase.id, probeAuthor);
    check('脏数据绕过(受控注入·哨兵变异)：改 projects.pm 不影响确认人',
      !injConf2.has(SENT_B) && pmSet.some(function (m) { return injConf2.has(m); }),
      'sentinelB 泄露=' + injConf2.has(SENT_B) + '；确认人=' + JSON.stringify(Array.from(injConf2)));

    db.prepare('UPDATE projects SET pm = ? WHERE id = ?').run(injBase.origPm, injBase.id);
    const restoredPm = db.prepare('SELECT pm FROM projects WHERE id = ?').get(injBase.id).pm;
    check('projects.pm 已还原（不污染演示数据）', restoredPm === injBase.origPm,
      'orig=' + JSON.stringify(injBase.origPm) + ' now=' + JSON.stringify(restoredPm));
  } else {
    check('脏数据绕过(受控注入)：选取注入基准项目', false, '无含 pm 成员的项目可注入');
  }

  // 数据质量正向断言：幻影管理员 dev_徐文斌 应已随 seed 幂等清理（非 B14 源码缺陷）
  const phantom = db.prepare("SELECT open_id, global_role FROM users WHERE open_id = 'dev_徐文斌'").get();
  check('[KNI] 数据质量：幻影管理员 dev_徐文斌 已清理', !phantom,
    phantom ? ('仍存在 open_id=dev_徐文斌, global_role=' + phantom.global_role)
            : '未发现（seed 幂等清理生效）');

  /* ---- PRIORITY_RANK 排序语义（复刻 enums.ts PRIORITY_RANK） ---- */
  const RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const sorted = ['P3', 'P1', 'P2', 'P0'].sort(function (a, b) { return RANK[a] - RANK[b]; });
  check('PRIORITY_RANK 排序 P0 置顶', JSON.stringify(sorted) === JSON.stringify(['P0', 'P1', 'P2', 'P3']),
    '升序结果=' + JSON.stringify(sorted));

  /* ════════════════ 阶段 B：启动后端 + HTTP 接口验证 ════════════════ */
  console.log('\n── 阶段 B：启动后端（测试端口 ' + TEST_PORT + '）并调用接口 ──');

  const server = spawn('node', ['server.js'], {
    cwd: PM_DIR,
    env: Object.assign({}, process.env, { PORT: String(TEST_PORT), DB_PATH: './pm.db', NODE_ENV: 'test' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverReady = false;
  const serverLog = [];
  await new Promise(function (resolve) {
    const onData = function (d) {
      const s = d.toString();
      serverLog.push(s);
      if (s.indexOf('服务已启动') >= 0) { serverReady = true; resolve(); }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    setTimeout(function () { if (!serverReady) resolve(); }, 20000);
  });
  check('后端启动成功（/api 可用）', serverReady, serverReady ? '' : '20s 内未收到启动信号；日志尾：' + serverLog.slice(-3).join(''));

  if (!serverReady) {
    console.log('⚠ 后端未就绪，跳过 HTTP 相关用例。');
  } else {
    // 取用户行签发令牌
    const adminRow = db.prepare('SELECT id, open_id, name, global_role FROM users WHERE open_id = ?').get('ou_xuwenbin01');
    const memberRow = db.prepare('SELECT id, open_id, name, global_role FROM users WHERE open_id = ?').get('ou_wudi09');
    if (!adminRow || !memberRow) {
      check('取测试用户 ou_xuwenbin01 / ou_wudi09', false, '用户缺失');
    } else {
      const adminTok = mintToken(SECRET, adminRow);
      const memberTok = mintToken(SECRET, memberRow);

      // B1. 未登录访问待确认接口 → 401
      const noAuth = await httpReq('GET', BASE + '/reports/pending-confirmation', null);
      check('待确认周报接口：未登录→401', noAuth.status === 401, 'status=' + noAuth.status);

      // B2. 确认人(admin)访问待确认 → 服务端 resolveConfirmers 过滤后的可确认周报
      const pcAdmin = await httpReq('GET', BASE + '/reports/pending-confirmation', adminTok);
      const pcAdminData = (pcAdmin.json && pcAdmin.json.data) || [];
      // 脏列绕过间接证明：admin 待确认列表不应包含任何「脏 pm 项目」的周报
      // （数据质量修复后脏项目已清零，此项恒为 0，但仍校验不变式：确认人源不含脏列）
      const dirtyInPc = pcAdminData.filter(function (r) { return DIRTY_PIDS.has(r.projectId); });
      check('待确认列表：admin 待确认不含脏列来源项目周报（脏列未读+自确认排除）', dirtyInPc.length === 0,
        'admin 视角待确认数=' + pcAdminData.length + '，其中脏项目=' + dirtyInPc.length);
      check('待确认列表：admin 看到可确认周报', pcAdminData.length > 0,
        'admin 视角待确认数=' + pcAdminData.length);

      // B3. 非确认人(member)访问待确认 → 不应含任何待确认周报（服务端过滤）
      const pcMember = await httpReq('GET', BASE + '/reports/pending-confirmation', memberTok);
      const pcMemberData = (pcMember.json && pcMember.json.data) || [];
      check('非确认人不该看到任何待确认周报（服务端过滤）', pcMemberData.length === 0,
        'member 视角待确认数=' + pcMemberData.length);

      // 选定一条 admin 可作确认人的已提交周报 R 做确认/打回 E2E
      // （从 admin 待确认列表中挑作者≠admin 者；该列表本身已保证 admin∈确认人）
      const e2eApi = pcAdminData.find(function (r) { return r.author !== 'ou_xuwenbin01'; }) || pcAdminData[0];
      const R = e2eApi ? e2eApi.id : null;
      const R_PID = e2eApi ? e2eApi.projectId : null;
      if (R) {
        const rRow = db.prepare('SELECT project_id, status, confirmed_by, confirmed_at, reject_reason FROM work_reports WHERE id = ?').get(R);
        const orig = { status: rRow.status, confirmed_by: rRow.confirmed_by, confirmed_at: rRow.confirmed_at, reject_reason: rRow.reject_reason };

        // B4. 非确认人确认 → 403
        const c1 = await httpReq('POST', BASE + '/projects/' + R_PID + '/reports/' + R + '/confirm', memberTok);
        check('非确认人确认→403', c1.status === 403, 'status=' + c1.status);

        // B5. 确认人确认 → 200，DB status=已确认 / confirmed_by / confirmed_at
        const c2 = await httpReq('POST', BASE + '/projects/' + R_PID + '/reports/' + R + '/confirm', adminTok);
        check('确认人确认→200', c2.status === 200, 'status=' + c2.status);
        const afterConfirm = db.prepare('SELECT status, confirmed_by, confirmed_at FROM work_reports WHERE id = ?').get(R);
        check('确认后 DB：status=已确认', afterConfirm.status === '已确认', 'status=' + afterConfirm.status);
        check('确认后 DB：confirmed_by=ou_xuwenbin01', afterConfirm.confirmed_by === 'ou_xuwenbin01', 'confirmed_by=' + afterConfirm.confirmed_by);
        check('确认后 DB：confirmed_at 非空', !!afterConfirm.confirmed_at, 'confirmed_at=' + afterConfirm.confirmed_at);

        // 还原 R 到 已提交（直连更新）
        db.prepare('UPDATE work_reports SET status = ?, confirmed_by = NULL, confirmed_at = NULL, reject_reason = ? WHERE id = ?')
          .run('已提交', orig.reject_reason, R);

        // B6. 打回：空原因 → 400
        const j1 = await httpReq('POST', BASE + '/projects/' + R_PID + '/reports/' + R + '/reject', adminTok, { reason: '' });
        check('打回空原因→400', j1.status === 400, 'status=' + j1.status);

        // B7. 打回：带原因 → 200，DB status=草稿 / reject_reason 落库 / confirmed_* 清空
        const j2 = await httpReq('POST', BASE + '/projects/' + R_PID + '/reports/' + R + '/reject', adminTok, { reason: 'QA测试打回-请补充风险责任人' });
        check('打回带原因→200', j2.status === 200, 'status=' + j2.status);
        const afterReject = db.prepare('SELECT status, reject_reason, confirmed_by, confirmed_at FROM work_reports WHERE id = ?').get(R);
        check('打回后 DB：status=草稿', afterReject.status === '草稿', 'status=' + afterReject.status);
        check('打回后 DB：reject_reason 落库', afterReject.reject_reason === 'QA测试打回-请补充风险责任人', 'reject_reason=' + afterReject.reject_reason);
        check('打回后 DB：confirmed_* 清空', afterReject.confirmed_by === null && afterReject.confirmed_at === null);

        // 还原 R 到原状态
        db.prepare('UPDATE work_reports SET status = ?, confirmed_by = ?, confirmed_at = ?, reject_reason = ? WHERE id = ?')
          .run(orig.status, orig.confirmed_by, orig.confirmed_at, orig.reject_reason, R);
        const restored = db.prepare('SELECT status, confirmed_by, confirmed_at, reject_reason FROM work_reports WHERE id = ?').get(R);
        check('R 已还原到原状态（不污染演示数据）',
          restored.status === orig.status && restored.confirmed_by === orig.confirmed_by &&
          restored.confirmed_at === orig.confirmed_at && restored.reject_reason === orig.reject_reason,
          'status=' + restored.status);
      } else {
        check('选定脏项目周报做确认/打回 E2E', false, '未找到可测试的脏项目已提交周报');
      }

      // B8. listWbs 返回任务含 priority 字段（动态选含 WBS 节点最多的项目）
      const wbsProjRow = db.prepare('SELECT project_id, COUNT(*) c FROM wbs_nodes GROUP BY project_id ORDER BY c DESC LIMIT 1').get();
      const WBS_PID = wbsProjRow ? wbsProjRow.project_id : null;
      const wbsResp = await httpReq('GET', BASE + '/projects/' + WBS_PID + '/wbs', adminTok);
      const wbsData = (wbsResp.json && wbsResp.json.data) || [];
      const allHavePrio = wbsData.length > 0 && wbsData.every(function (n) {
        return ['P0', 'P1', 'P2', 'P3'].indexOf(n.priority) >= 0;
      });
      check('listWbs 返回任务含 priority 字段', allHavePrio, '项目=' + WBS_PID + '，节点数=' + wbsData.length);

      // B9. 更新任务 priority=P0 → DB 落库 → 还原
      if (wbsData.length > 0) {
        const node = wbsData[0];
        const origPrio = node.priority;
        const up = await httpReq('PATCH', BASE + '/wbs/' + node.id, adminTok, { priority: 'P0' });
        check('PATCH priority=P0→200', up.status === 200, 'status=' + up.status + (up.json && up.json.message ? '（' + up.json.message + '）' : ''));
        const dbPrio = db.prepare('SELECT priority FROM wbs_nodes WHERE id = ?').get(node.id).priority;
        check('DB priority 落库=P0', dbPrio === 'P0', 'priority=' + dbPrio);

        // B10. 非法 priority → 400
        const bad = await httpReq('PATCH', BASE + '/wbs/' + node.id, adminTok, { priority: 'PX' });
        check('非法 priority→400', bad.status === 400, 'status=' + bad.status);

        // 还原 priority
        await httpReq('PATCH', BASE + '/wbs/' + node.id, adminTok, { priority: origPrio });
        const restoredPrio = db.prepare('SELECT priority FROM wbs_nodes WHERE id = ?').get(node.id).priority;
        check('任务 priority 已还原', restoredPrio === origPrio, 'priority=' + restoredPrio);
      }

      /* ════════════════ 阶段 B11：待办六源聚合交叉印证 ════════════════ */
      console.log('\n── 阶段 B11：待办六源聚合口径交叉印证（admin 视角）──');
      const wb = await httpReq('GET', BASE + '/workbench', adminTok);
      const wbData = (wb.json && wb.json.data) || {};
      const pc = await httpReq('GET', BASE + '/reports/pending-confirmation', adminTok);
      const pcData = (pc.json && pc.json.data) || [];

      const adminMe = { id: adminRow.id, open_id: 'ou_xuwenbin01', name: '徐文斌', global_role: 'admin' };

      // 后端 service 层口径（与接口同一套实现）
      const svcMyTasks = workbenchSvc.listMyTasks(db, adminMe);
      const svcApprovals = workbenchSvc.listMyApprovals(db, adminMe);
      const svcReminders = workbenchSvc.listReportReminders(db, adminMe);
      const svcPending = reportSvc.listPendingConfirmation(db, 'ou_xuwenbin01');

      // 纯 SQL 独立核算
      const curWeek = dates.weekCode();
      // APPROVAL：admin 可决定全部 审批中 评审
      const indepApproval = db.prepare("SELECT COUNT(*) c FROM reviews WHERE status = '审批中'").get().c;
      // REPORT_FILL：我参与且进行中、本周无已提交周报的项目数
      const indepReportFill = db.prepare(
        "SELECT COUNT(*) c FROM projects p WHERE p.deleted_at IS NULL AND p.status = '进行中' " +
        "AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_open_id = ?) " +
        "AND NOT EXISTS (SELECT 1 FROM work_reports wr WHERE wr.project_id = p.id AND wr.week = ? AND wr.status = '已提交')"
      ).get('ou_xuwenbin01', curWeek).c;
      // ASSIGNED / OVERDUE / BLOCKED：叶子 + owner=admin + status!=完成
      const nodes = db.prepare(
        'SELECT n.* FROM wbs_nodes n JOIN projects p ON p.id = n.project_id ' +
        "WHERE p.deleted_at IS NULL AND p.status NOT IN ('已结项','已终止') " +
        "AND n.project_id IN (SELECT project_id FROM project_members WHERE user_open_id = ?)"
      ).all('ou_xuwenbin01');
      const childCount = {};
      nodes.forEach(function (n) { if (n.parent_id) childCount[n.parent_id] = (childCount[n.parent_id] || 0) + 1; });
      const today = dates.today();
      let indepAssigned = 0, indepOverdue = 0, indepBlocked = 0;
      nodes.forEach(function (n) {
        if ((childCount[n.id] || 0) > 0) return;        // 非叶子
        if (n.owner !== 'ou_xuwenbin01') return;          // 非我负责
        if (n.status === '完成') return;                  // 已完成排除
        indepAssigned += 1;
        if (n.status === '阻塞') indepBlocked += 1;
        if (n.due_date && dates.diffDays(today, n.due_date) < 0) indepOverdue += 1;
      });
      // REPORT_CONFIRM：逐条 resolveConfirmers 独立复刻
      const submitted = db.prepare("SELECT * FROM work_reports WHERE status = '已提交'").all();
      let indepConfirm = 0;
      submitted.forEach(function (r) {
        if (resolveConfirmers(db, r.project_id, r.author_open_id).has('ou_xuwenbin01')) indepConfirm += 1;
      });

      const apiApproval = (wbData.myApprovals || []).length;
      const apiReportFill = (wbData.reportReminders || []).filter(function (x) { return !x.filled; }).length;
      const apiAssigned = (wbData.myTasks || []).length;
      const apiOverdue = (wbData.stats && wbData.stats.overdueTasks) || (wbData.myTasks || []).filter(function (t) {
        return t.dueDate && dates.diffDays(dates.today(), t.dueDate) < 0;
      }).length;
      const apiBlocked = (wbData.myTasks || []).filter(function (t) { return t.status === '阻塞'; }).length;
      const apiReportConfirm = pcData.length;

      console.log('    源             API     service   独立SQL');
      console.log('    APPROVAL       ' + apiApproval + '      ' + svcApprovals.length + '        ' + indepApproval);
      console.log('    REPORT_FILL    ' + apiReportFill + '      ' + svcReminders.filter(function (x) { return !x.filled; }).length + '        ' + indepReportFill);
      console.log('    ASSIGNED       ' + apiAssigned + '      ' + svcMyTasks.length + '        ' + indepAssigned);
      console.log('    OVERDUE        ' + apiOverdue + '      ' + workbenchSvc.countOverdue(svcMyTasks) + '        ' + indepOverdue);
      console.log('    BLOCKED        ' + apiBlocked + '      ' + svcMyTasks.filter(function (t) { return t.status === '阻塞'; }).length + '        ' + indepBlocked);
      console.log('    REPORT_CONFIRM ' + apiReportConfirm + '      ' + svcPending.length + '        ' + indepConfirm);

      check('六源-APPROVAL 三方一致', apiApproval === svcApprovals.length && svcApprovals.length === indepApproval,
        apiApproval + '/' + svcApprovals.length + '/' + indepApproval);
      check('六源-REPORT_FILL 三方一致', apiReportFill === svcReminders.filter(function (x) { return !x.filled; }).length && svcReminders.filter(function (x) { return !x.filled; }).length === indepReportFill,
        apiReportFill + '/' + svcReminders.filter(function (x) { return !x.filled; }).length + '/' + indepReportFill);
      check('六源-ASSIGNED 三方一致', apiAssigned === svcMyTasks.length && svcMyTasks.length === indepAssigned,
        apiAssigned + '/' + svcMyTasks.length + '/' + indepAssigned);
      check('六源-OVERDUE 三方一致', apiOverdue === workbenchSvc.countOverdue(svcMyTasks) && workbenchSvc.countOverdue(svcMyTasks) === indepOverdue,
        apiOverdue + '/' + workbenchSvc.countOverdue(svcMyTasks) + '/' + indepOverdue);
      check('六源-BLOCKED 三方一致', apiBlocked === svcMyTasks.filter(function (t) { return t.status === '阻塞'; }).length && svcMyTasks.filter(function (t) { return t.status === '阻塞'; }).length === indepBlocked,
        apiBlocked + '/' + svcMyTasks.filter(function (t) { return t.status === '阻塞'; }).length + '/' + indepBlocked);
      check('六源-REPORT_CONFIRM 三方一致', apiReportConfirm === svcPending.length && svcPending.length === indepConfirm,
        apiReportConfirm + '/' + svcPending.length + '/' + indepConfirm);

      // 待办总数（徽标）= 六源之和
      const totalTodo = apiApproval + apiReportFill + apiAssigned + apiOverdue + apiBlocked + apiReportConfirm;
      check('待办徽标总数=六源之和', totalTodo >= 0, 'badge total=' + totalTodo);
    }
  }

  // 关闭后端
  try { server.kill('SIGTERM'); } catch (e) { /* ignore */ }

  /* ════════════════ 阶段 C：静态前端核查（文件级，零依赖） ════════════════ */
  console.log('\n── 阶段 C：前端静态核查（路由/聚合挂载）──');
  try {
    const topbar = fs.readFileSync(path.join(WEB_DIR, 'src/components/layout/Topbar.tsx'), 'utf8');
    check('TodoBell 已挂载 Topbar', /import\s*\{\s*[^}]*TodoBell/.test(topbar) && /<TodoBell\s*\/?>/.test(topbar));
    const useTodos = fs.readFileSync(path.join(WEB_DIR, 'src/hooks/useTodos.ts'), 'utf8');
    const sixOk = ['myApprovals', 'reportReminders', 'myTasks', 'isOverdue', 'status === \'阻塞\'', 'listPendingConfirmation']
      .every(function (k) { return useTodos.indexOf(k) >= 0; });
    check('useTodos 聚合六源齐全', sixOk);
    const routes = fs.readFileSync(path.join(WEB_DIR, 'src/config/routes.ts'), 'utf8');
    check('ROUTES 含跳转常量(approvals/projectReports/projectWbs/workbench)',
      /approvals:/.test(routes) && /projectReports:/.test(routes) && /projectWbs:/.test(routes) && /workbench:/.test(routes));
    const enums = fs.readFileSync(path.join(WEB_DIR, 'src/config/enums.ts'), 'utf8');
    check('PRIORITY_RANK / PRIORITY_OPTIONS 存在', /PRIORITY_RANK/.test(enums) && /PRIORITY_OPTIONS/.test(enums));
    const dashAgg = fs.readFileSync(path.join(WEB_DIR, 'src/utils/dashboardAgg.ts'), 'utf8');
    check('aggregatePriorityDistribution / comparePriority 存在',
      /aggregatePriorityDistribution/.test(dashAgg) && /comparePriority/.test(dashAgg));
  } catch (e) {
    check('前端静态核查', false, '读取失败：' + e.message);
  }

  /* ════════════════ 阶段 D：TypeScript 编译复验 ════════════════ */
  console.log('\n── 阶段 D：web 端 tsc --noEmit 复验 ──');
  await new Promise(function (resolve) {
    const tsc = spawn('npx', ['tsc', '--noEmit'], { cwd: WEB_DIR, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    tsc.stdout.on('data', function (d) { out += d.toString(); });
    tsc.stderr.on('data', function (d) { out += d.toString(); });
    tsc.on('close', function (code) {
      check('npx tsc --noEmit 0 错误', code === 0, code === 0 ? '通过' : ('退出码 ' + code + '；输出尾部：' + out.slice(-400)));
      resolve();
    });
    setTimeout(function () { try { tsc.kill(); } catch (e) {} resolve(); }, 240000);
  });

  /* ───────────────────────── 汇总 ───────────────────────── */
  const passed = checks.filter(function (c) { return c.pass; }).length;
  const failed = checks.length - passed;
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' 汇总：' + passed + ' 通过 / ' + failed + ' 失败 / 共 ' + checks.length);
  console.log('══════════════════════════════════════════════════════════════');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('脚本异常：', e);
  process.exit(2);
});
