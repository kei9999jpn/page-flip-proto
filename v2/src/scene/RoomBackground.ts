import * as THREE from 'three';
import { asset, QP } from '../state';

// ============================================================
// 書斎の背景。
// 現状は油彩の1枚絵（assets/app-bg.jpg）をカメラの子の平面として「舞台の奥」に置く。
// 後処理（ぼけ・にじみ・色）が部屋にも掛かるので本が浮かない。
//
// ★拡張ポイント: 3D部屋に差し替える時は、このクラスだけ入れ替える。
//   必要な口は object / layout(camera) / setBreath(k) / dispose() の4つだけ。
// ============================================================
const BG_DIST = 3.0;
const BG_IMG_ASPECT = 941 / 1672;

export class RoomBackground {
  readonly object: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private tex: THREE.Texture | null = null;
  private ready = false;
  private gain: number;
  private onReady: (() => void) | null = null;

  constructor(gain = +(QP.get('q_gain') || 3.0)) {
    this.gain = gain;
    this.mat = new THREE.MeshBasicMaterial({ depthWrite: false, toneMapped: true, color: new THREE.Color().setScalar(gain) });
    this.object = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.object.position.set(0, 0, -BG_DIST);
    this.object.renderOrder = -10;
    this.object.visible = false;
  }

  load(onReady: () => void): void {
    this.onReady = onReady;
    this.tex = new THREE.TextureLoader().load(asset('app-bg.jpg'), t => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      this.ready = true;
      if (this.onReady) this.onReady();
    });
    this.mat.map = this.tex;
  }

  /** カメラの画角に合わせて cover / 縦画面は少し引く（現行 layoutBg と同じ） */
  layout(cam: THREE.PerspectiveCamera): void {
    const h = 2 * BG_DIST * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2), w = h * cam.aspect;
    let pw = w, ph = w / BG_IMG_ASPECT;
    if (ph < h) { ph = h; pw = h * BG_IMG_ASPECT; }                       // cover
    if (cam.aspect < 0.72 && QP.get('bg') !== 'cover') {                  // 縦画面は部屋を遠く（絵の全体が入る）
      const k = Math.min(w / pw, h / ph) * 1.06;
      pw *= k; ph *= k;
    }
    this.object.scale.set(pw, ph, 1);
    this.object.position.y = (ph - h) * 0.10;
    this.object.visible = this.ready;
  }

  /** 部屋の絵も炎と一緒に息をする（k は 1.0 前後の係数） */
  setBreath(k: number): void { this.mat.color.setScalar(this.gain * k); }

  dispose(): void { this.tex?.dispose(); this.mat.dispose(); this.object.geometry.dispose(); }
}
