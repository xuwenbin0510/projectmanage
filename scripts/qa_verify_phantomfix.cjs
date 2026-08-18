#!/usr/bin/env node
'use strict';
/*
 * B14 幻影管理员修复复验脚本（QA · 严过关）
 * 目的：复验 software-engineer 对 seed 幻影管理员 dev_徐文斌 的修复。
 * 机制：启动后端 → db.js 自动执行 migrations.run + seed.run(含 cleanupDirtyData) → 读取"清理后"真实状态断言。
 * 端口用 3998，避免与既有 3999 实例冲突。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const PM_DIR = 'C:/Users/xuwen/WorkBuddy/AstrBytes/pm-app';
const DB_PATH = path.join(PM_DIR, 'pm.db');
const TEST_PORT = 3998;
const BASE = 'http://127.0.0.1:' + TEST_PORT + '/api';

const checks = [];
function check(name, pass, detail) {
  checks.push({ name: name, pass: !!pass });
  console.log('  [' + (pass ? 'PASS' : 'FAIL') + '] ' + name + (detail ? '  —— ' + detail : ''));
}
function parseEnv(content) {
  const out = {};
  content.split('\n').forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
  return out;
}
function mintToken(envSecret, userRow) {
  const payload = Buffer.from(JSON.stringify({
    uid: userRow.id, oid: userRow.open_id, nm: userRow.name, rl: userRow.global_role,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', envSecret).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function httpReq(method, urlPath, token, body) {
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(urlPath);
    const opts = { host: u.hostname, port: u.port, path: u.pathname + u.search, method: method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(opts, function (res) {
      let buf = '';
      res.on('data', function (c) { buf += c; });
      res.on('end', function () { let j = null; try { j = JSON.parse(buf); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' B14 幻影管理员修复复验 · 严过关');
  console.log('══════════════════════════════════════════════════════════════');

  const env = parseEnv(fs.readFileSync(path.join(PM_DIR, '.env'), 'utf8'));
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 8000');
  const reportSvc = require(path.join(PM_DIR, 'server/services/report.service.js'));

  // 启动后端 → 自动执行 migrations + seed.cleanupDirtyData（清理幻影）
  const server = spawn('node', ['server.js'], {
    cwd: PM_DIR,
    env: Object.assign({}, process.env, { PORT: String(TEST_PORT), DB_PATH: './pm.db', NODE_ENV: 'test' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  await new Promise(function (resolve) {
    const on = function (d) { if (d.toString().indexOf('服务已启动') >= 0) { ready = true; resolve(); } };
    server.stdout.on('data', on); server.stderr.on('data', on);
    setTimeout(function () { resolve(); }, 20000);
  });
  check('后端启动成功（触发 migrations + seed 清理）', ready);
  if (!ready) { db.close(); try { server.kill(); } catch (e) {} process.exit(1); }

  const PID = 'Pmslkpu9a00dx'; // 原脏项目（pm 脏值 dev_徐文斌 已收敛）

  // 1) 脏 pm 已收敛为合法 open_id
  const dp = db.prepare('SELECT id, name, pm FROM projects WHERE id = ?').get(PID);
  check('脏数据清理：Pmslkpu9a00dx.pm 收敛为合法 open_id', dp && dp.pm === 'ou_xuwenbin01',
    'pm=' + JSON.stringify(dp && dp.pm) + '（清理前=dev_徐文斌）');

  // 2) 幻影管理员已删除
  const phantom = db.prepare("SELECT open_id FROM users WHERE open_id = 'dev_徐文斌'").get();
  check('脏数据清理：幻影管理员 dev_徐文斌 已删除', !phantom, phantom ? '仍存在 open_id=dev_徐文斌' : '已删除 ✓');

  // 3) project_members(pm) 为真实账号
  const pmm = db.prepare("SELECT user_open_id FROM project_members WHERE project_id = ? AND project_role = 'pm'").all(PID).map(function (r) { return r.user_open_id; });
  check('脏数据清理：Pmslkpu9a00dx project_members(pm) 为真实账号', pmm.length === 1 && pmm[0] === 'ou_xuwenbin01',
    'pmMembers=' + JSON.stringify(pmm));

  // 4) 哨兵变异：改 pm 为脏哨兵，确认人不应受影响（证明列被忽略）—— 在清理后状态验证
  const curPm = db.prepare('SELECT pm FROM projects WHERE id = ?').get(PID).pm;
  const cBefore = reportSvc.resolveConfirmers(db, PID, 'ou_wudi09');
  db.prepare('UPDATE projects SET pm = ? WHERE id = ?').run('SENTINEL_DIRTY_XYZ', PID);
  const cAfter = reportSvc.resolveConfirmers(db, PID, 'ou_wudi09');
  check('脏数据绕过(哨兵变异·清理后)：改 pm 不影响确认人',
    !cAfter.has('SENTINEL_DIRTY_XYZ') && cAfter.has('ou_xuwenbin01'),
    'sentinel 泄露=' + cAfter.has('SENTINEL_DIRTY_XYZ') + '；确认人=' + JSON.stringify(Array.from(cAfter)));
  // 还原 pm 为收敛值（不污染数据）
  db.prepare('UPDATE projects SET pm = ? WHERE id = ?').run(curPm === null ? 'ou_xuwenbin01' : curPm, PID);
  const restoredPm = db.prepare('SELECT pm FROM projects WHERE id = ?').get(PID).pm;
  check('验证后 pm 已还原为收敛值', restoredPm === 'ou_xuwenbin01', 'pm=' + JSON.stringify(restoredPm));

  // 5) 7 条周报（作者=admin）确认人：补 TL 后应为 [ou_wudi09]（真实账号，闭环闭合），且绝不含幻影
  const reps = db.prepare("SELECT id, author_open_id FROM work_reports WHERE project_id = ? AND status = '已提交'").all(PID);
  let confirmOk = reps.length > 0;
  reps.forEach(function (r) {
    const c = reportSvc.resolveConfirmers(db, r.project_id, r.author_open_id);
    const arr = Array.from(c);
    if (c.has('dev_徐文斌')) confirmOk = false;                 // 幻影仍在=失败
    if (!(arr.length === 1 && arr[0] === 'ou_wudi09')) confirmOk = false; // 应为真实 TL
    console.log('    周报 ' + r.id + ' 作者=' + r.author_open_id + ' → 确认人=' + JSON.stringify(arr));
  });
  check('补 TL 后：7 条周报确认人=[ou_wudi09]（真实账号，闭环闭合，无幻影）', confirmOk,
    '周报数=' + reps.length + '；预期确认人=[ou_wudi09]');

  // 5b) TL 成员已补齐（幂等 INSERT OR IGNORE）
  const tlMembers = db.prepare("SELECT user_open_id FROM project_members WHERE project_id = ? AND project_role = 'tl'").all(PID).map(function (r) { return r.user_open_id; });
  check('脏数据清理：Pmslkpu9a00dx 已补齐 TL 成员 ou_wudi09', tlMembers.indexOf('ou_wudi09') >= 0,
    'tlMembers=' + JSON.stringify(tlMembers));

  // 6) 待确认接口行为（admin 视角）
  const admin = db.prepare('SELECT id, open_id, name, global_role FROM users WHERE open_id = ?').get('ou_xuwenbin01');
  const tok = mintToken(env.SESSION_SECRET, admin);
  const pc = await httpReq('GET', BASE + '/reports/pending-confirmation', tok);
  const pcData = (pc.json && pc.json.data) || [];
  check('admin 待确认列表返回可确认周报', pcData.length > 0, 'admin 待确认数=' + pcData.length);
  const inDirty = pcData.filter(function (r) { return r.projectId === PID; }).length;
  check('脏项目周报不污染 admin 待确认（作者即pm被排除）', inDirty === 0, '其中脏项目(' + PID + ')=' + inDirty);

  db.close();
  try { server.kill('SIGTERM'); } catch (e) {}

  const pass = checks.filter(function (c) { return c.pass; }).length;
  const fail = checks.length - pass;
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' 汇总：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + checks.length);
  console.log('══════════════════════════════════════════════════════════════');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(function (e) { console.error('脚本异常：', e); process.exit(2); });
