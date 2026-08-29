// 検証用: デバッグChrome(9222)で a/ を開き、表紙→開く→めくり途中 をスクショ
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 430, height: 800 });
  await page.goto('http://127.0.0.1:8321/a/', { waitUntil: 'load' });
  await sleep(2500);
  await page.screenshot({ path: '_t1_cover.png' });
  await page.mouse.click(215, 400);
  await sleep(2300);
  await page.screenshot({ path: '_t2_page.png' });
  // drag mid-flip and hold
  const cv = await page.$('#book');
  const box = await cv.boundingBox();
  const y = box.y + box.height * 0.5;
  await page.mouse.move(box.x + box.width * 0.9, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) { await page.mouse.move(box.x + box.width * (0.9 - i * 0.09), y); await sleep(40); }
  await sleep(200);
  await page.screenshot({ path: '_t3_midflip.png' });
  for (let i = 7; i <= 10; i++) { await page.mouse.move(box.x + box.width * (0.9 - i * 0.09), y); await sleep(40); }
  await page.mouse.up();
  await sleep(600);
  await page.screenshot({ path: '_t4_after.png' });
  await page.close();
  await browser.close().catch(() => {});
  console.log('OK');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
