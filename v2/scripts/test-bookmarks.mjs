// 栞の複数化と「外しても閉じない」の自動テスト（2026-09-09）
// 使い方: node v2/scripts/test-bookmarks.mjs [url]   ※デバッグChrome 9222 が必要
import pw from 'file:///C:/Users/kooo4/KEI-Workshop/himari/materials-bot/node_modules/playwright-core/index.js';
const { chromium } = pw;

const URL_ = process.argv[2] || 'http://127.0.0.1:8123/page-flip-proto/app2/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails.push(msg); };

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = await browser.newContext({ viewport: { width: 430, height: 860 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.route('**/registerSW.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
await page.route('**/sw.js', r => r.fulfill({ status: 404, body: '' }));
await page.goto(URL_, { waitUntil: 'load' });
await page.evaluate(async () => {
  try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); } catch { /* noop */ }
  try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch { /* noop */ }
  localStorage.removeItem('bookexp-bookmark');
  localStorage.removeItem('bookexp-favs');
});
await page.reload({ waitUntil: 'load' });
await sleep(4000);

// 本を開く
await page.evaluate(() => window.__app.beginRead('read'));
await sleep(9000);   // 開く演出 + dawn（ボタンが出るまで）
ok(await page.evaluate(() => window.__app.stage) === 'read', '本が開いた（stage=read）');

// 栞ボタンを押す。UIが眠っていると1回目は起こすだけなので、効くまで最大3回試す
const marks = () => page.evaluate(() => {
  try {
    const raw = JSON.parse(localStorage.getItem('bookexp-bookmark') || 'null');
    const list = !raw ? [] : Array.isArray(raw) ? raw : Array.isArray(raw.list) ? raw.list : [raw];
    return list.map(b => b.deck[b.index]);
  } catch { return []; }
});
async function tapBookmark(want) {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => document.getElementById('favListBtn').click());
    await sleep(900);
    if ((await marks()).length === want) return true;
  }
  return false;
}
// 3ページ目まで進む（右端から左へなぞる = 次のページ）
async function flip(n) {
  for (let i = 0; i < n; i++) {
    await page.mouse.move(360, 430); await page.mouse.down();
    for (let x = 360; x >= 90; x -= 45) { await page.mouse.move(x, 430); await sleep(30); }
    await page.mouse.up(); await sleep(1400);
  }
}
await flip(2);
const p3 = await page.evaluate(() => window.__app.reader.index);
ok(p3 === 2, '3ページ目に進んだ（index=' + p3 + '）');

ok(await tapBookmark(1), '3ページ目に栞を挟んだ');
const first = (await marks())[0];
ok(await page.evaluate(() => window.__app.stage) === 'read', '栞を挟んでも本は開いたまま');

await flip(2);
ok(await tapBookmark(2), '2枚めくった先に2本目の栞を挟んだ（栞が2本）');
ok(await page.evaluate(() => window.__app.stage) === 'read', '2本目を挟んでも本は開いたまま');

// 1本目のページへ戻って、その栞だけを外す
async function flipBack(n) {
  for (let i = 0; i < n; i++) {
    await page.mouse.move(70, 430); await page.mouse.down();
    for (let x = 70; x <= 340; x += 45) { await page.mouse.move(x, 430); await sleep(30); }
    await page.mouse.up(); await sleep(1400);
  }
}
await flipBack(2);
ok(await page.evaluate(() => window.__app.reader.index) === 2, '1本目の栞のページへ戻った');
ok(await tapBookmark(1), '1本目の栞だけを外した');

await sleep(2500);   // 旧版はここで本が閉じていた（予約 closeBook 1400ms）
const stage = await page.evaluate(() => window.__app.stage);
ok(stage === 'read', '栞を外しても本は閉じない（stage=' + stage + '）');
const left = await marks();
ok(left.length === 1, '栞は1本だけ残っている（' + left.length + '本）');
ok(left[0] !== first, '残ったのは2本目の栞（外したのは1本目）');
ok(errors.length === 0, 'コンソールエラー 0（' + errors.length + '）');
if (errors.length) console.log(errors.slice(0, 5));

console.log(fails.length ? '\nRESULT: FAIL (' + fails.length + ')' : '\nRESULT: PASS');
await page.close(); await ctx.close(); await browser.close();
process.exit(fails.length ? 1 : 0);
