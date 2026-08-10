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

/**
 * 看板列（B11：补「阻塞」列，共 5 列）
 *
 * ⚠️ SK-B11-2 镜像对：与后端 `server/config/enums.js#BOARD_COLUMNS` **逐字一致**，
 *    改任一侧必须同一 commit 改另一侧。
 *
 * 顺序口径（决策 D-B11-3）：`待办 → 进行中 → 阻塞 → 待评审 → 完成`。
 *
 * ⚠️ 本常量仅用于 **Mock 引擎与类型约束**；页面渲染看板列的运行时单一数据源是
 *    服务端下发的 `BoardView.config.columns`，禁止在组件里遍历本常量。
 */
export const BOARD_COLUMNS: TaskStatus[] = ['待办', '进行中', '阻塞', '待评审', '完成'];

/**
 * 看板分列维度（B11 · 纯前端视图变换，不落后端参数）
 * - `status` 按状态分列（默认，可拖拽改状态）
 * - `owner`  按负责人分列（**只读**，见决策 D-B11-6）
 */
export type BoardGroupBy = 'status' | 'owner';

/** 看板筛选条件（B11 · 100% 前端过滤，切换零网络请求） */
export interface BoardFilter {
  /** 关键字：匹配 `wbsCode` 或 `name`，忽略大小写、去首尾空格；'' = 不过滤 */
  keyword: string;
  /** 负责人 openId；'' = 全部；`__unassigned__` = 仅未分配 */
  owner: string;
  /** 里程碑 id；'' = 全部；`__none__` = 仅未挂碑 */
  milestoneId: string;
  /** 仅看逾期（`dueDate` 早于今天） */
  overdueOnly: boolean;
}

/** 「未分配负责人」的筛选哨兵值（不会与真实 openId 冲突） */
export const OWNER_UNASSIGNED = '__unassigned__';

/** 「未关联里程碑」的筛选哨兵值 */
export const MILESTONE_NONE = '__none__';

/** 空筛选（用于初始化与「清空筛选」） */
export const EMPTY_BOARD_FILTER: BoardFilter = {
  keyword: '',
  owner: '',
  milestoneId: '',
  overdueOnly: false,
};

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
  /**
   * 累计实际工时（人日，B8 R1/R3）：叶子=历次已提交日志 actualDays 累加（服务端存储值）；
   * 父节点=Σ直接子节点（服务端 `decorateEffort` 计算，只读，禁止前端自行求和）。
   * 唯一写入方 = 工作日志 submit / 已提交日志编辑；WBS API 携带该字段 → E_WBS_EFFORT_WRITE_DISABLED。
   */
  effortHours: number;
  /** 直接子节点数（「由 N 个子任务汇总」的 N，服务端计算，前端只读引用） */
  effortChildCount: number;
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
  /**
   * 所属项目名（B11 新增·**仅 `GET /api/workbench` 的 `myTasks[]` 返回**）。
   *
   * 逾期柱状图需要按项目分组展示名称；`myTasks` 可能含「草稿 / 审批中 / 挂起」项目的任务，
   * 而 `myProjects` 只列在办，前端 join 会漏 → 服务端直接给名字最稳。
   * 其余 WBS 接口不返回该字段，故为可选。
   */
  projectName?: string;
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
