import type { WbsNode, WbsTreeNode } from '@/types/wbs';
import type { ProjectType, MilestoneTaskStats } from '@/types/project';
import { GRANULARITY_LIMIT } from '@/config/enums';

/**
 * WBS 纯函数工具：建树 / 编码重排 / 粒度校验
 * @prd P0-06
 */

/** 扁平节点 → 树（按 wbsCode 自然排序） */
export function buildTree(nodes: WbsNode[], projectType: ProjectType = 'A'): WbsTreeNode[] {
  const map = new Map<string, WbsTreeNode>();
  const roots: WbsTreeNode[] = [];

  for (const n of nodes) {
    map.set(n.id, { ...n, children: [], warnings: [] });
  }
  for (const n of nodes) {
    const node = map.get(n.id)!;
    if (n.parentId && map.has(n.parentId)) {
      map.get(n.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortRec = (list: WbsTreeNode[]): void => {
    list.sort((a, b) => compareWbsCode(a.wbsCode, b.wbsCode));
    for (const c of list) sortRec(c.children);
  };
  sortRec(roots);

  const annotate = (list: WbsTreeNode[]): void => {
    for (const node of list) {
      node.warnings = nodeWarnings(node, projectType);
      annotate(node.children);
    }
  };
  annotate(roots);

  return roots;
}

/** wbsCode 自然排序比较：1.2.10 排在 1.2.9 之后 */
export function compareWbsCode(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number(s) || 0);
  const pb = b.split('.').map((s) => Number(s) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 是否叶子节点（树形节点版） */
export function isLeaf(node: WbsTreeNode): boolean {
  return node.children.length === 0;
}

/* ═══════════════════════════════════════════════════
 * 🔴 叶子口径统一入口（SK-4）
 *   「叶子」= 无子节点，**不是** `nodeType === 'task'`。
 *   进度汇总 / WIP / 看板卡片 / 工作台 / 周报 一律走这两个函数。
 * ═══════════════════════════════════════════════════ */

/** 扁平节点集 → 「父 id → 子节点」索引（内部复用，O(n)） */
function indexChildren(nodes: WbsNode[]): Map<string, WbsNode[]> {
  const map = new Map<string, WbsNode[]>();
  for (const n of nodes) {
    const key = n.parentId ?? '__root__';
    const arr = map.get(key);
    if (arr) arr.push(n);
    else map.set(key, [n]);
  }
  return map;
}

/**
 * 取扁平节点集中的全部真叶子（无子节点者）。
 * ⚠️ SK-4：任何「这是不是干活单元」的判断都走这里。
 */
export function leafNodesOf(nodes: WbsNode[]): WbsNode[] {
  const hasChild = new Set<string>();
  for (const n of nodes) {
    if (n.parentId) hasChild.add(n.parentId);
  }
  return nodes.filter((n) => !hasChild.has(n.id));
}

/** 指定节点在给定节点集中是否为真叶子 */
export function isLeafNode(nodes: WbsNode[], nodeId: string): boolean {
  return !nodes.some((n) => n.parentId === nodeId);
}

/**
 * 叶子加权完成度 0~100：`Σ(estimateDays||1 × progress) / Σ(estimateDays||1)`
 * 项目整体进度与里程碑关联任务完成度共用同一算法（§2.5.3，零新范式）。
 */
export function weightedProgress(leaves: WbsNode[]): number {
  if (!leaves.length) return 0;
  const totalWeight = leaves.reduce((s, n) => s + (n.estimateDays || 1), 0);
  if (totalWeight === 0) return 0;
  const acc = leaves.reduce((s, n) => s + (n.estimateDays || 1) * (n.progress / 100), 0);
  return Math.round((acc / totalWeight) * 100);
}

/** 扁平节点集 → 「拥有子节点」的父 id 集合（O(n)，真叶子判定的统一入口） */
export function parentIdSet(nodes: WbsNode[]): Set<string> {
  const s = new Set<string>();
  for (const n of nodes) if (n.parentId) s.add(n.parentId);
  return s;
}

/**
 * 里程碑关联任务明细（口径 Y · SK-M4）
 * 「关联任务」的**唯一真源**：计数、加权、钻取列表三处必须全部从这里派生。
 */
export interface MilestoneTaskDetail {
  /**
   * 口径 Y 集合：`{ milestoneId === msId 的节点 }` ∪ `{ 这些节点子树内的真叶子 }`，
   * 按 `id` 去重、按 `wbsCode` 自然序排列（父在子之前，便于钻取弹窗缩进渲染）。
   */
  nodes: WbsNode[];
  /** `nodes` 中的**非叶子**（汇总）节点 id —— 钻取弹窗据此渲染「汇总」Chip，且不计权重 */
  rollupIds: Set<string>;
  /** `nodes` 中的**真叶子** —— 加权完成度的唯一输入（P0-M10） */
  leaves: WbsNode[];
}

/**
 * 里程碑关联任务明细（口径 Y · SK-M4 唯一真源）。
 *
 * 集合 = `{ milestoneId === msId 的节点（直接绑定节点自身）}` ∪ `{ 直接绑定节点子树内的真叶子 }`，按 `id` 去重。
 *
 * ⚠️ **计数与加权必须分离**：
 * - `nodes`（全集）→ 供 `total` / `done` / 钻取列表。用户心智 = 「看到几条就是几条」，
 *   绑定节点自身（如骨架 task）不能因为拆出子任务就凭空蒸发。
 * - `leaves`（真叶子）→ 供 `weightedProgress`。父节点 `progress` 是汇总值，
 *   参与加权即**重复计权**；骨架 task `estimateDays=0`（权重回落为 1）且 `progress`
 *   长期为 0，计入会**永久拉低**整碑完成度。这是数学正确性要求，不可妥协。
 *
 * 🚫 UI 层禁止自行推导关联任务集合（SK-M5 计数与钻取严格同源）——
 *    列表数字与钻取弹窗必须调用本函数、基于同一份 `WbsNode[]`。
 *
 * @param nodes       同项目全部 WBS 节点（扁平）
 * @param milestoneId 里程碑 **id**（身份键，不是 `code` · SK-M2）
 */
export function milestoneTaskDetail(nodes: WbsNode[], milestoneId: string): MilestoneTaskDetail {
  const childrenOf = indexChildren(nodes);
  const parents = parentIdSet(nodes);
  const anchors = nodes.filter((n) => n.milestoneId === milestoneId);
  const collected = new Map<string, WbsNode>();

  const walkLeaves = (node: WbsNode, guard: number): void => {
    if (guard > 64) return; // 防御性：脏数据成环时兜底
    const kids = childrenOf.get(node.id) ?? [];
    if (!kids.length) {
      collected.set(node.id, node);
      return;
    }
    for (const k of kids) walkLeaves(k, guard + 1);
  };

  for (const a of anchors) {
    /* ★ 口径 Y 的关键一行：绑定节点自身先入集（口径 X 缺的就是这行，导致骨架 task 拆分后蒸发） */
    collected.set(a.id, a);
    /* 再并入其子树真叶子；Map 天然按 id 去重，父子同挂一碑也不会重复计数 */
    walkLeaves(a, 0);
  }

  const list = [...collected.values()].sort((a, b) => compareWbsCode(a.wbsCode, b.wbsCode));

  return {
    nodes: list,
    rollupIds: new Set(list.filter((n) => parents.has(n.id)).map((n) => n.id)),
    leaves: list.filter((n) => !parents.has(n.id)),
  };
}

/**
 * 里程碑关联任务集合（口径 Y 全集）。
 * 供钻取弹窗罗列与计数核对；与 `milestoneTaskStats().total` **严格同源**（SK-M5），
 * 弹窗条目数恒等于列表 total，永不出现差值。
 */
export function milestoneTaskNodes(nodes: WbsNode[], milestoneId: string): WbsNode[] {
  return milestoneTaskDetail(nodes, milestoneId).nodes;
}

/**
 * 里程碑关联任务完成度（§2.5.3 · P0-M8 / P0-M10 · 口径 Y）。
 * - `total` / `done` → 口径 Y **全集**（与钻取列表条目数一致）
 * - `progress`       → **仅真叶子**加权，汇总节点权重记 0
 */
export function milestoneTaskStats(nodes: WbsNode[], milestoneId: string): MilestoneTaskStats {
  const detail = milestoneTaskDetail(nodes, milestoneId);
  return {
    total: detail.nodes.length,
    done: detail.nodes.filter((n) => n.progress >= 100).length,
    /* ★ 传 leaves 而非 nodes：父节点不参与加权，避免重复计权 + 零工时骨架稀释 */
    progress: weightedProgress(detail.leaves),
  };
}

/**
 * 节点告警（非阻塞）：
 * - 粒度超限（A/C >5 人日、B >2 人日）
 * - 叶子缺负责人 / 缺估算（SK-13：无子任务时不阻塞，只提示）
 */
export function nodeWarnings(node: WbsTreeNode, projectType: ProjectType): string[] {
  const out: string[] = [];
  const leaf = node.children.length === 0;
  const limit = GRANULARITY_LIMIT[projectType];
  if (leaf) {
    if (!node.owner) out.push('缺负责人');
    if (!node.estimateDays || node.estimateDays <= 0) out.push('缺工时估算');
    if (node.estimateDays > limit) {
      out.push(`⚠ 粒度超限，建议拆分为 ≤${limit} 人日`);
    }
  }
  return out;
}

/** 计算某父节点下的下一个 wbsCode */
export function nextChildCode(parentCode: string | null, siblingCodes: string[]): string {
  const prefix = parentCode ? `${parentCode}.` : '';
  let max = 0;
  for (const c of siblingCodes) {
    const tail = parentCode && c.startsWith(prefix) ? c.slice(prefix.length) : c;
    if (tail.includes('.')) continue;
    const n = Number(tail);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

/**
 * 全量重排编码：按树的顺序重新生成 1 / 1.1 / 1.1.1
 * 返回 id → 新编码 的映射
 */
export function reindexCodes(tree: WbsTreeNode[]): Map<string, { code: string; level: number }> {
  const out = new Map<string, { code: string; level: number }>();
  const walk = (list: WbsTreeNode[], prefix: string, level: number): void => {
    list.forEach((node, idx) => {
      const code = prefix ? `${prefix}.${idx + 1}` : String(idx + 1);
      out.set(node.id, { code, level });
      walk(node.children, code, level + 1);
    });
  };
  walk(tree, '', 1);
  return out;
}

/** 树扁平化（保持顺序） */
export function flattenTree(tree: WbsTreeNode[]): WbsTreeNode[] {
  const out: WbsTreeNode[] = [];
  const walk = (list: WbsTreeNode[]): void => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** 取全部叶子节点（看板数据源） */
export function leavesOf(tree: WbsTreeNode[]): WbsTreeNode[] {
  return flattenTree(tree).filter((n) => n.children.length === 0);
}

/** 汇总进度：叶子按估算加权，非叶子取子树加权平均 */
export function rollupProgress(node: WbsTreeNode): number {
  if (node.children.length === 0) return node.progress;
  let totalWeight = 0;
  let acc = 0;
  for (const c of node.children) {
    const w = c.estimateDays > 0 ? c.estimateDays : 1;
    totalWeight += w;
    acc += rollupProgress(c) * w;
  }
  return totalWeight === 0 ? 0 : Math.round(acc / totalWeight);
}

/** 判断 targetId 是否为 nodeId 的后代（移动防环） */
export function isDescendant(tree: WbsTreeNode[], nodeId: string, targetId: string): boolean {
  const find = (list: WbsTreeNode[]): WbsTreeNode | null => {
    for (const n of list) {
      if (n.id === nodeId) return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
    return null;
  };
  const node = find(tree);
  if (!node) return false;
  return flattenTree(node.children).some((n) => n.id === targetId);
}
