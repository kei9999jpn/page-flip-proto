// 名言画像 → 本のページ規格(1200x1600 / jpeg q68 / mozjpeg) 一括変換
// 使い方: node tools/build-pages.cjs <入力フォルダ> [開始ページ番号=1]
//   入力フォルダ内の画像(jpg/png)をファイル名の数字順に p<番号>.jpg として assets/pages/ に出力する。
//   元画像がどんなサイズでも(2倍サイズでも)この規格に揃う。SNS用の元データと本用データの橋渡し係。
const sharp = require('sharp');
sharp.cache(false);
const fs = require('fs'), path = require('path');

const SRCDIR = process.argv[2];
const START = parseInt(process.argv[3] || '1', 10);
if (!SRCDIR) { console.error('usage: node tools/build-pages.cjs <srcDir> [startPage]'); process.exit(1); }

const W = 1200, H = 1600, Q = 68;
const OUT = path.join(__dirname, '..', 'assets', 'pages');
fs.mkdirSync(OUT, { recursive: true });

const files = fs.readdirSync(SRCDIR)
  .filter(f => /\.(jpe?g|png)$/i.test(f))
  .map(f => ({ f, n: parseInt((f.match(/\d+/) || ['0'])[0], 10) }))
  .sort((a, b) => a.n - b.n || a.f.localeCompare(b.f));

(async () => {
  let page = START;
  for (const { f } of files) {
    const out = path.join(OUT, 'p' + page + '.jpg');
    const buf = await sharp(fs.readFileSync(path.join(SRCDIR, f)))
      .resize(W, H, { fit: 'cover' })
      .jpeg({ quality: Q, mozjpeg: true })
      .toBuffer();
    fs.writeFileSync(out, buf);
    console.log('p' + page + '.jpg', '<-', f, Math.round(buf.length / 1024) + 'KB');
    page++;
  }
  console.log('done:', page - START, 'pages. index.htmlのNを' + (page - 1) + 'に更新するのを忘れずに。');
})();
