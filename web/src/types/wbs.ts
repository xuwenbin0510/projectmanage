/** WBS 节点 / 看板配置（P0-06 / P0-07） */

export type WbsNodeType = 'stage' | 'package' | 'task';

/**
 * WBS 层级规则（模板驱动 · 引擎与页面共用同一份）
 *
 * - 落库位置：`lifecycle_templates.definition.wbsRules`
 * - 模板只写「与缺省不同」的项，其余由 `DEFAULT_WBS_RULES` 兜底
 *   （禁止在业务代码里散落 `if (projectType === 'B')` 之类的分支 · 决策 D-2）
 * @prd P0-06
 */
export interface WbsRules {
  /** 最大层级（含）。level 从 1 起算，缺省 4 = 工作分区/工作包/任务/子任务 */
  maxDepth: number;
  /** 是否允许根层直接挂 task（缺省 false：根层只能是工作分区或工作包） */
  allowRootTask: boolean;
  /** `nodeType==='stage'` 的 WBS 节点是否必须绑定生命周期阶段（A/C=true，B=false） */
  requireStageBinding: boolean;
  /** 建项时 WBS 骨架预生成策略：per-stage=按模板阶段逐个生成工作分区根节点；none=不生成 */
  skeleton: 'per-stage' | 'none';
  /** 父类型 → 允许的子节点类型；键 `root` 表示「无父节点」的根层 */
  childTypes: Record<'root' | WbsNodeType, WbsNodeType[]>;
}

export type TaskStatus = '待办' | '进行中' | '待评审' | '完成' | '阻塞';

export const BOARD_COLUMNS: TaskStatus[] = ['待办', '进行中', '待评审', '完成'];

export interface WbsNode {
  id: string;
  projectId: string;
  parentId: string | null;
  wbsCode: string;
  level: number;
  nodeType: WbsNodeType;
  /**
   * 绑定的生命周期阶段 id（project_stages.id）。
   * 仅 `nodeType==='stage'`（工作分区）可有值；其余类型恒为 null。
   * A/C 类必填（wbsRules.requireStageBinding=true），B 类可为 null。
   */
  lifecycleStageId: string | null;
  name: string;
  description: string;
  /** 负责人 openId（叶子必填） */
  owner: string;
  /** 负责人姓名（服务端派生的展示字段） */
  ownerName: string;
  estimateDays: number;
  actualDays: number;
  startDate: string;
  dueDate: string;
  status: TaskStatus;
  progress: number;
  boardOrder: number;
  isCritical: boolean;
  milestoneId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 带子节点的树形结构 */
export interface WbsTreeNode extends WbsNode {
  children: WbsTreeNode[];
  /** 粒度 / 完整性告警（非阻塞） */
  warnings: string[];
}

export interface BoardConfig {
  projectId: string;
  columns: TaskStatus[];
  /** { '进行中': 5 }；0 = 不限 */
  wipLimits: Record<string, number>;
  updatedAt: string;
}

export interface BoardColumn {
  status: TaskStatus;
  cards: WbsNode[];
  wipLimit: number;
}

export interface BoardView {
  projectId: string;
  columns: BoardColumn[];
  config: BoardConfig;
}
