import type { ReactNode } from 'react';
import { Box, Breadcrumbs, Link, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

export interface Crumb {
  label: string;
  to?: string;
}

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  crumbs?: Crumb[];
  actions?: ReactNode;
  /** 标题右侧的徽标区（状态、分类等） */
  badges?: ReactNode;
}

/** 页面头部：面包屑 + 标题 + 操作区 */
export function PageHeader({ title, subtitle, crumbs = [], actions, badges }: PageHeaderProps): JSX.Element {
  return (
    <Box sx={{ mb: 3 }}>
      {crumbs.length > 0 && (
        <Breadcrumbs sx={{ mb: 1, fontSize: 13 }} separator="/">
          {crumbs.map((c) =>
            c.to ? (
              <Link key={c.label} component={RouterLink} to={c.to} underline="hover" color="text.secondary">
                {c.label}
              </Link>
            ) : (
              <Typography key={c.label} variant="body2" color="text.secondary">
                {c.label}
              </Typography>
            ),
          )}
        </Breadcrumbs>
      )}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        spacing={1.5}
      >
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h5" sx={{ fontWeight: 600 }}>
              {title}
            </Typography>
            {badges}
          </Stack>
          {subtitle && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {subtitle}
            </Typography>
          )}
        </Box>
        {actions && (
          <Stack direction="row" spacing={1} flexShrink={0}>
            {actions}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
