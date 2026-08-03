// 太空字节项目管理 · 全栈后端
// 飞书免登 → 服务端会话 → Bearer 鉴权 → 业务 API（含 RBAC）
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');

const app = express();
app.use(express.json());

const FS_API = 'https://open.feishu.cn/open-apis';

/* ---------------- 飞书登录辅助 ---------------- */
async function getAppAccessToken() {
  const r = await fetch(FS_API + '/auth/v3/app_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.FEISHU_APP_ID, app_secret: cfg.FEISHU_APP_SECRET })
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error('app_access_token failed: ' + d.msg);
  return d.app_access_token;
}

async function code2session(code, appToken) {
  const r = await fetch(FS_API + '/authen/v1/oidc/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + appToken },
    body: JSON.stringify({ grant_type: 'authorization_code', code: code })
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error('code2session failed: ' + d.msg);
  return d.data; // { access_token, open_id, user_id(employee_id), ... }
}

async function getUserName(accessToken, openId) {
  try {
    const r = await fetch(FS_API + '/contact/v3/users/' + openId + '?user_id_type=open_id', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    const d = await r.json();
    if (d.code === 0 && d.data && d.data.user) return d.data.user.name || openId;
  } catch (e) { /* 忽略，回退 open_id */ }
  return openId;
}

/* ---------------- 会话令牌（HMAC 签名，无状态） ---------------- */
function signToken(user) {
  const payload = Buffer.from(JSON.stringify({
    uid: user.id, oid: user.open_id, nm: user.name, rl: user.role, exp: Date.now() + 7 * 864e5
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', cfg.SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', cfg.SESSION_SECRET).update(payload).digest('base64url');
  if (sig !== expect) return null;
  let p; try { p = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch (e) { return null; }
  if (!p.exp || p.exp < Date.now()) return null;
  return p;
}

/* ---------------- 鉴权中间件 ---------------- */
function auth(req, res, next) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  const p = m ? verifyToken(m[1]) : null;
  if (!p) return res.status(401).json({ error: '未登录或登录已过期' });
  req.user = { id: p.uid, open_id: p.oid, name: p.nm, role: p.rl };
  next();
}

/* ---------------- RBAC ---------------- */
function projectById(id) { return db.prepare('SELECT * FROM projects WHERE id=?').get(id); }
function taskById(id) { return db.prepare('SELECT * FROM tasks WHERE id=?').get(id); }
function reportById(id) { return db.prepare('SELECT * FROM reports WHERE id=?').get(id); }

function canEditProject(u, p) { return u.role === 'admin' || (p && p.pm === u.open_id); }
function canDeleteProject(u) { return u.role === 'admin'; } // 仅管理员可删项目
function canEditTask(u, t, p) {
  return u.role === 'admin' || (t && t.owner === u.open_id) || (p && p.pm === u.open_id);
}
function canEditReport(u, r) { return u.role === 'admin' || (r && r.author === u.open_id); }

/* ---------------- 审批流 ---------------- */
function approvalTemplate(p) {
  const t = cfg.APPROVAL_TEMPLATES;
  return (p && t[p.type]) || t['_default'] || ['pm', 'tl'];
}
// 当前审批步骤对应的角色；不在审批中返回 null
function currentApproverRole(p) {
  if (!p || p.status !== '审批中') return null;
  const tpl = approvalTemplate(p);
  const step = (p.approval_step === undefined || p.approval_step === null) ? -1 : p.approval_step;
  if (step < 0 || step >= tpl.length) return null;
  return tpl[step];
}
// 某角色下的全部用户（用于“当前待谁审批”展示）
function usersByRole(role) {
  return db.prepare('SELECT open_id,name,role FROM users WHERE role=? ORDER BY name').all(role);
}
// 是否有权审批当前步骤：角色匹配，或管理员可兜底（防死锁）
function canApproveStep(u, p) {
  const role = currentApproverRole(p);
  if (!role) return false;
  return u.role === 'admin' || u.role === role;
}

/* ---------------- 用户 upsert ---------------- */
function upsertUser(openId, employeeId, name) {
  const exist = db.prepare('SELECT * FROM users WHERE open_id=?').get(openId);
  if (exist) {
    if (name && name !== exist.name) db.prepare('UPDATE users SET name=? WHERE open_id=?').run(name, openId);
    return db.prepare('SELECT * FROM users WHERE open_id=?').get(openId);
  }
  // 角色判定：配置的管理员 open_id，或首名用户（引导员）
  const adminSet = cfg.ADMIN_OPEN_IDS;
  const isAdmin = adminSet.includes(openId) || db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  const role = isAdmin ? 'admin' : 'member';
  const info = { open_id: openId, employee_id: employeeId || '', name: name || openId, role: role, created_at: new Date().toISOString() };
  db.prepare('INSERT INTO users (open_id, employee_id, name, role, created_at) VALUES (@open_id,@employee_id,@name,@role,@created_at)').run(info);
  return db.prepare('SELECT * FROM users WHERE open_id=?').get(openId);
}

/* ---------------- 登录接口 ---------------- */
app.post('/api/login', async (req, res) => {
  try {
    if (!cfg.FEISHU_APP_ID) return res.status(400).json({ error: '服务端未配置飞书凭证，请使用开发登录' });
    const code = (req.body && req.body.code) || '';
    if (!code) return res.status(400).json({ error: '缺少 auth code' });
    const appToken = await getAppAccessToken();
    const sess = await code2session(code, appToken);
    const name = await getUserName(sess.access_token, sess.open_id);
    const user = upsertUser(sess.open_id, sess.user_id, name);
    res.json({ token: signToken(user), user: { id: user.id, name: user.name, role: user.role, open_id: user.open_id } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 开发登录：未配置飞书凭证时使用，便于本地联调
app.post('/api/devlogin', (req, res) => {
  if (cfg.FEISHU_APP_ID) return res.status(403).json({ error: '已配置飞书凭证，请使用飞书登录' });
  const name = (req.body && req.body.name) || '开发用户';
  const validRoles = Object.keys(cfg.ROLES);
  const user = upsertUser('dev_' + name, '', name);
  // 未显式指定角色时，沿用 upsertUser 的判定（首名用户自动为 admin）
  const role = (req.body && validRoles.indexOf(req.body.role) >= 0) ? req.body.role : user.role;
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, user.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  res.json({ token: signToken(u), user: { id: u.id, name: u.name, role: u.role, open_id: u.open_id } });
});

// 管理员分配用户角色（生产环境用于把同事设为 PM / TL / 管理层等）
app.put('/api/users/:id/role', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可分配角色' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.id === req.user.id) return res.status(403).json({ error: '不能修改自己的角色' });
  const validRoles = Object.keys(cfg.ROLES);
  const role = (req.body && validRoles.indexOf(req.body.role) >= 0) ? req.body.role : 'member';
  if (u.role === 'admin' && role !== 'admin') {
    const remain = db.prepare('SELECT COUNT(*) c FROM users WHERE role=? AND id!=?').get('admin', u.id).c;
    if (remain === 0) return res.status(403).json({ error: '至少需要保留一名管理员' });
  }
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, u.id);
  res.json({ ok: true, user: db.prepare('SELECT id,open_id,name,role FROM users WHERE id=?').get(u.id) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: req.user });
});

// 返回飞书 App ID（非敏感，供前端调用 tt.requestAuthCode）
app.get('/api/appid', (req, res) => {
  res.json({ appId: cfg.FEISHU_APP_ID });
});

app.get('/api/users', auth, (req, res) => {
  const rows = db.prepare('SELECT id, open_id, name, role FROM users ORDER BY name').all();
  res.json(rows);
});

// 审批配置（审批模板 + 角色名），前端据此渲染审批链与按钮权限
app.get('/api/approval-config', auth, (req, res) => {
  res.json({ templates: cfg.APPROVAL_TEMPLATES, roles: cfg.ROLES });
});

/* ---------------- 项目 ---------------- */
app.get('/api/projects', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  rows.forEach(function (r) { try { r.goal = JSON.parse(r.goal || 'null'); } catch (e) { r.goal = null; } });
  res.json(rows);
});

app.get('/api/projects/:id', auth, (req, res) => {
  const r = projectById(req.params.id);
  if (!r) return res.status(404).json({ error: '项目不存在' });
  try { r.goal = JSON.parse(r.goal || 'null'); } catch (e) { r.goal = null; }
  res.json(r);
});

app.post('/api/projects', auth, (req, res) => {
  const b = req.body || {};
  const id = 'P' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const now = new Date().toISOString();
  const goal = b.goal ? JSON.stringify(b.goal) : null;
  db.prepare(`INSERT INTO projects (id,code,name,type,customer,amount,background,goal,status,pm,approved_by,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, b.code || '', b.name || '未命名项目', b.type || '', b.customer || '', b.amount || '',
    b.background || '', goal, b.status || '草稿', b.pm || req.user.open_id,
    b.approved_by || '', req.user.open_id, now, now);
  res.json(projectById(id));
});

app.put('/api/projects/:id', auth, (req, res) => {
  const p = projectById(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (!canEditProject(req.user, p)) return res.status(403).json({ error: '仅项目负责人或管理员可编辑' });
  const b = req.body || {};
  const goal = b.goal !== undefined ? JSON.stringify(b.goal) : p.goal;
  db.prepare(`UPDATE projects SET code=?,name=?,type=?,customer=?,amount=?,background=?,goal=?,status=?,pm=?,approved_by=?,updated_at=? WHERE id=?`)
    .run(b.code !== undefined ? b.code : p.code, b.name !== undefined ? b.name : p.name,
      b.type !== undefined ? b.type : p.type, b.customer !== undefined ? b.customer : p.customer,
      b.amount !== undefined ? b.amount : p.amount, b.background !== undefined ? b.background : p.background,
      goal, b.status !== undefined ? b.status : p.status, b.pm !== undefined ? b.pm : p.pm,
      b.approved_by !== undefined ? b.approved_by : p.approved_by, new Date().toISOString(), req.params.id);
  res.json(projectById(req.params.id));
});

app.delete('/api/projects/:id', auth, (req, res) => {
  if (!canDeleteProject(req.user)) return res.status(403).json({ error: '仅管理员可删除项目' });
  const p = projectById(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------------- 审批流接口 ---------------- */
function approvalView(p) {
  const tpl = approvalTemplate(p);
  const step = (p.approval_step === undefined || p.approval_step === null) ? -1 : p.approval_step;
  const curRole = (p.status === '审批中' && step >= 0 && step < tpl.length) ? tpl[step] : null;
  const steps = tpl.map(function (role, i) {
    let st = 'pending'; // pending(未到) | current(待批) | approved(已批) | rejected(驳回)
    if (p.status === '已驳回') st = (i < step ? 'approved' : (i === step ? 'rejected' : 'pending'));
    else if (p.status === '已批准') st = 'approved';
    else if (p.status === '审批中') { st = i < step ? 'approved' : (i === step ? 'current' : 'pending'); }
    return { index: i, role: role, roleName: cfg.ROLES[role] || role, status: st };
  });
  const history = db.prepare('SELECT * FROM approvals WHERE project_id=? ORDER BY created_at').all(p.id);
  return {
    template: tpl,
    currentStep: step,
    currentRole: curRole,
    currentRoleName: curRole ? (cfg.ROLES[curRole] || curRole) : null,
    approvers: curRole ? usersByRole(curRole).map(function (u) { return { open_id: u.open_id, name: u.name }; }) : [],
    steps: steps,
    history: history
  };
}

app.get('/api/projects/:id/approval', auth, (req, res) => {
  const p = projectById(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  res.json(approvalView(p));
});

app.post('/api/projects/:id/submit', auth, (req, res) => {
  const p = projectById(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (!canEditProject(req.user, p)) return res.status(403).json({ error: '仅项目负责人或管理员可提交审批' });
  if (p.status !== '草稿' && p.status !== '已驳回') return res.status(400).json({ error: '仅草稿/已驳回状态可提交审批' });
  const tpl = approvalTemplate(p);
  db.prepare('UPDATE projects SET status=?, approval_step=?, updated_at=? WHERE id=?')
    .run('审批中', 0, new Date().toISOString(), p.id);
  db.prepare('INSERT INTO approvals (id,project_id,step_index,step_role,approver_open_id,approver_name,action,comment,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('A' + Date.now().toString(36), p.id, -1, tpl[0], req.user.open_id, req.user.name, 'submit', '', new Date().toISOString());
  res.json(approvalView(projectById(p.id)));
});

app.post('/api/projects/:id/approve', auth, (req, res) => {
  const p = projectById(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (!canApproveStep(req.user, p)) return res.status(403).json({ error: '当前步骤无需您审批（或您无权限）' });
  const tpl = approvalTemplate(p);
  const step = p.approval_step;
  const role = tpl[step];
  const comment = (req.body && req.body.comment) || '';
  db.prepare('INSERT INTO approvals (id,project_id,step_index,step_role,approver_open_id,approver_name,action,comment,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('A' + Date.now().toString(36), p.id, step, role, req.user.open_id, req.user.name, 'approve', comment, new Date().toISOString());
  if (step + 1 >= tpl.length) {
    db.prepare('UPDATE projects SET status=?, approval_step=?, updated_at=? WHERE id=?')
      .run('已批准', tpl.length, new Date().toISOString(), p.id);
  } else {
    db.prepare('UPDATE projects SET approval_step=?, updated_at=? WHERE id=?')
      .run(step + 1, new Date().toISOString(), p.id);
  }
  res.json(approvalView(projectById(p.id)));
});

app.post('/api/projects/:id/reject', auth, (req, res) => {
  const p = projectById(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (!canApproveStep(req.user, p)) return res.status(403).json({ error: '当前步骤无需您审批（或您无权限）' });
  const tpl = approvalTemplate(p);
  const step = p.approval_step;
  const role = tpl[step];
  const comment = (req.body && req.body.comment) || '';
  db.prepare('INSERT INTO approvals (id,project_id,step_index,step_role,approver_open_id,approver_name,action,comment,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('A' + Date.now().toString(36), p.id, step, role, req.user.open_id, req.user.name, 'reject', comment, new Date().toISOString());
  db.prepare('UPDATE projects SET status=?, approval_step=?, updated_at=? WHERE id=?')
    .run('已驳回', -1, new Date().toISOString(), p.id);
  res.json(approvalView(projectById(p.id)));
});

/* ---------------- 里程碑 ---------------- */
app.get('/api/milestones', auth, (req, res) => {
  let rows;
  if (req.query.projectId) rows = db.prepare('SELECT * FROM milestones WHERE project_id=? ORDER BY due').all(req.query.projectId);
  else rows = db.prepare('SELECT * FROM milestones ORDER BY due').all();
  res.json(rows);
});

app.post('/api/milestones', auth, (req, res) => {
  const b = req.body || {};
  const p = projectById(b.project_id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (!canEditProject(req.user, p)) return res.status(403).json({ error: '仅项目负责人或管理员可管理里程碑' });
  const id = 'M' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  db.prepare('INSERT INTO milestones (id,project_id,name,due,done,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, b.project_id, b.name || '里程碑', b.due || '', b.done ? 1 : 0, new Date().toISOString());
  res.json(db.prepare('SELECT * FROM milestones WHERE id=?').get(id));
});

app.put('/api/milestones/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM milestones WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '里程碑不存在' });
  const p = projectById(m.project_id);
  if (!canEditProject(req.user, p)) return res.status(403).json({ error: '仅项目负责人或管理员可管理里程碑' });
  const b = req.body || {};
  db.prepare('UPDATE milestones SET name=?,due=?,done=? WHERE id=?')
    .run(b.name !== undefined ? b.name : m.name, b.due !== undefined ? b.due : m.due,
      b.done !== undefined ? (b.done ? 1 : 0) : m.done, req.params.id);
  res.json(db.prepare('SELECT * FROM milestones WHERE id=?').get(req.params.id));
});

app.delete('/api/milestones/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM milestones WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '里程碑不存在' });
  const p = projectById(m.project_id);
  if (!canEditProject(req.user, p)) return res.status(403).json({ error: '仅项目负责人或管理员可管理里程碑' });
  db.prepare('DELETE FROM milestones WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------------- 任务 ---------------- */
app.get('/api/tasks', auth, (req, res) => {
  let rows;
  if (req.query.projectId) rows = db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY due').all(req.query.projectId);
  else rows = db.prepare('SELECT * FROM tasks ORDER BY due').all();
  res.json(rows);
});

app.post('/api/tasks', auth, (req, res) => {
  const b = req.body || {};
  const p = projectById(b.project_id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const id = 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  db.prepare(`INSERT INTO tasks (id,project_id,ms_id,code,name,owner,est,start,due,status,progress,crit,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, b.project_id, b.ms_id || null, b.code || '', b.name || '', b.owner || req.user.open_id,
    b.est || '', b.start || '', b.due || '', b.status || '待开始',
    b.progress || 0, b.crit ? 1 : 0, new Date().toISOString());
  res.json(taskById(id));
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const t = taskById(req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  const p = projectById(t.project_id);
  if (!canEditTask(req.user, t, p)) return res.status(403).json({ error: '仅任务负责人、项目负责人或管理员可编辑' });
  const b = req.body || {};
  db.prepare(`UPDATE tasks SET ms_id=?,code=?,name=?,owner=?,est=?,start=?,due=?,status=?,progress=?,crit=? WHERE id=?`)
    .run(b.ms_id !== undefined ? (b.ms_id || null) : t.ms_id, b.code !== undefined ? b.code : t.code,
      b.name !== undefined ? b.name : t.name, b.owner !== undefined ? b.owner : t.owner, b.est !== undefined ? b.est : t.est,
      b.start !== undefined ? b.start : t.start, b.due !== undefined ? b.due : t.due,
      b.status !== undefined ? b.status : t.status, b.progress !== undefined ? b.progress : t.progress,
      b.crit !== undefined ? (b.crit ? 1 : 0) : t.crit, req.params.id);
  res.json(taskById(req.params.id));
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  const t = taskById(req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  const p = projectById(t.project_id);
  if (!canEditTask(req.user, t, p)) return res.status(403).json({ error: '仅任务负责人、项目负责人或管理员可删除' });
  db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------------- 周报 ---------------- */
function reportWithTasks(id) {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(id);
  if (!r) return null;
  try { r.snap = JSON.parse(r.snap || 'null'); } catch (e) { r.snap = null; }
  r.tasks = db.prepare(`SELECT t.id,t.code,t.name,t.progress FROM tasks t
    JOIN report_tasks rt ON t.id=rt.task_id WHERE rt.report_id=? ORDER BY t.code`).all(id);
  return r;
}

app.get('/api/reports', auth, (req, res) => {
  let rows;
  if (req.query.projectId) rows = db.prepare('SELECT * FROM reports WHERE project_id=? ORDER BY created_at DESC').all(req.query.projectId);
  else rows = db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
  rows.forEach(function (r) { r = Object.assign(r, reportWithTasks(r.id)); });
  res.json(rows);
});

function saveReportLinks(reportId, taskIds) {
  db.prepare('DELETE FROM report_tasks WHERE report_id=?').run(reportId);
  (taskIds || []).forEach(function (tid) {
    db.prepare('INSERT OR IGNORE INTO report_tasks (report_id,task_id) VALUES (?,?)').run(reportId, tid);
  });
}

app.post('/api/reports', auth, (req, res) => {
  const b = req.body || {};
  const p = projectById(b.project_id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const id = 'R' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const snap = b.snap ? JSON.stringify(b.snap) : null;
  db.prepare(`INSERT INTO reports (id,project_id,week,author,done,plan,risk,risk_due,res,snap,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, b.project_id, b.week || '', req.user.open_id, b.done || '', b.plan || '',
    b.risk || '', b.risk_due || '', b.res || '', snap, new Date().toISOString());
  saveReportLinks(id, b.taskIds);
  res.json(reportWithTasks(id));
});

app.put('/api/reports/:id', auth, (req, res) => {
  const r = reportById(req.params.id);
  if (!r) return res.status(404).json({ error: '周报不存在' });
  if (!canEditReport(req.user, r)) return res.status(403).json({ error: '仅报告人或管理员可编辑' });
  const b = req.body || {};
  const snap = b.snap !== undefined ? JSON.stringify(b.snap) : r.snap;
  db.prepare(`UPDATE reports SET week=?,done=?,plan=?,risk=?,risk_due=?,res=?,snap=? WHERE id=?`)
    .run(b.week !== undefined ? b.week : r.week, b.done !== undefined ? b.done : r.done,
      b.plan !== undefined ? b.plan : r.plan, b.risk !== undefined ? b.risk : r.risk,
      b.risk_due !== undefined ? b.risk_due : r.risk_due, b.res !== undefined ? b.res : r.res,
      snap, req.params.id);
  if (b.taskIds) saveReportLinks(req.params.id, b.taskIds);
  res.json(reportWithTasks(req.params.id));
});

app.delete('/api/reports/:id', auth, (req, res) => {
  const r = reportById(req.params.id);
  if (!r) return res.status(404).json({ error: '周报不存在' });
  if (!canEditReport(req.user, r)) return res.status(403).json({ error: '仅报告人或管理员可删除' });
  db.prepare('DELETE FROM reports WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 某任务关联的周报（任务卡抽屉用）
app.get('/api/tasks/:id/reports', auth, (req, res) => {
  const rows = db.prepare(`SELECT r.* FROM reports r JOIN report_tasks rt ON r.id=rt.report_id
    WHERE rt.task_id=? ORDER BY r.created_at DESC`).all(req.params.id);
  rows.forEach(function (r) { try { r.snap = JSON.parse(r.snap || 'null'); } catch (e) { r.snap = null; } });
  res.json(rows);
});

/* ---------------- 数据看板聚合 ---------------- */
app.get('/api/dashboard', auth, (req, res) => {
  const projects = db.prepare('SELECT * FROM projects').all();
  const tasks = db.prepare('SELECT * FROM tasks').all();
  const reports = db.prepare('SELECT * FROM reports').all();
  const milestones = db.prepare('SELECT * FROM milestones').all();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const byStatus = {};
  projects.forEach(function (p) { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
  const totalTasks = tasks.length;
  const doneTasks = tasks.filter(function (t) { return t.status === '完成'; }).length;
  const overdue = tasks.filter(function (t) {
    return t.status !== '完成' && t.due && new Date(t.due) < today;
  }).length;
  const msTotal = milestones.length;
  const msDone = milestones.filter(function (m) { return m.done === 1; }).length;
  res.json({
    totalProjects: projects.length,
    byStatus: byStatus,
    totalTasks: totalTasks,
    doneTasks: doneTasks,
    taskCompletion: totalTasks ? Math.round(doneTasks / totalTasks * 100) : 0,
    overdueTasks: overdue,
    totalReports: reports.length,
    milestoneCompletion: msTotal ? Math.round(msDone / msTotal * 100) : 0,
    totalMilestones: msTotal
  });
});

/* ---------------- 静态前端 ---------------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(cfg.PORT, () => {
  console.log('[PM] 服务已启动: http://localhost:' + cfg.PORT);
  console.log('[PM] 飞书凭证: ' + (cfg.FEISHU_APP_ID ? '已配置' : '未配置(开发登录模式)'));
});
