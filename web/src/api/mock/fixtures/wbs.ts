import type { WbsNode, BoardConfig, TaskStatus, WbsNodeType, Priority } from '@/types/wbs';
import { BOARD_COLUMNS } from '@/types/wbs';
import type { User } from '@/types/project';
import { addDays, today, nowIso } from '@/utils/date';
import { OPEN_IDS, nameOf } from './users';
import { DEFAULT_WIP_LIMIT } from '@/config/enums';

/**
 * WBS 演示数据（含边界样本：逾期任务 / 粒度超限 / 叶子缺负责人 / 进行中列已满 WIP）
 * @prd P0-06 P0-07
 *
 * ⚠️ 存量种子仍按旧「stage / package / task」三型书写（历史数据，新模型仅 task / subtask），
 * 实例化时按 §2.4.4 确定性规则映射为「任务(task) / 子任务(subtask)」两型：
 *   · stage / package → 恒为 task
 *   · task 且有子节点 → task（容器）
 *   · task 且无子节点 → subtask（真叶子）
 * 这样 43 个节点映射为 task 15 / subtask 28，且满足「subtask 必为叶」「根层无 subtask」。
 */

/** 种子期的旧三型；仅用于书写，实例化时映射掉，不进入运行时类型 */
type SeedNodeType = 'stage' | 'package' | 'task';

type NodeSpec = [
  code: string,
  name: string,
  nodeType: SeedNodeType,
  owner: string,
  estimateDays: number,
  progress: number,
  status: TaskStatus,
  dueOffset: number,
];

/** 种子节点 → 最终 nodeType（§2.4.4 确定性映射） */
function mapSeedNodeType(t: SeedNodeType, hasChild: boolean): WbsNodeType {
  if (t === 'task') return hasChild ? 'task' : 'subtask';
  return 'task'; // stage / package → task
}

/**
 * 种子优先级（B14-块1，**确定性**规则，保证每次 reset 结果一致）：
 * - 已逾期（`dueOffset < 0`）且未完成 → `P0`（演示环图红色 + 逾期清单置顶）
 * - 关键路径分支（`1.2` / `1.4` 前缀，与 `isCritical` 同口径）→ `P1`
 * - 阻塞态 → `P1`（需要尽快解阻）
 * - 其余 → 缺省 `P2`；已完成且非关键 → `P3`（降噪，让环图四色齐全）
 */
function seedPriority(code: string, status: TaskStatus, dueOffset: number): Priority {
  const critical = code.startsWith('1.2') || code.startsWith('1.4');
  if (dueOffset < 0 && status !== '完成') return 'P0';
  if (status === '阻塞') return 'P1';
  if (critical) return 'P1';
  if (status === '完成') return 'P3';
  return 'P2';
}

/**
 * 里程碑挂载（§2.6 补挂建议）：把二级容器 task 绑到对应里程碑。
 *
 * ⚠️ 口径 Y（SK-M4）：被绑定的容器节点**自身也计入**该里程碑的关联任务集合，
 *    其子树真叶子一并计入（按 id 去重）；但**加权完成度只算真叶子**，
 *    容器节点权重为 0。详见 `src/utils/wbs.ts · milestoneTaskDetail`。
 */
const MILESTONE_BIND: Record<string, Record<string, string>> = {
  P0012: { '1.1': 'M2', '1.2': 'M3', '1.3': 'M4', '1.4': 'M4', '1.5': 'M5' },
  P0015: { '1.1': 'M2', '1.2': 'M3' },
  P0018: { '1.1': 'M2', '1.2': 'M4', '1.3': 'M5' },
  P0009: { '1.1': 'M4', '1.2': 'M5' },
  P0021: { '1': 'M1' },
};

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
  ['1.4', '数据接入模块', 'package', '', 0, 0, '进行中', 20],
  ['1.4.1', '采集协议解析', 'task', OPEN_IDS.wudi, 4, 60, '进行中', 5],
  ['1.4.2', '数据入库服务', 'task', OPEN_IDS.zhengshuang, 3, 30, '进行中', 7],
  ['1.3.1', '采集模块开发', 'task', OPEN_IDS.wudi, 5, 0, '待办', 12],
  /* B11：阻塞列样本（progress 0，syncWbsProgressStatus 会原样保留「阻塞」人工态） */
  ['1.3.2', '告警引擎开发', 'task', OPEN_IDS.zhengshuang, 4, 0, '阻塞', 16],
  ['1.3.3', '前端可视化开发', 'task', '', 0, 0, '待办', 20],
  ['1.3.4', '联调脚本编写', 'task', OPEN_IDS.wudi, 2, 20, '进行中', 9],
  ['1.3.5', '性能压测准备', 'task', OPEN_IDS.xuwenbin, 3, 10, '进行中', -3],
  ['1.5', '集成测试', 'package', '', 0, 0, '待办', 90],
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
  /* B11：阻塞列样本 */
  ['1.2.1', '调度引擎重构', 'task', OPEN_IDS.wangqiang, 3, 0, '阻塞', 8],
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
    const codes = specs.map((s) => s[0]);
    specs.forEach((s, i) => {
      codeToId.set(s[0], `${projectId}-W${i + 1}`);
    });

    // 判断某 code 是否有子节点（决定 task 还是 subtask）
    const hasChild = (code: string): boolean =>
      codes.some((c) => c.startsWith(`${code}.`));

    specs.forEach((s, i) => {
      const [code, name, seedType, owner, estimateDays, progress, status, dueOffset] = s;
      const pCode = parentCodeOf(code);
      const milestoneCode = MILESTONE_BIND[projectId]?.[code];
      nodes.push({
        id: `${projectId}-W${i + 1}`,
        projectId,
        parentId: pCode ? (codeToId.get(pCode) ?? null) : null,
        wbsCode: code,
        level: code.split('.').length,
        nodeType: mapSeedNodeType(seedType, hasChild(code)),
        name,
        description: '',
        owner,
        ownerName: nameOf(users, owner),
        estimateDays,
        actualDays: Number(((estimateDays * progress) / 100).toFixed(1)),
        // B8：累计实际工时（人日）种子按 0 起步（日志 submit 后累加）；读时由 mock decorateEffort 覆盖父节点 Σ
        effortHours: 0,
        effortChildCount: 0,
        startDate: addDays(today(), dueOffset - 10),
        dueDate: addDays(today(), dueOffset),
        status,
        progress,
        // B14-块1：种子优先级 —— 关键路径给 P1，逾期未完成给 P0，其余走缺省 P2
        priority: seedPriority(code, status, dueOffset),
        boardOrder: i,
        isCritical: code.startsWith('1.2') || code.startsWith('1.4'),
        milestoneId: milestoneCode ? `${projectId}-${milestoneCode}` : null,
        createdBy: OPEN_IDS.xuwenbin,
        createdAt: ts,
        updatedAt: ts,
      });
    });

    /* B11：列定义单一来源 = BOARD_COLUMNS（含「阻塞」共 5 列），禁止再硬编码数组 */
    boardConfigs.push({
      projectId,
      columns: [...BOARD_COLUMNS],
      wipLimits: { 进行中: DEFAULT_WIP_LIMIT },
      updatedAt: ts,
    });
  }

  return { nodes, boardConfigs };
}
