import type { MockDb } from '../db';
import { createUsers } from './users';
import { createTemplates } from './templates';
import { createProjects } from './projects';
import { createWbs } from './wbs';
import { createReports } from './reports';
import { createReviews } from './reviews';
import { createChanges } from './changes';
import { createAuditLogs, createRisks, createDocuments } from './audit';

export { OPEN_IDS, nameOf } from './users';

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
    sessionOpenId: null,
  };
}
