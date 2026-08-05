import type { Review, ReviewStep, Approval, ReviewType, ReviewMode } from '@/types/review';
import type { User } from '@/types/project';
import { REVIEW_TEMPLATES } from '@/config/enums';
import { addDays, today, nowIso } from '@/utils/date';
import { OPEN_IDS, nameOf } from './users';

/**
 * 演示评审单（T19）
 * 覆盖：串行链路进行中、并行一票否决、已通过、已驳回
 * @prd P0-09 P0-10
 */

interface ReviewSpec {
  id: string;
  projectId: string;
  projectName: string;
  refType: Review['refType'];
  refId: string;
  reviewType: ReviewType;
  title: string;
  status: Review['status'];
  /** 已决策的步骤数量（串行） */
  decidedSteps: number;
  /** 被驳回时驳回发生在第几步（0-based） */
  rejectAt?: number;
  initiator: string;
  createdOffset: number;
  /** 指定各步骤审批人 openId，缺省按角色兜底 */
  assignees: string[];
}

const ROLE_FALLBACK: Record<string, string> = {
  pm: OPEN_IDS.xuwenbin,
  tl: OPEN_IDS.wangqiang,
  qa: OPEN_IDS.chenjing,
  pmo: OPEN_IDS.zhangmin,
  cm: OPEN_IDS.zhaolei,
  po: OPEN_IDS.sunyue,
  management: OPEN_IDS.zhoutao,
  ccb: OPEN_IDS.zhangmin,
  customer_rep: OPEN_IDS.zhoutao,
};

const SPECS: ReviewSpec[] = [
  {
    id: 'RV001',
    projectId: 'P0012',
    projectName: '星舰数据中心一期',
    refType: 'gate',
    refId: 'P0012-QG4',
    reviewType: 'formal',
    title: 'QG4 集成测试门 · 阶段评审',
    status: '审批中',
    decidedSteps: 1,
    initiator: OPEN_IDS.xuwenbin,
    createdOffset: -3,
    assignees: [OPEN_IDS.wangqiang, OPEN_IDS.chenjing, OPEN_IDS.zhangmin],
  },
  {
    id: 'RV002',
    projectId: 'P0012',
    projectName: '星舰数据中心一期',
    refType: 'change',
    refId: 'CR001',
    reviewType: 'ccb',
    title: 'CR-001 M2 里程碑延后 7 天 · CCB 评审',
    status: '已通过',
    decidedSteps: 3,
    initiator: OPEN_IDS.xuwenbin,
    createdOffset: -12,
    assignees: [OPEN_IDS.wangqiang, OPEN_IDS.zhangmin, OPEN_IDS.zhoutao],
  },
  {
    id: 'RV003',
    projectId: 'P0015',
    projectName: '星链调度平台 v2.3',
    refType: 'gate',
    refId: 'P0015-QB2',
    reviewType: 'technical',
    title: 'QB2 技术方案门 · 技术评审',
    status: '审批中',
    decidedSteps: 0,
    initiator: OPEN_IDS.liming,
    createdOffset: -1,
    assignees: [OPEN_IDS.wangqiang, OPEN_IDS.chenjing],
  },
  {
    id: 'RV004',
    projectId: 'P0021',
    projectName: '遥测数据分析系统',
    refType: 'project',
    refId: 'P0021',
    reviewType: 'project',
    title: '遥测数据分析系统 · 立项审批',
    status: '审批中',
    decidedSteps: 1,
    initiator: OPEN_IDS.liming,
    createdOffset: -2,
    assignees: [OPEN_IDS.zhangmin, OPEN_IDS.zhoutao],
  },
  {
    id: 'RV005',
    projectId: 'P0018',
    projectName: '机房扩容工程',
    refType: 'gate',
    refId: 'P0018-QC2',
    reviewType: 'formal',
    title: 'QC2 施工方案门 · 阶段评审',
    status: '已驳回',
    decidedSteps: 2,
    rejectAt: 1,
    initiator: OPEN_IDS.xuwenbin,
    createdOffset: -8,
    assignees: [OPEN_IDS.wangqiang, OPEN_IDS.chenjing, OPEN_IDS.zhangmin],
  },
  {
    id: 'RV006',
    projectId: 'P0009',
    projectName: '老旧机房迁移',
    refType: 'project',
    refId: 'P0009',
    reviewType: 'project',
    title: '老旧机房迁移 · 结项审批',
    status: '已通过',
    decidedSteps: 2,
    initiator: OPEN_IDS.liming,
    createdOffset: -25,
    assignees: [OPEN_IDS.zhangmin, OPEN_IDS.zhoutao],
  },
];

const APPROVE_COMMENTS = [
  '方案完整，同意通过。',
  '检查项已核对齐备，同意。',
  '风险可控，同意进入下一阶段。',
  '已复核证据材料，通过。',
];

/** 构造演示评审单 */
export function createReviews(users: User[]): Review[] {
  const ts = nowIso();
  return SPECS.map((spec) => {
    const tpl = REVIEW_TEMPLATES[spec.reviewType];
    const mode: ReviewMode = tpl.mode;
    const createdAt = `${addDays(today(), spec.createdOffset)}T09:30:00.000Z`;

    const steps: ReviewStep[] = tpl.chain.map((role, idx) => {
      const assignee = spec.assignees[idx] ?? ROLE_FALLBACK[role] ?? OPEN_IDS.zhangmin;
      let status: ReviewStep['status'] = 'pending';
      if (spec.status === '已驳回') {
        if (spec.rejectAt !== undefined && idx === spec.rejectAt) status = 'rejected';
        else if (spec.rejectAt !== undefined && idx < spec.rejectAt) status = 'approved';
        else status = 'skipped';
      } else if (spec.status === '已通过') {
        status = 'approved';
      } else if (idx < spec.decidedSteps) {
        status = 'approved';
      } else if (idx === spec.decidedSteps) {
        status = mode === 'parallel_veto' ? 'current' : 'current';
      } else {
        status = mode === 'parallel_veto' ? 'current' : 'pending';
      }
      const decided = status === 'approved' || status === 'rejected';
      return {
        id: `${spec.id}-S${idx + 1}`,
        reviewId: spec.id,
        stepIndex: idx,
        role,
        assigneeOpenId: assignee,
        assigneeName: nameOf(users, assignee),
        required: true,
        status,
        decidedBy: decided ? assignee : null,
        decidedByName: decided ? nameOf(users, assignee) : '',
        decidedAt: decided ? `${addDays(today(), spec.createdOffset + idx + 1)}T10:00:00.000Z` : null,
        comment:
          status === 'approved'
            ? APPROVE_COMMENTS[idx % APPROVE_COMMENTS.length]
            : status === 'rejected'
              ? '施工方案缺少停电窗口应急预案与回退方案，请补充后重新提交。'
              : '',
      };
    });

    const approvals: Approval[] = [
      {
        id: `${spec.id}-A0`,
        reviewId: spec.id,
        projectId: spec.projectId,
        stepIndex: -1,
        stepRole: 'initiator',
        actorOpenId: spec.initiator,
        actorName: nameOf(users, spec.initiator),
        action: 'submit',
        comment: '发起评审',
        evidenceUrl: '',
        createdAt,
      },
    ];
    steps
      .filter((s) => s.status === 'approved' || s.status === 'rejected')
      .forEach((s, i) => {
        approvals.push({
          id: `${spec.id}-A${i + 1}`,
          reviewId: spec.id,
          projectId: spec.projectId,
          stepIndex: s.stepIndex,
          stepRole: s.role,
          actorOpenId: s.decidedBy ?? '',
          actorName: s.decidedByName,
          action: s.status === 'approved' ? 'approve' : 'reject',
          comment: s.comment,
          evidenceUrl: '',
          createdAt: s.decidedAt ?? createdAt,
        });
      });

    const closed = spec.status === '已通过' || spec.status === '已驳回';
    const currentStep = closed
      ? steps.length
      : steps.findIndex((s) => s.status === 'current') === -1
        ? 0
        : steps.findIndex((s) => s.status === 'current');

    return {
      id: spec.id,
      projectId: spec.projectId,
      projectName: spec.projectName,
      refType: spec.refType,
      refId: spec.refId,
      reviewType: spec.reviewType,
      title: spec.title,
      templateKey: tpl.key,
      mode,
      status: spec.status,
      currentStep,
      initiator: spec.initiator,
      initiatorName: nameOf(users, spec.initiator),
      createdAt,
      updatedAt: ts,
      closedAt: closed ? (steps[steps.length - 1]?.decidedAt ?? ts) : null,
      steps,
      approvals,
    };
  });
}
