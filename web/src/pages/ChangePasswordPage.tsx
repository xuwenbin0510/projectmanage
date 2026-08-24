import { useState } from 'react';
import { Box, Button, Card, IconButton, InputAdornment, Stack, TextField, Typography } from '@mui/material';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import LockResetIcon from '@mui/icons-material/LockReset';
import { useNavigate } from 'react-router-dom';

import { ROUTES } from '@/config/routes';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/useToast';
import { tokens } from '@/theme/tokens';

export function ChangePasswordPage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const changePassword = useAuthStore((s) => s.changePassword);
  const loading = useAuthStore((s) => s.loading);
  const user = useAuthStore((s) => s.user);

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleSubmit = async (): Promise<void> => {
    if (!newPassword || newPassword.length < 6) {
      toast.error('新密码至少 6 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('两次输入的新密码不一致');
      return;
    }
    try {
      await changePassword(oldPassword, newPassword);
      toast.success('密码已更新，请重新登录');
      navigate(ROUTES.login, { replace: true });
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 3,
        bgcolor: '#0A0E12',
        color: '#E8EAED',
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
          <LockResetIcon sx={{ color: tokens.brand.primary, fontSize: 28 }} />
          <Typography variant="h5" sx={{ fontWeight: 700, color: '#fff' }}>
            修改密码
          </Typography>
        </Stack>
        <Typography sx={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', mb: 3 }}>
          {user?.name ? `${user.name}，请设置你的登录密码` : '首次登录，请设置你的登录密码'}
        </Typography>

        <Stack spacing={2.5}>
          <TextField
            fullWidth
            label="原密码（首次登录可留空）"
            type={showOld ? 'text' : 'password'}
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSubmit();
            }}
            disabled={loading}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    edge="end"
                    onClick={() => setShowOld((v) => !v)}
                    sx={{ color: 'rgba(255,255,255,0.4)' }}
                  >
                    {showOld ? <VisibilityOffIcon /> : <VisibilityIcon />}
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
          <TextField
            fullWidth
            label="新密码"
            type={showNew ? 'text' : 'password'}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSubmit();
            }}
            disabled={loading}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    edge="end"
                    onClick={() => setShowNew((v) => !v)}
                    sx={{ color: 'rgba(255,255,255,0.4)' }}
                  >
                    {showNew ? <VisibilityOffIcon /> : <VisibilityIcon />}
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
          <TextField
            fullWidth
            label="确认新密码"
            type={showConfirm ? 'text' : 'password'}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSubmit();
            }}
            disabled={loading}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    edge="end"
                    onClick={() => setShowConfirm((v) => !v)}
                    sx={{ color: 'rgba(255,255,255,0.4)' }}
                  >
                    {showConfirm ? <VisibilityOffIcon /> : <VisibilityIcon />}
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
            onClick={() => void handleSubmit()}
            sx={{
              py: 1.25,
              bgcolor: tokens.brand.primary,
              color: '#0A0E12',
              fontWeight: 700,
              '&:hover': { bgcolor: '#7FBAC0' },
            }}
          >
            {loading ? '保存中…' : '确认修改'}
          </Button>
        </Stack>

        <Typography variant="caption" sx={{ display: 'block', mt: 3, color: 'rgba(255,255,255,0.35)' }}>
          密码修改完成后需重新登录。建议使用字母、数字组合，长度不少于 6 位。
        </Typography>
      </Card>
    </Box>
  );
}
