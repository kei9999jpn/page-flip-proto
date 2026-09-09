// ============================================================
// 保存データ。localStorage のキーと形は現行 app/ a/ と完全に同じ。
// 既存ユーザーのお気に入り（bookexp-favs）と栞（bookexp-bookmark）はそのまま引き継がれる。
//   bookexp-settings : 音の設定（v3..v6 のマイグレーションも現行どおり）
//   bookexp-favs     : number[]（実ページ番号）
//   bookexp-bookmark : { list:[{ deck:number[], index:number, ts:number, fav:boolean }] }（旧: 単体オブジェクトも読める）
//   bookexp-stats    : { visits, lastVisit, pagesTotal, favSaid }
//   bookexp-a2hs     : '1'（ホーム画面に追加のヒントを出したか）
// ============================================================

export const K = {
  settings: 'bookexp-settings',
  favs: 'bookexp-favs',
  bookmark: 'bookexp-bookmark',
  stats: 'bookexp-stats',
  a2hs: 'bookexp-a2hs',
} as const;

export interface Settings {
  bgm: boolean; rain: boolean; insects: boolean; candle: boolean;
  amb: number; flip: number; flipOn: boolean; rainKind: string; bgmVol: number;
  sound?: boolean;
  v3?: number; v4?: number; v5?: number; v6?: number;
  [k: string]: unknown;
}

export const DEFAULTS: Settings = {
  bgm: true, rain: true, insects: false, candle: false,
  amb: 0.6, flip: 1.0, flipOn: true, rainKind: 'study', bgmVol: 0.5,
};

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return (v == null ? fallback : v) as T;
  } catch { return fallback; }
}
function writeJSON(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* プライベートブラウズ等 */ }
}

// ---- 設定 ----
export const S: Settings = { ...DEFAULTS, ...readJSON<Partial<Settings>>(K.settings, {}) };
if (!S.v3) { S.rainKind = 'study'; S.bgmVol = 0.5; S.v3 = 1; }
if (!S.v4) { S.insects = false; S.candle = false; S.v4 = 1; }
S.rainKind = 'study';                                   // 環境音は1種類（KEI 2026-09-04）
if (!S.v5) { S.bgmVol = 0.5; S.amb = 0.5; S.flip = 0.5; S.v5 = 1; }
if (!S.v6) { S.sound = true; S.v6 = 1; }                // 音は ON/OFF ひとつだけ（v20）

export function saveSettings(): void { writeJSON(K.settings, S); }
/** 音 ON/OFF は bgm / rain / flipOn をまとめて動かす（現行と同じ） */
export function applySoundFlags(): void { S.bgm = S.rain = S.flipOn = !!S.sound; }
export function curve(x: number): number { return x <= 0 ? 0 : Math.pow(x / 0.5, 1.6); }

// ---- お気に入り ----
export function loadFavs(): number[] {
  const v = readJSON<number[]>(K.favs, []);
  return Array.isArray(v) ? v : [];
}
export function saveFavs(favs: number[]): void { writeJSON(K.favs, favs); }
export function favCount(): number { return loadFavs().length; }

// ---- 栞（2026-09-09 KEI: 何本でも挟める） ----
// 保存の形は { list: Bookmark[] }。キーは bookexp-bookmark のまま。
// 旧い形（単体の {deck,index,ts,fav}）で保存された端末も、そのまま1本の栞として読み込む。
export interface Bookmark { deck: number[]; index: number; ts: number; fav: boolean; seen?: number[] }

function isBookmark(x: unknown): x is Bookmark {
  const b = x as Bookmark | null;
  return !!(b && Array.isArray(b.deck) && b.deck.length && typeof b.index === 'number');
}
/** その栞が指している実ページ番号 */
export function bookmarkPage(b: Bookmark): number {
  return b.deck[Math.min(Math.max(b.index, 0), b.deck.length - 1)];
}
export function loadBookmarks(): Bookmark[] {
  const raw = readJSON<unknown>(K.bookmark, null);
  if (!raw) return [];
  const arr: unknown[] = Array.isArray(raw) ? raw
    : Array.isArray((raw as { list?: unknown }).list) ? (raw as { list: unknown[] }).list
    : [raw];
  return arr.filter(isBookmark);
}
export function saveBookmarks(list: Bookmark[]): void {
  if (!list.length) { clearBookmark(); return; }
  writeJSON(K.bookmark, { list });
}
/** 一番あとに挟んだ栞。「栞から読む」で開く時はこれを使う */
export function loadBookmark(): Bookmark | null {
  const l = loadBookmarks();
  if (!l.length) return null;
  return l.reduce((a, b) => ((b.ts || 0) >= (a.ts || 0) ? b : a));
}
export function bookmarkPages(): number[] { return loadBookmarks().map(bookmarkPage); }
/** 同じページの栞は1本だけ。挟み直すと最新になる */
export function saveBookmark(b: Bookmark): void {
  const p = bookmarkPage(b);
  const l = loadBookmarks().filter(x => bookmarkPage(x) !== p);
  l.push(b);
  saveBookmarks(l);
}
/** そのページの栞1本だけを外す（他の栞は残る） */
export function removeBookmarkPage(page: number): void {
  saveBookmarks(loadBookmarks().filter(x => bookmarkPage(x) !== page));
}
export function clearBookmark(): void { try { localStorage.removeItem(K.bookmark); } catch { /* noop */ } }
export function hasBookmark(): boolean { return loadBookmarks().length > 0; }
export function bookmarkCount(): number { return loadBookmarks().length; }

// ---- この端末の記録 ----
export interface Stats { visits: number; lastVisit: number; pagesTotal: number; favSaid: boolean }
export const ST: Stats = { visits: 0, lastVisit: 0, pagesTotal: 0, favSaid: false, ...readJSON<Partial<Stats>>(K.stats, {}) };
export function saveStats(): void { writeJSON(K.stats, ST); }

// ---- ホーム画面に追加のヒント ----
export function a2hsSeen(): boolean { try { return !!localStorage.getItem(K.a2hs); } catch { return true; } }
export function a2hsMark(): void { try { localStorage.setItem(K.a2hs, '1'); } catch { /* noop */ } }

// ---- 共通 ----
/** リポジトリ直下の assets/ を指す。base が /page-flip-proto/app2/ なので ../assets/ で届く */
export function asset(path: string): string {
  return new URL('../assets/' + path, document.baseURI).href;
}
export const MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');
export const QP = new URLSearchParams(location.search);
export const BUILD = '20260909v4';

// 2026-09-09 KEI: BUILD を上げても栞・印・枚数は消さない（更新のたびに読者の記録が飛ぶ不具合）。
// 記録するのは「どの版まで見たか」だけ。設定の形を変える時だけ、ここに移行処理を足す。
try {
  if (localStorage.getItem('bookexp-build') !== BUILD) localStorage.setItem('bookexp-build', BUILD);
} catch { /* noop */ }
