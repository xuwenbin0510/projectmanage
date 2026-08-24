import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Chip,
  Divider,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import RocketLaunchOutlinedIcon from '@mui/icons-material/RocketLaunchOutlined';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import TrackChangesOutlinedIcon from '@mui/icons-material/TrackChangesOutlined';
import AssignmentTurnedInOutlinedIcon from '@mui/icons-material/AssignmentTurnedInOutlined';
import { useLocation, useNavigate } from 'react-router-dom';

import { ROUTES } from '@/config/routes';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/useToast';
import { api, USE_MOCK } from '@/api/client';
import { isInFeishu, hasFeishuSdk, requestAuthCode, waitSdkReady } from '@/utils/feishu';
import { tokens } from '@/theme/tokens';

interface LocationState {
  from?: string;
}

const HERO_POINTS = [
  { icon: ShieldOutlinedIcon, text: '流程可追溯 · 决策有依据 · 交付可预期' },
  { icon: TrackChangesOutlinedIcon, text: '全生命周期项目跟踪：立项、WBS、门控、变更' },
  { icon: AssignmentTurnedInOutlinedIcon, text: '周报闭环、质量门、交付物一站式管理' },
];

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const loginWithPassword = useAuthStore((s) => s.loginWithPassword);
  const loginByCode = useAuthStore((s) => s.loginByCode);
  const loginByFeishuWeb = useAuthStore((s) => s.loginByFeishuWeb);
  const loading = useAuthStore((s) => s.loading);

  const from = (location.state as LocationState | null)?.from ?? ROUTES.workbench;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [feishuReady, setFeishuReady] = useState(false);
  const [feishuBusy, setFeishuBusy] = useState(false);
  const [appId, setAppId] = useState('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const ok = await waitSdkReady(1500);
      if (alive) setFeishuReady(ok && hasFeishuSdk());
      const id = await api.getAppId();
      if (alive) setAppId(id || '');
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (window.location.pathname !== ROUTES.login) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const err = params.get('error');
    const errDesc = params.get('error_description');
    if (err) {
      toast.error(`飞书授权失败：${errDesc || err}`);
      window.history.replaceState({}, '', ROUTES.login);
      return;
    }
    if (!code || !state) return;

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
        toast.error(e, '飞书网页登录失败，请改用邮箱密码登录');
        window.history.replaceState({}, '', ROUTES.login);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loginByFeishuWeb, navigate, from, toast]);

  const handlePasswordLogin = async (): Promise<void> => {
    if (!email.trim()) {
      toast.error('请输入邮箱');
      return;
    }
    if (!password) {
      toast.error('请输入密码');
      return;
    }
    try {
      const { user, mustChangePwd } = await loginWithPassword(email.trim(), password);
      if (mustChangePwd) {
        toast.info('首次登录，请先修改密码');
        navigate('/change-password', { replace: true });
        return;
      }
      toast.success(`欢迎回来，${user.name}`);
      navigate(from, { replace: true });
    } catch (e) {
      toast.error(e);
    }
  };

  const handleFeishuLogin = async (): Promise<void> => {
    setFeishuBusy(true);
    try {
      const appId = await api.getAppId();
      if (!appId) throw new Error('服务端未配置飞书应用凭证');
      const code = await requestAuthCode(appId);
      const user = await loginByCode(code);
      toast.success(`欢迎回来，${user.name}`);
      navigate(from, { replace: true });
    } catch (e) {
      toast.error(e, '飞书免登失败，请改用邮箱密码登录');
    } finally {
      setFeishuBusy(false);
    }
  };

  const handleFeishuWebLogin = async (): Promise<void> => {
    const id = await api.getAppId();
    if (!id) {
      toast.error('服务端未配置飞书应用凭证，请使用邮箱密码登录');
      return;
    }
    const state = Math.random().toString(36).slice(2);
    sessionStorage.setItem('feishu_oauth_state', state);
    const redirectUri = encodeURIComponent(`${window.location.origin}${ROUTES.login}`);
    const url =
      'https://open.feishu.cn/open-apis/authen/v1/authorize' +
      `?app_id=${id}&redirect_uri=${redirectUri}&response_type=code` +
      `&scope=${encodeURIComponent('contact:user.base:readonly contact:user.email:readonly')}&state=${state}`;
    window.location.href = url;
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        bgcolor: '#0A0E12',
        color: '#E8EAED',
      }}
    >
      {/* 左侧品牌区 */}
      <Box
        sx={{
          flex: 1,
          display: { xs: 'none', md: 'flex' },
          flexDirection: 'column',
          justifyContent: 'space-between',
          p: 6,
          background:
            'radial-gradient(ellipse at 20% 20%, rgba(109,168,174,0.10) 0%, transparent 40%), radial-gradient(ellipse at 80% 80%, rgba(45,95,100,0.12) 0%, transparent 45%), #0A0E12',
          borderRight: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <Stack direction="row" spacing={2} alignItems="center">
          <Box
            component="img"
            src="/logo_dark.png"
            alt="logo"
            sx={{
              height: 48,
              width: 'auto',
              display: 'block',
              objectFit: 'contain',
              filter: 'drop-shadow(0 0 16px rgba(109,168,174,0.35))',
            }}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
          <Typography sx={{ fontSize: 26, fontWeight: 700, letterSpacing: 2, color: '#fff' }}>
            项目管理系统
          </Typography>
        </Stack>

        <Box sx={{ maxWidth: 560 }}>
          <Chip
            size="small"
            label="COMMERCIAL PIPELINE"
            sx={{
              mb: 2,
              color: tokens.brand.primary,
              bgcolor: 'rgba(109,168,174,0.12)',
              border: '1px solid rgba(109,168,174,0.25)',
              fontWeight: 600,
              letterSpacing: 1,
            }}
          />
          <Typography
            variant="h2"
            sx={{
              fontSize: { md: 44, lg: 52 },
              fontWeight: 700,
              lineHeight: 1.18,
              mb: 2.5,
              color: '#fff',
            }}
          >
            把每一次推进，
            <br />
            沉淀成可信的增长证据。
          </Typography>
          <Typography sx={{ fontSize: 16, color: 'rgba(255,255,255,0.55)', lineHeight: 1.7, mb: 4 }}>
            面向高客单价、长周期航天 B2B 业务的独立项目作战系统。
            流程 · 决策 · 交付，全程可审计。
          </Typography>

          <Stack spacing={2.5}>
            {HERO_POINTS.map((p, idx) => (
              <Stack key={idx} direction="row" spacing={2} alignItems="center">
                <Box
                  sx={{
                    width: 38,
                    height: 38,
                    borderRadius: 2,
                    display: 'grid',
                    placeItems: 'center',
                    bgcolor: 'rgba(109,168,174,0.10)',
                    border: '1px solid rgba(109,168,174,0.18)',
                    color: tokens.brand.primary,
                  }}
                >
                  <p.icon sx={{ fontSize: 20 }} />
                </Box>
                <Typography sx={{ fontSize: 14, color: 'rgba(255,255,255,0.72)' }}>{p.text}</Typography>
              </Stack>
            ))}
          </Stack>
        </Box>

        <Typography sx={{ fontSize: 12, color: 'rgba(255,255,255,0.25)' }}>
          © 2026 AstrByte Space Data. All rights reserved.
        </Typography>
      </Box>

      {/* 右侧登录区 */}
      <Box
        sx={{
          flex: { xs: 1, md: '0 0 480px', lg: '0 0 520px' },
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: { xs: 3, sm: 5 },
          position: 'relative',
        }}
      >
        <Card
          elevation={0}
          sx={{
            width: '100%',
            maxWidth: 420,
            p: { xs: 3, sm: 4 },
            bgcolor: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 3,
            backdropFilter: 'blur(8px)',
          }}
        >
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 0.5 }}>
            <RocketLaunchOutlinedIcon sx={{ color: tokens.brand.primary, fontSize: 28 }} />
            <Typography variant="h5" sx={{ fontWeight: 700, color: '#fff' }}>
              登录系统
            </Typography>
          </Stack>
          <Typography sx={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', mb: 3 }}>
            使用企业邮箱与密码登录项目管理系统
          </Typography>

          <Stack spacing={2.5}>
            <TextField
              fullWidth
              label="邮箱"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handlePasswordLogin();
              }}
              autoFocus
              disabled={loading}
              sx={{
                '& .MuiOutlinedInput-root': {
                  bgcolor: 'rgba(255,255,255,0.04)',
                  '& fieldset': { borderColor: 'rgba(255,255,255,0.12)' },
                  '&:hover fieldset': { borderColor: 'rgba(109,168,174,0.5)' },
                  '&.Mui-focused fieldset': { borderColor: tokens.brand.primary },
                },
                '& .MuiInputLabel-root': { color: 'rgba(255,255,255,0.5)' },
                '& .MuiInputBase-input': { color: '#fff' },
              }}
            />
            <TextField
              fullWidth
              label="密码"
              type={showPwd ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handlePasswordLogin();
              }}
              disabled={loading}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      edge="end"
                      onClick={() => setShowPwd((v) => !v)}
                      sx={{ color: 'rgba(255,255,255,0.4)' }}
                    >
                      {showPwd ? <VisibilityOffIcon /> : <VisibilityIcon />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
              sx={{
                '& .MuiOutlinedInput-root': {
                  bgcolor: 'rgba(255,255,255,0.04)',
                  '& fieldset': { borderColor: 'rgba(255,255,255,0.12)' },
                  '&:hover fieldset': { borderColor: 'rgba(109,168,174,0.5)' },
                  '&.Mui-focused fieldset': { borderColor: tokens.brand.primary },
                },
                '& .MuiInputLabel-root': { color: 'rgba(255,255,255,0.5)' },
                '& .MuiInputBase-input': { color: '#fff' },
              }}
            />

            <Button
              variant="contained"
              size="large"
              fullWidth
              disabled={loading}
              onClick={() => void handlePasswordLogin()}
              sx={{
                py: 1.25,
                bgcolor: tokens.brand.primary,
                color: '#0A0E12',
                fontWeight: 700,
                '&:hover': { bgcolor: '#7FBAC0' },
              }}
            >
              {loading ? '登录中…' : '登 录'}
            </Button>
          </Stack>

          <Divider sx={{ my: 3, borderColor: 'rgba(255,255,255,0.08)' }}>
            <Typography sx={{ fontSize: 12, color: 'rgba(255,255,255,0.3)' }}>或</Typography>
          </Divider>

          <Stack spacing={1.5}>
            <Button
              variant="outlined"
              size="large"
              fullWidth
              disabled={!feishuReady || feishuBusy}
              onClick={() => void handleFeishuLogin()}
              sx={{
                borderColor: 'rgba(255,255,255,0.15)',
                color: 'rgba(255,255,255,0.85)',
                '&:hover': { borderColor: tokens.brand.primary, color: '#fff' },
              }}
            >
              {feishuBusy ? '飞书免登中…' : '使用飞书账号登录'}
            </Button>
            <Button
              variant="outlined"
              size="large"
              fullWidth
              disabled={!appId}
              onClick={() => void handleFeishuWebLogin()}
              sx={{
                borderColor: 'rgba(255,255,255,0.15)',
                color: 'rgba(255,255,255,0.85)',
                '&:hover': { borderColor: tokens.brand.primary, color: '#fff' },
              }}
            >
              {appId ? '使用飞书账号登录（浏览器）' : '飞书 Web 登录未启用'}
            </Button>
          </Stack>

          {!appId && !feishuReady && (
            <Typography variant="caption" sx={{ display: 'block', mt: 2, color: 'rgba(255,255,255,0.35)' }}>
              未配置飞书凭证时，请使用邮箱密码登录。首次登录默认密码为 AstrBytes@2026，登录后请立即修改。
            </Typography>
          )}

          {USE_MOCK && (
            <Typography variant="caption" sx={{ display: 'block', mt: 2, color: tokens.brand.primary }}>
              当前为 Mock 模式，仅用于本地演示。
            </Typography>
          )}
        </Card>
      </Box>
    </Box>
  );
}
