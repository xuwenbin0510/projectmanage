'use strict';

/**
 * 角色目录（单一来源 · 方案 B）
 *
 * ⚠ 这是「一次性引导种子」用的初始数据，对应 DB `roles` 表当前 15 个角色。
 * 运行时权限 / scope 判定一律读 `roles` 表（见 server/services/roleCatalog.js），
 * 不依赖本常量。本文件仅在「空库首次迁移」时 INSERT OR IGNORE，不会覆盖已有数据。
 *
 * 若你以后在管理后台新增 / 修改角色或视野(scope)，只动 `roles` 表（或后台 UI），
 * 代码零改动——这是「唯一真相源(roles 表) + 出生种子(本文件)」的分层设计。
 *
 * 字段顺序与 `roles` 表 INSERT 一致：[role_key, name, scope, description, order_no]
 */
const ROLE_CATALOG = [
  ['admin', '系统管理员', 'global', '拥有全部权限，系统至少保留一名', 1],
  ['management', '公司管理层', 'global', '公司层面决策与跨项目审批', 2],
  ['pmo', 'PMO', 'global', '项目管理办公室，全局项目治理与审批', 3],
  ['pm', '项目经理', 'project', '负责具体项目的交付管理', 4],
  ['tl', '技术负责人', 'project', '负责具体项目的技术决策', 5],
  ['qa', '质量负责人', 'project', '负责具体项目的质量保障', 6],
  ['cm', '配置管理员', 'project', '负责具体项目的配置管理', 7],
  ['po', '产品经理', 'project', '负责具体项目的需求与产品', 8],
  ['member', '项目成员', 'project', '项目内普通参与者', 9],
  ['cto', '技术总监', 'global', '公司技术总负责人，跨项目', 10],
  ['cpo', '产品总监', 'global', '公司产品总负责人，跨项目', 11],
  ['dev', '研发工程师', 'project', '项目内研发实现', 12],
  ['ops', '交付工程师', 'project', '项目内交付实施', 13],
  ['ued', '视觉设计师', 'project', '项目内视觉设计', 13],
  ['sale', '销售（客户）经理', 'project', '项目内销售与客户对接', 14],
];

module.exports = { ROLE_CATALOG };
