# 参照画像(book-ref-v1.png)から本モデル用テクスチャ3枚を切り出す
# 実行: python make_textures.py
# 出力: assets/cover-texture.png / spine-texture.png / pageedge-texture.png
import numpy as np
from PIL import Image, ImageFilter, ImageEnhance

REF = r"D:\kei-work\2026-09-02_book-model-ref\book-ref-v1.png"
OUT = r"D:\kei-tools\page-flip-proto\assets"

src = Image.open(REF).convert("RGB")

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

# ---- 焼き付いた明暗を薄める(アルベド化) ----
def delight(im, amount=0.75, radius=90):
    a = np.asarray(im, np.float32)
    lo = np.asarray(im.filter(ImageFilter.GaussianBlur(radius)), np.float32)
    lo = np.maximum(lo, 6.0)
    flat = a / lo * lo.mean(axis=(0, 1), keepdims=True)
    out = a * (1 - amount) + flat * amount
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))

# ---- 表紙(前面)四隅: 左上/右上/右下/左下 ----
COVER_QUAD = [(233, 190), (690, 148), (692, 1279), (218, 1229)]
CW, CH = 1536, 2048
cover = rectify(COVER_QUAD, CW, CH)
cover = delight(cover, 0.55, 110)
cover = ImageEnhance.Brightness(cover).enhance(0.72)

cover = ImageEnhance.Color(cover).enhance(1.05)
cover.save(OUT + r"\cover-texture.png", optimize=True)
print("cover", cover.size)

# ---- 小口(ページ束) ----
# 参照では紙の縞が縦。UVは U=本の高さ / V=厚み なので縞を横向きにする=90度回転
PAGE_QUAD = [(789, 205), (975, 190), (980, 1255), (793, 1270)]
pe = rectify(PAGE_QUAD, 512, 2048)
pe = delight(pe, 0.6, 70)
pe = pe.rotate(90, expand=True)                       # 縞が横向きに
pe = pe.crop((0, int(pe.height * 0.10), pe.width, int(pe.height * 0.93)))  # 上下の暗い革縁を落とす
pe = pe.resize((2048, 576), Image.LANCZOS)
# 3Dで作る留め革がテクスチャにも写っているので、隣の紙で塗り潰す
a = np.asarray(pe).astype(np.float32)
sx0, sx1 = int(2048 * 0.42), int(2048 * 0.59)
sw = sx1 - sx0
src_patch = a[:, sx0 - sw - 40: sx0 - 40].copy()
m = np.clip(np.minimum(np.arange(sw), sw - 1 - np.arange(sw))[None, :, None] / 50.0, 0, 1)
a[:, sx0:sx1] = a[:, sx0:sx1] * (1 - m) + src_patch * m
pe = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
# 参照の紙は淡いクリーム色。90パーセンタイルが 232 になるよう持ち上げる
b = np.asarray(pe).astype(np.float32)
b *= 232.0 / max(np.percentile(b, 90), 1.0)
b = 255.0 * np.clip(b / 255.0, 0, 1) ** 0.88
pe = Image.fromarray(np.clip(b, 0, 255).astype(np.uint8))
pe = ImageEnhance.Color(pe).enhance(0.62)
pe.save(OUT + r"\pageedge-texture.png", optimize=True)
print("pageedge", pe.size)

# ---- 背表紙: 隆起バンドは3D形状で作るので、テクスチャは無地の古革のみ ----
# 表紙の綺麗な革部分から縦帯を取り、縦に伸ばす
strip = cover.crop((int(CW * 0.30), int(CH * 0.02), int(CW * 0.62), int(CH * 0.98)))
sp = strip.resize((512, 2048), Image.LANCZOS)
sp = ImageEnhance.Brightness(sp).enhance(0.86)
sp.save(OUT + r"\spine-texture.png", optimize=True)
print("spine", sp.size)
