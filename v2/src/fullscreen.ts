// ============================================================
// 全画面（2026-09-09 KEI「全画面が消えた」で復活）
//   v3/v4 で本の画面の下段から「音量」の札ごと消えてしまい、全画面に入る手立てが
//   最初の一触りの自動要求（fsTried）だけになっていた。文字の札で明示的に出し入れする。
//   iOS Safari には文書の全画面が無いので、その時は「ホーム画面に追加」を案内する（従来の逃げ道）。
// ============================================================
type FsDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
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

/** 全画面に入る（最初の一触りで自動的に呼ばれる方。失敗しても黙って諦める） */
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

function fsExit(): void {
  try {
    const p = (d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen ? d.webkitExitFullscreen() : undefined) as Promise<void> | void;
    if (p && (p as Promise<void>).catch) (p as Promise<void>).catch(() => { /* noop */ });
  } catch { /* noop */ }
}

/**
 * 全画面の出し入れ。使えない端末（iOS Safari）では false を返すので、
 * 呼び手は「ホーム画面に追加すると全画面で読める」と案内する。
 */
export function toggleFullscreen(): boolean {
  if (!fsSupported()) return false;
  if (fsOn()) fsExit(); else fsEnter();
  return true;
}

const painters: Array<(on: boolean) => void> = [];
/** ボタンの文字を塗り直す先を登録する。登録時に一度呼ぶ */
export function onFsChange(fn: (on: boolean) => void): void {
  painters.push(fn);
  fn(fsOn());
}
const repaint = (): void => { const on = fsOn(); painters.forEach(f => f(on)); };
addEventListener('fullscreenchange', repaint);
addEventListener('webkitfullscreenchange', repaint);
