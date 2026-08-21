'use strict';

/**
 * 零依赖 CSV 构造器。
 *
 * 设计要点：
 *  - 字段内含逗号 / 引号 / 换行时按 RFC 4180 用双引号包裹并转义；
 *  - 首行前加 UTF-8 BOM（\uFEFF），保证 Excel 直接打开中文不乱码；
 *  - 行列分隔统一用 CRLF，跨平台兼容。
 */

/**
 * 转义单个单元格。
 * @param {*} value
 * @returns {string}
 */
function escapeCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * 由表头 + 行对象数组构造 CSV 文本（含 BOM）。
 * @param {string[]} headers 列名（同时作为每行对象的 key）
 * @param {Object<string, *>[]} rows 行对象数组（key = 表头名）
 * @returns {string} 带 BOM 的 CSV
 */
function toCsv(headers, rows) {
  const lines = [headers.map(escapeCell).join(',')];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    lines.push(
      headers
        .map(function (h) {
          return escapeCell(row[h]);
        })
        .join(','),
    );
  }
  return '﻿' + lines.join('\r\n');
}

module.exports = { toCsv, escapeCell };
