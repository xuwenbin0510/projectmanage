/** 路由常量 + 菜单定义（T17 路由收口，防深链白屏） */

export const ROUTES = {
  login: '/login',
  changePassword: '/change-password',
  workbench: '/workbench',
  projects: '/projects',
  projectCreate: '/projects/new',
  project: (id: string) => `/projects/${id}`,
  projectOverview: (id: string) => `/projects/${id}/overview`,
  projectMilestones: (id: string) => `/projects/${id}/milestones`,
  projectWbs: (id: string) => `/projects/${id}/wbs`,
  projectBoard: (id: string) => `/projects/${id}/board`,
  projectReports: (id: string) => `/projects/${id}/reports`,
  projectEffort: (id: string) => `/projects/${id}/effort`,
  projectReviews: (id: string) => `/projects/${id}/reviews`,
  projectChanges: (id: string) => `/projects/${id}/changes`,
  projectAudit: (id: string) => `/projects/${id}/audit`,
  projectRisks: (id: string) => `/projects/${id}/risks`,
  projectDocuments: (id: string) => `/projects/${id}/documents`,
  approvals: '/approvals',
  metrics: '/metrics',
  admin: '/admin',
  adminUsers: '/admin/users',
  adminPermissions: '/admin/permissions',
  adminReviewTemplates: '/admin/review-templates',
  adminAuditLog: '/admin/audit-logs',
  adminTemplates: '/admin/templates',
  adminRoles: '/admin/roles',
} as const;

export interface MenuItem {
  key: string;
  label: string;
  path: string;
  icon: 'workbench' | 'projects' | 'approvals' | 'metrics' | 'admin';
  /** 二期占位标记 */
  phase?: 'P1' | 'P2';
  /** 仅这些全局角色可见（不填 = 全部可见） */
  roles?: string[];
  /** 任一权限动作命中即可见（与权限矩阵对齐；不填 = 不限） */
  permissions?: string[];
  /** 是否出现在移动端底部 Tab */
  mobile?: boolean;
}

export const MAIN_MENU: MenuItem[] = [
  { key: 'workbench', label: '工作台', path: ROUTES.workbench, icon: 'workbench', mobile: true },
  { key: 'projects', label: '项目管理', path: ROUTES.projects, icon: 'projects', mobile: true },
  { key: 'approvals', label: '审批中心', path: ROUTES.approvals, icon: 'approvals', mobile: true },
  {
    key: 'metrics',
    label: '全局总览',
    path: ROUTES.metrics,
    icon: 'metrics',
    // 与权限矩阵对齐：具备 dashboard:global 权限（默认 admin/cho/cpo/cto/management/pmo）即可见
    permissions: ['dashboard:global'],
  },
  {
    key: 'admin',
    label: '管理后台',
    path: ROUTES.admin,
    icon: 'admin',
    // B19：管理后台入口改为按权限矩阵判定，不再硬编码 admin/pmo。
    // HR负责人（cho）在矩阵中被授予 admin:user:role / admin:audit:view，应能看到入口。
    // 入口指向 /admin 索引，由前端按权限落地到「第一个有权限的 Tab」（如仅审计权限→审计日志）。
    permissions: ['admin:user:role', 'admin:audit:view', 'admin:template'],
    mobile: true,
  },
];

export interface ProjectTabItem {
  key: string;
  label: string;
  /** 相对项目详情的子路径 */
  segment: string;
  phase?: 'P1' | 'P2';
}

export const PROJECT_TABS: ProjectTabItem[] = [
  { key: 'overview', label: '概览', segment: 'overview' },
  { key: 'milestones', label: '里程碑', segment: 'milestones' },
  { key: 'wbs', label: 'WBS', segment: 'wbs' },
  { key: 'board', label: '看板', segment: 'board' },
  { key: 'reports', label: '工作日志', segment: 'reports' },
  { key: 'effort', label: '工时报表', segment: 'effort' },
  { key: 'reviews', label: '评审审批', segment: 'reviews' },
  { key: 'changes', label: '变更', segment: 'changes' },
  /* D08.3：原「变更历史」改名「审计日志」——它是全量操作留痕（不止变更单） */
  { key: 'audit', label: '审计日志', segment: 'audit' },
  { key: 'risks', label: '风险', segment: 'risks' },
  { key: 'documents', label: '文档', segment: 'documents' },
];
