import { useEffect } from 'react';
import { Box, CircularProgress } from '@mui/material';
import { AppRouter } from './router';
import { useAuthStore } from '@/stores/authStore';

/** 应用根组件：启动时恢复会话，再交给路由 */
export function App(): JSX.Element {
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const ready = useAuthStore((s) => s.ready);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (!ready) {
    return (
      <Box sx={{ height: '100vh', display: 'grid', placeItems: 'center', bgcolor: 'background.default' }}>
        <CircularProgress />
      </Box>
    );
  }

  return <AppRouter />;
}
