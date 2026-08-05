import type { User } from '@/types/project';
import { nowIso } from '@/utils/date';
import { DEMO_ACCOUNTS, OPEN_IDS } from '@/config/demoAccounts';

/**
 * 演示用户集（T19）—— 与登录页共用 `config/demoAccounts.ts` 单一真源
 * @prd P0-10 P0-11
 */

/** 转出 openId 常量表，供其它 fixtures 引用 */
export { OPEN_IDS };

export function createUsers(): User[] {
  const ts = nowIso();
  return DEMO_ACCOUNTS.map((a, idx) => ({
    id: idx + 1,
    openId: a.openId,
    employeeId: a.employeeId,
    name: a.name,
    email: `${a.employeeId.toLowerCase()}@astrbytes.com`,
    dept: a.dept,
    avatarUrl: '',
    globalRole: a.globalRole,
    status: 'active' as const,
    createdAt: ts,
    updatedAt: ts,
  }));
}

/** openId → 姓名 快查表 */
export function nameOf(users: User[], openId: string | null | undefined): string {
  if (!openId) return '';
  return users.find((u) => u.openId === openId)?.name ?? openId;
}
