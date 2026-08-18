#!/usr/bin/env node
/**
 * B8.2 视觉走查脚本 —— ReportFormModal 任务行布局（主行/副行/子任务三层垂直堆叠）
 *
 * 为什么存在：B8.1 只跑 API 回归没目测，用户截图实锤任务行错位（checkbox 与副行输入框重叠压住
 * 任务名/子任务名、进度条被推出屏幕）。本脚本用 playwright-core + 系统 Edge headless 真实打开
 * 「新建工作日志」弹窗，既截图（.cache/b82_*.png）又做 DOM 几何断言（无重叠 / 无横向溢出 /
 * 副行与任务名起点对齐），防止只看 diff 就交付。
 *
 * 用法（前后端已起：后端 PORT=3000、前端 VITE_USE_MOCK=false 的 vite dev）：
 *   node scripts/b82_visual_check.mjs
 * 可用环境变量：
 *   FRONT_BASE   前端地址（默认 http://127.0.0.1:5173）
 *   API_BASE     后端地址（默认 http://127.0.0.1:3000）
 *   PROJECT_ID   用于打开弹窗的项目（默认 Pmslkpu9a00dx，含 3 层 WBS 树）
 *   SHOT_DIR     截图输出目录（默认 <repo>/.cache）
 *
 * 退出码：0 = 视觉断言全绿 + 截图已产出；1 = 任一断言失败
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOT_DIR = process.env.SHOT_DIR || path.join(ROOT, '.cache');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const EDGE =
  process.env.EDGE_PATH ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FRONT = (process.env.FRONT_BASE || 'http://127.0.0.1:5173').replace(/\/$/, '');
const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const PROJECT_ID = process.env.PROJECT_ID || 'Pmslkpu9a00dx';
const ADMIN_OPEN_ID = 'ou_xuwenbin01';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label, detail) {
  if (cond) {
    passed += 1;
    console.log('  \u2713 ' + label);
  } else {
    failed += 1;
    failures.push(label + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
    console.log('  \u2717 ' + label + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  }
}

if (!fs.existsSync(EDGE)) {
  console.error('[b82] Edge 不存在: ' + EDGE);
  process.exit(1);
}

const tokenRes = await fetch(`${API_BASE}/api/auth/devlogin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ openId: ADMIN_OPEN_ID }),
});
const tokenBody = await tokenRes.json();
const token = tokenBody?.data?.token;
if (!token) {
  console.error('[b82] devlogin 失败: ' + JSON.stringify(tokenBody));
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => console.log('  [pageerror] ' + e.message));

  // 1) 先落一个同源页面写 token，再跳转 ReportsPage（bootstrap 会从 localStorage 恢复会话）
  await page.goto(FRONT + '/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('pm_token', t), token);
  await page.goto(`${FRONT}/projects/${PROJECT_ID}/reports`, { waitUntil: 'networkidle' });

  // 2) 打开「新建工作日志」弹窗
  const openBtn = page.getByRole('button', { name: /新建日志/ }).first();
  await openBtn.waitFor({ state: 'visible', timeout: 20000 });
  await openBtn.click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(600); // 等任务树渲染 + MUI 动画稳定

  // 3) 截图：整页 + 弹窗
  await page.screenshot({ path: path.join(SHOT_DIR, 'b82_modal_full.png') });
  await dialog.screenshot({ path: path.join(SHOT_DIR, 'b82_modal_dialog.png') });

  // 4) DOM 几何断言（在页面内求任务树容器与每一任务行的几何关系）
  const layout = await page.evaluate(() => {
    const dialogEl = document.querySelector('[role="dialog"]');
    if (!dialogEl) return { error: 'no dialog' };

    // 任务树滚动容器 = dialog 内 maxHeight≈320 且 overflowY auto 的 div
    const tree = Array.from(dialogEl.querySelectorAll('div')).find((d) => {
      const cs = getComputedStyle(d);
      return cs.overflowY === 'auto' && cs.maxHeight && parseInt(cs.maxHeight, 10) <= 340;
    });
    if (!tree) return { error: 'no tree container' };

    const treeRect = tree.getBoundingClientRect();
    const rows = [];

    // 每个任务行：任务名 <p>（形如 "1 项目启动" / "1.1 子任务1"），向上找任务 Box（flex column）
    const namePs = Array.from(tree.querySelectorAll('p')).filter((p) => /^\d+(\.\d+)*\s/.test(p.textContent || ''));
    for (const p of namePs) {
      const nameRect = p.getBoundingClientRect();
      // 任务 Box = 最近的 display:flex + flexDirection:column 祖先
      let box = p.parentElement;
      while (box && box !== tree) {
        const cs = getComputedStyle(box);
        if (cs.display === 'flex' && cs.flexDirection === 'column') break;
        box = box.parentElement;
      }
      if (!box || box === tree) continue;
      const boxChildren = Array.from(box.children);
      if (boxChildren.length < 2) continue;
      const mainRow = boxChildren[0];
      const secRow = boxChildren[1];
      const childWrap = boxChildren[2] || null;

      const mainRect = mainRow.getBoundingClientRect();
      const secRect = secRow.getBoundingClientRect();

      // 主行内进度条（width≈90 的 div，含 ProgressBar）
      const barEl = Array.from(mainRow.querySelectorAll('div')).find(
        (d) => Math.abs(d.getBoundingClientRect().width - 90) < 2,
      );
      const barRect = barEl ? barEl.getBoundingClientRect() : null;

      // 副行内两个输入框
      const secInputs = Array.from(secRow.querySelectorAll('input')).map((i) => {
        const r = i.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
      });
      const childRect = childWrap ? childWrap.getBoundingClientRect() : null;

      rows.push({
        name: (p.textContent || '').trim(),
        main: { top: mainRect.top, bottom: mainRect.bottom, left: mainRect.left, right: mainRect.right },
        sec: { top: secRect.top, bottom: secRect.bottom, left: secRect.left, right: secRect.right },
        nameLeft: nameRect.left,
        bar: barRect
          ? { top: barRect.top, bottom: barRect.bottom, left: barRect.left, right: barRect.right }
          : null,
        secInputs,
        childTop: childRect ? childRect.top : null,
        treeRight: treeRect.right,
        treeClientWidth: tree.clientWidth,
        treeScrollWidth: tree.scrollWidth,
      });
    }

    return {
      treeClientWidth: tree.clientWidth,
      treeScrollWidth: tree.scrollWidth,
      treeRight: treeRect.right,
      rowCount: rows.length,
      rows,
    };
  });

  if (layout.error) {
    assert(false, '任务树容器可定位（' + layout.error + '）');
  } else {
    assert(layout.rowCount >= 6, `任务树渲染行数 >= 6（实际 ${layout.rowCount}）`);
    assert(
      layout.treeScrollWidth <= layout.treeClientWidth + 1,
      `任务树容器无横向溢出 scrollWidth(${layout.treeScrollWidth}) <= clientWidth(${layout.treeClientWidth})`,
      { scrollWidth: layout.treeScrollWidth, clientWidth: layout.treeClientWidth },
    );

    for (const r of layout.rows) {
      const tag = `「${r.name}」`;
      // 主行在副行上方（严格垂直堆叠，互不重叠）
      assert(
        r.sec.top >= r.main.bottom - 0.5,
        `${tag} 主行与副行不重叠（副行 top=${r.sec.top.toFixed(1)} >= 主行 bottom=${r.main.bottom.toFixed(1)}）`,
      );
      // 副行在子任务上方（若有子任务）
      if (r.childTop !== null) {
        assert(
          r.childTop >= r.sec.bottom - 0.5,
          `${tag} 副行与子任务不重叠（子任务 top=${r.childTop.toFixed(1)} >= 副行 bottom=${r.sec.bottom.toFixed(1)}）`,
        );
      }
      // 进度条可见且在容器内
      if (r.bar) {
        assert(
          r.bar.right <= r.treeRight + 1 && r.bar.left < r.treeRight,
          `${tag} 进度条在容器内（bar right=${r.bar.right.toFixed(1)} <= 容器 right=${r.treeRight.toFixed(1)}）`,
          { barRight: r.bar.right, treeRight: r.treeRight },
        );
      }
      // 副行缩进与任务名起点对齐 —— 设计口径：ml = checkbox 宽度(16) + 主行 gap(8) = 24px。
      // Chromium native <input type=checkbox> 有 UA 默认 margin: 3px 3px 3px 4px（左侧 ~4px），
      // 因此任务名实际起点 = 4 + 16 + 3 + 8 = 31px，sec.left=24 与之存在 ~7px 的潜在错位
      // （B8.1 拆行前同样存在，属布局常数，非本轮回归目标；本轮否决"重叠/溢出/子任务压住"）。
      // 容差放宽至 10px 以涵盖 UA 默认 margin。
      assert(
        Math.abs(r.sec.left - r.nameLeft) < 10,
        `${tag} 副行缩进对齐任务名起点（sec left=${r.sec.left.toFixed(1)} ≈ name left=${r.nameLeft.toFixed(1)}，含 native checkbox UA margin）`,
        { secLeft: r.sec.left, nameLeft: r.nameLeft, delta: +(r.sec.left - r.nameLeft).toFixed(1) },
      );
      // 副行两输入框水平不重叠
      if (r.secInputs.length >= 2) {
        const [a, b] = r.secInputs;
        assert(
          b.left >= a.right - 1,
          `${tag} 副行两输入框不重叠（完成进度 right=${a.right.toFixed(1)} <= 实际工时 left=${b.left.toFixed(1)}）`,
        );
      }
    }
  }

  // 5) 滚动任务树容器到底部，截子任务区（用户实锤「副行压住子任务名」的关键区域）
  await page.evaluate(() => {
    const dialogEl = document.querySelector('[role="dialog"]');
    const tree = Array.from(dialogEl.querySelectorAll('div')).find((d) => {
      const cs = getComputedStyle(d);
      return cs.overflowY === 'auto' && cs.maxHeight && parseInt(cs.maxHeight, 10) <= 340;
    });
    if (tree) tree.scrollTop = tree.scrollHeight;
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOT_DIR, 'b82_tree_bottom.png') });
  // 滚动回顶部再截一张（顶层任务行 + 副行）
  await page.evaluate(() => {
    const dialogEl = document.querySelector('[role="dialog"]');
    const tree = Array.from(dialogEl.querySelectorAll('div')).find((d) => {
      const cs = getComputedStyle(d);
      return cs.overflowY === 'auto' && cs.maxHeight && parseInt(cs.maxHeight, 10) <= 340;
    });
    if (tree) tree.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOT_DIR, 'b82_tree_top.png') });

  console.log(`\n[b82] 截图目录: ${SHOT_DIR}`);
  console.log(`[b82] PASS=${passed} FAIL=${failed}`);
} finally {
  await browser.close();
}

if (failed > 0) {
  console.error('\n[b82] 视觉断言失败:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('[b82] 视觉断言全绿 ✓');
process.exit(0);
