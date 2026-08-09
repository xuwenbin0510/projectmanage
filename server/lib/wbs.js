/**
 * WBS / 看板 纯函数库（服务端为准；与前端 `web/src/utils/wbs.ts` +
 * `web/src/api/mock/rules.ts` **逐条对齐**，同名同签名同返回形态）
 *
 * 这里只放**无副作用的纯函数**：不碰 db、不抛 HTTP 错误。
 * 需要落库 / 报错的逻辑一律放 services 层（校验函数返回 `{code,message,data}` 或 `null`，
 * 由 service 转成 `AppError`）。
 *
 * ⚠ SK-4「叶子」口径唯一入口：叶子 = **无子节点**，**不是** `nodeType === 'task'`。
 *   进度汇总 / WIP / 看板卡片 / 里程碑统计一律走 `leafNodesOf` / `isLeafNode`。
 *
 * ⚠ 排序一律用 `compareWbsCode`（自然序：1.2.10 在 1.2.9 之后）。
 *   **禁止** `ORDER BY wbs_code`（字典序会把 1.10 排到 1.2 前面）。
 *
 * ⚠ `resolveWbsRules` 在 `server/lib/rules.js`，本文件不重复实现，由调用方传 `rules`。
 */
const { diffDays } = require('./dates');
const { WBS_NODE_TYPE_LABEL } = require('../config/enums');

/* ═══════════════════════════════════════════════════
 * 一、编码与排序
 * ═══════════════════════════════════════════════════ */

/**
 * wbsCode 自然序比较：`1.2.10` 排在 `1.2.9` 之后。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareWbsCode(a, b) {
  const pa = String(a === null || a === undefined ? '' : a).split('.').map(function (s) {
    return Number(s) || 0;
  });
  const pb = String(b === null || b === undefined ? '' : b).split('.').map(function (s) {
    return Number(s) || 0;
  });
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] === undefined ? 0 : pa[i]) - (pb[i] === undefined ? 0 : pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 按 wbsCode 自然序排序（返回**新数组**，不改原数组）。
 * @param {Array<{wbsCode: string}>} nodes
 * @returns {Array}
 */
function sortByWbsCode(nodes) {
  return (nodes || []).slice().sort(function (a, b) {
    return compareWbsCode(a.wbsCode, b.wbsCode);
  });
}

/**
 * 计算某父节点下的下一个 wbsCode。
 * @param {?string} parentCode 父节点编码；null / '' 表示根层
 * @param {string[]} siblingCodes 同级已有编码
 * @returns {string}
 */
function nextChildCode(parentCode, siblingCodes) {
  const prefix = parentCode ? parentCode + '.' : '';
  let max = 0;
  (siblingCodes || []).forEach(function (raw) {
    const c = String(raw === null || raw === undefined ? '' : raw);
    const tail = parentCode && c.indexOf(prefix) === 0 ? c.slice(prefix.length) : c;
    if (tail.indexOf('.') >= 0) return;
    const n = Number(tail);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return prefix + String(max + 1);
}

/**
 * 编码 → 层级：`level = code.split('.').length`（编码与层级恒同步）。
 * @param {string} code
 * @returns {number}
 */
function levelOfCode(code) {
  const s = String(code === null || code === undefined ? '' : code);
  if (!s) return 1;
  return s.split('.').length;
}

/* ═══════════════════════════════════════════════════
 * 二、叶子口径（SK-4）与结构索引
 * ═══════════════════════════════════════════════════ */

/**
 * 扁平节点集 → 「父 id → 子节点数组」索引（内部复用，O(n)）。
 * 根层节点归入 `__root__` 键。
 * @param {Array} nodes
 * @returns {Map<string, Array>}
 */
function indexChildren(nodes) {
  const map = new Map();
  (nodes || []).forEach(function (n) {
    const key = n.parentId || '__root__';
    const arr = map.get(key);
    if (arr) arr.push(n);
    else map.set(key, [n]);
  });
  return map;
}

/**
 * 工时读时汇总（B8 · R1/R5，语义重构：`effortHours` 恒指「累计实际工时（人日）」）。
 *
 * 输入 API 形态节点数组（每节点带 `effortHours` 存储值，叶子=历次已提交日志累加值/0、父=NULL→0），
 * 返回**新数组**（不改入参，幂等可重复调用），每节点补充：
 *  - `effortChildCount` = 直接子节点数（「由 N 个子任务汇总」的 N）；
 *  - `effortHours` = 叶子取存储累计值（`Number(n.effortHours) || 0`）；父 = Σ**直接子节点**
 *    `effortHours`（子为父时其值已是递归汇总，天然自底向上）。
 *
 * 后序实现：`indexChildren` 索引 + 记忆化 DFS（父节点在子节点算完后才求值），
 * 任意输入顺序均正确；脏数据成环时由 guard 兜底（防御性，不爆栈）。
 * 本期**不落缓存列**（D-B7-1），展示/统计一律走本函数装饰值。
 *
 * @param {Array} nodes 同项目全部节点（API 形态）
 * @returns {Array} 新数组，每节点带 effortHours / effortChildCount
 */
function decorateEffort(nodes) {
  const list = nodes || [];
  if (!list.length) return [];
  const childrenOf = indexChildren(list);
  const memo = new Map();

  const compute = function (node, guard) {
    if (guard > 64) {
      return { effortHours: Number(node.effortHours) || 0, effortChildCount: 0 };
    }
    if (memo.has(node.id)) return memo.get(node.id);
    const kids = childrenOf.get(node.id) || [];
    let effortHours;
    if (kids.length) {
      effortHours = kids.reduce(function (s, k) {
        return s + compute(k, guard + 1).effortHours;
      }, 0);
    } else {
      effortHours = Number(node.effortHours) || 0;
    }
    const result = { effortHours: effortHours, effortChildCount: kids.length };
    memo.set(node.id, result);
    return result;
  };

  return list.map(function (n) {
    const r = compute(n, 0);
    return Object.assign({}, n, { effortHours: r.effortHours, effortChildCount: r.effortChildCount });
  });
}

/**
 * 扁平节点集 → 「拥有子节点」的父 id 集合（O(n)，真叶子判定的统一入口）。
 * @param {Array} nodes
 * @returns {Set<string>}
 */
function parentIdSet(nodes) {
  const s = new Set();
  (nodes || []).forEach(function (n) {
    if (n.parentId) s.add(n.parentId);
  });
  return s;
}

/**
 * 取扁平节点集中的全部**真叶子**（无子节点者）。
 * @param {Array} nodes
 * @returns {Array}
 */
function leafNodesOf(nodes) {
  const hasChild = parentIdSet(nodes);
  return (nodes || []).filter(function (n) {
    return !hasChild.has(n.id);
  });
}

/**
 * 指定节点在给定节点集中是否为真叶子。
 * @param {Array} nodes
 * @param {string} nodeId
 * @returns {boolean}
 */
function isLeafNode(nodes, nodeId) {
  return !(nodes || []).some(function (n) {
    return n.parentId === nodeId;
  });
}

/**
 * 子树相对深度：节点自身记 0，其最深后代记 n。
 * 移动校验必须用它 —— 否则「把 3 层子树移到第 3 层」可绕过 maxDepth。
 * @param {Array} nodes
 * @param {string} nodeId
 * @returns {number}
 */
function subtreeRelativeDepth(nodes, nodeId) {
  const childrenOf = indexChildren(nodes);
  const walk = function (id, guard) {
    if (guard > 64) return 0; // 防御性：脏数据成环时兜底，不递归爆栈
    const kids = childrenOf.get(id) || [];
    if (!kids.length) return 0;
    let deepest = 0;
    kids.forEach(function (k) {
      const d = walk(k.id, guard + 1);
      if (d > deepest) deepest = d;
    });
    return 1 + deepest;
  };
  return walk(nodeId, 0);
}

/**
 * 取某节点的**全部后代 id**（不含自身），用于级联删除。
 * @param {Array} nodes
 * @param {string} nodeId
 * @returns {Set<string>}
 */
function descendantIdsOf(nodes, nodeId) {
  const childrenOf = indexChildren(nodes);
  const out = new Set();
  const stack = [nodeId];
  let guard = 0;
  while (stack.length && guard < 100000) {
    guard += 1;
    const cur = stack.pop();
    const kids = childrenOf.get(cur) || [];
    kids.forEach(function (k) {
      if (out.has(k.id) || k.id === nodeId) return;
      out.add(k.id);
      stack.push(k.id);
    });
  }
  return out;
}

/**
 * 判断 `targetId` 是否为 `nodeId` 的后代（移动防环 · 扁平版）。
 * @param {Array} nodes
 * @param {string} nodeId 祖先候选
 * @param {string} targetId 后代候选
 * @returns {boolean}
 */
function isDescendant(nodes, nodeId, targetId) {
  if (!targetId || nodeId === targetId) return false;
  return descendantIdsOf(nodes, nodeId).has(targetId);
}

/* ═══════════════════════════════════════════════════
 * 三、进度汇总（口径 Y · §2.5.3）
 * ═══════════════════════════════════════════════════ */

/**
 * 叶子加权完成度 0~100：`Σ(estimateDays||1 × progress) / Σ(estimateDays||1)`。
 * @param {Array} leaves 真叶子集合
 * @returns {number}
 */
function weightedProgress(leaves) {
  const list = leaves || [];
  if (!list.length) return 0;
  const totalWeight = list.reduce(function (s, n) {
    return s + (Number(n.estimateDays) || 1);
  }, 0);
  if (totalWeight === 0) return 0;
  const acc = list.reduce(function (s, n) {
    const p = Number.isFinite(Number(n.progress)) ? Number(n.progress) : 0;
    return s + (Number(n.estimateDays) || 1) * (p / 100);
  }, 0);
  return Math.round((acc / totalWeight) * 100);
}

/**
 * R4-P0-3 扁平版父节点进度：对 `nodeId` 子树的**真叶子**按 estimateDays 加权；
 * 叶子自身返回其 progress。
 * @param {Array} nodes
 * @param {string} nodeId
 * @returns {number}
 */
function rollupProgressFlat(nodes, nodeId) {
  const list = nodes || [];
  const byId = new Map(list.map(function (n) { return [n.id, n]; }));
  const childrenOf = indexChildren(list);
  const leaves = [];
  const stack = [nodeId];
  let guard = 0;
  while (stack.length && guard < 100000) {
    guard += 1;
    const id = stack.pop();
    const kids = childrenOf.get(id) || [];
    if (!kids.length) {
      const leaf = byId.get(id);
      if (leaf) leaves.push(leaf);
      continue;
    }
    kids.forEach(function (k) { stack.push(k.id); });
  }
  return weightedProgress(leaves);
}

/**
 * 项目整体进度：真叶子按估算工时加权（SK-4 口径）。
 * @param {Array} nodes 同项目全部节点
 * @returns {number}
 */
function rollupProjectProgress(nodes) {
  return weightedProgress(leafNodesOf(nodes));
}

/* ═══════════════════════════════════════════════════
 * 四、里程碑关联任务（口径 Y · SK-M4 唯一真源）
 * ═══════════════════════════════════════════════════ */

/**
 * 里程碑关联任务明细（口径 Y）。
 *
 * 集合 = `{ milestoneId === msId 的节点自身 }` ∪ `{ 这些节点子树内的真叶子 }`，按 id 去重、
 * 按 wbsCode 自然序排列。
 *
 * ⚠ **计数与加权必须分离**：
 *  - `nodes`（全集）→ `total` / `done` / 钻取列表
 *  - `leaves`（真叶子）→ `weightedProgress`（父节点参与加权 = 重复计权）
 *
 * @param {Array} nodes 同项目全部 WBS 节点（扁平，API 形态）
 * @param {string} milestoneId 里程碑 **id**（身份键，不是 code · SK-M2）
 * @returns {{nodes: Array, rollupIds: Set<string>, leaves: Array}}
 */
function milestoneTaskDetail(nodes, milestoneId) {
  const list = nodes || [];
  const childrenOf = indexChildren(list);
  const parents = parentIdSet(list);
  const anchors = list.filter(function (n) { return n.milestoneId === milestoneId; });
  const collected = new Map();

  const walkLeaves = function (node, guard) {
    if (guard > 64) return; // 防御性：脏数据成环时兜底
    const kids = childrenOf.get(node.id) || [];
    if (!kids.length) {
      collected.set(node.id, node);
      return;
    }
    kids.forEach(function (k) { walkLeaves(k, guard + 1); });
  };

  anchors.forEach(function (a) {
    /* ★ 口径 Y 的关键一行：绑定节点自身先入集（否则骨架 task 拆分后计数蒸发） */
    collected.set(a.id, a);
    walkLeaves(a, 0);
  });

  const out = sortByWbsCode(Array.from(collected.values()));

  return {
    nodes: out,
    rollupIds: new Set(out.filter(function (n) { return parents.has(n.id); }).map(function (n) { return n.id; })),
    leaves: out.filter(function (n) { return !parents.has(n.id); }),
  };
}

/**
 * 里程碑关联任务集合（口径 Y 全集）。与 `milestoneTaskStats().total` 严格同源。
 * @param {Array} nodes
 * @param {string} milestoneId
 * @returns {Array}
 */
function milestoneTaskNodes(nodes, milestoneId) {
  return milestoneTaskDetail(nodes, milestoneId).nodes;
}

/**
 * 里程碑关联任务完成度（口径 Y）。
 * - `total` / `done` → 全集（与钻取列表条目数一致）
 * - `progress`       → **仅真叶子**加权
 * @param {Array} nodes
 * @param {string} milestoneId
 * @returns {{total: number, done: number, progress: number}}
 */
function milestoneTaskStats(nodes, milestoneId) {
  const detail = milestoneTaskDetail(nodes, milestoneId);
  return {
    total: detail.nodes.length,
    done: detail.nodes.filter(function (n) {
      return (Number(n.progress) || 0) >= 100;
    }).length,
    progress: weightedProgress(detail.leaves),
  };
}

/* ═══════════════════════════════════════════════════
 * 五、落位 / 日期 / 估算 校验（返回 {code,message,data} 或 null）
 * ═══════════════════════════════════════════════════ */

/**
 * 节点类型中文文案。
 * @param {string} t
 * @returns {string}
 */
function typeLabel(t) {
  return WBS_NODE_TYPE_LABEL[t] || String(t || '');
}

/**
 * 某父节点下允许挂哪些子节点类型（类型下拉的唯一数据源）。
 * - `parent === null` 视为根层
 * - 已达 `maxDepth` 时返回空数组
 * @param {?Object} parent 父节点（API 形态）；null = 根层
 * @param {{maxDepth: number, childTypes: Object}} rules
 * @returns {string[]}
 */
function allowedChildTypes(parent, rules) {
  const targetLevel = parent ? Number(parent.level) + 1 : 1;
  if (targetLevel > rules.maxDepth) return [];
  const key = parent ? parent.nodeType : 'root';
  return (rules.childTypes[key] || []).slice();
}

/**
 * WBS 落位校验（§2.4.2 · 仅 2 条）：
 *  - **W-1 深度上限**：`目标层级 + 被移动子树高度 ≤ maxDepth` → `E_WBS_DEPTH`
 *  - **W-2 父子类型**：根层只能是任务；任务下可挂任务/子任务；子任务下不可挂 → `E_WBS_PARENT_TYPE`
 *
 * ⚠ W-1 **先于** W-2：`allowedChildTypes` 在达 maxDepth 时返回空数组，
 *   若 W-2 先判会把「层级超限」误报为「父类型非法」。
 *
 * @param {{nodeType: string, parent: ?Object, subtreeDepth?: number}} input
 * @param {{maxDepth: number, childTypes: Object}} rules
 * @returns {?{code: string, message: string, data: Object}} null = 放行
 */
function validateWbsPlacement(input, rules) {
  const nodeType = input.nodeType;
  const parent = input.parent || null;
  const subtreeDepth = Number.isFinite(Number(input.subtreeDepth)) ? Number(input.subtreeDepth) : 0;
  const targetLevel = parent ? Number(parent.level) + 1 : 1;

  /* ── W-1 最大深度（含被移动子树的整体高度） ─────── */
  const resultDepth = targetLevel + subtreeDepth;
  if (resultDepth > rules.maxDepth) {
    return {
      code: 'E_WBS_DEPTH',
      message: '层级将达到第 ' + resultDepth + ' 层，超过上限 ' + rules.maxDepth + ' 层',
      data: {
        targetLevel: targetLevel,
        subtreeDepth: subtreeDepth,
        resultDepth: resultDepth,
        maxDepth: rules.maxDepth,
      },
    };
  }

  /* ── W-2 父子类型（含「子任务必为叶」） ─────────── */
  const allowed = allowedChildTypes(parent, rules);
  if (allowed.indexOf(nodeType) < 0) {
    const parentDesc = parent
      ? '「' + parent.wbsCode + ' ' + parent.name + '」(' + typeLabel(parent.nodeType) + ')'
      : '根层';
    const allowDesc = allowed.length
      ? allowed.map(typeLabel).join(' / ')
      : '（无，子任务下不能再挂节点）';
    return {
      code: 'E_WBS_PARENT_TYPE',
      message: parentDesc + '下不允许创建「' + typeLabel(nodeType) + '」，允许的类型：' + allowDesc,
      data: {
        parentId: parent ? parent.id : null,
        parentType: parent ? parent.nodeType : 'root',
        nodeType: nodeType,
        allowed: allowed,
      },
    };
  }

  return null;
}

/**
 * 截止日期硬拦截：
 *  - 有上级任务且上级有 dueDate：子节点 dueDate 不得晚于上级 dueDate
 *  - 有关联里程碑：子节点 dueDate 不得晚于里程碑 currentDate
 *
 * ⚠ `diffDays(a, b) = b - a`，故「晚于上限」等价于 `diffDays(上限, dueDate) > 0`。
 *
 * @param {{dueDate: string, parent?: ?Object, milestone?: ?Object}} input
 * @returns {?{code: string, message: string, data: Object}} null = 放行
 */
function validateWbsDeadline(input) {
  const dueDate = input.dueDate;
  const parent = input.parent || null;
  const milestone = input.milestone || null;
  if (!dueDate) return null;

  if (parent && parent.dueDate && diffDays(parent.dueDate, dueDate) > 0) {
    return {
      code: 'E_WBS_DEADLINE_OVERFLOW',
      message:
        '截止日期 ' + dueDate + ' 不能超过上级任务「' + parent.wbsCode + ' ' + parent.name +
        '」的计划日期 ' + parent.dueDate,
      data: {
        dueDate: dueDate,
        parentDue: parent.dueDate,
        milestoneDue: milestone && milestone.currentDate ? milestone.currentDate : null,
      },
    };
  }
  if (milestone && milestone.currentDate && diffDays(milestone.currentDate, dueDate) > 0) {
    return {
      code: 'E_WBS_DEADLINE_OVERFLOW',
      message:
        '截止日期 ' + dueDate + ' 不能超过关联里程碑「' + milestone.code + ' ' + milestone.name +
        '」的计划日期 ' + milestone.currentDate,
      data: {
        dueDate: dueDate,
        parentDue: parent && parent.dueDate ? parent.dueDate : null,
        milestoneDue: milestone.currentDate,
      },
    };
  }
  return null;
}

/**
 * 工时估算硬拦截：估算人日不得超过起止区间可用天数（`dueDate - startDate`）。
 * 无日期或可用天数非正时放行。
 * @param {{estimateDays: number, startDate: string, dueDate: string}} input
 * @returns {?{code: string, message: string, data: Object}} null = 放行
 */
function validateWbsEstimate(input) {
  const estimateDays = Number(input.estimateDays) || 0;
  const startDate = input.startDate;
  const dueDate = input.dueDate;
  if (!startDate || !dueDate) return null;
  const available = diffDays(startDate, dueDate);
  if (available <= 0) return null;
  if (estimateDays > available) {
    return {
      code: 'E_WBS_ESTIMATE_OVERFLOW',
      message:
        '工时估算 ' + estimateDays + ' 人日，超过起止区间可用天数 ' + available +
        ' 天（' + startDate + ' → ' + dueDate + '）',
      data: {
        estimateDays: estimateDays,
        startDate: startDate,
        dueDate: dueDate,
        available: available,
      },
    };
  }
  return null;
}

/* ═══════════════════════════════════════════════════
 * 六、状态流转 / WIP / 门 / 里程碑改期
 * ═══════════════════════════════════════════════════ */

/**
 * R4-P0-3 任务状态自动流转（D2 规则**唯一实现**）：
 *  1. 强规则：`progress >= 100` → 完成（无条件，含 阻塞/待评审）
 *  2. 弱规则：`progress === 0` 且当前 ∈ {进行中, 完成} → 待办
 *  3. 弱规则：`0 < progress < 100` 且当前 ∈ {待办, 完成} → 进行中
 *  4. 人工态边界：当前为 待评审/阻塞 时，除规则 1 外不被覆盖
 *
 * @param {string} status 当前状态
 * @param {number} progress 0~100
 * @returns {string} 收敛后的状态
 */
function syncNodeStatusFromProgress(status, progress) {
  const p = Number.isFinite(Number(progress)) ? Number(progress) : 0;
  if (p >= 100) return '完成';
  if (p === 0) return status === '进行中' || status === '完成' ? '待办' : status;
  return status === '待办' || status === '完成' ? '进行中' : status;
}

/**
 * WIP 限制检查。
 * - `limit <= 0` → 不限，放行
 * - SK-4：统计口径是**真叶子**，不是 `nodeType === 'task'`
 *
 * @param {Array} nodes 同项目全部节点
 * @param {{wipLimits: Object}} config 看板配置（API 形态）
 * @param {string} targetStatus 目标列
 * @param {string} movingNodeId 被拖动节点 id（不计入现有数量）
 * @returns {?{limit: number, current: number}} null = 放行
 */
function checkWip(nodes, config, targetStatus, movingNodeId) {
  const limits = (config && config.wipLimits) || {};
  const limit = Number(limits[targetStatus]) || 0;
  if (!limit || limit <= 0) return null;
  const list = nodes || [];
  const hasChild = parentIdSet(list);
  const current = list.filter(function (n) {
    return !hasChild.has(n.id) && n.status === targetStatus && n.id !== movingNodeId;
  }).length;
  if (current + 1 > limit) return { limit: limit, current: current };
  return null;
}

/**
 * 质量门是否满足决议条件：全部检查项已勾选。
 * @param {Array} items 检查项（API 形态，含 checked）
 * @returns {{ready: boolean, unchecked: Array}}
 */
function gateReady(items) {
  const unchecked = (items || []).filter(function (i) { return !i.checked; });
  return { ready: unchecked.length === 0, unchecked: unchecked };
}

/**
 * 里程碑单向规则：提前 / 保持允许直接改；**延后必须走变更单**。
 * @param {{currentDate: string}} current 当前里程碑（API 形态）
 * @param {string} toDate 目标日期
 * @returns {boolean} true = 需要走变更单
 */
function milestoneDelayNeedsChange(current, toDate) {
  return diffDays(current.currentDate, toDate) > 0;
}

module.exports = {
  // 编码与排序
  compareWbsCode,
  sortByWbsCode,
  nextChildCode,
  levelOfCode,
  // 结构索引与叶子口径
  indexChildren,
  parentIdSet,
  leafNodesOf,
  isLeafNode,
  subtreeRelativeDepth,
  descendantIdsOf,
  isDescendant,
  // 工时读时汇总（B8：effortHours=累计实际工时·人日）
  decorateEffort,
  // 进度汇总
  weightedProgress,
  rollupProgressFlat,
  rollupProjectProgress,
  // 里程碑关联任务
  milestoneTaskDetail,
  milestoneTaskNodes,
  milestoneTaskStats,
  // 校验
  allowedChildTypes,
  validateWbsPlacement,
  validateWbsDeadline,
  validateWbsEstimate,
  // 状态 / WIP / 门 / 改期
  syncNodeStatusFromProgress,
  checkWip,
  gateReady,
  milestoneDelayNeedsChange,
};
