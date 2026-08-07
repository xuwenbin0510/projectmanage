/** WBS 节点 / 看板配置（P0-06 / P0-07） */

/**
 * WBS 节点类型（简化方案一 · Q-3）
 * - `task` 任务：可作为容器（下挂任务 / 子任务），也可自身就是干活单元
 * - `subtask` 子任务：恒为叶子，不可再挂子节点
 *
 * ⚠️ SK-4：判断「是不是干活单元（叶子）」一律用 `utils/wbs.ts` 的
 * `leafNodesOf` / `isLeafNode`（口径 = `children.length === 0`），
 * **禁止**再写 `nodeType === 'task'`。
 */
export type WbsNodeType = 'task' | 'subtask';

/**
 * WBS 层级规则（模板驱动 · 引擎与页面共用同一份）
 *
 * - 落库位置：`lifecycle_templates.definition.wbsRules`
 * - 模板只写「与缺省不同」的项，其余由 `DEFAULT_WBS_RULES` 兜底
 *   （禁止在业务代码里散落 `if (projectType === 'B')` 之类的分支 · 决策 D-2 / SK-5）
 * @prd P0-06
 */
export interface WbsRules {
  /** 最大层级（含）。level 从 1 起算，缺省 4 */
  maxDepth: number;
  /**
   * 建项时 WBS 骨架预生成策略（决策 D-B）：
   * - `per-milestone` 为每个必备里程碑生成 1 个顶层任务，`milestoneId` 自动绑定
   * - `none` 不生成，新项目为空树
   */
  skeleton: 'none' | 'per-milestone';
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
  name: string;
  description: string;
  /** 负责人 openId（叶子必填；SK-13：仅 subtask 强制，无子 task 降级为告警） */
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
  /** 关联里程碑；该节点子树内的叶子会计入该里程碑的完成度 */
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
