// ============================================================
// 本の画面のUI（KEI指示 2026-09-07）
//   - 最初の画面は本だけ。ボタンは一切出さない。到着の一言も出さない。
//   - 表示から5秒後、画面中央に細い金の罫線1本と一文「2回タップで、本を読む」
//   - ダブルタップ（300ms以内の2回）で本が開き読書へ
//   - 1回タップで周りにUI（右上の「メニュー」1つだけ・2.5秒無操作で消える）
//   - メニュー = 画面中央に1枚のパネル：①この本の説明（3タブ）②音 ON/OFF
//                ③栞の続きから読む ④印のページだけ読む ⑤新しく開き直す
// ============================================================
import { hasBookmark, a2hsSeen, a2hsMark } from '../state';
import { SPK_ON, SPK_OFF } from '../audio';

const HINT_DELAY = 5000;
const UI_HIDE = 2500;
const DOUBLE_TAP = 300;

export interface UiHooks {
  onOpen: (mode: string, title?: string) => void;
  onToggleSound: () => void;
  onSay: (line: string) => void;
}

export class Ui {
  private hint: HTMLDivElement;
  private ui: HTMLDivElement;
  private menu: HTMLDivElement;
  private a2hs: HTMLDivElement;
  private menuBtn: HTMLButtonElement;
  private soundBtn: HTMLButtonElement;
  private uiTimer: ReturnType<typeof setTimeout> | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private tabIdx = 0;
  private lastTap = 0;
  private tapTimer: ReturnType<typeof setTimeout> | null = null;
  private locked = false;                       // 開く演出中・読書中は反応しない

  constructor(private hooks: UiHooks) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
<div id="hint"><div class="rule"></div><div class="txt">2回タップで、本を読む</div></div>
<div id="ui"><button class="ico" id="bMenu"><b>≡</b>メニュー</button></div>
<div id="a2hs"><span>ホーム画面に追加すると、枠のない全画面で読める</span><button id="a2hsX" aria-label="閉じる">✕</button></div>
<div class="ov" id="menu"><div class="box frame">
  <div class="tabs"><button class="tarrow" id="tabPrev">‹</button><h2 id="tabTitle">名言の書</h2><button class="tarrow" id="tabNext">›</button></div>
  <div class="rule"></div>
  <div class="tabbody">
  <div class="tab" data-tab="0">
    <p>異世界の叡智が集めてきた名言・問い・気づきを、一冊にまとめた本です。</p>
    <p>ページの順番は決まっていません。開くたびに並びが変わります。</p>
    <p>言葉は今も増え続けています。</p>
    <p class="h">読み方</p>
    <p>右から左になぞると、次のページへ進みます。</p>
    <p>左から右になぞると、前のページへ戻ります。</p>
  </div>
  <div class="tab" data-tab="1" hidden>
    <p>気に入ったページで、下の「印」を押します。</p>
    <p>ページの角に金の印がつき、お気に入りとして保存されます。</p>
    <p>本の画面で「印のページだけ読む」を押すと、印をつけたページだけを集めた本が開きます。</p>
    <p>印のページでもう一度「印」を押すと、印が外れます。</p>
  </div>
  <div class="tab" data-tab="2" hidden>
    <p>読んでいる途中で、下の「栞」を押します。</p>
    <p>そのページに栞が挟まり、ページの並びもそのまま保存されます。</p>
    <p>本の画面で「栞の続きから読む」を押すと、栞のページから続きを読めます。</p>
    <p>栞は一本だけです。新しく挟むと、前の栞は外れます。</p>
    <p>栞を挟まずに閉じると、次に開いたときページの並びが変わります。</p>
  </div>
  </div>
  <div class="dots"><i class="on"></i><i></i><i></i></div>
  <hr>
  <div id="menuActs">
    <button class="mode" id="mSound">音 ON<span>音楽・環境音・めくり音をまとめて</span></button>
    <button class="mode" id="mResume">栞の続きから読む<span>栞のページ・その並びのまま開く</span></button>
    <button class="mode" id="mFav">印のページだけ読む<span>印をつけたページだけを綴じ直す</span></button>
    <button class="mode" id="mFresh">新しく開き直す<span>並びをシャッフルし直す。栞は外れる</span></button>
  </div>
  <button class="close" id="menuClose">閉じる</button>
</div></div>`;
    while (wrap.firstElementChild) document.body.appendChild(wrap.firstElementChild);

    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    this.hint = $('hint'); this.ui = $('ui'); this.menu = $('menu'); this.a2hs = $('a2hs');
    this.menuBtn = $<HTMLButtonElement>('bMenu');
    this.soundBtn = $<HTMLButtonElement>('mSound');

    this.menuBtn.addEventListener('click', e => { e.stopPropagation(); this.openMenu(); });
    $('menuClose').addEventListener('click', () => this.closeMenu());
    this.menu.addEventListener('click', e => { if (e.target === this.menu) this.closeMenu(); });
    $('tabPrev').addEventListener('click', () => this.showTab(this.tabIdx - 1));
    $('tabNext').addEventListener('click', () => this.showTab(this.tabIdx + 1));
    this.soundBtn.addEventListener('click', () => this.hooks.onToggleSound());
    $('mResume').addEventListener('click', () => {
      if (hasBookmark()) { this.closeMenu(); this.hooks.onOpen('resume'); }
      else this.hooks.onSay('栞は、まだ挟まれていませんね');
    });
    $('mFav').addEventListener('click', () => { this.closeMenu(); this.hooks.onOpen('fav', '印のページ'); });
    $('mFresh').addEventListener('click', () => { this.closeMenu(); this.hooks.onOpen('fresh'); });
    $('a2hsX').addEventListener('click', () => this.closeA2hs());
  }

  /** 本が現れたら呼ぶ。5秒後に一文が浮かぶ */
  start(): void {
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => { if (!this.locked) this.hint.classList.add('show'); }, HINT_DELAY);
    setTimeout(() => this.maybeA2hs(), 1400);
  }
  setLocked(v: boolean): void {
    this.locked = v;
    if (v) { this.hint.classList.remove('show'); this.hideUi(); this.closeA2hs(); }
  }

  /**
   * 本の画面のタップ。1回=UIを出す / 2回=開く。
   * ドラッグ（回転）と区別するため、呼ぶ側で「短く動かないタップ」だけを渡す。
   */
  tap(): void {
    if (this.locked) return;
    const now = performance.now();
    if (now - this.lastTap < DOUBLE_TAP) {
      this.lastTap = 0;
      if (this.tapTimer) { clearTimeout(this.tapTimer); this.tapTimer = null; }
      this.hint.classList.remove('show');
      this.hooks.onOpen('read');
      return;
    }
    this.lastTap = now;
    if (this.tapTimer) clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => { this.tapTimer = null; this.showUi(); }, DOUBLE_TAP);
  }

  showUi(): void {
    if (this.locked) return;
    this.ui.classList.add('show');
    if (this.uiTimer) clearTimeout(this.uiTimer);
    this.uiTimer = setTimeout(() => this.hideUi(), UI_HIDE);
  }
  hideUi(): void {
    if (this.menu.classList.contains('show')) return;
    this.ui.classList.remove('show');
    if (this.uiTimer) { clearTimeout(this.uiTimer); this.uiTimer = null; }
  }

  openMenu(): void {
    if (this.uiTimer) { clearTimeout(this.uiTimer); this.uiTimer = null; }
    this.showTab(0);
    this.menu.classList.add('show');
    this.hint.classList.remove('show');
  }
  closeMenu(): void { this.menu.classList.remove('show'); this.showUi(); }

  private showTab(n: number): void {
    this.tabIdx = (n + 3) % 3;
    document.querySelectorAll<HTMLElement>('#menu .tab').forEach(el => { el.hidden = +(el.dataset.tab || '0') !== this.tabIdx; });
    document.querySelectorAll<HTMLElement>('#menu .dots i').forEach((el, k) => el.classList.toggle('on', k === this.tabIdx));
    (document.getElementById('tabTitle') as HTMLElement).textContent = ['名言の書', '印', '栞'][this.tabIdx];
  }

  paintSound(on: boolean): void {
    this.soundBtn.innerHTML = (on ? SPK_ON : SPK_OFF) + ' 音 ' + (on ? 'ON' : 'OFF') + '<span>音楽・環境音・めくり音をまとめて</span>';
  }

  // ---- ホーム画面に追加の一言（スタンドアロンでない時・モバイルの時だけ1回きり） ----
  private maybeA2hs(): void {
    const standalone = (() => { try { return matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true; } catch { return false; } })();
    if (standalone || !/iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '')) return;
    if (a2hsSeen()) return;
    this.a2hs.classList.add('show');
    setTimeout(() => this.closeA2hs(), 12000);
  }
  private closeA2hs(): void {
    if (!this.a2hs.classList.contains('show')) return;
    this.a2hs.classList.remove('show'); a2hsMark();
  }
}
