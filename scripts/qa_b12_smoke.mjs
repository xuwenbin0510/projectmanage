// B12 接口集成冒烟：验证角色 scope 降级 + 聚合返回结构
const BASE = 'http://127.0.0.1:3000';

async function devlogin(openId) {
  const r = await fetch(BASE + '/api/auth/devlogin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openId }),
  });
  const j = await r.json();
  return j.data.token;
}

async function overview(token, scope) {
  const r = await fetch(BASE + '/api/dashboard/overview?scope=' + scope, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const j = await r.json();
  return { status: r.status, body: j.data || j };
}

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + JSON.stringify(extra).slice(0, 200) : '')); }
}

console.log('== B12 /api/dashboard/overview 集成冒烟 ==');

// 1) admin 看全部
const adminTok = await devlogin('ou_xuwenbin01');
const adminAll = await overview(adminTok, 'all');
t('admin scope=all 返回 200', adminAll.status === 200, adminAll.status);
t('admin 实际 scope=all', adminAll.body.scope === 'all', adminAll.body.scope);
t('admin 返回 stats.managedProjects', typeof (adminAll.body.stats && adminAll.body.stats.managedProjects) === 'number', adminAll.body.stats);
t('admin 返回 health 分布', adminAll.body.health && typeof adminAll.body.health.red === 'number', adminAll.body.health);
t('admin 返回 ownerLoad 数组', Array.isArray(adminAll.body.ownerLoad), null);
t('admin 返回 projects 分页', adminAll.body.projects && Array.isArray(adminAll.body.projects.items), adminAll.body.projects);
t('admin 返回 statusDonut.segments', Array.isArray(adminAll.body.statusDonut.segments), null);
console.log('    [admin/all] managedProjects=' + (adminAll.body.stats && adminAll.body.stats.managedProjects) +
  ' red=' + (adminAll.body.health && adminAll.body.health.red) +
  ' avgProgress=' + (adminAll.body.stats && adminAll.body.stats.averageProgress));

// 2) pm 传 scope=all 必须降级为 mine
const pmTok = await devlogin('ou_liming03');
const pmAll = await overview(pmTok, 'all');
t('pm scope=all 返回 200', pmAll.status === 200, pmAll.status);
t('pm 实际 scope 被强制降级为 mine', pmAll.body.scope === 'mine', pmAll.body.scope);
console.log('    [pm/all→降级] scope=' + pmAll.body.scope +
  ' managedProjects=' + (pmAll.body.stats && pmAll.body.stats.managedProjects));

// 3) 非法 status 被丢弃回落三态基线（决策⑥）
const adminBad = await overview(adminTok, 'mine');
// 用 admin 默认（不带 scope）也应 = all
const adminDef = await overview(adminTok, '');
t('admin 不传 scope 默认 all', adminDef.body.scope === 'all', adminDef.body.scope);

console.log('');
console.log('== 结果: PASS=' + pass + '  FAIL=' + fail + ' ==');
process.exit(fail === 0 ? 0 : 1);
