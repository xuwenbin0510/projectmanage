// scripts/b83_diag.mjs — B8.3 单行布局真验证：多视口下断言每个任务行 6 元素同行 + 坐标顺序 + 无溢出
// 用法：node scripts/b83_diag.mjs [BASE]   （默认 http://127.0.0.1:3311，即 Express 托管 built dist + API）
// 退出码：0 = 全绿；1 = 有断言失败
import { chromium } from 'playwright-core';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = (process.argv[2] || process.env.SMOKE_BASE || 'http://127.0.0.1:3311').replace(/\/$/, '');
const OPEN_ID = 'ou_xuwenbin01';
const WIDTHS = [700, 900, 1100, 1280];
// 截图存 .cache/b83_dialog_w{W}.png（与 b82 截图同目录，路径相对脚本位置解析）
const SHOT_DIR = path.resolve(ROOT, '.cache');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label, detail) {
  if (cond) {
    passed += 1;
    console.log('  \u2713 ' + label);
  } else {
    failed += 1;
    const line = label + (detail === undefined ? '' : '  → ' + JSON.stringify(detail));
    failures.push(line);
    console.log('  \u2717 ' + line);
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // 登录并准备项目（复用/新建）：项目 + WBS 骨架 + 前两个父节点各建 2 个子任务
  const ctx0 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page0 = await ctx0.newPage();
  await page0.goto(BASE + '/login');
  await page0.waitForTimeout(400);
  await page0.evaluate(async (openId) => {
    const r = await fetch('/api/auth/devlogin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openId }),
    });
    const j = await r.json();
    if (j.data && j.data.token) localStorage.setItem('pm_token', j.data.token);
  }, OPEN_ID);

  const api = (m, p, b) => page0.evaluate(async ({ mm, pp, bb }) => {
    const t = localStorage.getItem('pm_token') || '';
    const res = await fetch(pp, {
      method: mm, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
      body: bb === undefined ? undefined : JSON.stringify(bb),
    });
    return res.json();
  }, { mm: m, pp: p, bb: b });

  const stamp = Date.now();
  const projRes = await api('POST', '/api/projects', {
    name: 'B83单行布局 ' + stamp, type: 'A',
    planStart: '2026-08-01', planEnd: '2026-08-31', pm: OPEN_ID,
    members: [{ userOpenId: OPEN_ID, role: 'pm' }, { userOpenId: 'ou_liming03', role: 'tl' }],
    milestones: [{ code: 'M1', name: '碑1', target: 'T1', required: true, date: '2026-08-20' }],
  });
  const PID = projRes.data && (projRes.data.id || projRes.data.projectId);
  console.log('project:', PID, 'code:', projRes.code);
  if (!PID) { console.log('建项目失败:', JSON.stringify(projRes).slice(0, 300)); await browser.close(); process.exit(1); }
  const nodes = (await api('GET', '/api/projects/' + PID + '/wbs')).data || [];
  for (const n of nodes) {
    await api('PATCH', '/api/wbs/' + n.id, { owner: OPEN_ID, estimateDays: 5 });
  }
  for (const parent of nodes.slice(0, 2)) {
    for (let i = 1; i <= 2; i += 1) {
      await api('POST', '/api/projects/' + PID + '/wbs', {
        parentId: parent.id, name: '子任务' + i, nodeType: 'task',
        owner: OPEN_ID, estimateDays: 1, dueDate: '2026-08-01',
      });
    }
  }
  await ctx0.close();

  const coordRows = {}; // 供回传汇总：{ [W]: [{name, y: {...}}] }

  for (const W of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: W, height: 900 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/login');
    await page.waitForTimeout(400);
    await page.evaluate(async (openId) => {
      const r = await fetch('/api/auth/devlogin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openId }),
      });
      const j = await r.json();
      if (j.data && j.data.token) localStorage.setItem('pm_token', j.data.token);
    }, OPEN_ID);
    await page.goto(BASE + '/projects/' + PID + '/reports');
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /新建日志/ }).click();
    await page.waitForTimeout(1000);

    await page.screenshot({ path: SHOT_DIR + '/b83_dialog_w' + W + '.png', fullPage: false });

    const data = await page.evaluate(() => {
      const dialog = document.querySelector('.MuiDialog-paper');
      if (!dialog) return { error: 'no .MuiDialog-paper', rows: [], overflow: null, paperW: 0 };
      const paper = dialog.getBoundingClientRect();
      // 横向溢出：弹窗纸面内容区 scrollWidth vs clientWidth
      const overflow = { scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth };
      const rows = [];
      const cbs = Array.from(dialog.querySelectorAll('input[type="checkbox"]'));
      for (const cb of cbs) {
        // 定位任务行 Stack：checkbox 向上找含 ≥2 number input 的最近祖先
        let box = cb.parentElement;
        for (let i = 0; i < 10 && box; i += 1) {
          if (box.querySelectorAll('input[type="number"]').length >= 2) break;
          box = box.parentElement;
        }
        if (!box) continue;
        const nameEl = Array.from(box.querySelectorAll('p, span, h6')).find(e => /项目|子任务|碑/.test(e.textContent || ''));
        const nameRect = nameEl ? nameEl.getBoundingClientRect() : null;
        const inputs = Array.from(box.querySelectorAll('input[type="number"]'));
        const progressBar = Array.from(box.querySelectorAll('div')).find(d => {
          const r = d.getBoundingClientRect();
          return Math.round(r.width) === 90 && r.height <= 10 && r.width > 0;
        });
        const cbRect = cb.getBoundingClientRect();
        // 完成进度(%) 与 本周实际工时 用 form-control 根节点（视觉对齐代表）取 rect，
        // 否则内嵌 input 因 label 占位会导致 y 偏移，无法与 checkbox(16px) 同行比较
        const inputRects = inputs.map(i => {
          const root = i.closest('.MuiFormControl-root') || i;
          const r = root.getBoundingClientRect();
          const label = root.querySelector('label');
          const lr = label ? label.getBoundingClientRect() : null;
          return {
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
            label: lr ? lr.textContent : null,
          };
        });
        const progressRect = progressBar ? progressBar.getBoundingClientRect() : null;
        rows.push({
          name: (nameEl ? nameEl.textContent : '').slice(0, 40),
          nameText: nameEl ? nameEl.textContent : '',
          // 每元素额外记 h —— "同一行"用 centerY(=y+h/2)比较，避免不同高度元素 topY 误判
          checkbox: { x: Math.round(cbRect.x), y: Math.round(cbRect.y), h: Math.round(cbRect.height) },
          nameRect: nameRect ? { x: Math.round(nameRect.x), y: Math.round(nameRect.y), w: Math.round(nameRect.width), h: Math.round(nameRect.height) } : null,
          progress: progressRect ? { x: Math.round(progressRect.x), y: Math.round(progressRect.y), w: Math.round(progressRect.width), h: Math.round(progressRect.height) } : null,
          inputs: inputRects,
        });
      }
      return { rows, overflow, paperW: Math.round(paper.width) };
    });

    if (data.error) {
      assert(false, 'W=' + W + ' 找到弹窗纸面', data.error);
      coordRows[W] = [];
      await ctx.close();
      continue;
    }

    console.log('\n======== 视口宽度 ' + W + 'px（弹窗纸面宽 ' + data.paperW + 'px）========');
    coordRows[W] = data.rows.map(r => ({
      name: r.name,
      y: {
        checkbox: r.checkbox.y,
        name: r.nameRect ? r.nameRect.y : null,
        progress: r.progress ? r.progress.y : null,
        input1: r.inputs[0] ? r.inputs[0].y : null,
        input2: r.inputs[1] ? r.inputs[1].y : null,
      },
      x: {
        progress: r.progress ? r.progress.x : null,
        input1: r.inputs[0] ? r.inputs[0].x : null,
        input2: r.inputs[1] ? r.inputs[1].x : null,
      },
    }));

    assert(data.rows.length >= 1, 'W=' + W + ' 找到 ' + data.rows.length + ' 个任务行（≥1）', data.rows.length);
    assert(data.overflow.scrollWidth <= data.overflow.clientWidth, 'W=' + W + ' 无横向溢出 scrollWidth=' + data.overflow.scrollWidth + ' ≤ clientWidth=' + data.overflow.clientWidth, data.overflow);

    for (let i = 0; i < data.rows.length; i += 1) {
      const r = data.rows[i];
      const tag = 'W=' + W + ' 行' + (i + 1) + '「' + r.name + '」';
      // 元素齐全
      assert(r.checkbox && r.nameRect && r.progress && r.inputs.length === 2, tag + ' 5 元素齐全（checkbox/名称/进度条/2输入）', { hasCheckbox: !!r.checkbox, hasName: !!r.nameRect, hasProgress: !!r.progress, inputs: r.inputs.length });
      if (!r.checkbox || !r.nameRect || !r.progress || r.inputs.length !== 2) continue;
      // "同一行"用 centerY 比较（不同高度元素的 topY 天然差异，centerY 才是视觉同行判据）
      const centers = [r.checkbox.y + r.checkbox.h / 2, r.nameRect.y + r.nameRect.h / 2, r.progress.y + r.progress.h / 2, r.inputs[0].y + r.inputs[0].h / 2, r.inputs[1].y + r.inputs[1].h / 2];
      const tops = [r.checkbox.y, r.nameRect.y, r.progress.y, r.inputs[0].y, r.inputs[1].y];
      const cMax = Math.max(...centers), cMin = Math.min(...centers);
      // 同一行：5 元素 centerY 差 ≤10
      assert(cMax - cMin <= 10, tag + ' 5 元素同行（centerY 差=' + (cMax - cMin).toFixed(1) + ' ≤10）', { tops, centers: centers.map(c => Math.round(c * 10) / 10) });
      // 完成进度 input.x > 进度条.x（紧接进度条右侧）
      assert(r.inputs[0].x > r.progress.x, tag + ' 完成进度 input.x(' + r.inputs[0].x + ') > 进度条.x(' + r.progress.x + ')', { input1x: r.inputs[0].x, progressX: r.progress.x });
      // 实际工时 input.x > 完成进度 input.x（并排）
      assert(r.inputs[1].x > r.inputs[0].x, tag + ' 实际工时 input.x(' + r.inputs[1].x + ') > 完成进度 input.x(' + r.inputs[0].x + ')', { input2x: r.inputs[1].x, input1x: r.inputs[0].x });
      // 两 input 平行（centerY 差 ≤10）
      const ic = [r.inputs[0].y + r.inputs[0].h / 2, r.inputs[1].y + r.inputs[1].h / 2];
      assert(Math.abs(ic[0] - ic[1]) <= 10, tag + ' 两输入平行（centerY 差=' + Math.abs(ic[0] - ic[1]).toFixed(1) + ' ≤10）', { c1: ic[0], c2: ic[1] });
      // 任务名不省略到空（有文字）
      assert(r.nameText.trim().length > 0, tag + ' 任务名非空', r.nameText);
    }
    await ctx.close();
  }

  await browser.close();

  console.log('\n══════════════════════════════════════');
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  if (failed) {
    console.log('\n失败明细：');
    failures.forEach(f => console.log('  - ' + f));
  }
  console.log('坐标汇总：');
  for (const W of WIDTHS) {
    console.log('  W=' + W + ': ' + JSON.stringify(coordRows[W]));
  }
  console.log(failed === 0 ? 'IS_PASS: YES' : 'IS_PASS: NO');
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('脚本异常：', e); process.exit(1); });
