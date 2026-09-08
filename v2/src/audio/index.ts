// ============================================================
// 音（親で一元管理）
//  - 現行 app/index.html の音（環境音・BGM 2デッキ・シェルの効果音）と
//    a/index.html の音（めくり音5声色・印・栞・<audio>代替）を1つの AudioContext に統合。
//  - preload="none"。音が要る瞬間（最初のタップ / 音ON）まで1バイトも落とさない。
//  - めくり音の中身（VAR 5声色・ピッチ揺らぎ・音量カーブ）は KEI 確定。変えない。
//  - 擦れ音 rustle* は KEI 不採用のため、そもそも実装しない。
// ============================================================
import { S, saveSettings, applySoundFlags, curve, asset, BUILD } from '../state';

const RAIN_SRC: Record<string, string> = {
  std: asset('rain.mp3'),
  drizzle: asset('rain/drizzle.mp3'),
  window: asset('rain/window.mp3'),
  storm: asset('rain/storm.mp3'),
  suno1: asset('rain/suno1.mp3'),
  // v2: study.mp3(12分)を丸ごと Opus(WebM) 40k / mp3 64k に（2026-09-08 KEI: 36秒ループは同じ所が気になる→12分で一周）。
  study: (() => {
    try {
      const a = document.createElement('audio');
      if (a.canPlayType('audio/webm; codecs=opus')) return asset('rain/study-loop.webm?b=' + BUILD);
    } catch { /* noop */ }
    return asset('rain/study-loop.mp3?b=' + BUILD);
  })(),
};

export const SPK_ON = '<svg width="18" height="16" viewBox="0 0 24 20" fill="none" stroke="#c9a24a" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M3 7h4l5-4v14l-5-4H3z"/><path d="M15.5 6.5a5 5 0 0 1 0 7"/><path d="M18.5 4a9 9 0 0 1 0 12"/></svg>';
export const SPK_OFF = '<svg width="18" height="16" viewBox="0 0 24 20" fill="none" stroke="#8a7a58" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M3 7h4l5-4v14l-5-4H3z"/><path d="M16 7l5 6M21 7l-5 6"/></svg>';

// ---- <audio> 要素（雨 + BGM 2デッキ）----
function mkAudio(loop: boolean): HTMLAudioElement {
  const a = document.createElement('audio');
  a.preload = 'none';
  a.loop = loop;
  document.body.appendChild(a);
  return a;
}
const rain = mkAudio(true);
const decks: HTMLAudioElement[] = [mkAudio(false), mkAudio(false)];

const BGM_ENABLED = false;                       // 2026-09-04 KEI: BGMは廃止。環境音（雨・暖炉）だけ
const BGM_LIST = [asset('bgm-loop.mp3?b=' + BUILD)];
const BGM_BASE = 0.5;
const BGM_XF = 6.0;

let audioOn = false, unlocked = false, bgmWanted = false;
let sx: AudioContext | null = null, sxMaster: GainNode | null = null;
let routed = false, rainG: GainNode | null = null, _rainV = 1;
const deckG: (GainNode | null)[] = [null, null];
const deckV = [0, 0];
let dk = 0, bgmOrder: number[] = [], bgmPos = 0, bgmLast = -1;
let xfade: ReturnType<typeof setInterval> | null = null;
let bgmFade: ReturnType<typeof setInterval> | null = null;
const bgmMix = [1, 0];

let duck = 1, duckCur = 1, ambBoost = 1, ambBoostCur = 1, duckUntil = 0;
let lastActivity = performance.now(), idleQuiet = false;
let readingNow = () => false;                    // 「読書中か」を main から差してもらう

export function setReadingProbe(fn: () => boolean): void { readingNow = fn; }
export function activity(): void { lastActivity = performance.now(); if (idleQuiet) { idleQuiet = false; duck = 1; ambBoost = 1; } }
export function flipDuck(): void { duck = 0.82; duckUntil = performance.now() + 550; }
export function setAmbBoost(v: number): void { ambBoost = v; }
function rainTarget(): number { return S.rain ? Math.min(1, 0.65 * curve(S.amb) * ambBoostCur) : 0; }

function sxInit(): void {
  if (sx) { if (sx.state === 'suspended') sx.resume().then(tryRoute).catch(() => {}); else tryRoute(); return; }
  try {
    const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    sx = new Ctor();
  } catch { sx = null; return; }
  sxMaster = sx.createGain(); sxMaster.gain.value = 1; sxMaster.connect(sx.destination);
  if (sx.state === 'suspended') sx.resume().then(tryRoute).catch(() => {}); else tryRoute();
}
// iPhone は <audio>.volume が効かない。AudioContext が「動いている」ことを確認してから GainNode 経由に切り替える
function tryRoute(): void {
  if (routed || !sx || sx.state !== 'running' || !sxMaster) return;
  try {
    const rs = sx.createMediaElementSource(rain); rainG = sx.createGain(); rs.connect(rainG); rainG.connect(sxMaster);
    decks.forEach((d, i) => { const src = sx!.createMediaElementSource(d); deckG[i] = sx!.createGain(); src.connect(deckG[i]!); deckG[i]!.connect(sxMaster!); });
    routed = true;
    rainG.gain.value = _rainV; rain.volume = 1;
    decks.forEach((d, i) => { deckG[i]!.gain.value = deckV[i]; d.volume = 1; });
  } catch { routed = false; }
}
function setRainVol(v: number): void { _rainV = v; if (routed && rainG && sx) rainG.gain.setTargetAtTime(v, sx.currentTime, 0.05); else rain.volume = v; }
function setDeckVol(i: number, v: number): void {
  v = Math.max(0, Math.min(1, v)); deckV[i] = v;
  if (routed && deckG[i] && sx) deckG[i]!.gain.setTargetAtTime(v, sx.currentTime, 0.05); else decks[i].volume = v;
}

// ---- BGM（2デッキのクロスフェード。曲を BGM_LIST に足せば繋がる）----
function bgmShuffle(): void {
  bgmOrder = BGM_LIST.map((_, i) => i);
  for (let i = bgmOrder.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bgmOrder[i], bgmOrder[j]] = [bgmOrder[j], bgmOrder[i]]; }
  bgmPos = 0;
}
function bgmNextSrc(): string {
  if (!bgmOrder.length || bgmPos >= bgmOrder.length) { bgmShuffle(); if (BGM_LIST.length > 1 && bgmOrder[0] === bgmLast) bgmOrder.push(bgmOrder.shift()!); }
  const i = bgmOrder[bgmPos++]; bgmLast = i; return BGM_LIST[i];
}
if (BGM_ENABLED && BGM_LIST.length === 1) { decks[0].loop = true; decks[0].src = BGM_LIST[0]; }
function bgmTargetVol(): number { return (BGM_ENABLED && S.bgm && bgmWanted) ? Math.min(1, BGM_BASE * curve(S.bgmVol) * duckCur) : 0; }
function bgmStart(): void {
  if (!BGM_ENABLED || !bgmWanted || !S.bgm) return;
  if (bgmFade) { clearInterval(bgmFade); bgmFade = null; }
  const d = decks[dk];
  if (BGM_LIST.length > 1 && !d.src) { d.loop = false; d.src = bgmNextSrc(); }
  bgmMix[dk] = 1; bgmMix[1 - dk] = 0;
  setDeckVol(dk, bgmTargetVol());
  if (d.paused) d.play().catch(() => {});
}
function bgmStop(ms: number): void {
  if (bgmFade) clearInterval(bgmFade);
  if (xfade) { clearInterval(xfade); xfade = null; }
  const from = [deckV[0], deckV[1]], t0 = performance.now();
  bgmFade = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / Math.max(50, ms || 200));
    decks.forEach((d, i) => { if (!d.paused) setDeckVol(i, from[i] * (1 - k)); });
    if (k >= 1) {
      clearInterval(bgmFade!); bgmFade = null;
      decks.forEach((d, i) => { d.pause(); if (BGM_LIST.length > 1) { try { d.removeAttribute('src'); d.load(); } catch { /* noop */ } } bgmMix[i] = i === dk ? 1 : 0; });
    }
  }, 30);
}
function bgmCrossfade(): void {
  if (xfade || BGM_LIST.length < 2) return;
  const cur = dk, nxt = 1 - dk, dn = decks[nxt];
  dn.loop = false; dn.src = bgmNextSrc(); bgmMix[nxt] = 0; setDeckVol(nxt, 0); dn.play().catch(() => {});
  const t0 = performance.now();
  xfade = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / (BGM_XF * 1000));
    bgmMix[cur] = 1 - k; bgmMix[nxt] = k;
    if (k >= 1) { clearInterval(xfade!); xfade = null; decks[cur].pause(); try { decks[cur].removeAttribute('src'); decks[cur].load(); } catch { /* noop */ } dk = nxt; }
  }, 50);
}
decks.forEach(d => d.addEventListener('ended', () => {
  if (BGM_LIST.length > 1 && bgmWanted && S.bgm && !xfade) {
    dk = decks.indexOf(d) === 0 ? 1 : 0;
    const n = decks[dk]; n.loop = false; n.src = bgmNextSrc(); bgmMix[dk] = 1; bgmMix[1 - dk] = 0;
    setDeckVol(dk, bgmTargetVol()); n.play().catch(() => {});
  }
}));
export function bgmFadeOut(ms: number): void { bgmWanted = false; bgmStop(ms); }
export function bgmWant(): void { bgmWanted = BGM_ENABLED; }

export function bgmTick(dt: number): void {
  if (duck < 1 && duckUntil && performance.now() > duckUntil && !idleQuiet) { duck = 1; duckUntil = 0; }
  if (readingNow() && !idleQuiet && performance.now() - lastActivity > 30000) { idleQuiet = true; duck = 0.55; ambBoost = 1.25; }
  duckCur += (duck - duckCur) * (1 - Math.exp(-dt / (duck < duckCur ? 0.12 : 0.9)));
  ambBoostCur += (ambBoost - ambBoostCur) * (1 - Math.exp(-dt / 1.5));
  if (audioOn) { const rv = rainTarget(); if (Math.abs(_rainV - rv) > 0.002) setRainVol(rv); }
  if (bgmFade) return;
  const tv = bgmTargetVol();
  decks.forEach((d, i) => {
    if (d.paused) return;
    const want = tv * bgmMix[i];
    if (Math.abs(deckV[i] - want) > 0.002) setDeckVol(i, deckV[i] + (want - deckV[i]) * (1 - Math.exp(-dt / 0.35)));
  });
  const d = decks[dk];
  if (BGM_LIST.length > 1 && bgmWanted && !d.paused && d.duration && d.duration - d.currentTime < BGM_XF) bgmCrossfade();
}

// ============================================================ 効果音（合成）
function noiseBuffer(dur: number, shape: (k: number) => number): AudioBuffer | null {
  if (!sx) return null;
  const len = Math.max(1, Math.floor(sx.sampleRate * dur));
  const nb = sx.createBuffer(1, len, sx.sampleRate), d = nb.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * shape(i / len);
  return nb;
}
/** 革表紙が落ちる「ドスッ……」 */
export function thudHeavy(): void {
  if (!sx || !sxMaster || !S.sound) return;
  const t0 = sx.currentTime;
  const o = sx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(82, t0); o.frequency.exponentialRampToValueAtTime(26, t0 + 0.34);
  const g = sx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.7, t0 + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.62);
  o.connect(g); g.connect(sxMaster); o.start(t0); o.stop(t0 + 0.7);
  const nb = noiseBuffer(0.22, k => Math.pow(1 - k, 2.2)); if (!nb) return;
  const s = sx.createBufferSource(); s.buffer = nb;
  const lp = sx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 240;
  const g3 = sx.createGain(); g3.gain.value = 0.4; s.connect(lp); lp.connect(g3); g3.connect(sxMaster); s.start(t0);
}
/** ボタンの音（低く暗く、うっすら） */
export function uiClick(k = 1): void {
  if (!sx || !sxMaster || !S.sound) return;
  const t0 = sx.currentTime;
  const o = sx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(74, t0); o.frequency.exponentialRampToValueAtTime(42, t0 + 0.16);
  const g = sx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.16 * k, t0 + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
  o.connect(g); g.connect(sxMaster); o.start(t0); o.stop(t0 + 0.3);
  const nb = noiseBuffer(0.05, x => Math.pow(1 - x, 3)); if (!nb) return;
  const n = sx.createBufferSource(); n.buffer = nb;
  const lp = sx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.7;
  const g2 = sx.createGain(); g2.gain.value = 0.05 * k; n.connect(lp); lp.connect(g2); g2.connect(sxMaster); n.start(t0);
}
/** 低いノイズのうねり（共通部品） */
function darkSwell(t0: number, dur: number, gain: number, f0: number, f1: number, attack: number, release: number): void {
  if (!sx || !sxMaster) return;
  const len = Math.floor(sx.sampleRate * (dur + 0.1)), nb = sx.createBuffer(1, len, sx.sampleRate), d = nb.getChannelData(0);
  let b0 = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b0 = 0.985 * b0 + w * 0.015; d[i] = b0 * 8; }
  const n = sx.createBufferSource(); n.buffer = nb;
  const lp = sx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.9; lp.frequency.setValueAtTime(f0, t0); lp.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  const g = sx.createGain();
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.setValueAtTime(gain, t0 + Math.max(attack, dur - release)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  n.connect(lp); lp.connect(g); g.connect(sxMaster); n.start(t0); n.stop(t0 + dur + 0.05);
}
// 表紙が開く音（v33 KEI: 「扉」ではなく「本」。紙のめくり録音を遅く重く鳴らし、革表紙の軽い着地を足す）
let pageBuf: AudioBuffer | null = null;
function loadPageBuf(): void {
  if (!sx || pageBuf) return;
  fetch(asset('se/page-soft.mp3')).then(r => r.arrayBuffer()).then(b => sx!.decodeAudioData(b)).then(buf => { pageBuf = buf; }).catch(() => {});
}
export function openBookSound(): void {
  if (!sx || !sxMaster || !S.sound) return;
  const t0 = sx.currentTime;
  if (pageBuf) {
    const src = sx.createBufferSource(); src.buffer = pageBuf; src.playbackRate.value = 0.55;
    const lp = sx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 0.5;
    const g = sx.createGain();
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(2.4, t0 + 0.08); g.gain.setValueAtTime(2.4, t0 + 0.9); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.9);
    src.connect(lp); lp.connect(g); g.connect(sxMaster); src.start(t0); src.stop(t0 + 2.0);
    const s2 = sx.createBufferSource(); s2.buffer = pageBuf; s2.playbackRate.value = 0.7;
    const g2 = sx.createGain();
    g2.gain.setValueAtTime(0.0001, t0 + 0.55); g2.gain.exponentialRampToValueAtTime(1.1, t0 + 0.65); g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.6);
    const lp2 = sx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 2600;
    s2.connect(lp2); lp2.connect(g2); g2.connect(sxMaster); s2.start(t0 + 0.55); s2.stop(t0 + 1.7);
  }
  const o = sx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(96, t0 + 1.3); o.frequency.exponentialRampToValueAtTime(40, t0 + 1.55);
  const og = sx.createGain(); og.gain.setValueAtTime(0.0001, t0 + 1.3); og.gain.exponentialRampToValueAtTime(0.3, t0 + 1.31); og.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.75);
  o.connect(og); og.connect(sxMaster); o.start(t0 + 1.3); o.stop(t0 + 1.8);
}
/** 文字送りの音（低い「ボソボソ」） */
export function blip(i: number): void {
  if (!sx || !sxMaster || !S.sound) return;
  try {
    const t = sx.currentTime, o = sx.createOscillator(), g = sx.createGain(), lp = sx.createBiquadFilter();
    o.type = 'triangle';
    o.frequency.setValueAtTime(96 + Math.random() * 38 + (i % 4) * 6, t);
    o.frequency.exponentialRampToValueAtTime(70 + Math.random() * 20, t + 0.045);
    lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.8;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(lp); lp.connect(g); g.connect(sxMaster); o.start(t); o.stop(t + 0.06);
  } catch { /* noop */ }
}

// ---- 読書側の効果音（a/ から移植。中身は KEI 確定なので変えない）----
const flipBufs: (AudioBuffer | null)[] = [];
let _lastVar = -1, _lastBuf = -1;
const _fbPool: HTMLAudioElement[] = [];
function fbFlip(): void {                                  // <audio> 代替（AudioContext が眠っていても必ず鳴らす）
  try {
    let a = _fbPool.find(x => x.paused || x.ended);
    if (!a) { a = new Audio(asset('se/page-loud.mp3')); _fbPool.push(a); }
    a.playbackRate = 0.92 + Math.random() * 0.16; a.currentTime = 0; a.play().catch(() => {});
  } catch { /* noop */ }
}
export function unlockFallbackAudio(): void {
  if (_fbPool.length) return;
  try {
    const a = new Audio(asset('se/page-loud.mp3')); a.muted = true;
    const p = a.play();
    if (p && p.then) p.then(() => { a.pause(); a.muted = false; a.currentTime = 0; }).catch(() => { a.muted = false; });
    _fbPool.push(a);
  } catch { /* noop */ }
}
/** めくり音。1録音 × 5声色（KEI 2026-09-04 確定。擦れ音・別録音は不採用） */
export function pageSound(strength: number, vel?: number): void {
  if (S.flipOn === false) return;
  if (!sx || sx.state !== 'running' || !flipBufs.some(Boolean)) {
    if (sx && sx.state !== 'running') { try { sx.resume(); } catch { /* noop */ } }
    fbFlip(); return;
  }
  const avail = flipBufs.map((b, i) => (b ? i : -1)).filter(i => i >= 0);
  if (!avail.length) return;
  let bi = avail[Math.floor(Math.random() * avail.length)];
  if (avail.length > 1 && bi === _lastBuf) bi = avail[(avail.indexOf(bi) + 1) % avail.length];
  _lastBuf = bi;
  const src = sx.createBufferSource(); src.buffer = flipBufs[bi]!;
  const VAR = [[1.00, 9000, 1.0], [0.88, 5200, 1.05], [1.12, 12000, 0.9], [0.80, 3800, 1.15], [1.06, 7000, 0.95]];
  let vi = Math.floor(Math.random() * VAR.length); if (vi === _lastVar) vi = (vi + 1) % VAR.length; _lastVar = vi;
  const V = VAR[vi];
  const v = Math.min(1, Math.abs(vel || 0) / 1.6);
  src.playbackRate.value = V[0] * (0.96 + Math.random() * 0.08) * (0.97 + v * 0.06);
  const lp = sx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = (V[2] > 1 ? V[1] : V[1] * 1.2) * (0.8 + v * 0.3); lp.Q.value = 0.4;
  const g = sx.createGain(); const t0 = sx.currentTime;
  const peak = Math.min(14, 6.8 * curve(S.flip) * Math.min(1, strength + 0.35) * V[2] * (0.85 + v * 0.2));
  g.gain.setValueAtTime(peak, t0); g.gain.setValueAtTime(peak, t0 + 0.45); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.0);
  const pan = sx.createStereoPanner ? sx.createStereoPanner() : null; if (pan) pan.pan.value = (Math.random() - 0.5) * 0.16;
  src.connect(lp); lp.connect(g);
  if (pan) { g.connect(pan); pan.connect(sxMaster!); } else g.connect(sxMaster!);
  src.start(); src.stop(t0 + 1.05);
}
/** 金の印を押す「コトッ」／外す時は軽く */
export function sealSound(on: boolean): void {
  if (!sx || !sxMaster || S.flipOn === false) return;
  const t0 = sx.currentTime;
  const o = sx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(on ? 210 : 260, t0); o.frequency.exponentialRampToValueAtTime(on ? 120 : 180, t0 + 0.07);
  const g = sx.createGain();
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(on ? 0.22 : 0.10, t0 + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t0 + (on ? 0.12 : 0.08));
  o.connect(g); g.connect(sxMaster); o.start(t0); o.stop(t0 + 0.15);
  const nb = noiseBuffer(0.03, k => Math.pow(1 - k, 4)); if (!nb) return;
  const s = sx.createBufferSource(); s.buffer = nb;
  const hp = sx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
  const g2 = sx.createGain(); g2.gain.value = on ? 0.16 : 0.08; s.connect(hp); hp.connect(g2); g2.connect(sxMaster); s.start(t0);
}
/** 栞の紐がページの間に「スッ…」と滑り込む音 */
export function ribbonSound(): void {
  if (!sx || !sxMaster || S.flipOn === false) return;
  const t0 = sx.currentTime, dur = 1.0;
  const len = Math.floor(sx.sampleRate * dur), nb = sx.createBuffer(1, len, sx.sampleRate), d = nb.getChannelData(0);
  let b0 = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b0 = 0.9 * b0 + w * 0.1; d[i] = (w * 0.3 + b0) * Math.sin(Math.PI * i / len); }
  const s = sx.createBufferSource(); s.buffer = nb;
  const bp = sx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
  bp.frequency.setValueAtTime(3600, t0); bp.frequency.exponentialRampToValueAtTime(900, t0 + dur);
  const g = sx.createGain(); g.gain.value = 0.10 * Math.max(0.3, curve(S.flip));
  s.connect(bp); bp.connect(g); g.connect(sxMaster); s.start(t0);
}

// ---- 虫の音・蝋燭の爆ぜ（既定は両方 OFF。設定を残すため移植） ----
let cricketsOn = false, crackleOn = false;
function startCrickets(): void {
  if (!sx || cricketsOn) return; cricketsOn = true;
  (function loop() {
    if (S.insects && sx && sxMaster) {
      const t0 = sx.currentTime + 0.05, n = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const t = t0 + i * 0.07;
        const o = sx.createOscillator(); o.type = 'sine'; o.frequency.value = 4100 + Math.random() * 400;
        const g = sx.createGain();
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05 * S.amb, t + 0.012); g.gain.linearRampToValueAtTime(0, t + 0.045);
        o.connect(g); g.connect(sxMaster); o.start(t); o.stop(t + 0.06);
      }
    }
    setTimeout(loop, 900 + Math.random() * 2200);
  })();
}
function startCrackle(): void {
  if (!sx || crackleOn) return; crackleOn = true;
  const noise = noiseBuffer(0.05, k => Math.pow(1 - k, 3)); if (!noise) return;
  (function loop() {
    if (S.candle && sx && sxMaster) {
      const n = 1 + Math.floor(Math.random() * 3), t0 = sx.currentTime + 0.02;
      for (let i = 0; i < n; i++) {
        const src = sx.createBufferSource(); src.buffer = noise; src.playbackRate.value = 0.6 + Math.random() * 0.9;
        const f = sx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800 + Math.random() * 2600; f.Q.value = 0.8;
        const g = sx.createGain(); g.gain.value = (0.05 + Math.random() * 0.09) * S.amb;
        src.connect(f); f.connect(g); g.connect(sxMaster); src.start(t0 + i * (0.03 + Math.random() * 0.08));
      }
    }
    setTimeout(loop, 400 + Math.random() * 2600);
  })();
}

// ============================================================ 解錠と適用
function applyRainSrc(): void {
  const src = RAIN_SRC[S.rainKind] || RAIN_SRC.study;
  if (rain.getAttribute('src') === src) return;
  const was = !rain.paused;
  rain.setAttribute('src', src); rain.load();
  if (was || (audioOn && S.rain)) { setRainVol(rainTarget()); rain.play().catch(() => {}); }
}
function applyAudio(): void {
  if (!audioOn) return;
  setRainVol(rainTarget());
  if (S.rain && rain.paused) rain.play().catch(() => {});
  if (S.bgm && bgmWanted) bgmStart();
  else if (decks.some(d => !d.paused)) bgmStop(400);
}
function loadFlipBufs(): void {
  if (!sx || flipBufs.length) return;
  [asset('se/page-soft.mp3')].forEach((u, i) => {
    fetch(u).then(r => r.arrayBuffer()).then(b => sx!.decodeAudioData(b)).then(buf => { flipBufs[i] = buf; }).catch(() => {});
  });
  flipBufs.length = 1;                                     // 読み込み中は空スロット
}
let onTiltGrant: (() => void) | null = null;
export function setTiltGrantHandler(fn: () => void): void { onTiltGrant = fn; }

function unlockAudio(): void {
  if (unlocked) return; unlocked = true;
  sxInit();
  try {
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
    if (DOE && typeof DOE.requestPermission === 'function') {
      DOE.requestPermission().then(s => { if (s === 'granted' && onTiltGrant) onTiltGrant(); }).catch(() => {});
    }
  } catch { /* noop */ }
  try {
    rain.muted = true;
    const p = rain.play();
    if (p && p.then) p.then(() => { rain.muted = false; applyAudio(); }).catch(() => { rain.muted = false; });
    else rain.muted = false;
  } catch { /* noop */ }
  if (BGM_ENABLED) decks.forEach((d, i) => {
    try {
      if (!d.src) d.src = BGM_LIST[0];
      setDeckVol(i, 0); d.muted = true;
      const p = d.play();
      if (p && p.then) p.then(() => { if (!bgmWanted || !S.bgm || i !== dk) { d.pause(); try { d.currentTime = 0; } catch { /* noop */ } } d.muted = false; }).catch(() => { d.muted = false; });
      else d.muted = false;
    } catch { /* noop */ }
  });
}

let onFullscreen: (() => void) | null = null;
export function setFullscreenHook(fn: () => void): void { onFullscreen = fn; }

export function ensureAudio(): void {
  if (onFullscreen) onFullscreen();
  activity();
  if (!S.sound) return;                                     // 音OFFの間は音に一切触らない
  applyRainSrc();
  unlockAudio(); sxInit(); loadPageBuf(); loadFlipBufs();
  startCrickets(); startCrackle();
  if (audioOn) return;
  audioOn = true; applyAudio();
}

let soundPainters: Array<(on: boolean) => void> = [];
export function onSoundChange(fn: (on: boolean) => void): void { soundPainters.push(fn); fn(!!S.sound); }
export function toggleSound(): void {
  S.sound = !S.sound; applySoundFlags(); saveSettings();
  soundPainters.forEach(f => f(!!S.sound));
  if (S.sound) {
    audioOn = false; ensureAudio();
    if (sx && sx.state !== 'running') sx.resume().catch(() => {});
    setRainVol(rainTarget()); rain.play().catch(() => {});
    uiClick(1);
  } else {
    try { rain.pause(); } catch { /* noop */ }
    decks.forEach(d => { try { d.pause(); } catch { /* noop */ } });
    if (sx && sx.state === 'running') sx.suspend().catch(() => {});
  }
}

/** 触覚（対応端末だけ） */
export function haptic(p: number | number[]): void { try { if (navigator.vibrate) navigator.vibrate(p); } catch { /* noop */ } }

export function initAudioGlobalHooks(): void {
  applySoundFlags();
  (['pointerdown', 'touchend', 'click', 'keydown'] as const).forEach(ev => addEventListener(ev, ensureAudio, { passive: true }));
  (['touchend', 'click', 'pointerup'] as const).forEach(ev => addEventListener(ev, () => {
    if (!S.sound) return;
    unlockFallbackAudio();
    if (!sx) return;
    if (sx.state !== 'running') sx.resume().then(tryRoute).catch(() => {}); else tryRoute();
  }, { passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.sound && sx && sx.state === 'suspended') sx.resume().catch(() => {});
  });
}

export const audioDebug = () => ({
  audioOn, routed, sxState: sx && sx.state, rainV: _rainV, deckV,
  flipBufs: flipBufs.filter(Boolean).length, pageBuf: !!pageBuf,
});
