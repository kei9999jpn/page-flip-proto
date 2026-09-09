// めくりの「カクカク」を数字で見るための計測（2026-09-09）
//   デバッグChrome(9222) に CDP でつなぎ、430x860・CPU 4倍遅く の条件で本を開き、
//   右上の角から左へなぞる「めくり」を 6 回。そのあいだの rAF の間隔(ms)だけを集める。
//   出力: mean / p95 / max と 33ms を超えたコマ数。
//
// 前提（落ちていたらこれを先に）:
//   Chrome: Start-Process -FilePath 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
//             -ArgumentList '--remote-debugging-port=9222','--user-data-dir=C:\Users\kooo4\KEI-Workshop\himari\midjourney-bot\chrome-profile','about:blank'
//   サーバ: cd D:/kei-tools && (python -m http.server 8123 >/dev/null 2>&1 &)
//
// 使い方: node v2/scripts/measure-flip.mjs [label] [url]
import pw from 'file:///C:/Users/kooo4/KEI-Workshop/himari/materials-bot/node_modules/playwright-core/index.js';
const { chromium } = pw;

const LABEL = process.argv[2] || 'run';
const URL_ = process.argv[3] || ('http://localhost:8123/page-flip-proto/app2/?v=' + Date.now());
const FLIPS = 6;
// 第4引数で CPU を絞る倍率を変えられる（4=既定。20 くらいまで上げると差が見える）
const THROTTLE = +(process.argv[4] || 4);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = await browser.newContext({ viewport: { width: 430, height: 860 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

// Service Worker は毎回止める（古い版を測らないため）
await page.route('**/registerSW.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
await page.route('**/sw.js', r => r.fulfill({ status: 404, body: '' }));
await page.goto(URL_, { waitUntil: 'load' });
await page.evaluate(async () => {
  try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); } catch { /* noop */ }
  try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch { /* noop */ }
});
await page.reload({ waitUntil: 'load' });

const cdp = await ctx.newCDPSession(page);

await sleep(5000);
await page.evaluate(() => window.__app.beginRead('read'));
await sleep(12000);                       // 開く演出 + 夜明け
const stage = await page.evaluate(() => window.__app.stage);
if (stage !== 'read') { console.log('本が開かなかった (stage=' + stage + ')'); process.exit(1); }

// rAF の刻みを拾うフック。ページ側で回しっぱなしにし、窓ごとに配列を取り出す
await page.evaluate(() => {
  window.__ft = [];
  const loop = t => { window.__ft.push(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
});
// 傾き（PCではマウス位置）を実際の読書と同じく動かした状態にしておく
await page.mouse.move(215, 430);
// 絞るのは「開く演出が終わってから」。演出中に絞ると開ききらないことがある
await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
await sleep(900);

const all = [];
const idx0 = await page.evaluate(() => window.__app.reader.index);
for (let i = 0; i < FLIPS; i++) {
  await page.evaluate(() => { window.__ft.length = 0; });
  // 右上の角から左へ。Reader は掴む角を固定しているので x のなぞりだけで決まる
  await page.mouse.move(380, 300);
  await page.mouse.down();
  for (let x = 380; x >= 80; x -= 30) { await page.mouse.move(x, 300); await sleep(16); }
  await page.mouse.up();
  await sleep(800);                       // 着地アニメが終わるまで
  const ts = await page.evaluate(() => window.__ft.slice());
  for (let k = 1; k < ts.length; k++) all.push(ts[k] - ts[k - 1]);
  await sleep(500);
}

all.sort((a, b) => a - b);
const n = all.length;
const mean = all.reduce((a, b) => a + b, 0) / n;
const p95 = all[Math.min(n - 1, Math.floor(n * 0.95))];
const max = all[n - 1];
const over = all.filter(v => v > 33).length;
const r = x => Math.round(x * 10) / 10;

const turned = (await page.evaluate(() => window.__app.reader.index)) - idx0;

console.log(JSON.stringify({
  label: LABEL, url: URL_, flips: FLIPS, turned, cpuThrottle: THROTTLE + 'x', frames: n,
  mean: r(mean), p95: r(p95), max: r(max), over33: over,
  over33pct: r(over / n * 100), errors: errors.slice(0, 5),
}, null, 2));

await page.close(); await ctx.close(); await browser.close();
