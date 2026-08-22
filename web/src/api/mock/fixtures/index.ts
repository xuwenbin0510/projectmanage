import type { MockDb, ProgressSnapshotMock } from '../db';
import { DEFAULT_REVIEW_TEMPLATES, DEFAULT_ROLES } from '../db';
import { createUsers } from './users';
import { createTemplates } from './templates';
import { createProjects } from './projects';
import { createWbs } from './wbs';
import { createReports } from './reports';
import { createReviews } from './reviews';
import { createChanges } from './changes';
import { createAuditLogs, createRisks, createDocuments } from './audit';
import { leafNodesOf } from '@/utils/wbs';
import { addDays, today, weekCode } from '@/utils/date';

export { OPEN_IDS, nameOf } from './users';

/** D03：构造连续两周（前周 + 上周）全量快照种子，让「任务进度环比」开箱即有演示数据 */
function createProgressSnapshots(wb: { nodes: ReturnType<typeof createWbs>['nodes'] }): ProgressSnapshotMock[] {
  const lastWeek = weekCode(addDays(today(), -7));
  const prevWeek = weekCode(addDays(today(), -14));
  const leafNodes = leafNodesOf(wb.nodes);
  const snaps: ProgressSnapshotMock[] = [];
  let seq = 0;

  leafNodes.forEach((n) => {
    const isP0 = n.wbsCode === '1.1' || n.wbsCode === '1.2' || n.name.includes('联调');
    const base = n.progress;
    // 前周快照：演示任务较上周普遍低 10~30 个百分点（少数已完成/未动）
    const prev = isP0 ? Math.max(0, base - 30) : Math.max(0, base - 10 - ((seq % 3) * 5));
    const idOf = (week: string) => `SNAP_${n.id}_${week}`;
    snaps.push({
      id: idOf(prevWeek),
      projectId: n.projectId,
      objectId: n.id,
      week: prevWeek,
      progress: prev,
      status: prev >= 100 ? '完成' : n.status === '完成' ? '待办' : n.status,
    });
    snaps.push({
      id: idOf(lastWeek),
      projectId: n.projectId,
      objectId: n.id,
      week: lastWeek,
      progress: base,
      status: n.status,
    });
    seq += 1;
  });
  return snaps;
}

/**
 * 构造完整演示数据集（T19）
 * 覆盖：A/B/C 各 1 进行中 + 1 审批中 + 1 已结项；含逾期任务、超 WIP、待审批、缺周报等边界样本
 * @prd 全局
 */
export function createSeedDb(): MockDb {
  const users = createUsers();
  const templates = createTemplates();
  const pb = createProjects(users, templates);
  const wb = createWbs(users);

  return {
    users,
    projects: pb.projects,
    members: pb.members,
    templates,
    gates: pb.gates,
    gateItems: pb.gateItems,
    milestones: pb.milestones,
    wbsNodes: wb.nodes,
    boardConfigs: wb.boardConfigs,
    reports: createReports(users, wb.nodes),
    reviews: createReviews(users),
    changes: createChanges(users),
    auditLogs: createAuditLogs(users),
    risks: createRisks(users),
    documents: createDocuments(users),
    reviewTemplates: DEFAULT_REVIEW_TEMPLATES.map((t) => ({ ...t, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })),
    roles: DEFAULT_ROLES.map((r) => ({ ...r })),
    progressSnapshots: createProgressSnapshots(wb),
    sessionOpenId: null,
  };
}
