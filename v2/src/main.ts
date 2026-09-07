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
// タイトルカード「名言の書」は出さない（2026-09-07 KEI: 表紙の箔押しに置き換えた）。
const fade = document.createElement('div');
fade.id = 'fade';
document.body.appendChild(fade);
const flash = document.createElement('div');
flash.id = 'flash';
document.body.appendChild(flash);

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

// ============================================================ 開く演出（作品最大の一発）
// 台本（秒。openBookSound は 0.85s に鳴らし、その内部タイミング＝紙2枚 0/0.55、革の着地 1.30 に合わせる）
//   0.00 環境音がすっと引く／表紙の金箔に光が走る
//   0.15 表紙が5°持ち上がり、カメラが寄る
//   0.85 表紙が開きはじめる（openBookSound）。光が本の内側から溢れはじめる
//   1.45 ページの間へドリー（視野が歪む）
//   2.15 革が着地する重い音に合わせて光が最大
//   2.42 暗転せずに読書画面へマッチカット（同じ位置・同じ明るさの紙／背景は直前の3D画面）
const OPEN_LIFT = 0.09;              // 表紙が持ち上がる角度（rad ≈ 5°）
const OPEN_DUR = 1.15;               // 表紙が開ききるまで
const T_SOUND = 0.85, T_MOTES = 1.00, T_DIVE = 1.45, T_SNAP = 0.30, T_CUT = 2.42;
let openT0 = 0, lifting = false, capturedBG = '';

function beginRead(mode: string, title?: string): void {
  if (stage !== 'book') return;
  void title;
  setStage('opening');
  ui.setLocked(true);
  ensureAudio();
  talk.classList.remove('show');
  activity(); pagesSession = 0; flipTimes = []; rushSeen = false;
  track('open_book', { mode });

  openT0 = performance.now(); lifting = true; capturedBG = '';
  setAmbBoost(0.34);                                        // 環境音がすっと引く
  const at = (sec: number, fn: () => void) => setTimeout(fn, sec * 1000);

  at(T_SOUND, () => { opening = true; openBookSound(); haptic(8); });
  at(T_MOTES, () => scene.motesStart());
  at(T_DIVE, () => { diving = true; });
  at(2.10, () => haptic(16));                               // 革が着地する直前
  at(2.15, () => { flash.style.transition = 'opacity .22s ease-out'; flash.style.opacity = '.82'; });
  at(T_SNAP, () => scene.captureFrame(url => { if (url) void dimSnapshot(url).then(u => { capturedBG = u; }); }));
  at(T_CUT, () => {
    setStage('read');
    $('bgDim').style.opacity = '1';
    reader.open(mode, { bg: capturedBG || undefined, matchCut: true });
    flash.style.transition = 'opacity 1.05s ease';
    flash.style.opacity = '0';
    setTimeout(() => {
      scene.motesStop(); scene.resetOpenFX();
      setAmbBoost(1);                                         // 引いた環境音を読書の部屋の音として戻す
      opening = false; diving = false; lifting = false; openT = 0; diveT = 0;
      if (scene.hinge) scene.hinge.rotation.z = 0;
    }, 600);
  });
}

/**
 * 開く直前の3D画面を、読書画面の後ろに敷ける形に落とす。
 * 1/3 に縮めてぼかし、暗く沈め、右下（ろうそくの居場所）は黒に潰す。
 * ここで焼いておけば読書中の CSS フィルタが要らず、転送も描画も軽い。
 */
function dimSnapshot(url: string): Promise<string> {
  return new Promise(res => {
    const im = new Image();
    im.onload = () => {
      try {
        const w = Math.max(64, Math.round(im.width / 3)), h = Math.max(64, Math.round(im.height / 3));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d')!;
        g.filter = 'blur(4px) brightness(0.44) saturate(0.85)';
        g.drawImage(im, 0, 0, w, h);
        g.filter = 'none';
        // 画面のふち
        let vg = g.createRadialGradient(w / 2, h * 0.46, 0, w / 2, h * 0.46, Math.max(w, h) * 0.78);
        vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(0.55, 'rgba(0,0,0,.35)'); vg.addColorStop(1, 'rgba(0,0,0,.92)');
        g.fillStyle = vg; g.fillRect(0, 0, w, h);
        // 右下はろうそくの居場所。黒に潰しておかないと灯りの絵が四角く浮く
        vg = g.createRadialGradient(w * 0.9, h * 0.95, 0, w * 0.9, h * 0.95, Math.max(w, h) * 0.42);
        vg.addColorStop(0, 'rgba(0,0,0,.98)'); vg.addColorStop(0.6, 'rgba(0,0,0,.7)'); vg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = vg; g.fillRect(0, 0, w, h);
        res(c.toDataURL('image/jpeg', 0.6));
      } catch { res(''); }
    };
    im.onerror = () => res('');
    im.src = url;
  });
}

/** 開く演出の連続量（光・箔の走り・表紙の持ち上げ・寄り）。毎フレーム呼ぶ */
function openEnvelope(): { r: number; ph: number } | null {
  if (stage !== 'opening' && stage !== 'read') return null;
  if (!lifting) return null;
  const ot = (performance.now() - openT0) / 1000;
  // 表紙の金箔に光が走る（0.00 → 0.85）
  scene.gild = Math.max(0, Math.min(1, (ot - 0.02) / 0.83));
  // 光が本の内側から溢れる。2.15 の着地で最大、そのあとすっと引く
  let f = 0;
  if (ot > T_SOUND) f = Math.min(1, (ot - T_SOUND) / 0.70);
  if (ot > 2.20) f = Math.max(0.35, 1 - (ot - 2.20) / 0.55);
  scene.openFlare = f;
  // 表紙が5°持ち上がる（0.15 → 0.80）。開きはじめたら hinge は下のループに任せる
  if (!opening && scene.hinge) {
    const k = Math.max(0, Math.min(1, (ot - 0.15) / 0.65));
    scene.hinge.rotation.z = OPEN_LIFT * (k * k * (3 - 2 * k));
  }
  // カメラが寄る（1.55 → 1.30）。潜り込みが始まったら dive 側が持つ
  if (ot < T_DIVE) {
    const k = Math.max(0, Math.min(1, (ot - 0.15) / 1.20));
    return { r: BookScene.CAM_R - 0.26 * (k * k * (3 - 2 * k)), ph: scene.camPhi };
  }
  return null;
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
// PC は mousemove で代替（光の向きが視線に付いてくる）
if (!MOBILE) {
  addEventListener('mousemove', e => {
    scene.tiltRaw.x = Math.max(-1, Math.min(1, (e.clientX / innerWidth - 0.5) * 2));
    scene.tiltRaw.y = Math.max(-1, Math.min(1, (e.clientY / innerHeight - 0.5) * 2));
  }, { passive: true });
  reader.listenMouse();
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
    openT = Math.min(openT + wdt / OPEN_DUR, 1);
    const k = openT * openT * (3 - 2 * openT);
    scene.hinge.rotation.z = OPEN_LIFT + (2.5 - OPEN_LIFT) * k;
  }
  if (diving) diveT += wdt;

  // 本を閉じる儀式: 本から抜ける(1.0s) → 表紙が重く閉じる(0.85s) → ドスッ
  let closeCam: { r: number; ph: number } | null = openEnvelope();
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
    camOverride: closeCam,
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
