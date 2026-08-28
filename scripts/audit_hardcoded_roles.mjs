// 角色硬编码审计脚本 —— 机械扫描全仓库所有角色字面量出现位置，
// 输出完整清单（不靠人记忆/抽样），用于每次权限改动后的"是否改全"对照。
//
// 用法: node scripts/audit_hardcoded_roles.mjs [--json]
//
// 设计要点:
//  1. 扫描 server/ 与 web/src/ 下所有 .js/.ts/.tsx（排除 node_modules/dist/build）。
//  2. 匹配常见角色字面量: admin pmo pm cto cho cpo management tl dev hr finance member guest。
//  3. 输出 文件:行号 | 命中角色 | 所在代码行。
//  4. 不在此做"是否门禁"的自动判定（那需语义理解），只保证"全量列出"，
//     逐条定性由人工写入 docs/hardcoded-roles-audit.md 跟踪。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROLES = ['admin', 'pmo', 'pm', 'cto', 'cho', 'cpo', 'management', 'tl', 'dev', 'hr', 'finance', 'member', 'guest'];
const ROLE_RE = new RegExp(`['"\`](${ROLES.join('|')})['"\`]`, 'g');
const SCAN_DIRS = ['server', 'web/src'];
const SKIP = /node_modules|dist|\.git|build/i;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|cjs|mjs|ts|tsx)$/.test(e.name)) out.push(p);
  }
}

const files = [];
for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);

const hits = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const m = line.match(ROLE_RE);
    if (m) hits.push({ file: path.relative(ROOT, f), line: i + 1, roles: m.map((x) => x.slice(1, -1)), text: line.trim() });
  });
}

hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(hits, null, 2));
} else {
  console.log(`# 角色硬编码全量扫描 (${hits.length} 处)\n`);
  let cur = '';
  for (const h of hits) {
    if (h.file !== cur) {
      cur = h.file;
      console.log(`\n## ${cur}`);
    }
    console.log(`  L${h.line}  [${h.roles.join(',')}]  ${h.text.slice(0, 140)}`);
  }
}
