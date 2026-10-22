// ============================================================================
//  场景道具：树木、地面草块
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MAP, HALF, hash2 } from '../constants.js';

function treeGeo() {
  const trunk = new THREE.CylinderGeometry(0.34, 0.5, 4.2, 6);
  trunk.translate(0, 2.1, 0);
  const leaf1 = new THREE.ConeGeometry(3.0, 6.0, 7);
  leaf1.translate(0, 7.0, 0);
  const leaf2 = new THREE.ConeGeometry(2.1, 4.4, 7);
  leaf2.translate(0, 10.2, 0);
  const g = mergeGeometries([trunk, leaf1, leaf2]);
  g.computeVertexNormals();
  return g;
}

function gateGeo() {
  // 立柱
  const post = new THREE.BoxGeometry(0.34, 4.4, 0.34);
  post.translate(0, 2.2, 0);
  // 指示牌
  const board = new THREE.BoxGeometry(4.6, 2.2, 0.26);
  board.translate(0, 5.1, 0);
  const g = mergeGeometries([post, board]);
  g.computeVertexNormals();
  return g;
}

export class PropRenderer {
  constructor(scene) {
    const geo = treeGeo();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, vertexColors: false });
    this.trees = new THREE.InstancedMesh(geo, mat, 1400);
    this.trees.castShadow = true;
    this.trees.receiveShadow = false;
    this.trees.count = 0;
    this.trees.frustumCulled = false;
    this.trees.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.trees);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._c = new THREE.Color();

    // 高速出入口（对外连接）标志
    this.gates = new THREE.InstancedMesh(gateGeo(),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.1 }),
      40);
    this.gates.castShadow = true;
    this.gates.count = 0;
    this.gates.frustumCulled = false;
    this.gates.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.gates);
  }

  /** 绘制高速出入口标志（state.entrances = 地块下标数组） */
  rebuildGates(state) {
    const m = this._m, q = this._q, p = this._p, s = this._s, c = this._c;
    let n = 0;
    const list = state.entrances || [];
    for (const i of list) {
      if (n >= this.gates.instanceMatrix.count) break;
      const x = i % MAP.SIZE, z = Math.floor(i / MAP.SIZE);
      const wx = (x + 0.5) * MAP.TILE - HALF;
      const wz = (z + 0.5) * MAP.TILE - HALF;
      // 牌面朝向地图外侧
      const yaw = x === 0 ? -Math.PI / 2 : x === MAP.SIZE - 1 ? Math.PI / 2
        : z === 0 ? Math.PI : 0;
      q.setFromAxisAngle(this._up, yaw);
      p.set(wx, (state.h && state.h[i]) || 0, wz);
      s.set(1, 1, 1);
      m.compose(p, q, s);
      this.gates.setMatrixAt(n, m);
      c.setHex(0x1f9e57);
      this.gates.setColorAt(n, c);
      n++;
    }
    this.gates.count = n;
    this.gates.instanceMatrix.needsUpdate = true;
    if (this.gates.instanceColor) this.gates.instanceColor.needsUpdate = true;
  }

  rebuild(state) {
    const m = this._m, q = this._q, p = this._p, s = this._s, c = this._c;
    let n = 0;
    for (let i = 0; i < state.road.length; i++) {
      if (state.road[i] || state.zone[i] || state.service[i]) continue;
      if (state.terrain && state.terrain[i]) continue;
      const x = i % MAP.SIZE, z = Math.floor(i / MAP.SIZE);
      const r = hash2(x, z, 4242);
      if (r > 0.26) continue;
      const r2 = hash2(x, z, 991);
      if (r2 < 0.42) continue;              // 一部分空地留作开发
      const wx = (x + 0.5) * MAP.TILE - HALF + (hash2(x, z, 7) - 0.5) * 9;
      const wz = (z + 0.5) * MAP.TILE - HALF + (hash2(x, z, 9) - 0.5) * 9;
      const sc = 0.75 + hash2(x, z, 11) * 0.75;
      q.setFromAxisAngle(this._up, hash2(x, z, 13) * Math.PI * 2);
      p.set(wx, 0, wz);
      s.set(sc, sc * (0.85 + hash2(x, z, 17) * 0.4), sc);
      m.compose(p, q, s);
      this.trees.setMatrixAt(n, m);
      c.setHSL(0.26 + hash2(x, z, 19) * 0.06, 0.34 + hash2(x, z, 23) * 0.2, 0.22 + hash2(x, z, 29) * 0.16);
      this.trees.setColorAt(n, c);
      n++;
      if (n >= this.trees.instanceMatrix.count) break;
    }
    this.trees.count = n;
    this.trees.instanceMatrix.needsUpdate = true;
    if (this.trees.instanceColor) this.trees.instanceColor.needsUpdate = true;
  }
}
