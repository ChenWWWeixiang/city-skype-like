// ============================================================================
//  交通信号灯渲染：路口信号杆 + 三色灯头
//  状态由服务端每帧广播（state.signals 贴图），与交通仿真的相位严格同步
// ============================================================================
import * as THREE from 'three';
import { MAP, HALF } from '../constants.js';
import { ROAD_DEFS } from './roads.js';

const RED = new THREE.Color(0xff2a18);
const YELLOW = new THREE.Color(0xffc61a);
const GREEN = new THREE.Color(0x35ff6a);
const DARK = new THREE.Color(0x141618);
const LAMP_COLORS = [RED, YELLOW, GREEN];

// 每个进口方向：bit(道路连接掩码) / 组(0=南北,1=东西) / 灯头旋转角
const APPROACHES = [
  { bit: 1, group: 0, rot: 0 },                 // 北侧来车（向南）
  { bit: 4, group: 1, rot: -Math.PI / 2 },      // 东侧来车（向西）
  { bit: 16, group: 0, rot: Math.PI },          // 南侧来车（向北）
  { bit: 64, group: 1, rot: Math.PI / 2 },      // 西侧来车（向东）
];

export class SignalRenderer {
  constructor(scene) {
    this.heads = [];

    const poleGeo = new THREE.CylinderGeometry(0.16, 0.2, 4.4, 6);
    poleGeo.translate(0, 2.2, 0);
    this.poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({
      color: 0x33383d, roughness: 0.85, metalness: 0.25,
    }), 1400);
    this.poles.count = 0;
    this.poles.frustumCulled = false;
    this.poles.castShadow = true;
    scene.add(this.poles);

    const boxGeo = new THREE.BoxGeometry(0.62, 1.72, 0.44);
    this.boxes = new THREE.InstancedMesh(boxGeo, new THREE.MeshStandardMaterial({
      color: 0x1b1e21, roughness: 0.8,
    }), 1400);
    this.boxes.count = 0;
    this.boxes.frustumCulled = false;
    scene.add(this.boxes);

    const lampGeo = new THREE.SphereGeometry(0.23, 10, 8);
    this.lamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({
      color: 0xffffff, toneMapped: false,
    }), 4200);
    this.lamps.count = 0;
    this.lamps.frustumCulled = false;
    scene.add(this.lamps);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._c = new THREE.Color();
  }

  /** 路网变化时重建灯杆位置（结构未变则跳过） */
  rebuild(state, force = false) {
    const sig0 = state.signals;
    let key = 0, cnt = 0;
    for (let i = 0; i < sig0.length; i++) {
      if (sig0[i]) { key = (key + (i + 1) * sig0[i]) % 1000000007; cnt++; }
    }
    const sigKey = cnt + ':' + key;
    if (!force && sigKey === this._sigKey) return;
    this._sigKey = sigKey;
    const T = MAP.TILE;
    const heads = [];
    const m = this._m, q = this._q, p = this._p, s = this._s;
    const sig = state.signals;
    for (let i = 0; i < sig.length; i++) {
      const v = sig[i];
      if (!v) continue;
      const elevated = (v & 16) !== 0;
      const mask = state.mask[i] | state.overMask[i];
      if (!mask) continue;
      const roadType = state.road[i] || state.over[i];
      const def = ROAD_DEFS[roadType] || ROAD_DEFS[1];
      const hw = def.width / 2;
      const x = i % MAP.SIZE, z = Math.floor(i / MAP.SIZE);
      const cx = (x + 0.5) * T - HALF;
      const cz = (z + 0.5) * T - HALF;
      const y = elevated ? (state.h[i] || 0) : 0;
      for (const ap of APPROACHES) {
        if (!(mask & ap.bit)) continue;
        // 灯杆位于路口角部、本进口方向的右侧路肩
        let px = cx, pz = cz;
        if (ap.group === 0) {
          px = cx - hw - 1.2;
          pz = cz + (ap.bit === 1 ? -1 : 1) * (T / 2 - 2.0);
        } else {
          pz = cz - hw - 1.2;
          px = cx + (ap.bit === 4 ? 1 : -1) * (T / 2 - 2.0);
        }
        q.setFromAxisAngle(this._up, ap.rot);
        p.set(px, y, pz);
        m.compose(p, q, s);
        const poleM = m.clone();
        p.set(px, y + 4.35, pz);
        m.compose(p, q, s);
        heads.push({ pole: poleM, box: m.clone(), group: ap.group, x: px, y, z: pz, rot: ap.rot, tile: i });
      }
    }
    this.heads = heads;
    const max = Math.min(heads.length, this.poles.instanceMatrix.count);
    for (let k = 0; k < max; k++) {
      this.poles.setMatrixAt(k, heads[k].pole);
      this.boxes.setMatrixAt(k, heads[k].box);
    }
    this.poles.count = max;
    this.boxes.count = max;
    this.poles.instanceMatrix.needsUpdate = true;
    this.boxes.instanceMatrix.needsUpdate = true;

    // 灯珠：红 / 黄 /绿 自上而下
    const q2 = new THREE.Quaternion();
    const p2 = new THREE.Vector3();
    const s2 = new THREE.Vector3(1, 1, 1);
    const m2 = new THREE.Matrix4();
    let li = 0;
    const maxLamps = this.lamps.instanceMatrix.count;
    for (let k = 0; k < heads.length && li + 3 <= maxLamps; k++) {
      const h = heads[k];
      q2.setFromAxisAngle(this._up, h.rot);
      for (let j = 0; j < 3; j++) {
        const dz = -0.26;   // 灯面朝向来车（局部 -Z）
        p2.set(h.x - Math.sin(h.rot) * dz, h.y + 5.02 - j * 0.5, h.z - Math.cos(h.rot) * dz);
        m2.compose(p2, q2, s2);
        this.lamps.setMatrixAt(li, m2);
        this.lamps.setColorAt(li, DARK);
        li++;
      }
    }
    this.lamps.count = li;
    this.lamps.instanceMatrix.needsUpdate = true;
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }

  /** 刷新灯色（与仿真相位一致） */
  update(state) {
    const sig = state.signals;
    const c = this._c;
    let li = 0;
    for (let k = 0; k < this.heads.length; k++) {
      const h = this.heads[k];
      const v = sig[h.tile] || 0;
      const st = (v >> 1) & 3;
      const phase = (v >> 3) & 1;
      let on = 0;
      if (st === 2) on = 0;                       // 全红
      else if (h.group === phase) on = st === 1 ? 1 : 2;
      else on = 0;
      for (let j = 0; j < 3; j++) {
        c.copy(DARK);
        if (j === on) c.copy(LAMP_COLORS[j]).multiplyScalar(1.7);
        this.lamps.setColorAt(li++, c);
      }
    }
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }
}
