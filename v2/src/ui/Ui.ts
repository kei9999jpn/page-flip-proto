// ============================================================
// 本の画面のUI（KEI指示 2026-09-07 夜・前の形に戻す）
//   - 下に「この本の説明」＋ 横長ボタン2つ「しおりから読む」「お気に入りを読む」（中身がある時だけ・必ず横並び）
//     2026-09-09 KEI: 本の画面に音のボタンは置かない。音の入切は読書画面の「音」ボタン
//     「この本を読む」ボタンは置かない（2回タップで開く）。2026-09-09 KEI: 小さな「栞」「印」の札は意味が分からないので廃止
//   - 表示から5秒後、画面中央に細い金の罫線1本と一文「2回タップで、本を読む」
//   - 本を開くのはダブルタップ（400ms以内の2回）だけ。1回タップは何もしない。PC は Enter / Space でも開く
//   - 「この本の説明」= 画面中央の縦パネル（この本の説明／操作説明／お気に入りの使い方／栞の使い方の4ページ。1文=1行）
//   - しおりから読む = 一番あとに挟んだ栞のページから／お気に入りを読む = お気に入りのページだけを綴じた本を開く
// ============================================================
import { hasBookmark, favCount, a2hsSeen, a2hsMark } from '../state';

const HINT_DELAY = 2000;
const DOUBLE_TAP = 400;   // 2026-09-09 KEI: 2回タップの猶予を広げる

export interface UiHooks {
  onOpen: (mode: string, title?: string) => void;
  onToggleSound: () => void;
  /** true=切り替えた / false=この端末では文書の全画面が使えない(iOS Safari) */
  onToggleFullscreen: () => boolean;
  onSay: (line: string) => void;
}

export class Ui {
  private hint: HTMLDivElement;
  private ui: HTMLDivElement;
  private menu: HTMLDivElement;
  private a2hs: HTMLDivElement;
  private bResume!: HTMLButtonElement;
  private bFav!: HTMLButtonElement;
  private bFs!: HTMLButtonElement;
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
    <button class="seal wide" id="bResume" aria-label="しおりから読む" hidden>しおりから読む</button>
    <button class="seal wide" id="bFav" aria-label="お気に入りを読む" hidden>お気に入りを読む</button>
    <button class="seal wide fs" id="bFs" aria-label="全画面">全画面</button>
  </div>
</div>
<div id="a2hs"><span>ホーム画面に追加すると、枠のない全画面で読める</span><button id="a2hsX" aria-label="閉じる">✕</button></div>
<div class="ov" id="menu"><div class="box frame">
  <h2>名言の書</h2>
  <div class="rule"></div>
  <p class="h" id="tabTitle">この本について</p>
  <div class="tabbody">
  <div class="tab" data-tab="0">
    <p>この本には、異なる世界を生きた者たちの言葉が収められている。迷いの中で選んだ道、守ろうとしたもの、手放したもの。その記録を、一枚ずつ読むための本だ。</p>
    <p>栞がなければ、開くたびに言葉の並びが変わる。はじめから順に読む必要はない。今の自分に届く一文があれば、そこで止まればいい。</p>
    <p>残したい言葉はお気に入りにする。続きは栞に預ける。集められた言葉は、これからも少しずつ、この本に加わっていく。</p>
  </div>
  <div class="tab" data-tab="1" hidden>
    <p>本を2回タップすると、開く。</p>
    <p>左右になぞると、ページがめくれる。</p>
    <p>読んでいる間、ボタンは姿を消す。</p>
    <p>画面の下に触れると、戻ってくる。</p>
  </div>
  <div class="tab" data-tab="2" hidden>
    <p>気に入った言の葉に「お気に入り」を押すと、ページの角に金の印がつく。</p>
    <p>お気に入りにした言の葉だけを、あとで一冊にして読める。</p>
    <p>もう一度押せば、お気に入りは外れる。</p>
  </div>
  <div class="tab" data-tab="3" hidden>
    <p>「栞」を押すと、そのページに栞が挟まる。本はそのまま読み続けられる。</p>
    <p>次に開くとき、本は最後に挟んだ栞のページから始まる。</p>
    <p>栞は何本でも挟める。</p>
    <p>栞のあるページでもう一度押せば、その栞だけが外れる。</p>
  </div>
  </div>
  <div class="pnav"><button class="tarrow" id="tabPrev">‹</button><div class="dots"><i class="on"></i><i></i><i></i><i></i></div><button class="tarrow" id="tabNext">›</button></div>
  <button class="close" id="menuClose">閉じる</button>
</div></div>`;
    while (wrap.firstElementChild) document.body.appendChild(wrap.firstElementChild);

    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    this.hint = $('hint'); this.ui = $('ui'); this.menu = $('menu'); this.a2hs = $('a2hs');

    const stop = (e: Event) => e.stopPropagation();
    this.ui.addEventListener('pointerdown', stop);
    this.ui.addEventListener('pointerup', stop);
    $('bInfo').addEventListener('click', () => this.openMenu());
    $('menuClose').addEventListener('click', () => this.closeMenu());
    this.menu.addEventListener('click', e => { if (e.target === this.menu) this.closeMenu(); });
    $('tabPrev').addEventListener('click', () => this.showTab(this.tabIdx - 1));
    $('tabNext').addEventListener('click', () => this.showTab(this.tabIdx + 1));
    this.bResume = $<HTMLButtonElement>('bResume');
    this.bFav = $<HTMLButtonElement>('bFav');
    this.bResume.addEventListener('click', () => {
      if (this.locked) return;
      if (hasBookmark()) this.hooks.onOpen('resume');
      else this.hooks.onSay('栞は、まだ挟まれていませんね');
    });
    this.bFav.addEventListener('click', () => {
      if (this.locked) return;
      if (favCount() > 0) this.hooks.onOpen('fav', 'お気に入りのページ');
      else this.hooks.onSay('お気に入りのページは、まだありませんね');
    });
    this.bFs = $<HTMLButtonElement>('bFs');
    this.bFs.addEventListener('click', () => {
      if (this.locked) return;
      if (!this.hooks.onToggleFullscreen()) this.hooks.onSay('ホーム画面に追加すると、全画面で読める');
    });
    this.updateEntry();
    $('a2hsX').addEventListener('click', () => this.closeA2hs());
    // キーボードでも開ける（Enter / Space）。ボタンに焦点がある時は素通し
    addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      if (this.locked || this.menu.classList.contains('show')) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'BUTTON' || t.tagName === 'INPUT' || t.tagName === 'A')) return;
      e.preventDefault();
      this.hint.classList.remove('show');
      this.hooks.onOpen('read');
    });
  }

  /**
   * 入口ボタンは「中身がある時だけ」出す（2026-09-09 KEI）。
   * 栞も印も無い＝本と一文だけの画面になる。
   */
  updateEntry(): void {
    this.bResume.hidden = !hasBookmark();
    this.bFav.hidden = favCount() === 0;
  }

  /** 本が現れたら呼ぶ。UIを出し、5秒後に一文が浮かぶ */
  start(): void {
    this.updateEntry();
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
    (document.getElementById('tabTitle') as HTMLElement).textContent = ['この本について', '読み方', 'お気に入り', '栞'][this.tabIdx];
  }

  /** 本の画面に音のボタンは置かない（2026-09-09 KEI）。音の入切は読書画面の「音」ボタンで行う */
  paintSound(_on: boolean): void { /* noop */ }

  /** 全画面の札（ 2026-09-09 KEI「全画面が消えた」で復活） */
  paintFullscreen(on: boolean, supported: boolean): void {
    if (!this.bFs) return;
    this.bFs.textContent = on ? '全画面をやめる' : '全画面';
    this.bFs.setAttribute('aria-label', on ? '全画面をやめる' : '全画面');
    this.bFs.classList.toggle('off', !supported);
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
