// 検証: デバッグChrome(9222)に CDP で繋ぎ、430x860 で v2 を一周してスクショを撮る。
// 使い方: node scripts/verify.mjs [url]
import pw from 'file:///C:/Users/kooo4/KEI-Workshop/himari/materials-bot/node_modules/playwright-core/index.js';
const { chromium } = pw;
import fs from 'node:fs';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8123/page-flip-proto/app2/';
const OUT = 'D:/kei-work/2026-09-07_bookexp-rebuild/skeleton';
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = await browser.newContext({ viewport: { width: 430, height: 860 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

const bytes = [];
let phase = 'initial';
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
const urls = new Map();
cdp.on('Network.requestWillBeSent', p => urls.set(p.requestId, p.request.url));
cdp.on('Network.loadingFinished', p => bytes.push({ phase, len: p.encodedDataLength, url: urls.get(p.requestId) || '' }));

// Service Worker 経由の取得は CDP の Network に出ないので、ページ側の Resource Timing で測る
const measure = () => page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const rs = performance.getEntriesByType('resource');
  const total = (nav ? nav.transferSize : 0) + rs.reduce((a, r) => a + (r.transferSize || 0), 0);
  const top = rs.slice().sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0)).slice(0, 10)
    .map(r => [Math.round((r.transferSize || 0) / 1024) + 'KB', r.name.split('/').pop()]);
  return { total, count: rs.length, top };
});
const shot = async (name) => { await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('shot', name); };

// 計測は Service Worker を止めて行う（SW 経由の取得は transferSize が 0 になり測れない）
await page.route('**/registerSW.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
await page.route('**/sw.js', r => r.fulfill({ status: 404, body: '' }));
await page.goto(URL_, { waitUntil: 'load' });
// 前回の Service Worker / キャッシュを消してから測り直す
await page.evaluate(async () => {
  try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); } catch {}
  try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch {}
});
// 初期画面の縦3列を必ず全部出すため、栞1本とお気に入り1件を仕込む（2026-09-10）
await page.evaluate(() => {
  localStorage.setItem('bookexp-favs', JSON.stringify([3]));
  localStorage.setItem('bookexp-bookmark', JSON.stringify({ list: [{ deck: [1, 2, 3, 4, 5], index: 2, ts: Date.now(), fav: false }] }));
});
bytes.length = 0;
await page.reload({ waitUntil: 'load' });
await sleep(3500);
await shot('01-initial');           // 本だけ・ボタンなし

await sleep(3000);
await shot('02-hint');              // 5秒後の一文

// 初期画面のボタン配置を測る（縦3列・重なりが無いか・2026-09-10 KEI）
const layout = async (w, h) => {
  await page.setViewportSize({ width: w, height: h });
  await sleep(900);
  return page.evaluate(() => {
    const r = el => { if (!el || el.hidden) return null; const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
    const ids = ['bResume', 'bFav', 'bInfo'];
    const boxes = {}; ids.forEach(id => { boxes[id] = r(document.getElementById(id)); });
    const hint = r(document.getElementById('hint'));
    const top = Math.min(...ids.map(id => boxes[id] ? boxes[id].y : Infinity));
    // 本（3D）の画面上の当たり範囲を投影して測る
    let book = null;
    try {
      const sc = window.__app.scene, cam = sc.camera, obj = sc.book;
      const V3 = cam.position.constructor;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      obj.updateWorldMatrix(true, true);
      const put = (a, b, c, d) => { if (a < x0) x0 = a; if (b > x1) x1 = b; if (c < y0) y0 = c; if (d > y1) y1 = d; };
      obj.traverse(m => {
        const g = m.geometry; if (!m.isMesh || !g || !g.attributes || !g.attributes.position) return;
        if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox;
        let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
        for (let i = 0; i < 8; i++) {
          const v = new V3(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z);
          v.applyMatrix4(m.matrixWorld).project(cam);
          if (!isFinite(v.x) || !isFinite(v.y)) continue;
          const px = (v.x * 0.5 + 0.5) * innerWidth, py = (-v.y * 0.5 + 0.5) * innerHeight;
          if (px < a) a = px; if (px > b) b = px; if (py < c) c = py; if (py > d) d = py;
        }
        // 本体でない大物（画面いっぱいの塵・影の板など）は当たり範囲から外す
        if (b - a > innerWidth * 3 || d - c > innerHeight * 3) return;
        put(a, b, c, d);
      });
      book = { x: +x0.toFixed(1), y: +y0.toFixed(1), w: +(x1 - x0).toFixed(1), h: +(y1 - y0).toFixed(1), bottom: +y1.toFixed(1) };
    } catch (e) { book = { err: String(e).slice(0, 80) }; }
    return {
      vp: innerWidth + 'x' + innerHeight, boxes, hint, book,
      columnTop: top,
      hintOverlap: !!(hint && hint.bottom > top),
      bookOverlap: !!(book && book.bottom > top),
      gapHintToColumn: hint ? +(top - hint.bottom).toFixed(1) : null,
      gapBookToColumn: book && book.bottom ? +(top - book.bottom).toFixed(1) : null,
      uiPointerEvents: getComputedStyle(document.getElementById('ui')).pointerEvents,
    };
  });
};
const L430 = await layout(430, 860);
const L375 = await layout(375, 667);
console.log('layout430', JSON.stringify(L430));
console.log('layout375', JSON.stringify(L375));
await page.setViewportSize({ width: 430, height: 860 });
await sleep(600);

const cx = 215, cy = 430;
await page.mouse.click(cx, cy);
await sleep(900);
await shot('03-ui');                // 1タップ → 右上メニューボタン

const initial = await measure();   // 本の画面だけ（メニューを開く前）
await page.click('#bInfo');
await sleep(700);
await shot('04-menu');              // メニューパネル
await page.click('#menuClose');
await sleep(600);

const afterMenu = await measure();
phase = 'read';

// 全画面の要求を数える見張りを仕掛ける（headless/CDP の Chrome は全画面を断ることがある。
// その時でも「開く操作の中で requestFullscreen を呼んだか」だけは確かめられる・2026-09-09）
await page.evaluate(() => {
  window.__fsCalls = 0;
  const el = document.documentElement;
  const orig = el.requestFullscreen;
  if (orig) el.requestFullscreen = function (...a) { window.__fsCalls++; return orig.apply(this, a); };
});

// ダブルタップで開く
await page.mouse.click(cx, cy);
await sleep(120);
await page.mouse.click(cx, cy);
await sleep(600);
// 開く操作で自動的に全画面へ入ったか（ボタンは廃止・2026-09-09 KEI）
const fullscreen = await page.evaluate(() => ({
  element: !!(document.fullscreenElement || document.webkitFullscreenElement),
  requestCalls: window.__fsCalls || 0,
}));
console.log('fullscreen', JSON.stringify(fullscreen),
  fullscreen.element ? 'OK(全画面に入った)'
    : fullscreen.requestCalls > 0 ? 'OK(要求は出た。この Chrome が断った)' : 'NG(要求すら出ていない)');
await sleep(2400);
await shot('05-opening');           // 開く演出の途中
await sleep(5000);
await shot('06-read');              // 読書

// めくる（右から左へ）
await page.mouse.move(340, 430);
await page.mouse.down();
for (let i = 0; i < 12; i++) { await page.mouse.move(340 - i * 22, 430 + i * 2); await sleep(16); }
await page.mouse.up();
await sleep(1200);
await shot('07-flip');

// 印
await page.mouse.move(215, 800); await sleep(200);
await page.click('#favBtn'); await sleep(300); await page.click('#favBtn');
await sleep(900);
await shot('08-fav');
// 栞
await page.mouse.move(215, 800); await sleep(200);
await page.click('#favListBtn'); await sleep(300); await page.click('#favListBtn');
await sleep(1400);
await shot('09-bookmark');

const readDone = await measure();

// 戻る（UI が隠れている等で押せなくても、計測結果は必ず出す）
try {
  await page.mouse.move(215, 800); await sleep(200);
  await page.click('#backBtn', { timeout: 6000, force: true }); await sleep(300);
  await page.click('#backBtn', { timeout: 6000, force: true });
  await sleep(5000);
  await shot('10-back');
} catch (e) { console.log('back skipped:', e.message.split(String.fromCharCode(10))[0]); }

const dbg = await page.evaluate(() => ({ stage: window.__app.stage, reader: window.__app.reader, audio: window.__app.audio }));

console.log(JSON.stringify({
  initial, afterMenu, readDone, fullscreen, errors, dbg,
}, null, 2));

await page.close();
await ctx.close();
await browser.close();
