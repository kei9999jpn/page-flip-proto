# 異世界の叡智 没入本: 閉じた古書の3Dモデルを生成して GLB 書き出し
# 実行: blender.exe -b -P make_book.py
# 出力: D:\kei-tools\page-flip-proto\assets\book.glb
import bpy, bmesh, math, random

OUT = r"D:\kei-tools\page-flip-proto\assets\book.glb"
random.seed(7)

# ---- クリーンシーン ----
bpy.ops.wm.read_factory_settings(use_empty=True)
col = bpy.context.scene.collection

# 本の寸法 (m): 幅(小口方向)0.24, 高さ0.32, 厚み0.07
W, H, T = 0.24, 0.32, 0.07
COVER_T = 0.008          # 表紙板の厚み
OVERHANG = 0.008         # 表紙が中身より張り出す量(チリ)

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

# 座標系: X=小口方向(+Xが小口/開く側, -Xが背), Y=上下(高さ), Z=厚み
# ---- 表紙・裏表紙 ----
front = make_box("Cover_Front", W + OVERHANG, H + OVERHANG*2, COVER_T,
                 (OVERHANG/2, 0,  T/2 - COVER_T/2))
back  = make_box("Cover_Back",  W + OVERHANG, H + OVERHANG*2, COVER_T,
                 (OVERHANG/2, 0, -T/2 + COVER_T/2))

# ---- 背表紙 (丸背: 半円筒) ----
sm = bpy.data.meshes.new("Spine")
bm = bmesh.new()
SPINE_R = T/2
ret = bmesh.ops.create_circle(bm, cap_ends=False, radius=SPINE_R, segments=16)
# 円をXZ平面へ(デフォルトはXY平面) → X軸回りに90度回転
import mathutils
rotm = mathutils.Matrix.Rotation(math.radians(90), 4, 'X')
bmesh.ops.transform(bm, matrix=rotm, verts=bm.verts)
# 半分に: x>0 の頂点を削除して、-X側へ膨らむ半円弧(Z=-R..+R)に
for v in [v for v in bm.verts if v.co.x > 1e-6]:
    bm.verts.remove(v)
# 弧を高さ方向(Y)に押し出し
r = bmesh.ops.extrude_edge_only(bm, edges=bm.edges[:])
verts_ext = [e for e in r['geom'] if isinstance(e, bmesh.types.BMVert)]
bmesh.ops.translate(bm, vec=(0, H + OVERHANG*2, 0), verts=verts_ext)
bmesh.ops.translate(bm, vec=(0, -(H + OVERHANG*2)/2, 0), verts=bm.verts)
bm.to_mesh(sm); bm.free()
spine = new_obj("Spine", sm)
spine.location = (-W/2, 0, 0)
solid = spine.modifiers.new("solid", 'SOLIDIFY'); solid.thickness = COVER_T

# ---- 中身のページブロック ----
PW, PH, PT = W - 0.004, H - 0.006, T - COVER_T*2 - 0.002
pm = bpy.data.meshes.new("Pages")
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1)
bmesh.ops.scale(bm, vec=(PW, PH, PT), verts=bm.verts)
# 小口側(+X)と天地に紙のうねり: 細分化してノイズ
bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=14, use_grid_fill=True)
for v in bm.verts:
    # 小口(+X面)と天地(Y端)の頂点を少し波打たせる(Z方向の層のうねり+X方向の不揃い)
    edge_x = v.co.x > PW*0.49
    edge_y = abs(v.co.y) > PH*0.49
    if edge_x or edge_y:
        v.co.x += random.uniform(-0.0006, 0.0006) if edge_x else 0
        wob = math.sin(v.co.z * 180.0) * 0.0005
        v.co.x += wob if edge_x else 0
        v.co.y += (random.uniform(-0.0004, 0.0004) if edge_y else 0)
bm.to_mesh(pm); bm.free()
pages = new_obj("Pages", pm)
pages.location = (0.001, 0, 0)
for p in pm.polygons:
    p.use_smooth = True
for p in sm.polygons:
    p.use_smooth = True

# ---- マテリアル割当(名前だけ。テクスチャはthree.js側で差し込む) ----
def mat(name, rgba):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = 0.85
    return m

m_cover = mat("M_Cover", (0.35, 0.27, 0.18, 1))   # 表紙: テクスチャ付き
m_spine = mat("M_Spine", (0.20, 0.15, 0.10, 1))   # 背: 濃い無地革
m_pages = mat("M_Pages", (0.87, 0.82, 0.70, 1))   # 古紙

TEX = r"D:\kei-tools\page-flip-proto\assets\cover-texture.png"
import os
if os.path.exists(TEX):
    img = bpy.data.images.load(TEX)
    nt = m_cover.node_tree
    tex_node = nt.nodes.new('ShaderNodeTexImage')
    tex_node.image = img
    bsdf = nt.nodes.get("Principled BSDF")
    nt.links.new(tex_node.outputs["Color"], bsdf.inputs["Base Color"])

for o in (front, back):
    o.data.materials.append(m_cover)
spine.data.materials.append(m_spine)
pages.data.materials.append(m_pages)

# ---- UV展開 ----
# 表紙・裏表紙: 外側の面(表=+Z/裏=-Z)を 0-1 いっぱいに正確マッピング(テクスチャ全面貼り)。
# それ以外の面(コバ・内側)は隅の小さな領域に押し込む(革の端が伸びて見えるだけ)。
def uv_cover(obj, outer_z_positive):
    me = obj.data
    if not me.uv_layers: me.uv_layers.new(name="UVMap")
    uv = me.uv_layers.active.data
    # バウンディング(ローカル)
    xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]
    x0, x1 = min(xs), max(xs); y0, y1 = min(ys), max(ys)
    for poly in me.polygons:
        outer = (poly.normal.z > 0.9) if outer_z_positive else (poly.normal.z < -0.9)
        for li in poly.loop_indices:
            v = me.vertices[me.loops[li].vertex_index].co
            if outer:
                u = (v.x - x0) / (x1 - x0)
                w = (v.y - y0) / (y1 - y0)
                if not outer_z_positive:
                    u = 1.0 - u  # 裏表紙は左右反転で貼る
                uv[li].uv = (u, w)
            else:
                uv[li].uv = (0.02 + 0.03 * ((v.x - x0) / (x1 - x0)),
                             0.02 + 0.03 * ((v.y - y0) / (y1 - y0)))

uv_cover(front, True)
uv_cover(back, False)
for o in (spine, pages):
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode='OBJECT')
    o.select_set(False)

# ---- モディファイア適用 & 書き出し ----
for o in (front, back, spine, pages):
    bpy.context.view_layer.objects.active = o
    for md in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=md.name)

for o in (front, back, spine, pages):
    o.select_set(True)

import os
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, use_selection=True, export_format='GLB',
                          export_yup=True, export_apply=True)
print("EXPORTED:", OUT)

# 検品用レンダ(簡易): カメラとライトを置いて1枚PNG
cam_data = bpy.data.cameras.new("Cam")
cam = new_obj("Cam", cam_data)
cam.location = (0.45, -0.42, 0.35)
cam.rotation_euler = (math.radians(62), 0, math.radians(46))
bpy.context.scene.camera = cam
light_data = bpy.data.lights.new("Sun", type='SUN'); light_data.energy = 3.0
light = new_obj("Sun", light_data)
light.rotation_euler = (math.radians(50), math.radians(-20), math.radians(30))
scn = bpy.context.scene
scn.render.engine = 'BLENDER_EEVEE'
scn.render.resolution_x, scn.render.resolution_y = 900, 700
scn.render.filepath = r"D:\kei-tools\page-flip-proto\blender\book_preview.png"
bpy.ops.render.render(write_still=True)
print("RENDERED preview")
