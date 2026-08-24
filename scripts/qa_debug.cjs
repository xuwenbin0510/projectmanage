const fs = require('fs');
const path = require('path');
const PM_DIR = 'C:/Users/xuwen/WorkBuddy/AstrBytes/pm-app';
const out = [];
const Database = require('better-sqlite3');
const db = new Database(path.join(PM_DIR, 'pm.db'));
db.pragma('busy_timeout = 8000');
const reportSvc = require(path.join(PM_DIR, 'server/services/report.service.js'));
const PID = 'Pmslkpu9a00dx';

// 本地复刻（用 String() 等价 toStr）
function myResolve(db, projectId, authorOpenId) {
  const pid = String(projectId).trim();
  const author = String(authorOpenId).trim();
  const result = new Set();
  if (!pid) return result;
  const pmRows = db.prepare("SELECT user_open_id FROM project_members WHERE project_id = ? AND project_role = 'pm'").all(pid);
  const pmSet = new Set(pmRows.map(function (r) { return String(r.user_open_id); }).filter(Boolean));
  const authorIsPm = author && pmSet.has(author);
  if (authorIsPm || pmSet.size === 0) {
    const tlRows = db.prepare("SELECT user_open_id FROM project_members WHERE project_id = ? AND project_role = 'tl'").all(pid);
    tlRows.forEach(function (r) { const v = String(r.user_open_id); if (v) result.add(v); });
    const adminRows = db.prepare("SELECT open_id FROM users WHERE global_role = 'admin'").all();
    adminRows.forEach(function (r) { const v = String(r.open_id); if (v) result.add(v); });
  } else {
    pmSet.forEach(function (v) { result.add(v); });
  }
  if (author) result.delete(author);
  return result;
}

const reps = db.prepare("SELECT id, author_open_id FROM work_reports WHERE project_id = ? AND status = '已提交'").all(PID);
out.push('reps.count=' + reps.length);
reps.slice(0, 1).forEach(function (r) {
  out.push('report=' + r.id + ' author=' + r.author_open_id);
  const real = reportSvc.resolveConfirmers(db, r.project_id, r.author_open_id);
  out.push('  REAL  -> ' + JSON.stringify(Array.from(real)));
  const mine = myResolve(db, r.project_id, r.author_open_id);
  out.push('  MINE  -> ' + JSON.stringify(Array.from(mine)));
});

fs.writeFileSync(path.join(PM_DIR, 'scripts/qa_debug.log'), out.join('\n'));
db.close();
