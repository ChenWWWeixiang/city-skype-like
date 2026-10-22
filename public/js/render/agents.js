// ============================================================================
//  车辆渲染：行驶车辆 / 特种车辆（警消救护灵垃） / 路边停放车辆
//  类型 id 与服务端 TRAFFIC.VEHICLE_TYPES / SPECIAL_TYPES 一致
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function sedanGeo() {
  return mergeGeometries([
    box(1.85, 0.95, 4.1, 0, 0.55, 0),
    box(1.65, 0.72, 2.1, 0, 1.32, -0.15),
  ]);
}
function truckGeo() {
  return mergeGeometries([
    box(2.25, 1.5, 1.9, 0, 1.05, 2.6),
    box(2.35, 2.1, 6.0, 0, 1.55, -1.5),
  ]);
}
function busGeo() {
  return mergeGeometries([box(2.5, 2.5, 10.5, 0, 1.6, 0)]);
}
function vanGeo() {
  return mergeGeometries([
    box(2.1, 1.9, 5.2, 0, 1.25, 0.4),
    box(1.95, 1.0, 1.6, 0, 1.55, -2.3),
  ]);
}
function bikeGeo() {
  return mergeGeometries([
    box(0.5, 0.35, 1.6, 0, 0.75, 0),
    box(0.12, 0.6, 0.12, 0, 0.45, 0),
  ]);
}

const PALETTE = [
  0xd8d8dc, 0x2f3b4a, 0x8b1f24, 0x1f4e79, 0x2f5d3a,
  0xd9b23a, 0x6b6f76, 0xa8442f, 0x3c6e8f, 0xe0e0e0,
];

// 特种车辆配色
const SPECIAL_COLORS = {
  4: 0x2b3f74,   // 警车
  5: 0xb0261f,   // 消防车
  6: 0xf2f2f2,   // 救护车
  7: 0xe6e6ea,   // 灵车
  8: 0x3f7a4a,   // 垃圾车
};
const LIGHT_COLORS = {
  4: 0x3355ff, 5: 0xff3322, 6: 0xffdd33, 7: 0xffffff, 8: 0x66ff88,
};

const MESH_OF = { 0: 'car', 4: 'car', 1: 'truck', 5: 'truck', 8: 'truck', 2: 'bus', 6: 'van', 7: 'van', 3: 'bike' };

// ---- 特种车辆专属外形（顶点色烘焙，保证一眼能认出来）----
function paint(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
function cbox(w, h, d, x, y, z, hex) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return paint(g, hex);
}
function specialGeo(kind) {
  if (kind === 'police') {
    return mergeGeometries([
      cbox(1.9, 0.9, 4.2, 0, 0.55, 0, 0xf2f4f8),
      cbox(1.7, 0.7, 2.1, 0, 1.3, -0.15, 0x1b3a6b),
      cbox(1.95, 0.34, 1.0, 0, 1.72, -0.15, 0x1b3a6b),   // 顶灯条底座
      cbox(0.6, 0.3, 0.5, 0, 1.95, -0.15, 0x3355ff),
    ]);
  }
  if (kind === 'fire') {
    return mergeGeometries([
      cbox(2.3, 1.6, 2.0, 0, 1.1, 2.4, 0xb0261f),
      cbox(2.4, 2.2, 6.0, 0, 1.6, -1.4, 0xd0342a),
      cbox(1.0, 0.35, 6.2, 0, 2.95, -1.4, 0xe8e8e8),   // 云梯
      cbox(0.25, 0.5, 6.2, -0.45, 2.95, -1.4, 0xff3322),
      cbox(0.25, 0.5, 6.2, 0.45, 2.95, -1.4, 0xff3322),
    ]);
  }
  if (kind === 'ambulance') {
    return mergeGeometries([
      cbox(2.1, 1.9, 5.2, 0, 1.25, 0.4, 0xf6f7f9),
      cbox(1.95, 1.0, 1.6, 0, 1.55, -2.3, 0xe4e8ec),
      cbox(0.45, 1.2, 0.16, 0, 1.3, 3.05, 0xd9544d),   // 红十字（横）
      cbox(1.2, 0.45, 0.16, 0, 1.3, 3.05, 0xd9544d),   // 红十字（竖）
      cbox(1.4, 0.25, 0.6, 0, 2.3, 0.6, 0xffdd33),
    ]);
  }
  if (kind === 'hearse') {
    return mergeGeometries([
      cbox(2.1, 1.9, 5.4, 0, 1.25, 0.2, 0x1b1c20),
      cbox(1.95, 1.0, 1.6, 0, 1.55, -2.5, 0x24262b),
      cbox(0.9, 0.12, 0.12, 0, 2.3, 0.6, 0xf0f0f0),     // 车顶白条
    ]);
  }
  if (kind === 'garbage') {
    return mergeGeometries([
      cbox(2.2, 1.4, 2.0, 0, 1.0, 2.6, 0x3f7a4a),
      cbox(2.4, 2.3, 5.4, 0, 1.6, -1.6, 0x4f9159),
      cbox(2.45, 0.4, 5.0, 0, 2.85, -1.6, 0x2f5d3a),
    ]);
  }
  // 校车
  return mergeGeometries([
    cbox(2.5, 2.4, 10.0, 0, 1.5, 0, 0xe8b62c),
    cbox(2.55, 0.7, 9.0, 0, 2.0, 0, 0xd8a41f),
    cbox(2.2, 0.5, 0.12, 0, 1.9, -5.05, 0x2b2f36),
  ]);
}
const SPECIAL_MESH = { 4: 'police', 5: 'fire', 6: 'ambulance', 7: 'hearse', 8: 'garbage', 9: 'schoolbus' };

/** 行驶中车辆 = 前 traffic.vehicles 辆，其余为路边停放车辆 */
export class AgentRenderer {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.28 });
    this.car = new THREE.InstancedMesh(sedanGeo(), mat, 900);
    this.truck = new THREE.InstancedMesh(truckGeo(), mat, 420);
    this.bus = new THREE.InstancedMesh(busGeo(), mat, 140);
    this.van = new THREE.InstancedMesh(vanGeo(), mat, 200);
    this.bike = new THREE.InstancedMesh(bikeGeo(), mat, 300);
    this.meshes = { car: this.car, truck: this.truck, bus: this.bus, van: this.van, bike: this.bike };
    for (const k in this.meshes) {
      const m = this.meshes[k];
      m.castShadow = true; m.count = 0; m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
    // 特种车辆：专属外形 + 专属材质（顶点色）
    this.specialMeshes = {};
    const sMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.2 });
    for (const kind of ['police', 'fire', 'ambulance', 'hearse', 'garbage', 'schoolbus']) {
      const m = new THREE.InstancedMesh(specialGeo(kind), sMat, 90);
      m.castShadow = true;
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
      this.specialMeshes[kind] = m;
    }
    // 特种车辆顶灯
    const lampGeo = new THREE.SphereGeometry(0.24, 8, 6);
    this.lamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({
      color: 0xffffff, toneMapped: false,
    }), 260);
    this.lamps.count = 0;
    this.lamps.frustumCulled = false;
    this.group.add(this.lamps);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._c = new THREE.Color();
    this._blink = 0;
  }

  /**
   * vehicles: 交错数组 [x, z, y, heading, typeId, id, speed] * N
   * id < 0 表示路边停放车辆（静止、缩小压暗）；id > 0 为行驶中的车辆
   */
  update(vehicles) {
    const m = this._m, q = this._q, p = this._p, c = this._c;
    const counts = { car: 0, truck: 0, bus: 0, van: 0, bike: 0 };
    const sCounts = { police: 0, fire: 0, ambulance: 0, hearse: 0, garbage: 0, schoolbus: 0 };
    const n = Math.floor(vehicles.length / 7);
    this._blink = (this._blink + 1) % 24;
    const blinkOn = this._blink < 12;
    let li = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 7;
      const x = vehicles[o], z = vehicles[o + 1];
      const y = vehicles[o + 2] || 0;
      const h = vehicles[o + 3], t = vehicles[o + 4] | 0;
      const id = vehicles[o + 5];
      const special = SPECIAL_MESH[t];
      const kind = special || MESH_OF[t] || 'car';
      const mesh = special ? this.specialMeshes[special] : this.meshes[kind];
      if (!mesh) continue;
      const parked = id < 0;          // 负 id = 路边停放
      q.setFromAxisAngle(this._up, h);
      p.set(x, y, z);
      const sc = parked ? 0.94 : 1;
      this._s.set(sc, sc, sc);
      m.compose(p, q, this._s);
      const cnt = special ? sCounts[special] : counts[kind];
      if (cnt < mesh.instanceMatrix.count) {
        mesh.setMatrixAt(cnt, m);
        if (special) c.setHex(0xffffff);
        else if (SPECIAL_COLORS[t] !== undefined) c.setHex(SPECIAL_COLORS[t]);
        else {
          // 颜色必须由「车辆 ID」决定（而不是数组下标），
          // 否则有车生成/消失时颜色会在车之间乱跳，看起来像"模型没动、颜色在闪"
          const key = Math.abs(id | 0);
          c.setHex(PALETTE[(key * 13 + 1) % PALETTE.length]);
          if (parked) c.multiplyScalar(0.78);        // 路边停放：压暗一档
        }
        mesh.setColorAt(cnt, c);
        if (special) sCounts[special]++; else counts[kind]++;
        // 特种车辆顶灯
        if (LIGHT_COLORS[t] !== undefined && !parked && li < this.lamps.instanceMatrix.count) {
          const lp = new THREE.Vector3(x, y + (kind === 'truck' ? 2.8 : 2.1), z);
          const lm = new THREE.Matrix4().compose(lp, q, this._s);
          this.lamps.setMatrixAt(li, lm);
          this.lamps.setColorAt(li, this._c.setHex(LIGHT_COLORS[t]).multiplyScalar(blinkOn ? 2.2 : 0.25));
          li++;
        }
      }
    }
    for (const k in this.meshes) {
      const mesh = this.meshes[k];
      mesh.count = counts[k];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    for (const k in this.specialMeshes) {
      const mesh = this.specialMeshes[k];
      mesh.count = sCounts[k];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.lamps.count = li;
    this.lamps.instanceMatrix.needsUpdate = true;
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }
}
