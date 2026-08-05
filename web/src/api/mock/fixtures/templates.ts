import type { LifecycleTemplate } from '@/types/project';
import { nowIso } from '@/utils/date';

/**
 * A / B / C 三套生命周期模板（阶段 + 质量门 + 检查项 + 里程碑骨架 + 文档清单）
 * @prd P0-02 P0-03
 */
export function createTemplates(): LifecycleTemplate[] {
  const ts = nowIso();

  const typeA: LifecycleTemplate = {
    id: 'TPL-A',
    projectType: 'A',
    version: 1,
    name: 'A 类（交付型）标准生命周期',
    isActive: true,
    createdAt: ts,
    definition: {
      stages: [
        {
          code: 'S1',
          name: '立项',
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
          code: 'S2',
          name: '需求',
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
          code: 'S3',
          name: '设计',
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
          code: 'S4',
          name: '开发实施',
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
          code: 'S5',
          name: '集成测试',
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
          code: 'S6',
          name: '验收交付',
          gate: {
            code: 'QG6',
            name: '验收交付质量门',
            ownerRole: 'pmo',
            items: [
              { content: '客户验收报告已签署', ownerRole: 'pm' },
              { content: '交付物清单齐套并归档', ownerRole: 'cm' },
              { content: '结项复盘已完成', ownerRole: 'pmo' },
            ],
          },
        },
      ],
      milestones: [
        { code: 'M1', name: '项目启动', offsetDays: 0 },
        { code: 'M2', name: '需求基线冻结', offsetDays: 30 },
        { code: 'M3', name: '设计评审通过', offsetDays: 70 },
        { code: 'M4', name: '首件调试完成', offsetDays: 125 },
        { code: 'M5', name: '集成测试通过', offsetDays: 170 },
        { code: 'M6', name: '客户验收通过', offsetDays: 210 },
        { code: 'M7', name: '项目结项', offsetDays: 232 },
      ],
      docs: [
        '立项申请表',
        '项目章程',
        '需求规格说明书',
        '系统架构设计说明书',
        '接口控制文档 ICD',
        '集成测试报告',
        '客户验收报告',
        '结项报告',
      ],
    },
  };

  const typeB: LifecycleTemplate = {
    id: 'TPL-B',
    projectType: 'B',
    version: 1,
    name: 'B 类（产品型）Sprint 生命周期',
    isActive: true,
    createdAt: ts,
    definition: {
      stages: [
        {
          code: 'S1',
          name: 'Sprint 计划',
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
          code: 'S2',
          name: '开发',
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
          code: 'S3',
          name: '评审',
          gate: {
            code: 'QB3',
            name: '质量评审门',
            ownerRole: 'qa',
            items: [
              { content: '回归测试通过率 ≥95%', ownerRole: 'qa' },
              { content: '无 P0/P1 未关闭缺陷', ownerRole: 'qa' },
            ],
          },
        },
        {
          code: 'S4',
          name: '演示',
          gate: {
            code: 'QB4',
            name: '发布门',
            ownerRole: 'po',
            items: [
              { content: 'Demo 已向 PO 演示并验收', ownerRole: 'po' },
              { content: '发布说明与回滚方案齐备', ownerRole: 'cm' },
            ],
          },
        },
        {
          code: 'S5',
          name: '回顾',
          gate: {
            code: 'QB5',
            name: '回顾闭环门',
            ownerRole: 'pmo',
            items: [
              { content: 'Sprint 回顾结论已记录', ownerRole: 'pm' },
              { content: '改进项已转为下个 Sprint 待办', ownerRole: 'po' },
            ],
          },
        },
      ],
      milestones: [
        { code: 'M1', name: 'Sprint 启动', offsetDays: 0 },
        { code: 'M2', name: '特性冻结', offsetDays: 8 },
        { code: 'M3', name: '版本发布', offsetDays: 14 },
      ],
      docs: ['产品需求文档 PRD', 'Sprint 计划', '发布说明', 'Sprint 回顾纪要'],
    },
  };

  const typeC: LifecycleTemplate = {
    id: 'TPL-C',
    projectType: 'C',
    version: 1,
    name: 'C 类（基建型）标准生命周期',
    isActive: true,
    createdAt: ts,
    definition: {
      stages: [
        {
          code: 'S1',
          name: '立项',
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
          code: 'S2',
          name: '方案设计',
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
          code: 'S3',
          name: '采购施工',
          gate: {
            code: 'QC3',
            name: '到货与施工门',
            ownerRole: 'cm',
            items: [
              { content: '设备到货验收单齐备', ownerRole: 'cm' },
              { content: '施工进度与安全记录齐全', ownerRole: 'pm' },
            ],
          },
        },
        {
          code: 'S4',
          name: '调试验收',
          gate: {
            code: 'QC4',
            name: '调试验收门',
            ownerRole: 'qa',
            items: [
              { content: '系统联调测试通过', ownerRole: 'qa' },
              { content: '验收报告已签署', ownerRole: 'pm' },
            ],
          },
        },
        {
          code: 'S5',
          name: '运维移交',
          gate: {
            code: 'QC5',
            name: '移交门',
            ownerRole: 'pmo',
            items: [
              { content: '运维手册与图纸已移交', ownerRole: 'cm' },
              { content: '运维团队培训已完成', ownerRole: 'pm' },
            ],
          },
        },
      ],
      milestones: [
        { code: 'M1', name: '项目启动', offsetDays: 0 },
        { code: 'M2', name: '方案定稿', offsetDays: 25 },
        { code: 'M3', name: '设备到货', offsetDays: 60 },
        { code: 'M4', name: '施工完成', offsetDays: 100 },
        { code: 'M5', name: '验收移交', offsetDays: 130 },
      ],
      docs: ['立项申请表', '施工方案', '设备清单', '验收报告', '运维手册'],
    },
  };

  return [typeA, typeB, typeC];
}
