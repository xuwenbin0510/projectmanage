'use strict';

/**
 * 数据导出服务（CSV，本期仅导出）。
 *
 * **只读复用**既有 service，不修改任何签名：
 *  - `exportProjectsCsv`   → projectService.listProjects
 *  - `exportProjectTasksCsv` → wbsService.listWbs
 *  - `exportProjectReportsCsv` → reportService.listReports
 *  - `exportAuditsCsv`     → auditService.listAudit
 *
 * 权限口径：
 *  - 项目 / 任务 / 周报导出：沿用「登录即可查看」（查看 = 任意登录用户），不额外加成员限定；
 *  - 审计导出：敏感（含全员操作记录），仅 admin / pmo / management 可调（路由层 requireGlobalRole 守门）。
 */

const db = require('../../db');
const { AppError, ErrorCode } = require('../lib/errors');
const { toCsv } = require('../lib/csv');
const projectService = require('./project.service');
const wbsService = require('./wbs.service');
const reportService = require('./report.service');
const auditService = require('./audit.service');

const ADMIN_ROLES = ['admin', 'pmo', 'management'];

/** 是否拥有全局管理角色（看全量 / 导出审计）。 */
function isAdminRole(me) {
  return !!me && ADMIN_ROLES.indexOf(me.global_role) >= 0;
}

/** 导出用日期戳（YYYYMMDD），用于文件名。 */
function dateStamp() {
  const d = new Date();
  const p = function (n) {
    return String(n).padStart(2, '0');
  };
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

/* ═══════════════════════════════════════════════════
 * 一、项目清单
 * ═══════════════════════════════════════════════════ */

const PROJECT_HEADERS = [
  '项目ID', '项目编码', '项目名称', '类别', '客户', '合同额(万元)', '状态', '健康度',
  '负责人', '计划开始', '计划结束', '实际结项', '进度(%)', '里程碑完成', '当前门控',
  '门通过数', '门总数', '高风险数',
];

function exportProjectsCsv(me) {
  const paged = projectService.listProjects(
    db,
    { onlyMine: !isAdminRole(me), pageSize: 200 },
    me,
  );
  const rows = (paged.items || []).map(function (p) {
    return {
      项目ID: p.id,
      项目编码: p.code,
      项目名称: p.name,
      类别: p.type,
      客户: p.customer,
      合同额_万元: p.contractAmount,
      状态: p.status,
      健康度: p.health,
      负责人: p.pmName,
      计划开始: p.planStart,
      计划结束: p.planEnd,
      实际结项: p.actualEnd,
      进度: p.progress,
      里程碑完成: p.milestoneDone != null && p.milestoneTotal != null ? p.milestoneDone + '/' + p.milestoneTotal : '',
      当前门控: p.currentGateCode,
      门通过数: p.gatePassed,
      门总数: p.gateTotal,
      高风险数: p.highRiskCount,
    };
  });
  return toCsv(PROJECT_HEADERS, rows);
}

/* ═══════════════════════════════════════════════════
 * 二、WBS 任务（含父子 / 里程碑归属）
 * ═══════════════════════════════════════════════════ */

const TASK_HEADERS = [
  '节点ID', 'WBS编码', '层级', '类型', '名称', '描述', '负责人ID', '负责人名',
  '估算(天)', '实际(天)', '开始', '截止', '状态', '进度(%)', '优先级', '关键路径', '里程碑ID', '父ID',
];

function exportProjectTasksCsv(projectId) {
  const nodes = wbsService.listWbs(db, String(projectId));
  const rows = (nodes || []).map(function (n) {
    return {
      节点ID: n.id,
      WBS编码: n.wbsCode,
      层级: n.level,
      类型: n.nodeType,
      名称: n.name,
      描述: n.description,
      负责人ID: n.owner,
      负责人名: n.ownerName,
      估算_天: n.estimateDays,
      实际_天: n.actualDays,
      开始: n.startDate,
      截止: n.dueDate,
      状态: n.status,
      进度: n.progress,
      优先级: n.priority,
      关键路径: n.isCritical ? '是' : '否',
      里程碑ID: n.milestoneId || '',
      父ID: n.parentId || '',
    };
  });
  return toCsv(TASK_HEADERS, rows);
}

/* ═══════════════════════════════════════════════════
 * 三、周报（按周报维度扁平化，嵌套任务/风险以数量呈现）
 * ═══════════════════════════════════════════════════ */

const REPORT_HEADERS = [
  '周报ID', '项目ID', '周次', '周开始', '周结束', '作者ID', '作者名', '状态',
  '完成说明', '资源说明', '任务数', '风险数', '确认人', '确认时间', '驳回原因', '提交时间', '创建时间',
];

function exportProjectReportsCsv(projectId) {
  const reports = reportService.listReports(db, String(projectId));
  const rows = (reports || []).map(function (r) {
    return {
      周报ID: r.id,
      项目ID: r.projectId,
      周次: r.week,
      周开始: r.weekStart,
      周结束: r.weekEnd,
      作者ID: r.author,
      作者名: r.authorName,
      状态: r.status,
      完成说明: r.doneNote,
      资源说明: r.resourceNote,
      任务数: Array.isArray(r.tasks) ? r.tasks.length : 0,
      风险数: Array.isArray(r.risks) ? r.risks.length : 0,
      确认人: r.confirmedBy || '',
      确认时间: r.confirmedAt || '',
      驳回原因: r.rejectReason || '',
      提交时间: r.submittedAt || '',
      创建时间: r.createdAt,
    };
  });
  return toCsv(REPORT_HEADERS, rows);
}

/* ═══════════════════════════════════════════════════
 * 四、审计日志（限管理角色，路由层守门）
 * ═══════════════════════════════════════════════════ */

const AUDIT_HEADERS = [
  '日志ID', '项目ID', '项目名称', '实体类型', '实体ID', '操作', '操作人ID', '操作人名', '摘要', '时间',
];

function exportAuditsCsv() {
  const paged = auditService.listAudit(db, { pageSize: 200 });
  const rows = (paged.items || []).map(function (a) {
    return {
      日志ID: a.id,
      项目ID: a.projectId || '',
      项目名称: a.projectName || '',
      实体类型: a.entityType,
      实体ID: a.entityId || '',
      操作: a.action,
      操作人ID: a.actorOpenId,
      操作人名: a.actorName,
      摘要: a.summary,
      时间: a.createdAt,
    };
  });
  return toCsv(AUDIT_HEADERS, rows);
}

module.exports = {
  isAdminRole,
  dateStamp,
  exportProjectsCsv,
  exportProjectTasksCsv,
  exportProjectReportsCsv,
  exportAuditsCsv,
};
