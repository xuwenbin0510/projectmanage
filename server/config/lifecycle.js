/**
 * A / B / C 三套生命周期模板（里程碑 + 质量门 + 检查项 + WBS 规则 + 文档清单）
 *
 * ⚠ 与前端 `web/src/api/mock/fixtures/templates.ts` **逐字对齐**。
 *   前端那份是 Mock 的种子数据；接真实后端后，模板的唯一真源是本文件
 *   → seed 写入 `lifecycle_templates` 表 → `GET /api/meta` 下发。
 *
 * 方案一（极简）：阶段实体已删除，质量门**内联**在里程碑上（一碑最多一门 · C-G1）。
 * `version` 随结构性变更 bump；制度引用格式为 `TPL-x v2`。
 *
 * 【WBS 规则 · 决策 D-2 / SK-5】三类项目层级规则一致，模板只写差异项
 *   （此处仅 maxDepth / skeleton），其余由 DEFAULT_WBS_RULES 兜底。
 *
 * ⚠ K-1：`createProject` **不会**按 gate 定义生成质量门（B3 才实现）。
 *   这里的 gate 定义是模板的完整描述，供前端预览与 B3 实例化使用。
 */

/** 当前模板版本（D04 起 docs 结构化为 {name, milestoneCode}，2→3） */
const TEMPLATE_VERSION = 3;

/**
 * A 类（交付型）：7 碑 7 门 19 检查项
 * @returns {Object}
 */
function templateA() {
  return {
    id: 'TPL-A',
    projectType: 'A',
    version: TEMPLATE_VERSION,
    name: 'A 类（交付型）标准生命周期',
    isActive: true,
    definition: {
      milestones: [
        {
          code: 'M1',
          name: '项目启动',
          offsetDays: 0,
          required: true,
          gate: {
            code: 'QG1',
            name: '立项质量门',
            ownerRole: 'pmo',
            items: [
              { content: '立项申请表已批准', ownerRole: 'pmo' },
              { content: '项目章程已签发', ownerRole: 'pm' },
              { content: '项目角色任命齐备（PM/TL/QA/CM）', ownerRole: 'pmo' },
            ],
          },
        },
        {
          code: 'M2',
          name: '需求基线冻结',
          offsetDays: 30,
          required: true,
          gate: {
            code: 'QG2',
            name: '需求质量门',
            ownerRole: 'pmo',
            items: [
              { content: '需求规格说明书已评审通过', ownerRole: 'pmo' },
              { content: '需求基线已冻结', ownerRole: 'cm' },
              { content: '客户需求确认单已签署', ownerRole: 'pm' },
            ],
          },
        },
        {
          code: 'M3',
          name: '设计评审通过',
          offsetDays: 70,
          required: true,
          gate: {
            code: 'QG3',
            name: '设计质量门',
            ownerRole: 'tl',
            items: [
              { content: '系统架构设计说明书已评审', ownerRole: 'tl' },
              { content: '详细设计文档齐套', ownerRole: 'cm' },
              { content: '设计基线已冻结', ownerRole: 'cm' },
            ],
          },
        },
        {
          code: 'M4',
          name: '首件调试完成',
          offsetDays: 125,
          required: true,
          gate: {
            code: 'QG4',
            name: '开发实施质量门',
            ownerRole: 'qa',
            items: [
              { content: '代码评审覆盖率 100%', ownerRole: 'tl' },
              { content: '单元测试通过率 ≥90%', ownerRole: 'qa' },
              { content: '接口文档(ICD)已冻结', ownerRole: 'tl' },
              { content: '开发阶段文档齐套', ownerRole: 'cm' },
            ],
          },
        },
        {
          code: 'M5',
          name: '集成测试通过',
          offsetDays: 170,
          required: true,
          gate: {
            code: 'QG5',
            name: '集成测试质量门',
            ownerRole: 'qa',
            items: [
              { content: '集成测试用例执行完毕', ownerRole: 'qa' },
              { content: '严重级别缺陷已全部关闭', ownerRole: 'qa' },
              { content: '性能指标满足合同要求', ownerRole: 'tl' },
            ],
          },
        },
        {
          code: 'M6',
          name: '客户验收通过',
          offsetDays: 210,
          required: true,
          gate: {
            code: 'QG6',
            name: '验收质量门',
            ownerRole: 'pmo',
            items: [
              { content: '客户验收报告已签署', ownerRole: 'pm' },
              { content: '交付物清单齐套并归档', ownerRole: 'cm' },
            ],
          },
        },
        {
          code: 'M7',
          name: '项目结项',
          offsetDays: 232,
          required: true,
          gate: {
            code: 'QG7',
            name: '结项质量门',
            ownerRole: 'pmo',
            items: [{ content: '结项复盘已完成', ownerRole: 'pmo' }],
          },
        },
      ],
      docs: [
        { name: '立项申请表', milestoneCode: 'M1' },
        { name: '项目章程', milestoneCode: 'M1' },
        { name: '需求规格说明书', milestoneCode: 'M2' },
        { name: '系统架构设计说明书', milestoneCode: 'M3' },
        { name: '接口控制文档 ICD', milestoneCode: 'M4' },
        { name: '集成测试报告', milestoneCode: 'M5' },
        { name: '客户验收报告', milestoneCode: 'M6' },
        { name: '结项报告', milestoneCode: 'M7' },
      ],
      wbsRules: { maxDepth: 4, skeleton: 'per-milestone' },
    },
  };
}

/**
 * B 类（产品型）：4 碑 4 门 10 检查项
 * @returns {Object}
 */
function templateB() {
  return {
    id: 'TPL-B',
    projectType: 'B',
    version: TEMPLATE_VERSION,
    name: 'B 类（产品型）Sprint 生命周期',
    isActive: true,
    definition: {
      milestones: [
        {
          code: 'M1',
          name: 'Sprint 启动',
          offsetDays: 0,
          required: true,
          gate: {
            code: 'QB1',
            name: '计划就绪门',
            ownerRole: 'po',
            items: [
              { content: 'Sprint Backlog 已确认', ownerRole: 'po' },
              { content: 'Story 已估点且负责人明确', ownerRole: 'tl' },
            ],
          },
        },
        {
          code: 'M2',
          name: '特性冻结',
          offsetDays: 8,
          required: true,
          gate: {
            code: 'QB2',
            name: '开发完成门',
            ownerRole: 'tl',
            items: [
              { content: '所有 Story 代码已合入 develop', ownerRole: 'tl' },
              { content: '代码评审全部 Approve', ownerRole: 'tl' },
            ],
          },
        },
        {
          code: 'M3',
          name: '版本发布',
          offsetDays: 14,
          required: true,
          gate: {
            code: 'QB3',
            name: '发布门',
            ownerRole: 'qa',
            items: [
              { content: '回归测试通过率 ≥95%', ownerRole: 'qa' },
              { content: '无 P0/P1 未关闭缺陷', ownerRole: 'qa' },
              { content: 'Demo 已向 PO 演示并验收', ownerRole: 'po' },
              { content: '发布说明与回滚方案齐备', ownerRole: 'cm' },
            ],
          },
        },
        {
          code: 'M4',
          name: 'Sprint 回顾完成',
          offsetDays: 16,
          required: true,
          gate: {
            code: 'QB4',
            name: '回顾闭环门',
            ownerRole: 'pmo',
            items: [
              { content: 'Sprint 回顾结论已记录', ownerRole: 'pm' },
              { content: '改进项已转为下个 Sprint 待办', ownerRole: 'po' },
            ],
          },
        },
      ],
      docs: [
        { name: '产品需求文档 PRD', milestoneCode: 'M1' },
        { name: 'Sprint 计划', milestoneCode: 'M1' },
        { name: '发布说明', milestoneCode: 'M3' },
        { name: 'Sprint 回顾纪要', milestoneCode: 'M4' },
      ],
      wbsRules: { maxDepth: 4, skeleton: 'per-milestone' },
    },
  };
}

/**
 * C 类（基建型）：5 碑 5 门 10 检查项
 * @returns {Object}
 */
function templateC() {
  return {
    id: 'TPL-C',
    projectType: 'C',
    version: TEMPLATE_VERSION,
    name: 'C 类（基建型）标准生命周期',
    isActive: true,
    definition: {
      milestones: [
        {
          code: 'M1',
          name: '项目启动',
          offsetDays: 0,
          required: true,
          gate: {
            code: 'QC1',
            name: '立项质量门',
            ownerRole: 'pmo',
            items: [
              { content: '预算已批准', ownerRole: 'pmo' },
              { content: '实施范围与边界已确认', ownerRole: 'pm' },
            ],
          },
        },
        {
          code: 'M2',
          name: '方案定稿',
          offsetDays: 25,
          required: true,
          gate: {
            code: 'QC2',
            name: '方案评审门',
            ownerRole: 'tl',
            items: [
              { content: '施工方案已评审通过', ownerRole: 'tl' },
              { content: '安全与合规评估已完成', ownerRole: 'qa' },
            ],
          },
        },
        {
          code: 'M3',
          name: '设备到货',
          offsetDays: 60,
          required: true,
          gate: {
            code: 'QC3',
            name: '到货验收门',
            ownerRole: 'cm',
            items: [{ content: '设备到货验收单齐备', ownerRole: 'cm' }],
          },
        },
        {
          code: 'M4',
          name: '施工完成',
          offsetDays: 100,
          required: true,
          gate: {
            code: 'QC4',
            name: '施工完成门',
            ownerRole: 'pm',
            items: [
              { content: '施工进度与安全记录齐全', ownerRole: 'pm' },
              { content: '系统联调测试通过', ownerRole: 'qa' },
            ],
          },
        },
        {
          code: 'M5',
          name: '验收移交',
          offsetDays: 130,
          required: true,
          gate: {
            code: 'QC5',
            name: '验收移交门',
            ownerRole: 'pmo',
            items: [
              { content: '验收报告已签署', ownerRole: 'pm' },
              { content: '运维手册与图纸已移交', ownerRole: 'cm' },
              { content: '运维团队培训已完成', ownerRole: 'pm' },
            ],
          },
        },
      ],
      docs: [
        { name: '立项申请表', milestoneCode: 'M1' },
        { name: '施工方案', milestoneCode: 'M2' },
        { name: '设备清单', milestoneCode: 'M3' },
        { name: '验收报告', milestoneCode: 'M5' },
        { name: '运维手册', milestoneCode: 'M5' },
      ],
      wbsRules: { maxDepth: 4, skeleton: 'per-milestone' },
    },
  };
}

/**
 * D 类（通用轻量型）：3 碑 0 门 0 文档
 * 用于专利 / 软著 / 资质 / 投标 / 培训等不归属 A/B/C 的「公司运营 / 职能」类项目。
 * 不强约束：无强制质量门、不自动派生文档，WBS 完全由用户自建。
 * @returns {Object}
 */
function templateD() {
  return {
    id: 'TPL-D',
    projectType: 'D',
    version: TEMPLATE_VERSION,
    name: 'D 类（通用轻量型）生命周期',
    isActive: true,
    definition: {
      milestones: [
        { code: 'M1', name: '启动与规划', offsetDays: 0, required: true },
        { code: 'M2', name: '执行与跟进', offsetDays: 15, required: false },
        { code: 'M3', name: '结项与归档', offsetDays: 30, required: false },
      ],
      docs: [],
      wbsRules: { maxDepth: 4, skeleton: 'per-milestone' },
    },
  };
}

/**
 * 生成四套模板的全新副本（调用方可安全改写，不会污染模块常量）。
 * @returns {Object[]}
 */
function createTemplates() {
  return [templateA(), templateB(), templateC(), templateD()];
}

module.exports = { TEMPLATE_VERSION, createTemplates };
