// ============================================================================
//  建筑渲染：按等级分组的实例化网格，程序化立面贴图 + 实例化颜色
// ============================================================================
import * as THREE from 'three';
import { MAP, HALF, hash2 } from '../constants.js';
import { groundHeightAt } from './world.js';

const SPECS = {
  1: [
    { w: 11, d: 11, h: 4.6, c: [0xc9b598, 0xbda78c, 0xd6c3a4, 0xb59a7f] },
    { w: 13, d: 13, h: 13, c: [0xd8c6ab, 0xcdb89c, 0xe0d0b8] },
    { w: 14, d: 14, h: 30, c: [0xdcd0bb, 0xc9bda8, 0xe6dccb] },
  ],
  2: [
    { w: 12, d: 10, h: 5, c: [0x93aec4, 0x86a2b8, 0x9db6cb] },
    { w: 14, d: 13, h: 15, c: [0x8fa9bf, 0x7f9bb2, 0x9db5c8] },
    { w: 14, d: 14, h: 34, c: [0x7d9cb6, 0x6e8ea9, 0x8fb0c8] },
  ],
  3: [
    { w: 13, d: 11, h: 5.5, c: [0xa89a86, 0x9a8c78, 0xb5a894] },
    { w: 14, d: 14, h: 8.5, c: [0x9e9280, 0x8f8472, 0xaaa08c] },
    { w: 15, d: 15, h: 12, c: [0x8e8574, 0x7f7768, 0x9c9382] },
  ],
};

function facadeTexture(zone) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  const win = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  if (zone === 1) {
    // 住宅：暖色墙面 + 零散窗户
    g.fillStyle = 'rgba(0,0,0,.06)';
    g.fillRect(0, 0, 64, 64);
    for (let y = 8; y < 60; y += 16) {
      for (let x = 8; x < 60; x += 16) {
        win(x, y, 7, 9, 'rgba(40,52,66,.78)');
        win(x + 1, y + 1, 5, 7, 'rgba(150,190,220,.55)');
      }
    }
  } else if (zone === 2) {
    // 商业：玻璃幕墙
    for (let y = 0; y < 64; y += 8) {
      for (let x = 0; x < 64; x += 8) {
        const k = 0.35 + 0.4 * hash2(x, y, 3);
        win(x, y, 7, 7, 'rgba(' + Math.floor(60 + k * 90) + ',' + Math.floor(90 + k * 100) + ',' + Math.floor(120 + k * 110) + ',.85)');
      }
    }
  } else {
    // 工业：横向条带
    g.fillStyle = 'rgba(0,0,0,.05)';
    g.fillRect(0, 0, 64, 64);
    for (let y = 6; y < 60; y += 14) {
      win(6, y, 52, 6, 'rgba(70,84,96,.55)');
      win(6, y, 52, 2, 'rgba(255,255,255,.25)');
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function buildingMaterial(zone) {
  const mat = new THREE.MeshStandardMaterial({
    map: facadeTexture(zone), roughness: 0.82, metalness: 0.06, vertexColors: false,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
      #ifdef USE_MAP
      {
        vec3 isc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vec3 an = abs(normal);
        float su = an.x > 0.5 ? isc.z : isc.x;
        float sv = an.y > 0.5 ? isc.z : isc.y;
        vMapUv = vec2(uv.x * su / 3.4, uv.y * sv / 3.4);
      }
      #endif`
    );
  };
  return mat;
}

export class BuildingRenderer {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.meshes = {};       // zone -> level -> mesh
    this.roofs = null;
    const cap = 900;
    for (const zone of [1, 2, 3]) {
      this.meshes[zone] = [];
      for (let lv = 1; lv <= 3; lv++) {
        const geo = new THREE.BoxGeometry(1, 1, 1);
        geo.translate(0, 0.5, 0);
        const mesh = new THREE.InstancedMesh(geo, buildingMaterial(zone), cap);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(mesh);
        this.meshes[zone].push(mesh);
      }
    }
    // 一级住宅的坡屋顶
    const roofGeo = new THREE.ConeGeometry(0.78, 0.5, 4);
    roofGeo.rotateY(Math.PI / 4);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x8d4b3a, roughness: 0.85 });
    this.roofs = new THREE.InstancedMesh(roofGeo, roofMat, 700);
    this.roofs.castShadow = true;
    this.roofs.count = 0;
    this.roofs.frustumCulled = false;
    this.group.add(this.roofs);
  }

  rebuild(state) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const counts = { 1: [0, 0, 0], 2: [0, 0, 0], 3: [0, 0, 0] };
    let roofCount = 0;
    const roofColor = new THREE.Color();

    for (let i = 0; i < state.zone.length; i++) {
      const zone = state.zone[i];
      if (!zone) continue;
      const lv = state.level[i];
      if (!lv) continue;
      const x = i % MAP.SIZE, z = Math.floor(i / MAP.SIZE);
      const spec = SPECS[zone][lv - 1];
      const r = hash2(x, z, 77);
      // 不规整地块：斜向道路斜切过角上（或被三面道路围住）
      // -> 只能盖小楼/歪楼（真实的城市里转角地块就是这样不规则）
      const mk = state.mask ? state.mask[i] : 0;
      const diag = !!(mk & 0b10000010) || !!(mk & 0b00101000);
      const orth = (mk & 1 ? 1 : 0) + (mk & 4 ? 1 : 0) + (mk & 16 ? 1 : 0) + (mk & 64 ? 1 : 0);
      const odd = diag || orth >= 3;
      const shrink = diag ? 0.62 : (orth >= 3 ? 0.78 : 1);
      const rot = Math.floor(r * 4) * Math.PI / 2 + (diag ? Math.PI / 4 : 0);
      const jx = (hash2(x, z, 13) - 0.5) * 1.6;
      const jz = (hash2(x, z, 29) - 0.5) * 1.6;
      const wx = (x + 0.5) * MAP.TILE - HALF + jx;
      const wz = (z + 0.5) * MAP.TILE - HALF + jz;
      const h = spec.h * (0.85 + hash2(x, z, 91) * 0.32);
      const hScaled = h * (diag ? 0.72 : 1);
      q.setFromAxisAngle(up, rot);
      // 建筑落在地形上（地形有起伏时不会陷进地里或浮在空中）
      const gy = groundHeightAt(state, wx, wz);
      pos.set(wx, gy, wz);
      scl.set(spec.w * shrink, hScaled, spec.d * shrink);
      m.compose(pos, q, scl);
      const mesh = this.meshes[zone][lv - 1];
      const n = counts[zone][lv - 1];
      if (n < mesh.instanceMatrix.count) {
        mesh.setMatrixAt(n, m);
        const c = new THREE.Color(spec.c[Math.floor(hash2(x, z, 41) * spec.c.length)]);
        mesh.setColorAt(n, c);
      }
      counts[zone][lv - 1] = n + 1;
      if (zone === 1 && lv === 1 && roofCount < this.roofs.instanceMatrix.count) {
        const rh = 3.2 + hash2(x, z, 55) * 1.6;
        pos.set(wx, gy + hScaled, wz);
        scl.set(spec.w * 0.92 * shrink, rh * (diag ? 0.72 : 1), spec.d * 0.92 * shrink);
        m.compose(pos, q, scl);
        this.roofs.setMatrixAt(roofCount, m);
        roofColor.setHSL(0.03 + hash2(x, z, 63) * 0.06, 0.35, 0.28 + hash2(x, z, 71) * 0.14);
        this.roofs.setColorAt(roofCount, roofColor);
        roofCount++;
      }
    }

    for (const zone of [1, 2, 3]) {
      for (let lv = 0; lv < 3; lv++) {
        const mesh = this.meshes[zone][lv];
        mesh.count = counts[zone][lv];
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
    this.roofs.count = roofCount;
    this.roofs.instanceMatrix.needsUpdate = true;
    if (this.roofs.instanceColor) this.roofs.instanceColor.needsUpdate = true;
  }
}
