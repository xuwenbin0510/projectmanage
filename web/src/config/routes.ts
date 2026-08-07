/** 路由常量 + 菜单定义（T17 路由收口，防深链白屏） */

export const ROUTES = {
  login: '/login',
  workbench: '/workbench',
  projects: '/projects',
  projectCreate: '/projects/new',
  project: (id: string) => `/projects/${id}`,
  projectOverview: (id: string) => `/projects/${id}/overview`,
  projectMilestones: (id: string) => `/projects/${id}/milestones`,
  projectWbs: (id: string) => `/projects/${id}/wbs`,
  projectBoard: (id: string) => `/projects/${id}/board`,
  projectReports: (id: string) => `/projects/${id}/reports`,
  projectReviews: (id: string) => `/projects/${id}/reviews`,
  projectChanges: (id: string) => `/projects/${id}/changes`,
  projectAudit: (id: string) => `/projects/${id}/audit`,
  projectRisks: (id: string) => `/projects/${id}/risks`,
  projectDocuments: (id: string) => `/projects/${id}/documents`,
  approvals: '/approvals',
  metrics: '/metrics',
  adminUsers: '/admin/users',
  adminAuditLog: '/admin/audit-logs',
  adminTemplates: '/admin/templates',
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
  /** 是否出现在移动端底部 Tab */
  mobile?: boolean;
}

export const MAIN_MENU: MenuItem[] = [
  { key: 'workbench', label: '工作台', path: ROUTES.workbench, icon: 'workbench', mobile: true },
  { key: 'projects', label: '项目', path: ROUTES.projects, icon: 'projects', mobile: true },
  { key: 'approvals', label: '审批中心', path: ROUTES.approvals, icon: 'approvals', mobile: true },
  { key: 'metrics', label: '度量看板', path: ROUTES.metrics, icon: 'metrics', phase: 'P1' },
  {
    key: 'admin',
    label: '管理后台',
    path: ROUTES.adminUsers,
    icon: 'admin',
    roles: ['admin', 'pmo'],
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
  { key: 'reviews', label: '评审审批', segment: 'reviews' },
  { key: 'changes', label: '变更', segment: 'changes' },
  { key: 'audit', label: '变更历史', segment: 'audit' },
  { key: 'risks', label: '风险', segment: 'risks', phase: 'P1' },
  { key: 'documents', label: '文档', segment: 'documents', phase: 'P1' },
];
