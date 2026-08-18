/**
 * 看板视图变换 · 纯函数模块（B11 · SK-B11-5）
 *
 * ══════════════════════════════════════════════════════════════════
 * 🚫 本文件**零 React 依赖**：不 import react / MUI / store，无副作用，
 *    输入输出确定 —— 可被 `scripts/qa_b11_verify.mjs` 直接 import 断言，
 *    也便于后续 P2 把逻辑平移到服务端。
 *
 * 📐 D-B11-5：分组与筛选 100% 在前端做，`getBoard` 不加 `groupBy` 参数。
 *    看板一次性拿到项目内全部叶子卡片，分组 / 筛选是**纯视图变换**。
 *
 * ⚠️ SK-B11-3：本模块只负责「过滤后的卡片」，**不负责 WIP 计数**。
 *    WIP Chip 恒按 `col.cards.length`（全量）计数，禁止把 `filterCards`
 *    的结果长度喂给 WIP 判定。
 * ══════════════════════════════════════════════════════════════════
 *
 * @prd B11
 */

import type { BoardFilter, WbsNode } from '@/types/wbs';
import { MILESTONE_NONE, OWNER_UNASSIGNED } from '@/types/wbs';
import { diffDays, today } from '@/utils/date';

/** 下拉选项（负责人 / 里程碑通用） */
export interface BoardOption {
  /** 选项值：真实 id / openId，或哨兵值（`__unassigned__` / `__none__`） */
  value: string;
  /** 展示文案 */
  label: string;
  /** 该选项下的卡片数（供「负责人（3）」这类计数展示） */
  count: number;
}

/** 负责人泳道（`groupBy === 'owner'` 的渲染单元） */
export interface OwnerLane {
  /** 负责人 openId；未分配为 `''` */
  owner: string;
  /** 负责人姓名；未分配为 `'未分配'` */
  ownerName: string;
  /** 该负责人名下卡片（按 逾期↓ → dueDate↑ → wbsCode↑ 排序） */
  cards: WbsNode[];
  /** 其中已逾期的张数 */
  overdueCount: number;
}

/** 「未分配」泳道的固定展示名 */
export const UNASSIGNED_LABEL = '未分配';

/**
 * 逾期判定（SK-B11-4 唯一口径）：`diffDays(today(), dueDate) < 0`。
 *
 * 与后端 `server/services/workbench.service.js#countOverdue` 逐字一致，
 * 禁止改成 `new Date()` 手撸比较。
 *
 * @param dueDate 计划完成日 `YYYY-MM-DD`，空值恒为 `false`
 */
export function isCardOverdue(dueDate: string | null | undefined): boolean {
  if (!dueDate) return false;
  return diffDays(today(), dueDate) < 0;
}

/** 关键字归一化：去首尾空格 + 转小写（空串表示不过滤） */
function normalizeKeyword(keyword: string): string {
  return typeof keyword === 'string' ? keyword.trim().toLowerCase() : '';
}

/** 筛选条件是否「生效」（任一维度非空即为生效，用于列头「显示 m / 共 n」的显隐） */
export function isFilterActive(filter: BoardFilter): boolean {
  if (!filter) return false;
  return (
    normalizeKeyword(filter.keyword) !== '' ||
    filter.owner !== '' ||
    filter.milestoneId !== '' ||
    filter.overdueOnly === true
  );
}

/**
 * 按筛选条件过滤卡片（四个维度 **AND** 关系）。
 *
 * | 维度 | 规则 |
 * | --- | --- |
 * | `keyword` | 命中 `wbsCode` **或** `name`，忽略大小写、去首尾空格；`''` 不过滤 |
 * | `owner` | 精确匹配 `owner`；`__unassigned__` = 仅 `owner` 为空；`''` 不过滤 |
 * | `milestoneId` | 精确匹配 `milestoneId`；`__none__` = 仅未挂碑；`''` 不过滤 |
 * | `overdueOnly` | `true` 时仅保留 `isCardOverdue(dueDate)` |
 *
 * @param cards  原始卡片（不会被修改，返回新数组）
 * @param filter 筛选条件
 */
export function filterCards(cards: WbsNode[], filter: BoardFilter): WbsNode[] {
  const list = Array.isArray(cards) ? cards : [];
  if (!filter) return list.slice();

  const kw = normalizeKeyword(filter.keyword);
  const wantOwner = filter.owner ?? '';
  const wantMilestone = filter.milestoneId ?? '';
  const overdueOnly = filter.overdueOnly === true;

  return list.filter((c) => {
    if (kw) {
      const hay = `${c.wbsCode ?? ''} ${c.name ?? ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }

    if (wantOwner) {
      const own = c.owner ?? '';
      if (wantOwner === OWNER_UNASSIGNED) {
        if (own !== '') return false;
      } else if (own !== wantOwner) {
        return false;
      }
    }

    if (wantMilestone) {
      const ms = c.milestoneId ?? null;
      if (wantMilestone === MILESTONE_NONE) {
        if (ms) return false;
      } else if (ms !== wantMilestone) {
        return false;
      }
    }

    if (overdueOnly && !isCardOverdue(c.dueDate)) return false;

    return true;
  });
}

/**
 * 收集负责人下拉选项。
 *
 * 排序：按卡片数 ↓ → 姓名（`localeCompare('zh-CN')`）↑；
 * 「未分配」若存在则**恒排最后**，与泳道排序口径一致。
 *
 * @param cards 原始（未过滤）卡片，保证选项不随筛选而消失
 */
export function collectOwnerOptions(cards: WbsNode[]): BoardOption[] {
  const list = Array.isArray(cards) ? cards : [];
  const byOwner = new Map<string, BoardOption>();
  let unassigned = 0;

  list.forEach((c) => {
    const own = c.owner ?? '';
    if (!own) {
      unassigned += 1;
      return;
    }
    const hit = byOwner.get(own);
    if (hit) {
      hit.count += 1;
      return;
    }
    byOwner.set(own, { value: own, label: c.ownerName || own, count: 1 });
  });

  const options = Array.from(byOwner.values()).sort((a, b) =>
    a.count !== b.count ? b.count - a.count : a.label.localeCompare(b.label, 'zh-CN'),
  );

  if (unassigned > 0) {
    options.push({ value: OWNER_UNASSIGNED, label: UNASSIGNED_LABEL, count: unassigned });
  }
  return options;
}

/**
 * 泳道内卡片排序：逾期优先 → 截止日升序（空值置后） → WBS 编码升序。
 *
 * 与看板「先看要炸的」的心智一致；`wbsCode` 用 `localeCompare` 兜底，
 * 避免 `1.10` 排在 `1.2` 前的字典序问题由 `numeric: true` 处理。
 */
function sortLaneCards(a: WbsNode, b: WbsNode): number {
  const oa = isCardOverdue(a.dueDate) ? 0 : 1;
  const ob = isCardOverdue(b.dueDate) ? 0 : 1;
  if (oa !== ob) return oa - ob;

  const da = a.dueDate || '9999-12-31';
  const db = b.dueDate || '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;

  return String(a.wbsCode ?? '').localeCompare(String(b.wbsCode ?? ''), 'zh-CN', { numeric: true });
}

/**
 * 按负责人分组为泳道（D-B11-6：该视图**只读**，卡片不可拖）。
 *
 * 泳道排序：逾期数 ↓ → 任务数 ↓ → 姓名 ↑；
 * **「未分配」恒为最后一列**（无论其逾期 / 任务数多少）。
 *
 * @param cards 已过滤的卡片
 */
export function groupByOwner(cards: WbsNode[]): OwnerLane[] {
  const list = Array.isArray(cards) ? cards : [];
  const byOwner = new Map<string, OwnerLane>();

  list.forEach((c) => {
    const own = c.owner ?? '';
    let lane = byOwner.get(own);
    if (!lane) {
      lane = {
        owner: own,
        ownerName: own ? c.ownerName || own : UNASSIGNED_LABEL,
        cards: [],
        overdueCount: 0,
      };
      byOwner.set(own, lane);
    }
    lane.cards.push(c);
    if (isCardOverdue(c.dueDate)) lane.overdueCount += 1;
  });

  const lanes = Array.from(byOwner.values());
  lanes.forEach((l) => l.cards.sort(sortLaneCards));

  return lanes.sort((a, b) => {
    /* 未分配恒置末列 */
    if (a.owner === '' && b.owner !== '') return 1;
    if (b.owner === '' && a.owner !== '') return -1;

    if (a.overdueCount !== b.overdueCount) return b.overdueCount - a.overdueCount;
    if (a.cards.length !== b.cards.length) return b.cards.length - a.cards.length;
    return a.ownerName.localeCompare(b.ownerName, 'zh-CN');
  });
}
