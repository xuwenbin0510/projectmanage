#!/usr/bin/env node
/**
 * 离线校验：前端 `web/src/config/permissions.ts` 的 PERMISSIONS action key 集合
 * 与后端 `server/config/permissions.js` 的 DEFAULT_PERMISSIONS action key 集合是否一致。
 *
 * 用法（任选其一）：
 *   node scripts/check_permissions_sync.mjs
 *
 * 退出码：0 = 一致；1 = 不一致（人工核对 / CI 用）。
 * 不接入主流程，纯本地核对工具；改任一端权限后建议手动跑一次。
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ── 后端：直接取 DEFAULT_PERMISSIONS 的 key ── */
const backend = require(path.join(ROOT, 'server/config/permissions.js'));
const backendKeys = Object.keys(backend.DEFAULT_PERMISSIONS || {}).sort();

/* ── 前端：定位 PERMISSIONS 对象块并抽取 action key ── */
const tsPath = path.join(ROOT, 'web/src/config/permissions.ts');
const src = fs.readFileSync(tsPath, 'utf8');
const start = src.indexOf('export const PERMISSIONS');
if (start < 0) {
  console.error('✗ 未在前端找到 `export const PERMISSIONS`');
  process.exit(1);
}
// 从 start 起按大括号配对，截出整个 PERMISSIONS 对象文本
const open = src.indexOf('{', start);
let depth = 0;
let ended = -1;
for (let i = open; i < src.length; i += 1) {
  const ch = src[i];
  if (ch === '{') depth += 1;
  else if (ch === '}') {
    depth -= 1;
    if (depth === 0) { ended = i; break; }
  }
}
const block = src.slice(open, ended + 1);
const re = /'([a-z][a-z0-9]*(?::[a-z0-9]+)+)':/g;
const feSet = new Set();
let m;
while ((m = re.exec(block))) feSet.add(m[1]);
const frontendKeys = Array.from(feSet).sort();

/* ── 比对 ── */
const bset = new Set(backendKeys);
const onlyBackend = backendKeys.filter((k) => !feSet.has(k));
const onlyFrontend = frontendKeys.filter((k) => !bset.has(k));

console.log('后端 DEFAULT_PERMISSIONS  action 数：' + backendKeys.length);
console.log('前端 PERMISSIONS           action 数：' + frontendKeys.length);

if (onlyBackend.length === 0 && onlyFrontend.length === 0) {
  console.log('\n✓ 两端 action key 集合完全一致');
  process.exit(0);
}
console.log('\n✗ 两端 action key 集合不一致：');
if (onlyBackend.length) console.log('  仅后端有（前端缺失）：\n    - ' + onlyBackend.join('\n    - '));
if (onlyFrontend.length) console.log('  仅前端有（后端缺失）：\n    - ' + onlyFrontend.join('\n    - '));
process.exit(1);
