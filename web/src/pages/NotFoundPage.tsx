import { Box, Button, Stack, Typography } from '@mui/material';
import ExploreOffIcon from '@mui/icons-material/ExploreOff';

import { useNavigate } from 'react-router-dom';
import { ROUTES } from '@/config/routes';

/** 404 兜底页（深链 / 路由未匹配时统一呈现，避免白屏） */
export function NotFoundPage(): JSX.Element {
  const navigate = useNavigate();
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={2}
      sx={{ py: 12, textAlign: 'center', color: 'text.secondary' }}
    >
      <ExploreOffIcon sx={{ fontSize: 64, opacity: 0.5 }} />
      <Typography variant="h4" sx={{ fontWeight: 700, color: 'text.primary' }}>
        404
      </Typography>
      <Typography variant="body1">你访问的页面不存在或已被移动。</Typography>
      <Box>
        <Button variant="contained" onClick={() => navigate(ROUTES.workbench)} sx={{ mr: 1 }}>
          回到工作台
        </Button>
        <Button variant="outlined" onClick={() => navigate(ROUTES.projects)}>
          查看项目
        </Button>
      </Box>
    </Stack>
  );
}
