/**
 * 管理后台 · 权限矩阵（阶段一）
 *
 * 角色 × 权限点只读矩阵：行 = 权限点（按业务域分组），列 = 9 个全局角色，
 * 单元格 = 该角色是否具备该权限（admin 恒具备）。右侧附「项目角色可授权」列。
 *
 * 数据源 = 前端权限镜像 `PERMISSIONS`（web/src/config/permissions.ts，与服务端
 * config/permissions.js 手工双写、smoke 断言一致）。矩阵为只读展示，**不是安全边界**。
 */
import { Box, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import CheckOutlinedIcon from '@mui/icons-material/CheckOutlined';

import { PageHeader, SectionCard } from '@/components/common';
import { AdminTabs } from './AdminTabs';
import { PERMISSIONS } from '@/config/permissions';
import { GLOBAL_ROLES, GLOBAL_ROLE_LABEL } from '@/config/enums';
import type { GlobalRole } from '@/types/project';

/** 权限点展示元数据：分组 + 中文标签（仅展示层，key 必须与 PERMISSIONS 一致） */
const PERM_GROUPS: Array<{ group: string; items: Array<{ action: string; label: string }> }> = [
  {
    group: '项目',
    items: [
      { action: 'project:create', label: '新建项目' },
      { action: 'project:edit', label: '编辑项目' },
      { action: 'project:delete', label: '删除项目' },
      { action: 'project:transition', label: '项目状态流转' },
      { action: 'project:close', label: '项目结项' },
      { action: 'project:member:assign', label: '项目成员分配' },
    ],
  },
  {
    group: '质量门',
    items: [
      { action: 'gate:decide', label: '质量门决议' },
      { action: 'gate:item:check', label: '检查项勾选' },
      { action: 'gate:item:add', label: '检查项维护' },
    ],
  },
  {
    group: '里程碑',
    items: [
      { action: 'milestone:create', label: '新建里程碑' },
      { action: 'milestone:edit', label: '编辑里程碑' },
      { action: 'milestone:delete', label: '删除里程碑' },
    ],
  },
  {
    group: 'WBS / 看板',
    items: [
      { action: 'wbs:edit', label: '任务编辑' },
      { action: 'wbs:delete', label: '任务删除' },
      { action: 'task:status', label: '任务状态流转' },
      { action: 'board:config', label: '看板配置' },
    ],
  },
  {
    group: '周报',
    items: [{ action: 'report:write', label: '周报填报' }],
  },
  {
    group: '评审',
    items: [
      { action: 'review:start', label: '发起评审' },
      { action: 'review:decide', label: '评审决议' },
      { action: 'review:proxy', label: '代评审' },
    ],
  },
  {
    group: '变更',
    items: [
      { action: 'change:create', label: '创建变更单' },
      { action: 'change:submit', label: '提交变更审批' },
    ],
  },
  {
    group: '全局总览',
    items: [{ action: 'dashboard:global', label: '查看公司全量范围' }],
  },
  {
    group: '管理后台',
    items: [
      { action: 'admin:user:role', label: '用户角色管理' },
      { action: 'admin:audit:view', label: '审计日志查看' },
      { action: 'admin:template', label: '内置模板管理' },
    ],
  },
  {
    group: '任务附件',
    items: [
      { action: 'document:upload', label: '上传附件' },
      { action: 'document:delete', label: '删除附件' },
    ],
  },
];

export function AdminPermissionsPage(): JSX.Element {
  const yes = (r: GlobalRole, action: string): boolean => {
    const rule = PERMISSIONS[action];
    if (!rule) return false;
    return rule.global.includes(r);
  };

  const projectRolesOf = (action: string): string => {
    const rule = PERMISSIONS[action];
    if (!rule || !rule.project.length) return '—';
    return rule.project
      .map((r) => GLOBAL_ROLE_LABEL[r] ?? r)
      .join(' / ');
  };

  return (
    <Box>
      <AdminTabs />
      <PageHeader
        title="权限矩阵"
        subtitle="角色 × 权限点（数据来自服务端权威源 permissions.js 的镜像，仅供查看）"
      />
      <SectionCard flush>
        <TableContainer sx={{ maxHeight: '72vh', overflow: 'auto' }}>
          <Table size="small" stickyHeader sx={{ minWidth: 860 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ minWidth: 150, fontWeight: 700 }}>权限点</TableCell>
                {GLOBAL_ROLES.map((r) => (
                  <TableCell key={r} align="center" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {GLOBAL_ROLE_LABEL[r]}
                  </TableCell>
                ))}
                <TableCell sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>项目角色可授权</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {PERM_GROUPS.map((g) => (
                <GroupRows key={g.group} group={g.group} items={g.items} yes={yes} projectRolesOf={projectRolesOf} />
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </SectionCard>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
        ✔ = 该全局角色具备权限；admin 恒具备全部权限。行内「项目角色可授权」指用户在项目内担任该角色时也可获得此权限（如 PM 在项目内可编辑 WBS）。
      </Typography>
    </Box>
  );
}

interface GroupRowsProps {
  group: string;
  items: Array<{ action: string; label: string }>;
  yes: (r: GlobalRole, action: string) => boolean;
  projectRolesOf: (action: string) => string;
}

function GroupRows({ group, items, yes, projectRolesOf }: GroupRowsProps): JSX.Element {
  return (
    <>
      <TableRow>
        <TableCell colSpan={1 + GLOBAL_ROLES.length + 1} sx={{ bgcolor: 'action.hover', py: 0.75 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 700, color: 'text.secondary' }}>{group}</Typography>
        </TableCell>
      </TableRow>
      {items.map((it) => (
        <TableRow key={it.action} hover>
          <TableCell sx={{ whiteSpace: 'nowrap' }}>
            <Typography sx={{ fontSize: 13 }}>{it.label}</Typography>
            <Typography variant="caption" color="text.disabled">
              {it.action}
            </Typography>
          </TableCell>
          {GLOBAL_ROLES.map((r) => (
            <TableCell key={r} align="center">
              {yes(r, it.action) ? (
                <CheckOutlinedIcon sx={{ fontSize: 15, color: 'primary.main' }} />
              ) : (
                <Typography variant="caption" color="text.disabled">
                  —
                </Typography>
              )}
            </TableCell>
          ))}
          <TableCell sx={{ whiteSpace: 'nowrap' }}>
            <Typography variant="caption" color="text.secondary">
              {projectRolesOf(it.action)}
            </Typography>
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}
