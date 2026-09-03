# 異世界の叡智 没入本: 分厚くボロボロの古代魔法書(牛革)の3Dモデル → GLB書き出し
# 実行: "D:\SteamLibrary\steamapps\common\Blender\blender.exe" -b -P make_book.py
# 出力: D:\kei-tools\page-flip-proto\assets\book.glb / blender\book_preview.png
#
# 重要(intro/index.html との契約):
#   - 表紙オブジェクト名は "Cover_Front" のまま。Box3 で拾って背側の縁にヒンジを作り
#     rotation.z で開くので、隅金具・留め金は Cover_Front に join して1オブジェクトにする。
#   - 座標系: X = 小口方向(+Xが小口/開く側, -Xが背), Y = 上下(高さ), Z = 厚み。export_yup。
import bpy, bmesh, math, random, os
import mathutils

# 出力先は環境変数 OUT_DIR で差し替え(既定 = _wip/book-v2)。
# 本番 assets/ を上書きするのは KEI の OK が出てから明示的に OUT_DIR を指定した時だけ。
OUTDIR = os.environ.get("OUT_DIR", r"D:\kei-tools\page-flip-proto\_wip\book-v3")
os.makedirs(OUTDIR, exist_ok=True)
OUT = os.path.join(OUTDIR, "book.glb")
PREVIEW = os.path.join(OUTDIR, "preview_v3.png")            # 参照写真と同じ煽り角
PREVIEW_INTRO = os.path.join(OUTDIR, "preview_v3_intro.png")  # intro のカメラ角
TEXDIR = OUTDIR                                              # cover/spine/pageedge
FALLBACK_TEXDIR = r"D:\kei-tools\page-flip-proto\assets"     # pagetop.jpg 等の共通素材
random.seed(7)
# v3 (2026-09-03 KEI): 金具・留め金は「付けるほど安っぽい」ので全撤去
HARDWARE = False

# 本の寸法 (m): 幅0.24 / 高さ0.32 / 厚み0.105 (参照画像に合わせて大幅に分厚く)
W, H, T = 0.24, 0.32, 0.105
SPINE_R_PRE = T / 2
COVER_T = 0.009          # 表紙板の厚み
OVERHANG = 0.009         # 表紙が中身より張り出す量(チリ)
CX0, CX1 = -W / 2, W / 2 + OVERHANG          # 表紙のX範囲
CY0, CY1 = -(H / 2 + OVERHANG), H / 2 + OVERHANG

bpy.ops.wm.read_factory_settings(use_empty=True)
col = bpy.context.scene.collection

def new_obj(name, mesh):
    o = bpy.data.objects.new(name, mesh)
    col.objects.link(o)
    return o

def make_box(name, sx, sy, sz, loc, bevel=0.0025, segs=2):
    m = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    bm.to_mesh(m); bm.free()
    o = new_obj(name, m)
    o.location = loc
    if bevel > 0:
        b = o.modifiers.new("bevel", 'BEVEL')
        b.width = bevel; b.segments = segs; b.limit_method = 'ANGLE'
    return o

def make_cyl(name, r, depth, loc, axis='Z', verts=10):
    m = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=verts,
                          radius1=r, radius2=r * 0.82, depth=depth)
    if axis == 'X':
        bmesh.ops.rotate(bm, matrix=mathutils.Matrix.Rotation(math.radians(90), 3, 'Y'),
                         verts=bm.verts)
    bm.to_mesh(m); bm.free()
    o = new_obj(name, m)
    o.location = loc
    return o

# ---------------------------------------------------------------- 表紙・裏表紙
front = make_box("Cover_Front", W + OVERHANG, H + OVERHANG * 2, COVER_T,
                 (OVERHANG / 2, 0,  T / 2 - COVER_T / 2))
back  = make_box("Cover_Back",  W + OVERHANG, H + OVERHANG * 2, COVER_T,
                 (OVERHANG / 2, 0, -T / 2 + COVER_T / 2))

BOW = 0.005
def bow_at(gx, gy, sign=+1):
    """warp_cover と同じ反り量。金具の設置高さを表紙のうねりに合わせる。"""
    t = (gx - CX0) / (CX1 - CX0)
    t = min(max(t, 0.0), 1.0)
    corner = (abs(gy) / CY1) ** 2
    return sign * BOW * (t ** 2) * (0.55 + 0.45 * corner)

def warp_cover(obj, sign):
    """小口側へ行くほど外へ反る + 縁の革が浮いて膨らむ(めくれ)"""
    m = obj.data
    bm = bmesh.new(); bm.from_mesh(m)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=7, use_grid_fill=True)
    xs = [v.co.x for v in bm.verts]; x0, x1 = min(xs), max(xs)
    ys = [v.co.y for v in bm.verts]; yh = max(abs(min(ys)), abs(max(ys)))
    for v in bm.verts:
        t = (v.co.x - x0) / (x1 - x0)
        corner = (abs(v.co.y) / yh) ** 2 if yh else 0
        v.co.z += sign * BOW * (t ** 2) * (0.55 + 0.45 * corner)
        # 縁: 革がめくれて浮く
        ex = min(v.co.x - x0, x1 - v.co.x) / (x1 - x0)
        ey = min(v.co.y + yh, yh - v.co.y) / (2 * yh)
        e = min(ex, ey)
        if e < 0.10:
            k = (0.10 - e) / 0.10
            v.co.z += sign * (0.0016 * k * k + random.uniform(-0.0007, 0.0007) * k)
            v.co.x += random.uniform(-0.0006, 0.0006) * k
            v.co.y += random.uniform(-0.0006, 0.0006) * k
    bm.to_mesh(m); bm.free()
warp_cover(front, +1)
warp_cover(back, -1)

# ---------------------------------------------------------------- 背表紙(丸背)+ 5本の隆起バンド
SPINE_R = T / 2
SPINE_H = H + OVERHANG * 2

def half_arc_shell(name, radius, height, segments=24):
    """XZ平面の半円弧をY方向へ押し出した殻(背表紙/バンド共通)"""
    m = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=False, radius=radius, segments=segments)
    bmesh.ops.transform(bm, matrix=mathutils.Matrix.Rotation(math.radians(90), 4, 'X'),
                        verts=bm.verts)
    for v in [v for v in bm.verts if v.co.x > 1e-6]:
        bm.verts.remove(v)
    r = bmesh.ops.extrude_edge_only(bm, edges=bm.edges[:])
    ext = [e for e in r['geom'] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(0, height, 0), verts=ext)
    bmesh.ops.translate(bm, vec=(0, -height / 2, 0), verts=bm.verts)
    bm.to_mesh(m); bm.free()
    return new_obj(name, m)

spine = half_arc_shell("Spine", SPINE_R, SPINE_H, 26)
spine.location = (-W / 2, 0, 0)
sd = spine.modifiers.new("solid", 'SOLIDIFY'); sd.thickness = COVER_T

bands = []
BAND_H = 0.018
for k in range(1, 6):
    y = -SPINE_H / 2 + SPINE_H * k / 6.0
    b = half_arc_shell("Band%d" % k, SPINE_R + 0.0015, BAND_H, 20)
    b.location = (-W / 2, y, 0)
    sd2 = b.modifiers.new("solid", 'SOLIDIFY')
    sd2.thickness = 0.0062; sd2.offset = 1.0        # 外側へ膨らませる
    bv = b.modifiers.new("bevel", 'BEVEL')
    bv.width = 0.0022; bv.segments = 2; bv.limit_method = 'ANGLE'
    bands.append(b)

# ---------------------------------------------------------------- 中身のページブロック(数百枚)
# v2: v1 は中身が表紙(CX1)より外へ出ていて、頁束の天面(オレンジの羊皮紙)が
#     隙間から帯状に見えていた。表紙が少し被さる(チリ)ようにして隠す。
# v5 (2026-09-03 KEI): 背表紙とページの間に隙間が見えていた → 頁束を背表紙の丸みの内側まで伸ばして埋める
PX0, PX1 = -W / 2 - SPINE_R_PRE * 0.78, W / 2 + 0.003
PY0, PY1 = -(H / 2) + 0.002, (H / 2) - 0.002
PZ = T - COVER_T * 2 - 0.003
NZ, NX, NY = 112, 12, 16                       # 層数 / 小口方向分割 / 高さ方向分割

def ring_base():
    pts = []
    for i in range(NY):
        pts.append((PX1, PY0 + (PY1 - PY0) * i / NY))
    for i in range(NX):
        pts.append((PX1 + (PX0 - PX1) * i / NX, PY1))
    for i in range(NY):
        pts.append((PX0, PY1 + (PY0 - PY1) * i / NY))
    for i in range(NX):
        pts.append((PX0 + (PX1 - PX0) * i / NX, PY0))
    return pts

base = ring_base()
M = len(base)
pm = bpy.data.meshes.new("Pages")
bm = bmesh.new()
layers = []
for k in range(NZ + 1):
    z = -PZ / 2 + PZ * k / NZ
    # 層(=紙の束)ごとのうねり
    s1 = math.sin(k * 0.83) * 0.5 + math.sin(k * 0.29 + 1.7) * 0.5
    s2 = math.sin(k * 0.17 + 0.4)
    row = []
    for (bx, by) in base:
        x, y = bx, by
        # v2: v1 は層ごとの飛び出しが強すぎて「崩れたレンガ」になった。振幅を約1/3へ。
        #     細かい積層線はテクスチャ側(頁線 196本)で出し、形状はゆるいうねりだけ残す。
        if bx > PX1 - 1e-6:                       # 小口(+X): 紙が不揃いに飛び出す
            wob = math.sin(by * 34.0 + k * 0.9) * 0.00015
            # v3: 層ごとの段差が実画面で「木の板の縞」に見えたので更に1/3へ。積層感はテクスチャに任せる
            # v3b: 層ごとの周期的な段差(s1/s2)が面の向きを交互に変え「横縞」に見えたので、ほぼ平らに
            x += 0.00003 * (0.45 + 0.55 * s1) + wob * 0.12 + random.uniform(-0.00002, 0.00002)
        if abs(by - PY1) < 1e-6 or abs(by - PY0) < 1e-6:   # 天地
            sgn = 1.0 if by > 0 else -1.0
            y += sgn * (0.0002 * (0.4 + 0.6 * s1) + random.uniform(-0.00013, 0.00013))
        if bx < PX0 + 1e-6:                       # 背側は綴じられているので暴れない
            x += random.uniform(-0.0002, 0.0002)
        row.append(bm.verts.new((x, y, z + random.uniform(-0.00003, 0.00003))))
    layers.append(row)
bm.verts.index_update()
for k in range(NZ):
    for i in range(M):
        j = (i + 1) % M
        bm.faces.new((layers[k][i], layers[k][j], layers[k + 1][j], layers[k + 1][i]))
bm.faces.new(list(reversed(layers[0])))
bm.faces.new(layers[NZ])
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
bm.to_mesh(pm); bm.free()
pages = new_obj("Pages", pm)
# v3: スムーズシェードだと層ごとの法線差が「太い縞」に見えたのでフラットに
for p in pm.polygons:
    p.use_smooth = False

# ---------------------------------------------------------------- 隅金具(4隅×表裏)
# v2: v1 は段ボール箱のように大きく厚く平らだった。約40%へ縮小し、板厚も1.7mmへ。
# ベベルを厚みに対して大きく取り、角を丸めて「叩き出した鉄」の断面にする。
GT = 0.0017      # 金具の厚み(1.7mm)
ARM = 0.020      # 腕の長さ(v1 0.050 の40%)
AW = 0.0072      # 腕の幅(v1 0.018 の40%)
guard_parts_f, guard_parts_b = [], []

def corner_guard(tag, sx, sy, z_out, sign, sink):
    """sx,sy=±1 の隅に L 字の鉄金具 + リベット。z_out=表紙外面のZ"""
    cx = CX1 if sx > 0 else CX0
    cy = sy * CY1
    parts = []
    bz = bow_at(cx - sx * ARM * 0.4, cy, sign)
    zc = z_out + bz + sign * (GT / 2 - 0.0004)
    parts.append(make_box("G%s_ax" % tag, ARM, AW, GT,
                          (cx - sx * ARM / 2, cy - sy * AW / 2, zc), bevel=0.00055, segs=3))
    parts.append(make_box("G%s_ay" % tag, AW, ARM, GT,
                          (cx - sx * AW / 2, cy - sy * ARM / 2, zc), bevel=0.00055, segs=3))
    # 板の小口へ回り込む唇
    parts.append(make_box("G%s_lx" % tag, ARM, GT, COVER_T + 0.0022,
                          (cx - sx * ARM / 2, cy + sy * GT / 2, z_out + bz - sign * COVER_T / 2),
                          bevel=0.00045, segs=2))
    parts.append(make_box("G%s_ly" % tag, GT, ARM, COVER_T + 0.0022,
                          (cx + sx * GT / 2, cy - sy * ARM / 2, z_out + bz - sign * COVER_T / 2),
                          bevel=0.00045, segs=2))
    for (rx, ry) in ((ARM * 0.80, AW * 0.5), (AW * 0.5, ARM * 0.80), (0.0062, 0.0062)):
        parts.append(make_cyl("G%s_r" % tag, 0.00105, 0.0013,
                              (cx - sx * rx, cy - sy * ry, zc + sign * 0.0009), verts=8))
    return parts

for (sx, sy) in (((1, 1), (1, -1), (-1, 1), (-1, -1)) if HARDWARE else ()):
    guard_parts_f += corner_guard("F%d%d" % (sx, sy), sx, sy, T / 2, +1, 0)
    guard_parts_b += corner_guard("B%d%d" % (sx, sy), sx, sy, -T / 2, -1, 0)

# ---------------------------------------------------------------- 留め金(小口を横切る革帯+鉄板)
if HARDWARE:
    CLASP_Y = 0.02
    # 表紙側: 鉄板 + 舌金(表紙と一緒に開く)
    cb = bow_at(CX1 - 0.030, CLASP_Y, +1)
    clasp_plate = make_box("ClaspPlate", 0.036, 0.021, 0.0020,
                           (CX1 - 0.020, CLASP_Y, T / 2 + cb + 0.0011), bevel=0.00065, segs=3)
    clasp_tongue = make_box("ClaspTongue", 0.016, 0.012, 0.0018,
                            (CX1 + 0.005, CLASP_Y, T / 2 + cb + 0.0010), bevel=0.00055, segs=2)
    clasp_rivets = [make_cyl("ClaspRv", 0.0016, 0.0016,
                             (CX1 - 0.020 + dx, CLASP_Y + dy, T / 2 + cb + 0.0023), verts=8)
                    for (dx, dy) in ((-0.012, 0.0), (0.009, 0.006), (0.009, -0.006))]
    front_parts = guard_parts_f + [clasp_plate, clasp_tongue] + clasp_rivets

    # 裏表紙側: 小口を回り込む革帯 + 受けの鉄板(閉じている間だけ表の舌金と噛む)
    STRAP_X = PX1 + 0.012
    strap = make_box("Strap", 0.0055, 0.024, T * 0.80,
                     (STRAP_X, CLASP_Y, -(T / 2 + 0.004) + (T * 0.80) / 2),
                     bevel=0.0008, segs=2)
    strap_back = make_box("StrapBack", 0.034, 0.024, 0.0020,
                          (CX1 - 0.018, CLASP_Y, -T / 2 - bow_at(CX1 - 0.018, CLASP_Y, +1) - 0.0011),
                          bevel=0.0007, segs=2)
    strap_buckle = make_box("StrapBuckle", 0.0075, 0.020, 0.0075,
                            (STRAP_X, CLASP_Y, T / 2 * 0.20), bevel=0.0009, segs=3)
    back_parts = guard_parts_b + [strap_back, strap_buckle]
else:
    clasp_plate = clasp_tongue = strap_back = strap_buckle = None
    clasp_rivets = []; strap = None
    front_parts = list(guard_parts_f); back_parts = list(guard_parts_b)

# ---------------------------------------------------------------- マテリアル
def mat(name, rgba, rough=0.85, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = rgba
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    return m

def hook_tex(material, path):
    if not os.path.exists(path):
        path = os.path.join(FALLBACK_TEXDIR, os.path.basename(path))
    if not os.path.exists(path):
        print("!! missing texture:", path); return
    img = bpy.data.images.load(path)
    nt = material.node_tree
    tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = img
    nt.links.new(tn.outputs["Color"], nt.nodes.get("Principled BSDF").inputs["Base Color"])

m_cover  = mat("M_Cover",  (0.35, 0.27, 0.18, 1), 0.96)
m_spine  = mat("M_Spine",  (0.20, 0.15, 0.10, 1), 0.94)
m_pages  = mat("M_Pages",  (0.87, 0.82, 0.70, 1), 0.96)
m_top    = mat("M_PageTop",(0.90, 0.75, 0.50, 1), 0.92)
# v2: 焼き黒めの鉄。金属度を上げて縁のベベルだけが蝋燭光を拾うようにする。
m_iron   = mat("M_Iron",   (0.030, 0.028, 0.026, 1), 0.48, 0.75)
hook_tex(m_cover, os.path.join(TEXDIR, "cover-texture.png"))
hook_tex(m_spine, os.path.join(TEXDIR, "spine-texture.png"))
hook_tex(m_pages, os.path.join(TEXDIR, "pageedge-texture.png"))
hook_tex(m_top,   os.path.join(TEXDIR, "pagetop.jpg"))

front.data.materials.append(m_cover)
back.data.materials.append(m_cover)
spine.data.materials.append(m_spine)
for b in bands:
    b.data.materials.append(m_spine)
pages.data.materials.append(m_pages)   # slot0: 小口・天地
pages.data.materials.append(m_top)     # slot1: 表紙側の面
for poly in pm.polygons[-2:]:          # 最後に作った2枚 = 天面/底面のキャップ
    if poly.normal.z > 0:
        poly.material_index = 1
for o in [x for x in guard_parts_f + guard_parts_b + [clasp_plate, clasp_tongue, strap_back, strap_buckle] + clasp_rivets if x]:
    o.data.materials.append(m_iron)
if strap: strap.data.materials.append(m_spine)

# ---------------------------------------------------------------- UV
def uv_cover(obj, outer_z_positive):
    me = obj.data
    if not me.uv_layers: me.uv_layers.new(name="UVMap")
    uv = me.uv_layers.active.data
    xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]
    x0, x1 = min(xs), max(xs); y0, y1 = min(ys), max(ys)
    for poly in me.polygons:
        outer = (poly.normal.z > 0.85) if outer_z_positive else (poly.normal.z < -0.85)
        for li in poly.loop_indices:
            v = me.vertices[me.loops[li].vertex_index].co
            if outer:
                u = (v.x - x0) / (x1 - x0); w = (v.y - y0) / (y1 - y0)
                if not outer_z_positive: u = 1.0 - u
                uv[li].uv = (u, w)
            else:
                # 板の小口(側面)。v1 は左上隅(=破れた明るい部分)を拾って
                # オレンジの帯になっていたので、中央付近の暗い革を使う。
                uv[li].uv = (0.46 + 0.05 * ((v.x - x0) / (x1 - x0)),
                             0.20 + 0.05 * ((v.y - y0) / (y1 - y0)))
uv_cover(front, True)
uv_cover(back, False)

def uv_spine(obj):
    me = obj.data
    if not me.uv_layers: me.uv_layers.new(name="UVMap")
    uv = me.uv_layers.active.data
    y0, y1 = -SPINE_H / 2, SPINE_H / 2
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            t = math.atan2(co.z, co.x)
            if t < 0: t += 2 * math.pi
            u = (t - math.pi / 2) / math.pi
            uv[li].uv = (min(max(u, 0.0), 1.0),
                         min(max((co.y - y0) / (y1 - y0), 0.0), 1.0))
uv_spine(spine)
for b in bands:
    uv_spine(b)

def uv_pages(obj):
    me = obj.data
    if not me.uv_layers: me.uv_layers.new(name="UVMap")
    uv = me.uv_layers.active.data
    x0, x1 = PX0, PX1 + 0.006
    y0, y1 = PY0 - 0.002, PY1 + 0.002
    z0, z1 = -PZ / 2, PZ / 2
    # 面の法線ではなく「位置」で判定する(小口の段差面は法線がZを向くため)
    for poly in me.polygons:
        c = poly.center
        if c.x > PX1 - 0.008:
            kind = 'fore'
        elif c.y > PY1 - 0.006 or c.y < PY0 + 0.006:
            kind = 'edge'
        else:
            kind = 'flat'
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            if kind == 'flat':        # 表紙側の面
                uv[li].uv = ((co.x - x0) / (x1 - x0), (co.y - y0) / (y1 - y0))
            elif kind == 'fore':      # 小口: U=高さ / V=積層
                uv[li].uv = ((co.y - y0) / (y1 - y0), (co.z - z0) / (z1 - z0))
            else:                     # 天地: U=小口方向 / V=積層
                uv[li].uv = ((co.x - x0) / (x1 - x0), (co.z - z0) / (z1 - z0))
uv_pages(pages)

# ---------------------------------------------------------------- モディファイア適用 & 結合
ALL = [front, back, spine, pages] + bands + front_parts + back_parts + ([strap] if strap else [])
for o in ALL:
    bpy.context.view_layer.objects.active = o
    for md in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=md.name)

def join_into(main, parts):
    bpy.ops.object.select_all(action='DESELECT')
    for p in parts:
        p.select_set(True)
    main.select_set(True)
    bpy.context.view_layer.objects.active = main
    bpy.ops.object.join()

join_into(front, front_parts)          # 名前は "Cover_Front" のまま
join_into(back, back_parts + ([strap] if strap else []))
join_into(spine, bands)

FINAL = [front, back, spine, pages]
bpy.ops.object.select_all(action='DESELECT')
tris = 0
for o in FINAL:
    o.select_set(True)
    me = o.data
    me.calc_loop_triangles()
    tris += len(me.loop_triangles)
print("NAMES:", [o.name for o in FINAL])
print("TRIS:", tris)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, use_selection=True, export_format='GLB',
                          export_yup=True, export_apply=True,
                          export_image_format='JPEG', export_jpeg_quality=80)
print("EXPORTED:", OUT, os.path.getsize(OUT))

# ---------------------------------------------------------------- 検品レンダ(参照画像と同じ煽り角)
scn = bpy.context.scene
world = bpy.data.worlds.new("W"); scn.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0, 0, 0, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.06

cam_data = bpy.data.cameras.new("Cam"); cam_data.lens = 62
cam = new_obj("Cam", cam_data)


def aim(loc, up=(0, 1, 0), target=(0.0, 0.0, 0.0)):
    loc = mathutils.Vector(loc)
    fwd = (mathutils.Vector(target) - loc).normalized()
    zc = -fwd
    xc = mathutils.Vector(up).cross(zc).normalized()
    yc = zc.cross(xc)
    cam.matrix_world = mathutils.Matrix((
        (xc.x, yc.x, zc.x, loc.x),
        (xc.y, yc.y, zc.y, loc.y),
        (xc.z, yc.z, zc.z, loc.z),
        (0, 0, 0, 1)))


aim((0.41, -0.02, 0.71))     # 参照写真に近い煽り角
scn.camera = cam

def add_point(name, loc, energy, color, radius=0.06):
    d = bpy.data.lights.new(name, type='POINT')
    d.energy = energy; d.color = color; d.shadow_soft_size = radius
    o = new_obj(name, d); o.location = loc
    return o
add_point("Candle", (-0.26, 0.16, 0.55), 26.0, (1.0, 0.68, 0.34), 0.05)   # 手前左の蝋燭
add_point("Fill",   (0.55, -0.10, 0.30),  6.0, (1.0, 0.80, 0.55), 0.10)
add_point("Rim",    (-0.35, 0.10, -0.45), 4.0, (0.55, 0.62, 0.85), 0.10)

try:
    scn.render.engine = 'BLENDER_EEVEE'
except TypeError:
    scn.render.engine = 'BLENDER_EEVEE_NEXT'
scn.render.resolution_x, scn.render.resolution_y = 1080, 1350
scn.render.filepath = PREVIEW
bpy.ops.render.render(write_still=True)
print("RENDERED:", PREVIEW)

# --- intro/index.html と同じカメラ角(CAM_R=0.88 / theta=0.35 / phi=1.02 / fov_y=38) ---
# three(Y-up) の (x,y,z) は export_yup により blender の (x, -z, y) に対応する。
_R, _TH, _PH = 0.88, 0.35, 1.02
gx = _R * math.sin(_PH) * math.sin(_TH)
gy = _R * math.cos(_PH)
gz = _R * math.sin(_PH) * math.cos(_TH)
cam_data.sensor_fit = 'VERTICAL'
cam_data.sensor_height = 24.0
cam_data.lens = 12.0 / math.tan(math.radians(38.0 / 2))
aim((gx, -gz, gy))
scn.render.filepath = PREVIEW_INTRO
bpy.ops.render.render(write_still=True)
print("RENDERED:", PREVIEW_INTRO)
