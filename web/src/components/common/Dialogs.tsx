import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
} from '@mui/material';
import type { Breakpoint } from '@mui/material';
import { useToast } from '@/hooks/useToast';

/* ── 确认对话框 ───────────────────────────────────── */

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  content: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

/** 二次确认对话框（带提交中态与异常提示） */
export function ConfirmDialog({
  open,
  title,
  content,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  onClose,
  onConfirm,
}: ConfirmDialogProps): JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const handle = async (): Promise<void> => {
    setSubmitting(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {typeof content === 'string' ? <DialogContentText>{content}</DialogContentText> : content}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting} color="inherit">
          {cancelText}
        </Button>
        <Button onClick={handle} disabled={submitting} variant="contained" color={danger ? 'error' : 'primary'}>
          {submitting ? '处理中…' : confirmText}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/* ── 表单对话框 ───────────────────────────────────── */

interface FormDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  submitText?: string;
  cancelText?: string;
  maxWidth?: Breakpoint;
  submitting?: boolean;
  disabled?: boolean;
  extraActions?: ReactNode;
  onClose: () => void;
  onSubmit: () => void;
}

/** 通用表单对话框外壳 */
export function FormDialog({
  open,
  title,
  children,
  submitText = '保存',
  cancelText = '取消',
  maxWidth = 'sm',
  submitting = false,
  disabled = false,
  extraActions,
  onClose,
  onSubmit,
}: FormDialogProps): JSX.Element {
  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth={maxWidth} fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.25} sx={{ pt: 1 }}>
          {children}
        </Stack>
      </DialogContent>
      <DialogActions>
        {extraActions}
        <Button onClick={onClose} disabled={submitting} color="inherit">
          {cancelText}
        </Button>
        <Button onClick={onSubmit} disabled={submitting || disabled} variant="contained">
          {submitting ? '提交中…' : submitText}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
