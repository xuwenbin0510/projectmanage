// scripts/b82_user_scenario_check.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:5173';
const OPEN_ID = 'ou_xuwenbin01';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1600 }, locale: 'zh-CN' });
  const page = await ctx.newPage();

  // 所有 API 在 page context 内调用（自动带 localStorage token）
  const api = async (method, path, body) => page.evaluate(async ({ m, p, b }) => {
    const token = localStorage.getItem('pm_token') || '';
    const res = await fetch(p, {
      method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { __raw: text.slice(0, 200) }; }
  }, { m: method, p: path, b: body });

  await page.goto(BASE + '/login');
  await page.waitForTimeout(500);
  const loginRes = await api('POST', '/api/auth/devlogin', { openId: OPEN_ID });
  console.log('login.code:', loginRes.code, 'token len:', (loginRes.data && loginRes.data.token || '').length);
  if (loginRes.data && loginRes.data.token) {
    await page.evaluate((t) => localStorage.setItem('pm_token', t), loginRes.data.token);
  }

  const projRes = await api('POST', '/api/projects', {
    name: 'B82用户场景复现', type: 'A',
    planStart: '2026-08-01', planEnd: '2026-08-31',
    pm: OPEN_ID,
    members: [
      { userOpenId: OPEN_ID, role: 'pm' },
      { userOpenId: 'ou_liming03', role: 'tl' },
    ],
    milestones: [
      { code: 'M1', name: '碑1', target: 'T1', required: true, date: '2026-08-20' },
      { code: 'M2', name: '碑2', target: 'T2', required: true, date: '2026-08-30' },
    ],
  });
  const PID = projRes.data && (projRes.data.id || projRes.data.projectId);
  console.log('project:', PID, 'code:', projRes.code);
  if (!PID) { console.log('建项目失败:', JSON.stringify(projRes).slice(0, 300)); await browser.close(); process.exit(1); }

  await page.waitForTimeout(500);
  const wbsRes = await api('GET', '/api/projects/' + PID + '/wbs');
  const nodes = (wbsRes.data) || [];
  console.log('骨架节点:', nodes.length);
  for (const n of nodes) {
    await api('PATCH', '/api/wbs/' + n.id, { owner: OPEN_ID, estimateDays: 5 });
  }
  for (const parent of nodes.slice(0, 3)) {
    for (let i = 1; i <= 2; i += 1) {
      await api('POST', '/api/projects/' + PID + '/wbs', {
        parentId: parent.id, name: '子任务' + i, nodeType: 'task',
        owner: OPEN_ID, estimateDays: 1, dueDate: '2026-08-01',
      });
    }
  }

  await page.goto(BASE + '/projects/' + PID + '/reports');
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /新建日志/ }).click();
  await page.waitForTimeout(1500);

  await page.screenshot({ path: 'pm-app/.cache/b82_user_scenario.png', fullPage: false });

  const geom = await page.evaluate(() => {
    const dialog = document.querySelector('.MuiDialog-paper') || document.body;
    const wbsCheckboxes = Array.from(dialog.querySelectorAll('input[type="checkbox"]'));
    const rows = [];
    for (const cb of wbsCheckboxes) {
      let box = cb.parentElement;
      for (let i = 0; i < 6 && box; i += 1) {
        if (box.querySelectorAll('input[type="number"]').length >= 2) break;
        box = box.parentElement;
      }
      if (!box) continue;
      const inputs = box.querySelectorAll('input[type="number"]');
      const boxRect = box.getBoundingClientRect();
      const taskName = Array.from(box.querySelectorAll('p, h6, span'))
        .map(e => e.textContent || '')
        .find(t => /项目|子任务|方案|碑|启动|子/.test(t)) || '';
      rows.push({
        taskName: taskName.slice(0, 60) || '(no text)',
        taskBox: { x: Math.round(boxRect.x), y: Math.round(boxRect.y), w: Math.round(boxRect.width), h: Math.round(boxRect.height) },
        inputs: Array.from(inputs).map(i => {
          const r = i.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        }),
        htmlPreview: box.outerHTML.slice(0, 400),
      });
    }
    return rows;
  });

  console.log('=== DOM 几何（每任务 Box）===');
  let issues = 0;
  for (const r of geom) {
    console.log('\nBox: "' + r.taskName + '" pos(' + r.taskBox.x + ',' + r.taskBox.y + ',w=' + r.taskBox.w + ',h=' + r.taskBox.h + ')');
    console.log('  html: ' + r.htmlPreview.replace(/\s+/g, ' ').slice(0, 350));
    r.inputs.forEach((i, idx) => {
      console.log('  input' + (idx + 1) + ': (' + i.x + ',' + i.y + ',w=' + i.w + ',h=' + i.h + ')');
    });
    if (r.taskBox.h < 70) { console.log('  ⚠ 任务 Box 高度 ' + r.taskBox.h + ' < 70'); issues += 1; }
    if (r.taskName === '(no text)') { console.log('  ⚠ 任务名未找到'); issues += 1; }
    if (r.inputs.length >= 2) {
      if (Math.abs(r.inputs[0].y - r.inputs[1].y) > 10) {
        console.log('  ⚠ 两 input y 差 ' + Math.abs(r.inputs[0].y - r.inputs[1].y) + ' > 10'); issues += 1;
      }
      if (r.inputs[0].y - r.taskBox.y < 5) {
        console.log('  ⚠ 第一个 input y 紧贴任务 Box 顶部'); issues += 1;
      }
    }
  }
  console.log('\n总问题数: ' + issues);
  await browser.close();
  process.exit(issues > 0 ? 1 : 0);
})();