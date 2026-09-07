// ============================================================
// 本の画面のUI（KEI指示 2026-09-07 夜・前の形に戻す）
//   - 下に「この本の説明」＋「栞／音量／印」の3つ。本の画面では常に表示（自動で消えない）。「この本を読む」ボタンは置かない（2回タップで開く）
//   - 表示から5秒後、画面中央に細い金の罫線1本と一文「2回タップで、本を読む」
//   - 本を開くのはダブルタップ（300ms以内の2回）だけ。1回タップは何もしない
//   - 「この本の説明」= 画面中央の縦パネル（この本の説明／操作説明／印の使い方／栞の使い方の4ページ。1文=1行）
//   - 栞 = 栞のページから続きを読む／印 = 印のページだけを綴じた本を開く／音量 = 音の一括スイッチ
// ============================================================
import { hasBookmark, favCount, a2hsSeen, a2hsMark } from '../state';
import { SPK_ON, SPK_OFF } from '../audio';

const HINT_DELAY = 2000;
const DOUBLE_TAP = 300;
const RIB_ICO = '<svg width="14" height="18" viewBox="0 0 14 18" fill="none" stroke="#c9a24a" stroke-width="1.3"><path d="M2 1h10v16l-5-4-5 4z"/></svg>';

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
  private soundBtn: HTMLButtonElement;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private tabIdx = 0;
  private lastTap = 0;
  private locked = false;                       // 開く演出中・読書中は反応しない

  constructor(private hooks: UiHooks) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
<div id="hint"><div class="rule"></div><div class="txt">2回タップで、本を読む</div></div>
<div id="ui">
  <button class="seal sub" id="bInfo">この本の説明</button>
  <div class="row">
    <button class="ico" id="bResume"><b>${RIB_ICO}</b>栞</button>
    <button class="ico" id="bSound"><b>${SPK_ON}</b>音量</button>
    <button class="ico" id="bFav"><b>♥</b>印</button>
  </div>
</div>
<div id="a2hs"><span>ホーム画面に追加すると、枠のない全画面で読める</span><button id="a2hsX" aria-label="閉じる">✕</button></div>
<div class="ov" id="menu"><div class="box frame">
  <h2>名言の書</h2>
  <div class="rule"></div>
  <p class="h" id="tabTitle">この本の説明</p>
  <div class="tabbody">
  <div class="tab" data-tab="0">
    <p>異世界の叡智が、これまでに集めた言葉をすべて綴じた一冊。</p>
    <p>開くたびに、ページの並びが変わる。</p>
    <p>同じ順で読めることは、二度とないらしい。</p>
    <p>どのページから読んでも、ひとつの言葉で完結している。</p>
    <p>言葉は、今も増え続けている。</p>
  </div>
  <div class="tab" data-tab="1" hidden>
    <p>本の画面を2回タップすると、本が開く。</p>
    <p>右から左になぞると、次のページ。</p>
    <p>左から右になぞると、前のページ。</p>
    <p>読んでいる間、ボタンは闇に溶ける。</p>
    <p>画面の下に触れると、戻ってくる。</p>
    <p>「戻る」で、本を閉じる。</p>
  </div>
  <div class="tab" data-tab="2" hidden>
    <p>気に入ったページで「印」を押す。</p>
    <p>ページの角に、金の印がつく。</p>
    <p>本の画面の「印」を押すと、印のページだけを綴じた本が開く。</p>
    <p>もう一度「印」を押すと、印は外れる。</p>
  </div>
  <div class="tab" data-tab="3" hidden>
    <p>読んでいる途中で「栞」を押す。</p>
    <p>そのページに栞が挟まり、本は一度閉じる。</p>
    <p>次に本を開くと、栞のページから続きが読める。</p>
    <p>めくった枚数も、そのまま残る。</p>
    <p>栞は一本だけ。</p>
    <p>新しく挟むと、前の栞は外れる。</p>
  </div>
  </div>
  <div class="pnav"><button class="tarrow" id="tabPrev">‹</button><div class="dots"><i class="on"></i><i></i><i></i><i></i></div><button class="tarrow" id="tabNext">›</button></div>
  <button class="close" id="menuClose">閉じる</button>
</div></div>`;
    while (wrap.firstElementChild) document.body.appendChild(wrap.firstElementChild);

    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    this.hint = $('hint'); this.ui = $('ui'); this.menu = $('menu'); this.a2hs = $('a2hs');
    this.soundBtn = $<HTMLButtonElement>('bSound');

    const stop = (e: Event) => e.stopPropagation();
    this.ui.addEventListener('pointerdown', stop);
    this.ui.addEventListener('pointerup', stop);
    $('bInfo').addEventListener('click', () => this.openMenu());
    $('menuClose').addEventListener('click', () => this.closeMenu());
    this.menu.addEventListener('click', e => { if (e.target === this.menu) this.closeMenu(); });
    $('tabPrev').addEventListener('click', () => this.showTab(this.tabIdx - 1));
    $('tabNext').addEventListener('click', () => this.showTab(this.tabIdx + 1));
    this.soundBtn.addEventListener('click', () => this.hooks.onToggleSound());
    $('bResume').addEventListener('click', () => {
      if (this.locked) return;
      if (hasBookmark()) this.hooks.onOpen('resume');
      else this.hooks.onSay('栞は、まだ挟まれていませんね');
    });
    $('bFav').addEventListener('click', () => {
      if (this.locked) return;
      if (favCount() > 0) this.hooks.onOpen('fav', '印のページ');
      else this.hooks.onSay('印のついたページは、まだありませんね');
    });
    $('a2hsX').addEventListener('click', () => this.closeA2hs());
  }

  /** 本が現れたら呼ぶ。UIを出し、5秒後に一文が浮かぶ */
  start(): void {
    this.showUi();
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => { if (!this.locked) this.hint.classList.add('show'); }, HINT_DELAY);
    setTimeout(() => this.maybeA2hs(), 1400);
  }
  setLocked(v: boolean): void {
    this.locked = v;
    if (v) { this.hint.classList.remove('show'); this.hideUi(); this.closeMenu(); this.closeA2hs(); }
  }

  /**
   * 本の画面のタップ。2回=開く。1回は何もしない。
   * ドラッグ（回転）と区別するため、呼ぶ側で「短く動かないタップ」だけを渡す。
   */
  tap(): void {
    if (this.locked || this.menu.classList.contains('show')) return;
    const now = performance.now();
    if (now - this.lastTap < DOUBLE_TAP) {
      this.lastTap = 0;
      this.hint.classList.remove('show');
      this.hooks.onOpen('read');
      return;
    }
    this.lastTap = now;
  }

  showUi(): void { if (!this.locked) this.ui.classList.add('show'); }
  hideUi(): void { this.ui.classList.remove('show'); }

  openMenu(): void {
    if (this.locked) return;
    this.showTab(0);
    this.menu.classList.add('show');
    this.hint.classList.remove('show');
  }
  closeMenu(): void { this.menu.classList.remove('show'); }

  private showTab(n: number): void {
    this.tabIdx = (n + 4) % 4;
    document.querySelectorAll<HTMLElement>('#menu .tab').forEach(el => { el.hidden = +(el.dataset.tab || '0') !== this.tabIdx; });
    document.querySelectorAll<HTMLElement>('#menu .dots i').forEach((el, k) => el.classList.toggle('on', k === this.tabIdx));
    (document.getElementById('tabTitle') as HTMLElement).textContent = ['この本の説明', '操作説明', '印の使い方', '栞の使い方'][this.tabIdx];
  }

  paintSound(on: boolean): void {
    this.soundBtn.innerHTML = '<b>' + (on ? SPK_ON : SPK_OFF) + '</b>音量';
    this.soundBtn.classList.toggle('off', !on);
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
