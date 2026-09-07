// ============================================================
// 3D書斎と本。app/index.html v42 の描画設定をそのまま移植。
//   Bloom / Bokeh(PCのみ) / GradeShader / ろうそく明滅3正弦 / 自動軽量化 auto-lite
//   栞の紐・印の金の印・塵・吸い込みの光の粒・端末の傾き
// ★拡張ポイント:
//   - 部屋の3D化      → RoomBackground を差し替える
//   - 開く演出の豪華化 → openProgress()/setOpening() と main.ts の beginRead 台本
//   - 紙の物質感      → applyLeather() と reader/Reader.ts の drawInner()
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { asset, MOBILE, QP, BUILD, loadFavs, hasBookmark } from '../state';
import { RoomBackground } from './RoomBackground';

const QUALITY = !QP.has('classic');
const CAM_R = 1.55;
const CANDLE_I = QUALITY ? 2.0 : 1.6;
const DIVE_DUR = 2.0;                     // ページの間へ潜る時間（秒）2026-09-07 夜: 台本2倍に合わせて延長

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 }, uVig: { value: 0.30 }, uGrain: { value: 0.018 }, uCA: { value: 0.0012 }, uWarm: { value: 1.0 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime, uVig, uGrain, uCA, uWarm; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 uv = vUv; vec2 d = uv - 0.5; float r2 = dot(d, d);
      vec2 off = d * uCA * r2 * 8.0;
      vec4 c; c.r = texture2D(tDiffuse, uv + off).r; c.g = texture2D(tDiffuse, uv).g; c.b = texture2D(tDiffuse, uv - off).b; c.a = texture2D(tDiffuse, uv).a;
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 shadowTint = vec3(0.95, 0.96, 1.04), lightTint = vec3(1.03, 1.0, 0.96);
      c.rgb *= mix(shadowTint, lightTint, smoothstep(0.05, 0.75, l));
      c.rgb = mix(vec3(l), c.rgb, 1.04);
      c.rgb = pow(max(c.rgb, 0.0), vec3(1.0 / uWarm));
      float vig = 1.0 - uVig * smoothstep(0.15, 0.95, r2 * 2.2);
      c.rgb *= vig;
      float g = (hash(uv * vec2(1920.0, 1080.0) + fract(uTime)) - 0.5) * uGrain;
      c.rgb += g * (0.35 + 0.65 * (1.0 - l));
      gl_FragColor = c;
    }`,
};

const RIB_YAW = -0.06;   // 栞タブの向き（本の上端＝奥端から覗く。2026-09-07 夜 KEI「本の上に挟む」）

export class BookScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10);
  readonly room = new RoomBackground();

  book: THREE.Object3D | null = null;
  hinge: THREE.Group | null = null;
  bookBB: THREE.Box3 | null = null;
  private pivot = new THREE.Group();
  private ribbon: THREE.Mesh | null = null;
  private favMarks: THREE.Group | null = null;
  private stageGroup: THREE.Group | null = null;

  private candleB: THREE.PointLight;
  private fireB: THREE.PointLight;
  private dust: THREE.Points;
  private dustGeo = new THREE.BufferGeometry();
  private dspd: number[] = [];
  private ND = MOBILE ? 120 : 220;

  private titleDecal: THREE.Mesh | null = null;
  private titleSweep: THREE.Mesh | null = null;
  private sweepTex: THREE.CanvasTexture | null = null;
  private flareA: THREE.PointLight;             // 表紙の内側から溢れる光
  private flareB: THREE.PointLight;             // ページの谷から立つ光
  private rimB: THREE.DirectionalLight;
  private rimHome = new THREE.Vector3(-0.8, 0.9, -0.6);
  private capture: ((url: string) => void) | null = null;
  /** 開く演出の光量 0..1（main.ts の台本が毎フレーム入れる） */
  openFlare = 0;
  /** 表紙の箔に光が走る 0..1 */
  gild = 0;

  private motes: THREE.Points;
  private mGeo = new THREE.BufferGeometry();
  private mPos: Float32Array; private mVel: Float32Array; private mLife: Float32Array;
  private MN = MOBILE ? 800 : 1600;
  private motesOn = false; private moteT = 0;

  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private bokehPass: BokehPass | null = null;
  private gradePass: ShaderPass | null = null;
  private perfN = 0; private perfT = 0; private perfDone = false;

  camTheta = 0.35; camPhi = 1.02;
  bookScale = 0; bookTarget = 0;
  shake = 0;
  readonly tiltRaw = { x: 0, y: 0 };
  private tiltCur = { x: 0, y: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, MOBILE ? 1.5 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.72;
    this.renderer.autoClear = false;
    if (QUALITY) { this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap; }

    this.scene.add(this.camera);
    this.scene.add(new THREE.AmbientLight(0x2a2018, QUALITY ? 0.75 : 1.0));
    this.candleB = new THREE.PointLight(0xffc98f, CANDLE_I, 2.5, 2.0);
    this.candleB.position.set(0.28, 0.34, 0.30);
    this.scene.add(this.candleB);
    this.rimB = new THREE.DirectionalLight(QUALITY ? 0x6f80b8 : 0x7a86a8, QUALITY ? 0.55 : 0.9);
    this.rimB.position.copy(this.rimHome); this.scene.add(this.rimB);
    this.fireB = new THREE.PointLight(0xff6a22, QUALITY ? 0.9 : 0, 4.0, 2.0);
    this.fireB.position.set(-1.25, -0.05, 0.45); this.scene.add(this.fireB);
    // 開く瞬間の光は「本の内側」から出す。書斎の右下（ろうそく側）を強くすると
    // 画面右下が白く飛んで文字が読めなくなる（2026-09-07 KEI 指摘）ので、
    // ろうそくは逆に一瞬だけ落とし、光源は本の中に置く。
    this.flareA = new THREE.PointLight(0xffd9a4, 0, 1.15, 2.4);
    this.flareA.position.set(-0.06, 0.085, 0.0); this.scene.add(this.flareA);
    this.flareB = new THREE.PointLight(0xfff0cc, 0, 0.55, 2.4);
    this.flareB.position.set(0.02, 0.06, 0.0); this.scene.add(this.flareB);
    if (QUALITY) {
      this.candleB.castShadow = true;
      this.candleB.shadow.mapSize.set(MOBILE ? 512 : 1024, MOBILE ? 512 : 1024);
      this.candleB.shadow.bias = -0.003;
      this.candleB.shadow.radius = 4;
    }
    if (QUALITY) { this.camera.add(this.room.object); this.room.load(() => this.room.layout(this.camera)); }
    this.scene.add(this.pivot);

    // 塵
    const dpos = new Float32Array(this.ND * 3);
    for (let i = 0; i < this.ND; i++) {
      dpos[i * 3] = (Math.random() - 0.5) * 1.4; dpos[i * 3 + 1] = (Math.random() - 0.5) * 1.0; dpos[i * 3 + 2] = (Math.random() - 0.5) * 1.4;
      this.dspd.push(0.008 + Math.random() * 0.02);
    }
    this.dustGeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
    this.dust = new THREE.Points(this.dustGeo, new THREE.PointsMaterial({ color: 0xd8b878, size: 0.0035, transparent: true, opacity: 0.55, depthWrite: false }));
    this.scene.add(this.dust);

    // 吸い込みの光の粒
    this.mPos = new Float32Array(this.MN * 3); this.mVel = new Float32Array(this.MN * 3); this.mLife = new Float32Array(this.MN);
    this.mGeo.setAttribute('position', new THREE.BufferAttribute(this.mPos, 3));
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,240,200,1)'); r.addColorStop(0.35, 'rgba(255,200,120,.6)'); r.addColorStop(1, 'rgba(255,150,60,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    this.motes = new THREE.Points(this.mGeo, new THREE.PointsMaterial({
      size: 0.016, map: new THREE.CanvasTexture(c), transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffd9a0,
    }));
    this.motes.visible = false;
    this.camera.add(this.motes);

    this.buildComposer();
  }

  load(onReady: () => void): void {
    const glbOverride = QP.get('glb');
    // v2: 本体は Draco + WebP(1024) に落とした自ホスト版（4.18MB → 0.86MB）。
    //     デコーダも public/draco/ に同梱して自ホスト（CDN依存ゼロ）。
    //     元の assets/book.glb は ?glb=assets/book.glb で読める（検証用）。
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath(new URL('draco/', document.baseURI).href);
    loader.setDRACOLoader(draco);
    const url = glbOverride
      ? new URL('../' + glbOverride, document.baseURI).href + '?_=' + Date.now()
      : new URL('book.glb?b=' + BUILD, document.baseURI).href;
    loader.load(url, g => {
      const book = g.scene; book.rotation.z = 0.06; this.pivot.add(book); this.book = book;
      book.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.material) {
          const mat = m.material as THREE.MeshStandardMaterial;
          mat.roughness = Math.max(mat.roughness || 0, 0.95);
          mat.metalness = 0;
          if (mat.color) mat.color.multiplyScalar(0.86);
          if (QUALITY) { m.castShadow = true; m.receiveShadow = true; mat.envMapIntensity = 0.22; }
        }
      });
      if (QUALITY) this.applyLeather(book);
      const cover = book.getObjectByName('Cover_Front');
      if (cover) {
        const bb = new THREE.Box3().setFromObject(cover);
        const hinge = new THREE.Group();
        hinge.position.set(bb.min.x, (bb.min.y + bb.max.y) / 2, 0);
        book.add(hinge); hinge.attach(cover); this.hinge = hinge;
      }
      this.pivot.scale.setScalar(1); this.bookScale = 1; this.bookTarget = 1;
      this.buildRibbon(); this.buildFavMarks(); if (QUALITY) this.buildStage();
      this.buildTitleDecal(cover || null);
      onReady();
    });
  }

  private applyLeather(root: THREE.Object3D): void {
    const tl = new THREE.TextureLoader();
    const nrm = tl.load(asset('cover-normal.webp')); nrm.flipY = false; nrm.colorSpace = THREE.NoColorSpace;
    const rgh = tl.load(asset('cover-rough.jpg')); rgh.flipY = false; rgh.colorSpace = THREE.NoColorSpace;
    root.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.material) return;
      if (/Cover_Front|Cover_Back/.test(m.name)) {
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.normalMap = nrm; mat.normalScale = new THREE.Vector2(0.55, 0.55);
        mat.roughnessMap = rgh; mat.roughness = 1.0; mat.envMapIntensity = 0.35; mat.needsUpdate = true;
      }
    });
  }


  // ------------------------------------------------------------------
  // 表紙の箔押し「名言の書」（KEI 2026-09-07: DOM のタイトルカードは出さず、
  // 表紙そのものに刻む）。GLB の UV が分からないのでテクスチャに焼かず、
  // 表紙のすぐ上に薄い板（デカール）を貼る。見た目は箔押しと同じ。
  // 斜光でだけ読める控えめな金。位置は紋章の下。
  // ------------------------------------------------------------------
  private titleCanvas(): { tex: THREE.CanvasTexture; ratio: number } {
    const W = 1024, H = 300;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    const chars = ['名', '言', 'の', '書'];
    const fs = 168, sp = fs * 0.30;
    g.font = '500 ' + fs + 'px "Hiragino Mincho ProN","Yu Mincho","Shippori Mincho",serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const widths = chars.map(ch => g.measureText(ch).width);
    const total = widths.reduce((a, b) => a + b, 0) + sp * (chars.length - 1);
    let x = (W - total) / 2;
    const grad = g.createLinearGradient(0, H * 0.18, 0, H * 0.86);
    grad.addColorStop(0, '#f6e6ae'); grad.addColorStop(0.42, '#cda54c');
    grad.addColorStop(0.56, '#9d7a2c'); grad.addColorStop(1, '#e6cf88');
    for (let i = 0; i < chars.length; i++) {
      const cx = x + widths[i] / 2;
      // 押し込みの影（箔押しの窪み）
      g.fillStyle = 'rgba(20,12,4,.55)';
      g.fillText(chars[i], cx + 3, H / 2 + 3);
      g.fillStyle = grad;
      g.fillText(chars[i], cx, H / 2);
      // 縁の一本ハイライト
      g.strokeStyle = 'rgba(255,244,206,.35)'; g.lineWidth = 1.6;
      g.strokeText(chars[i], cx - 0.8, H / 2 - 1.2);
      x += widths[i] + sp;
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return { tex, ratio: W / H };
  }
  private sweepTexture(): THREE.CanvasTexture {
    const W = 256, H = 8;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    const lg = g.createLinearGradient(0, 0, W, 0);
    lg.addColorStop(0.00, 'rgba(0,0,0,0)');
    lg.addColorStop(0.42, 'rgba(0,0,0,0)');
    lg.addColorStop(0.50, 'rgba(255,246,214,1)');
    lg.addColorStop(0.58, 'rgba(0,0,0,0)');
    lg.addColorStop(1.00, 'rgba(0,0,0,0)');
    g.fillStyle = lg; g.fillRect(0, 0, W, H);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  private buildTitleDecal(cover: THREE.Object3D | null): void {
    const book = this.book; if (!book || !cover || this.titleDecal) return;
    const hinge = this.hinge; if (!hinge) return;
    // 表紙のバウンディングボックスを本のローカル座標で測る（buildRibbon と同じ手）
    const rz = book.rotation.z, py = this.pivot.position.y, hz = hinge.rotation.z;
    book.rotation.z = 0; hinge.rotation.z = 0; this.pivot.position.y = 0;
    this.pivot.updateMatrixWorld(true);
    const cb = new THREE.Box3().setFromObject(cover);
    book.rotation.z = rz; hinge.rotation.z = hz; this.pivot.position.y = py;
    const cw = cb.max.x - cb.min.x, cz = cb.max.z - cb.min.z;
    const { tex, ratio } = this.titleCanvas();
    const w = cw * 0.52, h = w / ratio;
    const geo = new THREE.PlaneGeometry(w, h);
    geo.rotateX(-Math.PI / 2);                       // 表紙の面（+Y を向く）に寝かせる
    const mat = new THREE.MeshStandardMaterial({
      map: tex, transparent: true, alphaTest: 0.02, depthWrite: false,
      metalness: 0.85, roughness: 0.28, envMapIntensity: 0.9,
      emissive: new THREE.Color(0xffd48a), emissiveIntensity: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const m = new THREE.Mesh(geo, mat);
    // 紋章の下（本の上端 = z 小、下端 = z 大）
    const px = (cb.min.x + cb.max.x) / 2 + cw * 0.02;
    const pz = cb.min.z + cz * 0.70;
    const pyTop = cb.max.y + 0.0006;
    m.position.set(px - hinge.position.x, pyTop - hinge.position.y, pz - hinge.position.z);
    m.renderOrder = 2;
    hinge.add(m); this.titleDecal = m;

    // 箔の上を光が走る板（同じ字型で抜く）
    this.sweepTex = this.sweepTexture();
    const sw = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({
      map: this.sweepTex, alphaMap: tex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }));
    sw.position.copy(m.position); sw.position.y += 0.0002;
    sw.renderOrder = 3; sw.visible = false;
    hinge.add(sw); this.titleSweep = sw;
  }

  /** 直後の1フレームを画像にして返す（読書画面の背景に敷く） */
  captureFrame(cb: (url: string) => void): void { this.capture = cb; }

  private buildStage(): void {
    if (!this.book || !this.bookBB || this.stageGroup) return;
    const bb = this.bookBB;
    this.stageGroup = new THREE.Group();
    const y = bb.min.y - 0.004;
    const desk = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), new THREE.ShadowMaterial({ opacity: 0.5, color: 0x000000 }));
    desk.rotation.x = -Math.PI / 2; desk.position.y = y; desk.receiveShadow = true; this.stageGroup.add(desk);
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d')!;
    const r = g.createRadialGradient(128, 128, 20, 128, 128, 128);
    r.addColorStop(0, 'rgba(0,0,0,.85)'); r.addColorStop(0.55, 'rgba(0,0,0,.35)'); r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r; g.fillRect(0, 0, 256, 256);
    const bw = bb.max.x - bb.min.x, bz = bb.max.z - bb.min.z;
    const contact = new THREE.Mesh(
      new THREE.PlaneGeometry(bw * 1.55, bz * 1.45),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: 0.9 }),
    );
    contact.rotation.x = -Math.PI / 2;
    contact.position.set((bb.min.x + bb.max.x) / 2 + bw * 0.03, y + 0.001, (bb.min.z + bb.max.z) / 2);
    contact.renderOrder = -1;
    this.stageGroup.add(contact);
    this.book.add(this.stageGroup);
  }

  private buildRibbon(): void {
    const book = this.book; if (!book) return;
    const rz = book.rotation.z, py = this.pivot.position.y;
    book.rotation.z = 0; this.pivot.position.y = 0; this.pivot.updateMatrixWorld(true);
    this.bookBB = new THREE.Box3().setFromObject(book);
    book.rotation.z = rz; this.pivot.position.y = py;
    const bb = this.bookBB;
    const bw = bb.max.x - bb.min.x, bh = bb.max.z - bb.min.z;

    // 羊皮紙の栞タブ。bookmark.webp の上端 F 分だけを使い、閉じた本の上端(min.z)から覗かせる。
    const F = 0.30;                                   // 使うテクスチャの割合（麻紐＋マーク＋少しの紙）
    const peek = bh * 0.21;                          // 本の上端から出ている長さ
    const len = peek / 0.72;                          // 残り 28% は本の中（ページに挟まっている）
    const w = len * (400 / (1805 * F));               // 切り出した領域の縦横比

    const tex = new THREE.TextureLoader().load(new URL('bookmark.webp', document.baseURI).href);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(1, F); tex.offset.set(0, 1 - F);

    const geo = new THREE.PlaneGeometry(w, len, 1, 8);
    geo.translate(0, -len / 2, 0);                    // 原点＝タブの先端（テクスチャ上端）
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {             // 先端をわずかに反らせて光を受けさせる
      const k = 1 + pos.getY(i) / len;                // 先端 1 → 根元 0
      pos.setZ(i, k * k * len * 0.18);
    }
    geo.rotateX(-Math.PI / 2); geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      map: tex, color: 0xe8ddc6, transparent: true, alphaTest: 0.42, roughness: 0.96, metalness: 0, side: THREE.DoubleSide,
    });
    this.ribbon = new THREE.Mesh(geo, mat);
    // 本の上端（奥端 min.z）から覗かせる。表紙のすぐ下に挟み、先端を起こして本体に隠れないようにする
    this.ribbon.position.set(bb.min.x + bw * 0.58, bb.max.y - (bb.max.y - bb.min.y) * 0.22, bb.min.z - peek);
    this.ribbon.rotation.x = 0.30;          // 先端を持ち上げて面をカメラへ向ける
    this.ribbon.rotation.y = RIB_YAW;
    book.add(this.ribbon);
    this.ribbon.visible = hasBookmark();
  }

  buildFavMarks(): void {
    if (!this.book || !this.bookBB) return;
    if (this.favMarks) { this.book.remove(this.favMarks); this.favMarks = null; }
    const favs = loadFavs();
    if (!favs.length) return;
    const bb = this.bookBB;
    this.favMarks = new THREE.Group();
    const bw = bb.max.x - bb.min.x, by = bb.max.y - bb.min.y, bz = bb.max.z - bb.min.z;
    const mat = new THREE.MeshStandardMaterial({ color: 0xd9b25a, roughness: 0.35, metalness: 0.7, emissive: 0x3a2a08 });
    const geo = new THREE.BoxGeometry(bw * 0.012, Math.max(0.0006, by * 0.006), bz * 0.028);
    favs.slice(0, 80).forEach((p, i) => {
      const m = new THREE.Mesh(geo, mat);
      const k = (p % 790) / 790;
      const z = bb.max.z - bz * (0.12 + ((i * 0.618) % 1) * 0.76);
      m.position.set(bb.max.x + bw * 0.003, bb.min.y + by * (0.18 + k * 0.64), z);
      this.favMarks!.add(m);
    });
    this.book.add(this.favMarks);
  }

  get ribbonMesh(): THREE.Mesh | null { return this.ribbon; }
  setRibbonVisible(v: boolean): void { if (this.ribbon) this.ribbon.visible = v; }
  refreshRibbon(): void { if (this.ribbon) this.ribbon.visible = hasBookmark(); }

  // ---- 吸い込みの光の粒 ----
  private moteSpawn(i: number): void {
    const z = -(0.35 + Math.random() * 1.4), spread = 0.62 * (-z);
    this.mPos[i * 3] = (Math.random() - 0.5) * 2 * spread;
    this.mPos[i * 3 + 1] = (Math.random() - 0.5) * 2 * spread * 1.6;
    this.mPos[i * 3 + 2] = z;
    this.mVel[i * 3] = (Math.random() - 0.5) * 0.08;
    this.mVel[i * 3 + 1] = 0.02 + Math.random() * 0.10;
    this.mVel[i * 3 + 2] = 0.35 + Math.random() * 0.9;
    this.mLife[i] = 0.6 + Math.random() * 1.6;
  }
  motesStart(): void { this.motesOn = true; this.moteT = 0; this.motes.visible = true; for (let i = 0; i < this.MN; i++) { this.moteSpawn(i); this.mLife[i] *= Math.random(); } }
  motesStop(): void { this.motesOn = false; this.motes.visible = false; }
  private motesStep(dt: number): void {
    if (!this.motesOn) return;
    this.moteT += dt;
    for (let i = 0; i < this.MN; i++) {
      this.mLife[i] -= dt;
      if (this.mLife[i] <= 0) { this.moteSpawn(i); continue; }
      this.mPos[i * 3] += this.mVel[i * 3] * dt;
      this.mPos[i * 3 + 1] += this.mVel[i * 3 + 1] * dt;
      this.mPos[i * 3 + 2] += this.mVel[i * 3 + 2] * dt * (1 + this.moteT * 0.8);
      if (this.mPos[i * 3 + 2] > -0.05) this.mLife[i] = 0;
    }
    this.mGeo.attributes.position.needsUpdate = true;
    (this.motes.material as THREE.PointsMaterial).opacity = Math.min(0.8, this.moteT * 1.0);
  }
  /** 机に落ちた衝撃で塵が舞う */
  burstDust(): void {
    for (let i = 0; i < this.dspd.length; i++) this.dspd[i] = 0.05 + Math.random() * 0.08;
    setTimeout(() => { for (let i = 0; i < this.dspd.length; i++) this.dspd[i] = 0.008 + Math.random() * 0.02; }, 1800);
  }

  private buildComposer(): void {
    if (!QUALITY || QP.get('q_post') === '0') return;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (!MOBILE) {
      this.bokehPass = new BokehPass(this.scene, this.camera, { focus: CAM_R, aperture: 0.00004, maxblur: 0.0045 });
      this.composer.addPass(this.bokehPass);
    }
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), MOBILE ? 0.32 : 0.42, 0.65, 0.80);
    this.composer.addPass(this.bloomPass);
    this.gradePass = new ShaderPass(GradeShader);
    if (QP.get('q_vig')) this.gradePass.uniforms.uVig.value = +QP.get('q_vig')!;
    if (MOBILE) { this.gradePass.uniforms.uGrain.value = 0.012; this.gradePass.uniforms.uCA.value = 0.0; }
    this.composer.addPass(this.gradePass);
    this.composer.addPass(new OutputPass());
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }

  resize(): void {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.room.layout(this.camera);
    if (this.composer) {
      this.composer.setSize(innerWidth, innerHeight);
      if (this.bloomPass) this.bloomPass.resolution.set(innerWidth / 2, innerHeight / 2);
    }
  }

  /**
   * 毎フレーム。opts で「開く」「吸い込み」「閉じる」の状態を渡す。
   * 描画設定・数式は現行 app/ と1文字も変えていない。
   */
  update(opts: {
    dt: number; wdt: number; t: number; raw: number;
    dragging: boolean; opening: boolean; diving: boolean; diveT: number;
    autoSpin: boolean; camOverride: { r: number; ph: number } | null;
  }): void {
    if (this.composer && !this.perfDone) {
      this.perfN++; this.perfT += opts.raw;
      if (this.perfT > 8) {
        this.perfDone = true;
        const fps = this.perfN / this.perfT;
        if (fps < 22) {
          this.composer = null; this.renderer.shadowMap.enabled = false; this.candleB.castShadow = false;
          console.log('quality: auto-lite', fps.toFixed(1));
        }
      }
    }
    this.renderer.clear();
    const book = this.book;
    if (!book) return;
    const { dt, wdt, t } = opts;

    this.bookScale += (this.bookTarget - this.bookScale) * (1 - Math.exp(-wdt / 0.28));
    this.pivot.scale.setScalar(Math.max(0.0001, this.bookScale));
    this.pivot.position.y = 0.10 + Math.sin(t * 0.9) * 0.008;
    if (opts.autoSpin) this.camTheta += dt * 0.055;
    while (this.camTheta > Math.PI) this.camTheta -= Math.PI * 2;
    while (this.camTheta < -Math.PI) this.camTheta += Math.PI * 2;

    if (this.shake > 0) { this.shake *= Math.exp(-wdt / 0.18); if (this.shake < 0.01) this.shake = 0; }

    this.tiltCur.x += (this.tiltRaw.x - this.tiltCur.x) * 0.08;
    this.tiltCur.y += (this.tiltRaw.y - this.tiltCur.y) * 0.08;
    this.candleB.position.set(0.28 + this.tiltCur.x * 0.22, 0.34 + this.tiltCur.y * 0.12, 0.30 - this.tiltCur.y * 0.15);
    this.candleB.intensity = (CANDLE_I + Math.sin(t * 0.71) * 0.18 + Math.sin(t * 1.63 + 1.1) * 0.11 + Math.sin(t * 0.29 + 2.4) * 0.14 + this.shake * 0.6)
      * (1 - this.openFlare * 0.80);                 // 開く瞬間は書斎の灯りを引き、光を本の中に集める
    // 端末を傾けると縁の光の向きが動く（±8°ぶん）
    this.rimB.position.set(
      this.rimHome.x - this.tiltCur.x * 0.42,
      this.rimHome.y - Math.abs(this.tiltCur.y) * 0.10,
      this.rimHome.z + this.tiltCur.y * 0.30,
    );
    // 開く演出の光（本の内側から溢れる。白飛びさせないよう上限を切る）
    if (this.openFlare > 0.0001 || this.flareA.intensity > 0.0001) {
      const f = this.openFlare;
      const fl = 0.9 + Math.sin(t * 21) * 0.06 + Math.sin(t * 7.3) * 0.04;
      this.flareA.intensity = f * 0.90 * fl;
      this.flareB.intensity = f * f * 0.42 * fl;
      if (this.bloomPass) this.bloomPass.strength = (MOBILE ? 0.32 : 0.42) + f * (MOBILE ? 0.18 : 0.24);
      this.renderer.toneMappingExposure = 0.72 + f * 0.04;
      if (this.gradePass) this.gradePass.uniforms.uVig.value = 0.30 - f * 0.14;
    }
    // 表紙の箔に光が走る
    if (this.titleDecal) {
      const mat = this.titleDecal.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = this.gild * 0.55 + this.openFlare * 0.35;
      if (this.titleSweep && this.sweepTex) {
        const on = this.gild > 0.001;
        this.titleSweep.visible = on;
        if (on) {
          const sm = this.titleSweep.material as THREE.MeshBasicMaterial;
          sm.opacity = Math.min(1, Math.sin(Math.PI * Math.min(1, this.gild)) * 1.6);
          this.sweepTex.offset.x = -0.5 + this.gild * 1.15;
        }
      }
    }
    if (QUALITY) {
      const fl = Math.sin(t * 1.9) * 0.5 + Math.sin(t * 3.7 + 0.8) * 0.3 + Math.sin(t * 0.53 + 2.0) * 0.2;
      this.fireB.intensity = 0.9 + fl * 0.22 + this.shake * 0.4;
      this.room.setBreath(0.97 + fl * 0.025 + (this.candleB.intensity - CANDLE_I) * 0.03);
      if (this.gradePass) this.gradePass.uniforms.uTime.value = t;
      if (this.bokehPass) (this.bokehPass.uniforms as Record<string, { value: number }>)['focus'].value = this.camera.position.length();
    }

    const p = this.dustGeo.attributes.position.array as Float32Array;
    for (let i = 0; i < this.ND; i++) { p[i * 3 + 1] += this.dspd[i] * dt; if (p[i * 3 + 1] > 0.55) p[i * 3 + 1] = -0.55; }
    this.dustGeo.attributes.position.needsUpdate = true;
    this.dust.visible = this.bookScale > 0.2;

    if (this.ribbon && this.ribbon.visible) {
      this.ribbon.rotation.y = RIB_YAW + Math.sin(t * 0.7) * 0.03 + this.shake * Math.sin(t * 40) * 0.08;
    }
    this.motesStep(wdt);

    const sx0 = this.shake * Math.sin(t * 57) * 0.012, sy0 = this.shake * Math.sin(t * 43 + 1) * 0.008;
    const cam = this.camera;
    if (opts.diving) {
      const k = Math.min(opts.diveT / DIVE_DUR, 1), e2 = k * k * k * (k * (6 * k - 15) + 10);
      const r = CAM_R * (1 - e2) + 0.155 * e2, th = this.camTheta, ph = this.camPhi * (1 - e2) + 0.12 * e2;
      cam.position.set(r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph), r * Math.sin(ph) * Math.cos(th));
      cam.lookAt(0, 0.01, 0);
      // 本の中へ潜るほど視野が広がる（覗き込む歪み）
      const fov = 38 + 20 * (k * k);
      if (Math.abs(cam.fov - fov) > 0.05) { cam.fov = fov; cam.updateProjectionMatrix(); }
    } else if (opts.camOverride) {
      const { r, ph } = opts.camOverride, th = this.camTheta;
      cam.position.set(r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph), r * Math.sin(ph) * Math.cos(th));
      cam.lookAt(0, 0.01, 0);
    } else {
      const hx = QUALITY ? Math.sin(t * 0.37) * 0.004 + Math.sin(t * 0.91 + 1.0) * 0.002 : 0;
      const hy = QUALITY ? Math.sin(t * 0.53 + 1.0) * 0.003 : 0;
      cam.position.set(
        CAM_R * Math.sin(this.camPhi) * Math.sin(this.camTheta) + sx0,
        CAM_R * Math.cos(this.camPhi) + sy0,
        CAM_R * Math.sin(this.camPhi) * Math.cos(this.camTheta),
      );
      cam.lookAt(this.tiltCur.x * 0.02 + hx, this.tiltCur.y * 0.015 + hy, 0);
    }

    if (this.bookScale > 0.002) {
      if (this.composer) this.composer.render(); else this.renderer.render(this.scene, cam);
    }
    if (this.capture) {
      const cb = this.capture; this.capture = null;
      let url = '';
      try { url = this.renderer.domElement.toDataURL('image/jpeg', 0.62); } catch { /* noop */ }
      cb(url);
    }
  }

  /** 開く演出が終わったら描画設定を平常へ戻す */
  resetOpenFX(): void {
    if (this.camera.fov !== 38) { this.camera.fov = 38; this.camera.updateProjectionMatrix(); }
    this.openFlare = 0; this.gild = 0;
    this.flareA.intensity = 0; this.flareB.intensity = 0;
    if (this.bloomPass) this.bloomPass.strength = MOBILE ? 0.32 : 0.42;
    this.renderer.toneMappingExposure = 0.72;
    if (this.gradePass) this.gradePass.uniforms.uVig.value = QP.get('q_vig') ? +QP.get('q_vig')! : 0.30;
    if (this.titleSweep) this.titleSweep.visible = false;
    if (this.titleDecal) (this.titleDecal.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
  }

  static readonly CAM_R = CAM_R;
  static readonly DIVE_DUR = DIVE_DUR;
  static readonly QUALITY = QUALITY;
}
