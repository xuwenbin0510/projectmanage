import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
} from '@mui/material';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { useToast } from '@/hooks/useToast';
import { useAuthStore } from '@/stores/authStore';
import { tokens } from '@/theme/tokens';

interface Props {
  open: boolean;
  onClose: () => void;
}

const fieldSx = {
  '& .MuiOutlinedInput-root': {
    bgcolor: 'rgba(255,255,255,0.04)',
    '& fieldset': { borderColor: 'rgba(255,255,255,0.12)' },
    '&:hover fieldset': { borderColor: 'rgba(109,168,174,0.5)' },
    '&.Mui-focused fieldset': { borderColor: tokens.brand.primary },
  },
  '& .MuiInputLabel-root': { color: 'rgba(255,255,255,0.5)' },
  '& .MuiInputBase-input': { color: '#fff' },
};

export function ChangePasswordDialog({ open, onClose }: Props): JSX.Element {
  const toast = useToast();
  const changePassword = useAuthStore((s) => s.changePassword);
  const loading = useAuthStore((s) => s.loading);

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const reset = (): void => {
    setOldPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setShowOld(false);
    setShowNew(false);
    setShowConfirm(false);
  };

  const handleClose = (): void => {
    if (loading) return;
    reset();
    onClose();
  };

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
      toast.success('密码已更新');
      reset();
      onClose();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      fullWidth
      maxWidth="xs"
      PaperProps={{ sx: { bgcolor: '#11161B', color: '#E8EAED', borderRadius: 3 } }}
    >
      <DialogTitle sx={{ fontWeight: 700, color: '#fff' }}>修改密码</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <TextField
            fullWidth
            label="原密码"
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
            sx={fieldSx}
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
            sx={fieldSx}
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
            sx={fieldSx}
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleClose} disabled={loading} sx={{ color: 'rgba(255,255,255,0.6)' }}>
          取消
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleSubmit()}
          disabled={loading}
          sx={{
            bgcolor: tokens.brand.primary,
            color: '#0A0E12',
            fontWeight: 700,
            '&:hover': { bgcolor: '#7FBAC0' },
          }}
        >
          {loading ? '保存中…' : '确认修改'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
