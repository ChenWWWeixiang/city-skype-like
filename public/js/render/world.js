// ============================================================================
//  场景：渲染器 / 光照 / 天空 / 地面 / 水面
// ============================================================================
import * as THREE from 'three';
import { MAP, WORLD, HALF, hash2 } from '../constants.js';

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance', stencil: false,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  return renderer;
}

/**
 * 画质档位：城市模拟要跑满 30fps（移动的车看起来才连贯），
 * 所以按实测帧率自动降级 —— 像素比 -> 阴影 -> 抗锯齿。
 * level: 2 = 全画质, 1 = 关阴影, 0 = 关阴影 + 降分辨率
 */
export function applyQuality(renderer, world, level) {
  const q = Math.max(0, Math.min(2, level | 0));
  const pr = q === 2 ? Math.min(devicePixelRatio, 2) : (q === 1 ? Math.min(devicePixelRatio, 1.25) : 0.75);
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight);
  const wantShadow = q >= 2;
  if (renderer.shadowMap.enabled !== wantShadow) {
    renderer.shadowMap.enabled = wantShadow;
    // 阴影开关变化后所有材质都要重新编译
    world.scene.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m.needsUpdate = true;
    });
  }
  if (world && world.sun) world.sun.castShadow = wantShadow;
  return q;
}

function grassTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#4a6b3a';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5200; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    const v = Math.random();
    g.fillStyle = v > 0.55 ? 'rgba(120,150,90,.30)' : 'rgba(40,62,32,.34)';
    g.fillRect(x, y, 1.6, 1.6);
  }
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, r = 12 + Math.random() * 40;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(110,140,80,.16)');
    grd.addColorStop(1, 'rgba(110,140,80,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(MAP.SIZE, MAP.SIZE);
  t.anisotropy = 8;
  return t;
}

function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0.0, '#2f6fb5');
  grd.addColorStop(0.45, '#7fb3e0');
  grd.addColorStop(0.72, '#cfe2f2');
  grd.addColorStop(1.0, '#e9dfc9');
  g.fillStyle = grd;
  g.fillRect(0, 0, 16, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createScene() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xbcd2e4, 700, 1900);

  // 天空穹顶
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(2400, 32, 20),
    new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false })
  );
  sky.renderOrder = -1;
  scene.add(sky);

  // 地面
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD, WORLD, MAP.SIZE, MAP.SIZE),
    new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 0.96, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.geometry.computeVertexNormals();
  scene.add(ground);

  // 水面（略高于地面）
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x2c6a92, roughness: 0.16, metalness: 0.32,
    transparent: true, opacity: 0.9,
  });
  const water = new THREE.InstancedMesh(new THREE.PlaneGeometry(MAP.TILE, MAP.TILE), waterMat, MAP.SIZE * MAP.SIZE);
  water.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  water.receiveShadow = false;
  water.count = 0;
  scene.add(water);

  // 光照
  const hemi = new THREE.HemisphereLight(0xbcd8f5, 0x4a5a3a, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.1);
  sun.position.set(-260, 420, 200);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 1400;
  sun.shadow.bias = -0.0009;
  sun.shadow.normalBias = 0.6;
  const sc = sun.shadow.camera;
  sc.left = -320; sc.right = 320; sc.top = 320; sc.bottom = -320;
  scene.add(sun);
  scene.add(sun.target);
  scene.add(new THREE.AmbientLight(0xffffff, 0.18));

  return { scene, sun, ground, water, sky };
}

/**
 * 地形网格：把地形高程（山丘 / 河谷 / 隧道堑壕）反映到地表的顶点上。
 * 隧道那一格的地表会被「挖低」到路面高度，于是山体上出现一条真实的隧道沟槽。
 */
export function rebuildTerrain(groundMesh, state) {
  const geo = groundMesh.geometry;
  const pos = geo.getAttribute('position');
  const S = MAP.SIZE;
  const h = state.height;
  // 有效地表高度：隧道格要挖到路面以下
  const eff = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) {
    let v = h ? (h[i] || 0) : 0;
    if (state.tunnel && state.tunnel[i]) {
      const rh = state.roadH ? (state.roadH[i] || 0) : v;
      if (rh < v) v = rh - 0.12;
    }
    eff[i] = v;
  }
  const tileH = (x, z) => {
    if (x < 0) x = 0; else if (x > S - 1) x = S - 1;
    if (z < 0) z = 0; else if (z > S - 1) z = S - 1;
    return eff[z * S + x];
  };
  const sample = (gx, gz) => {
    const x = gx - 0.5, z = gz - 0.5;
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const fx = x - x0, fz = z - z0;
    const a = tileH(x0, z0) * (1 - fx) + tileH(x0 + 1, z0) * fx;
    const b = tileH(x0, z0 + 1) * (1 - fx) + tileH(x0 + 1, z0 + 1) * fx;
    return a * (1 - fz) + b * fz;
  };
  for (let i = 0; i < pos.count; i++) {
    // 网格本体在 XY 平面上（靠 mesh.rotation 摆平），局部 +Y -> 世界 -Z
    const gx = (pos.getX(i) + HALF) / MAP.TILE;
    const gz = (HALF - pos.getY(i)) / MAP.TILE;
    // 局部 Z 轴 = 世界高度（网格靠 mesh.rotation.x = -90° 摆平）
    pos.setZ(i, sample(gx, gz));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
}

/** 依据地形数据重建水面实例 */
export function rebuildWater(waterMesh, state) {
  const m = new THREE.Matrix4();
  let n = 0;
  for (let i = 0; i < state.zone.length; i++) {
    // 地形信息保存在 state.terrain（由 full diff 提供）
    if (!state.terrain || !state.terrain[i]) continue;
    const x = i % MAP.SIZE, z = Math.floor(i / MAP.SIZE);
    m.makeRotationX(-Math.PI / 2);
    m.setPosition((x + 0.5) * MAP.TILE - HALF, 0.06, (z + 0.5) * MAP.TILE - HALF);
    waterMesh.setMatrixAt(n++, m);
  }
  waterMesh.count = n;
  waterMesh.instanceMatrix.needsUpdate = true;
}
