import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const db = require('better-sqlite3')('pm.db');
const base = 'http://127.0.0.1:3000';

function openIdOf(id) {
  const r = db.prepare('SELECT open_id FROM users WHERE id=?').get(id);
  return r && r.open_id;
}

async function devlogin(id) {
  const openId = openIdOf(id);
  const res = await fetch(base + '/api/auth/devlogin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openId }),
  });
  const data = await res.json();
  return data.token || (data.data && data.data.token);
}

async function call(token, path) {
  const res = await fetch(base + path, { headers: { Authorization: 'Bearer ' + token } });
  return res.status;
}

const cases = [
  { id: 26, name: '何繁(dev)', checks: [
    ['/api/meta/permission-matrix', 200, '普通成员可读权限矩阵(活矩阵注入)'],
    ['/api/audit', 403, '全局审计 dev 应被拦'],
    ['/api/projects', 200, '普通成员可看项目列表'],
    ['/api/users', 200, 'legacy 用户列表(仅 requireAuth)'],
  ]},
  { id: 35, name: '张雨婷(cho)', checks: [
    ['/api/audit', 200, '全局审计 cho 应放行(admin:audit:view)'],
    ['/api/admin/permissions', 403, '权限矩阵配置 cho 应被拦(admin:permission:config)'],
  ]},
];

let fail = 0;
for (const c of cases) {
  const tok = await devlogin(c.id);
  if (!tok) { console.log(`✗ ${c.name} 登录失败`); fail++; continue; }
  for (const [path, expect, desc] of c.checks) {
    const got = await call(tok, path);
    const ok = got === expect;
    if (!ok) fail++;
    console.log(`${ok ? '✓' : '✗'} ${c.name} ${path} -> ${got} (期望 ${expect}) ${desc}`);
  }
}
console.log(fail === 0 ? '\n=== 全部通过 ===' : `\n=== ${fail} 项不符 ===`);
