// ============================================================================
//  示范城建造（供 make-demo / 诊断脚本复用）
//
//  结构（和真实城市一样：环城高架 + 放射干道 + 地面街区）
//    · 高架环线：整圈平桥面（11m），4 条匝道上下高速
//    · 高速出入口 → 直接上高架环线 → 过境车走环线（不进城中心），
//      地面干道只服务本地交通 —— 这样高架才真的会有车
//    · 穿山隧道：北部大山 + 西南丘陵各一条
//    · 跨河大桥：东岸出入口
//    · 45° 斜向大道 + 圆弧支路：路网不是格子
//    · 高度上限：核心区才盖高楼，高架沿线限高低层 —— 路网一眼看得见
// ============================================================================
import { City } from '../server/sim/city.js';
import { MAP, TRAFFIC, TERRAIN, TIME, hash2 } from '../server/sim/constants.js';
import { roadPath, straightPath } from '../server/sim/roadpath.js';

const T = (x, z) => z * MAP.SIZE + x;
const DECK_H = 9.5;                             // 高架环线桥面高度 (m)
const DEMO_SEED = Number(process.env.DEMO_SEED || 7);   // 固定种子：示范城每次生成都一样

export function buildDemoCity(id = 'demo_skyline', name = '天际示范城') {
// 显式山体：隧道要正好从山中间穿过去，所以山的位置必须固定，不能靠随机。
//   北部大山（隧道 x1~10,z3） / 西南丘陵（隧道 x1~9,z39）
//   东北 / 东南的山 —— 让整张图有高低起伏，不是平板
const PEAKS = [
  { x: 3.0, z: 3.0, r: 5.6, h: 31 },
  { x: 4.0, z: 39.0, r: 5.4, h: 27 },
  { x: 45.0, z: 5.0, r: 5.0, h: 24 },
  { x: 45.0, z: 45.0, r: 6.0, h: 30 },
  { x: 42.0, z: 40.0, r: 3.4, h: 12 },
];
const city = new City({ id, name, seed: DEMO_SEED, peaks: PEAKS });
city.funds = 4000000;

let built = 0, tunnels = 0, failed = 0;
function lay(tiles, type, label, opts = {}) {
  const r = city.buildRoad(tiles, type, opts);
  if (r.ok) { built++; if (opts.tunnel) tunnels++; return true; }
  failed++;
  console.log('  ! ' + label + ' 失败: ' + r.msg);
  return false;
}

// ============================================================================
//  1) 地面路网（刻意不规则：环路 / 放射 / 斜向 / 圆弧）
// ============================================================================
console.log('--- 地面路网 ---');
// --- 高速：出入口 -> 高架匝道（过境车从这里上环线）---
lay(straightPath(0, 3, 0, 3), 3, '北部高速 入口段');
lay(straightPath(1, 3, 10, 3), 3, '北部高速 穿山隧道', { tunnel: true });
lay(straightPath(10, 3, 19, 3), 3, '北部高速');
lay(straightPath(0, 39, 0, 39), 3, '西南高速 入口段');
lay(straightPath(1, 39, 9, 39), 3, '西南高速 穿山隧道', { tunnel: true });
lay(straightPath(9, 39, 19, 39), 3, '西南高速');
// 跨河大桥：东部大道 -> 大河 -> 东岸 -> 地图东边界出入口
lay(straightPath(32, 22, 47, 22), 3, '跨河大桥');
// --- 主干道 ---
lay(straightPath(9, 3, 9, 40), 2, '西部大道');
lay(straightPath(32, 3, 32, 40), 2, '东部大道（河滨）');
lay(straightPath(21, 3, 21, 40), 2, '中央纵轴大道');
lay(straightPath(8, 22, 32, 22), 2, '中央横轴大道');
lay(straightPath(9, 40, 33, 40), 2, '南部大道');
lay(straightPath(19, 3, 32, 3), 2, '北部联络线');
// --- 支路 ---
lay(straightPath(16, 10, 16, 32), 1, '西部支路');
lay(straightPath(9, 13, 32, 13), 1, '北部支路');
lay(straightPath(9, 28, 32, 28), 1, '南部支路');
lay(straightPath(24, 8, 24, 13), 1, '东北支路');
// 45° 斜向大道：西南 -> 东北，横穿整个核心区（两次从高架桥下穿过）
lay(straightPath(10, 36, 32, 14), 2, '斜向大道');
// 圆弧支路：让城区看起来是「画」出来的，不是格子
lay(roadPath([{ x: 25, z: 3 }, { x: 29, z: 5 }, { x: 32, z: 9 }], 2), 1, '东北弧线支路');
lay(roadPath([{ x: 21, z: 40 }, { x: 26, z: 39 }, { x: 30, z: 36 }, { x: 32, z: 33 }], 2), 1, '东南弧线支路');
lay(roadPath([{ x: 14, z: 38 }, { x: 16, z: 39 }, { x: 17, z: 40 }], 1), 1, '西南联络线');
lay(roadPath([{ x: 15, z: 13 }, { x: 14, z: 18 }, { x: 14, z: 24 }], 1), 1, '西侧弧形街');
lay(roadPath([{ x: 27, z: 14 }, { x: 28, z: 19 }, { x: 28, z: 25 }], 1), 1, '东侧弧形街');

// ============================================================================
//  2) 高架环线 + 4 条匝道
//     顺序很重要：地面路网 -> 匝道 -> 环线。
//     匝道落地端必须接在「已建好的地面道路」上，高程才对得上；
//     匝道必须先于环线建，否则环线先占了匝道末端那一格，匝道就不够长（坡度超限）。
// ============================================================================
console.log('--- 高架环线 ---');
const RAMPS = [
  ['北匝道', straightPath(19, 3, 19, 8)],    // 北部高速(z=3)  -> 环线北边(z=8)
  ['南匝道', straightPath(19, 39, 19, 34)],  // 西南高速(z=39) -> 环线南边(z=34)
  ['西匝道', straightPath(9, 21, 13, 21)],    // 西部大道(x=9)  -> 环线西边(x=13)
  ['东匝道', straightPath(32, 16, 27, 16)],   // 东部大道(x=32) -> 环线东边(x=27)
  ['东北匝道', straightPath(21, 13, 21, 8)],  // 北部支路(z=13) -> 环线北边(z=8)
  ['西北匝道', straightPath(9, 13, 13, 13)],  // 北部支路(z=13) -> 环线西边(x=13)
  ['西南匝道', straightPath(13, 40, 13, 34)], // 南部大道(z=40) -> 环线西边(x=13)
  ['东南匝道', straightPath(25, 40, 25, 34)], // 南部大道(z=40) -> 环线南边(z=34)
];
for (const [label, path] of RAMPS) {
  const r = city.buildRoad(path, 3, { elevated: true, ramp: 'up', height: DECK_H });
  if (r.ok) built++; else { failed++; console.log('  ! ' + label + ' 失败: ' + r.msg); }
}
// 环线高架板：整圈等高（靠上面的匝道上下高速）
const RING = {
  north: straightPath(13, 8, 27, 8),
  east:  straightPath(27, 8, 27, 34),
  south: straightPath(27, 34, 13, 34),
  west:  straightPath(13, 34, 13, 8),
};
for (const [k, path] of Object.entries(RING)) {
  const r = city.buildRoad(path, 3, { elevated: true, deck: true, height: DECK_H });
  if (r.ok) built++; else { failed++; console.log('  ! 高架' + k + ' 失败: ' + r.msg); }
}

console.log('  道路完成：' + built + ' 段（含隧道 ' + tunnels + ' 段），失败 ' + failed +
  '　路网节点 ' + city.net.nodes.length + '，连通块 ' + city.net.components);

// ============================================================================
//  3) 分区：整块成区（像真的街区），核心 / 工业 / 住宅分明
// ============================================================================
const IND_C = { x: 25, z: 31 }, COM_C = { x: 20, z: 19 };
const res = [], com = [], ind = [];
// 高架沿线：限高低层（1 级小楼），桥面才看得见
const nearViaduct = (x, z) => {
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    const nx = x + dx, nz = z + dz;
    if (nx < 0 || nz < 0 || nx >= MAP.SIZE || nz >= MAP.SIZE) continue;
    if (city.tiles[nz * MAP.SIZE + nx].over) return true;
  }
  return false;
};
// 城区范围：离路 3 格以内、山上（坡太陡盖楼不稳）、水面除外
const urban = new Uint8Array(MAP.SIZE * MAP.SIZE);
for (let i = 0; i < city.tiles.length; i++) {
  const t = city.tiles[i];
  if (t.road || t.over || t.service) continue;
  if (t.terrain === TERRAIN.water) continue;
  if (city.elevAt(i) > 13) continue;              // 山地留作林地
  const x = i % MAP.SIZE, z = Math.floor(i / MAP.SIZE);
  let near = false;
  for (let dz = -3; dz <= 3 && !near; dz++) for (let dx = -3; dx <= 3; dx++) {
    const nx = x + dx, nz = z + dz;
    if (nx < 0 || nz < 0 || nx >= MAP.SIZE || nz >= MAP.SIZE) continue;
    const nt = city.tiles[nz * MAP.SIZE + nx];
    if (nt.road || nt.over) { near = true; break; }
  }
  if (near) urban[i] = 1;
}
for (let i = 0; i < city.tiles.length; i++) {
  if (!urban[i]) continue;
  const x = i % MAP.SIZE, z = Math.floor(i / MAP.SIZE);
  // 留些空地/绿地，别让每条街都贴满楼 —— 路网要看得见
  if (hash2(x, z, 91) < 0.15) continue;
  const dI = Math.hypot(x - IND_C.x, z - IND_C.z);
  const dC = Math.hypot(x - COM_C.x, z - COM_C.z);
  if (dI < 8.0) ind.push(i);
  else if (dC < 7.0) com.push(i);
  else res.push(i);
}
city.zoneTiles(res, 'res');
city.zoneTiles(com, 'com');
city.zoneTiles(ind, 'ind');

// ============================================================================
//  3.5) 高度上限：核心区才盖高楼，高架沿线限高低层
// ============================================================================
for (const list of [res, com, ind]) {
  for (const i of list) {
    const t = city.tiles[i];
    const x = i % MAP.SIZE, z = Math.floor(i / MAP.SIZE);
    const dC = Math.hypot(x - COM_C.x, z - COM_C.z);
    // 工业区允许盖到 3 级（工业园），商业核心盖高楼，住宅外围 2 级
    let cap = list === ind ? 3 : (dC < 5.5 ? 3 : 2);
    if (nearViaduct(x, z)) cap = Math.min(cap, 1);
    t.hcap = cap;
  }
}
console.log('分区完成 住宅 ' + res.length + ' 商业 ' + com.length + ' 工业 ' + ind.length);

// ============================================================================
//  4) 服务设施
// ============================================================================
console.log('--- 服务设施 ---');
const svc = (x, z, type) => {
  const r = city.placeService(T(x, z), type);
  console.log('  ' + type.padEnd(7) + ' ' + x + ',' + z + '  ' + (r.ok ? 'OK' : r.msg));
};
svc(22, 36, 'power');
svc(11, 36, 'water');
svc(30, 25, 'water');
svc(17, 11, 'police');
svc(26, 11, 'fire');
svc(15, 26, 'clinic');
svc(11, 18, 'school');
svc(20, 10, 'park');

// ============================================================================
//  5) 高速出入口（人口与货物的唯一来源）
// ============================================================================
console.log('--- 高速出入口 ---');
for (const [x, z] of [[0, 3], [0, 39], [47, 22]]) {
  const r = city.addEntrance(T(x, z));
  console.log('  (' + x + ',' + z + ')  ' + (r.ok ? 'OK' : r.msg));
}

  return city;
}
