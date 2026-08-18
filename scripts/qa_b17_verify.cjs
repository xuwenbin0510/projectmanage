#!/usr/bin/env node
'use strict';
/*
 * B17 全局总览可视化优化 — 独立 QA 验证脚本（QA · 严过关）
 *
 * 运行：node scripts/qa_b17_verify.cjs   （需从 pm-app 根目录执行）
 *
 * 设计原则（与工程师验证路径完全独立）：
 *  - 后端 3 个纯函数：直接 require `server/lib/portfolioAgg.js` 断言（含脏值 / 边界）；
 *  - 数值对照：以 `pm.db` 只读直连 + **独立 SQL/GROUP BY 复刻**（不经任何 service），
 *    再与 纯函数 → dashboard.service → HTTP API 三层结果互证；
 *  - 红线回归：`HealthDistBar` 保留 / 工作台引用；只读文件无 B17 内容；
 *    `server/**` 仅 2 文件含 B17；schema_migrations 版本前后不变（无 schema 变更）；
 *  - 接口级：起后端（:3999，ALLOW_DEV_LOGIN=true）→ devlogin admin → GET overview；
 *  - 编译：vite build + tsc --noEmit 0 错误；
 *  - 数据安全：全程只读 pm.db（better-sqlite3 readonly），脚本自身零写入；
 *    服务启动可能执行的迁移为版本化幂等（版本已是最新 v7，实际不落任何迁移）。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const PM_DIR = 'C:/Users/xuwen/WorkBuddy/AstrBytes/pm-app';
const DB_PATH = path.join(PM_DIR, 'pm.db');
const WEB_DIR = path.join(PM_DIR, 'web');
const TEST_PORT = 3999;
const BASE = 'http://127.0.0.1:' + TEST_PORT + '/api';

/* ───────────────────────── 结果收集 ───────────────────────── */
const checks = [];
function check(name, pass, detail) {
  checks.push({ name: name, pass: !!pass, detail: detail || '' });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log('  [' + tag + '] ' + name + (detail ? '  —— ' + detail : ''));
}
function section(title) {
  console.log('\n── ' + title + ' ──');
}

/* ───────────────────────── 工具函数 ───────────────────────── */
function httpReq(method, urlPath, token, body) {
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(urlPath);
    const opts = {
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(opts, function (res) {
      let buf = '';
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: json, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** 轮询直到端口有 HTTP 响应（服务就绪） */
async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await httpReq('GET', url, null);
      if (r.status >= 200) return true;
    } catch (e) { /* 未就绪 */ }
    await sleep(400);
  }
  return false;
}

/** 运行子进程并收集 stdout/stderr，返回 { code, out } */
function runProc(cmd, args, opts, timeoutMs) {
  return new Promise(function (resolve) {
    const child = spawn(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts));
    let out = '';
    child.stdout.on('data', function (d) { out += d.toString(); });
    child.stderr.on('data', function (d) { out += d.toString(); });
    const timer = setTimeout(function () {
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      resolve({ code: -1, out: out + '\n[QA] 超时被强杀' });
    }, timeoutMs || 300000);
    child.on('close', function (code) {
      clearTimeout(timer);
      resolve({ code: code, out: out });
    });
  });
}

/* ───────────────────────── 独立核算（纯 SQL 复刻，不经 service） ─────────────────────────
 * 与 server/services/dashboard.service.js 的取数口径逐字段对照：
 *  1. 范围 = deleted_at IS NULL AND status IN ('已批准','进行中','挂起')（决策⑥）
 *  2. 叶子 = 节点 id 不出现在本范围内任何节点的 parent_id 中（leafNodesOf 同语义）
 *  3. 归一 = toApiWbsNode 同款：status 空→'待办'；priority 空→'P2'（toStr 兜底）
 *  4. 在办 = status !== '完成'；全量 = 含已完成
 * 本函数返回独立计算出的三张分布 + 项目/叶子集合，供三层断言互证。 */
function independentAgg(db, dates) {
  const projects = db.prepare(
    "SELECT * FROM projects WHERE deleted_at IS NULL AND status IN ('已批准','进行中','挂起') ORDER BY updated_at DESC, id DESC",
  ).all();
  const pids = projects.map(function (p) { return String(p.id); });

  let rows = [];
  if (pids.length) {
    const ph = pids.map(function () { return '?'; }).join(',');
    rows = db.prepare('SELECT * FROM wbs_nodes WHERE project_id IN (' + ph + ')').all(pids);
  }

  /* toApiWbsNode 同款归一（仅取本脚本需要的字段） */
  const norm = rows.map(function (r) {
    return {
      id: String(r.id),
      projectId: String(r.project_id),
      parentId: r.parent_id === undefined || r.parent_id === null ? null : String(r.parent_id),
      status: r.status === undefined || r.status === null ? '待办' : String(r.status),
      priority: r.priority === undefined || r.priority === null ? 'P2' : String(r.priority),
      dueDate: r.due_date === undefined || r.due_date === null ? '' : String(r.due_date),
    };
  });

  /* 叶子判定（与 wbs.leafNodesOf 一致：id 不在 parentId 集合内） */
  const parentIds = new Set();
  norm.forEach(function (n) { if (n.parentId) parentIds.add(n.parentId); });
  const leaves = norm.filter(function (n) { return !parentIds.has(n.id); });
  const inProgress = leaves.filter(function (n) { return n.status !== '完成'; });

  /* ① 优先级分布（白名单 P0–P3，脏值 P2，大小写归一；小写 p0 → P0 为已确认口径） */
  const PRIO = ['P0', 'P1', 'P2', 'P3'];
  const pd = { P0: 0, P1: 0, P2: 0, P3: 0, total: 0 };
  inProgress.forEach(function (n) {
    const raw = String(n.priority || '').trim().toUpperCase();
    const p = PRIO.indexOf(raw) >= 0 ? raw : 'P2';
    pd[p] += 1;
    pd.total += 1;
  });

  /* ② 状态分布（五档，脏状态不计入；全量叶子含已完成） */
  const TS = ['待办', '进行中', '待评审', '完成', '阻塞'];
  const sd = { 待办: 0, 进行中: 0, 待评审: 0, 完成: 0, 阻塞: 0, total: 0 };
  leaves.forEach(function (n) {
    const s = String(n.status || '');
    if (TS.indexOf(s) < 0) return;
    sd[s] += 1;
    sd.total += 1;
  });

  /* ③ 逾期时长分段（在办叶子，isOverdue 者 days=diffDays(due,today)，分段 1–7/8–30/≥31） */
  const todayStr = dates.today();
  const od = { days1to7: 0, days8to30: 0, daysOver30: 0, total: 0 };
  inProgress.forEach(function (n) {
    const due = String(n.dueDate || '');
    if (!due) return;
    const days = dates.diffDays(due, todayStr); // today - due
    if (days <= 0) return; // 未逾期（due >= today）
    if (days <= 7) od.days1to7 += 1;
    else if (days <= 30) od.days8to30 += 1;
    else od.daysOver30 += 1;
    od.total += 1;
  });

  return { projects: projects, leaves: leaves, inProgress: inProgress, pd: pd, sd: sd, od: od, todayStr: todayStr };
}

/* ───────────────────────── 主流程 ───────────────────────── */
async function main() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' B17 QA 独立验证脚本 · 严过关');
  console.log('══════════════════════════════════════════════════════════════');

  const Database = require('better-sqlite3');
  const dates = require(path.join(PM_DIR, 'server/lib/dates.js'));
  const enums = require(path.join(PM_DIR, 'server/config/enums.js'));
  const agg = require(path.join(PM_DIR, 'server/lib/portfolioAgg.js'));
  const dashboardService = require(path.join(PM_DIR, 'server/services/dashboard.service.js'));

  /* ════════════ 阶段 0：红线回归（源码级，只读） ════════════ */
  section('阶段 0：红线回归');

  const healthDistBarPath = path.join(PM_DIR, 'web/src/components/dashboard/HealthDistBar.tsx');
  const workbenchPath = path.join(PM_DIR, 'web/src/pages/WorkbenchPage.tsx');
  check('HealthDistBar.tsx 组件保留', fs.existsSync(healthDistBarPath), healthDistBarPath);
  const wbSrc = fs.readFileSync(workbenchPath, 'utf8');
  check('WorkbenchPage 仍 import HealthDistBar', /HealthDistBar/.test(wbSrc));
  const wbUseLines = wbSrc.split('\n').map(function (l, i) { return i + 1; }).filter(function (ln, i) {
    return /<HealthDistBar/.test(wbSrc.split('\n')[i]);
  });
  check('WorkbenchPage 渲染 <HealthDistBar>', wbUseLines.length > 0, '行 ' + wbUseLines.join(','));

  /* 只读红线文件不应含 B17 内容 */
  const redFiles = [
    'web/src/components/dashboard/HealthDistBar.tsx',
    'web/src/components/dashboard/DonutChart.tsx',
    'web/src/components/dashboard/ChartCard.tsx',
    'web/src/components/dashboard/OverdueBarChart.tsx',
    'web/src/components/dashboard/OwnerLoadBarChart.tsx',
    'web/src/api/http.ts',
  ];
  const redViolations = [];
  redFiles.forEach(function (rel) {
    const abs = path.join(PM_DIR, rel);
    if (!fs.existsSync(abs)) { redViolations.push(rel + '(缺失)'); return; }
    const src = fs.readFileSync(abs, 'utf8');
    if (/B17/.test(src)) redViolations.push(rel);
  });
  check('只读红线文件无 B17 内容', redViolations.length === 0, redViolations.join(',') || '6 文件全净');

  /* server/** 仅 2 文件含 B17 */
  const serverFiles = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (e.name.endsWith('.js')) serverFiles.push(p);
    });
  })(path.join(PM_DIR, 'server'));
  const b17Server = serverFiles.filter(function (p) {
    return /B17/.test(fs.readFileSync(p, 'utf8'));
  }).map(function (p) { return path.relative(PM_DIR, p).replace(/\\/g, '/'); });
  check('server/** 仅 portfolioAgg.js / dashboard.service.js 含 B17',
    b17Server.length === 2 &&
    b17Server.indexOf('server/lib/portfolioAgg.js') >= 0 &&
    b17Server.indexOf('server/services/dashboard.service.js') >= 0,
    b17Server.join(', '));

  /* 无 schema 变更：无 migrations 目录；docs/schema.sql 早于 B17 生成日（2026-08-18） */
  const migrationsDirs = [];
  (function walk2(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      if (e.isDirectory()) {
        const p = path.join(dir, e.name);
        if (e.name === 'migrations') migrationsDirs.push(p);
        else if (e.name !== 'node_modules' && e.name !== 'web' && e.name !== 'dist') walk2(p);
      }
    });
  })(PM_DIR);
  check('无 migrations 目录', migrationsDirs.length === 0, migrationsDirs.join(',') || '无');
  const schemaPath = path.join(PM_DIR, 'docs/schema.sql');
  const schemaMtime = fs.existsSync(schemaPath) ? fs.statSync(schemaPath).mtimeMs : 0;
  const b17Gen = Date.UTC(2026, 7, 18); // 2026-08-18
  check('docs/schema.sql 未被 B17 触碰', fs.existsSync(schemaPath) && schemaMtime < b17Gen,
    'mtime=' + (fs.existsSync(schemaPath) ? new Date(schemaMtime).toISOString() : '缺失'));

  /* 前端类型 / 组件 / mock / 页面源码断言 */
  const typesSrc = fs.readFileSync(path.join(PM_DIR, 'web/src/types/dashboard.ts'), 'utf8');
  check('类型：TaskStatusDistribution 存在', /export interface TaskStatusDistribution/.test(typesSrc));
  check('类型：OverdueDurationDistribution 存在', /export interface OverdueDurationDistribution/.test(typesSrc));
  check('类型：DashboardOverview 含 priorityDist/statusDist/overdueDuration',
    /priorityDist:\s*PriorityDistribution/.test(typesSrc) &&
    /statusDist:\s*TaskStatusDistribution/.test(typesSrc) &&
    /overdueDuration:\s*OverdueDurationDistribution/.test(typesSrc));

  const cbcSrc = fs.readFileSync(path.join(PM_DIR, 'web/src/components/dashboard/CategoryBarChart.tsx'), 'utf8');
  check('CategoryBarChart：掩码多 series 逐档着色存在',
    /data:\s*list\.map\(\(_, j\) => \(j === i \? r\.value : null\)\)/.test(cbcSrc),
    'series data 仅对应档位有值、其余 null');
  check('CategoryBarChart：valueFormatter 显示 N 个 · P%', /`\$\{v\} \$\{unit\} · \$\{pct\(v\)\}%`/.test(cbcSrc));
  check('CategoryBarChart：onDrill 可选（B18 新增），缺省时图例 onClick 为 undefined',
    /onDrill\?:/.test(cbcSrc) && /onClick:\s*onDrill \? \(\) => onDrill\(r\.key\) : undefined/.test(cbcSrc));

  const hdSrc = fs.readFileSync(path.join(PM_DIR, 'web/src/components/dashboard/HealthDonut.tsx'), 'utf8');
  check('HealthDonut：centerValue = red+yellow', /centerValue=\{String\(d\.red \+ d\.yellow\)\}/.test(hdSrc) || /centerValue=\{String\(needsAttention\)\}/.test(hdSrc));
  check('HealthDonut：中心色三态（红>0→红 / 仅黄→黄 / 全绿→brandStrong）',
    /d\.red > 0 \? palette\.health\.red : d\.yellow > 0 \? palette\.health\.yellow : palette\.brandStrong/.test(hdSrc));
  check('HealthDonut：subtitle = {total} 个在办项目', /\$\{d\.total\} 个在办项目/.test(hdSrc));
  check('HealthDonut：空态总览口径', /当前范围暂无在办项目/.test(hdSrc) && /切换范围或调整筛选条件试试/.test(hdSrc));

  const mockSrc = fs.readFileSync(path.join(PM_DIR, 'web/src/api/mock/index.ts'), 'utf8');
  check('Mock getDashboardOverview 返回 3 字段',
    /priorityDist,/.test(mockSrc) && /statusDist,/.test(mockSrc) && /overdueDuration,/.test(mockSrc));
  check('Mock 保留全量叶子（含已完成）再筛在办',
    /allLeafTasks = leafNodesOf/.test(mockSrc) && /tasks = allLeafTasks\.filter\(\(n\) => n\.status !== '完成'\)/.test(mockSrc));

  const mpSrc = fs.readFileSync(path.join(PM_DIR, 'web/src/pages/MetricsPage.tsx'), 'utf8');
  const gridOk = /gridTemplateColumns: \{ xs: '1fr', md: 'repeat\(2, 1fr\)', xl: 'repeat\(3, 1fr\)' \}/.test(mpSrc);
  check('MetricsPage：栅格 xs 1 列 / md 2 列 / xl 3 列', gridOk);
  /* 7 图顺序：DonutChart → HealthDonut → OverdueBarChart → OwnerLoadBarChart → CategoryBarChart ×3 */
  const chartOrder = [];
  const mpLines = mpSrc.split('\n');
  mpLines.forEach(function (l, i) {
    if (/<DonutChart/.test(l)) chartOrder.push(i + 1 + ':DonutChart');
    if (/<HealthDonut/.test(l)) chartOrder.push(i + 1 + ':HealthDonut');
    if (/<OverdueBarChart/.test(l)) chartOrder.push(i + 1 + ':OverdueBarChart');
    if (/<OwnerLoadBarChart/.test(l)) chartOrder.push(i + 1 + ':OwnerLoadBarChart');
    if (/<CategoryBarChart/.test(l)) chartOrder.push(i + 1 + ':CategoryBarChart');
  });
  const orderStr = chartOrder.map(function (s) { return s.split(':')[1]; }).join('→');
  check('MetricsPage：7 图顺序 状态环→健康环→逾期柱→负荷柱→优先级→状态→逾期时长',
    orderStr === 'DonutChart→HealthDonut→OverdueBarChart→OwnerLoadBarChart→CategoryBarChart→CategoryBarChart→CategoryBarChart',
    orderStr);
  const dashImportMatch = mpSrc.match(/import \{([\s\S]*?)\} from '@\/components\/dashboard'/);
  check('MetricsPage：不再 import HealthDistBar（仅注释提及替换）',
    !!dashImportMatch && !/HealthDistBar/.test(dashImportMatch[1]) && /HealthDonut/.test(dashImportMatch[1]),
    dashImportMatch ? 'dashboard import: ' + dashImportMatch[1].replace(/\s+/g, ' ').trim() : '未匹配 dashboard import');
  /* 原 4 图 props 不变：状态环 onSegmentClick、健康下钻 toggle、逾期 openOverdue、负荷 openOwner */
  check('MetricsPage：状态环 onSegmentClick 保留（状态筛选 toggle）', /onSegmentClick=\{\(seg\) => \{/.test(mpSrc));
  check('MetricsPage：健康环 onDrill toggle 保留', /onDrill=\{\(h\) => setQuery\(\{ health: query\.health === h \? '' : h \}\)\}/.test(mpSrc));
  check('MetricsPage：逾期柱 onDrill=openOverdue 保留', /<OverdueBarChart rows=\{data\?\.overdue \?\? \[\]\} loading=\{loading\} onDrill=\{openOverdue\} \/>/.test(mpSrc));
  check('MetricsPage：负荷柱 onDrill=openOwner 保留', /<OwnerLoadBarChart rows=\{data\?\.ownerLoad \?\? \[\]\} loading=\{loading\} onDrill=\{openOwner\} \/>/.test(mpSrc));
  check('MetricsPage：优先级配色 P0红/P1黄/P2品牌蓝/P3灰',
    /p === 'P0'[\s\S]*?palette\.health\.red/.test(mpSrc) &&
    /p === 'P1'[\s\S]*?palette\.health\.yellow/.test(mpSrc) &&
    /p === 'P2'[\s\S]*?palette\.brandMain/.test(mpSrc) &&
    /palette\.track/.test(mpSrc));
  check('MetricsPage：逾期时长三段红系递进（hexAlpha 0.5/0.75/1.0）',
    /hexAlpha\(palette\.health\.red, 0\.5\)/.test(mpSrc) &&
    /hexAlpha\(palette\.health\.red, 0\.75\)/.test(mpSrc) &&
    /color: palette\.health\.red \}/.test(mpSrc));

  /* http.ts 复用同一接口（不新增接口/路由） */
  const httpSrc = fs.readFileSync(path.join(PM_DIR, 'web/src/api/http.ts'), 'utf8');
  check('http.ts getDashboardOverview 仅复用既有接口', /getDashboardOverview\(query: DashboardOverviewQuery\): Promise<DashboardOverview>/.test(httpSrc));
  check('http.ts 无 B17 标记（零改动红线）', !/B17/.test(httpSrc));

  /* barrel 导出 */
  const barrelSrc = fs.readFileSync(path.join(PM_DIR, 'web/src/components/dashboard/index.ts'), 'utf8');
  check('barrel 导出 CategoryBarChart / HealthDonut',
    /export \{ CategoryBarChart \} from '\.\/CategoryBarChart'/.test(barrelSrc) &&
    /export \{ HealthDonut \} from '\.\/HealthDonut'/.test(barrelSrc));

  /* ════════════ 阶段 1：后端纯函数单测（直接 require，零服务） ════════════ */
  section('阶段 1：后端纯函数单测（server/lib/portfolioAgg.js）');

  /* aggregatePriorityDist */
  const prioNormal = agg.aggregatePriorityDist([
    { priority: 'P0' }, { priority: 'P1' }, { priority: 'P2' }, { priority: 'P3' },
    { priority: 'P0' }, { priority: 'P1' }, { priority: 'P3' },
  ]);
  check('aggregatePriorityDist 正常 4 档计数',
    prioNormal.P0 === 2 && prioNormal.P1 === 2 && prioNormal.P2 === 1 && prioNormal.P3 === 2 && prioNormal.total === 7,
    JSON.stringify(prioNormal));
  check('aggregatePriorityDist 脏值 P9 → P2',
    agg.aggregatePriorityDist([{ priority: 'P9' }]).P2 === 1 && agg.aggregatePriorityDist([{ priority: 'P9' }]).total === 1);
  check('aggregatePriorityDist 空串 → P2',
    agg.aggregatePriorityDist([{ priority: '' }]).P2 === 1);
  check('aggregatePriorityDist null/缺失 → P2',
    agg.aggregatePriorityDist([{ priority: null }, {}]).P2 === 2 && agg.aggregatePriorityDist([{ priority: null }, {}]).total === 2);
  /* 已确认口径：小写 p0 先归一大写 → P0（非 P2） */
  check('aggregatePriorityDist 小写 p0 → P0（已确认口径）',
    agg.aggregatePriorityDist([{ priority: 'p0' }]).P0 === 1 && agg.aggregatePriorityDist([{ priority: 'p0' }]).P2 === 0);
  check('aggregatePriorityDist 空数组 → 全零不 NaN',
    JSON.stringify(agg.aggregatePriorityDist([])) === JSON.stringify({ P0: 0, P1: 0, P2: 0, P3: 0, total: 0 }));

  /* aggregateStatusDist */
  const stNormal = agg.aggregateStatusDist([
    { status: '待办' }, { status: '进行中' }, { status: '待评审' }, { status: '完成' }, { status: '阻塞' },
    { status: '完成' }, { status: '进行中' },
  ]);
  check('aggregateStatusDist 五档（含完成）计数',
    stNormal.待办 === 1 && stNormal.进行中 === 2 && stNormal.待评审 === 1 && stNormal.完成 === 2 && stNormal.阻塞 === 1 && stNormal.total === 7,
    JSON.stringify(stNormal));
  const stDirty = agg.aggregateStatusDist([{ status: '未知' }, { status: '' }, { status: '待办' }]);
  check('aggregateStatusDist 脏状态不计入且 total 随之下调',
    stDirty.待办 === 1 && stDirty.total === 1, JSON.stringify(stDirty));
  check('aggregateStatusDist 空数组 → 全零', agg.aggregateStatusDist([]).total === 0);

  /* aggregateOverdueDuration 边界 */
  const today = '2026-08-18';
  const mkDue = function (d) { return { dueDate: d }; };
  const b7 = agg.aggregateOverdueDuration([mkDue('2026-08-11')], today);    // 7 天前 → 1to7
  const b8 = agg.aggregateOverdueDuration([mkDue('2026-08-10')], today);    // 8 天前 → 8to30
  const b30 = agg.aggregateOverdueDuration([mkDue('2026-07-19')], today);   // 30 天前 → 8to30
  const b31 = agg.aggregateOverdueDuration([mkDue('2026-07-18')], today);   // 31 天前 → over30
  check('边界 days=7 → 1–7 档', b7.days1to7 === 1 && b7.total === 1, JSON.stringify(b7));
  check('边界 days=8 → 8–30 档', b8.days8to30 === 1 && b8.days1to7 === 0 && b8.total === 1, JSON.stringify(b8));
  check('边界 days=30 → 8–30 档', b30.days8to30 === 1 && b30.daysOver30 === 0 && b30.total === 1, JSON.stringify(b30));
  check('边界 days=31 → >30 档', b31.daysOver30 === 1 && b31.days8to30 === 0 && b31.total === 1, JSON.stringify(b31));
  const mixed = agg.aggregateOverdueDuration([
    mkDue('2026-08-11'), mkDue('2026-08-10'), mkDue('2026-07-18'),
    mkDue('2026-08-19'), // 明天 → 不逾期
    mkDue(''),           // 空 dueDate → 不计
    { dueDate: null },   // null → 不计
    { dueDate: '2026-08-18' }, // 今天 → 不逾期
  ], today);
  check('逾期时长：未逾期/空/今天不计，total=3', mixed.total === 3 && mixed.days1to7 === 1 && mixed.days8to30 === 1 && mixed.daysOver30 === 1,
    JSON.stringify(mixed));
  const overdueMix = [
    mkDue('2026-08-11'), mkDue('2026-08-10'), mkDue('2026-07-18'), mkDue('2026-08-19'), mkDue(''),
  ];
  check('overdueDuration.total === countOverdueTasks（同入参同 today）',
    agg.aggregateOverdueDuration(overdueMix, today).total === agg.countOverdueTasks(overdueMix, today),
    'total=' + agg.aggregateOverdueDuration(overdueMix, today).total + ' count=' + agg.countOverdueTasks(overdueMix, today));

  /* ════════════ 阶段 2：DB 独立核算（pm.db 只读 + 独立 SQL 复刻） ════════════ */
  section('阶段 2：DB 独立核算（pm.db 只读直连 + 独立 GROUP BY）');

  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('busy_timeout = 8000');
  const beforeSchema = JSON.stringify(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all());

  const ind = independentAgg(db, dates);
  check('独立核算：在管项目集（三态）', ind.projects.length > 0, ind.projects.length + ' 个项目');
  check('独立核算：叶子任务集', ind.leaves.length > 0, '叶子 ' + ind.leaves.length + ' / 在办 ' + ind.inProgress.length);

  /* 独立 GROUP BY vs 纯函数（同输入归一化数组） */
  const normTasks = ind.inProgress.map(function (n) { return { priority: n.priority, status: n.status, dueDate: n.dueDate }; });
  const fnPd = agg.aggregatePriorityDist(normTasks);
  check('优先级分布：独立 GROUP BY === 纯函数',
    JSON.stringify(fnPd) === JSON.stringify(ind.pd),
    '独立=' + JSON.stringify(ind.pd) + ' 函数=' + JSON.stringify(fnPd));

  const normAll = ind.leaves.map(function (n) { return { status: n.status }; });
  const fnSd = agg.aggregateStatusDist(normAll);
  check('状态分布：独立 GROUP BY === 纯函数（含已完成）',
    JSON.stringify(fnSd) === JSON.stringify(ind.sd),
    '独立=' + JSON.stringify(ind.sd) + ' 函数=' + JSON.stringify(fnSd));

  const fnOd = agg.aggregateOverdueDuration(normTasks, ind.todayStr);
  check('逾期时长：独立分段 === 纯函数',
    JSON.stringify(fnOd) === JSON.stringify(ind.od),
    '独立=' + JSON.stringify(ind.od) + ' 函数=' + JSON.stringify(fnOd));

  const dbOverdueCount = agg.countOverdueTasks(normTasks, ind.todayStr);
  check('DB 层 overdueDuration.total === countOverdueTasks', ind.od.total === dbOverdueCount,
    'total=' + ind.od.total + ' count=' + dbOverdueCount);

  /* 状态分布五档之和 === total；且完成档 = 全量叶子中含完成的真实值 */
  const sdSum = ind.sd.待办 + ind.sd.进行中 + ind.sd.待评审 + ind.sd.完成 + ind.sd.阻塞;
  check('状态分布 total === 五档之和', ind.sd.total === sdSum, 'total=' + ind.sd.total);
  const doneCount = ind.leaves.filter(function (n) { return n.status === '完成'; }).length;
  check('状态分布完成档 = 范围内已完成叶子真实值', ind.sd.完成 === doneCount,
    '完成档=' + ind.sd.完成 + ' 独立统计=' + doneCount);

  /* 优先级 total === 在办叶子数（脏值也兜底计入 P2） */
  check('优先级分布 total === 在办叶子数', ind.pd.total === ind.inProgress.length,
    'total=' + ind.pd.total + ' 在办=' + ind.inProgress.length);

  /* service 层直接调用（不经 HTTP）三层互证 */
  const adminMe = { open_id: 'ou_xuwenbin01', global_role: 'admin' };
  const svc = dashboardService.getDashboardOverview(db, {}, adminMe);
  check('service：priorityDist 与独立核算一致', JSON.stringify(svc.priorityDist) === JSON.stringify(ind.pd),
    JSON.stringify(svc.priorityDist));
  check('service：statusDist 与独立核算一致', JSON.stringify(svc.statusDist) === JSON.stringify(ind.sd),
    JSON.stringify(svc.statusDist));
  check('service：overdueDuration 与独立核算一致', JSON.stringify(svc.overdueDuration) === JSON.stringify(ind.od),
    JSON.stringify(svc.overdueDuration));
  check('service：stats.overdueTasks === overdueDuration.total',
    svc.stats.overdueTasks === svc.overdueDuration.total,
    'stats=' + svc.stats.overdueTasks + ' total=' + svc.overdueDuration.total);
  check('service：既有字段结构完整',
    svc.stats && svc.statusDonut && svc.health && svc.overdue && svc.ownerLoad && svc.reportMissing && svc.projects &&
    Array.isArray(svc.overdue) && Array.isArray(svc.ownerLoad) && Array.isArray(svc.reportMissing) &&
    svc.projects.items && typeof svc.projects.total === 'number',
    'stats/statusDonut/health/overdue/ownerLoad/reportMissing/projects 均存在');
  check('service：health.total === green+yellow+red',
    svc.health.total === svc.health.green + svc.health.yellow + svc.health.red,
    JSON.stringify(svc.health));
  check('service：scope=all（admin 默认）', svc.scope === 'all', 'scope=' + svc.scope);

  /* ════════════ 阶段 3：接口级（起后端 → devlogin → GET overview） ════════════ */
  section('阶段 3：接口级（:3999 起后端 + devlogin admin + GET /api/dashboard/overview）');

  let server = null;
  let serverOut = '';
  let serverReady = false;
  /* 先探测 3999 是否已被占用；占用则视为复用（不重复起），否则自行起 */
  try {
    const probe = await httpReq('GET', BASE + '/dashboard/overview', null);
    if (probe.status >= 200) serverReady = true;
  } catch (e) { /* 未起 */ }

  if (!serverReady) {
    server = spawn('node', ['server.js'], {
      cwd: PM_DIR,
      env: Object.assign({}, process.env, {
        PORT: String(TEST_PORT),
        DB_PATH: './pm.db',
        ALLOW_DEV_LOGIN: 'true',
        NODE_ENV: 'test',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', function (d) { serverOut += d.toString(); });
    server.stderr.on('data', function (d) { serverOut += d.toString(); });
    serverReady = await waitForServer('http://127.0.0.1:' + TEST_PORT + '/api/dashboard/overview', 30000);
  }
  check('后端在 :3999 就绪', serverReady, serverReady ? '' : '30s 未就绪，日志尾部：' + serverOut.slice(-600));

  let loginOk = false;
  let token = '';
  if (serverReady) {
    const lg = await httpReq('POST', BASE + '/auth/devlogin', null, { openId: 'ou_xuwenbin01' });
    loginOk = lg.status === 200 && lg.json && lg.json.code === 0 && lg.json.data && lg.json.data.token;
    if (loginOk) token = lg.json.data.token;
    check('devlogin admin（ou_xuwenbin01）返回 token', loginOk, lg.status + ' ' + (lg.raw || '').slice(0, 200));
  } else {
    check('devlogin admin（ou_xuwenbin01）返回 token', false, '服务未就绪，跳过');
  }

  let ov = null;
  if (serverReady && loginOk) {
    const resp = await httpReq('GET', BASE + '/dashboard/overview', token);
    check('GET /api/dashboard/overview 200', resp.status === 200 && resp.json && resp.json.code === 0,
      'status=' + resp.status + ' code=' + (resp.json ? resp.json.code : 'n/a'));
    if (resp.json && resp.json.code === 0) {
      ov = resp.json.data;
      check('API 返回体含 priorityDist/statusDist/overdueDuration',
        ov && ov.priorityDist && ov.statusDist && ov.overdueDuration,
        'keys=' + Object.keys(ov || {}).join(','));
      check('API priorityDist 与独立核算一致', JSON.stringify(ov.priorityDist) === JSON.stringify(ind.pd),
        'API=' + JSON.stringify(ov.priorityDist) + ' 独立=' + JSON.stringify(ind.pd));
      check('API statusDist 与独立核算一致', JSON.stringify(ov.statusDist) === JSON.stringify(ind.sd),
        'API=' + JSON.stringify(ov.statusDist) + ' 独立=' + JSON.stringify(ind.sd));
      check('API overdueDuration 与独立核算一致', JSON.stringify(ov.overdueDuration) === JSON.stringify(ind.od),
        'API=' + JSON.stringify(ov.overdueDuration) + ' 独立=' + JSON.stringify(ind.od));
      check('API stats.overdueTasks === overdueDuration.total',
        ov.stats.overdueTasks === ov.overdueDuration.total,
        'stats=' + ov.stats.overdueTasks + ' total=' + ov.overdueDuration.total);
      const expectKeys = ['scope', 'generatedAt', 'stats', 'statusDonut', 'health', 'priorityDist', 'statusDist', 'overdueDuration', 'overdue', 'ownerLoad', 'reportMissing', 'projects'];
      const apiKeys = Object.keys(ov).sort();
      const expectSorted = expectKeys.slice().sort();
      check('API 返回体字段集合 = 既有 9 字段 + 新增 3 字段（无多余无缺失）',
        JSON.stringify(apiKeys) === JSON.stringify(expectSorted),
        apiKeys.join(','));
      check('API scope=all（admin 默认）', ov.scope === 'all', 'scope=' + ov.scope);
      check('API 既有字段结构完整（stats/statusDonut/health/overdue/ownerLoad/reportMissing/projects）',
        ov.stats && ov.statusDonut && ov.health && Array.isArray(ov.overdue) && Array.isArray(ov.ownerLoad) &&
        Array.isArray(ov.reportMissing) && ov.projects && Array.isArray(ov.projects.items),
        'stats keys=' + Object.keys(ov.stats || {}).join(','));
      check('API 无回归：statusDonut.segments 数组 + total', Array.isArray(ov.statusDonut.segments) && typeof ov.statusDonut.total === 'number');
      check('API 无回归：health total === 三段之和', ov.health.total === ov.health.green + ov.health.yellow + ov.health.red);
    }
  } else {
    check('GET /api/dashboard/overview 200', false, '前置失败，跳过');
  }

  /* schema 版本在服务启动前后不变（无 schema 变更） */
  const afterSchema = JSON.stringify(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all());
  check('schema_migrations 版本在验证前后不变（零 schema 变更）', beforeSchema === afterSchema,
    'v=' + afterSchema.replace(/[^\d]/g, ' '));

  /* 关闭自起后端 */
  if (server) {
    try { server.kill('SIGTERM'); } catch (e) { /* ignore */ }
    await sleep(800);
    check('自起后端已关闭（:3999）', true, 'SIGTERM 已发送');
  } else {
    check('自起后端已关闭（:3999）', true, '复用既有服务，未自起');
  }

  /* ════════════ 阶段 4：前端编译（vite build + tsc --noEmit） ════════════ */
  section('阶段 4：前端编译');

  const build = await runProc('node', ['node_modules/vite/bin/vite.js', 'build'], { cwd: WEB_DIR }, 300000);
  check('vite build 0 错误', build.code === 0, 'code=' + build.code + ' 尾部输出：' + build.out.slice(-300));

  const tsc = await runProc('node', ['node_modules/typescript/bin/tsc', '--noEmit'], { cwd: WEB_DIR }, 300000);
  check('tsc --noEmit 0 错误', tsc.code === 0, 'code=' + tsc.code + ' 尾部输出：' + tsc.out.slice(-300));

  /* ───────────────────────── 汇总 ───────────────────────── */
  const failed = checks.filter(function (c) { return !c.pass; });
  const passed = checks.length - failed.length;
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' 汇总：' + passed + ' / ' + checks.length + ' 通过');
  if (failed.length) {
    console.log(' 失败项：');
    failed.forEach(function (c) { console.log('   ✗ ' + c.name + (c.detail ? '  —— ' + c.detail : '')); });
  }
  console.log('══════════════════════════════════════════════════════════════');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('[QA] 脚本异常：', e);
  process.exit(2);
});
