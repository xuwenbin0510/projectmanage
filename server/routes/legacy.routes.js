/**
 * 旧路由兼容层（决策 D-9：**批次 1 保留不删**）
 *
 * 为什么保留：
 *  - `devcheck.js` / `test_runner.js` 仍在打这些老接口，一次性删掉会让自检全红，
 *    掩盖真正的回归；按批次逐步迁走更安全。
 *  - 老接口返回的是**裸 JSON**（`{error}` / 数组 / 对象），不是新契约的 `{code,data,message}` 信封。
 *    这是刻意的：老脚本按裸结构解析，包上信封反而更早炸。
 *
 * 迁移路线（设计方案 §3.10）：
 *  | 旧路由 | 去向 | 批次 |
 *  |---|---|---|
 *  | `POST /api/login`                | → `/api/auth/feishu`          | 4 |
 *  | `POST /api/devlogin`             | **已直接改造**（入参 `{openId}`）| 1 |
 *  | `GET  /api/me`                   | → `/api/auth/me`（老形态 `{user}`）| 4 |
 *  | `GET  /api/users` `PUT /api/users/:id/role` | → `/api/admin/users` | 4 |
 *  | `GET  /api/approval-config`      | → `/api/meta`                 | 4 |
 *  | 老 milestones / tasks / reports  | → 新嵌套式路由                 | 3 / 4 |
 *  | `GET  /api/dashboard`            | 保留（前端不消费，不冲突）      | — |
 *  | `DELETE /api/projects/:id`       | 保留（新契约无此方法，不冲突）  | — |
 *
 * ⚠ 本路由必须挂在**新路由与降级桩之后**：路径重叠时（如 `DELETE /api/milestones/:id`）
 *   由新契约优先接管，老实现只兜住新契约没覆盖的方法（如 `PUT`）。
 * ⚠ 全站禁用 PUT 的约束针对**新契约**；这里的 `PUT` 是待淘汰的历史包袱，随批次 3/4 一并删除。
 *
 * @deprecated 整个文件将在批次 4 结束后删除。
 */

const express = require('express');

const cfg = require('../../config');
const db = require('../../db');
const { requireAuth } = require('../middleware/auth');
const { signToken } = require('../lib/token');
const { nowIso } = require('../lib/dates');
const { genId } = require('../lib/ids');
const feishu = require('../lib/feishu');

const router = express.Router();

/** 启动时打印一次的弃用清单（提醒后续批次清理） */
const DEPRECATED_ROUTES = [
  'POST   /api/login              → POST /api/auth/feishu        (批次4 删除)',
  'POST   /api/devlogin           → POST /api/auth/devlogin      (兼容 {openId} 与老 {name,role})',
  'GET    /api/me                 → GET  /api/auth/me            (批次4 删除)',
  'GET    /api/users              → GET  /api/admin/users        (批次4 删除)',
  'PUT    /api/users/:id/role     → PATCH /api/admin/users/:openId (批次4 删除)',
  'GET    /api/approval-config    → GET  /api/meta               (批次4 删除)',
  'PUT    /api/projects/:id       → PATCH /api/projects/:id      (批次3 删除)',
  'GET/POST/PUT /api/milestones   → 新嵌套式里程碑路由            (批次3 删除)',
  'GET/POST/PUT/DELETE /api/tasks → /api/wbs                     (批次3 删除)',
  'GET/POST/PUT/DELETE /api/reports → 新嵌套式周报路由            (批次4 删除)',
];

/**
 * 打印弃用路由清单（server.js 启动时调用一次）。
 * @returns {void}
 */
function warnDeprecated() {
  console.warn('[legacy] 以下旧路由仍在提供服务，将按批次逐步下线：');
  DEPRECATED_ROUTES.forEach(function (line) { console.warn('[legacy]   ' + line); });
}

/* ── 老实现依赖的小工具 ─────────────────────────────── */

/**
 * 老 `type` 值（中文）→ 新枚举 A/B/C。
 * @param {*} raw
 * @returns {'A'|'B'|'C'}
 */
function normalizeType(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (s === 'A' || s === 'B' || s === 'C') return s;
  if (s.indexOf('A') === 0) return 'A';
  if (s.indexOf('C') === 0) return 'C';
  return 'B';
}

/**
 * 项目行（老形态：goal 解析为对象）。
 * @param {string} id
 * @returns {object|null}
 */
function projectById(id) {
  const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(String(id || ''));
  if (!r) return null;
  try { r.goal = JSON.parse(r.goal || 'null'); } catch (e) { r.goal = null; }
  return r;
}

/**
 * 项目的审批模板（按 A/B/C key 取，缺省走 `_default`）。
 * @param {object} p projects 行
 * @returns {string[]}
 */
function approvalTemplate(p) {
  const key = normalizeType(p && p.type);
  return cfg.APPROVAL_TEMPLATES[key] || cfg.APPROVAL_TEMPLATES._default;
}

/**
 * 按全局角色取用户。
 * @param {string} role
 * @returns {Array<object>}
 */
/**
 * 取用户全部全局职位（主职位 users.global_role + 额外职位 user_roles，合并去重）。
 * 与 rbac.globalRolesOf / auth.resolveGlobalRoles 语义一致：任一职位命中即通过。
 */
function mergedGlobalRoles(u) {
  if (!u) return [];
  const set = {};
  if (u.global_role) set[String(u.global_role)] = true;
  db.prepare('SELECT role_key FROM user_roles WHERE user_open_id = ?')
    .all(u.open_id)
    .forEach(function (r) { if (r.role_key) set[String(r.role_key)] = true; });
  return Object.keys(set);
}
function isAdminUser(u) {
  return mergedGlobalRoles(u).indexOf('admin') >= 0;
}

function usersByRole(role) {
  const r = String(role || '');
  return db.prepare(
    'SELECT * FROM users WHERE global_role = ? OR open_id IN (SELECT user_open_id FROM user_roles WHERE role_key = ?) ORDER BY name'
  ).all(r, r);
}

/**
 * 是否可编辑项目（项目负责人 / 创建人 / 管理员）。
 * @param {object} u users 行
 * @param {object} p projects 行
 * @returns {boolean}
 */
function canEditProject(u, p) {
  if (!u || !p) return false;
  if (isAdminUser(u)) return true;
  return p.pm === u.open_id || p.created_by === u.open_id;
}

/**
 * 当前审批步骤是否轮到该用户。
 * @param {object} u users 行
 * @param {object} p projects 行
 * @returns {boolean}
 */
function canApproveStep(u, p) {
  if (!u || !p || p.status !== '审批中') return false;
  const tpl = approvalTemplate(p);
  const step = p.approval_step;
  if (step === null || step === undefined || step < 0 || step >= tpl.length) return false;
  if (isAdminUser(u)) return true;
  return mergedGlobalRoles(u).indexOf(tpl[step]) >= 0;
}

/**
 * 审批视图（老形态）。
 * @param {object} p projects 行
 * @returns {object}
 */
function approvalView(p) {
  const tpl = approvalTemplate(p);
  const step = (p.approval_step === undefined || p.approval_step === null) ? -1 : p.approval_step;
  const curRole = (p.status === '审批中' && step >= 0 && step < tpl.length) ? tpl[step] : null;
  const steps = tpl.map(function (role, i) {
    let st = 'pending';
    if (p.status === '已驳回') st = (i < step ? 'approved' : (i === step ? 'rejected' : 'pending'));
    else if (p.status === '已批准') st = 'approved';
    else if (p.status === '审批中') st = (i < step ? 'approved' : (i === step ? 'current' : 'pending'));
    return { index: i, role: role, roleName: cfg.ROLES[role] || role, status: st };
  });
  return {
    template: tpl,
    currentStep: step,
    currentRole: curRole,
    currentRoleName: curRole ? (cfg.ROLES[curRole] || curRole) : null,
    approvers: curRole ? usersByRole(curRole).map(function (u) { return { open_id: u.open_id, name: u.name }; }) : [],
    steps: steps,
    history: db.prepare('SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at').all(p.id),
  };
}

/** 老形态用户视图（老脚本读 `user.role`，新表列名是 global_role） */
function legacyUser(u) {
  if (!u) return null;
  return { id: u.id, open_id: u.open_id, name: u.name, role: u.global_role };
}

/* ── 认证 ───────────────────────────────────────────── */

/** @deprecated 用 `POST /api/auth/feishu` */
router.post('/login', function legacyLogin(req, res) {
  const code = (req.body && req.body.code) || '';
  if (!code) return res.status(400).json({ error: '缺少 code' });
  feishu
    .getAppAccessToken()
    .then(function (appToken) { return feishu.code2session(code, appToken); })
    .then(async function (session) {
      const openId = session && session.open_id ? String(session.open_id) : '';
      if (!openId) throw new Error('飞书返回缺少 open_id');
      const ts = nowIso();
      let u = db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId);
      if (!u) {
        const name = await feishu.getUserName(session.access_token, openId);
        const role = (cfg.ADMIN_OPEN_IDS || []).indexOf(openId) >= 0 ? 'admin' : 'member';
        db.prepare(
          `INSERT INTO users (open_id, employee_id, name, email, dept, avatar_url, global_role, status, created_at, updated_at)
           VALUES (?, '', ?, '', '', '', ?, 'active', ?, ?)`,
        ).run(openId, name, role, ts, ts);
        u = db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId);
      }
      res.json({ token: signToken(u), user: legacyUser(u) });
    })
    .catch(function (e) {
      res.status(500).json({ error: '登录失败: ' + (e && e.message ? e.message : String(e)) });
    });
});

/**
 * @deprecated 用 `POST /api/auth/devlogin`。
 * ⚠ 入参语义已改造为 `{openId}`（老的 `{name, role}` 会凭空造用户，与演示账号体系冲突）。
 */
router.post('/devlogin', function legacyDevLogin(req, res) {
  if (!cfg.ALLOW_DEV_LOGIN) return res.status(403).json({ error: '当前环境已关闭免密登录' });
  const body = req.body || {};
  const openId = String(body.openId || '').trim();

  // 新入参 {openId}：只认已存在的账号（与 POST /api/auth/devlogin 同口径）
  if (openId) {
    const u = db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId);
    if (!u) return res.status(404).json({ error: '用户不存在，请从列表中选择' });
    if (u.status === 'disabled') return res.status(403).json({ error: '该账号已停用' });
    return res.json({ token: signToken(u), user: legacyUser(u) });
  }

  // 老入参 {name, role}：按姓名「查不到就建」，首个用户自动成为管理员。
  // 决策 D-9：devcheck.js / test_runner.js 仍在用这套语义，批次 1 不能让它们全红。
  // 仅在此弃用路由内保留，新契约 /api/auth/devlogin 不提供建号能力。
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name 或 openId 至少提供一个' });

  let u = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  if (!u) {
    const total = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const validRoles = Object.keys(cfg.ROLES);
    let role = validRoles.indexOf(String(body.role || '')) >= 0 ? String(body.role) : 'member';
    if (total === 0) role = 'admin'; // 引导员机制：系统第一个用户即管理员
    const ts = nowIso();
    const devOpenId = 'dev_' + genId('u');
    db.prepare(
      'INSERT INTO users (open_id, employee_id, name, email, dept, avatar_url, global_role, status, created_at, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(devOpenId, null, name, null, null, null, role, 'active', ts, ts);
    u = db.prepare('SELECT * FROM users WHERE open_id = ?').get(devOpenId);
  } else if (body.role && Object.keys(cfg.ROLES).indexOf(String(body.role)) >= 0
             && u.global_role !== String(body.role)) {
    // 老脚本靠 role 入参切换身份；已存在用户按传入角色对齐，保持旧行为
    db.prepare('UPDATE users SET global_role = ?, updated_at = ? WHERE id = ?')
      .run(String(body.role), nowIso(), u.id);
    u = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  }
  if (u.status === 'disabled') return res.status(403).json({ error: '该账号已停用' });
  res.json({ token: signToken(u), user: legacyUser(u) });
});

/** @deprecated 用 `GET /api/auth/me`（新接口直接返回 User，不裹 `{user}`） */
router.get('/me', requireAuth, function legacyMe(req, res) {
  res.json({ user: Object.assign({}, req.user, { role: req.user.global_role }) });
});

/** @deprecated 用 `GET /api/admin/users` */
router.get('/users', requireAuth, function legacyUsers(req, res) {
  res.json(db.prepare('SELECT * FROM users ORDER BY name').all().map(legacyUser));
});

/** @deprecated 用 `PATCH /api/admin/users/:openId` */
router.put('/users/:id/role', requireAuth, function legacySetRole(req, res) {
  if (!isAdminUser(req.user)) return res.status(403).json({ error: '仅管理员可分配角色' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.id === req.user.id) return res.status(403).json({ error: '不能修改自己的角色' });
  const validRoles = Object.keys(cfg.ROLES);
  const role = (req.body && validRoles.indexOf(req.body.role) >= 0) ? req.body.role : 'member';
  if (isAdminUser(u) && role !== 'admin') {
    const remain = db.prepare(
      'SELECT COUNT(*) c FROM users WHERE (global_role = ? OR open_id IN (SELECT user_open_id FROM user_roles WHERE role_key = ?)) AND id != ?'
    ).get('admin', 'admin', u.id).c;
    if (remain === 0) return res.status(403).json({ error: '至少需要保留一名管理员' });
  }
  db.prepare('UPDATE users SET global_role = ?, updated_at = ? WHERE id = ?').run(role, nowIso(), u.id);
  res.json({ ok: true, user: legacyUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

/** @deprecated 用 `GET /api/meta` */
router.get('/approval-config', requireAuth, function legacyApprovalConfig(req, res) {
  res.json({ templates: cfg.APPROVAL_TEMPLATES, roles: cfg.ROLES });
});

/* ── 项目（仅补新契约未覆盖的方法） ───────────────────── */

/* 老项目 CRUD 走 `/api/legacy/projects` 命名空间：
 * `POST/GET /api/projects` 已被新契约接管且语义完全不同（信封 + 强校验 + 成员基数）。
 * 老脚本 devcheck.js / test_runner.js 仍需要「裸 JSON + 宽松入参」的建项能力来驱动
 * 老审批流回归。与其在新契约路由里塞第二套语义（会一路污染批次 2/3），
 * 不如把老 CRUD 挪到独立命名空间，两套互不干扰。
 * 决策 D-9：批次 4 删除本文件时，这些端点与老脚本一并移除。
 */

/** @deprecated 老建项（宽松入参）。新契约用 `POST /api/projects` */
router.post('/legacy/projects', requireAuth, function legacyCreateProject(req, res) {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: '项目名称不能为空' });
  const ts = nowIso();
  const id = genId('P');
  db.prepare(
    `INSERT INTO projects (id, code, name, type, customer, amount, background, goal,
       status, health, pm, approval_step, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    b.code || null,
    name,
    normalizeType(b.type),
    b.customer || null,
    b.amount === undefined ? null : b.amount,
    b.background || null,
    JSON.stringify(b.goal || []),
    b.status || '草稿',
    'green',
    b.pm || req.user.open_id,
    -1, // 未进入审批：与列默认值一致（NOT NULL DEFAULT -1）
    req.user.open_id,
    ts,
    ts,
  );
  res.json(projectById(id));
});

/** @deprecated 老项目列表（裸数组）。新契约用 `GET /api/projects`（Paged 信封） */
router.get('/legacy/projects', requireAuth, function legacyListProjects(req, res) {
  const rows = db
    .prepare('SELECT id FROM projects WHERE deleted_at IS NULL ORDER BY created_at DESC')
    .all();
  res.json(rows.map(function (r) { return projectById(r.id); }));
});

/** @deprecated 老项目详情（裸对象）。新契约用 `GET /api/projects/:id` */
router.get('/legacy/projects/:id', requireAuth, function legacyGetProject(req, res) {
  const p = projectById(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  res.json(p);
});

/** @deprecated 用 `PATCH /api/projects/:id` */
router.put('/projects/:id', requireAuth, function legacyUpdateProject(req, res) {
  const p = projectById(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (!canEditProject(req.user, p)) return res.status(403).json({ error: '仅项目负责人或管理员可编辑' });
  const b = req.body || {};
  const goal = b.goal !== undefined ? JSON.stringify(b.goal) : JSON.stringify(p.goal || []);
  db.prepare(
    `UPDATE projects SET code=?, name=?, type=?, customer=?, amount=?, background=?, goal=?,
       status=?, pm=?, approved_by=?, updated_at=? WHERE id=?`,
  ).run(
    b.code !== undefined ? b.code : p.code,
    b.name !== undefined ? b.name : p.name,
    b.type !== undefined ? normalizeType(b.type) : p.type,
    b.customer !== undefined ? b.customer : p.customer,
    b.amount !== undefined ? b.amount : p.amount,
    b.background !== undefined ? b.background : p.background,
    goal,
    b.status !== undefined ? b.status : p.status,
    b.pm !== undefined ? b.pm : p.pm,
    b.approved_by !== undefined ? b.approved_by : p.approved_by,
    nowIso(),
    req.params.id,
  );
  res.json(projectById(req.params.id));
});

/** 保留：新契约无「删除项目」方法，不冲突 */
router.delete('/projects/:id', requireAuth, function legacyDeleteProject(req, res) {
  if (!isAdminUser(req.user)) return res.status(403).json({ error: '仅管理员可删除项目' });
  const p = projectById(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ── 老审批流（批次 4 由 reviews / transition 取代） ───── */

/** @deprecated 批次 4 由 `GET /api/reviews` 取代 */
router.get('/projects/:id/approval', requireAuth, function legacyApproval(req, res) {
  const p = projectById(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  res.json(approvalView(p));
});

/** @deprecated 批次 4 由 `POST /api/projects/:id/transition` 取代 */
router.post('/projects/:id/submit', requireAuth, function legacySubmit(req, res) {
  const p = projectById(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (!canEditProject(req.user, p)) return res.status(403).json({ error: '仅项目负责人或管理员可提交审批' });
  if (p.status !== '草稿' && p.status !== '已驳回') return res.status(400).json({ error: '仅草稿/已驳回状态可提交审批' });
  const tpl = approvalTemplate(p);
  const ts = nowIso();
  db.prepare('UPDATE projects SET status=?, approval_step=?, updated_at=? WHERE id=?').run('审批中', 0, ts, p.id);
  db.prepare(
    `INSERT INTO approvals (id,project_id,step_index,step_role,approver_open_id,approver_name,action,comment,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(genId('A'), p.id, -1, tpl[0], req.user.open_id, req.user.name, 'submit', '', ts);
  res.json(approvalView(projectById(p.id)));
});

/** @deprecated 批次 4 由 `POST /api/reviews/:id/approve` 取代 */
router.post('/projects/:id/approve', requireAuth, function legacyApprove(req, res) {
  const p = projectById(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (!canApproveStep(req.user, p)) return res.status(403).json({ error: '当前步骤无需您审批（或您无权限）' });
  const tpl = approvalTemplate(p);
  const step = p.approval_step;
  const ts = nowIso();
  db.prepare(
    `INSERT INTO approvals (id,project_id,step_index,step_role,approver_open_id,approver_name,action,comment,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(genId('A'), p.id, step, tpl[step], req.user.open_id, req.user.name, 'approve', (req.body && req.body.comment) || '', ts);
  if (step + 1 >= tpl.length) {
    db.prepare('UPDATE projects SET status=?, approval_step=?, updated_at=? WHERE id=?').run('已批准', tpl.length, ts, p.id);
  } else {
    db.prepare('UPDATE projects SET approval_step=?, updated_at=? WHERE id=?').run(step + 1, ts, p.id);
  }
  res.json(approvalView(projectById(p.id)));
});

/** @deprecated 批次 4 由 `POST /api/reviews/:id/reject` 取代 */
router.post('/projects/:id/reject', requireAuth, function legacyReject(req, res) {
  const p = projectById(req.params.id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (!canApproveStep(req.user, p)) return res.status(403).json({ error: '当前步骤无需您审批（或您无权限）' });
  const tpl = approvalTemplate(p);
  const step = p.approval_step;
  const ts = nowIso();
  db.prepare(
    `INSERT INTO approvals (id,project_id,step_index,step_role,approver_open_id,approver_name,action,comment,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(genId('A'), p.id, step, tpl[step], req.user.open_id, req.user.name, 'reject', (req.body && req.body.comment) || '', ts);
  db.prepare('UPDATE projects SET status=?, approval_step=?, updated_at=? WHERE id=?').run('已驳回', -1, ts, p.id);
  res.json(approvalView(projectById(p.id)));
});

/* ── 老里程碑（列名已迁移：due→planned_date，done→done_at 派生） ── */

/** 老形态里程碑视图（补回 `due` / `done` 两个已下线字段） */
function legacyMilestone(m) {
  if (!m) return null;
  return Object.assign({}, m, { due: m.planned_date || '', done: m.done_at ? 1 : 0 });
}

/** @deprecated 用 `GET /api/projects/:projectId/milestones` */
router.get('/milestones', requireAuth, function legacyListMilestones(req, res) {
  const rows = req.query.projectId
    ? db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY planned_date').all(req.query.projectId)
    : db.prepare('SELECT * FROM milestones ORDER BY planned_date').all();
  res.json(rows.map(legacyMilestone));
});

/** @deprecated 用 `POST /api/projects/:projectId/milestones` */
router.post('/milestones', requireAuth, function legacyCreateMilestone(req, res) {
  const b = req.body || {};
  const p = projectById(b.project_id);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (!canEditProject(req.user, p)) return res.status(403).json({ error: '仅项目负责人或管理员可管理里程碑' });
  const id = genId('M');
  const ts = nowIso();
  const due = b.due || '';
  db.prepare(
    `INSERT INTO milestones (id, project_id, code, name, target, required, baseline_date, planned_date, done_at, created_at, updated_at)
     VALUES (?, ?, '', ?, '', 0, ?, ?, ?, ?, ?)`,
  ).run(id, b.project_id, b.name || '里程碑', due, due, b.done ? ts : null, ts, ts);
  res.json(legacyMilestone(db.prepare('SELECT * FROM milestones WHERE id = ?').get(id)));
});

/** @deprecated 用 `PATCH /api/milestones/:id` */
router.put('/milestones/:id', requireAuth, function legacyUpdateMilestone(req, res) {
  const m = db.prepare('SELECT * FROM milestones WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '里程碑不存在' });
  if (!canEditProject(req.user, projectById(m.project_id))) {
    return res.status(403).json({ error: '仅项目负责人或管理员可管理里程碑' });
  }
  const b = req.body || {};
  const ts = nowIso();
  let doneAt = m.done_at;
  if (b.done !== undefined) doneAt = b.done ? (m.done_at || ts) : null;
  db.prepare('UPDATE milestones SET name = ?, planned_date = ?, done_at = ?, updated_at = ? WHERE id = ?').run(
    b.name !== undefined ? b.name : m.name,
    b.due !== undefined ? b.due : m.planned_date,
    doneAt,
    ts,
    req.params.id,
  );
  res.json(legacyMilestone(db.prepare('SELECT * FROM milestones WHERE id = ?').get(req.params.id)));
});

module.exports = router;
module.exports.warnDeprecated = warnDeprecated;
module.exports.DEPRECATED_ROUTES = DEPRECATED_ROUTES;
