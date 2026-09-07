// ============================================================
// 保存データ。localStorage のキーと形は現行 app/ a/ と完全に同じ。
// 既存ユーザーの印（bookexp-favs）と栞（bookexp-bookmark）はそのまま引き継がれる。
//   bookexp-settings : 音の設定（v3..v6 のマイグレーションも現行どおり）
//   bookexp-favs     : number[]（実ページ番号）
//   bookexp-bookmark : { deck:number[], index:number, ts:number, fav:boolean }
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

// ---- 印（お気に入り） ----
export function loadFavs(): number[] {
  const v = readJSON<number[]>(K.favs, []);
  return Array.isArray(v) ? v : [];
}
export function saveFavs(favs: number[]): void { writeJSON(K.favs, favs); }
export function favCount(): number { return loadFavs().length; }

// ---- 栞 ----
export interface Bookmark { deck: number[]; index: number; ts: number; fav: boolean; seen?: number[] }
export function loadBookmark(): Bookmark | null {
  const b = readJSON<Bookmark | null>(K.bookmark, null);
  if (b && Array.isArray(b.deck) && b.deck.length) return b;
  return null;
}
export function saveBookmark(b: Bookmark): void { writeJSON(K.bookmark, b); }
export function clearBookmark(): void { try { localStorage.removeItem(K.bookmark); } catch { /* noop */ } }
export function hasBookmark(): boolean { return !!loadBookmark(); }

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
export const BUILD = '20260907v2-3';

// テスト期間の約束（2026-09-07 夜 KEI「更新のたびにリセットして」）: BUILD が変わったら栞・印・枚数を消す。
// ※一般公開の前にこのブロックを外すこと（読者の栞まで消える）
try {
  if (localStorage.getItem('bookexp-build') !== BUILD) {
    [K.bookmark, K.favs, K.stats].forEach(k => localStorage.removeItem(k));
    localStorage.setItem('bookexp-build', BUILD);
  }
} catch { /* noop */ }
