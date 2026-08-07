import type {
  Project,
  ProjectMember,
  QualityGate,
  GateStatus,
  GateChecklistItem,
  Milestone,
  LifecycleTemplate,
  User,
  ProjectRole,
  ProjectType,
  ProjectStatus,
  Health,
} from '@/types/project';
import { addDays, today, nowIso, diffDays } from '@/utils/date';
import { OPEN_IDS, nameOf } from './users';

/**
 * 演示项目集（T19）：A/B/C 各 1 个进行中项目 + 1 个审批中 + 1 个已结项归档
 * @prd P0-01 P0-02 P0-03 P0-04 P0-05
 *
 * ⚠️ 方案一（极简）：阶段实体已删除。实例化逻辑改为「按里程碑生成门」，
 * `currentStageSeq` 概念改为 `currentGateSeq`（第几道门在检）。
 */
interface ProjectSpec {
  id: string;
  code: string;
  name: string;
  type: ProjectType;
  templateId: string;
  customer: string;
  contractAmount: number;
  background: string;
  goal: string[];
  status: ProjectStatus;
  health: Health;
  planStartOffset: number;
  planEndOffset: number;
  /** 当前在检的门序号（1-based）；已结项项目填里程碑总数 */
  currentGateSeq: number;
  /** 当前在检门已勾选的检查项数量 */
  currentGateChecked: number;
  /** 前 n 个里程碑已达成（写入 doneAt，状态派生为「已达成」） */
  milestonesDone: number;
  members: Array<[string, ProjectRole]>;
  createdBy: string;
  classifySuggested: ProjectType;
  classifyOverrideReason: string;
  classifyInput: Project['classifyInput'];
  /** 已结项项目的实际完成日 */
  actualEndOffset?: number;
}

const SPECS: ProjectSpec[] = [
  {
    id: 'P0012',
    code: 'P-0012',
    name: '星舰数据中心一期',
    type: 'A',
    templateId: 'TPL-A',
    customer: 'XX 航天科技集团',
    contractAmount: 380,
    background:
      '客户需在西北基地建设一套星舰遥测数据中心，含数据采集硬件、接入软件与可视化平台，合同要求 2026 年内完成验收交付。',
    goal: ['完成遥测数据采集与接入平台建设', '通过客户现场验收', '交付全套技术文档并归档'],
    status: '进行中',
    health: 'yellow',
    planStartOffset: -70,
    planEndOffset: 165,
    currentGateSeq: 4,
    currentGateChecked: 2,
    milestonesDone: 2,
    members: [
      [OPEN_IDS.xuwenbin, 'pm'],
      [OPEN_IDS.wangqiang, 'tl'],
      [OPEN_IDS.chenjing, 'qa'],
      [OPEN_IDS.zhaolei, 'cm'],
      [OPEN_IDS.zhangmin, 'pmo'],
      [OPEN_IDS.wudi, 'member'],
      [OPEN_IDS.zhengshuang, 'member'],
      [OPEN_IDS.liming, 'member'],
    ],
    createdBy: OPEN_IDS.xuwenbin,
    classifySuggested: 'A',
    classifyOverrideReason: '',
    classifyInput: {
      contractAmount: 380,
      hasHardware: true,
      hasAcceptance: true,
      isSelfIteration: false,
      isInfrastructure: false,
    },
  },
  {
    id: 'P0015',
    code: 'P-0015',
    name: '星链调度平台 v2.3',
    type: 'B',
    templateId: 'TPL-B',
    customer: '内部（产品部）',
    contractAmount: 0,
    background: '星链调度平台产品化迭代，本 Sprint 聚焦多星批量调度与冲突检测能力。',
    goal: ['交付多星批量调度能力', '调度冲突检测准确率 ≥98%'],
    status: '进行中',
    health: 'green',
    planStartOffset: -6,
    planEndOffset: 8,
    currentGateSeq: 2,
    currentGateChecked: 1,
    milestonesDone: 1,
    members: [
      [OPEN_IDS.liming, 'pm'],
      [OPEN_IDS.wangqiang, 'tl'],
      [OPEN_IDS.sunyue, 'po'],
      [OPEN_IDS.chenjing, 'qa'],
      [OPEN_IDS.wudi, 'member'],
    ],
    createdBy: OPEN_IDS.liming,
    classifySuggested: 'B',
    classifyOverrideReason: '',
    classifyInput: {
      contractAmount: 0,
      hasHardware: false,
      hasAcceptance: false,
      isSelfIteration: true,
      isInfrastructure: false,
    },
  },
  {
    id: 'P0018',
    code: 'P-0018',
    name: '机房扩容工程',
    type: 'C',
    templateId: 'TPL-C',
    customer: '内部（基础设施部）',
    contractAmount: 96,
    background: '总部二期机房扩容 120 个机柜，含配电、精密空调与综合布线改造。',
    goal: ['新增 120 机柜可用容量', '双路配电冗余达标', '完成运维移交'],
    status: '进行中',
    health: 'red',
    planStartOffset: -90,
    planEndOffset: 60,
    currentGateSeq: 3,
    currentGateChecked: 1,
    milestonesDone: 2,
    members: [
      [OPEN_IDS.wangqiang, 'pm'],
      [OPEN_IDS.zhaolei, 'cm'],
      [OPEN_IDS.chenjing, 'qa'],
      [OPEN_IDS.xuwenbin, 'pmo'],
      [OPEN_IDS.zhengshuang, 'member'],
    ],
    createdBy: OPEN_IDS.wangqiang,
    classifySuggested: 'C',
    classifyOverrideReason: '',
    classifyInput: {
      contractAmount: 96,
      hasHardware: false,
      hasAcceptance: false,
      isSelfIteration: false,
      isInfrastructure: true,
    },
  },
  {
    id: 'P0021',
    code: 'P-0021',
    name: '遥测分析系统',
    type: 'A',
    templateId: 'TPL-A',
    customer: 'YY 卫星运营公司',
    contractAmount: 128,
    background: '为客户建设遥测数据分析系统，含离线分析与在线告警两部分，需客户现场验收。',
    goal: ['交付遥测分析与告警系统', '通过客户验收'],
    status: '审批中',
    health: 'green',
    planStartOffset: 7,
    planEndOffset: 220,
    currentGateSeq: 1,
    currentGateChecked: 0,
    milestonesDone: 0,
    members: [
      [OPEN_IDS.liming, 'pm'],
      [OPEN_IDS.wangqiang, 'tl'],
      [OPEN_IDS.chenjing, 'qa'],
      [OPEN_IDS.xuwenbin, 'pmo'],
    ],
    createdBy: OPEN_IDS.liming,
    classifySuggested: 'A',
    classifyOverrideReason: '',
    classifyInput: {
      contractAmount: 128,
      hasHardware: false,
      hasAcceptance: true,
      isSelfIteration: false,
      isInfrastructure: false,
    },
  },
  {
    id: 'P0009',
    code: 'P-0009',
    name: '老旧机房迁移',
    type: 'C',
    templateId: 'TPL-C',
    customer: '内部（基础设施部）',
    contractAmount: 45,
    background: '一号楼老旧机房整体迁移至二号楼新机房，已于上季度完成验收移交。',
    goal: ['完成 60 台设备迁移', '业务中断时间 <4 小时'],
    status: '已结项',
    health: 'green',
    planStartOffset: -300,
    planEndOffset: -150,
    currentGateSeq: 5,
    currentGateChecked: 2,
    milestonesDone: 5,
    actualEndOffset: -150,
    members: [
      [OPEN_IDS.wangqiang, 'pm'],
      [OPEN_IDS.zhaolei, 'cm'],
      [OPEN_IDS.xuwenbin, 'pmo'],
    ],
    createdBy: OPEN_IDS.wangqiang,
    classifySuggested: 'C',
    classifyOverrideReason: '',
    classifyInput: {
      contractAmount: 45,
      hasHardware: false,
      hasAcceptance: false,
      isSelfIteration: false,
      isInfrastructure: true,
    },
  },
];

export interface ProjectBundle {
  projects: Project[];
  members: ProjectMember[];
  gates: QualityGate[];
  gateItems: GateChecklistItem[];
  milestones: Milestone[];
}

/**
 * 按生命周期模板实例化项目的里程碑 + 门 + 检查项（方案一：一碑一门，无阶段）
 * @prd P0-02 P0-05
 */
export function createProjects(users: User[], templates: LifecycleTemplate[]): ProjectBundle {
  const ts = nowIso();
  const bundle: ProjectBundle = {
    projects: [],
    members: [],
    gates: [],
    gateItems: [],
    milestones: [],
  };

  for (const spec of SPECS) {
    const tpl = templates.find((t) => t.id === spec.templateId)!;
    const planStart = addDays(today(), spec.planStartOffset);
    const planEnd = addDays(today(), spec.planEndOffset);
    const isClosed = spec.status === '已结项';

    // 先落成员，便于取 PMO 作为门决议 / 达成操作人
    const pmoOpenId =
      spec.members.find(([openId, role]) => role === 'pmo')?.[0] ?? spec.createdBy;

    spec.members.forEach(([openId, role], i) => {
      bundle.members.push({
        id: `${spec.id}-MB${i + 1}`,
        projectId: spec.id,
        userOpenId: openId,
        userName: nameOf(users, openId),
        projectRole: role,
        assignedBy: spec.createdBy,
        assignedAt: planStart,
      });
    });

    // ── 逐里程碑生成：里程碑 + 其门（0..1） + 检查项 ──
    tpl.definition.milestones.forEach((md, idx) => {
      const baselineDate = addDays(planStart, md.offsetDays);
      // 演示：P-0012 的 M2 由变更单 CR-001 延后 7 天
      const delayed = spec.id === 'P0012' && md.code === 'M2';
      const currentDate = delayed ? addDays(baselineDate, 7) : baselineDate;
      const delayDays = diffDays(baselineDate, currentDate);
      const done = idx < spec.milestonesDone;

      bundle.milestones.push({
        id: `${spec.id}-${md.code}`,
        projectId: spec.id,
        code: md.code,
        name: md.name,
        target: '',
        required: md.required,
        baselineDate,
        currentDate,
        delayDays,
        // SK-2：status / done 为派生值，此处给初始值；读路径经 refreshMilestoneStatuses 重算
        status: done ? '已达成' : '未开始',
        done,
        doneAt: done ? currentDate : null,
        doneBy: done ? pmoOpenId : null,
        statusOverride: null,
        overrideBy: null,
        overrideAt: null,
        overrideBaseDate: null,
        lastChangeId: delayed ? 'CR001' : null,
        createdAt: ts,
        updatedAt: ts,
      });

      // 一碑一门（C-G1）：模板必备碑恒配门，用户自建碑无门（本轮不开放）
      if (md.gate) {
        const gateId = `${spec.id}-${md.gate.code}`;
        const isCurrent = !isClosed && idx === spec.currentGateSeq - 1;
        const gateStatus: GateStatus = done
          ? '已通过'
          : isCurrent
            ? '待检查'
            : '未开始';

        bundle.gates.push({
          id: gateId,
          projectId: spec.id,
          milestoneId: `${spec.id}-${md.code}`,
          code: md.gate.code,
          name: md.gate.name,
          ownerRole: md.gate.ownerRole,
          status: gateStatus,
          conclusion: done ? '已通过' : '',
          comment: done ? '检查项齐备，同意里程碑达成。' : '',
          decidedBy: done ? pmoOpenId : null,
          decidedAt: done ? currentDate : null,
          createdAt: ts,
        });

        md.gate.items.forEach((it, i) => {
          const checked = done || (isCurrent && i < spec.currentGateChecked);
          bundle.gateItems.push({
            id: `${gateId}-I${i + 1}`,
            gateId,
            seq: i + 1,
            content: it.content,
            ownerRole: it.ownerRole,
            checked,
            checkedBy: checked ? OPEN_IDS.chenjing : null,
            checkedAt: checked ? addDays(planStart, (idx + 1) * 18 - 2) : null,
            source: 'template',
          });
        });
      }
    });

    bundle.projects.push({
      id: spec.id,
      code: spec.code,
      name: spec.name,
      type: spec.type,
      classifyInput: spec.classifyInput,
      classifySuggested: spec.classifySuggested,
      classifyOverrideReason: spec.classifyOverrideReason,
      customer: spec.customer,
      contractAmount: spec.contractAmount,
      background: spec.background,
      goal: spec.goal,
      status: spec.status,
      // 方案一：currentStageId 已删除，进度以里程碑为唯一时间轴
      health: spec.health,
      planStart,
      planEnd,
      actualEnd:
        spec.actualEndOffset !== undefined ? addDays(today(), spec.actualEndOffset) : null,
      approvalStep: spec.status === '审批中' ? 1 : 0,
      templateId: spec.templateId,
      createdBy: spec.createdBy,
      createdAt: planStart,
      updatedAt: ts,
    });
  }

  return bundle;
}
