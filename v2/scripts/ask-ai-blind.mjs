import pw from 'file:///C:/Users/kooo4/KEI-Workshop/himari/materials-bot/node_modules/playwright-core/index.js';
import fs from 'node:fs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = 'D:/kei-work/2026-09-07_bookexp-rebuild/ai-advice/';
const prompt = fs.readFileSync(OUT + 'prompt.txt', 'utf8');
const which = process.argv[2];
const cfg = {
  chatgpt: { url: 'https://chatgpt.com/', editor: '#prompt-textarea', answer: '[data-message-author-role="assistant"]' },
  claude:  { url: 'https://claude.ai/new', editor: 'div.ProseMirror', answer: '[data-is-streaming], .font-claude-response, .font-claude-message' },
  gemini:  { url: 'https://gemini.google.com/app', editor: 'div.ql-editor', answer: 'message-content, .model-response-text' },
}[which];
const b = await pw.chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = b.contexts()[0];
const page = await ctx.newPage();
await page.goto(cfg.url, { waitUntil: 'domcontentloaded' }); await sleep(4000);
const ed = await page.waitForSelector(cfg.editor, { timeout: 20000 });
await ed.click(); await sleep(300);
await page.keyboard.insertText(prompt); await sleep(800);
await page.keyboard.press('Enter'); await sleep(1500); const sb = await page.$('button[aria-label="メッセージを送信"], button[aria-label="Send message"], button[aria-label="Send Message"], button[data-testid="send-button"]'); if (sb) { await sb.click(); } await sleep(3000); console.log('after send url', page.url());
// wait until answer text stops growing
let last = '', stable = 0;
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  const els = await page.$$(cfg.answer);
  const txt = els.length ? await els[els.length - 1].innerText() : '';
  if (txt && txt === last) { stable++; if (stable >= 4) break; } else stable = 0;
  last = txt;
}
fs.writeFileSync(OUT + which + '.md', last, 'utf8');
console.log(which, 'chars:', last.length, 'url:', page.url());
await page.close(); await b.close();
