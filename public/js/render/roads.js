// ============================================================================
//  道路渲染
//  - 8 方向连接（支持斜向/曲线），路口圆角
//  - 高程（高架桥 + 坡道 + 桥墩）
//  - 车道类型着色
//  - 拥堵用顶点色实时着色
// ============================================================================
import * as THREE from 'three';
import { MAP, HALF } from '../constants.js';

export const ROAD_DEFS = {
  1: { width: 8, lanes: 2, color: 0x3a4046, name: '街道' },
  2: { width: 11, lanes: 4, color: 0x454b52, name: '大道' },
  3: { width: 16, lanes: 4, color: 0x52585f, name: '高速公路' },
};

export const LANE_COLORS = [0xffffff, 0x3fa9e8, 0x54c46a, 0xf0c04a];

const D8 = [
  { dx: 0, dz: -1, bit: 1 }, { dx: 1, dz: -1, bit: 2 },
  { dx: 1, dz: 0, bit: 4 }, { dx: 1, dz: 1, bit: 8 },
  { dx: 0, dz: 1, bit: 16 }, { dx: -1, dz: 1, bit: 32 },
  { dx: -1, dz: 0, bit: 64 }, { dx: -1, dz: -1, bit: 128 },
];

function asphaltTexture(lanes, base) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  const col = new THREE.Color(base);
  g.fillStyle = '#' + col.getHexString();
  g.fillRect(0, 0, 64, 128);
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * 64, y = Math.random() * 128;
    g.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,.045)' : 'rgba(0,0,0,.07)';
    g.fillRect(x, y, 1.5, 1.5);
  }
  g.fillStyle = 'rgba(226,226,214,.70)';
  g.fillRect(2, 0, 2, 128);
  g.fillRect(60, 0, 2, 128);
  g.fillStyle = 'rgba(238,200,110,.85)';
  if (lanes <= 2) {
    for (let y = 0; y < 128; y += 32) g.fillRect(31, y, 2, 18);
  } else {
    for (let y = 0; y < 128; y += 32) { g.fillRect(15, y, 2, 18); g.fillRect(47, y, 2, 18); }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function plainTexture(base) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const col = new THREE.Color(base);
  g.fillStyle = '#' + col.getHexString();
  g.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 400; i++) {
    const x = Math.random() * 64, y = Math.random() * 64;
    g.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.06)';
    g.fillRect(x, y, 1.5, 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class RoadRenderer {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.meshes = {};
    this.tileRanges = { 1: [], 2: [], 3: [] };
    this.tilesOf = { 1: [], 2: [], 3: [] };
    for (const key of [1, 2, 3]) {
      const def = ROAD_DEFS[key];
      const matMarked = new THREE.MeshStandardMaterial({
        map: asphaltTexture(def.lanes, def.color), vertexColors: true,
        roughness: 0.93, metalness: 0.02,
      });
      const matPlain = new THREE.MeshStandardMaterial({
        map: plainTexture(def.color), vertexColors: true, roughness: 0.95, metalness: 0.02,
      });
      const matDiag = new THREE.MeshStandardMaterial({
        map: plainTexture(def.color), vertexColors: true, roughness: 0.95, metalness: 0.02,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      // 路基（路缘）：把路面和地形的接缝盖住，看起来像有路肩
      const matCurb = new THREE.MeshStandardMaterial({
        color: 0x6b6f74, vertexColors: true, roughness: 0.98, metalness: 0,
      });
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), [matPlain, matMarked, matDiag, matCurb]);
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.meshes[key] = mesh;
    }

    // 车道类型色带
    const bandGeo = new THREE.PlaneGeometry(1, 1);
    bandGeo.rotateX(-Math.PI / 2);
    this.laneBands = new THREE.InstancedMesh(bandGeo, new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.42, depthWrite: false,
    }), 1200);
    this.laneBands.count = 0;
    this.laneBands.frustumCulled = false;
    this.laneBands.renderOrder = 2;
    scene.add(this.laneBands);

    // 高架桥墩
    const pillarGeo = new THREE.CylinderGeometry(1.5, 1.8, 1, 8);
    pillarGeo.translate(0, 0.5, 0);
    this.pillars = new THREE.InstancedMesh(pillarGeo, new THREE.MeshStandardMaterial({
      color: 0x9aa0a8, roughness: 0.9,
    }), 900);
    this.pillars.count = 0;
    this.pillars.castShadow = true;
    this.pillars.frustumCulled = false;
    scene.add(this.pillars);
  }

  rebuild(state) {
    const T = MAP.TILE, H = T / 2;
    const pillarM = new THREE.Matrix4();
    let pillarCount = 0;

    for (const key of [1, 2, 3]) {
      const def = ROAD_DEFS[key];
      const hw = def.width / 2;
      const pos = [], uv = [], col = [], nor = [];
      const idxCenter = [], idxStrip = [], idxDiag = [];
      const idxCurb = [];
      const ranges = [], tiles = [];
      let vbase = 0;

      // pts: [x, z, u, v, y]  逐角高度 -> 坡道平滑过渡
      const pushQuad = (pts, list) => {
        const n = vbase;
        for (const p of pts) {
          pos.push(p[0], p[4] !== undefined ? p[4] : 0, p[1]);
          nor.push(0, 1, 0);
          uv.push(p[2], p[3]);
          col.push(1, 1, 1);
        }
        list.push(n, n + 2, n + 1, n, n + 3, n + 2);
        vbase += 4;
      };

      // 路缘竖面（只在没有连接的方向上补）
      const pushCurb = (x0, z0, x1, z1, yTop) => {
        const yBot = yTop - 0.55;
        const n = vbase;
        pos.push(x0, yTop, z0, x1, yTop, z1, x1, yBot, z1, x0, yBot, z0);
        for (let k = 0; k < 4; k++) { nor.push(0, 1, 0); col.push(1, 1, 1); uv.push(0, 0); }
        idxCurb.push(n, n + 2, n + 1, n, n + 3, n + 2);
        vbase += 4;
      };

      // y0/y1: 沿道路方向两端的实际高程（用于坡道平滑）
      // 路面贴图：u = 横向（垂直于道路），v = 沿路方向。
      // 之前东西向道路把 u/v 弄反了 —— 车道线贴图被转了 90°，
      // 结果「中心虚线」横跨马路、边线顺着马路跑。
      const rect = (x0, x1, z0, z1, along, list, y0, y1) => {
        const a0 = ((along === 'z' ? z0 : x0) + H) / T;   // 沿路方向起点
        const a1 = ((along === 'z' ? z1 : x1) + H) / T;   // 沿路方向终点
        if (along === 'z') {
          // 南北向道路：u 沿 X，v 沿 Z
          pushQuad([
            [x0, z0, 0, a0, y0], [x1, z0, 1, a0, y0],
            [x1, z1, 1, a1, y1], [x0, z1, 0, a1, y1],
          ], list);
        } else {
          // 东西向道路：u 沿 Z，v 沿 X
          pushQuad([
            [x0, z0, 0, a0, y0], [x1, z0, 0, a1, y0],
            [x1, z1, 1, a1, y1], [x0, z1, 1, a0, y1],
          ], list);
        }
      };

      // 地面层 + 高架层分别生成几何（高架层带高度）
      const instances = [];
      for (let i = 0; i < state.road.length; i++) {
        // 地面层：路面高度 = 地形高程（桥面 / 隧道也在这里）
        if (state.road[i] === key) {
          instances.push({ i, mask: state.mask[i], h: (state.roadH && state.roadH[i]) || 0, layer: 0 });
        }
        if (state.over && state.over[i] === key) {
          instances.push({ i, mask: state.overMask[i], h: state.h[i] || 0, layer: 1 });
        }
      }
      for (const inst of instances) {
        const i = inst.i;
        const x = i % MAP.SIZE, z = Math.floor(i / MAP.SIZE);
        const wx = (x + 0.5) * T - HALF;
        const wz = (z + 0.5) * T - HALF;
        const m = inst.mask;
        const y = inst.h + 0.04;
        const start = vbase;
        // 邻接格高度（用于坡面插值）
        const nH = (dx, dz) => {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= MAP.SIZE || nz >= MAP.SIZE) return inst.h;
          const j = nz * MAP.SIZE + nx;
          const nh = inst.layer === 1 ? (state.h[j] || 0) : ((state.roadH && state.roadH[j]) || 0);
          return nh + 0.04;
        };
        const hN = nH(0, -1), hS = nH(0, 1), hE = nH(1, 0), hW = nH(-1, 0);

        rect(wx - hw, wx + hw, wz - hw, wz + hw, 'x', idxCenter, y, y);
        // 地面层补路缘（高架层悬空，不需要）
        if (inst.layer === 0) {
          if (!(m & 1)) pushCurb(wx - hw, wz - hw, wx + hw, wz - hw, y - 0.04);
          if (!(m & 16)) pushCurb(wx - hw, wz + hw, wx + hw, wz + hw, y - 0.04);
          if (!(m & 64)) pushCurb(wx - hw, wz - hw, wx - hw, wz + hw, y - 0.04);
          if (!(m & 4)) pushCurb(wx + hw, wz - hw, wx + hw, wz + hw, y - 0.04);
        }
        for (const d of D8) {
          if (!(m & d.bit)) continue;
          if (d.dx === 0 || d.dz === 0) {
            // 正交臂
            if (d.dx === 0) {
              const z0 = d.dz < 0 ? wz - H : wz + hw;
              const z1 = d.dz < 0 ? wz - hw : wz + H;
              const hOut = d.dz < 0 ? hN : hS;
              rect(wx - hw, wx + hw, z0, z1, 'z', idxStrip, hOut, y);
            } else {
              const x0 = d.dx < 0 ? wx - H : wx + hw;
              const x1 = d.dx < 0 ? wx - hw : wx + H;
              const hOut = d.dx < 0 ? hW : hE;
              rect(x0, x1, wz - hw, wz + hw, 'x', idxStrip, hOut, y);
            }
          } else {
            // 对角臂：从地块中心斜向延伸到对角，宽度垂直于斜向
            const len = Math.SQRT1_2;
            const px = (d.dz) / len * hw, pz = -(d.dx) / len * hw;
            const kx = wx + d.dx * H, kz = wz + d.dz * H;
            const hOut = d.dx === 0 ? (d.dz < 0 ? hN : hS) : (d.dx > 0 ? hE : hW);
            pushQuad([
              [wx - px, wz - pz, 0, 0, y], [kx - px, kz - pz, 0, 1, hOut],
              [kx + px, kz + pz, 1, 1, hOut], [wx + px, wz + pz, 1, 0, y],
            ], idxDiag);
          }
        }
        ranges.push([start, vbase]);
        tiles.push(i);

        // 桥墩：地面层的「桥」要架在河床上；高架层要架在地面上
        if (pillarCount < this.pillars.instanceMatrix.count) {
          const ground = (state.height && state.height[i]) || 0;
          const span = inst.h - ground;
          if (span > 2.2) {
            pillarM.makeScale(1, span, 1);
            pillarM.setPosition(wx, ground, wz);
            this.pillars.setMatrixAt(pillarCount, pillarM);
            pillarCount++;
          }
        }
      }

      const geo = this.meshes[key].geometry;
      geo.dispose();
      const ng = new THREE.BufferGeometry();
      ng.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      ng.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      ng.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      ng.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      ng.setIndex(idxCenter.concat(idxStrip, idxDiag, idxCurb));
      ng.addGroup(0, idxCenter.length, 0);
      ng.addGroup(idxCenter.length, idxStrip.length, 1);
      ng.addGroup(idxCenter.length + idxStrip.length, idxDiag.length, 2);
      ng.addGroup(idxCenter.length + idxStrip.length + idxDiag.length, idxCurb.length, 3);
      this.meshes[key].geometry = ng;
      this.tileRanges[key] = ranges;
      this.tilesOf[key] = tiles;
    }

    this.pillars.count = pillarCount;
    this.pillars.instanceMatrix.needsUpdate = true;
    this._rebuildLaneBands(state);
  }

  /** 车道类型色带：特殊车道（公交/自行车/转弯）着色 */
  _rebuildLaneBands(state) {
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const T = MAP.TILE;
    let n = 0;
    const addTile = (i, layer) => {
      const lt = layer === 1 ? state.olt[i] : state.lt[i];
      if (!lt) return;
      const roadType = layer === 1 ? state.over[i] : state.road[i];
      if (!roadType) return;
      const x = i % MAP.SIZE, z = Math.floor(i / MAP.SIZE);
      const wx = (x + 0.5) * T - HALF;
      const wz = (z + 0.5) * T - HALF;
      const def = ROAD_DEFS[roadType];
      const m8 = layer === 1 ? state.overMask[i] : state.mask[i];
      const yBase = (layer === 1 ? (state.h[i] || 0) : ((state.roadH && state.roadH[i]) || 0)) + 0.07;
      // 道路可能有多个方向（十字路口既有东西向又有南北向）
      // 车道色带必须按「每个存在的方向」各画一遍，否则路口的色带会画错方向。
      const alongX = (m8 & 4) || (m8 & 64);
      const alongZ = (m8 & 1) || (m8 & 16);
      const laneW = def.width / def.lanes;
      for (const isX of [true, false]) {
        if (isX ? !alongX : !alongZ) continue;
        for (let l = 0; l < def.lanes; l++) {
          const type = (lt >> (l * 2)) & 3;
          if (type === 0) continue;
          const off = (l - (def.lanes - 1) / 2) * laneW;
          p.set(wx + (isX ? 0 : off), yBase, wz + (isX ? off : 0));
          // 色带的长轴必须与道路同向：
          // 统一用「长轴沿局部 X」的盒子，X 向道路不旋转，Z 向道路整体转 90°。
          // （之前 Z 向道路的缩放也交换了，结果色带变成横跨马路的短横杠）
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), isX ? 0 : Math.PI / 2);
          s.set(T * 0.96, 1, laneW * 0.62);
          m.compose(p, q, s);
          this.laneBands.setMatrixAt(n, m);
          c.setHex(LANE_COLORS[type]);
          this.laneBands.setColorAt(n, c);
          n++;
          if (n >= this.laneBands.instanceMatrix.count) return;
        }
      }
    };
    for (let i = 0; i < state.lt.length; i++) {
      addTile(i, 0);
      if (n >= this.laneBands.instanceMatrix.count) break;
      addTile(i, 1);
    }
    this.laneBands.count = n;
    this.laneBands.instanceMatrix.needsUpdate = true;
    if (this.laneBands.instanceColor) this.laneBands.instanceColor.needsUpdate = true;
  }

  updateCongestion(state) {
    for (const key of [1, 2, 3]) {
      const geo = this.meshes[key].geometry;
      const colors = geo.getAttribute('color');
      if (!colors) continue;
      const arr = colors.array;
      const ranges = this.tileRanges[key], tiles = this.tilesOf[key];
      for (let r = 0; r < ranges.length; r++) {
        const c = state.congestion[tiles[r]] / 255;
        const rr = 1 + c * 0.95, gg = 1 - c * 0.72, bb = 1 - c * 0.78;
        const [s, e] = ranges[r];
        for (let v = s; v < e; v++) {
          arr[v * 3] = rr; arr[v * 3 + 1] = gg; arr[v * 3 + 2] = bb;
        }
      }
      colors.needsUpdate = true;
    }
  }
}
