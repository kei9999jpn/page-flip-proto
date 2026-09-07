// 検証: 開く演出（Phase 3）と読書画面の物質感（Phase 4）。
// 開く演出の3コマはスクショが演出を邪魔しないよう、1回のロードにつき1枚だけ撮る。
// 使い方: node scripts/verify-phase34.mjs [url]
import pw from 'file:///C:/Users/kooo4/KEI-Workshop/himari/materials-bot/node_modules/playwright-core/index.js';
const { chromium } = pw;
import fs from 'node:fs';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8123/page-flip-proto/app2/';
const OUT = 'D:/kei-work/2026-09-07_bookexp-rebuild/phase34';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [];

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = await browser.newContext({ viewport: { width: 430, height: 860 }, deviceScaleFactor: 2 });

async function fresh() {
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.route('**/registerSW.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route('**/sw.js', r => r.fulfill({ status: 404, body: '' }));
  await page.goto(URL_, { waitUntil: 'load' });
  await page.evaluate(async () => {
    try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); } catch {}
    try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch {}
  });
  await sleep(3200);
  return page;
}

// ---- 開く演出の3コマ（1ロード1枚） ----
for (const [name, at] of [['01-open-gild', 620], ['02-open-flood', 1520], ['03-open-dive', 2180]]) {
  const page = await fresh();
  await page.evaluate(ms => { setTimeout(() => { window.__mark = 1; }, ms); window.__app.beginRead('read'); }, at);
  await page.waitForFunction(() => window.__mark === 1, null, { timeout: 8000 });
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  console.log('shot', name);
  await page.close();
}

// ---- 本の画面・読書画面・印の光・FPS ----
const page = await fresh();
const cdp = await ctx.newCDPSession(page);
const fps = async label => {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const v = await page.evaluate(() => new Promise(res => {
    let n = 0; const t0 = performance.now();
    const step = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(step); else res(n / ((performance.now() - t0) / 1000)); };
    requestAnimationFrame(step);
  }));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  console.log('FPS(CPU 4倍スロットル)', label, v.toFixed(1));
  return v;
};
await page.screenshot({ path: path.join(OUT, '00-book.png') });
const fps3d = await fps('3D画面');
await page.evaluate(() => window.__app.beginRead('read'));
await sleep(4200);
await page.screenshot({ path: path.join(OUT, '04-read.png') });
const info = await page.evaluate(() => ({
  stage: window.__app.stage,
  snap: !!document.querySelector('#reader #bg.snap'),
  titleCard: !!document.getElementById('readTitle'),
  tilt: getComputedStyle(document.getElementById('book')).transform,
}));
const fpsRead = await fps('読書画面');
// 印を押すと金の光が縁を一周する（1回目のタップは沈んだUIを起こすだけ）
await page.evaluate(() => document.getElementById('favBtn').click());
await sleep(600);
await page.evaluate(() => document.getElementById('favBtn').click());
for (const [n, ms] of [['05-seal-run-a', 90], ['05-seal-run-b', 260], ['05-seal-run-c', 300]]) {
  await sleep(ms); await page.screenshot({ path: path.join(OUT, n + '.png') }); console.log('shot', n);
}
await sleep(900); await page.screenshot({ path: path.join(OUT, '06-read-sealed.png') });
console.log(info);
console.log('FPS 3D =', fps3d.toFixed(1), '/ 読書 =', fpsRead.toFixed(1));
console.log('console errors:', errors.length, errors.slice(0, 8));
await page.close(); await ctx.close();
process.exit(0);
