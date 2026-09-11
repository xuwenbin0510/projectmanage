import { useEffect, useRef, useState } from 'react';
import { Tooltip, Typography } from '@mui/material';
import type { SystemStyleObject } from '@mui/system';
import type { Theme } from '@mui/material';

interface TruncatedNameProps {
  /** 展示文本（单行截断） */
  name: string;
  /** Tooltip 内容，默认与 name 相同 */
  title?: string;
  /** 覆盖排版（字号/字重/颜色、flex 伸缩等）；容器相关样式由调用方按场景给 */
  sx?: SystemStyleObject<Theme>;
}

/**
 * 单行截断文本：**仅当文本实际被截断（scrollWidth > clientWidth）时才弹 Tooltip**
 * 显示完整内容；未截断时不出提示，避免每行悬停都打扰。
 *
 * 实现要点：用 ResizeObserver + 挂载时预检测截断状态——**不能在 onMouseEnter 里惰性测量**，
 * 因为 disableHoverListener 在鼠标进入后才翻转时，Tooltip 已错过 enter 事件不会弹出。
 */
export function TruncatedName({ name, title, sx }: TruncatedNameProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setTruncated(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [name]);

  return (
    <Tooltip title={title ?? name} arrow disableHoverListener={!truncated}>
      <Typography ref={ref} sx={{ minWidth: 0, ...sx }} noWrap>
        {name}
      </Typography>
    </Tooltip>
  );
}
