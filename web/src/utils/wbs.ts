import type { WbsNode, WbsTreeNode } from '@/types/wbs';
import type { ProjectType } from '@/types/project';
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

/** 是否叶子节点 */
export function isLeaf(node: WbsTreeNode): boolean {
  return node.children.length === 0;
}

/**
 * 节点告警（非阻塞）：
 * - 工作分区未绑定生命周期阶段（U-6，宽松期仅提示）
 * - 粒度超限（A/C >5 人日、B >2 人日）
 * - 叶子缺负责人 / 缺估算
 */
export function nodeWarnings(node: WbsTreeNode, projectType: ProjectType): string[] {
  const out: string[] = [];
  const leaf = node.children.length === 0;
  const limit = GRANULARITY_LIMIT[projectType];
  if (node.nodeType === 'stage' && !node.lifecycleStageId) {
    out.push('未绑定生命周期阶段，点击编辑补选');
  }
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
