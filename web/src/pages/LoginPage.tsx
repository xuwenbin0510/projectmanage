import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import RocketLaunchOutlinedIcon from '@mui/icons-material/RocketLaunchOutlined';
import { useLocation, useNavigate } from 'react-router-dom';

import { UserAvatar } from '@/components/common';
import { DEMO_ACCOUNTS } from '@/config/demoAccounts';
import type { DemoAccount } from '@/config/demoAccounts';
import { GLOBAL_ROLE_LABEL } from '@/config/enums';
import { ROUTES } from '@/config/routes';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/useToast';
import { USE_MOCK } from '@/api/client';
import { isInFeishu, hasFeishuSdk, requestAuthCode, waitSdkReady } from '@/utils/feishu';
import { alphaOf as alpha, tokens } from '@/theme/tokens';

interface LocationState {
  from?: string;
}

/**
 * 登录页：飞书免登（内嵌环境）+ 开发态账号切换
 * @prd P0-11
 */
export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const login = useAuthStore((s) => s.login);
  const loginByCode = useAuthStore((s) => s.loginByCode);
  const loading = useAuthStore((s) => s.loading);

  const [feishuReady, setFeishuReady] = useState<boolean>(false);
  const [feishuBusy, setFeishuBusy] = useState<boolean>(false);
  const [picked, setPicked] = useState<string>('');

  const from = (location.state as LocationState | null)?.from ?? ROUTES.workbench;

  useEffect(() => {
    let alive = true;
    void (async () => {
      const ok = await waitSdkReady(1500);
      if (alive) setFeishuReady(ok && hasFeishuSdk());
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** 开发登录：直接指定 openId */
  const handleDevLogin = async (account: DemoAccount): Promise<void> => {
    setPicked(account.openId);
    try {
      const user = await login(account.openId);
      toast.success(`已以「${user.name}· ${GLOBAL_ROLE_LABEL[user.globalRole]}」身份登录`);
      navigate(from, { replace: true });
    } catch (e) {
      toast.error(e);
    } finally {
      setPicked('');
    }
  };

  /** 飞书免登：JSSDK 取 code → 换会话 */
  const handleFeishuLogin = async (): Promise<void> => {
    setFeishuBusy(true);
    try {
      const code = await requestAuthCode(import.meta.env.VITE_APP_TITLE ?? 'cli_demo_appid');
      const user = await loginByCode(code);
      toast.success(`欢迎回来，${user.name}`);
      navigate(from, { replace: true });
    } catch (e) {
      toast.error(e, '飞书免登失败，请改用开发登录');
    } finally {
      setFeishuBusy(false);
    }
  };

  return (
    <Box
      className="space-gradient"
      sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: { xs: 2, md: 4 } }}
    >
      <Paper
        variant="outlined"
        sx={{
          width: '100%',
          maxWidth: 760,
          p: { xs: 2.5, md: 4 },
          bgcolor: alpha(tokens.bg.card, 0.92),
          backdropFilter: 'blur(6px)',
        }}
      >
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 0.5 }}>
          <RocketLaunchOutlinedIcon sx={{ color: tokens.brand.primary, fontSize: 30 }} />
          <Box>
            <Typography variant="h5" sx={{ fontWeight: 600 }}>
              太空字节 · 项目管理系统
            </Typography>
            <Typography variant="body2" color="text.secondary">
              流程可追溯 · 决策有依据 · 交付可预期
            </Typography>
          </Box>
        </Stack>

        <Divider sx={{ my: 2.5 }} />

        <Stack spacing={1.25} sx={{ mb: 2.5 }}>
          <Button
            variant="contained"
            size="large"
            fullWidth
            disabled={!feishuReady || feishuBusy}
            onClick={handleFeishuLogin}
          >
            {feishuBusy ? '飞书免登中…' : '使用飞书账号登录'}
          </Button>
          {!feishuReady && (
            <Typography variant="caption" color="text.secondary">
              {isInFeishu()
                ? '检测到飞书环境，但 JSSDK 尚未就绪，请使用下方开发登录。'
                : '当前不在飞书客户端内，免登不可用，请使用下方开发登录。'}
            </Typography>
          )}
        </Stack>

        {USE_MOCK && (
          <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
            当前为 <b>S1 静态原型（Mock 模式）</b>：数据存于浏览器会话，刷新保留、关闭标签页清空；
            右上角菜单可「复位演示数据」。
          </Alert>
        )}

        <Typography variant="subtitle2" sx={{ mb: 1.25 }}>
          开发登录 · 选择一个演示角色
        </Typography>

        <Box
          sx={{
            display: 'grid',
            gap: 1.25,
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' },
          }}
        >
          {DEMO_ACCOUNTS.map((a) => {
            const busy = loading && picked === a.openId;
            return (
              <Paper
                key={a.openId}
                variant="outlined"
                onClick={() => void handleDevLogin(a)}
                sx={{
                  p: 1.5,
                  cursor: 'pointer',
                  opacity: loading && !busy ? 0.6 : 1,
                  pointerEvents: loading ? 'none' : 'auto',
                  transition: 'border-color .18s, transform .18s',
                  '&:hover': { borderColor: alpha(tokens.brand.primary, 0.7), transform: 'translateY(-2px)' },
                }}
              >
                <Stack direction="row" spacing={1.25} alignItems="center">
                  <UserAvatar name={a.name} size={34} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{a.name}</Typography>
                      <Chip
                        size="small"
                        label={GLOBAL_ROLE_LABEL[a.globalRole]}
                        sx={{ height: 18, fontSize: 10, bgcolor: alpha(tokens.brand.primary, 0.16) }}
                      />
                      {busy && (
                        <Typography variant="caption" color="text.secondary">
                          登录中…
                        </Typography>
                      )}
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {a.hint}
                    </Typography>
                  </Box>
                </Stack>
              </Paper>
            );
          })}
        </Box>
      </Paper>
    </Box>
  );
}
