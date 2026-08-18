// C01 任务附件 · HTTP 集成验证
// 前置：服务器已用隔离的临时 DB + 临时附件目录启动（见调用脚本）。
// 本脚本直接往临时库插入最小用户/项目/节点，再走真实 HTTP 端点验证全链路 + RBAC。
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'qa-secret';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const BASE = process.env.QA_BASE || 'http://127.0.0.1:3111';
const DB = process.env.QA_DB || './_qa_pm.db';
const ATTACH = process.env.QA_ATTACH || './_qa_attach';

let pass = 0,
  fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ✓', msg);
  } else {
    fail++;
    fails.push(msg);
    console.log('  ✗', msg);
  }
}

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/appid`);
      if (r.ok) return true;
    } catch (_) {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function call(method, p, { token, form, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (form) {
    body = form;
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(`${BASE}/api${p}`, { method, headers, body });
  let data = null;
  try {
    const j = await res.json();
    data = j && j.data !== undefined ? j.data : j;
    return { status: res.status, code: j && j.code, message: j && j.message, data };
  } catch (_) {
    return { status: res.status, code: null, message: '', data: null };
  }
}

async function devlogin(openId) {
  const r = await call('POST', '/auth/devlogin', { json: { openId } });
  if (r.status !== 200 || !r.data || !r.data.token) throw new Error('devlogin 失败: ' + r.status);
  return r.data.token;
}

function seedDb() {
  const db = new Database(DB);
  const now = new Date().toISOString();
  // 用户可能已由服务端 seed 预置（demo 账号），用 IGNORE 避免唯一冲突
  db.prepare(
    "INSERT OR IGNORE INTO users (open_id,name,global_role,status,created_at,updated_at) VALUES ('ou_xuwenbin01','徐文斌','admin','active',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT OR IGNORE INTO users (open_id,name,global_role,status,created_at,updated_at) VALUES ('ou_chenjing05','陈静','qa','active',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT OR IGNORE INTO projects (id,name,type,goal,status,health,approval_step,created_at,updated_at) VALUES ('QA1','C01QA','B','[]','进行中','green',-1,?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT OR IGNORE INTO wbs_nodes (id,project_id,wbs_code,level,node_type,name,status,progress,created_at,updated_at) VALUES ('QN1','QA1','1',1,'task','QA任务','待办',0,?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT OR IGNORE INTO milestones (id,project_id,code,name,required,created_at,updated_at) VALUES ('QM1','QA1','M1','QA里程碑',0,?,?)",
  ).run(now, now);
  db.close();
}

function formFile(name, mime, buf) {
  const fd = new FormData();
  // 浏览器 File 会带真实 MIME；测试用 Blob 显式指定，模拟真实上传
  fd.append('file', new Blob([buf], { type: mime }), name);
  return fd;
}

(async () => {
  if (!(await waitReady())) {
    console.error('服务器未就绪（' + BASE + '）');
    process.exit(2);
  }
  seedDb();

  const tokenA = await devlogin('ou_xuwenbin01'); // admin
  const tokenQ = await devlogin('ou_chenjing05'); // qa

  // 1. 上传（admin，关联到任务 QN1）
  const upA = await call('POST', '/projects/QA1/documents', {
    token: tokenA,
    form: (() => {
      const fd = formFile('需求.doc', 'application/msword', Buffer.from('hello c01 attachment'));
      fd.append('nodeId', 'QN1');
      return fd;
    })(),
  });
  ok(upA.status === 200 && upA.data && upA.data.id, 'admin 上传成功 (200 + id)');
  const docA = upA.data;
  ok(docA && docA.nodeId === 'QN1', '附件记录关联 nodeId=QN1');
  const dirA = path.join(ATTACH, 'QA1');
  ok(fs.existsSync(dirA) && fs.readdirSync(dirA).length === 1, '文件已落盘到附件目录');

  // 2. 上传（qa，全员可传）
  const upQ = await call('POST', '/projects/QA1/documents', {
    token: tokenQ,
    form: (() => {
      const fd = formFile('设计.pdf', 'application/pdf', Buffer.from('pdf content here'));
      fd.append('nodeId', 'QN1');
      return fd;
    })(),
  });
  ok(upQ.status === 200 && upQ.data && upQ.data.id, 'qa 也能上传成功（document:upload 全角色）');
  const docQ = upQ.data;

  // 3. 列表
  const list = await call('GET', '/projects/QA1/documents', { token: tokenA });
  ok(list.status === 200 && Array.isArray(list.data) && list.data.length === 2, '列表返回 2 条');

  // 4. 按 nodeId 过滤
  const listNode = await call('GET', '/projects/QA1/documents?nodeId=QN1', { token: tokenA });
  ok(listNode.data.length === 2, '按 nodeId=QN1 过滤命中 2 条');

  // 5. 下载
  const dl = await call('GET', `/projects/QA1/documents/${docA.id}/download`, { token: tokenA });
  ok(dl.status === 200, '下载端点 200');

  // 6. 删除越权：qa 删 → 403
  const delQByQ = await call('DELETE', `/projects/QA1/documents/${docQ.id}`, { token: tokenQ });
  ok(delQByQ.status === 403, 'qa 删除被拒 (403 E_FORBIDDEN)');
  const listAfterForbidden = await call('GET', '/projects/QA1/documents', { token: tokenA });
  ok(listAfterForbidden.data.length === 2, '越权删除未生效，列表仍为 2 条');

  // 7. 删除越权：admin 可删
  const delAByA = await call('DELETE', `/projects/QA1/documents/${docA.id}`, { token: tokenA });
  ok(delAByA.status === 200, 'admin 删除成功 (200)');
  ok(!fs.existsSync(path.join(dirA, fs.readdirSync(dirA)[0] === undefined ? 'x' : fs.readdirSync(dirA)[0])) || fs.readdirSync(dirA).length === 1, 'admin 删除后磁盘文件减少');
  ok(fs.readdirSync(dirA).length === 1, '磁盘仅剩 qa 上传的文件');

  // 8. 非法 MIME
  const badMime = await call('POST', '/projects/QA1/documents', {
    token: tokenA,
    form: (() => {
      const fd = formFile('virus.exe', 'application/x-msdownload', Buffer.from('x'));
      fd.append('nodeId', 'QN1');
      return fd;
    })(),
  });
  ok(badMime.status === 400, '非法 MIME 被拒 (400)');

  // 9. 超过 20MB
  const big = await call('POST', '/projects/QA1/documents', {
    token: tokenA,
    form: (() => {
      const fd = formFile('big.bin', 'application/pdf', Buffer.alloc(21 * 1024 * 1024));
      fd.append('nodeId', 'QN1');
      return fd;
    })(),
  });
  ok(big.status === 400, '超过 20MB 被拒 (400)');

  // 10. 关联非法任务
  const badNode = await call('POST', '/projects/QA1/documents', {
    token: tokenA,
    form: (() => {
      const fd = formFile('x.txt', 'text/plain', Buffer.from('x'));
      fd.append('nodeId', 'NOPE');
      return fd;
    })(),
  });
  ok(badNode.status === 400, '关联不存在的任务被拒 (400)');

  // 11. 删除 qa 的文件（admin 收尾）
  const delQByA = await call('DELETE', `/projects/QA1/documents/${docQ.id}`, { token: tokenA });
  ok(delQByA.status === 200, 'admin 删除 qa 文件成功');

  // 12. 下载不存在 → 404
  const dlMissing = await call('GET', `/projects/QA1/documents/DOCMISSING/download`, { token: tokenA });
  ok(dlMissing.status === 404, '下载不存在附件 → 404');

  console.log(`\nC01 集成验证：通过 ${pass} / 失败 ${fail}`);
  if (fail) console.log('失败项：\n - ' + fails.join('\n - '));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('QA 运行异常：', e);
  process.exit(3);
});
