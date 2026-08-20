import type { ReactNode } from 'react';
import { Box, CircularProgress } from '@mui/material';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { AppLayout } from '@/components/layout/AppLayout';
import { ProjectLayout } from '@/components/layout/ProjectLayout';
import { useAuthStore } from '@/stores/authStore';
import { ROUTES } from '@/config/routes';

import { LoginPage } from '@/pages/LoginPage';
import { WorkbenchPage } from '@/pages/WorkbenchPage';
import { ApprovalsPage } from '@/pages/ApprovalsPage';
import { MetricsPage } from '@/pages/MetricsPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ProjectListPage } from '@/pages/projects/ProjectListPage';
import { ProjectCreatePage } from '@/pages/projects/ProjectCreatePage';
import { ProjectOverviewPage } from '@/pages/projects/ProjectOverviewPage';
import { MilestonesPage } from '@/pages/projects/MilestonesPage';
import { WbsPage } from '@/pages/projects/WbsPage';
import { BoardPage } from '@/pages/projects/BoardPage';
import { ReportsPage } from '@/pages/projects/ReportsPage';
import { EffortReportPage } from '@/pages/projects/EffortReportPage';
import { ReviewsPage } from '@/pages/projects/ReviewsPage';
import { ChangesPage } from '@/pages/projects/ChangesPage';
import { ProjectAuditPage } from '@/pages/projects/ProjectAuditPage';
import { RisksPage } from '@/pages/projects/RisksPage';
import { DocumentsPage } from '@/pages/projects/DocumentsPage';
import { AdminUsersPage } from '@/pages/admin/AdminUsersPage';
import { AdminPermissionsPage } from '@/pages/admin/AdminPermissionsPage';
import { AdminTemplatesPage } from '@/pages/admin/AdminTemplatesPage';
import { AdminAuditPage } from '@/pages/admin/AdminAuditPage';

/**
 * 登录守卫：未登录一律回登录页，并把原始深链记在 state 里
 * @prd P0-11
 */
function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const user = useAuthStore((s) => s.user);
  const ready = useAuthStore((s) => s.ready);
  const location = useLocation();

  if (!ready) {
    return (
      <Box sx={{ height: '100vh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }
  if (!user) {
    return <Navigate to={ROUTES.login} replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

/** 已登录访问 /login 时直接进工作台 */
function RedirectIfAuthed({ children }: { children: ReactNode }): JSX.Element {
  const user = useAuthStore((s) => s.user);
  if (user) return <Navigate to={ROUTES.workbench} replace />;
  return <>{children}</>;
}

/**
 * 全局路由表（T17 路由收口）
 * - 所有 PROJECT_TABS 的 segment 都在此注册，避免深链白屏
 * - 未匹配统一走 404 页而不是空白
 */
export function AppRouter(): JSX.Element {
  return (
    <Routes>
      <Route
        path={ROUTES.login}
        element={
          <RedirectIfAuthed>
            <LoginPage />
          </RedirectIfAuthed>
        }
      />

      <Route
        path="/"
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to={ROUTES.workbench} replace />} />
        <Route path="workbench" element={<WorkbenchPage />} />

        <Route path="projects" element={<ProjectListPage />} />
        <Route path="projects/new" element={<ProjectCreatePage />} />
        <Route path="projects/:id" element={<ProjectLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<ProjectOverviewPage />} />
          <Route path="milestones" element={<MilestonesPage />} />
          <Route path="wbs" element={<WbsPage />} />
          <Route path="board" element={<BoardPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="effort" element={<EffortReportPage />} />
          <Route path="reviews" element={<ReviewsPage />} />
          <Route path="changes" element={<ChangesPage />} />
          <Route path="audit" element={<ProjectAuditPage />} />
          <Route path="risks" element={<RisksPage />} />
          <Route path="documents" element={<DocumentsPage />} />
          <Route path="*" element={<Navigate to="overview" replace />} />
        </Route>

        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="metrics" element={<MetricsPage />} />

        <Route path="admin" element={<Navigate to={ROUTES.adminUsers} replace />} />
        <Route path="admin/users" element={<AdminUsersPage />} />
        <Route path="admin/permissions" element={<AdminPermissionsPage />} />
        <Route path="admin/templates" element={<AdminTemplatesPage />} />
        <Route path="admin/audit-logs" element={<AdminAuditPage />} />

        <Route path="*" element={<NotFoundPage />} />
      </Route>

      <Route path="*" element={<Navigate to={ROUTES.workbench} replace />} />
    </Routes>
  );
}
