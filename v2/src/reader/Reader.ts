// ============================================================
// 読書レイヤー（旧 a/index.html を同一ページの全画面レイヤーとして移植。postMessage は廃止）
//
// ★ めくりの手触りと音は KEI 確定。ここは触らない：
//    - 掴む場所は右上の角1箇所（grab.fy = 0.30 固定・pointermove/release の両方）
//    - 擦れ音 rustle* は実装しない（v27 KEI「シールが剥がれる音」で不採用）
//    - 着地の揺れ settle() は呼ばない（v27 KEI「ペラッペラで安っぽい」で不採用。関数は残置）
//    - 紙は丸めすぎない（peel の P1/P2 係数）
//    - finishFlip の dur / イージング / commitTo のしきい値
// ============================================================
import { asset, MOBILE, QP, S, loadFavs, saveFavs, loadBookmark, saveBookmark, clearBookmark, type Bookmark } from '../state';
import { pageSound, sealSound, ribbonSound, uiClick, haptic, ensureAudio } from '../audio';

const N = 790;
const SRC = (i: number) => asset('pages/p' + (i + 1) + '.jpg');
const PAPER = QP.get('paper') !== '0';
const EDGE = 8;
const AHEAD = 8, BEHIND = 2, MAX_PAR = 4;
const KEEP = 12;                                        // いま開いている所から前後 KEEP 枚だけ持つ（LRU ±12）

type Pt = { x: number; y: number };

export interface ReaderHooks {
  onClose: () => void;
  onFlip: (info: { v: number; dir: number; seen: number }) => void;
  onFav: (info: { count: number; on: boolean }) => void;
  onBookmark: (info: { off: boolean }) => void;
  onActivity: () => void;
  onFirstTouch: () => void;
  onSoundToggle: () => void;
}

export class Reader {
  readonly root: HTMLDivElement;
  private cv!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private dc!: HTMLCanvasElement;
  private dctx!: CanvasRenderingContext2D;

  private W = 0; private H = 0; private DPR = 1; private TRAVEL = 200;

  private ALL_PAGES = Array.from({ length: N }, (_, i) => i);
  private deck: number[] = this.shuffled(this.ALL_PAGES);
  private index = 0;
  private favMode = false;
  private favs: number[] = loadFavs();
  private seenSet = new Set<number>();

  private imgs: (HTMLImageElement | null)[] = new Array(N).fill(null);
  private loadedSet = new Set<number>();
  private loading = new Set<number>();
  private backTex: HTMLImageElement | null = null;
  private firstReady!: () => void;
  private pagesReady: Promise<void>;

  private flip: { dir: number; t: number } | null = null;
  private anim: { raf?: number } | null = null;
  private settling = false;
  private favStamp: { t0: number } | null = null;

  private grab = { fy: 0.30, dy: 0 };                   // KEI 確定: 右上の角1箇所
  private pd: { x0: number; x: number; y0: number; y: number; t0: number; started: boolean; tBase: number; fy: number; tTarget?: number } | null = null;
  private hist: [number, number][] = [];
  private followRaf: number | null = null;
  private _actAt = 0;

  private lampLevel = 0; private _lampTick = 0; private _lampSig = 1e9;
  private glowBase = 0; private glowRaf: number | null = null;
  private _fl = { t: 0, tgt: 0, cur: 0, next: 0, gust: 0 };
  private tilt = { x: 0, y: 0, on: false, sx: 0, sy: 0 };

  private motes: Array<{ x: number; y: number; r: number; a: number; vx: number; vy: number; ph: number }> = [];
  private embers: Array<{ x: number; y: number; r: number; a: number; vx: number; vy: number; sway: number; ph: number; life: number; px: number; py: number; hot: boolean }> = [];
  private glowFl = 0.8; private glowTarget = 0.8;

  private uiTimer: ReturnType<typeof setTimeout> | null = null;
  private uiJustWoke = 0;
  private ribbonShown = false;
  private candleOn = false;
  private _toastT: ReturnType<typeof setTimeout> | null = null;
  private opened = false;
  private _touched = false;

  private el!: {
    ribbon: HTMLDivElement; paperGlow: HTMLDivElement; candle: HTMLDivElement; shade: HTMLDivElement;
    halo: HTMLDivElement; candleImg: HTMLImageElement; flameGlow: HTMLDivElement; flame: HTMLDivElement;
    veil: HTMLDivElement; seen: HTMLDivElement; backBtn: HTMLDivElement; favBtn: HTMLDivElement;
    favListBtn: HTMLDivElement; setBtn: HTMLDivElement; toast: HTMLDivElement; favPanel: HTMLDivElement;
  };

  constructor(private hooks: ReaderHooks) {
    this.pagesReady = new Promise<void>(res => { this.firstReady = res as () => void; });
    this.root = document.createElement('div');
    this.root.id = 'reader';
    this.root.innerHTML = `
<div id="bg"></div>
<div id="ribbon"></div>
<canvas id="book"></canvas>
<div id="paperGlow"></div>
<div id="candle"></div>
<div id="shade"></div>
<div id="halo"></div>
<img id="candleImg" alt=""><div id="flameGlow"></div>
<div id="flameWrap"><div id="wick"></div><div id="flame"></div><div id="flameCore"></div></div>
<div id="veil"></div>
<canvas id="dust"></canvas>
<div id="seen"></div>
<div id="backBtn">‹ 戻る</div>
<div id="favBtn"><b>♡</b><span>印</span></div>
<div id="favListBtn"><b><svg width="14" height="18" viewBox="0 0 14 18" fill="none" stroke="#c9a24a" stroke-width="1.3"><path d="M2 1h10v16l-5-4-5 4z"/></svg></b><span>栞</span></div>
<div id="setBtn"><b></b><span>音</span></div>
<div id="toast"></div>
<div id="favPanel"><div class="box"><h2>印のページ</h2>
<div class="empty" id="favEmpty">まだ印のページがない</div><button class="close" id="favClose">閉じる</button></div></div>`;
    document.body.appendChild(this.root);

    const q = <T extends HTMLElement>(id: string) => this.root.querySelector<T>('#' + id)!;
    this.cv = q<HTMLCanvasElement>('book');
    this.ctx = this.cv.getContext('2d')!;
    this.dc = q<HTMLCanvasElement>('dust');
    this.dctx = this.dc.getContext('2d')!;
    this.el = {
      ribbon: q('ribbon'), paperGlow: q('paperGlow'), candle: q('candle'), shade: q('shade'),
      halo: q('halo'), candleImg: q<HTMLImageElement>('candleImg'), flameGlow: q('flameGlow'), flame: q('flame'),
      veil: q('veil'), seen: q('seen'), backBtn: q('backBtn'), favBtn: q('favBtn'),
      favListBtn: q('favListBtn'), setBtn: q('setBtn'), toast: q('toast'), favPanel: q('favPanel'),
    };
    this.el.veil.style.transition = 'opacity 1.4s ease';
    this.el.candleImg.addEventListener('error', () => { this.el.candleImg.style.display = 'none'; });
    this.el.candleImg.addEventListener('load', () => this.candleLit());
    if (this.el.candleImg.complete && this.el.candleImg.naturalWidth > 0) this.candleLit();

    this.layout();
    addEventListener('resize', () => { this.layout(); this.draw(); this.placeRibbon(false); this.dustLayout(); });
    this.dustLayout();

    this.bindInput();
    // v2: 読書に入るまでは1バイトも落とさない（ページ画像・裏紙・書斎の絵・ロウソクの絵）。
    //     iframe 版は「iframe を作った瞬間」が境目だったので、その境目を open() に移した。
    this.draw();
    this.dustLoop(0);
    this.flickerLoop(performance.now());
  }

  // ---------------------------------------------------------- 出入り
  /** mode: 'read' | 'fav' | 'resume' | 'fresh' */
  open(mode: string): void {
    this.opened = true;                                  // これ以降だけ画像を落とす
    if (!this.el.candleImg.getAttribute('src')) this.el.candleImg.setAttribute('src', asset('candle.webp'));
    if (!this.backTex) this.loadImg(asset('backside.jpg')).then(im => { this.backTex = im; });
    setTimeout(() => { if (!this.imgs[this.deck[this.index]]) this.firstReady(); }, 6000);
    this.root.classList.add('show');
    this.cv.classList.add('in'); this.cv.classList.add('sway');
    this.rampGlow(1.0, 3600);                            // 暗い所から徐々に灯る（KEI 2026-09-04）
    this.pagesReady.then(() => {
      this.draw(); this.updateFavUI();
      [300, 1200, 2600].forEach(ms => setTimeout(() => { this.layout(); this.draw(); this.placeRibbon(false); }, ms));
    });
    this.showButtons();
    if (mode === 'fresh') clearBookmark();
    if (mode === 'fav') this.enterFavBook();
    if (mode === 'resume' || mode === 'read') {
      const b = loadBookmark();
      if (b && b.deck.every(n => n >= 0 && n < N)) {
        this.deck = b.deck; this.index = Math.min(b.index, this.deck.length - 1); this.favMode = !!b.fav;
        this.draw(); this.updateFavUI();
      }
    }
    this.opened = true;
    this.uiWake();
    this.pump();
  }
  /** 本を閉じる儀式（ページの世界が先に沈む） */
  closeRitual(): void {
    this.root.classList.add('uihide');
    this.cv.classList.remove('sway'); this.cv.classList.add('out');
    this.rampGlow(0, 1200);
    this.hideRibbon();
  }
  /** 完全に退場（シェルが本の画面に戻ったあと） */
  hide(): void {
    this.opened = false;
    this.root.classList.remove('show');
    this.cv.classList.remove('out', 'in', 'sway');
    this.glowBase = 0; this.lampLevel = 0;
    this.el.paperGlow.style.opacity = '0';
  }
  get isOpen(): boolean { return this.opened; }
  get pageCount(): number { return this.seenSet.size; }

  // ---------------------------------------------------------- 版面
  private shuffled(a: number[]): number[] {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  private pg(k: number): HTMLImageElement | null { const p = this.deck[k]; return p == null ? null : this.imgs[p]; }
  private layout(): void {
    const vw = innerWidth, vh = innerHeight;
    this.H = Math.min(vh * 0.72, vw * 0.92 * 4 / 3); this.W = this.H * 3 / 4;
    this.DPR = Math.min(devicePixelRatio || 1, MOBILE ? 1.5 : 1.75);
    this.cv.style.width = this.W + 'px'; this.cv.style.height = this.H + 'px';
    this.cv.width = Math.round(this.W * this.DPR); this.cv.height = Math.round(this.H * this.DPR);
    this.TRAVEL = Math.max(180, Math.min(this.W * 1.05, vw * 0.72));
  }

  // ---------------------------------------------------------- 画像（先読み + LRU ±12）
  private loadImg(src: string): Promise<HTMLImageElement | null> {
    return new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
  }
  private releaseFar(): void {
    if (this.loadedSet.size <= KEEP * 2 + 4) return;
    const lo = Math.max(0, this.index - KEEP), hi = Math.min(this.deck.length - 1, this.index + KEEP);
    const keep = new Set<number>();
    for (let k = lo; k <= hi; k++) keep.add(this.deck[k]);
    for (const i of Array.from(this.loadedSet)) {
      if (keep.has(i)) continue;
      const im = this.imgs[i];
      this.imgs[i] = null; this.loadedSet.delete(i);
      if (im) { try { im.removeAttribute('src'); } catch { /* noop */ } }
    }
  }
  private ensure(i: number, prio: boolean): void {
    if (i < 0 || i >= N || this.imgs[i] || this.loading.has(i)) return;
    if (!prio && this.loading.size >= MAX_PAR) return;
    this.loading.add(i);
    this.loadImg(SRC(i)).then(im => {
      this.imgs[i] = im; this.loading.delete(i); if (im) this.loadedSet.add(i);
      const k = this.deck.indexOf(i);
      if (k >= this.index - 1 && k <= this.index + 1) this.draw();
      if (i === this.deck[0] || i === this.deck[this.index]) this.firstReady();
      this.pump();
    });
  }
  private pump(): void {
    if (!this.opened) return;                            // 読書に入るまでページは読まない
    for (let d = 0; d <= AHEAD; d++) { const k = this.index + d; if (k >= 0 && k < this.deck.length) this.ensure(this.deck[k], d <= 1); }
    for (let d = 1; d <= BEHIND; d++) { const k = this.index - d; if (k >= 0) this.ensure(this.deck[k], false); }
    this.releaseFar();
  }

  // ---------------------------------------------------------- 栞の紐
  private placeRibbon(animate: boolean): void {
    const r = this.cv.getBoundingClientRect();
    const tail = Math.round(Math.max(52, r.height * 0.11)), rh = Math.round(r.height * 0.96 + tail);
    const el = this.el.ribbon;
    el.style.height = rh + 'px';
    el.style.left = Math.round(r.left + r.width * 0.71) + 'px';
    const top = Math.round(r.top - tail);
    if (animate) {
      el.classList.remove('sway');
      el.style.transition = 'none';
      el.style.top = Math.round(r.top - rh - 6) + 'px';
      void el.offsetHeight;
      el.style.transition = '';
      el.classList.add('show');
      requestAnimationFrame(() => { el.style.top = top + 'px'; });
      setTimeout(() => el.classList.add('sway'), 1200);
    } else {
      el.style.transition = 'none'; el.style.top = top + 'px'; void el.offsetHeight; el.style.transition = '';
    }
  }
  private showRibbon(animate: boolean): void {
    if (this.ribbonShown && !animate) return;
    this.ribbonShown = true; this.placeRibbon(animate);
    if (!animate) this.el.ribbon.classList.add('show', 'sway');
  }
  private hideRibbon(): void {
    if (!this.ribbonShown) return;
    this.ribbonShown = false; this.el.ribbon.classList.remove('show', 'sway');
  }

  // ---------------------------------------------------------- 印・栞・UI
  private updateSeen(): void {
    if (this.deck[this.index] != null) this.seenSet.add(this.deck[this.index]);
    this.el.seen.innerHTML = '<b>' + this.seenSet.size + '</b>枚目';
  }
  private updateFavUI(): void {
    this.updateSeen();
    const bm = loadBookmark();
    const bmHere = !!(bm && bm.index === this.index && bm.deck[bm.index] === this.deck[this.index]);
    this.el.favListBtn.classList.toggle('on', bmHere);
    if (bmHere) this.showRibbon(false); else this.hideRibbon();
    const on = this.favs.includes(this.deck[this.index]);
    this.el.favBtn.querySelector('span')!.textContent = '印';
    this.el.favBtn.querySelector('b')!.textContent = on ? '♥' : '♡';
    this.el.favBtn.classList.toggle('on', on);
  }
  private toast(text: string): void {
    if (this._toastT) { clearTimeout(this._toastT); this._toastT = null; }
    const t = this.el.toast;
    t.textContent = text; t.classList.remove('hide'); void t.offsetHeight; t.classList.add('show');
    this._toastT = setTimeout(() => { t.classList.remove('show'); t.classList.add('hide'); this._toastT = null; }, 1500);
  }
  private stampAnim(): void {
    const step = (now: number) => {
      if (!this.favStamp) return;
      this.draw();
      if (now - this.favStamp.t0 < 700) requestAnimationFrame(step);
      else { this.favStamp = null; this.draw(); }
    };
    step(performance.now());
  }
  private enterFavBook(): void {
    const list = this.favs.slice().sort((a, b) => a - b);
    if (!list.length) { this.el.favPanel.style.display = 'flex'; return; }
    this.favMode = true; this.deck = list; this.index = 0; this.flip = null; this.anim = null;
    this.pump(); this.draw(); this.updateFavUI(); pageSound(0.6);
  }
  private showButtons(): void {
    this.el.favBtn.classList.add('show');
    this.el.favListBtn.classList.add('show');
    this.el.seen.classList.add('show');
    this.el.setBtn.classList.add('show');
    this.el.backBtn.classList.add('show');
    this.updateFavUI();
  }
  paintSound(on: boolean): void {
    const b = this.el.setBtn.querySelector('b');
    if (!b) return;
    b.innerHTML = on
      ? '<svg width="18" height="16" viewBox="0 0 24 20" fill="none" stroke="#c9a24a" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M3 7h4l5-4v14l-5-4H3z"/><path d="M15.5 6.5a5 5 0 0 1 0 7"/><path d="M18.5 4a9 9 0 0 1 0 12"/></svg>'
      : '<svg width="18" height="16" viewBox="0 0 24 20" fill="none" stroke="#8a7a58" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M3 7h4l5-4v14l-5-4H3z"/><path d="M16 7l5 6M21 7l-5 6"/></svg>';
  }
  private uiWake(): void {
    if (this.root.classList.contains('uihide')) this.uiJustWoke = performance.now();
    this.root.classList.remove('uihide');
    if (this.uiTimer) clearTimeout(this.uiTimer);
    this.uiTimer = setTimeout(() => this.root.classList.add('uihide'), 2500);
  }

  // ---------------------------------------------------------- 紙の幾何（KEI確定・変更禁止）
  private peel(t: number, pw: number, ph: number) {
    const fy = this.grab.fy, gdy = this.grab.dy;
    const sag = 1 - Math.min(1, Math.abs(fy - 0.5) * 2);
    const C = { x: pw, y: ph * fy };
    const P1 = { x: pw * (0.05 - sag * 0.22), y: ph * (fy + (0.5 - fy) * 1.6) + gdy * 0.45 };
    const P2 = { x: -pw * (1.7 + sag * 0.35), y: ph * (fy - (0.5 - fy) * 0.4) + gdy * 0.7 };
    const u = 1 - t;
    const M = { x: u * u * C.x + 2 * t * u * P1.x + t * t * P2.x, y: u * u * C.y + 2 * t * u * P1.y + t * t * P2.y };
    const dx = M.x - C.x, dy = M.y - C.y;
    const len = Math.hypot(dx, dy) || 1;
    const n = { x: dx / len, y: dy / len };
    const mid = { x: (C.x + M.x) / 2, y: (C.y + M.y) / 2 };
    const k = mid.x * n.x + mid.y * n.y;
    return { n, k, mid, C, M };
  }
  private sd(p: Pt, g: { n: Pt; k: number }): number { return p.x * g.n.x + p.y * g.n.y - g.k; }
  private clipPoly(poly: Pt[], g: { n: Pt; k: number }, keepNeg: boolean): Pt[] {
    const out: Pt[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = this.sd(a, g), db = this.sd(b, g);
      const ina = keepNeg ? da <= 0 : da >= 0, inb = keepNeg ? db <= 0 : db >= 0;
      if (ina) out.push(a);
      if (ina !== inb) { const f = da / (da - db); out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }); }
    }
    return out;
  }
  private pathPoly(poly: Pt[]): void {
    const ctx = this.ctx;
    ctx.beginPath();
    poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
  }

  // ---------------------------------------------------------- 描画
  private draw(): void { this.drawInner(); this.lampOverlay(); }
  private smoothNoise(t: number): number { return Math.sin(t * 0.61) * 0.5 + Math.sin(t * 1.37 + 1.3) * 0.3 + Math.sin(t * 0.23 + 2.1) * 0.2; }
  private gustFn(s: number): void { this._fl.gust = Math.min(1.2, this._fl.gust + s); }

  private lampOverlay(): void {
    if (this.lampLevel <= 0.001) return;
    const ctx = this.ctx, pw = this.W - EDGE, ph = this.H - EDGE;
    const n = this.smoothNoise(this._fl.t), cur = this._fl.cur;
    const gu = this._fl.gust, gj = gu * Math.sin(this._fl.t * 41) * 0.5 + gu * 0.5;
    const lv = Math.max(0, Math.min(1, this.lampLevel * (0.85 + n * 0.12 + cur * 0.35 + gj * 0.22)));
    const n2 = this.smoothNoise(this._fl.t * 1.7 + 3.1);
    const cx = pw * (0.80 + n * 0.04 + n2 * 0.02 + gu * Math.sin(this._fl.t * 33) * 0.05);
    const cy = ph * (0.82 + n * 0.03 - gu * 0.03);
    const r = Math.max(pw, ph) * (1.05 + n * 0.10 + cur * 0.18 + gj * 0.12);
    ctx.save();
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    this.sheen(pw, ph);
    ctx.globalCompositeOperation = 'multiply';
    let g = ctx.createRadialGradient(cx, cy, r * 0.18, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(214,188,150,1)');
    g.addColorStop(1, 'rgba(70,48,28,1)');
    ctx.globalAlpha = lv * 0.9; ctx.fillStyle = g; ctx.fillRect(0, 0, pw, ph);
    ctx.globalCompositeOperation = 'overlay';
    g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.75);
    g.addColorStop(0, 'rgba(255,196,120,' + (0.62 + n2 * 0.12).toFixed(3) + ')');
    g.addColorStop(0.5, 'rgba(255,150,70,0.20)');
    g.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.globalAlpha = lv; ctx.fillStyle = g; ctx.fillRect(0, 0, pw, ph);
    if (PAPER) {
      const ax = pw * (0.98 + gu * 0.02), ay = ph * (0.96 - n * 0.02);
      let lg = ctx.createLinearGradient(ax, ay, pw * 0.15, ph * 0.05);
      lg.addColorStop(0, 'rgba(255,178,80,' + (0.30 + n * 0.05 + cur * 0.12 + gj * 0.10).toFixed(3) + ')');
      lg.addColorStop(0.45, 'rgba(255,160,70,0.08)'); lg.addColorStop(1, 'rgba(255,150,60,0)');
      ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = lv; ctx.fillStyle = lg; ctx.fillRect(0, 0, pw, ph);
      lg = ctx.createLinearGradient(pw * 0.05, ph * 0.05, ax, ay);
      lg.addColorStop(0, 'rgba(28,18,10,' + (0.34 - cur * 0.10).toFixed(3) + ')');
      lg.addColorStop(0.55, 'rgba(28,18,10,0.06)'); lg.addColorStop(1, 'rgba(28,18,10,0)');
      ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = lv; ctx.fillStyle = lg; ctx.fillRect(0, 0, pw, ph);
      const eg = ctx.createLinearGradient(pw - 18, 0, pw, 0);
      eg.addColorStop(0, 'rgba(255,220,160,0)');
      eg.addColorStop(1, 'rgba(255,220,160,' + (0.22 + gj * 0.15).toFixed(3) + ')');
      ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = lv * 0.8; ctx.fillStyle = eg; ctx.fillRect(pw - 18, 0, 18, ph);
    }
    ctx.restore();
  }
  private gutter(pw: number, ph: number, k: number): void {
    const ctx = this.ctx, w = pw * 0.07, a = 0.16 + 0.20 * k;
    const gr = ctx.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0, 'rgba(20,12,4,' + a.toFixed(3) + ')');
    gr.addColorStop(0.5, 'rgba(20,12,4,' + (a * 0.3).toFixed(3) + ')');
    gr.addColorStop(1, 'rgba(20,12,4,0)');
    ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = gr; ctx.fillRect(0, 0, w, ph); ctx.restore();
  }
  private drawSealFor(pw: number, ph: number, page: number | undefined): void {
    if (page == null || !this.favs.includes(page)) return;
    const ctx = this.ctx;
    let s = 1, al = 1, flash = 0;
    if (this.favStamp && page === this.deck[this.index]) {
      const k = Math.min(1, (performance.now() - this.favStamp.t0) / 700);
      const e = k < 0.35 ? k / 0.35 : 1;
      s = 1.9 - 0.9 * (1 - Math.pow(1 - e, 3)); al = Math.min(1, e * 1.4);
      flash = k > 0.3 ? Math.max(0, 1 - (k - 0.3) / 0.7) : 0;
    }
    const r = Math.max(6, pw * 0.021), cx = pw - r * 2.2, cy = r * 2.4;
    ctx.save();
    ctx.translate(cx, cy); ctx.scale(s, s); ctx.globalAlpha = al;
    if (flash > 0) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 5);
      g.addColorStop(0, 'rgba(255,220,140,' + (0.55 * flash).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(255,200,100,0)');
      ctx.fillStyle = g; ctx.fillRect(-r * 5, -r * 5, r * 10, r * 10);
    }
    ctx.rotate(Math.PI / 4);
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
    const g2 = ctx.createLinearGradient(-r, -r, r, r);
    g2.addColorStop(0, '#f2dc9a'); g2.addColorStop(0.45, '#c9a24a'); g2.addColorStop(0.55, '#a8842e'); g2.addColorStop(1, '#e9cf7e');
    ctx.fillStyle = g2; ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.strokeStyle = 'rgba(80,55,10,.55)'; ctx.lineWidth = Math.max(0.6, r * 0.09); ctx.strokeRect(-r, -r, r * 2, r * 2);
    ctx.strokeStyle = 'rgba(255,245,210,.55)'; ctx.lineWidth = Math.max(0.5, r * 0.07); ctx.strokeRect(-r * 0.62, -r * 0.62, r * 1.24, r * 1.24);
    ctx.fillStyle = 'rgba(90,60,10,.7)'; ctx.beginPath(); ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  private sheen(pw: number, ph: number): void {
    if (!this.tilt.on) return;
    const ctx = this.ctx;
    this.tilt.sx += (this.tilt.x - this.tilt.sx) * 0.12;
    this.tilt.sy += (this.tilt.y - this.tilt.sy) * 0.12;
    const px = pw * (0.5 + this.tilt.sx * 0.9), py = ph * (0.5 + this.tilt.sy * 0.9);
    const g = ctx.createLinearGradient(px - pw * 0.55, py - ph * 0.35, px + pw * 0.55, py + ph * 0.35);
    const a = 0.09 + 0.06 * Math.min(1, Math.hypot(this.tilt.sx, this.tilt.sy) * 2);
    g.addColorStop(0, 'rgba(255,240,200,0)'); g.addColorStop(0.42, 'rgba(255,240,200,0)');
    g.addColorStop(0.5, 'rgba(255,244,210,' + a.toFixed(3) + ')');
    g.addColorStop(0.58, 'rgba(255,240,200,0)'); g.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.fillStyle = g; ctx.fillRect(0, 0, pw, ph); ctx.restore();
  }

  private drawInner(): void {
    this.pump();
    const ctx = this.ctx;
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none'; ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
    ctx.clearRect(0, 0, this.W, this.H);
    const pw = this.W - EDGE, ph = this.H - EDGE;
    const flip = this.flip;

    const remain = Math.max(0, this.deck.length - 1 - this.index - (flip && flip.dir > 0 ? 1 : 0));
    for (let i = Math.min(3, remain); i >= 1; i--) {
      const o = i * 2.4;
      ctx.fillStyle = i % 2 ? '#cbbd9c' : '#bfb08d';
      ctx.fillRect(o, o, pw, ph);
      ctx.fillStyle = 'rgba(60,45,20,0.25)';
      ctx.fillRect(o, o + ph - 1, pw, 1); ctx.fillRect(o + pw - 1, o, 1, ph);
    }

    const cur = this.pg(this.index);
    if (!cur) { ctx.fillStyle = '#1a140c'; ctx.fillRect(0, 0, pw, ph); return; }
    if (!flip) { ctx.drawImage(cur, 0, 0, pw, ph); this.gutter(pw, ph, 0); this.drawSealFor(pw, ph, this.deck[this.index]); return; }
    const under = flip.dir > 0 ? this.pg(this.index + 1) : this.pg(this.index);
    const sheet = flip.dir > 0 ? this.pg(this.index) : this.pg(this.index - 1);
    if (!under || !sheet) { ctx.drawImage(cur, 0, 0, pw, ph); this.gutter(pw, ph, 0); this.drawSealFor(pw, ph, this.deck[this.index]); return; }
    const t = Math.min(Math.max(flip.t, 0.004), 0.996);
    const g = this.peel(t, pw, ph);
    const rect: Pt[] = [{ x: 0, y: 0 }, { x: pw, y: 0 }, { x: pw, y: ph }, { x: 0, y: ph }];
    const frontPoly = this.clipPoly(rect, g, false);
    const foldPoly = this.clipPoly(rect, g, true);

    ctx.drawImage(under, 0, 0, pw, ph);
    this.gutter(pw, ph, Math.sin(Math.PI * t));
    this.drawSealFor(pw, ph, flip.dir > 0 ? this.deck[this.index + 1] : this.deck[this.index]);

    const so = 0.40 * Math.sin(Math.PI * t);
    if (so > 0.01 && foldPoly.length) {
      ctx.save(); this.pathPoly(foldPoly); ctx.clip();
      const sw = Math.min(64, pw * 0.28);
      const gr = ctx.createLinearGradient(g.mid.x, g.mid.y, g.mid.x - g.n.x * sw, g.mid.y - g.n.y * sw);
      gr.addColorStop(0, 'rgba(0,0,0,' + so.toFixed(3) + ')'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, pw, ph);
      ctx.restore();
    }
    if (frontPoly.length) {
      ctx.save(); this.pathPoly(frontPoly); ctx.clip();
      ctx.drawImage(sheet, 0, 0, pw, ph);
      this.drawSealFor(pw, ph, flip.dir > 0 ? this.deck[this.index] : this.deck[this.index - 1]);
      const cw = Math.min(30, pw * 0.12);
      const gr = ctx.createLinearGradient(g.mid.x, g.mid.y, g.mid.x + g.n.x * cw, g.mid.y + g.n.y * cw);
      gr.addColorStop(0, 'rgba(0,0,0,0.28)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, pw, ph);
      ctx.restore();
    }
    if (foldPoly.length) {
      const a = 1 - 2 * g.n.x * g.n.x, b = -2 * g.n.x * g.n.y, d = 1 - 2 * g.n.y * g.n.y;
      const e = 2 * g.k * g.n.x, f = 2 * g.k * g.n.y;
      ctx.save();
      ctx.transform(a, b, b, d, e, f);
      this.pathPoly(foldPoly); ctx.clip();
      if (this.backTex) {
        ctx.drawImage(this.backTex, 0, 0, pw, ph);
        ctx.globalAlpha = 0.16;
        ctx.drawImage(sheet, 0, 0, pw, ph);
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(18,12,5,0.48)'; ctx.fillRect(0, 0, pw, ph);
      } else { ctx.fillStyle = '#5f4f38'; ctx.fillRect(0, 0, pw, ph); }
      const gr = ctx.createLinearGradient(g.mid.x, g.mid.y, g.mid.x + (g.C.x - g.mid.x), g.mid.y + (g.C.y - g.mid.y));
      gr.addColorStop(0, 'rgba(250,238,210,0.10)');
      gr.addColorStop(0.15, 'rgba(250,238,210,0.0)');
      gr.addColorStop(0.45, 'rgba(24,16,6,0.34)');
      gr.addColorStop(1, 'rgba(10,7,3,0.72)');
      ctx.fillStyle = gr; ctx.fillRect(-pw, -ph, pw * 3, ph * 3);
      ctx.restore();
      const flapScreen = foldPoly.map(p => ({ x: a * p.x + b * p.y + e, y: b * p.x + d * p.y + f }));
      ctx.save();
      this.pathPoly(flapScreen);
      ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 14;
      ctx.shadowOffsetX = -6 * Math.sin(Math.PI * t); ctx.shadowOffsetY = 5 * Math.sin(Math.PI * t);
      ctx.strokeStyle = 'rgba(40,30,12,0.35)'; ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---------------------------------------------------------- めくり制御（KEI確定）
  private beginFlip(dir: number): boolean {
    if (dir > 0 && this.index >= this.deck.length - 1) return false;
    if (dir < 0 && this.index <= 0) return false;
    if (!this.pg(this.index + (dir > 0 ? 1 : -1))) return false;
    this.flip = { dir, t: dir > 0 ? 0 : 1 };
    return true;
  }
  private finishFlip(commitTo: number, withSound: boolean, vel?: number): void {
    const flip = this.flip!;
    const from = flip.t, dir = flip.dir;
    const v = Math.min(1, Math.abs(vel || 0) / 1.6);
    const dur = (150 + 430 * Math.abs(commitTo - from)) * (1 - v * 0.35);
    const t0 = performance.now();
    const dist = Math.abs(commitTo - from);
    if (withSound && dist > 0.05) pageSound(dist, vel);
    if (dist > 0.3) this.gustFn(0.5 + v * 0.7);
    this.anim = {};
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      flip.t = from + (commitTo - from) * e;
      this.draw();
      if (k < 1) { this.anim!.raf = requestAnimationFrame(step); }
      else {
        const turned = (dir > 0 && commitTo === 1) || (dir < 0 && commitTo === 0);
        if (dir > 0 && commitTo === 1) this.index++;
        if (dir < 0 && commitTo === 0) this.index--;
        this.flip = null; this.anim = null; this.draw(); this.updateFavUI();
        if (turned) { haptic(8); this.hooks.onFlip({ v: vel || 0, dir, seen: this.seenSet.size }); }
        // （着地後の紙の揺れ settle() は KEI 2026-09-04「ペラッペラで安っぽい」で不採用。関数は残置）
      }
    };
    step(t0);
  }
  /** 残置（KEI 不採用。呼ばない） */
  private settle(dir: number): void {
    if (!this.pg(this.index + 1) || this.flip) return;
    this.settling = true; this.anim = {};
    const t0 = performance.now(), dur = 460, amp = 0.032;
    const keepFy = this.grab.fy; this.grab.dy = 0;
    const step = (now: number) => {
      if (!this.settling) return;
      const k = Math.min(1, (now - t0) / dur);
      this.flip = { dir: +1, t: amp * (1 - k) * (1 - k) * Math.abs(Math.sin(k * Math.PI * 2)) };
      this.draw();
      if (k < 1) this.anim!.raf = requestAnimationFrame(step);
      else { this.settling = false; this.flip = null; this.anim = null; this.grab.fy = keepFy; this.draw(); }
    };
    step(t0);
  }
  private cancelSettle(): void {
    if (!this.settling) return;
    this.settling = false;
    if (this.anim && this.anim.raf) cancelAnimationFrame(this.anim.raf);
    this.flip = null; this.anim = null;
  }
  private startFollow(): void {
    if (this.followRaf) return;
    let prevT = this.flip ? this.flip.t : 0, prevNow = performance.now();
    const fstep = () => {
      if (this.pd && this.pd.started && this.flip) {
        this.flip.t += ((this.pd.tTarget != null ? this.pd.tTarget : this.flip.t) - this.flip.t) * 0.55;
        const now = performance.now();
        prevT = this.flip.t; prevNow = now;
        this.draw();
        this.followRaf = requestAnimationFrame(fstep);
      } else { this.followRaf = null; }
    };
    fstep();
  }

  // ---------------------------------------------------------- 入力
  private bindInput(): void {
    const cv = this.cv;
    cv.addEventListener('pointerdown', e => {
      if (this.settling) this.cancelSettle();
      if (this.anim) return;
      this.firstTouch();
      if (performance.now() - this._actAt > 1000) { this._actAt = performance.now(); this.hooks.onActivity(); }
      const r = cv.getBoundingClientRect();
      this.pd = {
        x0: e.clientX, x: e.clientX, y0: e.clientY, y: e.clientY, t0: performance.now(),
        started: false, tBase: 0, fy: Math.max(0.04, Math.min(0.96, (e.clientY - r.top) / r.height)),
      };
      this.hist = [[e.clientX, performance.now()]];
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', e => {
      const pd = this.pd; if (!pd) return;
      pd.x = e.clientX; pd.y = e.clientY;
      this.hist.push([e.clientX, performance.now()]);
      while (this.hist.length > 2 && performance.now() - this.hist[0][1] > 90) this.hist.shift();
      if (!pd.started) {
        const dx = pd.x - pd.x0;
        if (Math.abs(dx) < 5) return;
        const dir = dx < 0 ? +1 : -1;
        if (!this.beginFlip(dir)) { this.pd = null; return; }
        pd.started = true; pd.tBase = this.flip!.t;
        this.grab.fy = 0.30; this.grab.dy = 0;           // KEI 確定: 右上の角1箇所
        this.startFollow();
      }
      pd.tTarget = Math.max(0, Math.min(1, pd.tBase + (pd.x0 - pd.x) / this.TRAVEL));
    });
    cv.addEventListener('pointerup', () => this.release());
    cv.addEventListener('pointercancel', () => {
      if (this.pd && this.pd.started && this.flip) this.finishFlip(this.flip.dir > 0 ? 0 : 1, false);
      this.pd = null;
    });

    // UI の目覚め
    this.root.addEventListener('pointerdown', e => {
      const y = (e as PointerEvent).clientY / innerHeight;
      if (y > 0.78 || y < 0.14) this.uiWake();
      else if (!this.root.classList.contains('uihide')) this.uiWake();
    }, { passive: true });

    this.el.favBtn.addEventListener('click', () => {
      this.uiWake();
      if (performance.now() - this.uiJustWoke < 400) return;
      this.firstTouch();
      const p = this.deck[this.index];
      const i = this.favs.indexOf(p);
      if (i >= 0) { this.favs.splice(i, 1); sealSound(false); haptic(6); this.toast('印を外しました'); }
      else { this.favs.push(p); this.favStamp = { t0: performance.now() }; sealSound(true); haptic([10, 20, 15]); this.stampAnim(); this.toast('このページに印をつけました'); }
      saveFavs(this.favs); this.updateFavUI();
      this.hooks.onFav({ count: this.favs.length, on: i < 0 });
    });
    this.el.favListBtn.addEventListener('click', () => {
      this.uiWake();
      if (performance.now() - this.uiJustWoke < 400) return;
      this.firstTouch();
      const bm0 = loadBookmark();
      if (bm0 && bm0.index === this.index && bm0.deck[bm0.index] === this.deck[this.index]) {
        clearBookmark();
        this.hideRibbon(); this.el.favListBtn.classList.remove('on');
        sealSound(false); haptic(6); this.hooks.onBookmark({ off: true });
        this.toast('栞を外しました');
        return;
      }
      const b: Bookmark = { deck: this.deck, index: this.index, ts: Date.now(), fav: this.favMode };
      saveBookmark(b);
      this.toast('このページに栞を挟みました');
      this.showRibbon(true); ribbonSound(); haptic([10, 20, 15]);
      this.el.favListBtn.classList.add('on'); this.hooks.onBookmark({ off: false });
    });
    this.el.setBtn.addEventListener('click', () => { ensureAudio(); uiClick(); this.hooks.onSoundToggle(); });
    this.el.backBtn.addEventListener('click', () => { ensureAudio(); uiClick(); this.hooks.onClose(); });
    this.root.querySelector('#favClose')!.addEventListener('click', () => { ensureAudio(); uiClick(); this.el.favPanel.style.display = 'none'; });
  }
  private firstTouch(): void {
    ensureAudio();
    if (!this._touched) { this._touched = true; this.hooks.onFirstTouch(); }
  }
  private release(): void {
    const pd = this.pd; if (!pd) return;
    const dt = performance.now() - pd.t0, dx = pd.x - pd.x0;
    if (!pd.started) {
      if (dt < 300 && Math.abs(dx) < 8) {
        const dir = pd.x0 > innerWidth / 2 ? +1 : -1;
        this.grab.fy = 0.30; this.grab.dy = 0;
        if (this.beginFlip(dir)) this.finishFlip(dir > 0 ? 1 : 0, true, 0.6);
      }
      this.pd = null; return;
    }
    let vx = 0;
    if (this.hist.length >= 2) {
      const a = this.hist[0], b = this.hist[this.hist.length - 1];
      if (b[1] > a[1]) vx = (b[0] - a[0]) / (b[1] - a[1]);
    }
    const cur = pd.tTarget != null ? pd.tTarget : this.flip!.t;
    let commitTo: number;
    if (this.flip!.dir > 0) commitTo = (cur > 0.4 || vx < -0.4) ? 1 : 0;
    else commitTo = (cur < 0.6 || vx > 0.4) ? 0 : 1;
    this.finishFlip(commitTo, true, vx);
    this.pd = null;
  }

  // ---------------------------------------------------------- 塵・火の粉
  private dustLayout(): void {
    this.dc.width = innerWidth; this.dc.height = innerHeight;
    const n = Math.round(innerWidth * innerHeight / (MOBILE ? 70000 : 40000));
    this.motes = Array.from({ length: n }, () => ({
      x: Math.random() * this.dc.width, y: Math.random() * this.dc.height,
      r: 0.6 + Math.random() * 1.6, a: 0.03 + Math.random() * 0.10,
      vx: (Math.random() - 0.5) * 0.12, vy: -(0.05 + Math.random() * 0.16),
      ph: Math.random() * Math.PI * 2,
    }));
  }
  private spawnEmber(): void {
    this.embers.push({
      x: this.dc.width * (0.62 + Math.random() * 0.36), y: this.dc.height * (0.78 + Math.random() * 0.22),
      r: 0.9 + Math.random() * 1.9, a: 0.55 + Math.random() * 0.4,
      vx: (Math.random() - 0.5) * 0.25, vy: -(0.35 + Math.random() * 0.65), sway: 14 + Math.random() * 26,
      ph: Math.random() * Math.PI * 2, life: 0.8 + Math.random() * 0.5, px: 0, py: 0,
      hot: Math.random() < 0.22,
    });
  }
  private dustLoop = (ts: number): void => {
    const dctx = this.dctx, dc = this.dc;
    if (!this.opened) { requestAnimationFrame(this.dustLoop); return; }   // 読書中以外は描かない（電池）
    dctx.clearRect(0, 0, dc.width, dc.height);
    if (this.glowBase > 0) {
      if (Math.random() < 0.03) this.glowTarget = 0.55 + Math.random() * 0.45;
      this.glowFl += (this.glowTarget - this.glowFl) * 0.04;
      const gx = dc.width / 2, gy = dc.height * 0.56;
      const gr0 = Math.min(dc.width, dc.height) * (0.30 + 0.04 * Math.sin(ts / 700));
      const al = this.glowBase * 0.16 * this.glowFl;
      const gg = dctx.createRadialGradient(gx, gy, 0, gx, gy, gr0 * 2.1);
      gg.addColorStop(0, 'rgba(255,176,70,' + al.toFixed(3) + ')');
      gg.addColorStop(0.45, 'rgba(255,150,60,' + (al * 0.5).toFixed(3) + ')');
      gg.addColorStop(1, 'rgba(255,130,50,0)');
      dctx.fillStyle = gg; dctx.fillRect(0, 0, dc.width, dc.height);
    }
    for (const m of this.motes) {
      m.x += m.vx + Math.sin(ts / 2400 + m.ph) * 0.06; m.y += m.vy;
      if (m.y < -4) { m.y = dc.height + 4; m.x = Math.random() * dc.width; }
      if (m.x < -4) m.x = dc.width + 4; if (m.x > dc.width + 4) m.x = -4;
      const tw = 0.6 + 0.4 * Math.sin(ts / 900 + m.ph * 3);
      dctx.fillStyle = 'rgba(255,226,170,' + (m.a * tw).toFixed(3) + ')';
      dctx.beginPath(); dctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); dctx.fill();
    }
    if (this.embers.length < (MOBILE ? 10 : 18) && Math.random() < 0.07) this.spawnEmber();
    dctx.save();
    dctx.globalCompositeOperation = 'lighter';
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i];
      e.life -= 0.0022 + e.r * 0.0004;
      e.vx += (Math.sin(ts / 900 + e.ph) * 0.012 + (Math.random() - 0.5) * 0.02);
      e.vx *= 0.985;
      e.px = e.x; e.py = e.y;
      e.x += e.vx; e.y += e.vy * (0.75 + 0.25 * Math.sin(ts / 700 + e.ph * 2));
      if (e.y < -10 || e.life <= 0 || e.x < -10 || e.x > dc.width + 10) { this.embers.splice(i, 1); continue; }
      const tw = 0.55 + 0.45 * Math.sin(ts / (90 + e.ph * 40) + e.ph * 7);
      const al = Math.min(1, e.life * 1.6) * tw * e.a;
      const rr = e.r * (0.7 + 0.3 * e.life);
      dctx.strokeStyle = 'rgba(255,150,60,' + (al * 0.35).toFixed(3) + ')';
      dctx.lineWidth = Math.max(0.6, rr * 0.7);
      dctx.beginPath(); dctx.moveTo(e.px - e.vx * 3, e.py - e.vy * 3); dctx.lineTo(e.x, e.y); dctx.stroke();
      const gr = dctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, rr * 5);
      gr.addColorStop(0, (e.hot ? 'rgba(255,236,190,' : 'rgba(255,190,110,') + (al * 0.9).toFixed(3) + ')');
      gr.addColorStop(0.25, (e.hot ? 'rgba(255,180,80,' : 'rgba(230,110,40,') + (al * 0.45).toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(255,110,30,0)');
      dctx.fillStyle = gr;
      dctx.beginPath(); dctx.arc(e.x, e.y, rr * 5, 0, Math.PI * 2); dctx.fill();
      dctx.fillStyle = (e.hot ? 'rgba(255,246,220,' : 'rgba(255,200,130,') + Math.min(0.95, al * (e.hot ? 1.3 : 0.9)).toFixed(3) + ')';
      dctx.beginPath(); dctx.arc(e.x, e.y, rr * 0.55, 0, Math.PI * 2); dctx.fill();
    }
    dctx.restore();
    requestAnimationFrame(this.dustLoop);
  };

  // ---------------------------------------------------------- ろうそくの明滅
  private candleLit(): void {
    if (this.candleOn) return;
    this.candleOn = true;
    setTimeout(() => this.el.candleImg.classList.add('on'), 800);
  }
  private _flPrev = performance.now();
  private flickerLoop = (now: number): void => {
    if (!this.opened) { this._flPrev = now; requestAnimationFrame(this.flickerLoop); return; }
    const dt = Math.min((now - this._flPrev) / 1000, 0.1); this._flPrev = now; this._fl.t += dt;
    if (this._fl.gust > 0.001) { this._fl.gust *= Math.exp(-dt / 0.42); if (this._fl.gust < 0.001) this._fl.gust = 0; }
    if (this._fl.t > this._fl.next) {
      this._fl.tgt = Math.random() < 0.45 ? -0.35 - Math.random() * 0.25 : 0;
      this._fl.next = this._fl.t + 8 + Math.random() * 12;
    }
    this._fl.cur += (this._fl.tgt - this._fl.cur) * (1 - Math.exp(-dt / 1.2));
    if (this._fl.tgt !== 0 && Math.abs(this._fl.cur - this._fl.tgt) < 0.03) this._fl.tgt = 0;
    const n = this.smoothNoise(this._fl.t);
    const lvl = 0.95 + n * 0.05 + this._fl.cur * 0.45;
    this.el.candle.style.opacity = lvl.toFixed(3);
    const dx = this.smoothNoise(this._fl.t * 0.8 + 5) * 0.9, dy = this.smoothNoise(this._fl.t * 0.7 + 9) * 0.6, sc = 1 + n * 0.02;
    this.el.shade.style.transform = 'translate(' + dx.toFixed(2) + '%,' + dy.toFixed(2) + '%) scale(' + sc.toFixed(3) + ')';
    this.el.shade.style.opacity = (0.86 - this._fl.cur * 0.3).toFixed(3);
    const gj = this._fl.gust * (0.5 + 0.5 * Math.sin(this._fl.t * 41));
    this.el.halo.style.opacity = Math.min(1, 0.95 + n * 0.10 + this._fl.cur * 0.4 + gj * 0.25).toFixed(3);
    this.el.flame.style.transform = 'scaleY(' + (0.92 + n * 0.10 + this._fl.cur * 0.25).toFixed(3) + ') scaleX(' + (0.96 + n * 0.05).toFixed(3) + ') skewX(' + (dx * 4).toFixed(1) + 'deg)';
    this.el.flame.style.opacity = (0.9 + n * 0.08 + this._fl.cur * 0.2).toFixed(3);
    this.el.halo.style.transform = 'translate(' + (35 + dx).toFixed(1) + '%,' + (40 + dy).toFixed(1) + '%) scale(' + (1 + n * 0.03).toFixed(3) + ')';
    if (this.candleOn) {
      const r = this.el.candleImg.getBoundingClientRect();
      const fx = r.left + r.width * 0.43, fy = r.top + r.height * 0.23;
      const fast = Math.sin(this._fl.t * 9.1) * 0.5 + Math.sin(this._fl.t * 13.7 + 1) * 0.3 + Math.sin(this._fl.t * 23 + 2) * 0.2;
      this.el.flameGlow.style.left = (fx + fast * 2.5 + gj * 6).toFixed(1) + 'px';
      this.el.flameGlow.style.top = (fy + fast * 1.5).toFixed(1) + 'px';
      this.el.flameGlow.style.opacity = Math.max(0, Math.min(1, 0.55 + n * 0.18 + this._fl.cur * 0.35 + fast * 0.08 + gj * 0.3)).toFixed(3);
      this.el.flameGlow.style.transform = 'scale(' + (0.9 + n * 0.12 + fast * 0.06 + gj * 0.25).toFixed(3) + ',' + (1.0 + n * 0.16 + fast * 0.10 + gj * 0.3).toFixed(3) + ')';
    }
    if (this.glowBase > 0) {
      this.el.paperGlow.style.opacity = (this.glowBase * (0.95 + n * 0.20 + this._fl.cur * 0.35)).toFixed(3);
      this.el.paperGlow.style.transform = 'translate(-50%,-50%) scale(' + (1 + n * 0.02).toFixed(3) + ')';
      const vt = this._fl.cur < -0.15 ? 0.10 : 0.02;
      this.el.veil.style.opacity = vt.toFixed(3);
    }
    // 炎の揺れが前回の描画からほとんど動いていない時は描き直さない（見た目は同じ・CPUだけ下がる）
    if (this.lampLevel > 0.001 && !this.flip && (++this._lampTick % (MOBILE ? 3 : 2) === 0 || this._fl.gust > 0.01 || this.tilt.on)) {
      const n2f = this.smoothNoise(this._fl.t * 1.7 + 3.1);
      const sig = n + n2f * 0.5 + this._fl.cur + this._fl.gust * 2;
      if (this.tilt.on || Math.abs(sig - this._lampSig) > 0.008) { this._lampSig = sig; this.draw(); }
    }
    requestAnimationFrame(this.flickerLoop);
  };
  private rampGlow(target: number, ms: number): void {
    if (this.glowRaf) cancelAnimationFrame(this.glowRaf);
    const from = this.glowBase, t0 = performance.now();
    const gstep = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      this.glowBase = from + (target - from) * (1 - Math.pow(1 - k, 2));
      this.lampLevel = this.glowBase;
      this.draw();
      if (k < 1) this.glowRaf = requestAnimationFrame(gstep); else this.glowRaf = null;
    };
    gstep(t0);
  }

  /** 端末の傾き（箔押し・インクの艶） */
  listenTilt(): void {
    addEventListener('deviceorientation', ev => {
      if (ev.gamma == null || ev.beta == null) return;
      this.tilt.on = true;
      this.tilt.x = Math.max(-1, Math.min(1, ev.gamma / 35));
      this.tilt.y = Math.max(-1, Math.min(1, (ev.beta - 45) / 35));
    }, { passive: true });
  }

  readonly debug = () => ({ lru: this.imgs.filter(Boolean).length, index: this.index, deck: this.deck.length, favs: this.favs.length });
}
