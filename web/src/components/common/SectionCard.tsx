import type { ReactNode } from 'react';
import { Box, Divider, Paper, Stack, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';

interface SectionCardProps {
  title?: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** 内容区去掉内边距（表格/看板场景） */
  flush?: boolean;
  sx?: SxProps<Theme>;
}

/** 内容分区卡片（深空面板） */
export function SectionCard({
  title,
  subtitle,
  actions,
  children,
  flush = false,
  sx = {},
}: SectionCardProps): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden', ...sx }}>
      {(title || actions) && (
        <>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            spacing={1}
            sx={{ px: 2.5, py: 1.75 }}
          >
            <Box sx={{ minWidth: 0 }}>
              {typeof title === 'string' ? (
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  {title}
                </Typography>
              ) : (
                title
              )}
              {subtitle && (
                <Typography variant="caption" color="text.secondary">
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
          <Divider />
        </>
      )}
      <Box sx={{ p: flush ? 0 : 2.5 }}>{children}</Box>
    </Paper>
  );
}
