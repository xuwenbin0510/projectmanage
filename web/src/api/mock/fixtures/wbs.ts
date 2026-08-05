import type { WbsNode, BoardConfig, TaskStatus, WbsNodeType } from '@/types/wbs';
import type { User } from '@/types/project';
import { addDays, today, nowIso } from '@/utils/date';
import { OPEN_IDS, nameOf } from './users';
import { DEFAULT_WIP_LIMIT } from '@/config/enums';

/**
 * WBS 演示数据（含边界样本：逾期任务 / 粒度超限 / 叶子缺负责人 / 进行中列已满 WIP）
 * @prd P0-06 P0-07
 */

type NodeSpec = [
  code: string,
  name: string,
  nodeType: WbsNodeType,
  owner: string,
  estimateDays: number,
  progress: number,
  status: TaskStatus,
  dueOffset: number,
];

const P0012: NodeSpec[] = [
  ['1', '星舰数据中心一期', 'stage', '', 0, 0, '进行中', 165],
  ['1.1', '需求阶段', 'package', '', 0, 0, '完成', -40],
  ['1.1.1', '客户需求调研', 'task', OPEN_IDS.liming, 3, 100, '完成', -55],
  ['1.1.2', '需求规格说明书编写', 'task', OPEN_IDS.liming, 5, 100, '完成', -45],
  ['1.2', '设计阶段', 'package', '', 0, 0, '进行中', -5],
  ['1.2.1', '系统架构设计', 'task', OPEN_IDS.wangqiang, 5, 80, '进行中', -2],
  ['1.2.2', '硬件接口 ICD 定义', 'task', OPEN_IDS.wangqiang, 8, 40, '待评审', -4],
  ['1.2.3', '详细设计评审准备', 'task', OPEN_IDS.wudi, 2, 100, '完成', -8],
  ['1.3', '开发实施', 'package', '', 0, 0, '进行中', 60],
  // 存量违规修正（WBS 重构 D-2）：原 1.3.1「数据接入模块」package 挂在 package(1.3) 下违反
  // 「package→task」白名单；提升为根级 package（根节点 1 为 stage，允许挂 package），顺延集成测试编码
  ['1.4', '数据接入模块', 'package', '', 0, 0, '进行中', 20],
  ['1.4.1', '采集协议解析', 'task', OPEN_IDS.wudi, 4, 60, '进行中', 5],
  ['1.4.2', '数据入库服务', 'task', OPEN_IDS.zhengshuang, 3, 30, '进行中', 7],
  ['1.3.1', '采集模块开发', 'task', OPEN_IDS.wudi, 5, 0, '待办', 12],
  ['1.3.2', '告警引擎开发', 'task', OPEN_IDS.zhengshuang, 4, 0, '待办', 16],
  ['1.3.3', '前端可视化开发', 'task', '', 0, 0, '待办', 20],
  ['1.3.4', '联调脚本编写', 'task', OPEN_IDS.wudi, 2, 20, '进行中', 9],
  ['1.3.5', '性能压测准备', 'task', OPEN_IDS.xuwenbin, 3, 10, '进行中', -3],
  ['1.5', '集成测试', 'package', '', 0, 0, '未开始' as TaskStatus extends never ? never : TaskStatus, 90],
  ['1.5.1', '集成测试用例编写', 'task', OPEN_IDS.xuwenbin, 3, 0, '待办', 4],
  ['1.5.2', '缺陷回归', 'task', OPEN_IDS.xuwenbin, 2, 0, '待办', -1],
];

const P0015: NodeSpec[] = [
  ['1', '星链调度平台 v2.3', 'stage', '', 0, 0, '进行中', 8],
  ['1.1', 'Sprint 7', 'package', '', 0, 0, '进行中', 8],
  ['1.1.1', '多星批量调度 API', 'task', OPEN_IDS.wangqiang, 2, 70, '进行中', 2],
  ['1.1.2', '冲突检测算法', 'task', OPEN_IDS.wudi, 2, 40, '进行中', 3],
  ['1.1.3', '调度看板前端', 'task', OPEN_IDS.liming, 1.5, 100, '完成', -1],
  ['1.1.4', '回归测试', 'task', OPEN_IDS.chenjing, 1, 0, '待办', 5],
  ['1.2', '技术债', 'package', '', 0, 0, '待办', 14],
  ['1.2.1', '调度引擎重构', 'task', OPEN_IDS.wangqiang, 3, 0, '待办', 8],
];

const P0018: NodeSpec[] = [
  ['1', '机房扩容工程', 'stage', '', 0, 0, '进行中', 60],
  ['1.1', '方案设计', 'package', '', 0, 0, '完成', -55],
  ['1.1.1', '配电方案设计', 'task', OPEN_IDS.wangqiang, 4, 100, '完成', -70],
  ['1.1.2', '精密空调选型', 'task', OPEN_IDS.zhaolei, 3, 100, '完成', -60],
  ['1.2', '采购施工', 'package', '', 0, 0, '进行中', 20],
  ['1.2.1', '机柜到货验收', 'task', OPEN_IDS.zhaolei, 2, 100, '完成', -20],
  ['1.2.2', '综合布线施工', 'task', OPEN_IDS.zhengshuang, 6, 55, '进行中', -5],
  ['1.2.3', '配电改造施工', 'task', OPEN_IDS.zhengshuang, 5, 30, '进行中', 6],
  ['1.2.4', '精密空调安装', 'task', '', 0, 0, '待办', 14],
  ['1.3', '调试验收', 'package', '', 0, 0, '待办', 40],
  ['1.3.1', '系统联调', 'task', OPEN_IDS.chenjing, 3, 0, '待办', 25],
];

const P0021: NodeSpec[] = [['1', '遥测分析系统', 'stage', '', 0, 0, '待办', 220]];

const P0009: NodeSpec[] = [
  ['1', '老旧机房迁移', 'stage', '', 0, 0, '完成', -150],
  ['1.1', '设备迁移', 'task', OPEN_IDS.zhengshuang, 5, 100, '完成', -170],
  ['1.2', '验收移交', 'task', OPEN_IDS.zhaolei, 2, 100, '完成', -152],
];

const ALL: Array<[string, NodeSpec[]]> = [
  ['P0012', P0012],
  ['P0015', P0015],
  ['P0018', P0018],
  ['P0021', P0021],
  ['P0009', P0009],
];

/** 由 wbsCode 推导父节点 code（1.2.3 → 1.2；1 → null） */
function parentCodeOf(code: string): string | null {
  const idx = code.lastIndexOf('.');
  return idx === -1 ? null : code.slice(0, idx);
}

export interface WbsBundle {
  nodes: WbsNode[];
  boardConfigs: BoardConfig[];
}

export function createWbs(users: User[]): WbsBundle {
  const ts = nowIso();
  const nodes: WbsNode[] = [];
  const boardConfigs: BoardConfig[] = [];

  for (const [projectId, specs] of ALL) {
    const codeToId = new Map<string, string>();
    specs.forEach((s, i) => {
      codeToId.set(s[0], `${projectId}-W${i + 1}`);
    });

    specs.forEach((s, i) => {
      const [code, name, nodeType, owner, estimateDays, progress, status, dueOffset] = s;
      const pCode = parentCodeOf(code);
      nodes.push({
        id: `${projectId}-W${i + 1}`,
        projectId,
        parentId: pCode ? (codeToId.get(pCode) ?? null) : null,
        wbsCode: code,
        level: code.split('.').length,
        nodeType,
        // 存量种子节点名称不可靠，不按名称猜测阶段归属；统一 null，由 UI 提示补选
        lifecycleStageId: null,
        name,
        description: '',
        owner,
        ownerName: nameOf(users, owner),
        estimateDays,
        actualDays: Number(((estimateDays * progress) / 100).toFixed(1)),
        startDate: addDays(today(), dueOffset - 10),
        dueDate: addDays(today(), dueOffset),
        status,
        progress,
        boardOrder: i,
        isCritical: code.startsWith('1.2') || code.startsWith('1.4'),
        milestoneId: null,
        createdBy: OPEN_IDS.xuwenbin,
        createdAt: ts,
        updatedAt: ts,
      });
    });

    boardConfigs.push({
      projectId,
      columns: ['待办', '进行中', '待评审', '完成'],
      wipLimits: { 进行中: DEFAULT_WIP_LIMIT },
      updatedAt: ts,
    });
  }

  return { nodes, boardConfigs };
}
