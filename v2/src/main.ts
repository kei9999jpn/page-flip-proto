// ============================================================
// 名言の書 v2 — 状態機械
//   book（3D書斎・本） → opening（開く演出） → read（読書） → closing
// iframe は廃止し、読書は同一ページの全画面レイヤー（reader/Reader.ts）。
// ============================================================
import * as THREE from 'three';
import { BookScene } from './scene/BookScene';
import { Reader } from './reader/Reader';
import { Ui } from './ui/Ui';
import {
  S, ST, saveStats, hasBookmark, favCount, MOBILE, QP,
} from './state';
import {
  initAudioGlobalHooks, ensureAudio, toggleSound, onSoundChange, activity, flipDuck,
  bgmTick, bgmFadeOut, bgmWant, setAmbBoost, setReadingProbe, setFullscreenHook, setTiltGrantHandler,
  thudHeavy, openBookSound, blip, haptic, audioDebug,
} from './audio';
import { track } from './track';

type Stage = 'book' | 'opening' | 'read' | 'closing';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const canvas = document.getElementById('c') as HTMLCanvasElement;

// ---- 画面に足す要素（HTML を小さく保つ） ----
const readTitle = document.createElement('div');
readTitle.id = 'readTitle';
readTitle.innerHTML = '<div class="rule"></div><div class="main">名言の書</div><div class="rule"></div>';
document.body.appendChild(readTitle);
const fade = document.createElement('div');
fade.id = 'fade';
document.body.appendChild(fade);

let stage: Stage = 'book';
function setStage(s: Stage): void {
  stage = s;
  document.body.classList.remove('stage-book', 'stage-opening', 'stage-read', 'stage-closing');
  document.body.classList.add('stage-' + s);
}
setReadingProbe(() => stage === 'read');

// ============================================================ この端末の記録
ST.visits++; ST.lastVisit = Date.now(); saveStats();
let pagesSession = 0, flipTimes: number[] = [], rushSeen = false;

// ============================================================ 字幕（本の声）
const talk = $('talk'), talkTxt = $('talkTxt');
let typing: ReturnType<typeof setInterval> | null = null;
let talkHide: ReturnType<typeof setTimeout> | null = null;
function say(line: string, hold = 3000): void {
  line = line.replace(/\n/g, '');
  if (typing) { clearInterval(typing); typing = null; }
  if (talkHide) { clearTimeout(talkHide); talkHide = null; }
  talk.classList.remove('slow');
  talk.classList.add('show');
  talkTxt.textContent = '';
  let i = 0;
  typing = setInterval(() => {
    talkTxt.textContent = line.slice(0, ++i);
    blip(i);
    if (i >= line.length) {
      clearInterval(typing!); typing = null;
      talkHide = setTimeout(() => { talk.classList.add('slow'); talk.classList.remove('show'); }, hold);
    }
  }, 55);
}

// ============================================================ 没入（モバイル）
let fsTried = false;
setFullscreenHook(() => {
  if (fsTried) return; fsTried = true;
  try {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) { const p = req.call(el, { navigationUI: 'hide' } as FullscreenOptions); if (p && p.catch) p.catch(() => {}); }
  } catch { /* noop */ }
  try {
    const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    if (so && so.lock) { const p = so.lock('portrait'); if (p && p.catch) p.catch(() => {}); }
  } catch { /* noop */ }
});

// ============================================================ 3D
const scene = new BookScene(canvas);
const clock = new THREE.Clock();
let opening = false, openT = 0, diving = false, diveT = 0;
let closing: { phase: 'wait' | 'pull' | 'shut'; t: number } | null = null;
let dragging = false, lastX = 0, lastY = 0;

// ============================================================ 読書レイヤー
const reader = new Reader({
  onClose: () => closeBook(),
  onFlip: info => {
    activity(); flipDuck(); pagesSession++;
    ST.pagesTotal = (ST.pagesTotal || 0) + 1; saveStats();
    const now = performance.now();
    flipTimes.push(now);
    while (flipTimes.length && now - flipTimes[0] > 9000) flipTimes.shift();
    if (flipTimes.length >= 6) { rushSeen = true; flipTimes = []; }
    void info;
  },
  onFav: info => { activity(); track('seal', { on: info.on, count: info.count }); },
  onBookmark: info => { activity(); scene.setRibbonVisible(!info.off); track('bookmark', { off: info.off }); },
  onActivity: () => activity(),
  onFirstTouch: () => { bgmWant(); ensureAudio(); activity(); },
  onSoundToggle: () => { toggleSound(); activity(); },
});

// ============================================================ UI
const ui = new Ui({
  onOpen: (mode, title) => beginRead(mode, title),
  onToggleSound: () => toggleSound(),
  onSay: line => say(line, 2500),
});
onSoundChange(on => { ui.paintSound(on); reader.paintSound(on); });

// ============================================================ 開く → 吸い込まれる → 読書
function beginRead(mode: string, title?: string): void {
  if (stage !== 'book') return;
  setStage('opening');
  ui.setLocked(true);
  (readTitle.querySelector('.main') as HTMLElement).textContent = title || '名言の書';
  ensureAudio();
  talk.classList.remove('show');
  readTitle.classList.add('show');
  activity(); pagesSession = 0; flipTimes = []; rushSeen = false;
  track('open_book', { mode });

  setTimeout(() => readTitle.classList.remove('show'), 2400);
  setTimeout(() => { opening = true; openBookSound(); }, 1700);
  setTimeout(() => haptic(12), 3000);
  setTimeout(() => haptic(12), 3800);
  setTimeout(() => scene.motesStart(), 2600);
  setTimeout(() => { diving = true; }, 3300);
  setTimeout(() => { fade.style.transition = 'opacity 1.4s ease-in'; fade.style.opacity = '1'; }, 4000);
  setTimeout(() => {
    setStage('read');
    $('bgDim').style.opacity = '1';
    reader.open(mode);
    scene.motesStop();
    setTimeout(() => { fade.style.transition = 'opacity 2.2s ease'; fade.style.opacity = '0'; }, 700);
    opening = false; diving = false; openT = 0; diveT = 0;
    if (scene.hinge) scene.hinge.rotation.z = 0;
  }, 5900);
}

// 本を閉じる儀式（約3秒）
function closeBook(): void {
  if (closing || stage !== 'read') return;
  track('close_book', { pages: pagesSession });
  setStage('closing');
  closing = { phase: 'wait', t: 0 };
  reader.closeRitual();
  bgmFadeOut(1300);
  setAmbBoost(0.85);
  fade.style.transition = 'opacity .5s ease-in';
  setTimeout(() => { fade.style.opacity = '1'; }, 900);
  setTimeout(() => {
    reader.hide();
    $('bgDim').style.opacity = '0';
    scene.bookTarget = 1;
    if (scene.hinge) scene.hinge.rotation.z = 2.5;
    closing = { phase: 'pull', t: 0 };
    fade.style.transition = 'opacity .7s ease-out'; fade.style.opacity = '0';
  }, 1450);
}
function closeBookDone(): void {
  closing = null;
  if (scene.hinge) scene.hinge.rotation.z = 0;
  setStage('book');
  thudHeavy(); haptic(18); scene.shake = 1;
  scene.burstDust();
  setAmbBoost(1);
  scene.refreshRibbon();
  scene.buildFavMarks();
  ui.setLocked(false);
  ui.start();                       // 戻ってきたら、また5秒後に一文
}

// ============================================================ 本の画面の入力（回転 / タップ）
let downAt = 0, downX = 0, downY = 0, moved = false;
canvas.addEventListener('pointerdown', e => {
  if (stage !== 'book') return;
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  downAt = performance.now(); downX = e.clientX; downY = e.clientY; moved = false;
});
addEventListener('pointermove', e => {
  if (!dragging) return;
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 8) moved = true;
  scene.camTheta -= (e.clientX - lastX) * 0.006;
  scene.camPhi = Math.max(0.4, Math.min(2.2, scene.camPhi - (e.clientY - lastY) * 0.004));
  lastX = e.clientX; lastY = e.clientY;
});
addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  if (!moved && performance.now() - downAt < 300 && stage === 'book') ui.tap();
});

// ============================================================ 端末の傾き
function listenTilt(): void {
  addEventListener('deviceorientation', ev => {
    if (ev.gamma == null || ev.beta == null) return;
    scene.tiltRaw.x = Math.max(-1, Math.min(1, ev.gamma / 35));
    scene.tiltRaw.y = Math.max(-1, Math.min(1, (ev.beta - 45) / 35));
  }, { passive: true });
  reader.listenTilt();
}
setTiltGrantHandler(listenTilt);
try {
  const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
  if (!(DOE && typeof DOE.requestPermission === 'function')) listenTilt();
} catch { /* noop */ }

// ============================================================ ループ
addEventListener('resize', () => scene.resize());
scene.resize();
initAudioGlobalHooks();

scene.load(() => {
  scene.resize();
  ui.start();
});

scene.renderer.setAnimationLoop(() => {
  const raw = clock.getDelta();
  const dt = Math.min(raw, 0.05), wdt = Math.min(raw, 0.5), t = clock.elapsedTime;
  bgmTick(wdt);
  if (stage === 'read' && !diving) return;       // 読書中は3Dを描かない（電池）

  if (opening && scene.hinge) {
    openT = Math.min(openT + wdt / 2.2, 1);
    const k = openT * openT * (3 - 2 * openT);
    scene.hinge.rotation.z = k * 2.5;
  }
  if (diving) diveT += wdt;

  // 本を閉じる儀式: 本から抜ける(1.0s) → 表紙が重く閉じる(0.85s) → ドスッ
  let closeCam: { r: number; ph: number } | null = null;
  if (closing && scene.hinge) {
    closing.t += wdt;
    if (closing.phase === 'pull') {
      const k = Math.min(closing.t / 1.0, 1), e2 = 1 - Math.pow(1 - k, 3);
      closeCam = { r: 0.19 + (BookScene.CAM_R - 0.19) * e2, ph: 0.12 + (scene.camPhi - 0.12) * e2 };
      scene.hinge.rotation.z = 2.5;
      if (k >= 1) closing = { phase: 'shut', t: 0 };
    } else if (closing.phase === 'shut') {
      const k = Math.min(closing.t / 0.85, 1), e2 = k * k * k;
      scene.hinge.rotation.z = 2.5 * (1 - e2);
      if (k >= 1) closeBookDone();
    }
  }

  scene.update({
    dt, wdt, t, raw,
    dragging, opening, diving, diveT,
    autoSpin: !dragging && !opening && !diving && stage === 'book',
    closeCam,
  });
});

// ============================================================ デバッグ
window.__app = {
  get stage() { return stage; },
  get audio() { return audioDebug(); },
  get reader() { return reader.debug(); },
  get info() { return { favs: favCount(), bookmark: hasBookmark(), visits: ST.visits, mobile: MOBILE, sound: S.sound, q: QP.toString() }; },
  beginRead, closeBook,
  setCam(th: number, ph: number) { scene.camTheta = th; scene.camPhi = ph; },
  ui,
};
