import type { ReactNode } from 'react';
import {
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { EmptyState, LoadingState } from './States';

export interface Column<T> {
  key: string;
  label: string;
  /** 列宽：px / CSS 字符串 / 响应式对象（第二批起支持，配合 tableLayout="fixed" 控制拉伸上限） */
  width?: number | string | Record<string, number | string>;
  align?: 'left' | 'right' | 'center';
  render?: (row: T, index: number) => ReactNode;
  /** 移动端隐藏（兼容旧接口，等价于 hideBelow: 'md'） */
  hideOnMobile?: boolean;
  /** 在指定断点以下隐藏该列；例如 'lg' 表示 lg 以下隐藏，lg 及以上显示 */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
}

/** 将 hideBelow 映射为 MUI display 响应式对象 */
function responsiveHideSx(below?: 'sm' | 'md' | 'lg' | 'xl') {
  switch (below) {
    case 'sm':
      return { display: { xs: 'none', sm: 'table-cell' } };
    case 'md':
      return { display: { xs: 'none', md: 'table-cell' } };
    case 'lg':
      return { display: { xs: 'none', lg: 'table-cell' } };
    case 'xl':
      return { display: { xs: 'none', xl: 'table-cell' } };
    default:
      return {};
  }
}

interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  onRowClick?: (row: T) => void;
  /** 分页（不传则不显示） */
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    onChange: (page: number, pageSize: number) => void;
  };
  dense?: boolean;
  /**
   * 表格布局（第二批 · 高分辨率自适应）：
   * - `auto`（默认）：浏览器按内容分配列宽，兼容既有页面；
   * - `fixed`：按列 `width` 固定分配，未设宽度的列均分剩余空间（配合列级 minWidth/maxWidth 控制拉伸上限）。
   */
  tableLayout?: 'auto' | 'fixed';
}

/** 通用数据表格（含空态 / 加载态 / 分页） */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  emptyTitle = '暂无数据',
  emptyDescription = '',
  onRowClick,
  pagination,
  dense = false,
  tableLayout = 'auto',
}: DataTableProps<T>): JSX.Element {
  // 响应式断点：用于计算 fixed 布局下「当前可见列」的声明宽度之和，作为表格最小宽度。
  // 注意：以下 hook 必须位于所有 early return 之前，避免 hooks 调用顺序不一致。
  const theme = useTheme();
  const smUp = useMediaQuery(theme.breakpoints.up('sm'));
  const mdUp = useMediaQuery(theme.breakpoints.up('md'));
  const lgUp = useMediaQuery(theme.breakpoints.up('lg'));
  const xlUp = useMediaQuery(theme.breakpoints.up('xl'));

  if (loading) return <LoadingState variant="skeleton" rows={5} height={44} />;
  if (!rows.length) return <EmptyState title={emptyTitle} description={emptyDescription} dense />;

  const isFixed = tableLayout === 'fixed';

  // fixed 模式的最小宽度 = 当前断点下可见列的声明宽度之和：
  // 容器变窄时表格改为横向滚动（TableContainer 已 overflowX:auto），而不是把列同比压窄到触发 text-overflow 裁切。
  const upByBreakpoint: Record<'sm' | 'md' | 'lg' | 'xl', boolean> = { sm: smUp, md: mdUp, lg: lgUp, xl: xlUp };
  const isColumnVisible = (c: Column<T>): boolean => {
    const below = c.hideBelow ?? (c.hideOnMobile ? 'md' : undefined);
    return below ? upByBreakpoint[below] : true;
  };
  const fixedMinWidth = columns.reduce(
    (sum, c) => (isColumnVisible(c) && typeof c.width === 'number' ? sum + c.width : sum),
    0,
  );

  return (
    <Box>
      <TableContainer sx={{ overflowX: 'auto', width: '100%' }}>
        {/* fixed：设最小宽度=可见列声明宽度之和，容器更窄时横向滚动，避免列被压窄后触发 text-overflow 裁切；auto：保持既有行为 */}
        <Table size={dense ? 'small' : 'medium'} sx={{ tableLayout, minWidth: isFixed ? fixedMinWidth || undefined : 'max-content' }}>
          <TableHead>
            <TableRow>
              {columns.map((c) => (
                <TableCell
                  key={c.key}
                  align={c.align ?? 'left'}
                  sx={{
                    width: c.width,
                    maxWidth: isFixed ? undefined : c.width,
                    whiteSpace: 'nowrap',
                    overflow: c.width ? 'hidden' : undefined,
                    textOverflow: c.width ? 'ellipsis' : undefined,
                    ...(c.hideBelow ? responsiveHideSx(c.hideBelow) : c.hideOnMobile ? { display: { xs: 'none', md: 'table-cell' } } : {}),
                  }}
                >
                  {c.label}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow
                key={rowKey(row)}
                hover
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                sx={{ cursor: onRowClick ? 'pointer' : 'default' }}
              >
                {columns.map((c) => (
                  <TableCell
                    key={c.key}
                    align={c.align ?? 'left'}
                    sx={{
                      width: c.width,
                      maxWidth: isFixed ? undefined : c.width,
                      whiteSpace: 'nowrap',
                      overflow: c.width ? 'hidden' : undefined,
                      textOverflow: c.width ? 'ellipsis' : undefined,
                      ...(c.hideBelow ? responsiveHideSx(c.hideBelow) : c.hideOnMobile ? { display: { xs: 'none', md: 'table-cell' } } : {}),
                    }}
                  >
                    {c.render ? c.render(row, i) : String((row as Record<string, unknown>)[c.key] ?? '—')}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {pagination && (
        <TablePagination
          component="div"
          count={pagination.total}
          page={Math.max(0, pagination.page - 1)}
          rowsPerPage={pagination.pageSize}
          rowsPerPageOptions={[10, 12, 20, 50]}
          labelRowsPerPage="每页"
          labelDisplayedRows={({ from, to, count }) => `${from}-${to} / 共 ${count} 条`}
          onPageChange={(_, p) => pagination.onChange(p + 1, pagination.pageSize)}
          onRowsPerPageChange={(e) => pagination.onChange(1, Number(e.target.value))}
        />
      )}
    </Box>
  );
}
