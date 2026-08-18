/**
 * 看板工具条（B11 · T03）
 *
 * 关键字 + 负责人 + 里程碑 + 「仅看逾期」+ 视图维度切换（状态 / 负责人）+ 清空筛选。
 *
 * 设计要点：
 * - **筛选 100% 前端**（D-B11-5）：本组件只负责把用户输入变成 `BoardFilter`，
 *   由 `BoardPage` 用 `useMemo` 派生视图，**切视图 / 改筛选零网络请求**。
 * - **不持久化**（§9-4）：状态只存 `BoardPage` 组件内 state，不落 URL、不落 localStorage。
 * - **负责人视图只读**（D-B11-6）：切到「按负责人」时给出 Tooltip 说明为何不能拖。
 *
 * @prd B11
 */

import ClearAllIcon from '@mui/icons-material/ClearAll';
import SearchIcon from '@mui/icons-material/Search';
import ViewColumnOutlinedIcon from '@mui/icons-material/ViewColumnOutlined';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import {
  Button,
  FormControlLabel,
  InputAdornment,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';

import type { BoardFilter, BoardGroupBy } from '@/types/wbs';
import { EMPTY_BOARD_FILTER } from '@/types/wbs';
import type { BoardOption } from '@/utils/board';
import { isFilterActive } from '@/utils/board';

export interface BoardToolbarProps {
  /** 当前筛选条件 */
  filter: BoardFilter;
  /** 筛选变更（整体替换，父组件直接 `setFilter(next)`） */
  onFilterChange: (next: BoardFilter) => void;
  /** 当前分列维度 */
  groupBy: BoardGroupBy;
  /** 分列维度变更 */
  onGroupByChange: (next: BoardGroupBy) => void;
  /** 负责人下拉选项（由 `collectOwnerOptions(全量卡片)` 产出） */
  ownerOptions: BoardOption[];
  /** 里程碑下拉选项（由 `BoardPage` 用 `listMilestones` + 卡片计数产出） */
  milestoneOptions: BoardOption[];
  /** 全量卡片数 */
  totalCount: number;
  /** 过滤后卡片数 */
  shownCount: number;
}

/**
 * 看板工具条。
 *
 * 所有下拉均为**受控组件**，值为 `''` 表示「全部」（不过滤）。
 */
export function BoardToolbar({
  filter,
  onFilterChange,
  groupBy,
  onGroupByChange,
  ownerOptions,
  milestoneOptions,
  totalCount,
  shownCount,
}: BoardToolbarProps): JSX.Element {
  const active = isFilterActive(filter);

  /** 局部改一项，其余原样保留 */
  const patch = (part: Partial<BoardFilter>): void => {
    onFilterChange({ ...filter, ...part });
  };

  return (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      spacing={1.25}
      alignItems={{ xs: 'stretch', md: 'center' }}
      sx={{ px: 1.5, pt: 1.5, pb: 0.5, flexWrap: 'wrap' }}
      useFlexGap
    >
      <TextField
        size="small"
        placeholder="搜索 WBS 编码或任务名"
        value={filter.keyword}
        onChange={(e) => patch({ keyword: e.target.value })}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon sx={{ fontSize: 17 }} />
            </InputAdornment>
          ),
        }}
        sx={{ minWidth: { xs: '100%', md: 216 }, flex: { md: '0 1 240px' } }}
      />

      <TextField
        select
        size="small"
        label="负责人"
        value={filter.owner}
        onChange={(e) => patch({ owner: e.target.value })}
        sx={{ minWidth: { xs: '100%', md: 148 } }}
      >
        <MenuItem value="">全部负责人</MenuItem>
        {ownerOptions.map((o) => (
          <MenuItem key={o.value} value={o.value}>
            {o.label}（{o.count}）
          </MenuItem>
        ))}
      </TextField>

      <TextField
        select
        size="small"
        label="里程碑"
        value={filter.milestoneId}
        onChange={(e) => patch({ milestoneId: e.target.value })}
        sx={{ minWidth: { xs: '100%', md: 168 } }}
      >
        <MenuItem value="">全部里程碑</MenuItem>
        {milestoneOptions.map((o) => (
          <MenuItem key={o.value} value={o.value}>
            {o.label}（{o.count}）
          </MenuItem>
        ))}
      </TextField>

      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={filter.overdueOnly}
            onChange={(e) => patch({ overdueOnly: e.target.checked })}
          />
        }
        label={
          <Typography variant="body2" color="text.secondary">
            仅看逾期
          </Typography>
        }
        sx={{ ml: 0, mr: 0 }}
      />

      {/* 右侧：命中计数 + 清空 + 视图切换 */}
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{ ml: { md: 'auto' }, flexShrink: 0, flexWrap: 'wrap' }}
        useFlexGap
      >
        {active && (
          <Typography variant="caption" color="text.secondary">
            命中 {shownCount} / 共 {totalCount}
          </Typography>
        )}

        <Button
          size="small"
          variant="text"
          startIcon={<ClearAllIcon sx={{ fontSize: 16 }} />}
          disabled={!active}
          onClick={() => onFilterChange({ ...EMPTY_BOARD_FILTER })}
        >
          清空筛选
        </Button>

        <Tooltip
          title={
            groupBy === 'owner'
              ? '按负责人视图为只读，切回「按状态」可拖拽改状态'
              : '按状态分列，可拖拽卡片改变任务状态'
          }
          arrow
        >
          <ToggleButtonGroup
            size="small"
            exclusive
            value={groupBy}
            onChange={(_e, v) => {
              if (v === 'status' || v === 'owner') onGroupByChange(v);
            }}
          >
            <ToggleButton value="status" sx={{ px: 1.25, fontSize: 12, textTransform: 'none' }}>
              <ViewColumnOutlinedIcon sx={{ fontSize: 16, mr: 0.5 }} />
              按状态
            </ToggleButton>
            <ToggleButton value="owner" sx={{ px: 1.25, fontSize: 12, textTransform: 'none' }}>
              <GroupOutlinedIcon sx={{ fontSize: 16, mr: 0.5 }} />
              按负责人
            </ToggleButton>
          </ToggleButtonGroup>
        </Tooltip>
      </Stack>
    </Stack>
  );
}
