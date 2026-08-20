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
} from '@mui/material';
import { EmptyState, LoadingState } from './States';

export interface Column<T> {
  key: string;
  label: string;
  /** 列宽：px / CSS 字符串 / 响应式对象（第二批起支持，配合 tableLayout="fixed" 控制拉伸上限） */
  width?: number | string | Record<string, number | string>;
  align?: 'left' | 'right' | 'center';
  render?: (row: T, index: number) => ReactNode;
  /** 移动端隐藏 */
  hideOnMobile?: boolean;
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
  if (loading) return <LoadingState variant="skeleton" rows={5} height={44} />;
  if (!rows.length) return <EmptyState title={emptyTitle} description={emptyDescription} dense />;

  return (
    <Box>
      <TableContainer>
        <Table size={dense ? 'small' : 'medium'} sx={{ tableLayout }}>
          <TableHead>
            <TableRow>
              {columns.map((c) => (
                <TableCell
                  key={c.key}
                  align={c.align ?? 'left'}
                  sx={{
                    width: c.width,
                    whiteSpace: 'nowrap',
                    ...(c.hideOnMobile ? { display: { xs: 'none', md: 'table-cell' } } : {}),
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
                    sx={c.hideOnMobile ? { display: { xs: 'none', md: 'table-cell' } } : undefined}
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
