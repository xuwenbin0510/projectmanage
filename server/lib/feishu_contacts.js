/**
 * 飞书通讯录拉取（批量导入 / 按姓名搜索用）。
 *
 * 复用 `feishu.js` 的 `getTenantAccessToken()`（通讯录接口需要**租户级**令牌，
 * app_access_token 不被接受）。本文件只做「拉数据 + 归一化」，不做任何本地库写操作。
 *
 * 设计要点：
 *  - 部门递归遍历（从根部门 0 出发），逐部门拉直属于该部门的成员，按 open_id 去重。
 *  - 人员归一化为统一 DTO：{ openId, unionId, name, email, employeeId, departmentIds, departmentNames }。
 *  - 部门名解析：全量拉取时直接用遍历得到的部门名映射；搜索结果为懒加载 + 缓存。
 *  - 所有飞书调用失败统一抛出带 code/msg 的 Error，由上层路由包成 E_FEISHU_API。
 */

const { FS_API, getTenantAccessToken } = require('./feishu');

const PAGE_SIZE = 50;

/**
 * 低层 GET（带租户令牌 + 错误归一化）。
 * @param {string} path 不含 Base 的路径，如 /contact/v3/departments?...
 * @param {string} token tenant_access_token
 * @returns {Promise<object>} 飞书响应的 `data` 字段
 */
async function feishuGet(path, token) {
  const r = await fetch(FS_API + path, {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token },
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error('feishu GET ' + path + ' failed: code=' + d.code + ' msg=' + (d.msg || ''));
  return d.data || {};
}

/**
 * 归一化一个飞书 user 对象为内部 DTO。
 * @param {object} u 飞书 user 对象
 * @param {(deptId:string)=>string} nameOf 部门 id → 部门名 解析器
 * @returns {object}
 */
function normalizeUser(u, nameOf) {
  // 关键：飞书 /contact/v3/users 列表接口【不返回 department_ids 字段】，必须靠
  // 「按部门拉成员」时给成员打上的部门标记(_deptIds)来还原部门归属；若都没有则为空
  // 数组（即飞书侧未归属任何部门的人员，如 Min / Eric Yi）。
  const deptIds = (Array.isArray(u._deptIds) && u._deptIds.length)
    ? u._deptIds.slice()
    : (Array.isArray(u.department_ids) ? u.department_ids.slice() : []);
  const deptNames = deptIds
    .map(function (id) { return nameOf(id); })
    .filter(Boolean);
  return {
    openId: u.open_id || '',
    unionId: u.union_id || '',
    name: u.name || '',
    email: (u.email || '').toLowerCase(),
    employeeId: u.employee_no || u.employee_id || '',
    departmentIds: deptIds,
    departmentNames: deptNames,
  };
}

/**
 * 递归遍历部门树，返回扁平部门清单（含根部门的直接/间接子部门）。
 * @param {string} token tenant_access_token
 * @returns {Promise<Array<{open_department_id:string,name:string,parent_department_id:string}>>}
 */
async function walkDepartments(token) {
  const out = [];
  // 根部门 id 固定为 '0'
  const stack = ['0'];
  while (stack.length) {
    const parent = stack.pop();
    let pageToken = null;
    do {
      const qs = '?parent_department_id=' + encodeURIComponent(parent)
        + '&department_id_type=open_department_id&page_size=' + PAGE_SIZE
        + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
      const data = await feishuGet('/contact/v3/departments' + qs, token);
      const items = Array.isArray(data.items) ? data.items : [];
      items.forEach(function (d) {
        out.push({
          open_department_id: d.open_department_id,
          name: d.name || '',
          parent_department_id: d.parent_department_id || '',
        });
        // 继续向下递归
        stack.push(d.open_department_id);
      });
      pageToken = data.has_more ? data.page_token : null;
    } while (pageToken);
  }
  return out;
}

/**
 * 拉取单个部门的直属成员（分页）。不含子部门。
 * @param {string} deptId open_department_id
 * @param {string} token tenant_access_token
 * @returns {Promise<Array<object>>} 飞书 user 对象（原始）
 */
async function fetchUsersInDept(deptId, token) {
  const users = [];
  let pageToken = null;
  do {
    const qs = '?department_id=' + encodeURIComponent(deptId)
      + '&department_id_type=open_department_id&user_id_type=open_id&page_size=' + PAGE_SIZE
      + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
    const data = await feishuGet('/contact/v3/users' + qs, token);
    const items = Array.isArray(data.items) ? data.items : [];
    items.forEach(function (u) {
      // 列表接口不返回 department_ids，这里按「拉自哪个部门」给成员打上部门标记，
      // 后续 normalizeUser 用它还原部门归属（多人部门会被 getFullContacts 聚合去重）。
      u._deptIds = Array.isArray(u._deptIds) ? u._deptIds : [];
      if (u._deptIds.indexOf(deptId) < 0) u._deptIds.push(deptId);
      users.push(u);
    });
    pageToken = data.has_more ? data.page_token : null;
  } while (pageToken);
  return users;
}

/**
 * 模块级缓存：飞书通讯录在 30s 内复用，避免搜索/预览/导入反复全量拉取。
 */
let _fullCache = null;
let _fullCacheAt = 0;
const FULL_CACHE_TTL = 30 * 1000;

/**
 * 兜底拉取：以根部门 fetch_child=true 一次性拉全量。
 * 可命中「未归属任何部门」的人员（部门遍历会漏掉，典型如曾旻/易岐筠）。
 * @param {string} token tenant_access_token
 * @returns {Promise<Array<object>>} 飞书 user 原始对象
 */
async function fetchUsersViaRoot(token) {
  const users = [];
  let pageToken = null;
  do {
    const qs = '?department_id=0&department_id_type=open_department_id&user_id_type=open_id&fetch_child=true&page_size=' + PAGE_SIZE
      + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
    const data = await feishuGet('/contact/v3/users' + qs, token);
    const items = Array.isArray(data.items) ? data.items : [];
    items.forEach(function (u) { if (u.open_id) users.push(u); });
    pageToken = data.has_more ? data.page_token : null;
  } while (pageToken);
  return users;
}

/**
 * 拉取通讯录全量人员。
 * 取数策略：部门递归遍历（覆盖有部门归属者） ∪ 根部门 fetch_child（覆盖无部门归属者），
 * 按 open_id 去重合并。两者并集即完整通讯录，避免漏掉「未分部门」人员。
 * @param {string} [token] tenant_access_token；省略则内部换取
 * @param {object} [opts] { force?: boolean } 强制跳过缓存
 * @returns {Promise<Array<object>>} 归一化 DTO 数组（按 open_id 去重）
 */
async function getFullContacts(token, opts) {
  const tk = token || (await getTenantAccessToken());
  const force = !!(opts && opts.force);
  const now = Date.now();
  if (!force && _fullCache && now - _fullCacheAt < FULL_CACHE_TTL) return _fullCache;

  const depts = await walkDepartments(tk);
  // 部门名映射，供 DTO 带出部门名
  const deptNameMap = {};
  depts.forEach(function (d) { deptNameMap[d.open_department_id] = d.name; });
  const nameOf = function (id) { return deptNameMap[id] || id || ''; };

  const byId = {};
  const mergeDept = function (target, src) {
    const merged = target._deptIds ? target._deptIds.slice() : [];
    (src._deptIds || []).forEach(function (id) {
      if (merged.indexOf(id) < 0) merged.push(id);
    });
    target._deptIds = merged;
  };

  // 1) 部门遍历（有部门归属者）
  for (const d of depts) {
    const list = await fetchUsersInDept(d.open_department_id, tk);
    list.forEach(function (u) {
      if (!u.open_id) return;
      if (!byId[u.open_id]) byId[u.open_id] = u;
      else mergeDept(byId[u.open_id], u);
    });
  }
  // 2) 根部门兜底（无部门归属者，如曾旻/易岐筠）
  const rootUsers = await fetchUsersViaRoot(tk);
  rootUsers.forEach(function (u) {
    if (!u.open_id) return;
    if (!byId[u.open_id]) byId[u.open_id] = u;
    else mergeDept(byId[u.open_id], u);
  });

  const result = Object.keys(byId).map(function (k) { return normalizeUser(byId[k], nameOf); });
  _fullCache = result;
  _fullCacheAt = now;
  return result;
}

/** 清除全量通讯录缓存（导入后调用，保证下次预览拿最新数据）。 */
function clearFullContactsCache() {
  _fullCache = null;
  _fullCacheAt = 0;
}

/**
 * 在已拉取的全量通讯录中按关键字过滤（姓名或邮箱子串，大小写不敏感）。
 * 复用 getFullContacts() 的数据，避免对飞书 /contact/v3/users/search 产生额外
 * 权限依赖（该接口需独立 scope，未授予时会 502）。全量目录已在可见范围内，
 * 本地过滤与远端搜索结果等价。
 * @param {Array<object>} contacts 归一化 DTO 数组
 * @param {string} query 姓名或邮箱关键字
 * @param {number} [pageSize] 返回条数上限（可选）
 * @returns {Array<object>}
 */
function filterContacts(contacts, query, pageSize) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const matched = (contacts || []).filter(function (c) {
    const name = String(c.name || '').toLowerCase();
    const email = String(c.email || '').toLowerCase();
    return name.indexOf(q) >= 0 || email.indexOf(q) >= 0;
  });
  return typeof pageSize === 'number' && pageSize > 0 ? matched.slice(0, pageSize) : matched;
}

module.exports = {
  PAGE_SIZE,
  walkDepartments,
  getFullContacts,
  clearFullContactsCache,
  filterContacts,
  normalizeUser,
};
