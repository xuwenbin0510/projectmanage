#!/usr/bin/env node
'use strict';
/*
 * B15 独立 QA 验证脚本（严过关 · 全新视角，不复跑工程师验证路径）
 * 目标：验证「工作台数据展示区快速查询/编辑入口」6 文件改动符合
 *       docs/B15-PRD.md §7 验收标准（P0 11 项 + P1 4 项）与 docs/B15-架构设计.md 施工图，
 *       并做 B13/B14 红线回归 + 编译级 + 动态级验证。
 *
 * 方法（断言式脚本，可重复跑）：
 *   A 组 · 静态源码断言：6 个改动文件逐点核对（props 最终签名 / mode 分支 /
 *         MyTasksDrawer 六列 / 空态三分支 / PAGE_SIZE=8 / 行点击 / WorkbenchPage 四入口）
 *   B 组 · 红线回归：DonutChart / StatCard(Widgets) / DataTable / PriorityDonut 零 B15 改动；
 *         server/** 零改动；组件代码内无 `new Date()`；优先级走 normalizePriority/
 *         PRIORITY_OPTIONS；日期走 utils/date
 *   C 组 · 编译级：tsc --noEmit 0 错误；vite build 0 错误
 *   D 组 · 动态级：后端 :3000（不在则起 3999）devlogin → GET /api/workbench
 *         myTasks 含 projectId/projectName、reportReminders 含 projectId；
 *         vite dev :5173 页面 200
 *
 * 数据安全：本脚本**只读**——仅 GET 接口 + devlogin（查用户签发令牌，不写库），
 *           不直连 pm.db 写入任何数据；无事务/还原需求（B15 纯前端、零后端改动）。
 *
 * 运行：node scripts/qa_b15_verify.cjs        （从 pm-app 根目录）
 * 退出码：0 = 全绿；1 = 有断言失败；2 = 脚本异常
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PM_DIR = path.resolve(__dirname, '..');
const WEB_DIR = path.join(PM_DIR, 'web');
const SRC = path.join(WEB_DIR, 'src');
const TEST_PORT = 3999;
const MAIN_PORT = 3000;
const DEV_PORT = 5173;

/* 6 个改动文件（相对 web/src） */
const FILES = {
  types: path.join(SRC, 'types/dashboard.ts'),
  progressDonut: path.join(SRC, 'components/dashboard/ProgressDonut.tsx'),
  overdueDrawer: path.join(SRC, 'components/dashboard/OverdueTaskDrawer.tsx'),
  myTasksDrawer: path.join(SRC, 'components/dashboard/MyTasksDrawer.tsx'),
  barrel: path.join(SRC, 'components/dashboard/index.ts'),
  workbench: path.join(SRC, 'pages/WorkbenchPage.tsx'),
};

/* ───────────────────────── 结果收集 ───────────────────────── */
const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail || '' });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log('  [' + tag + '] ' + name + (detail ? '  —— ' + detail : ''));
}

/* ───────────────────────── 工具 ───────────────────────── */
function read(file) {
  return fs.readFileSync(file, 'utf8');
}
function has(src, re) {
  return re.test(src);
}
/** 断言 src 含某正则；detail 为失败时的说明 */
function assertHas(fileLabel, src, re, label) {
  check(label, has(src, re), has(src, re) ? '' : fileLabel + ' 缺失模式: ' + re);
}
/** 断言 src 不含某正则（跳过注释行） */
function assertNoCodeLine(fileLabel, src, re, label) {
  const lines = src.split('\n');
  const bad = [];
  lines.forEach(function (ln, i) {
    const t = ln.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/')) return;
    if (t.indexOf('禁止') >= 0) return;
    if (re.test(ln)) bad.push((i + 1) + ':' + ln.trim());
  });
  check(label, bad.length === 0, bad.length ? fileLabel + ' 命中行: ' + bad.join(' | ') : '');
}
/** 取接口块文本（精确匹配接口名） */
function interfaceBlock(src, iface) {
  const re = new RegExp('export\\s+interface\\s+' + iface + '(?![A-Za-z0-9_])\\s*\\{', 'm');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0, end = -1;
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  return end >= 0 ? src.slice(start, end + 1) : null;
}
/** HTTP 请求（原生 http，兼容旧 Node） */
function httpReq(method, urlPath, token, body) {
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(urlPath);
    const opts = {
      host: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000,
    };
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(opts, function (res) {
      let buf = '';
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw: buf });
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}
/** spawn 并收集退出码与输出 */
function runProcess(cmd, args, cwd, timeoutMs) {
  return new Promise(function (resolve) {
    const child = spawn(cmd, args, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', function (d) { out += d.toString(); });
    child.stderr.on('data', function (d) { out += d.toString(); });
    const timer = setTimeout(function () {
      try { child.kill(); } catch (e) { /* ignore */ }
      resolve({ code: -1, out: out + '\n[timeout after ' + timeoutMs + 'ms]' });
    }, timeoutMs);
    child.on('close', function (code) {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}
/** 递归收集目录下文件（按扩展名过滤） */
function listFiles(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (ent) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', 'dist', '.git', '.vite'].indexOf(ent.name) >= 0) return;
      out.push.apply(out, listFiles(p, exts));
    } else if (exts.some(function (e) { return ent.name.endsWith(e); })) {
      out.push(p);
    }
  });
  return out;
}
/** 今天 YYYY-MM-DD（UTC 安全） */
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
/** 加 N 天（UTC 安全，避免 DST 偏移） */
function addDaysStr(base, n) {
  const p = base.split('-').map(Number);
  const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return dt.getUTCFullYear() + '-' +
    String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(dt.getUTCDate()).padStart(2, '0');
}

/* ───────────────────────── 主流程 ───────────────────────── */
async function main() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' B15 QA 验证脚本 · 严过关（工作台快速查询/编辑入口）');
  console.log(' 依据：docs/B15-PRD.md §7 验收 + docs/B15-架构设计.md 施工图');
  console.log('══════════════════════════════════════════════════════════════');

  /* ════════════════ A 组 · 静态源码断言 ════════════════ */
  console.log('\n── A 组：6 文件静态源码断言 ──');
  const types = read(FILES.types);
  const progressDonut = read(FILES.progressDonut);
  const overdueDrawer = read(FILES.overdueDrawer);
  const myTasksDrawer = read(FILES.myTasksDrawer);
  const barrel = read(FILES.barrel);
  const workbench = read(FILES.workbench);

  /* ── A1. types/dashboard.ts ── */
  console.log('  [A1] types/dashboard.ts');
  assertHas('types/dashboard.ts', types, /export type ProgressSegment = 'done' \| 'active' \| 'pending';/,
    'ProgressSegment 类型已定义（done/active/pending）');
  const otRow = interfaceBlock(types, 'OverdueTaskRow');
  check('OverdueTaskRow 接口存在', !!otRow, otRow ? '' : '未找到接口');
  if (otRow) {
    check('OverdueTaskRow.projectId 必填字段（B15）', /projectId:\s*string;/.test(otRow), 'projectId 缺失或非 string');
    check('OverdueTaskRow.projectName 必填字段（B15）', /projectName:\s*string;/.test(otRow), 'projectName 缺失或非 string');
    check('OverdueTaskRow 既有字段保留（id/wbsCode/name/ownerId/ownerName/dueDate/status/progress/milestoneName/priority/priorityRank）',
      ['id', 'wbsCode', 'name', 'ownerId', 'ownerName', 'dueDate', 'status', 'progress', 'milestoneName', 'priority', 'priorityRank']
        .every(function (f) { return new RegExp('\\b' + f + ':').test(otRow); }),
      '有既有字段缺失');
  }

  /* ── A2. ProgressDonut.tsx ── */
  console.log('  [A2] ProgressDonut.tsx');
  const pdProps = interfaceBlock(progressDonut, 'ProgressDonutProps');
  check('ProgressDonutProps.onDrill?: (segment: ProgressSegment) => void 已加',
    !!pdProps && /onDrill\?:\s*\(segment:\s*ProgressSegment\)\s*=>\s*void;/.test(pdProps), '');
  check('函数解构含 onDrill', /function ProgressDonut\(\{ summary, loading = false, onDrill \}: ProgressDonutProps\)/.test(progressDonut), '');
  check('onSegmentClick 透传 onDrill（不传则 undefined 不可点）',
    /onSegmentClick=\{onDrill \? \(seg\) => onDrill\(seg\.id as ProgressSegment\) : undefined\}/.test(progressDonut), '');
  check('三段 segments 仍为 done/active/pending',
    /id: 'done'[\s\S]*id: 'active'[\s\S]*id: 'pending'/.test(progressDonut), '');

  /* ── A3. OverdueTaskDrawer.tsx ── */
  console.log('  [A3] OverdueTaskDrawer.tsx（B13 单项目模式必须逐字保留）');
  const ovProps = interfaceBlock(overdueDrawer, 'OverdueTaskDrawerProps');
  check('props 接口存在', !!ovProps, '');
  if (ovProps) {
    check('mode?: \'project\' | \'all\' 可选字段已加', /mode\?:\s*'project' \| 'all';/.test(ovProps), '');
    check('projects?: Array<{projectId,projectName}> 可选字段已加',
      /projects\?:[\s\S]*?Array<\{[\s\S]*?projectId:\s*string;[\s\S]*?projectName:\s*string[\s\S]*?\}>/.test(ovProps), '');
    check('既有 props（open/projectId/projectName?/initialTab?/currentUserId?/onClose）保留',
      ['open:', 'projectId:', 'projectName?:', 'initialTab?:', 'currentUserId?:', 'onClose:'].every(function (f) { return ovProps.indexOf(f) >= 0; }),
      '有既有字段缺失');
  }
  check('mode 缺省 = \'project\'（B13 路径默认）', /mode = 'project'/.test(overdueDrawer), 'mode 缺省必须是 project');
  check('ScopedWbsNode 内部类型（__projectId/__projectName）',
    /interface ScopedWbsNode extends WbsNode \{[\s\S]*__projectId: string;[\s\S]*__projectName: string;/.test(overdueDrawer), '');
  check('nodes state 类型为 ScopedWbsNode[]', /useState<ScopedWbsNode\[\]>\(\[\]\)/, '');
  check('msMap 注释/声明为复合 key（projectId::milestoneId）',
    /Map<string, string>/.test(overdueDrawer) && /::/.test(overdueDrawer), '');
  /* load 分支 */
  check('all 模式 load：Promise.all(projectList.map(...listWbs+listMilestones))',
    /if \(mode === 'all'\) \{[\s\S]*Promise\.all\([\s\S]*projectList\.map\(\(p\) =>[\s\S]*Promise\.all\(\[api\.listWbs\(p\.projectId\), api\.listMilestones\(p\.projectId\)\]\)/.test(overdueDrawer), '');
  check('project 模式 load：单项目 Promise.all([listWbs(projectId), listMilestones(projectId)])',
    /Promise\.all\(\[[\s\S]*api\.listWbs\(projectId\)[\s\S]*api\.listMilestones\(projectId\)[\s\S]*\]\)/.test(overdueDrawer), '');
  check('all 模式扁平化节点带 __projectId/__projectName',
    /allNodes\.push\(\{ \.\.\.n, __projectId: pid, __projectName: pname \}\)/.test(overdueDrawer), '');
  check('msMap 写入用复合 key `${pid}::${m.id}`', /map\.set\(`\$\{pid\}::\$\{m\.id\}`, m\.name \|\| ''\)/.test(overdueDrawer), '');
  check('project 模式 msMap 写入同样复合 key `${pid}::${m.id}`',
    /map\.set\(`\$\{pid\}::\$\{m\.id\}`, m\.name \|\| ''\)/.test(overdueDrawer), '');
  check('load deps 含 [mode, projectId, projectName, projects]',
    /\}, \[mode, projectId, projectName, projects\]\);/.test(overdueDrawer), '');
  check('useEffect 守卫：project 无 projectId 不拉 / all 无 projects 不拉',
    /if \(mode === 'project' && !projectId\) return;[\s\S]*if \(mode === 'all' && !\(Array\.isArray\(projects\) && projects\.length > 0\)\) return;/.test(overdueDrawer), '');
  check('useEffect deps 含 open/mode/projectId/projects/initialTab/load',
    /\[open, mode, projectId, projects, initialTab, load\]\);/.test(overdueDrawer), '');
  /* baseRows */
  check('baseRows 行带 projectId = n.__projectId', /projectId:\s*n\.__projectId,/.test(overdueDrawer), '');
  check('baseRows 行带 projectName = n.__projectName', /projectName:\s*n\.__projectName,/.test(overdueDrawer), '');
  check('里程碑解析用复合 key `${n.__projectId}::${n.milestoneId}`',
    /msMap\.get\(`\$\{n\.__projectId\}::\$\{n\.milestoneId\}`\)/.test(overdueDrawer), '');
  check('排序仍用 comparePriority（P0 置顶唯一实现）', /\.sort\(comparePriority\)/.test(overdueDrawer), '');
  check('involvedProjects = 当前 Tab 行去重项目数',
    /const involvedProjects = useMemo\([\s\S]*new Set\(baseRows\.map\(\(r\) => r\.projectId\)\)\.size/.test(overdueDrawer), '');
  /* 头部 */
  check('标题：all 模式「全部项目 · 逾期 / 临期明细」，project 模式原名',
    /mode === 'all'[\s\S]*?\? '全部项目 · 逾期 \/ 临期明细'[\s\S]*?: `\$\{projectName \|\| '项目'\} · 逾期 \/ 临期明细`/.test(overdueDrawer), '');
  check('副标题：all 模式追加「涉及 K 个项目」', /· 涉及 \$\{involvedProjects\} 个项目/.test(overdueDrawer), '');
  check('all 模式且 currentUserId 时显示「含他人任务」提示行（P1-3）',
    /mode === 'all' && currentUserId \? \([\s\S]*含他人任务，可开「仅看我」对齐卡片数值/.test(overdueDrawer), '');
  /* 列 */
  check('all 模式列尾追加「所属项目」列（key projectName / width 110 / hideOnMobile）',
    /if \(mode === 'all'\) \{[\s\S]*key: 'projectName',[\s\S]*label: '所属项目',[\s\S]*width: 110,[\s\S]*hideOnMobile: true/.test(overdueDrawer), '');
  check('project 模式列定义保留七列（priority/name/ownerName/dueDate/status/progress/milestoneName）',
    ['key: \'priority\'', 'key: \'name\'', 'key: \'ownerName\'', 'key: \'dueDate\'', 'key: \'status\'', 'key: \'progress\'', 'key: \'milestoneName\'']
      .every(function (k) { return new RegExp(k).test(overdueDrawer); }), '七列有缺失');
  check('行点击跳对应项目 WBS：navigate(ROUTES.projectWbs(row.projectId))',
    /onRowClick=\{\(row\) => navigate\(ROUTES\.projectWbs\(row\.projectId\)\)\}/.test(overdueDrawer), '');
  /* 空态 */
  check('project 模式空态原文案保留（该项目暂无已逾期任务 / 该项目暂无临期任务）',
    /'该项目暂无已逾期任务'/.test(overdueDrawer) && /'该项目暂无临期任务'/.test(overdueDrawer), '');
  check('all 模式空态：太好了，没有逾期任务 / 未来 3 天内没有待完成的任务',
    /'太好了，没有逾期任务'/.test(overdueDrawer) && /'未来 3 天内没有待完成的任务'/.test(overdueDrawer), '');
  check('筛选无匹配统一「当前筛选条件下没有匹配的任务」',
    /'当前筛选条件下没有匹配的任务'/.test(overdueDrawer), '');
  /* 其他 */
  check('PAGE_SIZE = 8', /const PAGE_SIZE = 8;/.test(overdueDrawer), '');
  check('分页阈值 filteredRows.length > PAGE_SIZE', /filteredRows\.length > PAGE_SIZE/.test(overdueDrawer), '');
  check('ErrorState 重试 onRetry={() => void load()}（load 已无参）',
    /onRetry=\{\(\) => void load\(\)\}/.test(overdueDrawer), '');
  check('双 Tab 逾期/临期保留', /<Tab label="逾期" value="overdue" \/>/.test(overdueDrawer) && /<Tab label="临期" value="dueSoon" \/>/.test(overdueDrawer), '');
  check('仅看我开关（currentUserId 传入时显示）', /FormControlLabel[\s\S]*label="仅看我负责"/.test(overdueDrawer), '');
  assertNoCodeLine('OverdueTaskDrawer', overdueDrawer, /wbsStore/, '不写 wbsStore（局部拉取，关闭即丢弃；仅注释提及）');
  check('优先级归一走 normalizePriority / priorityRankOf', /normalizePriority\(n\.priority\)/.test(overdueDrawer) && /priorityRankOf\(n\.priority\)/.test(overdueDrawer), '');
  check('优先级下拉选项走 PRIORITY_OPTIONS', /PRIORITY_OPTIONS\.map/.test(overdueDrawer), '');

  /* ── A4. MyTasksDrawer.tsx（新建） ── */
  console.log('  [A4] MyTasksDrawer.tsx（新建）');
  const mtProps = interfaceBlock(myTasksDrawer, 'MyTasksDrawerProps');
  check('MyTasksDrawerProps 定义在组件文件内（与 OverdueTaskDrawerProps 同风格）', !!mtProps, '');
  if (mtProps) {
    check('props: open/tasks/initialProgress?/initialPriority?/onClose',
      ['open:', 'tasks:', 'initialProgress?:', 'initialPriority?:', 'onClose:'].every(function (f) { return mtProps.indexOf(f) >= 0; }),
      '有字段缺失');
  }
  check('PAGE_SIZE = 8（与 OverdueTaskDrawer 一致）', /const PAGE_SIZE = 8;/.test(myTasksDrawer), '');
  check('进度段分类 progressSegmentOf 镜像 aggregateTaskProgress（done=完成 / active=进行中+待评审 / pending=待办+阻塞+default）',
    /case '完成':\s*return 'done';[\s\S]*case '进行中':[\s\S]*case '待评审':\s*return 'active';[\s\S]*case '待办':[\s\S]*case '阻塞':[\s\S]*default:\s*return 'pending';/.test(myTasksDrawer), '');
  check('打开时按 initialProgress/initialPriority 预置并复位筛选/分页',
    /setProgressFilter\(initialProgress \?\? ''\);[\s\S]*setPriorityFilter\(initialPriority \?\? ''\);[\s\S]*setPage\(1\)/.test(myTasksDrawer), '');
  check('筛选顺序：进度段 → 优先级 → 状态 → 关键字（任一变化复位分页）',
    /progressFilter && progressSegmentOf\(t\.status\) !== progressFilter[\s\S]*priorityFilter && normalizePriority\(t\.priority\) !== priorityFilter[\s\S]*statusFilter && t\.status !== statusFilter[\s\S]*`\$\{t\.wbsCode\} \$\{t\.name\} \$\{t\.projectName \?\? \'\'\}`/.test(myTasksDrawer), '');
  /* 六列 */
  const colBlock = (function () {
    const startMarker = 'const columns = useMemo<Array<Column<WbsNode>>>(() => [';
    const idx = myTasksDrawer.indexOf(startMarker);
    if (idx < 0) return null;
    const endMarker = '], []);';
    const endIdx = myTasksDrawer.indexOf(endMarker, idx + startMarker.length);
    if (endIdx < 0) return null;
    return myTasksDrawer.slice(idx + startMarker.length, endIdx);
  })();
  check('六列定义存在', !!colBlock, colBlock ? '' : '未提取到 columns 数组');
  if (colBlock) {
    check('六列键：priority/name/projectName/dueDate/status/progress',
      ['priority', 'name', 'projectName', 'dueDate', 'status', 'progress'].every(function (k) { return new RegExp("key: '" + k + "'").test(colBlock); }),
      '有列缺失');
    check('不含里程碑列（决策 #5：myTasks 无 milestoneName，不额外拉取）',
      !/milestone/.test(colBlock), colBlock.match(/milestone/) ? 'columns 中出现 milestone' : '');
    check('列宽符合施工图（优先级62/项目名110/截止日96/状态70/进度88）',
      /width: 62/.test(colBlock) && /width: 110/.test(colBlock) && /width: 96/.test(colBlock) && /width: 70/.test(colBlock) && /width: 88/.test(colBlock), '');
  }
  check('截止日逾期红/临期黄走 utils/date（isOverdue + diffDays(today(), dueDate)<=3）',
    /const overdue = isOverdue\(r\.dueDate\);[\s\S]*const soon = !overdue && diffDays\(today\(\), r\.dueDate\) <= 3;/.test(myTasksDrawer), '');
  check('行点击跳 ROUTES.projectWbs(row.projectId)',
    /onRowClick=\{\(row\) => navigate\(ROUTES\.projectWbs\(row\.projectId\)\)\}/.test(myTasksDrawer), '');
  check('空态三分支：无任务 / 已完成段 / 筛选无匹配',
    /'没有分配给我的未完成任务'/.test(myTasksDrawer) &&
    /progressFilter === 'done'[\s\S]*?'没有已完成任务'/.test(myTasksDrawer) &&
    /'已完成任务请在项目 WBS 查看'/.test(myTasksDrawer) &&
    /'当前筛选条件下没有匹配的任务'/.test(myTasksDrawer) &&
    /'试试调整筛选条件'/.test(myTasksDrawer), '');
  check('抽屉零请求（无 api 调用 / 无 listMilestones / 无 wbsStore）',
    !/api\.(listWbs|listMilestones|getWorkbench|moveTask)/.test(myTasksDrawer) && !/wbsStore/.test(myTasksDrawer), '');
  check('优先级归一走 normalizePriority、下拉走 PRIORITY_OPTIONS',
    /normalizePriority\(r\.priority\)/.test(myTasksDrawer) && /PRIORITY_OPTIONS\.map/.test(myTasksDrawer), '');
  check('日期走 utils/date（isOverdue/diffDays/today/fmtDate 均已 import）',
    /import \{ diffDays, fmtDate, isOverdue, today \} from '.\/.\/utils\/date';/.test(myTasksDrawer) ||
    /from '@\/utils\/date'/.test(myTasksDrawer), '');
  check('分页（P1-2）：filteredRows.length > PAGE_SIZE 启用', /filteredRows\.length > PAGE_SIZE/.test(myTasksDrawer), '');
  check('状态下拉保序去重（P1-1）', /Array\.from\(new Set\(tasks\.map\(\(t\) => t\.status\)\)\)/.test(myTasksDrawer), '');
  check('抽屉骨架：Drawer anchor="right" + width 420 + maxWidth 92vw',
    /<Drawer anchor="right" open=\{open\} onClose=\{onClose\}>[\s\S]*width: 420,[\s\S]*maxWidth: '92vw'/.test(myTasksDrawer), '');
  check('头部标题「我的任务明细」+ 副标题「共 N 个未完成 · 按优先级排序」',
    /我的任务明细/.test(myTasksDrawer) && /共 \{tasks\.length\} 个未完成 · 按优先级排序/.test(myTasksDrawer), '');

  /* ── A5. barrel ── */
  console.log('  [A5] components/dashboard/index.ts');
  check('barrel 导出 MyTasksDrawer', /export \{ MyTasksDrawer \} from '\.\/MyTasksDrawer';/.test(barrel), '');
  check('barrel 导出 MyTasksDrawerProps 类型', /export type \{ MyTasksDrawerProps \} from '\.\/MyTasksDrawer';/.test(barrel), '');

  /* ── A6. WorkbenchPage.tsx ── */
  console.log('  [A6] WorkbenchPage.tsx（四入口接线）');
  check('ovDrawer state 含 mode: \'project\' | \'all\'，初始 mode project',
    /mode: 'project' \| 'all';[\s\S]*\{ open: false, mode: 'project', projectId: '', projectName: '' \}/.test(workbench), '');
  check('myTasksDrawer state { open, progress?, priority? }',
    /const \[myTasksDrawer, setMyTasksDrawer\] = useState<\{[\s\S]*open: boolean;[\s\S]*progress\?: ProgressSegment;[\s\S]*priority\?: Priority;[\s\S]*\}>\(\{ open: false \}\);/.test(workbench), '');
  check('openOverdue（B13 柱形）补 mode: \'project\'，行为不变',
    /const openOverdue = \(projectId: string\): void => \{[\s\S]*setOvDrawer\(\{ open: true, mode: 'project', projectId, projectName: name \}\)/ .test(workbench), '');
  check('openGlobalOverdue → mode: \'all\'（P0-1）',
    /const openGlobalOverdue = \(\): void => \{[\s\S]*setOvDrawer\(\{ open: true, mode: 'all', projectId: '', projectName: '' \}\)/ .test(workbench), '');
  check('openMyTasks 三入口共用（opts 缺省 {} = 查看全部）',
    /const openMyTasks = \(opts: \{ progress\?: ProgressSegment; priority\?: Priority \} = \{\}\): void => \{[\s\S]*setMyTasksDrawer\(\{ open: true, progress: opts\.progress, priority: opts\.priority \}\)/ .test(workbench), '');
  check('逾期卡 onClick={openGlobalOverdue}（P0-1）', /onClick=\{openGlobalOverdue\}/.test(workbench), '');
  check('逾期卡 hint「点击查看全部逾期任务」（P1-5）', /hint="点击查看全部逾期任务"/.test(workbench), '');
  check('周报卡 onClick：missing>0 时跳 missing[0].projectId（P0-4）',
    /if \(missing\.length > 0\) navigate\(ROUTES\.projectReports\(missing\[0\]\.projectId\)\)/.test(workbench), '');
  check('周报卡 hint 条件化（缺失>0 引导填写；=0 不引导空点）',
    /hint=\{missing\.length > 0 \? '点击前往填写' : '本周周报已全部填写'\}/.test(workbench), '');
  check('missing = reportReminders.filter(!filled)', /const missing = reportReminders\.filter\(\(r\) => !r\.filled\);/.test(workbench), '');
  check('进度环 onDrill → openMyTasks({ progress: seg })（P0-6）',
    /<ProgressDonut[\s\S]*onDrill=\{\(seg\) => openMyTasks\(\{ progress: seg \}\)\}/.test(workbench), '');
  check('优先级环 onDrill → openMyTasks({ priority: pri })（P0-7，PriorityDonut 零改动）',
    /<PriorityDonut[\s\S]*onDrill=\{\(pri\) => openMyTasks\(\{ priority: pri \}\)\}/.test(workbench), '');
  check('「我的任务」SectionCard actions「查看全部」→ openMyTasks({})（P0-10，仅 myTasks>0 显示）',
    /myTasks\.length > 0 \? \([\s\S]*<Button size="small" onClick=\{\(\) => openMyTasks\(\{\}\)\}>[\s\S]*?查看全部[\s\S]*?<\/Button>/.test(workbench), '');
  check('OverdueTaskDrawer 渲染传 mode/projectId/projectName/projects={dashboard.overdue}/currentUserId',
    /<OverdueTaskDrawer[\s\S]*mode=\{ovDrawer\.mode\}[\s\S]*projectId=\{ovDrawer\.projectId\}[\s\S]*projectName=\{ovDrawer\.projectName\}[\s\S]*projects=\{dashboard\.overdue\}[\s\S]*currentUserId=\{me\?\.openId\}/.test(workbench), '');
  check('MyTasksDrawer 渲染传 tasks={sortedTasks}/initialProgress/initialPriority',
    /<MyTasksDrawer[\s\S]*tasks=\{sortedTasks\}[\s\S]*initialProgress=\{myTasksDrawer\.progress\}[\s\S]*initialPriority=\{myTasksDrawer\.priority\}/.test(workbench), '');
  check('sortedTasks = sortByPriority(data?.myTasks ?? [])（P0 置顶、与区块同源同序）',
    /const sortedTasks = useMemo\(\(\) => sortByPriority\(data\?\.myTasks \?\? \[\]\), \[data\]\);/.test(workbench), '');
  /* 既有功能保留 */
  check('B13 柱形点击保留：OverdueBarChart onDrill={openOverdue}', /<OverdueBarChart[\s\S]*onDrill=\{openOverdue\}/.test(workbench), '');
  check('周报「去填写」按钮保留', /'去填写'/.test(workbench), '');
  check('待我审批 StatCard 点击保留（navigate(ROUTES.approvals)）',
    /<StatCard[\s\S]*onClick=\{\(\) => navigate\(ROUTES\.approvals\)\}/.test(workbench), '');
  check('健康分布条跳转保留（navigate(ROUTES.projects)）',
    /<HealthDistBar[\s\S]*onDrill=\{\(\) => navigate\(ROUTES\.projects\)\}/.test(workbench), '');
  check('「我的任务」区块前 8 条展示保留', /sortedTasks\.slice\(0, 8\)/.test(workbench), '');
  check('区块内行内状态 Select（handleStatus）保留', /handleStatus\(t\.id, e\.target\.value as TaskStatus, t\.boardOrder\)/.test(workbench), '');
  check('useMemo 在早退前调用（Hooks 顺序稳定）',
    workbench.indexOf('const dashboard = useMemo(() => buildDashboard(data), [data]);') < workbench.indexOf('if (loading && !data) return') &&
    workbench.indexOf('const sortedTasks = useMemo') < workbench.indexOf('if (loading && !data) return'), '');

  /* ════════════════ B 组 · 红线回归 ════════════════ */
  console.log('\n── B 组：红线回归（B13/B14 不动 + server 零改动 + 口径红线）──');
  const donut = read(path.join(SRC, 'components/dashboard/DonutChart.tsx'));
  const widgets = read(path.join(SRC, 'components/common/Widgets.tsx'));
  const dataTable = read(path.join(SRC, 'components/common/DataTable.tsx'));
  const priDonut = read(path.join(SRC, 'components/dashboard/PriorityDonut.tsx'));
  check('DonutChart.tsx 无 B15 改动痕迹', !/B15/.test(donut), /B15/.test(donut) ? '含 B15 字样' : '');
  check('DonutChart 已具备 onSegmentClick（环体+图例点击）',
    /onSegmentClick\?: \(segment: DonutSegment\) => void;/.test(donut) && /onItemClick/.test(donut), '');
  check('StatCard(Widgets.tsx) 无 B15 改动痕迹', !/B15/.test(widgets), /B15/.test(widgets) ? '含 B15 字样' : '');
  check('StatCard 已支持 onClick（cursor:pointer + hover 抬起）',
    /onClick\?: \(\) => void;/.test(widgets) && /cursor: onClick \? 'pointer' : 'default'/.test(widgets), '');
  check('DataTable.tsx 无 B15 改动痕迹', !/B15/.test(dataTable), /B15/.test(dataTable) ? '含 B15 字样' : '');
  check('DataTable 已支持 onRowClick + 分页（1 起，内部转 0 起）',
    /onRowClick\?: \(row: T\) => void;/.test(dataTable) && /Math\.max\(0, pagination\.page - 1\)/.test(dataTable) && /pagination\.onChange\(p \+ 1, pagination\.pageSize\)/.test(dataTable), '');
  check('PriorityDonut.tsx 无 B15 改动痕迹', !/B15/.test(priDonut), /B15/.test(priDonut) ? '含 B15 字样' : '');
  check('PriorityDonut onDrill prop 已就绪（B14 既有，仅工作台接线）',
    /onDrill\?: \(priority: Priority\) => void;/.test(priDonut) && /onSegmentClick=\{onDrill \? \(seg\) => onDrill\(seg\.id as Priority\) : undefined\}/.test(priDonut), '');
  /* server/** 零改动 */
  const serverFiles = listFiles(path.join(PM_DIR, 'server'), ['.js', '.json', '.sql']);
  const serverB15 = serverFiles.filter(function (f) { return /B15/.test(read(f)); });
  check('server/** 无 B15 改动痕迹（共扫描 ' + serverFiles.length + ' 个文件）', serverB15.length === 0,
    serverB15.length ? '命中: ' + serverB15.join(', ') : '');
  /* 组件代码内无 new Date() */
  [['OverdueTaskDrawer', overdueDrawer], ['MyTasksDrawer', myTasksDrawer], ['WorkbenchPage', workbench], ['ProgressDonut', progressDonut]]
    .forEach(function (pair) {
      assertNoCodeLine(pair[0] + '.tsx', pair[1], /new Date\(/, pair[0] + ' 代码内无 new Date()（日期走 utils/date）');
    });
  /* 优先级/日期口径红线 */
  check('MyTasksDrawer 优先级走 normalizePriority / PRIORITY_OPTIONS（无字符串直接比较）',
    /normalizePriority/.test(myTasksDrawer) && /PRIORITY_OPTIONS/.test(myTasksDrawer), '');
  check('OverdueTaskDrawer 优先级走 normalizePriority / priorityRankOf / PRIORITY_OPTIONS',
    /normalizePriority/.test(overdueDrawer) && /priorityRankOf/.test(overdueDrawer) && /PRIORITY_OPTIONS/.test(overdueDrawer), '');
  check('OverdueTaskDrawer 日期口径经 splitOverdueByStatus（dashboardAgg → utils/date）',
    /splitOverdueByStatus/.test(overdueDrawer) && /fmtDate/.test(overdueDrawer), '');

  /* ════════════════ C 组 · 编译级 ════════════════ */
  console.log('\n── C 组：编译级（tsc + vite build 独立复核）──');
  if (process.env.QA_SKIP_COMPILE === '1') {
    console.log('  ⚠ QA_SKIP_COMPILE=1，跳过编译级（手动已跑）');
  } else {
    const tsc = await runProcess('node', ['node_modules/typescript/bin/tsc', '--noEmit'], WEB_DIR, 240000);
    check('npx tsc --noEmit 0 错误', tsc.code === 0, tsc.code === 0 ? '通过' : ('退出码 ' + tsc.code + '；尾部：' + tsc.out.slice(-500)));
    const vite = await runProcess('node', ['node_modules/vite/bin/vite.js', 'build'], WEB_DIR, 240000);
    check('vite build 0 错误', vite.code === 0, vite.code === 0 ? '通过' : ('退出码 ' + vite.code + '；尾部：' + vite.out.slice(-500)));
  }

  /* ════════════════ D 组 · 动态级 ════════════════ */
  console.log('\n── D 组：动态级（后端复用 + 接口结构 + 页面可加载）──');

  /* D0. 探测后端：优先 :3000，不在则起 3999（只读使用） */
  let BASE = null;
  let spawned = null;
  try {
    const probe = await httpReq('POST', 'http://127.0.0.1:' + MAIN_PORT + '/api/auth/devlogin', null, { openId: 'ou_xuwenbin01' });
    if (probe.status === 200 && probe.json && probe.json.data && probe.json.data.token) {
      BASE = 'http://127.0.0.1:' + MAIN_PORT;
      check('后端 :' + MAIN_PORT + ' 可复用（devlogin 直接响应）', true, '');
    } else {
      check('后端 :' + MAIN_PORT + ' 探测', false, 'status=' + probe.status);
    }
  } catch (e) {
    check('后端 :' + MAIN_PORT + ' 探测', false, '连接失败：' + e.message);
  }
  if (!BASE) {
    console.log('  ⚠ :3000 未就绪，尝试起测试后端 :' + TEST_PORT + '（只读 GET，不污染 pm.db）');
    spawned = spawn('node', ['server.js'], {
      cwd: PM_DIR,
      env: Object.assign({}, process.env, { PORT: String(TEST_PORT), DB_PATH: './pm.db', NODE_ENV: 'test' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    await new Promise(function (resolve) {
      const onData = function () {
        if (!ready) {
          ready = true;
          resolve();
        }
      };
      spawned.stdout.on('data', onData);
      spawned.stderr.on('data', onData);
      setTimeout(function () { if (!ready) resolve(); }, 20000);
    });
    try {
      const probe2 = await httpReq('POST', 'http://127.0.0.1:' + TEST_PORT + '/api/auth/devlogin', null, { openId: 'ou_xuwenbin01' });
      if (probe2.json && probe2.json.data && probe2.json.data.token) BASE = 'http://127.0.0.1:' + TEST_PORT;
      check('测试后端 :' + TEST_PORT + ' 启动成功', !!BASE, BASE ? '' : 'devlogin 未返回 token');
    } catch (e) {
      check('测试后端 :' + TEST_PORT + ' 启动成功', false, e.message);
    }
  }

  if (BASE) {
    /* D1. devlogin 拿 admin token */
    const login = await httpReq('POST', BASE + '/api/auth/devlogin', null, { openId: 'ou_xuwenbin01' });
    const adminToken = login.json && login.json.data ? login.json.data.token : null;
    check('devlogin(ou_xuwenbin01) → token', !!adminToken, adminToken ? '' : ('status=' + login.status));

    if (adminToken) {
      /* D2. GET /api/workbench 结构（B15 依赖字段） */
      const wb = await httpReq('GET', BASE + '/api/workbench', adminToken);
      const wd = wb.json && wb.json.data;
      check('GET /api/workbench → 200 且有 data', wb.status === 200 && !!wd, 'status=' + wb.status);
      if (wd) {
        check('workbench.myTasks 每行含 projectId（string）', (wd.myTasks || []).every(function (t) { return typeof t.projectId === 'string' && t.projectId.length > 0; }),
          'myTasks=' + (wd.myTasks || []).length);
        check('workbench.myTasks 每行含 projectName（string，B11/B15 依赖）', (wd.myTasks || []).every(function (t) { return typeof t.projectName === 'string'; }),
          'myTasks=' + (wd.myTasks || []).length);
        check('workbench.reportReminders 每行含 projectId（string）', (wd.reportReminders || []).every(function (r) { return typeof r.projectId === 'string' && r.projectId.length > 0; }),
          'reportReminders=' + (wd.reportReminders || []).length);
        /* 独立核算：stats.overdueTasks = 我负责的逾期叶子数（日期字符串比较，口径同 countOverdue） */
        const today = todayStr();
        const indepOverdue = (wd.myTasks || []).filter(function (t) { return t.dueDate && String(t.dueDate) < today; }).length;
        check('stats.overdueTasks 与独立核算一致（= 我负责的逾期任务数）',
          wd.stats && wd.stats.overdueTasks === indepOverdue,
          'stats=' + (wd.stats ? wd.stats.overdueTasks : '?') + ' 独立=' + indepOverdue);
        /* 全局抽屉依赖：dashboard.overdue 涉及项目名非空（前端聚合的输入数据） */
        const overdueProjects = new Set((wd.myTasks || []).filter(function (t) { return t.dueDate && String(t.dueDate) < today; }).map(function (t) { return t.projectId; }));
        const projectNameOk = (wd.myTasks || []).every(function (t) {
          if (!overdueProjects.has(t.projectId)) return true;
          return typeof t.projectName === 'string' && t.projectName.length > 0;
        });
        check('dashboard.overdue 涉及项目均有 projectName（全局抽屉「所属项目」列可渲染）', projectNameOk,
          '逾期涉及项目数=' + overdueProjects.size);
      }
      /* D3. PM 用户视角：reportReminders 含未填且带 projectId（周报卡直达数据源） */
      const pmLogin = await httpReq('POST', BASE + '/api/auth/devlogin', null, { openId: 'ou_liming03' });
      const pmToken = pmLogin.json && pmLogin.json.data ? pmLogin.json.data.token : null;
      if (pmToken) {
        const pmWb = await httpReq('GET', BASE + '/api/workbench', pmToken);
        const pmd = pmWb.json && pmWb.json.data;
        const missing = (pmd && pmd.reportReminders || []).filter(function (r) { return !r.filled; });
        check('PM(ou_liming03) 有未填周报且带 projectId（周报卡 missing[0] 可直达）',
          pmd && missing.length > 0 && missing.every(function (r) { return typeof r.projectId === 'string' && r.projectId.length > 0; }),
          'missing=' + missing.length);
      } else {
        check('PM(ou_liming03) devlogin → token', false, '未取到 token');
      }
    }
  }

  /* D4. vite dev 页面可加载 */
  try {
    const dev = await httpReq('GET', 'http://127.0.0.1:' + DEV_PORT + '/', null, null);
    check('vite dev :' + DEV_PORT + ' 返回 200', dev.status === 200, 'status=' + dev.status);
  } catch (e) {
    check('vite dev :' + DEV_PORT + ' 返回 200', false, '连接失败：' + e.message);
  }

  /* 关闭自起后端 */
  if (spawned) { try { spawned.kill('SIGTERM'); } catch (e) { /* ignore */ } }

  /* ───────────────────────── 汇总 ───────────────────────── */
  const passed = checks.filter(function (c) { return c.pass; }).length;
  const failed = checks.length - passed;
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' 汇总：' + passed + ' 通过 / ' + failed + ' 失败 / 共 ' + checks.length);
  console.log(' 数据安全：本脚本只读（GET + devlogin），未写 pm.db');
  console.log('══════════════════════════════════════════════════════════════');
  if (failed > 0) {
    console.log('\n失败明细：');
    checks.filter(function (c) { return !c.pass; }).forEach(function (c) {
      console.log('  ✗ ' + c.name + (c.detail ? '  → ' + c.detail : ''));
    });
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('脚本异常：', e);
  process.exit(2);
});
