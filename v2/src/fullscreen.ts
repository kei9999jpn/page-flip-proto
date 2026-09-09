// ============================================================
// 全画面（2026-09-09 KEI「ボタンはいらない。開くたびに勝手に全画面になって」）
//   札（ボタン）は本の画面からも読書画面からも撤去した。本を開く操作そのもの
//   ——ダブルタップ／「しおりから読む」「お気に入りを読む」／Enter・Space——の
//   中で同期的に requestFullscreen を呼ぶ。ブラウザは「利用者の操作の中」でしか
//   全画面を許さないので、await や setTimeout をはさんだ先で呼んではいけない。
//   iOS Safari には文書の全画面が無い。その時は何も起きず、Ui 側の
//   「ホーム画面に追加すると、枠のない全画面で読める」の一言が従来どおり逃げ道になる。
// ============================================================
type FsDoc = Document & { webkitFullscreenElement?: Element | null };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const d = document as FsDoc;

/** この端末で文書の全画面が使えるか（iOS Safari は false） */
export function fsSupported(): boolean {
  const el = document.documentElement as FsEl;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

/** いま全画面か */
export function fsOn(): boolean {
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}

/**
 * 全画面に入る。すでに全画面なら何もしない。断られても黙って諦める。
 * **必ず利用者の操作のハンドラの中で、await の前に**呼ぶこと。
 */
export function fsEnter(): void {
  if (fsOn()) return;
  const el = document.documentElement as FsEl;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return;
  try {
    const p = req.call(el, { navigationUI: 'hide' } as FullscreenOptions) as Promise<void> | void;
    if (p && (p as Promise<void>).catch) (p as Promise<void>).catch(() => { /* noop */ });
  } catch { /* noop */ }
}
