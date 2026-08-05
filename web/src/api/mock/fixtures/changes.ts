import type { Change } from '@/types/change';
import type { User } from '@/types/project';
import { addDays, today } from '@/utils/date';
import { OPEN_IDS, nameOf } from './users';

/**
 * 演示变更单（T19）
 * 覆盖：已批准并实施（驱动 M2 延期）、审批中（CCB 路由）、草稿（PM 直批路由）
 * @prd P0-14 P0-15
 */
export function createChanges(users: User[]): Change[] {
  const d = (o: number): string => `${addDays(today(), o)}T08:00:00.000Z`;

  return [
    {
      id: 'CR001',
      projectId: 'P0012',
      code: 'CR-001',
      changeType: 'milestone_date',
      title: 'M2 需求基线里程碑延后 7 天',
      content:
        '客户方硬件接口 ICD 二次确认延迟，导致需求基线无法按原计划冻结，申请将 M2 里程碑从基线日期延后 7 个自然日。',
      impactAnalysis:
        '影响范围：需求基线冻结、设计阶段启动各延后 7 天；通过压缩集成测试准备并行度可吸收，项目终期里程碑 M7 不变。追加工作量约 4 人日。',
      effortDays: 4,
      targetType: 'milestone',
      targetId: 'P0012-M2',
      payload: { fromDate: addDays(today(), -40), toDate: addDays(today(), -33) },
      route: 'ccb',
      status: '已实施',
      reviewId: 'RV002',
      createdBy: OPEN_IDS.xuwenbin,
      createdByName: nameOf(users, OPEN_IDS.xuwenbin),
      createdAt: d(-12),
      appliedAt: d(-9),
    },
    {
      id: 'CR002',
      projectId: 'P0012',
      code: 'CR-002',
      changeType: 'requirement_baseline',
      title: '新增「多源遥测数据比对」需求条目',
      content:
        '客户在集成测试阶段提出新增多源遥测数据比对能力，需在已冻结的需求基线上追加 3 条需求条目并同步更新 SRS。',
      impactAnalysis:
        '预计新增开发 6 人日、测试 2 人日，合计 8 人日，超过 3 人日阈值且涉及需求基线，需走 CCB。',
      effortDays: 8,
      targetType: 'requirement',
      targetId: 'SRS-3.4',
      payload: {},
      route: 'ccb',
      status: '审批中',
      reviewId: null,
      createdBy: OPEN_IDS.wangqiang,
      createdByName: nameOf(users, OPEN_IDS.wangqiang),
      createdAt: d(-2),
      appliedAt: null,
    },
    {
      id: 'CR003',
      projectId: 'P0015',
      code: 'CR-003',
      changeType: 'scope',
      title: '调整调度冲突提示文案与交互',
      content: '按 PO 反馈优化冲突提示的文案与二次确认交互，不涉及需求基线与里程碑。',
      impactAnalysis: '仅前端文案与交互微调，工作量约 1 人日，不影响里程碑。',
      effortDays: 1,
      targetType: 'scope',
      targetId: '',
      payload: {},
      route: 'pm_only',
      status: '草稿',
      reviewId: null,
      createdBy: OPEN_IDS.sunyue,
      createdByName: nameOf(users, OPEN_IDS.sunyue),
      createdAt: d(-1),
      appliedAt: null,
    },
    {
      id: 'CR004',
      projectId: 'P0018',
      code: 'CR-004',
      changeType: 'milestone_date',
      title: 'C2 精密空调到货里程碑延后 10 天',
      content: '供应商产能紧张，精密空调设备到货延迟，申请将 C2 里程碑延后 10 个自然日。',
      impactAnalysis: '直接影响后续安装与调试，项目终期里程碑同步延后 10 天，需客户书面确认。',
      effortDays: 0,
      targetType: 'milestone',
      targetId: 'P0018-C2',
      payload: { fromDate: addDays(today(), -5), toDate: addDays(today(), 5) },
      route: 'ccb',
      status: '审批中',
      reviewId: null,
      createdBy: OPEN_IDS.xuwenbin,
      createdByName: nameOf(users, OPEN_IDS.xuwenbin),
      createdAt: d(-4),
      appliedAt: null,
    },
  ];
}
