// ============================================================================
//  服务设施渲染：发电厂 / 水塔 / 警察局 / 消防站 / 诊所 / 学校 / 公园
//  每个类型有**专属外形 + 专属配色 + 头顶指示灯**，保证一眼就能认出来。
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MAP, HALF, hash2 } from '../constants.js';

function paint(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
function box(w, h, d, x, y, z, hex) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return paint(g, hex);
}
function cyl(rt, rb, h, seg, x, y, z, hex) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  g.translate(x, y, z);
  return paint(g, hex);
}
function cone(r, h, seg, x, y, z, hex) {
  const g = new THREE.ConeGeometry(r, h, seg);
  g.translate(x, y, z);
  return paint(g, hex);
}

/** 每种设施的外形（顶点色已烘焙好） */
const GEO = {
  // 1 警察局：蓝白楼 + 顶部警灯塔
  1: () => mergeGeometries([
    box(9, 5.2, 8, 0, 2.6, 0, 0xdfe6f2),
    box(9.2, 1.1, 8.2, 0, 5.0, 0, 0x2f6fd0),
    box(4.4, 2.2, 4.4, 0, 6.4, 0, 0xeef2f8),
    box(1.6, 1.0, 1.6, 0, 8.0, 0, 0x2f6fd0),
  ]),
  // 2 消防站：红砖楼 + 车库门 + 警灯塔
  2: () => mergeGeometries([
    box(9.5, 5.0, 8, 0, 2.5, 0, 0xc0392b),
    box(9.8, 0.9, 8.3, 0, 4.6, 0, 0x8e2b20),
    box(4.2, 3.0, 0.4, 0, 1.5, 4.1, 0x2b2f36),
    box(4.0, 1.2, 4.0, 0, 6.0, 0, 0xd9544d),
    cyl(0.3, 0.3, 2.4, 6, 0, 7.6, 0, 0xdddddd),
  ]),
  // 3 诊所：白色楼 + 红十字
  3: () => mergeGeometries([
    box(8.5, 5.4, 7.5, 0, 2.7, 0, 0xf4f6f8),
    box(8.8, 0.8, 7.8, 0, 4.8, 0, 0xd9544d),
    box(2.6, 0.5, 0.5, 0, 6.6, 3.6, 0xd9544d),
    box(0.5, 0.5, 2.6, 0, 6.6, 3.6, 0xd9544d),
  ]),
  // 4 学校：黄色楼 + 钟楼 + 旗杆
  4: () => mergeGeometries([
    box(10, 4.6, 8, 0, 2.3, 0, 0xe8c55a),
    box(10.3, 0.8, 8.3, 0, 4.4, 0, 0xb8912f),
    box(3.0, 4.0, 3.0, 3.2, 6.0, 0, 0xf0d67a),
    cyl(0.12, 0.12, 4.0, 6, -4.0, 6.0, 0, 0xcccccc),
    box(1.6, 1.0, 0.12, -3.2, 7.4, 0, 0xd9544d),
  ]),
  // 5 公园：绿地 + 树 + 长椅
  5: () => mergeGeometries([
    box(10, 0.5, 9, 0, 0.25, 0, 0x5aa845),
    cyl(0.3, 0.36, 1.6, 6, -2.6, 0.8, 1.4, 0x6b4a2f),
    cone(1.8, 3.0, 7, -2.6, 2.6, 1.4, 0x3f8a3a),
    cyl(0.3, 0.36, 1.6, 6, 2.4, 0.8, -1.2, 0x6b4a2f),
    cone(1.8, 3.0, 7, 2.4, 2.6, -1.2, 0x3f8a3a),
    box(2.4, 0.3, 0.6, 0, 0.6, 2.6, 0x8a5a2b),
  ]),
  // 6 发电厂：厂房 + 冷却塔 + 烟囱
  6: () => mergeGeometries([
    box(11, 5.0, 9, 0, 2.5, 0, 0xb9b2a4),
    box(11.3, 0.7, 9.3, 0, 4.6, 0, 0x8d8579),
    cyl(2.0, 2.6, 8.0, 10, -3.2, 4.0, 1.0, 0xd9d3c6),
    cyl(1.1, 1.3, 6.5, 8, 3.4, 3.2, -2.0, 0xd98b2b),
    cyl(0.5, 0.5, 1.2, 8, 3.4, 6.6, -2.0, 0x555555),
  ]),
  // 7 水塔：支架 + 水箱
  7: () => mergeGeometries([
    cyl(0.28, 0.28, 6.0, 6, -1.8, 3.0, -1.8, 0x9aa3ab),
    cyl(0.28, 0.28, 6.0, 6, 1.8, 3.0, -1.8, 0x9aa3ab),
    cyl(0.28, 0.28, 6.0, 6, -1.8, 3.0, 1.8, 0x9aa3ab),
    cyl(0.28, 0.28, 6.0, 6, 1.8, 3.0, 1.8, 0x9aa3ab),
    cyl(2.6, 2.6, 3.4, 12, 0, 7.6, 0, 0x3aa8d0),
    cyl(2.7, 2.7, 0.4, 12, 0, 9.4, 0, 0x2b8fb4),
  ]),
};

// 指示灯颜色（和设施色一致）
const BEACON = {
  1: 0x2f6fd0, 2: 0xd9544d, 3: 0xe8e8e8, 4: 0xe8c55a, 5: 0x3fa14b, 6: 0xd98b2b, 7: 0x3aa8d0,
};

export class ServiceRenderer {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.meshes = {};
    for (const id of Object.keys(GEO)) {
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.08 });
      const m = new THREE.InstancedMesh(GEO[id](), mat, 120);
      m.castShadow = true;
      m.receiveShadow = true;
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
      this.meshes[id] = m;
    }
    // 头顶指示灯（漂浮的小八面体，一眼就能看出这是特种设施）
    const bg = new THREE.OctahedronGeometry(1.15, 0);
    bg.scale(1, 1.5, 1);
    this.beacon = new THREE.InstancedMesh(bg, new THREE.MeshBasicMaterial({
      vertexColors: false, toneMapped: false,
    }), 140);
    this.beacon.count = 0;
    this.beacon.frustumCulled = false;
    this.beacon.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.beacon);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._c = new THREE.Color();
    this.positions = [];      // {x,y,z,id} 供指示灯逐帧动画
    this.t = 0;
  }

  rebuild(state) {
    const m = this._m, q = this._q, p = this._p, s = this._s;
    const counts = {};
    this.positions.length = 0;
    for (const id of Object.keys(this.meshes)) counts[id] = 0;
    for (let i = 0; i < state.service.length; i++) {
      const sid = state.service[i];
      if (!sid) continue;
      const mesh = this.meshes[sid];
      if (!mesh) continue;
      const x = i % MAP.SIZE, z = Math.floor(i / MAP.SIZE);
      const wx = (x + 0.5) * MAP.TILE - HALF;
      const wz = (z + 0.5) * MAP.TILE - HALF;
      const rot = Math.floor(hash2(x, z, 31) * 4) * Math.PI / 2;
      q.setFromAxisAngle(this._up, rot);
      p.set(wx, 0, wz);
      s.set(1, 1, 1);
      m.compose(p, q, s);
      const n = counts[sid];
      if (n < mesh.instanceMatrix.count) {
        mesh.setMatrixAt(n, m);
        mesh.setColorAt(n, this._c.setHex(0xffffff));
        counts[sid] = n + 1;
      }
      this.positions.push({ x: wx, z: wz, id: sid, h: 11.5 });
    }
    for (const id of Object.keys(this.meshes)) {
      const mesh = this.meshes[id];
      mesh.count = counts[id];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.updateBeacons(0);
  }

  /** 指示灯逐帧：上下浮动 + 呼吸发光 */
  updateBeacons(dt) {
    this.t += dt;
    const m = this._m, q = this._q, p = this._p, s = this._s;
    let n = 0;
    for (const it of this.positions) {
      if (n >= this.beacon.instanceMatrix.count) break;
      const bob = Math.sin(this.t * 2.2 + it.x * 0.1) * 0.5;
      p.set(it.x, it.h + bob, it.z);
      s.set(1, 1, 1);
      m.compose(p, q, s);
      this.beacon.setMatrixAt(n, m);
      const pulse = 0.55 + 0.45 * Math.sin(this.t * 4 + it.z * 0.05);
      this.beacon.setColorAt(n, this._c.setHex(BEACON[it.id] || 0xffffff).multiplyScalar(0.6 + pulse * 1.4));
      n++;
    }
    this.beacon.count = n;
    this.beacon.instanceMatrix.needsUpdate = true;
    if (this.beacon.instanceColor) this.beacon.instanceColor.needsUpdate = true;
  }
}
