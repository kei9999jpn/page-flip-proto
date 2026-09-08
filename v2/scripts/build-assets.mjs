// ============================================================
// アセットパイプライン（名言の書 v2）
//   node scripts/build-assets.mjs [glb|rain|pages|all]
//
//   glb   : ../assets/book.glb → public/book.glb（Draco + テクスチャ1024・WebP）
//   rain  : ../assets/rain/study.mp3 → 30〜45秒のシームレスループを切り出し、
//           Opus(WebM) 64kbps + mp3 の2本を ../assets/rain/ に出す（ffmpeg 必須）
//   pages : ../assets/pages/*.jpg（1200x1600, 790枚）→ ../assets/pages-avif/*.avif
//           900x1200 / AVIF q52。時間がかかる（1時間前後）ので単独で回すこと。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');            // v2/
const ASSETS = path.resolve(ROOT, '..', 'assets');
const PUBLIC = path.join(ROOT, 'public');

const task = process.argv[2] || 'all';
const log = (...a) => console.log('[assets]', ...a);

// ------------------------------------------------------------ glb
async function buildGlb() {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const { draco, prune, dedup } = await import('@gltf-transform/functions');
  const draco3d = await import('draco3dgltf');
  const sharp = (await import('sharp')).default;

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });

  const src = path.join(ASSETS, 'book.glb');
  const dst = path.join(PUBLIC, 'book.glb');
  const doc = await io.read(src);
  await doc.transform(dedup(), prune());
  // テクスチャは自前の sharp で 1024 上限 + WebP に落とす
  // （@gltf-transform の textureCompress は同梱 vips と噛み合わず落ちるため使わない）
  for (const tex of doc.getRoot().listTextures()) {
    const img = tex.getImage();
    if (!img) continue;
    const before = img.byteLength;
    const buf = await sharp(Buffer.from(img))
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 84 })
      .toBuffer();
    tex.setImage(new Uint8Array(buf)).setMimeType('image/webp');
    const name = tex.getName() || tex.getURI() || 'texture';
    log('  tex', name, (before / 1e6).toFixed(2) + 'MB →', (buf.length / 1e6).toFixed(2) + 'MB');
  }
  await doc.transform(draco({ method: 'edgebreaker' }));
  await io.write(dst, doc);
  log('glb', (fs.statSync(src).size / 1e6).toFixed(2) + 'MB', '→', (fs.statSync(dst).size / 1e6).toFixed(2) + 'MB');
}

// ------------------------------------------------------------ rain
// 環境音ループ。2026-09-08 から元の12分を丸ごと（Opus 40k ≈3.6MB / mp3 64k ≈5.8MB。preload=none で音が要る時だけ流し込み）
function buildRain() {
  const src = path.join(ASSETS, 'rain', 'study.mp3');
  if (!fs.existsSync(src)) { log('rain: 元ファイルが無い', src); return; }
  const outDir = path.join(ASSETS, 'rain');
  const START = 0, DUR = 720;                     // 2026-09-08 KEI「同じ所のループが気になる・10分は流れてほしい」→ 元の12分を丸ごと
  const wav = path.join(outDir, '_study-loop.wav');
  execFileSync('ffmpeg', ['-y', '-ss', String(START), '-t', String(DUR), '-i', src,
    '-af', 'afade=t=in:st=0:d=0.35,afade=t=out:st=' + (DUR - 0.35) + ':d=0.35', '-ac', '2', '-ar', '48000', wav], { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-i', wav, '-c:a', 'libopus', '-b:a', '40k', '-vbr', 'on',
    path.join(outDir, 'study-loop.webm')], { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '64k',
    path.join(outDir, 'study-loop.mp3')], { stdio: 'ignore' });
  fs.unlinkSync(wav);
  for (const f of ['study-loop.webm', 'study-loop.mp3']) {
    log('rain', f, (fs.statSync(path.join(outDir, f)).size / 1e6).toFixed(2) + 'MB');
  }
}

// ------------------------------------------------------------ pages
async function buildPages() {
  const sharp = (await import('sharp')).default;
  const inDir = path.join(ASSETS, 'pages');
  const outDir = path.join(ASSETS, 'pages-avif');
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs.readdirSync(inDir).filter(f => /\.jpg$/i.test(f));
  let done = 0, saved = 0;
  const CONC = 4;
  const queue = files.slice();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const f = queue.pop();
      const out = path.join(outDir, f.replace(/\.jpg$/i, '.avif'));
      if (!fs.existsSync(out)) {
        await sharp(path.join(inDir, f)).resize(900, 1200, { fit: 'inside' }).avif({ quality: 52, effort: 4 }).toFile(out);
      }
      saved += fs.statSync(out).size;
      if (++done % 50 === 0) log('pages', done + '/' + files.length);
    }
  }));
  log('pages done', done, (saved / 1e6).toFixed(1) + 'MB');
}

// ------------------------------------------------------------ ui（枠素材と表紙の法線マップを軽くする）
async function buildUi() {
  const sharp = (await import('sharp')).default;
  const jobs = [
    // 9スライスの枠。border-image は 92px のスライスを使うので寸法は変えない。
    { src: path.join(ASSETS, 'ui2', 'panel.png'), dst: path.join(ASSETS, 'ui2', 'panel.webp'), w: null, q: 82 },
    // 表紙の法線マップ。1024 あれば足りる（表示は最大でも画面の半分）。
    { src: path.join(ASSETS, 'cover-normal.jpg'), dst: path.join(ASSETS, 'cover-normal.webp'), w: 1024, q: 76 },
  ];
  for (const j of jobs) {
    if (!fs.existsSync(j.src)) { log('ui: 元ファイルが無い', j.src); continue; }
    let im = sharp(j.src);
    if (j.w) im = im.resize(j.w, j.w, { fit: 'inside', withoutEnlargement: true });
    await im.webp({ quality: j.q }).toFile(j.dst);
    log('ui', path.basename(j.src), (fs.statSync(j.src).size / 1e3).toFixed(0) + 'KB →',
      path.basename(j.dst), (fs.statSync(j.dst).size / 1e3).toFixed(0) + 'KB');
  }
}

if (task === 'ui' || task === 'all') await buildUi();
if (task === 'glb' || task === 'all') await buildGlb();
if (task === 'rain' || task === 'all') buildRain();
if (task === 'pages') await buildPages();
