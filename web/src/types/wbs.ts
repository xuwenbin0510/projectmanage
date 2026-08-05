/** WBS 节点 / 看板配置（P0-06 / P0-07） */

export type WbsNodeType = 'stage' | 'package' | 'task';

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
