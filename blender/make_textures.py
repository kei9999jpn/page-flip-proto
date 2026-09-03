# 参照画像(book-ref-v1.png)から本モデル用テクスチャ3枚を作る (v2)
# 実行: python make_textures.py            -> 既定の出力先は _wip/book-v2
#       OUT_DIR=...\assets python make_textures.py   -> 本番へ出す時だけ明示する
# 出力: <OUT_DIR>/cover-texture.png / spine-texture.png / pageedge-texture.png
#
# v2 の狙い(v1 の反省):
#   - v1 は de-light を効かせすぎて革が「淡いオレンジ茶」に潰れた。
#     → de-light を弱め、ローカルコントラスト(ひび割れ)を持ち上げ、
#       深い暗褐色(平均輝度 35-55/255)へ落とし込む。紋章は局所コントラストで強調。
#   - 小口は参照写真の切り出しだと積層が粗く「崩れたレンガ」に見えた。
#     → 手続き生成に切り替え、細い頁線を高頻度(約200本)+ゆるいうねりで作る。
#       色はクリーム/黄変(彩度低め・輝度も抑えめ)。
import os
import numpy as np
from PIL import Image, ImageFilter, ImageEnhance

REF = r"D:\kei-work\2026-09-02_book-model-ref\book-ref-v1.png"
OUT = os.environ.get("OUT_DIR", r"D:\kei-tools\page-flip-proto\_wip\book-v3")
os.makedirs(OUT, exist_ok=True)

src = Image.open(REF).convert("RGB")
rng = np.random.default_rng(11)


# ---- 透視補正: 出力矩形 -> 入力四角形 の係数を解く ----
def persp_coeffs(dst_quad, src_quad):
    A, B = [], []
    for (x, y), (u, v) in zip(dst_quad, src_quad):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
    return np.linalg.solve(np.array(A, float), np.array(B, float))


def rectify(quad, w, h):
    dst = [(0, 0), (w, 0), (w, h), (0, h)]
    c = persp_coeffs(dst, quad)
    return src.transform((w, h), Image.PERSPECTIVE, tuple(c), Image.BICUBIC)


# ---- 焼き付いた明暗を薄める(アルベド化)。v2 は弱め・広半径 ----
def delight(im, amount=0.40, radius=170):
    a = np.asarray(im, np.float32)
    lo = np.asarray(im.filter(ImageFilter.GaussianBlur(radius)), np.float32)
    lo = np.maximum(lo, 6.0)
    flat = a / lo * lo.mean(axis=(0, 1), keepdims=True)
    out = a * (1 - amount) + flat * amount
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def local_contrast(im, radius, amount):
    """ハイパス成分を持ち上げる(ひび割れ・空押しの陰影を出す)"""
    a = np.asarray(im, np.float32)
    lo = np.asarray(im.filter(ImageFilter.GaussianBlur(radius)), np.float32)
    return Image.fromarray(np.clip(lo + (a - lo) * amount, 0, 255).astype(np.uint8))


def lum(a):
    return a @ np.array([0.299, 0.587, 0.114], np.float32)


def set_mean_lum(a, target, gamma=1.0):
    """ガンマで暗部を締めてから平均輝度を target に合わせる"""
    x = np.clip(a, 0, 255) / 255.0
    x = x ** gamma
    m = lum(x * 255.0).mean()
    x *= (target / max(m, 1e-3))
    return np.clip(x * 255.0, 0, 255)


# ================================================================ 表紙
COVER_QUAD = [(233, 190), (690, 148), (692, 1279), (218, 1229)]
CW, CH = 1280, 1706
cover = rectify(COVER_QUAD, CW, CH)
# v3: 金具は撤去するので、参照写真の右上/右下の隅金具と留め金を革で塗り潰す(中央の綺麗な革を貼る)
def _patch(im, box, srcbox, feather=0.22):
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    src_p = np.asarray(im.crop(srcbox).resize((w, h), Image.LANCZOS), np.float32)
    dst_p = np.asarray(im.crop(box), np.float32)
    fy = np.clip(np.minimum(np.arange(h), h - 1 - np.arange(h)) / (h * feather), 0, 1)
    fx = np.clip(np.minimum(np.arange(w), w - 1 - np.arange(w)) / (w * feather), 0, 1)
    m = (fy[:, None] * fx[None, :])[:, :, None]
    im.paste(Image.fromarray(np.clip(dst_p * (1 - m) + src_p * m, 0, 255).astype(np.uint8)), (x0, y0))
_patch(cover, (int(CW*0.66), 0, CW, int(CH*0.16)),              (int(CW*0.30), int(CH*0.62), int(CW*0.64), int(CH*0.78)), 0.30)
_patch(cover, (int(CW*0.62), int(CH*0.84), CW, CH),             (int(CW*0.28), int(CH*0.20), int(CW*0.66), int(CH*0.36)), 0.30)
_patch(cover, (int(CW*0.80), int(CH*0.36), CW, int(CH*0.60)),   (int(CW*0.34), int(CH*0.66), int(CW*0.54), int(CH*0.90)), 0.30)
cover = delight(cover, 0.40, 170)          # v1 は 0.55 / 110 で潰しすぎた
cover = local_contrast(cover, 7, 1.04)     # v3: ひび割れは控えめ(明るい筋がマーブル模様に見えていた)
cover = local_contrast(cover, 34, 1.06)    # 革の大きなうねり
cover = ImageEnhance.Color(cover).enhance(0.92)   # v3: 彩度を落として黒に近い牛革へ

a = np.asarray(cover, np.float32)

# ---- 紋章(葉と眼)の空押しを読めるように局所強調 ----
# 参照画像での紋章はおおむね正規化 (0.38-0.64, 0.38-0.58) の矩形に入る
ex0, ex1 = int(CW * 0.34), int(CW * 0.68)
ey0, ey1 = int(CH * 0.36), int(CH * 0.60)
patch = a[ey0:ey1, ex0:ex1]
pim = Image.fromarray(np.clip(patch, 0, 255).astype(np.uint8))
plo = np.asarray(pim.filter(ImageFilter.GaussianBlur(26)), np.float32)
hi = patch - plo                                   # 空押しの陰影(低周波を除いた分)
hi2 = patch - np.asarray(pim.filter(ImageFilter.GaussianBlur(7)), np.float32)
# v3: 色ずれ(緑/青の縁)を避けるため輝度だけ持ち上げる
hiL = lum(hi)[:, :, None]; hi2L = lum(hi2)[:, :, None]
boost = np.clip(plo + hiL * 2.2 + hi2L * 0.8, 0, 255)
# 矩形の継ぎ目が出ないよう縁でフェード
hgt, wid = patch.shape[:2]
fy = np.clip(np.minimum(np.arange(hgt), hgt - 1 - np.arange(hgt)) / (hgt * 0.18), 0, 1)
fx = np.clip(np.minimum(np.arange(wid), wid - 1 - np.arange(wid)) / (wid * 0.18), 0, 1)
mask = (fy[:, None] * fx[None, :])[:, :, None]
a[ey0:ey1, ex0:ex1] = patch * (1 - mask) + boost * mask
# v5 (2026-09-03 KEI): 紋章だけ金箔押しに。空押しのエッジ(hiL)が明るい所を金色へ寄せる
GOLD = np.array([214.0, 172.0, 70.0], np.float32)
edge = np.clip((hiL[:, :, 0] - 4.0) / 18.0, 0, 1)[:, :, None] * mask
gold_layer = GOLD[None, None, :] * (0.55 + 0.45 * np.clip(patch.mean(axis=2, keepdims=True) / 60.0, 0, 1))
a[ey0:ey1, ex0:ex1] = a[ey0:ey1, ex0:ex1] * (1 - edge * 0.85) + gold_layer * (edge * 0.85)

# ハイライトを軟らかく圧縮(白飛びした粒がオレンジに光るのを抑える)
x = np.clip(a, 0, 255) / 255.0
K = 2.6   # v3: ひび割れのハイライトをさらに圧縮(蝋燭光で白飛び→マーブル化していた)
x = (1.0 - np.exp(-K * x)) / (1.0 - np.exp(-K))
a = set_mean_lum(x * 255.0, 33.0, gamma=1.30)   # v3: 黒に近い牛革。目標 28-38/255
a = np.minimum(a, 105.0)                          # ひび割れの最大輝度を抑える
cover = Image.fromarray(a.astype(np.uint8))
cover.save(os.path.join(OUT, "cover-texture.png"), optimize=True)
print("cover", cover.size, "mean lum %.1f" % lum(np.asarray(cover, np.float32)).mean())

# ================================================================ 背表紙
# 表紙の綺麗な革部分から縦帯を取り、縦に伸ばす(バンドは3D形状で作る)
strip = cover.crop((int(CW * 0.30), int(CH * 0.02), int(CW * 0.62), int(CH * 0.98)))
sp = strip.resize((448, 1792), Image.LANCZOS)
sa = set_mean_lum(np.asarray(sp, np.float32), 30.0, gamma=1.05)
sp = Image.fromarray(sa.astype(np.uint8))
sp.save(os.path.join(OUT, "spine-texture.png"), optimize=True)
print("spine", sp.size, "mean lum %.1f" % lum(sa).mean())

# ================================================================ 小口(頁の積層)
# UV: U = 本の高さ方向 / V = 厚み方向 -> 頁の線は「横向き」に走る。
# 参照写真の切り出しでは線が太く粗い(=崩れたレンガ)ので手続き生成する。
PW, PH = 1600, 800
NLINES = 196                                # 見える積層線の本数(高頻度)
u = np.linspace(0, 1, PW, dtype=np.float32)[None, :]
v = np.linspace(0, 1, PH, dtype=np.float32)[:, None]

# 頁のうねり: 本の高さ方向(U)でわずかに上下する。強すぎると波打ちすぎる。
wave = (np.sin(u * 6.1 + 0.7) * 0.55 +
        np.sin(u * 13.3 + 2.1) * 0.28 +
        np.sin(u * 27.0 + 4.4) * 0.14) * 1.9      # 単位 = 頁ピッチ
pos = v * NLINES + wave                            # 各点が何枚目の頁か
idx = np.floor(pos).astype(np.int32)
frac = pos - idx

# 頁ごとの個体差(厚み・汚れ・浮き)
pg_tone = rng.normal(0.0, 0.045, NLINES + 8).astype(np.float32)
pg_gap = (0.20 + rng.random(NLINES + 8).astype(np.float32) * 0.22)   # 影の幅
tone = pg_tone[np.clip(idx, 0, NLINES + 7)]
gap = pg_gap[np.clip(idx, 0, NLINES + 7)]

# 1頁の断面: 前縁に暗い溝、中央がわずかに明るい
d = np.minimum(frac, 1.0 - frac) * 2.0             # 0(頁境界) .. 1(頁の中央)
shade = np.clip(d / np.maximum(gap, 1e-3), 0, 1) ** 0.45
val = 0.22 + 0.78 * shade + tone

# 数十枚まとまった「束」の起伏(参照写真の緩いブロック感)
val *= (1.0 + 0.035 * np.sin(v * 26.0 + u * 2.2) + 0.02 * np.sin(v * 71.0 + 1.3))

# 天地の汚れ・シミ(U方向)
stain = (0.90 + 0.10 * np.sin(u * 3.3 + 1.1)) * (1.0 - 0.16 * np.exp(-((u - 0.03) / 0.05) ** 2)
                                                 - 0.16 * np.exp(-((u - 0.97) / 0.05) ** 2))
val *= stain
val += rng.normal(0.0, 0.022, (PH, PW)).astype(np.float32)          # 紙の粒子
val = np.clip(val, 0.0, 1.35)

# クリーム/黄変。彩度は低め(v1 は鮮やかなオレンジになっていた)
DARK = np.array([58.0, 46.0, 32.0], np.float32)
LIGHT = np.array([232.0, 219.0, 190.0], np.float32)
pe = DARK[None, None, :] + (LIGHT - DARK)[None, None, :] * val[:, :, None]
pe = np.clip(pe, 0, 255)
# intro の蝋燭光(PointLight 5.2 + ACES)で白飛びするため、かなり暗いアルベドにする。
pe = set_mean_lum(pe, 60.0, gamma=1.12)
pei = ImageEnhance.Color(Image.fromarray(pe.astype(np.uint8))).enhance(0.9)   # v3: 参照写真は灰味のクリーム。オレンジにしない  # 黄変した紙の色味
pe = np.asarray(pei, np.float32)
pei.save(os.path.join(OUT, "pageedge-texture.png"), optimize=True)
print("pageedge", pei.size, "mean lum %.1f" % lum(pe).mean(), "lines", NLINES)
