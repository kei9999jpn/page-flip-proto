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
bytes.length = 0;
await page.reload({ waitUntil: 'load' });
await sleep(3500);
await shot('01-initial');           // 本だけ・ボタンなし

await sleep(3000);
await shot('02-hint');              // 5秒後の一文

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
