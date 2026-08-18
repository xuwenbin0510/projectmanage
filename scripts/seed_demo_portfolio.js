/**
 * 演示组合数据注入（B12 仪表盘可用化）
 *
 * 现状：库内 15 个项目里 12 个是 B3 冒烟测试残留（草稿状态），在管三态（已批准/进行中/挂起）
 * 只命中 1 个红灯项目，导致 B12 全局仪表盘几乎为空。
 *
 * 本脚本**新增** 10 个在管三态的真实风格项目（太空数据中心主题），每个都带：
 *  - 1 名 PM（project_members, project_role='pm'，驱动 pmName）
 *  - 3~5 个里程碑（部分 done_at 落地 → 进度差异；planned_date 驱动下个里程碑日期）
 *  - 1 个父阶段节点 + 6~9 个 WBS 叶子任务（owner 指向真实用户 → 负责人负荷；
 *    部分 due_date 早于今天 → 逾期）
 *  - 进行中项目的周报（部分已提交 → 周报填报率 < 100%）
 *
 * 幂等：code 已存在则跳过整个项目，可反复执行不重复插。
 * 全程单事务，失败整体回滚。
 */
const path = require('path');
const Database = require('better-sqlite3');
const dates = require('../server/lib/dates');

const ROOT = path.resolve(__dirname, '..');
const db = new Database(path.join(ROOT, 'pm.db'));
db.pragma('foreign_keys = OFF');

const NOW = dates.nowIso();
const TODAY = dates.today();

/* 真实用户（open_id → 姓名） */
const PMS = ['ou_liming03', 'ou_sunyue07', 'ou_wangqiang02', 'ou_zhangmin04', 'ou_xuwenbin01'];
const DEVS = ['ou_wudi09', 'ou_zhengshuang10', 'ou_wangqiang02', 'ou_chenjing05', 'ou_liming03', 'ou_sunyue07'];

/* 10 个在管三态项目定义（核心属性） */
const PROJECTS = [
  { code: 'P-2001', name: '星载数据中继地面站建设', customer: '国家航天测控中心', type: 'A', status: '进行中', health: 'green', ps: '2026-05-06', pe: '2026-11-30', pm: 0 },
  { code: 'P-2002', name: '卫星载荷数据预处理平台', customer: '遥感应用研究院', type: 'A', status: '进行中', health: 'yellow', ps: '2026-06-01', pe: '2026-12-15', pm: 1 },
  { code: 'P-2003', name: '地面接收天线阵列升级', customer: '深空探测实验室', type: 'B', status: '进行中', health: 'red', ps: '2026-04-20', pe: '2026-10-10', pm: 2 },
  { code: 'P-2004', name: '数据中心灾备体系建设', customer: '太空字节自有', type: 'A', status: '进行中', health: 'yellow', ps: '2026-05-15', pe: '2027-01-20', pm: 3 },
  { code: 'P-2005', name: '在轨数据智能解译系统', customer: '智能情报事业部', type: 'C', status: '已批准', health: 'green', ps: '2026-07-10', pe: '2027-02-28', pm: 1 },
  { code: 'P-2006', name: '测控网络带宽扩容', customer: '地面运控中心', type: 'B', status: '已批准', health: 'yellow', ps: '2026-08-01', pe: '2026-12-31', pm: 2 },
  { code: 'P-2007', name: '数据资产治理平台', customer: '集团数据管理委员会', type: 'A', status: '挂起', health: 'red', ps: '2026-03-15', pe: '2026-09-30', pm: 4 },
  { code: 'P-2008', name: '量子加密传输试点', customer: '信息安全实验室', type: 'C', status: '挂起', health: 'green', ps: '2026-06-20', pe: '2026-11-15', pm: 3 },
  { code: 'P-2009', name: '遥感影像分发服务', customer: '行业应用生态部', type: 'A', status: '进行中', health: 'green', ps: '2026-05-25', pe: '2026-12-05', pm: 0 },
  { code: 'P-2010', name: '边缘计算节点部署', customer: '近地观测项目组', type: 'B', status: '进行中', health: 'yellow', ps: '2026-06-10', pe: '2026-11-08', pm: 2 },
];

const MS_NAMES = ['需求与立项', '总体设计评审', '核心模块开发', '集成联试', '试运行与验收'];
const TASK_VERBS = ['接口联调', '数据建模', '性能压测', '前端开发', '算法调优', '文档编写', '环境部署', '安全加固', '问题修复'];

function addDays(base, n) { return dates.addDays(base, n); }

/* 取一个在 [ps, pe] 区间内的里程碑日期，idx 越大越靠后 */
function msDate(ps, pe, idx, total) {
  const span = dates.diffDays(ps, pe); // pe - ps 天数
  const offset = Math.round((span * (idx + 1)) / (total + 1));
  return dates.addDays(ps, offset);
}

let inserted = 0;

const tx = db.transaction(function () {
  const insProject = db.prepare(
    `INSERT INTO projects (id, code, name, type, classify_input, customer, contract_amount, amount, goal, status, health, plan_start, plan_end, approval_step, template_id, pm, created_by, created_at, updated_at)
     VALUES (@id,@code,@name,@type,@classify_input,@customer,@contract_amount,@amount,@goal,@status,@health,@plan_start,@plan_end,@approval_step,@template_id,@pm,@created_by,@created_at,@updated_at)`
  );
  const insMember = db.prepare(
    `INSERT INTO project_members (id, project_id, user_open_id, project_role, assigned_by, assigned_at)
     VALUES (@id,@project_id,@user_open_id,@project_role,@assigned_by,@assigned_at)`
  );
  const insMs = db.prepare(
    `INSERT INTO milestones (id, project_id, code, name, target, required, baseline_date, planned_date, done_at, done_by, created_at, updated_at)
     VALUES (@id,@project_id,@code,@name,@target,@required,@baseline_date,@planned_date,@done_at,@done_by,@created_at,@updated_at)`
  );
  const insWbs = db.prepare(
    `INSERT INTO wbs_nodes (id, project_id, parent_id, wbs_code, level, node_type, name, description, owner, estimate_days, actual_days, start_date, due_date, status, progress, board_order, is_critical, created_by, created_at, updated_at)
     VALUES (@id,@project_id,@parent_id,@wbs_code,@level,@node_type,@name,@description,@owner,@estimate_days,@actual_days,@start_date,@due_date,@status,@progress,@board_order,@is_critical,@created_by,@created_at,@updated_at)`
  );
  const insWr = db.prepare(
    `INSERT INTO work_reports (id, project_id, week, week_start, week_end, author_open_id, author_name, status, done_note, plan_items, resource_note, submitted_at, created_at, updated_at)
     VALUES (@id,@project_id,@week,@week_start,@week_end,@author_open_id,@author_name,@status,@done_note,@plan_items,@resource_note,@submitted_at,@created_at,@updated_at)`
  );

  const week = dates.weekCode(TODAY);
  const weekStart = addDays(TODAY, -((new Date(TODAY).getUTCDay() + 6) % 7));
  const weekEnd = addDays(weekStart, 6);

  PROJECTS.forEach(function (p, i) {
    const pid = 'Pdemo' + p.code.slice(2);
    const exists = db.prepare('SELECT 1 FROM projects WHERE code = ?').get(p.code);
    if (exists) { console.log('  skip (已存在) ' + p.code + ' ' + p.name); return; }

    const pmOpen = PMS[p.pm % PMS.length];
    insProject.run({
      id: pid, code: p.code, name: p.name, type: p.type, classify_input: p.type,
      customer: p.customer, contract_amount: (800 + i * 120) * 1.0, amount: (800 + i * 120) + ' 万元',
      goal: p.name + '：完成建设目标并通过验收，满足' + p.customer + '的业务需求。',
      status: p.status, health: p.health, plan_start: p.ps, plan_end: p.pe,
      approval_step: p.status === '草稿' ? 0 : 3, template_id: 'tpl-' + p.type,
      pm: pmOpen, created_by: 'ou_xuwenbin01', created_at: NOW, updated_at: NOW,
    });

    /* PM 成员 */
    insMember.run({ id: pid + '-m-pm', project_id: pid, user_open_id: pmOpen, project_role: 'pm', assigned_by: 'ou_xuwenbin01', assigned_at: NOW });
    /* 再挂 1 名成员，丰富成员关系 */
    const extra = DEVS[(i + 2) % DEVS.length];
    if (extra !== pmOpen) insMember.run({ id: pid + '-m-dev', project_id: pid, user_open_id: extra, project_role: 'member', assigned_by: 'ou_xuwenbin01', assigned_at: NOW });

    /* 里程碑：done 比例随健康度变化（green 多完成、red 少完成） */
    const msTotal = 4 + (i % 2);
    const doneCount = p.health === 'green' ? msTotal - 1 : p.health === 'yellow' ? Math.ceil(msTotal / 2) : Math.floor(msTotal / 2);
    for (let m = 0; m < msTotal; m++) {
      const md = msDate(p.ps, p.pe, m, msTotal);
      insMs.run({
        id: pid + '-ms-' + m, project_id: pid, code: 'M' + (m + 1), name: MS_NAMES[m % MS_NAMES.length],
        target: '里程碑' + (m + 1) + '交付物', required: 1, baseline_date: md, planned_date: md,
        done_at: m < doneCount ? addDays(md, -2) : null, done_by: m < doneCount ? pmOpen : null,
        created_at: NOW, updated_at: NOW,
      });
    }

    /* WBS：1 个父阶段 + 若干叶子任务 */
    const parentId = pid + '-wbs-root';
    insWbs.run({
      id: parentId, project_id: pid, parent_id: null, wbs_code: '1', level: 1, node_type: 'phase',
      name: '实施阶段', description: '', owner: null, estimate_days: 60, actual_days: 20,
      start_date: p.ps, due_date: p.pe, status: '进行中', progress: 50, board_order: 0, is_critical: 0,
      created_by: 'ou_xuwenbin01', created_at: NOW, updated_at: NOW,
    });

    const leafCount = 6 + (i % 4); // 6~9
    let overdueAssigned = 0;
    for (let t = 0; t < leafCount; t++) {
      const owner = DEVS[(i + t) % DEVS.length];
      // 约 40% 叶子任务逾期（due < today，且状态非完成）
      const overdue = (t % 5 === 0 || t % 7 === 0) && overdueAssigned < 3;
      if (overdue) overdueAssigned++;
      const due = overdue ? addDays(TODAY, -(3 + (t % 9))) : addDays(p.ps, 30 + t * 12);
      const status = overdue ? (t % 2 === 0 ? '进行中' : '待办') : (t % 4 === 3 ? '完成' : '进行中');
      insWbs.run({
        id: pid + '-wbs-' + t, project_id: pid, parent_id: parentId, wbs_code: '1.' + (t + 1), level: 2,
        node_type: 'task', name: p.name.slice(0, 6) + '·' + TASK_VERBS[t % TASK_VERBS.length], description: '',
        owner: owner, estimate_days: 8, actual_days: overdue ? 10 : 3,
        start_date: addDays(p.ps, t * 5), due_date: due,
        status: status, progress: status === '完成' ? 100 : (overdue ? 30 : 60),
        board_order: t, is_critical: t % 3 === 0 ? 1 : 0,
        created_by: 'ou_xuwenbin01', created_at: NOW, updated_at: NOW,
      });
    }

    /* 进行中项目插周报：约 60% 已提交，其余缺失 → 周报填报率 < 100% */
    if (p.status === '进行中') {
      const submitted = (i % 5 !== 0); // 第 0,5 个进行中项目缺报
      insWr.run({
        id: pid + '-wr-1', project_id: pid, week: week, week_start: weekStart, week_end: weekEnd,
        author_open_id: pmOpen, author_name: pmOpen,
        status: submitted ? '已提交' : '草稿',
        done_note: submitted ? '本周完成关键模块联调，进度符合预期。' : '本周进展待补充。',
        plan_items: '下周计划推进集成测试。', resource_note: '无特殊资源需求。',
        submitted_at: submitted ? NOW : null, created_at: NOW, updated_at: NOW,
      });
    }

    inserted++;
    console.log('  + ' + p.code + ' ' + p.name + ' [' + p.type + '/' + p.status + '/' + p.health + ']');
  });
});

tx();
console.log('\n[seed-demo] 新增项目 ' + inserted + ' 个。当前在管三态项目总数见下方核验。');

/* 核验 */
const dist = db.prepare("SELECT status, COUNT(*) c FROM projects WHERE status IN ('已批准','进行中','挂起') GROUP BY status").all();
console.table(dist);
db.close();
