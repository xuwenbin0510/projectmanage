/**
 * 演示账号常量。
 *
 * ⚠ 演示账号已于 2026-08 全量废弃（系统改为真实飞书免登 + devlogin），
 * 登录页不再展示任何写死账号。`DEMO_ACCOUNTS` 清空，`OPEN_IDS` 仅作为
 * mock 开发态 fixtures 的内部关联 key 保留（不含姓名，不对外展示）。
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

/** openId 常量表（仅 mock fixtures 内部引用使用，不对外展示） */
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

/** 演示账号已废弃，清空——登录页与用户列表不再渲染任何写死账号 */
export const DEMO_ACCOUNTS: DemoAccount[] = [];

/** openId → 演示账号（已无数据，保留函数签名兼容） */
export function demoAccountOf(openId: string): DemoAccount | undefined {
  return DEMO_ACCOUNTS.find((a) => a.openId === openId);
}
