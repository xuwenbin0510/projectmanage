import { Box, Tooltip, Typography } from '@mui/material';
import type { Health } from '@/types/project';
import { alphaOf as alpha, colorOf } from '@/theme/tokens';
import { HEALTH_LABEL, HEALTH_HINT } from '@/config/enums';

interface HealthDotProps {
  health: Health;
  showLabel?: boolean;
  size?: number;
}

/**
 * 项目健康度指示灯（绿 / 黄 / 红）
 * @prd P0-04
 */
export function HealthDot({ health, showLabel = false, size = 10 }: HealthDotProps): JSX.Element {
  const color = colorOf(health);
  return (
    <Tooltip title={`${HEALTH_LABEL[health]}：${HEALTH_HINT[health]}`} arrow>
      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
        <Box
          component="span"
          sx={{
            width: size,
            height: size,
            borderRadius: '50%',
            bgcolor: color,
            boxShadow: `0 0 ${size}px ${alpha(color, 0.9)}`,
            flexShrink: 0,
          }}
        />
        {showLabel && (
          <Typography variant="caption" sx={{ color }}>
            {HEALTH_LABEL[health]}
          </Typography>
        )}
      </Box>
    </Tooltip>
  );
}
