import type { AuditLog, Risk, ProjectDocument } from '@/types/audit';
import type { User } from '@/types/project';
import { addDays, today } from '@/utils/date';
import { OPEN_IDS, nameOf } from './users';

/**
 * 演示审计日志 + P1 风险/文档种子（T19）
 * @prd P0-16（审计）/ P1（风险、文档）
 */

interface LogSpec {
  id: string;
  projectId: string;
  projectName: string;
  entityType: AuditLog['entityType'];
  entityId: string;
  action: AuditLog['action'];
  actor: string;
  offset: number;
  hour: string;
  summary: string;
  diff: AuditLog['diff'];
}

const LOGS: LogSpec[] = [
  {
    id: 'AL001',
    projectId: 'P0012',
    projectName: '星舰数据中心一期',
    entityType: 'project',
    entityId: 'P0012',
    action: 'create',
    actor: OPEN_IDS.xuwenbin,
    offset: -70,
    hour: '09:12',
    summary: '创建项目「星舰数据中心一期」，分类判定 A 类（合同额 380 万 + 含硬件 + 需验收）',
    diff: [{ field: 'type', label: '项目分类', before: '', after: 'A 类（工程交付型）' }],
  },
  {
    id: 'AL002',
    projectId: 'P0012',
    projectName: '星舰数据中心一期',
    entityType: 'gate',
    entityId: 'P0012-QG1',
    action: 'decide',
    actor: OPEN_IDS.zhangmin,
    offset: -55,
    hour: '16:40',
    summary: 'QG1 立项门检查通过，阶段 S1 关闭',
    diff: [{ field: 'status', label: '门状态', before: '待检查', after: '已通过' }],
  },
  {
    id: 'AL003',
    projectId: 'P0012',
    projectName: '星舰数据中心一期',
    entityType: 'change',
    entityId: 'CR001',
    action: 'create',
    actor: OPEN_IDS.xuwenbin,
    offset: -12,
    hour: '08:05',
    summary: '提交变更单 CR-001「M2 里程碑延后 7 天」，路由判定 CCB',
    diff: [{ field: 'route', label: '审批路由', before: '', after: 'CCB 变更控制委员会' }],
  },
  {
    id: 'AL004',
    projectId: 'P0012',
    projectName: '星舰数据中心一期',
    entityType: 'review',
    entityId: 'RV002',
    action: 'approve',
    actor: OPEN_IDS.zhoutao,
    offset: -9,
    hour: '11:20',
    summary: 'CCB 终审通过 CR-001',
    diff: [{ field: 'status', label: '评审状态', before: '审批中', after: '已通过' }],
  },
  {
    id: 'AL005',
    projectId: 'P0012',
    projectName: '星舰数据中心一期',
    entityType: 'milestone',
    entityId: 'P0012-M2',
    action: 'apply',
    actor: OPEN_IDS.xuwenbin,
    offset: -9,
    hour: '11:26',
    summary: '变更实施：M2 当前日期由基线延后 7 天（基线日期保持不变）',
    diff: [
      { field: 'currentDate', label: '当前日期', before: addDays(today(), -40), after: addDays(today(), -33) },
      { field: 'delayDays', label: '累计延期', before: '0 天', after: '7 天' },
    ],
  },
  {
    id: 'AL006',
    projectId: 'P0012',
    projectName: '星舰数据中心一期',
    entityType: 'wbs_node',
    entityId: 'P0012-W9',
    action: 'status_change',
    actor: OPEN_IDS.wudi,
    offset: -4,
    hour: '14:02',
    summary: '任务「遥测解析服务开发」状态由「进行中」变更为「待评审」',
    diff: [{ field: 'status', label: '任务状态', before: '进行中', after: '待评审' }],
  },
  {
    id: 'AL007',
    projectId: 'P0012',
    projectName: '星舰数据中心一期',
    entityType: 'report',
    entityId: 'RP001',
    action: 'create',
    actor: OPEN_IDS.xuwenbin,
    offset: -3,
    hour: '17:31',
    summary: '提交上周周报，冻结 3 条任务进度快照',
    diff: [{ field: 'status', label: '周报状态', before: '草稿', after: '已提交' }],
  },
  {
    id: 'AL008',
    projectId: 'P0012',
    projectName: '星舰数据中心一期',
    entityType: 'review',
    entityId: 'RV001',
    action: 'create',
    actor: OPEN_IDS.xuwenbin,
    offset: -3,
    hour: '09:30',
    summary: '发起 QG4 集成测试门阶段评审（串行：TL → QA → PMO）',
    diff: [],
  },
  {
    id: 'AL009',
    projectId: 'P0015',
    projectName: '星链调度平台 v2.3',
    entityType: 'project',
    entityId: 'P0015',
    action: 'create',
    actor: OPEN_IDS.liming,
    offset: -6,
    hour: '10:00',
    summary: '创建项目「星链调度平台 v2.3」，分类判定 B 类（自研迭代）',
    diff: [{ field: 'type', label: '项目分类', before: '', after: 'B 类（产品迭代型）' }],
  },
  {
    id: 'AL010',
    projectId: 'P0018',
    projectName: '机房扩容工程',
    entityType: 'project',
    entityId: 'P0018',
    action: 'update',
    actor: OPEN_IDS.zhangmin,
    offset: -2,
    hour: '15:45',
    summary: '项目健康度由「黄」调整为「红」：C2 里程碑逾期且存在无负责人任务',
    diff: [{ field: 'health', label: '健康度', before: '黄', after: '红' }],
  },
  {
    id: 'AL011',
    projectId: 'P0018',
    projectName: '机房扩容工程',
    entityType: 'review',
    entityId: 'RV005',
    action: 'reject',
    actor: OPEN_IDS.chenjing,
    offset: -6,
    hour: '10:30',
    summary: 'QC2 施工方案门评审被驳回：缺少停电窗口应急预案',
    diff: [{ field: 'status', label: '评审状态', before: '审批中', after: '已驳回' }],
  },
  {
    id: 'AL012',
    projectId: 'P0009',
    projectName: '老旧机房迁移',
    entityType: 'project',
    entityId: 'P0009',
    action: 'status_change',
    actor: OPEN_IDS.zhangmin,
    offset: -25,
    hour: '18:00',
    summary: '项目结项通过，状态由「进行中」变更为「已结项」',
    diff: [{ field: 'status', label: '项目状态', before: '进行中', after: '已结项' }],
  },
];

/** 构造演示审计日志（倒序：最新在前） */
export function createAuditLogs(users: User[]): AuditLog[] {
  return LOGS.map((l) => ({
    id: l.id,
    projectId: l.projectId,
    projectName: l.projectName,
    entityType: l.entityType,
    entityId: l.entityId,
    action: l.action,
    actorOpenId: l.actor,
    actorName: nameOf(users, l.actor),
    before: null,
    after: null,
    diff: l.diff,
    summary: l.summary,
    createdAt: `${addDays(today(), l.offset)}T${l.hour}:00.000Z`,
  })).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** P1 风险登记册种子（占位页展示用） */
export function createRisks(users: User[]): Risk[] {
  return [
    {
      id: 'RK001',
      projectId: 'P0012',
      code: 'R-001',
      description: '客户硬件接口 ICD 二次确认延迟，影响需求基线冻结',
      category: '需求',
      probability: 4,
      impact: 4,
      riskValue: 16,
      strategy: '减轻：每周与客户接口人对齐一次，预留 5 天缓冲',
      owner: nameOf(users, OPEN_IDS.xuwenbin),
      status: '跟踪中',
      reviewDate: addDays(today(), 7),
    },
    {
      id: 'RK002',
      projectId: 'P0012',
      code: 'R-002',
      description: '压测环境资源不足，性能指标无法充分验证',
      category: '技术',
      probability: 3,
      impact: 4,
      riskValue: 12,
      strategy: '减轻：申请共享压测集群时间窗口',
      owner: nameOf(users, OPEN_IDS.wangqiang),
      status: '跟踪中',
      reviewDate: addDays(today(), 10),
    },
    {
      id: 'RK003',
      projectId: 'P0018',
      code: 'R-003',
      description: '精密空调供应商产能紧张，到货时间不可控',
      category: '供应链',
      probability: 5,
      impact: 5,
      riskValue: 25,
      strategy: '转移：启用备选供应商并签署违约条款',
      owner: nameOf(users, OPEN_IDS.xuwenbin),
      status: '已升级',
      reviewDate: addDays(today(), 3),
    },
  ];
}

/** P1 文档清单种子（占位页展示用） */
export function createDocuments(users: User[]): ProjectDocument[] {
  const owner = nameOf(users, OPEN_IDS.xuwenbin);
  return [
    {
      id: 'DC001',
      projectId: 'P0012',
      stageId: 'P0012-S1',
      templateKey: 'charter',
      name: '项目章程 v1.0',
      status: '已基线',
      version: '1.0',
      baselineFlag: true,
      url: '',
      owner,
    },
    {
      id: 'DC002',
      projectId: 'P0012',
      stageId: 'P0012-S2',
      templateKey: 'srs',
      name: '需求规格说明书 SRS v1.2',
      status: '已基线',
      version: '1.2',
      baselineFlag: true,
      url: '',
      owner: nameOf(users, OPEN_IDS.sunyue),
    },
    {
      id: 'DC003',
      projectId: 'P0012',
      stageId: 'P0012-S3',
      templateKey: 'hld',
      name: '概要设计说明书 v1.0',
      status: '评审中',
      version: '1.0',
      baselineFlag: false,
      url: '',
      owner: nameOf(users, OPEN_IDS.wangqiang),
    },
    {
      id: 'DC004',
      projectId: 'P0012',
      stageId: 'P0012-S4',
      templateKey: 'test_plan',
      name: '集成测试计划 v0.9',
      status: '草稿',
      version: '0.9',
      baselineFlag: false,
      url: '',
      owner: nameOf(users, OPEN_IDS.chenjing),
    },
  ];
}
