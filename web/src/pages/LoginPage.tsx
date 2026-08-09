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
import { api, USE_MOCK } from '@/api/client';
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
  const loginByFeishuWeb = useAuthStore((s) => s.loginByFeishuWeb);
  const loading = useAuthStore((s) => s.loading);

  const [feishuReady, setFeishuReady] = useState<boolean>(false);
  const [feishuBusy, setFeishuBusy] = useState<boolean>(false);
  /** 服务端下发的飞书 AppID（Web OAuth 按钮是否可用取决于它，与 JSSDK 的 feishuReady 解耦） */
  const [appId, setAppId] = useState<string>('');
  const [picked, setPicked] = useState<string>('');

  const from = (location.state as LocationState | null)?.from ?? ROUTES.workbench;

  useEffect(() => {
    let alive = true;
    void (async () => {
      const ok = await waitSdkReady(1500);
      if (alive) setFeishuReady(ok && hasFeishuSdk());
      // 取服务端 AppID（B4-T03 浏览器飞书登录按钮的可用开关）
      const id = await api.getAppId();
      if (alive) setAppId(id || '');
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 飞书 Web OAuth 回调处理（B4-T03）：飞书授权后重定向回 `/login?code=..&state=..`。
   * - 校验 `state` 防 CSRF（与发起时写入 sessionStorage 的值比对）；
   * - 调 `loginByFeishuWeb` 换 token 并落到同一用户态；
   * - 清理 URL 中的 `code/state`，避免刷新重复消费。
   */
  useEffect(() => {
    if (window.location.pathname !== ROUTES.login) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) return; // 非回调进入，忽略

    const expected = sessionStorage.getItem('feishu_oauth_state');
    sessionStorage.removeItem('feishu_oauth_state');
    if (state !== expected) {
      toast.error('飞书授权校验失败（state 不匹配），请重试');
      window.history.replaceState({}, '', ROUTES.login);
      return;
    }

    let alive = true;
    void (async () => {
      try {
        const user = await loginByFeishuWeb(code);
        if (!alive) return;
        toast.success(`欢迎回来，${user.name}`);
        window.history.replaceState({}, '', ROUTES.login);
        navigate(from, { replace: true });
      } catch (e) {
        if (!alive) return;
        toast.error(e, '飞书网页登录失败，请改用开发登录');
        window.history.replaceState({}, '', ROUTES.login);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loginByFeishuWeb, navigate, from]);

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

  /**
   * 飞书免登：服务端取真实 AppID → JSSDK 取 code → 换会话。
   *
   * ⚠️ AppID **必须**来自服务端 `GET /api/appid`（后端读 FEISHU_APP_ID）。
   * 历史实现误传了 `VITE_APP_TITLE`（应用标题），JSSDK 一定取不到 code。
   */
  const handleFeishuLogin = async (): Promise<void> => {
    setFeishuBusy(true);
    try {
      const appId = await api.getAppId();
      if (!appId) {
        throw new Error('服务端未配置飞书应用凭证（FEISHU_APP_ID），请改用开发登录');
      }
      const code = await requestAuthCode(appId);
      const user = await loginByCode(code);
      toast.success(`欢迎回来，${user.name}`);
      navigate(from, { replace: true });
    } catch (e) {
      toast.error(e, '飞书免登失败，请改用开发登录');
    } finally {
      setFeishuBusy(false);
    }
  };

  /**
   * 浏览器飞书 Web OAuth 发起（B4-T03）：拼接授权 URL 跳转飞书开放平台。
   * 注意：`redirect_uri` 必须 == 飞书开放平台「重定向 URL」登记值（含协议/路径/末尾无斜杠）。
   */
  const handleFeishuWebLogin = async (): Promise<void> => {
    const id = await api.getAppId();
    if (!id) {
      toast.error('服务端未配置飞书应用凭证（FEISHU_APP_ID），请改用开发登录');
      return;
    }
    const state = Math.random().toString(36).slice(2);
    sessionStorage.setItem('feishu_oauth_state', state);
    const redirectUri = encodeURIComponent(`${window.location.origin}${ROUTES.login}`);
    const url =
      'https://open.feishu.cn/open-apis/authen/v2/authorize' +
      `?app_id=${id}&redirect_uri=${redirectUri}&response_type=code` +
      `&scope=${encodeURIComponent('contact:user.base:readonly')}&state=${state}`;
    window.location.href = url; // 跳飞书授权页
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

        {/* 浏览器飞书 Web OAuth 登录（普通浏览器可用，不依赖 JSSDK） */}
        <Stack spacing={1} sx={{ mb: 2.5 }}>
          <Button
            variant="outlined"
            size="large"
            fullWidth
            disabled={!appId}
            onClick={handleFeishuWebLogin}
          >
            {appId ? '使用飞书账号登录（浏览器）' : '飞书 Web 登录未启用'}
          </Button>
          {!appId && (
            <Typography variant="caption" color="text.secondary">
              {USE_MOCK
                ? '当前为 Mock 模式，Web 登录不可用，请使用下方开发登录。'
                : '服务端未配置飞书应用凭证（FEISHU_APP_ID），Web 登录不可用，请使用下方开发登录。'}
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
