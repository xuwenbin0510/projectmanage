import type { Report, ReportTaskRow, ReportRisk } from '@/types/report';
import type { WbsNode } from '@/types/wbs';
import { leafNodesOf } from '@/utils/wbs';
import type { User } from '@/types/project';
import { weekCode, weekRange, shiftWeek, today, addDays } from '@/utils/date';
import { OPEN_IDS, nameOf } from './users';

/**
 * 演示周报（T19）
 * 覆盖：上周已提交（P0012 / P0015）、本周缺报（P0012 / P0018 → 工作台红点）
 * @prd P0-08 P0-13
 */

interface ReportSpec {
  id: string;
  projectId: string;
  /** 相对当前周的偏移，-1 = 上周 */
  weekOffset: number;
  author: string;
  status: Report['status'];
  doneNote: string;
  planItems: string[];
  resourceNote: string;
  risks: Array<{ description: string; owner: string; dueOffset: number }>;
  /** 取该项目下前 n 个叶子任务作为关联任务 */
  taskCount: number;
}

const SPECS: ReportSpec[] = [
  {
    id: 'RP001',
    projectId: 'P0012',
    weekOffset: -1,
    author: OPEN_IDS.xuwenbin,
    status: '已提交',
    doneNote:
      '完成数据采集模块与接入网关联调，客户现场硬件已加电自检通过；ICD 二次确认仍在推进中。',
    planItems: [
      '完成遥测解析服务性能压测方案评审',
      '推动客户完成硬件接口 ICD 最终签署',
      '启动 QG4 集成测试门检查项收集',
    ],
    resourceNote: '需要 QA 增派 1 名测试工程师支持压测，预计投入 5 人日。',
    risks: [
      {
        description: '客户 ICD 二次确认延迟，可能继续影响需求基线冻结',
        owner: OPEN_IDS.xuwenbin,
        dueOffset: 5,
      },
      {
        description: '压测环境资源不足，性能指标验证存在不确定性',
        owner: OPEN_IDS.wangqiang,
        dueOffset: 9,
      },
    ],
    taskCount: 3,
  },
  {
    id: 'RP002',
    projectId: 'P0015',
    weekOffset: -1,
    author: OPEN_IDS.liming,
    status: '已提交',
    doneNote: '多星批量调度核心算法完成开发并通过单元测试，冲突检测准确率自测 98.6%。',
    planItems: ['完成冲突检测模块联调', '提交 QB2 技术方案门评审'],
    resourceNote: '暂无额外资源需求。',
    risks: [
      {
        description: '批量调度在 500 星规模下响应时间尚未验证',
        owner: OPEN_IDS.wangqiang,
        dueOffset: 6,
      },
    ],
    taskCount: 2,
  },
  {
    id: 'RP003',
    projectId: 'P0015',
    weekOffset: 0,
    author: OPEN_IDS.liming,
    status: '草稿',
    doneNote: '本周冲突检测联调进行中，进度约 60%。',
    planItems: ['完成联调并提交评审'],
    resourceNote: '',
    risks: [],
    taskCount: 2,
  },
];

/**
 * 生成演示周报；本周 P0012 / P0018 故意缺报，用于工作台「待填周报」红点
 * @prd P0-08
 */
export function createReports(users: User[], wbsNodes: WbsNode[]): Report[] {
  return SPECS.map((spec) => {
    const week = shiftWeek(weekCode(today()), spec.weekOffset);
    const range = weekRange(week);
    // SK-4：周报关联任务取「真叶子」（无子节点者），不再用 nodeType === 'task' 近似
    const leaves = leafNodesOf(
      wbsNodes.filter((n) => n.projectId === spec.projectId),
    ).slice(0, spec.taskCount);

    const tasks: ReportTaskRow[] = leaves.map((n) => ({
      reportId: spec.id,
      nodeId: n.id,
      nodeCode: n.wbsCode,
      nodeName: n.name,
      progressBefore: Math.max(0, n.progress - 20),
      progressAfter: n.progress,
      selected: n.progress > 0,
      // B8（R3）：本周实际人日（种子按 0，与 wbs fixtures effortHours=0 一致）
      weekActualDays: 0,
    }));

    const risks: ReportRisk[] = spec.risks.map((r, i) => ({
      id: `${spec.id}-RK${i + 1}`,
      reportId: spec.id,
      seq: i + 1,
      description: r.description,
      owner: r.owner,
      dueDate: addDays(today(), r.dueOffset),
      promotedRiskId: null,
    }));

    const submitted = spec.status === '已提交';
    const snapshot: Record<string, number> | null = submitted
      ? Object.fromEntries(tasks.map((t) => [t.nodeId, t.progressAfter]))
      : null;

    return {
      id: spec.id,
      projectId: spec.projectId,
      week,
      weekStart: range.start,
      weekEnd: range.end,
      author: spec.author,
      authorName: nameOf(users, spec.author),
      status: spec.status,
      doneNote: spec.doneNote,
      planItems: spec.planItems,
      resourceNote: spec.resourceNote,
      tasks,
      risks,
      snapshot,
      submittedAt: submitted ? `${range.end}T17:30:00.000Z` : null,
      // B14-块2：种子数据一律停在「已提交 / 草稿」，确认三字段留空，便于演示确认/打回
      confirmedBy: null,
      confirmedAt: null,
      rejectReason: null,
      createdAt: `${range.start}T09:00:00.000Z`,
      updatedAt: `${range.end}T17:30:00.000Z`,
    };
  });
}
