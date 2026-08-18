// scripts/b82_diag.mjs — 客观坐标诊断：多视口宽度下弹窗任务行布局
import { chromium } from 'playwright-core';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:5173';
const OPEN_ID = 'ou_xuwenbin01';
const WIDTHS = [700, 900, 1100, 1280];

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // 登录并准备项目（复用/新建）
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

  const projRes = await api('POST', '/api/projects', {
    name: 'B82诊断项目', type: 'A',
    planStart: '2026-08-01', planEnd: '2026-08-31', pm: OPEN_ID,
    members: [{ userOpenId: OPEN_ID, role: 'pm' }, { userOpenId: 'ou_liming03', role: 'tl' }],
    milestones: [{ code: 'M1', name: '碑1', target: 'T1', required: true, date: '2026-08-20' }],
  });
  const PID = projRes.data && (projRes.data.id || projRes.data.projectId);
  console.log('project:', PID);
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

    await page.screenshot({ path: 'pm-app/.cache/b82_diag_w' + W + '.png', fullPage: false });

    const rows = await page.evaluate(() => {
      const dialog = document.querySelector('.MuiDialog-paper') || document.body;
      const out = [];
      const cbs = Array.from(dialog.querySelectorAll('input[type="checkbox"]'));
      for (const cb of cbs) {
        // 定位任务 Box：checkbox 向上找含 ≥2 number input 的最近祖先
        let box = cb.parentElement;
        for (let i = 0; i < 8 && box; i += 1) {
          if (box.querySelectorAll('input[type="number"]').length >= 2) break;
          box = box.parentElement;
        }
        if (!box) continue;
        const nameEl = Array.from(box.querySelectorAll('p, span, h6')).find(e => /项目|子任务|碑/.test(e.textContent || ''));
        const nameRect = nameEl ? nameEl.getBoundingClientRect() : null;
        const inputs = Array.from(box.querySelectorAll('input[type="number"]'));
        const progressBar = Array.from(box.querySelectorAll('div')).find(d => (d.getBoundingClientRect().width === 90 && d.getBoundingClientRect().height <= 10));
        const cbRect = cb.getBoundingClientRect();
        out.push({
          name: (nameEl ? nameEl.textContent : '').slice(0, 30),
          checkbox: { x: Math.round(cbRect.x), y: Math.round(cbRect.y) },
          nameText: nameRect ? { x: Math.round(nameRect.x), y: Math.round(nameRect.y), w: Math.round(nameRect.width), h: Math.round(nameRect.height) } : null,
          inputs: inputs.map(i => {
            const r = i.getBoundingClientRect();
            const label = i.closest('.MuiFormControl-root') ? i.closest('.MuiFormControl-root').querySelector('label') : null;
            const lr = label ? label.getBoundingClientRect() : null;
            return {
              x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
              label: lr ? { text: label.textContent, x: Math.round(lr.x), y: Math.round(lr.y) } : null,
            };
          }),
          progress: progressBar ? (() => { const r = progressBar.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; })() : null,
        });
      }
      return out;
    });

    console.log('\n======== 视口宽度 ' + W + 'px ========');
    for (const r of rows) {
      console.log('任务"' + r.name + '"  checkbox(' + r.checkbox.x + ',' + r.checkbox.y + ') 名称(' + (r.nameText ? r.nameText.x + ',' + r.nameText.y : '无') + ') 进度条(' + (r.progress ? r.progress.x + ',' + r.progress.y + ' w=' + r.progress.w : '无') + ')');
      r.inputs.forEach((inp, i) => {
        console.log('  input' + (i + 1) + ': (' + inp.x + ',' + inp.y + ',w=' + inp.w + ',h=' + inp.h + ')  label=' + (inp.label ? '"' + inp.label.text + '"@(' + inp.label.x + ',' + inp.label.y + ')' : '无'));
      });
    }
    await ctx.close();
  }
  await browser.close();
})();