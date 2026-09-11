'use strict';

/**
 * 项目类型目录（单一来源 · 出生种子）
 *
 * ⚠ 这是「一次性引导种子」用的初始数据，对应 DB `project_types` 表的 4 个内置类型
 * （A / B / C / D）。运行时读取 / 校验一律读 `project_types` 表
 * （见 server/services/projectType.service.js），不依赖本常量。
 * 本文件仅在迁移 v29 **首次**落库时 `INSERT OR IGNORE`，绝不会覆盖后台的后续改动。
 *
 * 若你以后在管理后台新增 / 修改项目类型、例子、排序或启停，只动 `project_types` 表
 * （或后台「项目类型」页），代码零改动 —— 这是
 * 「唯一真相源(project_types 表) + 出生种子(本文件)」的分层设计（照 roles-catalog.js 先例）。
 *
 * 字段顺序与 `project_types` 表 INSERT 一致：[code, name, example, enabled, order_no]
 *   - code     标识（内置 A/B/C/D；后台新增为系统生成的 T1/T2…，创建后不变）
 *   - name     名称（业务方可改）
 *   - example  例子 / 说明（建项时辅助识别）
 *   - enabled  启用：1=启用 0=停用
 *   - order_no 排序（升序；新增默认排到末尾）
 */
const PROJECT_TYPE_CATALOG = [
  ['A', '载荷产品类', '计算 / 网络 / 存储', 1, 1],
  ['B', '软件产品类', '平台 / 应用', 1, 2],
  ['C', '基建类', '卫星 / 地面站 / 激光', 1, 3],
  ['D', '通用类', '行政 / 人力 / 其他', 1, 4],
];

module.exports = { PROJECT_TYPE_CATALOG };
