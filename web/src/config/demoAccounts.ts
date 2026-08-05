/**
 * 演示账号单一真源（T04 开发登录 + T19 演示数据种子共用）
 * @prd P0-11
 *
 * ⚠ 仅用于 S1 静态原型的开发登录选择器；接真实飞书免登后此文件不参与鉴权。
 */
import type { GlobalRole } from '@/types/project';

export interface DemoAccount {
  openId: string;
  employeeId: string;
  name: string;
  globalRole: GlobalRole;
  dept: string;
  /** 登录页展示的「这个账号能看到什么」提示 */
  hint: string;
}

/** openId 常量表（fixtures 之间互相引用时使用） */
export const OPEN_IDS = {
  xuwenbin: 'ou_xuwenbin01',
  wangqiang: 'ou_wangqiang02',
  liming: 'ou_liming03',
  zhangmin: 'ou_zhangmin04',
  chenjing: 'ou_chenjing05',
  zhaolei: 'ou_zhaolei06',
  sunyue: 'ou_sunyue07',
  zhoutao: 'ou_zhoutao08',
  wudi: 'ou_wudi09',
  zhengshuang: 'ou_zhengshuang10',
} as const;

export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    openId: OPEN_IDS.xuwenbin,
    employeeId: 'E1001',
    name: '徐文斌',
    globalRole: 'admin',
    dept: '项目管理部',
    hint: '全权限：管理后台、全部项目、全部审批',
  },
  {
    openId: OPEN_IDS.liming,
    employeeId: 'E1003',
    name: '李明',
    globalRole: 'pm',
    dept: '项目管理部',
    hint: 'PM 视角：建项目、报周报、提变更、推阶段',
  },
  {
    openId: OPEN_IDS.zhangmin,
    employeeId: 'E1004',
    name: '张敏',
    globalRole: 'pmo',
    dept: 'PMO',
    hint: 'PMO 视角：门控决议、立项审批、全局审计',
  },
  {
    openId: OPEN_IDS.wangqiang,
    employeeId: 'E1002',
    name: '王强',
    globalRole: 'tl',
    dept: '研发中心',
    hint: 'TL 视角：技术评审、WBS 维护、CCB 二审',
  },
  {
    openId: OPEN_IDS.chenjing,
    employeeId: 'E1005',
    name: '陈静',
    globalRole: 'qa',
    dept: '质量部',
    hint: 'QA 视角：质量门检查项勾选与结论',
  },
  {
    openId: OPEN_IDS.sunyue,
    employeeId: 'E1007',
    name: '孙悦',
    globalRole: 'po',
    dept: '产品部',
    hint: 'PO 视角：B 类产品需求基线、CCB 三审',
  },
  {
    openId: OPEN_IDS.zhoutao,
    employeeId: 'E1008',
    name: '周涛',
    globalRole: 'management',
    dept: '公司管理层',
    hint: '管理层视角：立项终审、正式评审一票否决',
  },
  {
    openId: OPEN_IDS.zhaolei,
    employeeId: 'E1006',
    name: '赵磊',
    globalRole: 'cm',
    dept: '配置管理组',
    hint: 'CM 视角：配置项与文档基线检查项',
  },
  {
    openId: OPEN_IDS.wudi,
    employeeId: 'E1009',
    name: '吴迪',
    globalRole: 'member',
    dept: '研发中心',
    hint: '普通成员：只看自己的任务与周报（含超 WIP 样本）',
  },
  {
    openId: OPEN_IDS.zhengshuang,
    employeeId: 'E1010',
    name: '郑爽',
    globalRole: 'member',
    dept: '研发中心',
    hint: '普通成员：含逾期任务样本',
  },
];

/** openId → 演示账号 */
export function demoAccountOf(openId: string): DemoAccount | undefined {
  return DEMO_ACCOUNTS.find((a) => a.openId === openId);
}
