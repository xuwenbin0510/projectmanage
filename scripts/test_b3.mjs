/**
 * test_b3.mjs — B3 批次 **service 层分支测试**（与 smoke_b3.mjs 互补）
 *
 * 与 `smoke_b3.mjs` 的分工：
 *  - `smoke_b3.mjs`：走 **HTTP**，验 DoD §五 的对外契约（信封 / HTTP 码 / 字段命名 / 端到端联动）
 *  - `test_b3.mjs` （本文件）：**直接调 service 函数**，验内部分支与 `AppError.data` 形状。
 *    不经 Express，所以能断言 HTTP 映射**之前**的原始错误码与 data 负载，
 *    也能覆盖 HTTP 层难造的边界（如深度 4 溢出、循环搬运、工时溢出）。
 *
 * 隔离：每次运行开一个 **`:memory:` 全新库**，跑 migrations + seed，
 *       与 :3000 上的 pm.db 完全无关 —— 不污染开发数据，可反复执行。
 *
 * 覆盖：
 *   ① WBS 建/改/删/移动 7 类校验
 *   ② 里程碑单向日期（E_MS_NEED_CHANGE + changeDraft）
 *   ③ 质量门勾选 / 结论（含未勾齐+不通过例外、幂等）
 *   ④ 成员基数 E_ROLE_CARDINALITY
 *   ⑤ 双引擎一致性（强规则收敛 / 口径 Y 加权 / WIP 计数）
 *
 * 运行：node scripts/test_b3.mjs
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const migrations = require('../server/dal/migrations');
const seed = require('../server/dal/seed');

const projectService = require('../server/services/project.service');
const wbsService = require('../server/services/wbs.service');
const boardService = require('../server/services/board.service');
const milestoneService = require('../server/services/milestone.service');
const gateService = require('../server/services/gate.service');
const memberService = require('../server/services/member.service');
const wbsLib = require('../server/lib/wbs');
const { ErrorCode } = require('../server/lib/errors');

/* ═══════════════════════════════════════════════════
 * 断言工具
 * ═══════════════════════════════════════════════════ */

let passed = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    passed += 1;
    console.log('  \u2713 ' + label);
  } else {
    failures.push({ label, detail });
    console.log('  \u2717 ' + label + (detail === undefined ? '' : '  \u2192 ' + JSON.stringify(detail)));
  }
}

function eq(actual, expected, label) {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    JSON.stringify(actual) === JSON.stringify(expected) ? undefined : { expected, actual },
  );
}

/**
 * 断言 fn 抛出指定业务错误码，返回该错误（便于继续断言 data）。
 * @returns {?object} AppError 或 null
 */
function throws(fn, expectedCode, label) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (!err) {
    ok(false, label + ' \u2192 应抛 ' + expectedCode, { actual: '未抛错' });
    return null;
  }
  ok(err.code === expectedCode, label + ' \u2192 ' + expectedCode, err.code === expectedCode ? undefined : { expected: expectedCode, actual: err.code, message: err.message });
  return err;
}

/** 断言 fn 不抛错，返回其结果 */
function noThrow(fn, label) {
  try {
    const r = fn();
    ok(true, label);
    return r;
  } catch (e) {
    ok(false, label, { threw: e.code || e.message });
    return null;
  }
}

function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ═══════════════════════════════════════════════════
 * 夹具
 * ═══════════════════════════════════════════════════ */

const ADMIN = 'ou_xuwenbin01';   // globalRole: admin（RBAC 短路）
const TL = 'ou_wangqiang02';     // globalRole: tl
const MEMBER = 'ou_wudi09';      // globalRole: member
const MEMBER2 = 'ou_zhengshuang10';

const db = new Database(':memory:');
migrations.run(db);
seed.run(db);

/** 取用户行（service 期望 req.user 是 users 表行：open_id / global_role 蛇形） */
function userRow(openId) {
  return db.prepare('SELECT * FROM users WHERE open_id = ?').get(openId);
}

/** 构造伪 Express req */
function reqAs(openId) {
  return { user: userRow(openId) };
}

const ADMIN_REQ = reqAs(ADMIN);
let projectSeq = 0;

/**
 * 建一个干净项目。
 * @param {Array} [milestones] 里程碑规格；不传则走模板回退（K-1：门恒为 null）
 */
function mkProject(milestones) {
  projectSeq += 1;
  return projectService.createProject(db, {
    name: 'B3单测项目' + projectSeq,
    type: 'A',
    customer: '星舰客户',
    contractAmount: 500,
    background: 'test_b3',
    goal: ['service 层分支测试'],
    planStart: dayOffset(0),
    planEnd: dayOffset(180),
    classifyInput: {
      contractAmount: 500, hasHardware: true, hasAcceptance: true, isSelfIteration: false, isInfrastructure: false,
    },
    classifySuggested: 'A',
    classifyOverrideReason: '',
    members: [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }],
    milestones: milestones,
  }, userRow(ADMIN));
}

/** 建 WBS 节点（默认补齐叶子必填项） */
function mkNode(projectId, payload) {
  return wbsService.createWbsNode(db, ADMIN_REQ, projectId, Object.assign(
    { owner: ADMIN, estimateDays: 1 },
    payload,
  ));
}

/* ═══════════════════════════════════════════════════
 * ① WBS 7 类校验
 * ═══════════════════════════════════════════════════ */

function testWbsValidations() {
  console.log('\n\u2460 WBS 建/改/删/移动 · 7 类校验');
  const p = mkProject([{ code: 'M1', name: '启动', date: dayOffset(60), required: true, gate: null }]);
  const pid = p.id;

  /* --- 1) E_WBS_LEAF_INCOMPLETE：叶子缺 owner / estimateDays --- */
  throws(
    () => wbsService.createWbsNode(db, ADMIN_REQ, pid, { name: '缺负责人', estimateDays: 2 }),
    ErrorCode.E_WBS_LEAF_INCOMPLETE, '[V1] 叶子缺 owner',
  );
  throws(
    () => wbsService.createWbsNode(db, ADMIN_REQ, pid, { name: '缺工时', owner: ADMIN }),
    ErrorCode.E_WBS_LEAF_INCOMPLETE, '[V1] 叶子缺 estimateDays',
  );

  /* --- 2) E_WBS_PARENT_TYPE：subtask 下不允许再挂子 --- */
  const lv1 = mkNode(pid, { name: '一层任务' });
  const lv2 = mkNode(pid, { name: '二层任务', parentId: lv1.id });
  const lv3sub = mkNode(pid, { name: '三层子任务', parentId: lv2.id, nodeType: 'subtask' });
  const eParent = throws(
    () => mkNode(pid, { name: '挂在 subtask 下', parentId: lv3sub.id }),
    ErrorCode.E_WBS_PARENT_TYPE, '[V2] subtask 下建子节点',
  );
  eq(eParent && eParent.data && eParent.data.parentType, 'subtask', '[V2] data.parentType === subtask');
  eq(eParent && eParent.data && eParent.data.allowed, [], '[V2] data.allowed === []（subtask 不许有子）');

  /* --- 3) E_WBS_DEPTH：maxDepth = 4，第 5 层被拦 --- */
  const lv3 = mkNode(pid, { name: '三层任务', parentId: lv2.id });
  const lv4 = mkNode(pid, { name: '四层任务', parentId: lv3.id, nodeType: 'subtask' });
  const eDepth = throws(
    () => mkNode(pid, { name: '五层溢出', parentId: lv4.id }),
    ErrorCode.E_WBS_DEPTH, '[V3] 第 5 层建节点',
  );
  eq(eDepth && eDepth.data && eDepth.data.maxDepth, 4, '[V3] data.maxDepth === 4');
  ok(
    eDepth && eDepth.data && eDepth.data.resultDepth > 4,
    '[V3] data.resultDepth > 4',
    eDepth && eDepth.data,
  );

  /* W-1 深度先于 W-2 类型 fail-fast：在 lv4(subtask) 下建，两条规则都违反 → 先报 DEPTH */
  eq(eDepth && eDepth.code, ErrorCode.E_WBS_DEPTH, '[V3] W-1 深度校验先于 W-2 类型校验（fail-fast）');

  /* --- 4) E_WBS_TYPE_LOCKED：有子节点时改 nodeType --- */
  const eLocked = throws(
    () => wbsService.updateWbsNode(db, ADMIN_REQ, lv1.id, { nodeType: 'subtask' }),
    ErrorCode.E_WBS_TYPE_LOCKED, '[V4] 有子节点改 nodeType',
  );
  ok(
    eLocked && eLocked.data && Number(eLocked.data.childCount) > 0,
    '[V4] data.childCount > 0',
    eLocked && eLocked.data,
  );

  /* --- 5) E_WBS_CYCLE：把父节点搬到自己子孙下 --- */
  throws(
    () => wbsService.moveWbsNode(db, ADMIN_REQ, lv1.id, lv3.id, 0),
    ErrorCode.E_WBS_CYCLE, '[V5] 把祖先搬到自己子孙下',
  );
  throws(
    () => wbsService.moveWbsNode(db, ADMIN_REQ, lv1.id, lv1.id, 0),
    ErrorCode.E_WBS_CYCLE, '[V5] 把节点搬到自己下面',
  );

  /* --- 6) E_WBS_DEADLINE_OVERFLOW：子截止晚于父截止 --- */
  const pDead = mkProject([{ code: 'M1', name: '启动', date: dayOffset(60), required: true, gate: null }]);
  const parentDue = mkNode(pDead.id, { name: '父·限期', dueDate: dayOffset(30) });
  const eDead = throws(
    () => mkNode(pDead.id, { name: '子·超期', parentId: parentDue.id, dueDate: dayOffset(45) }),
    ErrorCode.E_WBS_DEADLINE_OVERFLOW, '[V6] 子截止晚于父截止',
  );
  eq(eDead && eDead.data && eDead.data.parentDue, dayOffset(30), '[V6] data.parentDue 为父截止日');

  /* --- 7) E_WBS_ESTIMATE_OVERFLOW：工时超出 start~due 可用天数 --- */
  const eEst = throws(
    () => mkNode(pDead.id, {
      name: '工时溢出', startDate: dayOffset(1), dueDate: dayOffset(3), estimateDays: 99,
    }),
    ErrorCode.E_WBS_ESTIMATE_OVERFLOW, '[V7] estimateDays 超出可用天数',
  );
  ok(
    eEst && eEst.data && Number(eEst.data.available) < 99,
    '[V7] data.available < estimateDays',
    eEst && eEst.data,
  );

  /* --- 移动成功路径：D13 返回整个项目节点数组 --- */
  const moved = noThrow(
    () => wbsService.moveWbsNode(db, ADMIN_REQ, lv3.id, lv1.id, 0),
    '[V8] 合法移动（lv3 → lv1 下）',
  );
  ok(Array.isArray(moved), '[V8·D13] moveWbsNode 返回整个项目节点数组', { type: typeof moved });
  ok(moved && moved.length >= 4, '[V8] 返回数组含全部节点', { len: moved && moved.length });

  /* --- 删除：D13 返回 null，子树一并删除 --- */
  const beforeDel = wbsService.loadNodes(db, pid).length;
  const delRet = wbsService.deleteWbsNode(db, ADMIN_REQ, lv1.id);
  eq(delRet, null, '[V9·D13] deleteWbsNode 返回 null');
  const afterDel = wbsService.loadNodes(db, pid).length;
  ok(afterDel < beforeDel, '[V9] 删除父节点后子树一并移除', { beforeDel, afterDel });
}

/* ═══════════════════════════════════════════════════
 * ② 里程碑单向日期
 * ═══════════════════════════════════════════════════ */

function testMilestone() {
  console.log('\n\u2461 里程碑单向日期 · changeDraft');
  const p = mkProject([
    { code: 'M1', name: '启动', date: dayOffset(30), required: true, gate: null },
    { code: 'M2', name: '交付', date: dayOffset(90), required: true, gate: null },
  ]);
  const list0 = milestoneService.listMilestonesWithGate(db, p.id);
  eq(list0.length, 2, '[MS0] 两个里程碑落库');
  const m1 = list0[0];

  /* --- 1) 延后 → E_MS_NEED_CHANGE + changeDraft --- */
  const eDelay = throws(
    () => milestoneService.updateMilestone(db, ADMIN_REQ, m1.id, { currentDate: dayOffset(50) }),
    ErrorCode.E_MS_NEED_CHANGE, '[MS1] 延后里程碑日期',
  );
  const draft = eDelay && eDelay.data && eDelay.data.changeDraft;
  ok(!!draft, '[MS1] data.changeDraft 存在');
  eq(draft && draft.targetType, 'milestone', '[MS1] changeDraft.targetType === milestone');
  eq(draft && draft.targetId, m1.id, '[MS1] changeDraft.targetId === 里程碑 id');
  eq(draft && draft.payload && draft.payload.fromDate, m1.currentDate, '[MS1] payload.fromDate === 原日期');
  eq(draft && draft.payload && draft.payload.toDate, dayOffset(50), '[MS1] payload.toDate === 目标日期');
  /* 关键：抛错后事务回滚，日期不能被改掉 */
  const afterDelay = milestoneService.listMilestonesWithGate(db, p.id)[0];
  eq(afterDelay.currentDate, m1.currentDate, '[MS1] 抛错后日期未被写入（事务回滚）');

  /* --- 2) 提前 → 直接放行 --- */
  noThrow(
    () => milestoneService.updateMilestone(db, ADMIN_REQ, m1.id, { currentDate: dayOffset(20) }),
    '[MS2] 提前里程碑日期直接放行',
  );
  const afterEarly = milestoneService.listMilestonesWithGate(db, p.id)[0];
  eq(afterEarly.currentDate, dayOffset(20), '[MS2] 日期已提前到目标值');

  /* --- 3) 保持同日 → 放行（diffDays === 0，非延后） --- */
  noThrow(
    () => milestoneService.updateMilestone(db, ADMIN_REQ, m1.id, { currentDate: dayOffset(20) }),
    '[MS3] 保持同日放行（边界 diffDays === 0）',
  );

  /* --- 4) statusOverride 枚举不含「已达成」 --- */
  throws(
    () => milestoneService.updateMilestone(db, ADMIN_REQ, m1.id, { statusOverride: '已达成' }),
    ErrorCode.E_VALIDATION, '[MS4] statusOverride = 已达成',
  );

  /* --- 5) 新建里程碑 K-1：不自动建质量门 --- */
  const created = milestoneService.createMilestone(db, ADMIN_REQ, p.id, {
    name: '新增碑', date: dayOffset(120), required: false,
  });
  ok(Array.isArray(created) ? true : !!created, '[MS5] createMilestone 成功');
  const listAfterCreate = milestoneService.listMilestonesWithGate(db, p.id);
  const newMs = listAfterCreate.filter((m) => m.name === '新增碑')[0];
  ok(!!newMs, '[MS5] 新碑已落库');
  eq(newMs && newMs.gate, null, '[MS5·K-1] 新建里程碑不自动建质量门（gate === null）');

  /* --- 6) 删除里程碑：级联删门，WBS 节点 milestone_id 置 NULL 不删（SK-12） --- */
  const node = mkNode(p.id, { name: '绑碑任务', milestoneId: newMs.id });
  eq(node.milestoneId, newMs.id, '[MS6] 任务已绑定新碑');
  milestoneService.deleteMilestone(db, ADMIN_REQ, newMs.id);
  const nodeAfter = wbsService.loadNodes(db, p.id).filter((n) => n.id === node.id)[0];
  ok(!!nodeAfter, '[MS6·SK-12] 删碑后 WBS 节点仍在（不级联删任务）');
  ok(!nodeAfter.milestoneId, '[MS6·SK-12] 节点 milestoneId 已置空', { milestoneId: nodeAfter && nodeAfter.milestoneId });
}

/* ═══════════════════════════════════════════════════
 * ③ 质量门勾选 / 结论
 * ═══════════════════════════════════════════════════ */

function testGate() {
  console.log('\n\u2462 质量门 · 勾选与结论');
  const p = mkProject([{
    code: 'M1', name: '需求基线', date: dayOffset(40), required: true,
    gate: {
      code: 'QG1', name: '需求质量门', ownerRole: 'pmo',
      items: [
        { content: '需求评审通过', ownerRole: 'po' },
        { content: '验收标准明确', ownerRole: 'qa' },
      ],
    },
  }]);
  const ms = milestoneService.listMilestonesWithGate(db, p.id)[0];
  const gate = ms.gate;
  ok(!!gate, '[G0] 向导显式提交门规格 → 质量门已落库');
  /* 契约：检查项挂在 MilestoneWithGate.gateItems（与 gate 平级），不是 gate.items */
  eq(ms.gateItems && ms.gateItems.length, 2, '[G0] 两条检查项（挂在 ms.gateItems）');
  eq(gate && gate.items, undefined, '[G0] gate 自身不内嵌 items（形状契约）');

  /* --- 0b) 结论枚举：只认 已通过 / 有条件通过 / 不通过 --- */
  const eEnum = throws(
    () => gateService.decideGate(db, ADMIN_REQ, p.id, gate.id, { conclusion: '通过', comment: '错枚举' }),
    ErrorCode.E_VALIDATION, '[G0] 结论「通过」不在枚举内',
  );
  eq(
    eEnum && eEnum.data && eEnum.data.allowed, ['已通过', '有条件通过', '不通过'],
    '[G0] data.allowed === GATE_CONCLUSIONS',
  );

  /* --- 1) 未勾齐 + 「已通过」 → E_GATE_ITEM_INCOMPLETE，data.unchecked 为 [{id,content}] --- */
  const eIncomplete = throws(
    () => gateService.decideGate(db, ADMIN_REQ, p.id, gate.id, { conclusion: '已通过', comment: '强推' }),
    ErrorCode.E_GATE_ITEM_INCOMPLETE, '[G1] 未勾齐时结论「已通过」',
  );
  const unchecked = eIncomplete && eIncomplete.data && eIncomplete.data.unchecked;
  ok(Array.isArray(unchecked) && unchecked.length === 2, '[G1] data.unchecked 为长度 2 的数组', unchecked);
  ok(
    Array.isArray(unchecked) && unchecked.every((u) => u && u.id && u.content),
    '[G1] unchecked 元素形状为 {id, content}', unchecked,
  );

  /* --- 2) 未勾齐 + 「不通过」 → 放行（例外分支） --- */
  const rejected = noThrow(
    () => gateService.decideGate(db, ADMIN_REQ, p.id, gate.id, { conclusion: '不通过', comment: '需求不清' }),
    '[G2] 未勾齐 + 「不通过」→ 放行（例外分支）',
  );
  ok(Array.isArray(rejected), '[G2] decideGate 返回 MilestoneWithGate[] 整表', { type: typeof rejected });
  const msAfterReject = (rejected || []).filter((m) => m.id === ms.id)[0] || {};
  eq(msAfterReject.gate && msAfterReject.gate.conclusion, '不通过', '[G2] 结论已落库为「不通过」');
  ok(!msAfterReject.doneAt, '[G2] 「不通过」不触发里程碑达成', { doneAt: msAfterReject.doneAt });

  /* --- 3) 勾选检查项 → 返回整表，checked 落库 --- */
  const items = ms.gateItems;
  const afterToggle = gateService.toggleGateItem(db, ADMIN_REQ, items[0].id, true);
  ok(Array.isArray(afterToggle), '[G3] toggleGateItem 返回 MilestoneWithGate[] 整表');
  const it0 = ((afterToggle || []).filter((m) => m.id === ms.id)[0] || {}).gateItems || [];
  eq(it0.filter((i) => i.checked).length, 1, '[G3] 已勾选 1 项');
  gateService.toggleGateItem(db, ADMIN_REQ, items[1].id, true);
  const it1 = (milestoneService.listMilestonesWithGate(db, p.id)[0] || {}).gateItems || [];
  eq(it1.filter((i) => i.checked).length, 2, '[G3] 已勾齐 2 项');

  /* --- 4) 勾齐 + 「已通过」 → 成功，触发里程碑达成 --- */
  const passedRet = noThrow(
    () => gateService.decideGate(db, ADMIN_REQ, p.id, gate.id, { conclusion: '已通过', comment: '符合基线' }),
    '[G4] 勾齐 + 「已通过」→ 成功',
  );
  const msPassed = (passedRet || []).filter((m) => m.id === ms.id)[0] || {};
  eq(msPassed.gate && msPassed.gate.conclusion, '已通过', '[G4] 结论为「已通过」');
  ok(!!msPassed.doneAt, '[G4] GATE_PASSED_STATUSES 触发里程碑达成（doneAt 有值）', { doneAt: msPassed.doneAt });

  /* --- 5) 重复决策幂等：doneAt 不变 --- */
  const firstDoneAt = msPassed.doneAt;
  const again = gateService.decideGate(db, ADMIN_REQ, p.id, gate.id, { conclusion: '已通过', comment: '再决一次' });
  const msAgain = (again || []).filter((m) => m.id === ms.id)[0] || {};
  eq(msAgain.doneAt, firstDoneAt, '[G5] 重复决策幂等 → doneAt 不变');

  /* --- 6) 「有条件通过」也属达成状态 --- */
  const p2 = mkProject([{
    code: 'M1', name: '条件门', date: dayOffset(40), required: true,
    gate: { code: 'QG2', name: '条件质量门', ownerRole: 'qa', items: [{ content: '唯一项', ownerRole: 'qa' }] },
  }]);
  const ms2 = milestoneService.listMilestonesWithGate(db, p2.id)[0];
  gateService.toggleGateItem(db, ADMIN_REQ, ms2.gateItems[0].id, true);
  const cond = gateService.decideGate(db, ADMIN_REQ, p2.id, ms2.gate.id, { conclusion: '有条件通过', comment: '带尾巴放行' });
  const ms2After = (cond || []).filter((m) => m.id === ms2.id)[0] || {};
  ok(!!ms2After.doneAt, '[G6] 「有条件通过」同样触发达成', { doneAt: ms2After.doneAt });
}

/* ═══════════════════════════════════════════════════
 * ④ 成员基数
 * ═══════════════════════════════════════════════════ */

function testMember() {
  console.log('\n\u2463 成员写 · 角色基数');
  const p = mkProject([{ code: 'M1', name: '启动', date: dayOffset(30), required: true, gate: null }]);
  const pid = p.id;

  eq(memberService.SINGLETON_ROLES, ['pm', 'tl'], '[MB0] SINGLETON_ROLES === [pm, tl]');

  /* --- 1) 追加第二个 pm / tl → E_ROLE_CARDINALITY --- */
  throws(
    () => memberService.addMember(db, ADMIN_REQ, pid, { userOpenId: MEMBER2, role: 'pm' }),
    ErrorCode.E_ROLE_CARDINALITY, '[MB1] 追加第二个 PM',
  );
  throws(
    () => memberService.addMember(db, ADMIN_REQ, pid, { userOpenId: MEMBER2, role: 'tl' }),
    ErrorCode.E_ROLE_CARDINALITY, '[MB1] 追加第二个 TL',
  );

  /* --- 2) 加普通成员 → 成功 --- */
  const added = noThrow(
    () => memberService.addMember(db, ADMIN_REQ, pid, { userOpenId: MEMBER2, role: 'member' }),
    '[MB2] 追加普通成员成功',
  );
  ok(!!(added && added.id), '[MB2] 返回 ProjectMember.id');
  eq(added && added.projectRole, 'member', '[MB2] 角色字段名为 projectRole');
  ok(!!(added && added.userName), '[MB2] userName 已回填', { userName: added && added.userName });

  /* --- 3) 删必备角色 pm / tl → E_ROLE_CARDINALITY --- */
  const members = projectService.listMembers(db, pid);
  const pmRow = members.filter((m) => m.projectRole === 'pm')[0];
  const tlRow = members.filter((m) => m.projectRole === 'tl')[0];
  ok(!!pmRow && !!tlRow, '[MB3] 项目内存在 PM 与 TL 成员行');
  throws(
    () => memberService.removeMember(db, ADMIN_REQ, pid, pmRow.id),
    ErrorCode.E_ROLE_CARDINALITY, '[MB3] 移除唯一 PM',
  );
  throws(
    () => memberService.removeMember(db, ADMIN_REQ, pid, tlRow.id),
    ErrorCode.E_ROLE_CARDINALITY, '[MB3] 移除唯一 TL',
  );

  /* --- 4) 删普通成员 → 成功，返回 null --- */
  const rm = memberService.removeMember(db, ADMIN_REQ, pid, added.id);
  eq(rm, null, '[MB4] removeMember 返回 null');
  eq(projectService.listMembers(db, pid).length, members.length - 1, '[MB4] 成员条数 -1');

  /* --- 5) 越权：普通 member 账号无 project:member:assign --- */
  throws(
    () => memberService.addMember(db, reqAs(MEMBER), pid, { userOpenId: MEMBER2, role: 'member' }),
    ErrorCode.E_FORBIDDEN, '[MB5] member 账号加成员',
  );

  /* --- 6) 建项时基数校验（纯函数分支） --- */
  throws(
    () => projectService.assertMemberCardinality([{ userOpenId: ADMIN, role: 'pm' }], 'A'),
    ErrorCode.E_ROLE_CARDINALITY, '[MB6] 建项缺 TL',
  );
  throws(
    () => projectService.assertMemberCardinality(
      [{ userOpenId: ADMIN, role: 'pm' }, { userOpenId: TL, role: 'tl' }], 'B',
    ),
    ErrorCode.E_PROJECT_PO_REQUIRED, '[MB6] B 类项目缺 PO',
  );
}

/* ═══════════════════════════════════════════════════
 * ⑤ 双引擎一致性（强规则 / 口径 Y / WIP）
 * ═══════════════════════════════════════════════════ */

function testEngines() {
  console.log('\n\u2464 双引擎一致性 · 强规则 / 口径 Y / WIP');
  const p = mkProject([{ code: 'M1', name: '启动', date: dayOffset(60), required: true, gate: null }]);
  const pid = p.id;

  /* --- 1) 强规则：progress=100 的卡拖到「进行中」→ 收敛回「完成」 --- */
  const n1 = mkNode(pid, { name: '强规则卡', progress: 100 });
  const bv = boardService.moveTask(db, ADMIN_REQ, n1.id, '进行中', 0);
  const colOf = (v, s) => ((v.columns || []).filter((c) => c.status === s)[0] || { cards: [] });
  eq(colOf(bv, '进行中').cards.filter((c) => c.id === n1.id).length, 0, '[E1] progress=100 不停留在「进行中」');
  eq(colOf(bv, '完成').cards.filter((c) => c.id === n1.id).length, 1, '[E1] 强规则收敛回「完成」');

  /* --- 2) 强规则：progress=0 的卡拖到「进行中」→ 收敛回「待办」 --- */
  const n2 = mkNode(pid, { name: '零进度卡', progress: 0 });
  const bv2 = boardService.moveTask(db, ADMIN_REQ, n2.id, '进行中', 0);
  eq(colOf(bv2, '待办').cards.filter((c) => c.id === n2.id).length, 1, '[E2] progress=0 被踢回「待办」');

  /* --- 3) 强规则：待评审不被覆盖（除规则 1） --- */
  const n3 = mkNode(pid, { name: '待评审卡', progress: 0 });
  const bv3 = boardService.moveTask(db, ADMIN_REQ, n3.id, '待评审', 0);
  eq(colOf(bv3, '待评审').cards.filter((c) => c.id === n3.id).length, 1, '[E3] progress=0 的「待评审」不被踢回');

  /* --- 4) 叶子口径 SK-4：叶子加子后从看板消失 --- */
  const leafBefore = mkNode(pid, { name: '将变父的叶子' });
  const bvLeaf = boardService.getBoard(db, pid);
  const allCards = (bvLeaf.columns || []).reduce((acc, c) => acc.concat(c.cards || []), []);
  eq(allCards.filter((c) => c.id === leafBefore.id).length, 1, '[E4] 叶子在看板上有卡片');
  mkNode(pid, { name: '新子节点', parentId: leafBefore.id });
  const bvAfter = boardService.getBoard(db, pid);
  const allCards2 = (bvAfter.columns || []).reduce((acc, c) => acc.concat(c.cards || []), []);
  eq(allCards2.filter((c) => c.id === leafBefore.id).length, 0, '[E4·SK-4] 加子后从看板消失（卡片=真叶子）');

  /* --- 5) 口径 Y：total 取全集，progress 只按真叶子 estimateDays 加权 --- */
  const pY = mkProject([{ code: 'M1', name: '交付碑', date: dayOffset(60), required: true, gate: null }]);
  const msY = milestoneService.listMilestonesWithGate(db, pY.id)[0];
  const skeleton = mkNode(pY.id, { name: '骨架任务', milestoneId: msY.id, estimateDays: 1 });
  const cA = mkNode(pY.id, { name: '子任务甲', parentId: skeleton.id, nodeType: 'subtask', estimateDays: 2 });
  mkNode(pY.id, { name: '子任务乙', parentId: skeleton.id, nodeType: 'subtask', estimateDays: 3 });
  boardService.moveTask(db, ADMIN_REQ, cA.id, '完成', 0);

  const msYAfter = milestoneService.listMilestonesWithGate(db, pY.id)[0];
  const stats = msYAfter.taskStats || {};
  eq(stats.total, 3, '[E5·口径Y] total === 3（绑定节点自身 + 2 子）');
  eq(stats.done, 1, '[E5·口径Y] done === 1（仅子任务甲 progress≥100）');
  eq(stats.progress, 40, '[E5·口径Y] progress === 40（(2×100+3×0)/5，只按真叶子加权）');

  const skeletonAfter = wbsService.loadNodes(db, pY.id).filter((n) => n.id === skeleton.id)[0];
  eq(skeletonAfter.progress, 40, '[E5] rollupProgressFlat 把骨架 progress 回写为 40');

  /* --- 6) checkWip 纯函数分支 --- */
  const fakeNodes = [
    { id: 'a', parentId: null, status: '进行中' },
    { id: 'b', parentId: null, status: '进行中' },
    { id: 'c', parentId: 'a', status: '进行中' },  // 有父 → a 不是叶子
    { id: 'd', parentId: null, status: '待办' },
  ];
  const cfg = { wipLimits: { 进行中: 2 } };
  eq(wbsLib.checkWip(fakeNodes, cfg, '进行中', 'd'), { limit: 2, current: 2 }, '[E6] checkWip 超限返回 {limit,current}');
  eq(wbsLib.checkWip(fakeNodes, cfg, '待办', 'd'), null, '[E6] 未配上限的列直接放行');
  eq(wbsLib.checkWip(fakeNodes, cfg, '进行中', 'b'), null, '[E6] 被拖动节点自身不计入现有数量');
  eq(
    wbsLib.checkWip(fakeNodes, { wipLimits: { 进行中: 0 } }, '进行中', 'd'), null,
    '[E6] limit <= 0 视为不限',
  );

  /* --- 7) 引擎收尾次序：里程碑状态随任务完成刷新 --- */
  ok(
    typeof wbsService.syncWbsProgressStatus === 'function'
      && typeof milestoneService.refreshMilestoneStatuses === 'function',
    '[E7] 两个引擎函数均导出（syncWbsProgressStatus → refreshMilestoneStatuses）',
  );
}

/* ═══════════════════════════════════════════════════
 * 主流程
 * ═══════════════════════════════════════════════════ */

console.log('════════════════════════════════════════');
console.log(' test_b3 · B3 service 层分支测试（内存库）');
console.log('════════════════════════════════════════');
console.log('schema 版本: v' + migrations.currentVersion(db));

try {
  testWbsValidations();
  testMilestone();
  testGate();
  testMember();
  testEngines();
} catch (e) {
  failures.push({ label: '测试执行中断: ' + (e && e.message), detail: e && e.stack });
  console.log('\n\u2717 测试执行中断: ' + (e && e.message));
  console.log(e && e.stack);
}

console.log('\n────────────────────────────────');
console.log('通过 ' + passed + ' / 失败 ' + failures.length);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f, i) => {
    console.log('  ' + (i + 1) + '. ' + f.label + (f.detail === undefined ? '' : '  \u2192 ' + JSON.stringify(f.detail)));
  });
}
db.close();
process.exit(failures.length ? 1 : 0);
