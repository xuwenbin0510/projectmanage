import type { ProjectMember } from '@/types/project';

/**
 * 责任人姓名唯一解析入口（R3-7③ / R3-8）。
 *
 * 风险责任人 = `report.risks[].owner`（用户 openId），从项目成员列表解析 `userName`
 * 只读展示；解析不到时回退 openId 原文，不阻塞。
 *
 * ⚠️ 一律走本函数，禁止在页面内散落 `members.find(...)`（SK：姓名解析唯一真源）。
 *
 * @param members 项目成员列表（projectStore.members）
 * @param openId  责任人 openId（可能为空串 / 脏数据）
 * @returns 成员姓名，解析不到返回 openId 原文
 */
export function memberNameOf(members: ProjectMember[], openId: string): string {
  const hit = members.find((m) => m.userOpenId === openId);
  return hit?.userName ?? openId;
}
