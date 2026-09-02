# 異世界の叡智 没入本: 白い素体(マネキン)の人体モデル → GLB 書き出し
# 実行: "D:\SteamLibrary\steamapps\common\Blender\blender.exe" -b -P make_figure.py
# 出力: D:\kei-tools\page-flip-proto\assets\figure.glb
#       D:\kei-tools\page-flip-proto\blender\figure_preview.png / figure_preview_side.png
#
# 仕様: 白いマットな素体。顔のディテールなし。直立、腕は体からわずかに離す。
#       three.js から回せるようにパーツを分離し、各オブジェクトの原点＝関節ピボットに置く。
#         Torso (原点=骨盤)
#           ├ Head  (原点=首の付け根)
#           ├ ArmL / ArmR (原点=肩) ─ HandL / HandR (原点=手首)
#           └ LegL / LegR (原点=股関節)
#       親子付けしてあるので、肩を回せば手も付いてくる(glTF のノード階層で書き出し)。
#       ※ L/R は画面向かって左右ではなく人物本人の左右。ArmL = 人物の左腕 = -X 側。
import bpy, bmesh, math, os
from mathutils import Vector, Matrix

OUT    = r"D:\kei-tools\page-flip-proto\assets\figure.glb"
PREV_F = r"D:\kei-tools\page-flip-proto\blender\figure_preview.png"
PREV_S = r"D:\kei-tools\page-flip-proto\blender\figure_preview_side.png"

bpy.ops.wm.read_factory_settings(use_empty=True)
col = bpy.context.scene.collection
TAU = math.pi * 2.0

def new_obj(name, mesh):
    o = bpy.data.objects.new(name, mesh)
    col.objects.link(o)
    return o

# ----------------------------------------------------------------------------
# チューブ(手足・胴)ビルダ: 折れ線に沿って楕円断面を並べる。平行移動フレームで捻れ防止。
# ----------------------------------------------------------------------------
def resample_path(pts, radii, n, smooth=2):
    """折れ線を n 点に線形補間 → 近傍平均で滑らかに(肘・膝の角が取れる)。"""
    m = len(pts) - 1
    P, R = [], []
    for i in range(n):
        s = i / (n - 1) * m
        k = min(int(s), m - 1); f = s - k
        P.append(pts[k].lerp(pts[k + 1], f))
        R.append((radii[k][0] + (radii[k + 1][0] - radii[k][0]) * f,
                  radii[k][1] + (radii[k + 1][1] - radii[k][1]) * f))
    for _ in range(smooth):
        P = [P[0]] + [(P[i - 1] + P[i] * 2.0 + P[i + 1]) / 4.0 for i in range(1, n - 1)] + [P[-1]]
        R = [R[0]] + [((R[i - 1][0] + R[i][0] * 2 + R[i + 1][0]) / 4,
                       (R[i - 1][1] + R[i][1] * 2 + R[i + 1][1]) / 4) for i in range(1, n - 1)] + [R[-1]]
    return P, R

def round_cap(pts, radii, at_start, steps=4):
    """端を丸める(関節がボール状になり、回しても破綻しない)。"""
    i = 0 if at_start else len(pts) - 1
    p = pts[i]
    t = (pts[1] - pts[0]) if at_start else (pts[-1] - pts[-2])
    t.normalize()
    if at_start:
        t = -t
    rx, ry = radii[i]
    r = (rx + ry) * 0.5
    add_p, add_r = [], []
    for k in range(steps, 0, -1):
        a = (k / steps) * (math.pi / 2) * 0.92
        add_p.append(p + t * (r * math.sin(a)))
        add_r.append((rx * math.cos(a), ry * math.cos(a)))
    if at_start:
        return add_p + list(pts), add_r + list(radii)
    return list(pts) + add_p[::-1], list(radii) + add_r[::-1]

def tube(name, pts, radii, segs=28, cap_start=True, cap_end=True, res=1):
    if cap_start:
        pts, radii = round_cap(pts, radii, True)
    if cap_end:
        pts, radii = round_cap(pts, radii, False)
    n = len(pts)
    tangents = []
    for i in range(n):
        if i == 0:      t = pts[1] - pts[0]
        elif i == n - 1: t = pts[-1] - pts[-2]
        else:            t = pts[i + 1] - pts[i - 1]
        if t.length < 1e-9:
            t = Vector((0, 0, 1))
        tangents.append(t.normalized())
    # 平行移動フレーム
    ref = Vector((1, 0, 0))
    if abs(tangents[0].dot(ref)) > 0.9:
        ref = Vector((0, 1, 0))
    nrm = (ref - tangents[0] * ref.dot(tangents[0])).normalized()
    normals = [nrm]
    for i in range(1, n):
        prev, cur = tangents[i - 1], tangents[i]
        ax = prev.cross(cur)
        if ax.length < 1e-8:
            normals.append(normals[-1])
        else:
            ang = math.acos(max(-1.0, min(1.0, prev.dot(cur))))
            normals.append((Matrix.Rotation(ang, 3, ax.normalized()) @ normals[-1]).normalized())

    verts, faces, rings = [], [], []
    for i in range(n):
        u = normals[i]
        w = tangents[i].cross(u).normalized()
        rx, ry = radii[i]
        ring = []
        for j in range(segs):
            th = TAU * j / segs
            ring.append(len(verts))
            verts.append(pts[i] + u * (math.cos(th) * rx) + w * (math.sin(th) * ry))
        rings.append(ring)
    for i in range(n - 1):
        a, b = rings[i], rings[i + 1]
        for j in range(segs):
            j2 = (j + 1) % segs
            faces.append((a[j], a[j2], b[j2], b[j]))
    for idx, flip in ((0, True), (n - 1, False)):
        c = len(verts); verts.append(pts[idx])
        for j in range(segs):
            j2 = (j + 1) % segs
            faces.append((rings[idx][j2], rings[idx][j], c) if flip
                         else (rings[idx][j], rings[idx][j2], c))
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    for p in me.polygons:
        p.use_smooth = True
    return me

def add_blob(me, center, scale, u=20, v=12, rot=None, floor=None):
    """既存メッシュに楕円体を足す(足・手のひら・頭など)。floor 指定でその高さに底を平らに。"""
    bm = bmesh.new(); bm.from_mesh(me)
    res = bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=1.0)
    vs = list(res['verts'])
    bmesh.ops.scale(bm, vec=scale, verts=vs)
    if rot is not None:
        bmesh.ops.transform(bm, matrix=rot, verts=vs)
    bmesh.ops.translate(bm, vec=center, verts=vs)
    if floor is not None:
        for x in vs:
            if x.co.z < floor:
                x.co.z = floor
    bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = True
    return me

def merge_close(me, dist=0.0008):
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)
    bm.to_mesh(me); bm.free()
    me.update()

# ----------------------------------------------------------------------------
# 体格 (身長 約1.75m)。ワールド座標で関節位置を決め、各パーツはその点をローカル原点にする。
# ----------------------------------------------------------------------------
J = {
    "pelvis":   Vector((0.000,  0.000, 0.950)),
    "neck":     Vector((0.000,  0.000, 1.495)),
    "shoulderR": Vector(( 0.172, 0.000, 1.428)),
    "shoulderL": Vector((-0.172, 0.000, 1.428)),
    "wristR":   Vector(( 0.272, -0.048, 0.788)),
    "wristL":   Vector((-0.272, -0.048, 0.788)),
    "hipR":     Vector(( 0.082,  0.000, 0.945)),
    "hipL":     Vector((-0.082,  0.000, 0.945)),
}

# ---- Torso (原点 = 骨盤) ----
torso_pts = [Vector((0, 0, z)) for z in
             (0.952, 0.995, 1.060, 1.125, 1.195, 1.265, 1.330, 1.388, 1.436, 1.470, 1.498, 1.516)]
torso_rad = [(0.133, 0.094), (0.156, 0.104), (0.148, 0.098), (0.129, 0.088),
             (0.133, 0.091), (0.152, 0.100), (0.170, 0.104), (0.183, 0.104),
             (0.185, 0.099), (0.146, 0.084), (0.074, 0.059), (0.046, 0.042)]
tp, tr = resample_path(torso_pts, torso_rad, 32, smooth=2)
torso_me = tube("Torso", tp, tr, segs=40, cap_start=True, cap_end=False)
# 尻のふくらみ(背面下部)
add_blob(torso_me, (0.0, 0.042, 0.985), (0.142, 0.082, 0.100), u=20, v=12)
merge_close(torso_me)
torso = new_obj("Torso", torso_me)
for v in torso_me.vertices:                      # 原点を骨盤へ
    v.co -= J["pelvis"]
torso.location = J["pelvis"]

# ---- Head (原点 = 首の付け根) ----
head_me = tube("Head", [Vector((0, 0.004, 1.452)), Vector((0, -0.004, 1.560))],
               [(0.056, 0.052), (0.052, 0.049)], segs=24, cap_start=False, cap_end=False)
add_blob(head_me, (0.0, -0.008, 1.648), (0.090, 0.104, 0.118), u=30, v=20)   # 頭部(顔の造作なし)
merge_close(head_me)
head = new_obj("Head", head_me)
for v in head_me.vertices:
    v.co -= J["neck"]
head.location = J["neck"] - J["pelvis"]

# ---- Arms (原点 = 肩) / Hands (原点 = 手首) ----
def make_arm(side):
    """side: +1 = 人物の右(+X), -1 = 人物の左(-X)"""
    s = "R" if side > 0 else "L"
    sh, wr = J["shoulder" + s], J["wrist" + s]
    pts = [sh,
           Vector((side * 0.203, -0.004, 1.250)),
           Vector((side * 0.228, -0.010, 1.080)),   # 肘
           Vector((side * 0.252, -0.031, 0.922)),
           wr]
    rad = [(0.058, 0.056), (0.048, 0.047), (0.042, 0.041), (0.038, 0.037), (0.031, 0.030)]
    p, r = resample_path(pts, rad, 26, smooth=2)
    me = tube("Arm" + s, p, r, segs=26)
    o = new_obj("Arm" + s, me)
    for v in me.vertices:
        v.co -= sh
    o.location = sh - J["pelvis"]
    return o, sh, wr

def make_hand(side, wr):
    s = "R" if side > 0 else "L"
    me = tube("Hand" + s,
              [Vector((0, 0, 0.010)), Vector((0, -0.004, -0.035))],
              [(0.031, 0.030), (0.036, 0.024)], segs=22)          # 手首〜手の甲
    add_blob(me, (0.0, -0.010, -0.088), (0.040, 0.022, 0.062), u=22, v=14)   # 手のひら＋指
    add_blob(me, (0.0, -0.012, -0.140), (0.030, 0.019, 0.030), u=16, v=10)   # 指先
    rot = (Matrix.Rotation(math.radians(-side * 38), 4, 'Y')
           @ Matrix.Rotation(math.radians(-14), 4, 'X'))
    add_blob(me, (side * 0.031, -0.016, -0.062), (0.014, 0.014, 0.036),
             u=14, v=10, rot=rot)                                            # 親指
    merge_close(me)
    o = new_obj("Hand" + s, me)          # メッシュは既に手首原点で作ってある
    return o

armR, shR, wrR = make_arm(+1)
armL, shL, wrL = make_arm(-1)
handR = make_hand(+1, wrR)
handL = make_hand(-1, wrL)
handR.location = wrR - shR
handL.location = wrL - shL
handR.rotation_euler = (0.0, math.radians(-7), math.radians(-6))
handL.rotation_euler = (0.0, math.radians(7), math.radians(6))

# ---- Legs (原点 = 股関節) ----
def make_leg(side):
    s = "R" if side > 0 else "L"
    hip = J["hip" + s]
    pts = [Vector((side * 0.082, 0.000, 0.975)),
           Vector((side * 0.091, 0.006, 0.740)),
           Vector((side * 0.095, 0.010, 0.510)),   # 膝
           Vector((side * 0.098, 0.000, 0.290)),
           Vector((side * 0.100, 0.006, 0.088))]   # 足首
    rad = [(0.094, 0.097), (0.079, 0.082), (0.060, 0.062), (0.055, 0.057), (0.037, 0.038)]
    p, r = resample_path(pts, rad, 28, smooth=2)
    me = tube("Leg" + s, p, r, segs=26)
    add_blob(me, (side * 0.101, -0.050, 0.043), (0.046, 0.115, 0.042),
             u=22, v=14, floor=0.004)              # 足(底は平ら)
    merge_close(me)
    o = new_obj("Leg" + s, me)
    for v in me.vertices:
        v.co -= hip
    o.location = hip - J["pelvis"]
    return o

legR = make_leg(+1)
legL = make_leg(-1)

# ---- 親子付け(肩を回せば手も付いてくる) ----
for child, parent in ((head, torso), (armR, torso), (armL, torso),
                      (legR, torso), (legL, torso), (handR, armR), (handL, armL)):
    child.parent = parent

# ----------------------------------------------------------------------------
# マテリアル: マットなオフホワイト(素体)
# ----------------------------------------------------------------------------
m = bpy.data.materials.new("M_Body")
m.use_nodes = True
bsdf = m.node_tree.nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value = (0.900, 0.888, 0.865, 1.0)
bsdf.inputs["Roughness"].default_value = 0.62
for key in ("Specular IOR Level", "Specular"):
    if key in bsdf.inputs:
        bsdf.inputs[key].default_value = 0.30
        break

OBJS = [torso, head, armL, armR, handL, handR, legL, legR]
for o in OBJS:
    o.data.materials.append(m)
    bpy.context.view_layer.objects.active = o
    for md in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=md.name)

tris = 0
for o in OBJS:
    o.data.calc_loop_triangles()
    tris += len(o.data.loop_triangles)
print("TRIANGLES:", tris)

bpy.ops.object.select_all(action='DESELECT')
for o in OBJS:
    o.select_set(True)
bpy.context.view_layer.objects.active = torso
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, use_selection=True, export_format='GLB',
                          export_yup=True, export_apply=True)
print("EXPORTED:", OUT, os.path.getsize(OUT), "bytes")

# ----------------------------------------------------------------------------
# 検品レンダ (黒背景 + 前方左からの蝋燭色ポイントライト)
# ----------------------------------------------------------------------------
scn = bpy.context.scene
world = bpy.data.worlds.new("W")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0, 0, 0, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.0
scn.world = world

fm = bpy.data.meshes.new("Floor")
bmf = bmesh.new(); bmesh.ops.create_grid(bmf, x_segments=1, y_segments=1, size=6.0)
bmf.to_mesh(fm); bmf.free()
floor = new_obj("Floor", fm)
fmat = bpy.data.materials.new("M_Floor"); fmat.use_nodes = True
fb = fmat.node_tree.nodes.get("Principled BSDF")
fb.inputs["Base Color"].default_value = (0.022, 0.020, 0.018, 1)
fb.inputs["Roughness"].default_value = 0.9
floor.data.materials.append(fmat)

target = bpy.data.objects.new("Target", None)
col.objects.link(target)
target.location = (0.0, 0.0, 0.95)

cam_data = bpy.data.cameras.new("Cam"); cam_data.lens = 55
cam = new_obj("Cam", cam_data)
scn.camera = cam
c = cam.constraints.new('TRACK_TO')
c.target = target; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'

def add_point(name, loc, energy, color, radius=0.12):
    ld = bpy.data.lights.new(name, type='POINT')
    ld.energy = energy; ld.color = color; ld.shadow_soft_size = radius
    o = new_obj(name, ld); o.location = loc
    return o

add_point("Candle", (-1.05, -1.30, 1.25), 210.0, (1.0, 0.66, 0.34), 0.10)  # 蝋燭(前方左)
add_point("Fill",   (-0.65, -1.20, 0.60),  26.0, (1.0, 0.74, 0.48), 0.30)
add_point("Rim",    (1.20, 1.55, 1.90),    75.0, (0.55, 0.66, 0.90), 0.35)

try:
    scn.render.engine = 'BLENDER_EEVEE'
except Exception:
    scn.render.engine = 'BLENDER_EEVEE_NEXT'
try:
    scn.eevee.taa_render_samples = 96
except Exception:
    pass
try:
    scn.view_settings.view_transform = 'AgX'
    scn.view_settings.look = 'AgX - Medium High Contrast'
except Exception:
    try:
        scn.view_settings.view_transform = 'Filmic'
    except Exception:
        pass
scn.render.resolution_x, scn.render.resolution_y = 1080, 1350
scn.render.image_settings.file_format = 'PNG'

def shoot(loc, path):
    cam.location = loc
    bpy.context.view_layer.update()
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("RENDERED:", path)

shoot((2.05, -3.15, 1.30), PREV_F)        # 3/4 ビュー
shoot((3.70, -0.75, 1.25), PREV_S)        # サイド寄り
print("DONE")
