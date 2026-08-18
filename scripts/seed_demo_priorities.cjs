/**
 * seed_demo_priorities.cjs — 为演示项目注入 P0/P1/P2/P3 优先级分布（幂等，可重跑）
 * 规则（确定性，重跑结果一致）：
 *   按 wbs_code 排序叶子节点：
 *   - 叶子 >= 6：第1个=P0，第2~3个=P1，最后2个=P3，其余=P2
 *   - 叶子 3~5 ：第1个=P0，第2个=P1，最后1个=P3，其余=P2
 *   - 叶子 < 3 ：全部保持 P2（不强制）
 * 只改本地 pm.db 的 wbs_nodes.priority，不动源码、不动其他表。
 */
const path = require('path');
const db = require('better-sqlite3')(path.join(__dirname, '..', 'pm.db'));

const projects = db.prepare("SELECT id, name FROM projects WHERE status='进行中' ORDER BY id").all();
const tx = db.transaction(() => {
  let total = 0;
  for (const p of projects) {
    const leaves = db.prepare(
      "SELECT id, wbs_code, name, priority FROM wbs_nodes WHERE project_id=? AND parent_id IS NOT NULL ORDER BY wbs_code"
    ).all(p.id);
    if (leaves.length < 3) continue;
    const plan = new Map(); // id -> priority
    if (leaves.length >= 6) {
      plan.set(leaves[0].id, 'P0');
      plan.set(leaves[1].id, 'P1');
      plan.set(leaves[2].id, 'P1');
      plan.set(leaves[leaves.length - 2].id, 'P3');
      plan.set(leaves[leaves.length - 1].id, 'P3');
    } else {
      plan.set(leaves[0].id, 'P0');
      plan.set(leaves[1].id, 'P1');
      plan.set(leaves[leaves.length - 1].id, 'P3');
    }
    const upd = db.prepare('UPDATE wbs_nodes SET priority=? WHERE id=?');
    let n = 0;
    for (const [id, pr] of plan) { upd.run(pr, id); n++; }
    total += n;
    const dist = {};
    db.prepare("SELECT priority, COUNT(*) c FROM wbs_nodes WHERE project_id=? AND parent_id IS NOT NULL GROUP BY priority")
      .all(p.id).forEach(r => dist[r.priority] = r.c);
    console.log(p.id, '叶子=' + leaves.length, '更新=' + n, '分布=' + JSON.stringify(dist));
  }
  return total;
});
const n = tx();
console.log('done, updated', n, 'nodes');
