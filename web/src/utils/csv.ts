/**
 * CSV 工具：前端导出用。
 *
 *  - `toCsv`：零依赖构造（与后端 server/lib/csv.js 同口径，含 UTF-8 BOM），供 mock 模式本地生成；
 *  - `downloadCsv`：Blob + a 标签触发浏览器下载；
 *  - `fetchCsv`：带 Bearer 鉴权拉取服务端导出的 CSV（真实模式走此通道）。
 */

import { getToken } from '@/api/http';
import { USE_MOCK } from '@/api/client';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) || '/api';

/** 转义单个单元格（RFC 4180）。 */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 由表头 + 行对象数组构造带 BOM 的 CSV。 */
export function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h])).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

/** 触发浏览器下载 CSV（csv 文本应已含 BOM）。 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 带 Bearer 鉴权拉取服务端导出的 CSV 文本。 */
export async function fetchCsv(url: string): Promise<string> {
  const res = await fetch(`${BASE}${url}`, {
    method: 'GET',
    headers: { ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
  });
  if (!res.ok) {
    throw new Error(`导出失败（HTTP ${res.status}）`);
  }
  return res.text();
}

/** 文件名用日期戳（YYYYMMDD）。 */
export function csvDateStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export { USE_MOCK };
