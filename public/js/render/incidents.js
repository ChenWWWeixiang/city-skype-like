// ============================================================================
//  事件渲染：火灾（火焰 + 浓烟）/ 犯罪 / 疾病 / 事故（占道警示）
// ============================================================================
import * as THREE from 'three';
import { MAP, HALF } from '../constants.js';

export class IncidentRenderer {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);

    // 火焰（锥体）+ 浓烟（球）
    const flame = new THREE.ConeGeometry(1.5, 4.2, 7);
    flame.translate(0, 2.1, 0);
    this.flames = new THREE.InstancedMesh(flame, new THREE.MeshBasicMaterial({
      color: 0xff7a1a, toneMapped: false, transparent: true, opacity: 0.92,
    }), 40);
    this.flames.count = 0;
    this.flames.frustumCulled = false;
    this.group.add(this.flames);

    const smoke = new THREE.SphereGeometry(1.5, 7, 6);
    this.smokes = new THREE.InstancedMesh(smoke, new THREE.MeshBasicMaterial({
      color: 0x3a3a3a, toneMapped: false, transparent: true, opacity: 0.45,
    }), 60);
    this.smokes.count = 0;
    this.smokes.frustumCulled = false;
    this.group.add(this.smokes);

    // 事件标记（菱形，犯罪=黄、疾病=绿）
    const mark = new THREE.OctahedronGeometry(1.4, 0);
    mark.scale(1, 1.6, 1);
    this.marks = new THREE.InstancedMesh(mark, new THREE.MeshBasicMaterial({
      toneMapped: false, transparent: true, opacity: 0.95,
    }), 40);
    this.marks.count = 0;
    this.marks.frustumCulled = false;
    this.group.add(this.marks);

    // 事故占道警示（横在路上的闪灯条）
    const bar = new THREE.BoxGeometry(1.0, 0.5, 13);
    this.bars = new THREE.InstancedMesh(bar, new THREE.MeshBasicMaterial({
      color: 0xff8c1a, toneMapped: false, transparent: true, opacity: 0.85,
    }), 30);
    this.bars.count = 0;
    this.bars.frustumCulled = false;
    this.group.add(this.bars);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._c = new THREE.Color();
    this.t = 0;
    this.list = [];
  }

  setEvents(events) {
    this.list = events || [];
  }

  update(dt) {
    this.t += dt;
    const m = this._m, q = this._q, p = this._p, s = this._s;
    let nf = 0, ns = 0, nm = 0, nb = 0;
    for (const e of this.list) {
      const x = e.tile % MAP.SIZE, z = Math.floor(e.tile / MAP.SIZE);
      const wx = (x + 0.5) * MAP.TILE - HALF;
      const wz = (z + 0.5) * MAP.TILE - HALF;
      const sev = e.severity || 0.3;
      if (e.type === 'fire') {
        // 火焰：随严重度变大 + 抖动
        const wob = Math.sin(this.t * 9 + e.tile) * 0.22;
        const sc = 0.7 + sev * 0.9;
        q.setFromAxisAngle(this._up, wob);
        p.set(wx, 0.5, wz);
        s.set(sc, sc * (1 + Math.sin(this.t * 11 + e.tile) * 0.12), sc);
        m.compose(p, q, s);
        if (nf < this.flames.instanceMatrix.count) {
          this.flames.setMatrixAt(nf, m);
          this.flames.setColorAt(nf, this._c.setHex(0xff7a1a).multiplyScalar(1.1 + Math.sin(this.t * 13 + e.tile) * 0.25));
          nf++;
        }
        // 浓烟：往上飘
        for (let k = 0; k < 3; k++) {
          const rise = ((this.t * 1.6 + k * 1.1 + e.tile * 0.03) % 3.2);
          q.setFromAxisAngle(this._up, this.t * 0.6 + k);
          p.set(wx + Math.sin(this.t + k) * 0.8, 4 + rise * 2.4, wz + Math.cos(this.t * 0.8 + k) * 0.8);
          s.setScalar(0.5 + rise * 0.32);
          m.compose(p, q, s);
          if (ns < this.smokes.instanceMatrix.count) {
            this.smokes.setMatrixAt(ns, m);
            this.smokes.setColorAt(ns, this._c.setHex(0x404040).multiplyScalar(1 - rise * 0.12));
            ns++;
          }
        }
      } else if (e.type === 'accident') {
        // 占道警示条：闪
        const blink = (Math.sin(this.t * 8) > 0) ? 1 : 0.25;
        q.setFromAxisAngle(this._up, 0);
        p.set(wx, 0.8, wz);
        s.set(1, 1, 1);
        m.compose(p, q, s);
        if (nb < this.bars.instanceMatrix.count) {
          this.bars.setMatrixAt(nb, m);
          this.bars.setColorAt(nb, this._c.setHex(0xff8c1a).multiplyScalar(blink * 1.6));
          nb++;
        }
      } else {
        // 犯罪 / 疾病：头顶菱形标记
        const bob = Math.sin(this.t * 3 + e.tile) * 0.5;
        q.setFromAxisAngle(this._up, this.t * 1.6);
        p.set(wx, 9 + bob, wz);
        const sc = 0.8 + sev * 0.5;
        s.set(sc, sc, sc);
        m.compose(p, q, s);
        if (nm < this.marks.instanceMatrix.count) {
          this.marks.setMatrixAt(nm, m);
          this.marks.setColorAt(nm, this._c.setHex(e.color || 0xffd23f).multiplyScalar(1.2));
          nm++;
        }
      }
    }
    this.flames.count = nf;
    this.flames.instanceMatrix.needsUpdate = true;
    if (this.flames.instanceColor) this.flames.instanceColor.needsUpdate = true;
    this.smokes.count = ns;
    this.smokes.instanceMatrix.needsUpdate = true;
    if (this.smokes.instanceColor) this.smokes.instanceColor.needsUpdate = true;
    this.marks.count = nm;
    this.marks.instanceMatrix.needsUpdate = true;
    if (this.marks.instanceColor) this.marks.instanceColor.needsUpdate = true;
    this.bars.count = nb;
    this.bars.instanceMatrix.needsUpdate = true;
    if (this.bars.instanceColor) this.bars.instanceColor.needsUpdate = true;
  }
}
