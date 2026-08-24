/**
 * 把库里 users.open_id 从「旧飞书应用体系」替换为「新应用 cli_aa00088f1338dd2d 体系」。
 *
 * 背景：飞书同一租户下不同应用对同一个人返回不同 open_id（设计如此）。
 * 库里 12 个 open_id 来自旧应用，新应用登录会拿到新 open_id，
 * 不替换会导致飞书登录建出重复幽灵账号。本脚本按「姓名」匹配通讯录，
 * 把 users.open_id 改为新 open_id，并回填真实 email。
 *
 * 前提：新应用已在飞书后台发布并通过管理员审核，通讯录可见范围=全部成员。
 *
 * 用法：
 *   node scripts/remap-openid.js --dry      # 只预览，不改库
 *   node scripts/remap-openid.js --apply    # 真正执行 UPDATE
 */
const path = require('path');
const Database = require('better-sqlite3');
const { getAppAccessToken } = require('../server/lib/feishu');
const FS_API = 'https://open.feishu.cn/open-apis';

const mode = process.argv.includes('--apply') ? 'apply' : 'dry';
const dbPath = path.join(__dirname, '..', 'pm.db');

async function listContactUsers(at) {
  const items = [];
  let pageToken = '';
  do {
    const url =
      FS_API + '/contact/v3/users?page_size=50&user_id_type=open_id' +
      (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + at } });
    const d = await r.json();
    if (d.code !== 0) throw new Error('拉通讯录失败: ' + d.msg);
    items.push(...(d.data.items || []));
    pageToken = d.data.page_token && d.data.has_more ? d.data.page_token : '';
  } while (pageToken);
  return items;
}

(async () => {
  const at = await getAppAccessToken();
  const contact = await listContactUsers(at);
  console.log('[通讯录] 新应用可见人数:', contact.length);

  const db = new Database(dbPath);
  const local = db.prepare('SELECT id, open_id, name, email FROM users ORDER BY id').all();

  const plan = [];
  for (const u of local) {
    const hit = contact.find((c) => c.name === u.name);
    if (hit) {
      plan.push({
        id: u.id,
        name: u.name,
        oldOpenId: u.open_id,
        newOpenId: hit.open_id,
        newEmail: hit.email || u.email,
      });
    } else {
      console.log('⚠️ 通讯录找不到:', u.name, '（未替换，保留旧 open_id）');
    }
  }

  console.log('\n=== 替换预览 (' + (mode === 'apply' ? '执行' : 'dry-run') + ') ===');
  plan.forEach((p) => {
    console.log(
      (mode === 'apply' ? '🔄' : '👁 '),
      p.name,
      '|', p.oldOpenId.slice(0, 12) + '... →', p.newOpenId,
      '| email:', p.newEmail || '(无)'
    );
  });

  if (mode === 'apply') {
    const upd = db.prepare('UPDATE users SET open_id = ?, email = ?, updated_at = ? WHERE id = ?');
    const tx = db.transaction((rows) => {
      let n = 0;
      for (const p of rows) {
        n += upd.run(p.newOpenId, p.newEmail, new Date().toISOString(), p.id).changes;
      }
      return n;
    });
    const n = tx(plan);
    console.log('\n✅ 已更新', n, '位用户的 open_id + email');
  } else {
    console.log('\n（dry-run 未改库。确认无误后执行: node scripts/remap-openid.js --apply）');
  }
  db.close();
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
