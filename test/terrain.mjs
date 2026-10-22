// ============================================================================
//  地形 / 桥梁 / 隧道 / 坡度 / 实时财政  自检
// ============================================================================
import { City } from '../server/sim/city.js';
import { MAP, ELEV, TERRAIN, ECON } from '../server/sim/constants.js';

const T = (x, z) => z * MAP.SIZE + x;
let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''));
}

// ---------------------------------------------------------------- 1. 地形
console.log('\n[1] 地形高程');
const c = new City({ name: '地形测试' });
let min = 1e9, max = -1e9, water = 0;
for (let i = 0; i < c.height.length; i++) {
  const h = c.height[i];
  if (h < min) min = h;
  if (h > max) max = h;
  const x = i % MAP.SIZE, z = Math.floor(i / MAP.SIZE);
  if (c.terrain[i] === TERRAIN.water) water++;
  // 河流两侧的陆地必须比水面高（桥才能接得上）
  if (c.terrain[i] !== TERRAIN.water && h < 0) {
    // 允许：只统计紧邻水面的岸格
    let nearWater = false;
    for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= MAP.SIZE || nz >= MAP.SIZE) continue;
      if (c.terrain[T(nx, nz)] === TERRAIN.water) nearWater = true;
    }
    if (nearWater) { check('岸边高于水面', false, 'tile ' + x + ',' + z); break; }
  }
}
check('地形有高低起伏', max - min > 6, '最低 ' + min.toFixed(1) + ' m / 最高 ' + max.toFixed(1) + ' m');
check('存在水面（河流）', water > 20, water + ' 格');
check('河床在水位之下', min < -1, min.toFixed(1) + ' m');

// 找一段最陡的相邻地块 —— 那里应该修不了路
let steep = null, steepD = 0;
for (let z = 1; z < MAP.SIZE - 1; z++) {
  for (let x = 1; x < MAP.SIZE - 1; x++) {
    const i = T(x, z);
    const j = T(x + 1, z);
    if (c.terrain[i] === TERRAIN.water || c.terrain[j] === TERRAIN.water) continue;
    const d = Math.abs(c.height[i] - c.height[j]);
    if (d > steepD) { steepD = d; steep = [i, j]; }
  }
}
check('存在陡坡（坡度 > 15%）', steepD > ELEV.MAX_RAMP, '高差 ' + steepD.toFixed(2) + ' m/格');
const steepRes = c.buildRoad(steep, 1);
check('陡坡上修不了路', !steepRes.ok && /坡度/.test(steepRes.msg), steepRes.msg || '竟然建成了');

// ---------------------------------------------------------------- 2. 桥
console.log('\n[2] 桥梁');
// 找一条横跨河流的路（垂直于河流方向）
let bridgeTest = null;
for (let z = 2; z < MAP.SIZE - 2 && !bridgeTest; z++) {
  for (let x = 2; x < MAP.SIZE - 2; x++) {
    const i = T(x, z);
    if (c.terrain[i] !== TERRAIN.water) continue;
    const line = [T(x - 2, z), T(x - 1, z), i, T(x + 1, z), T(x + 2, z)];
    if (line.some((k) => c.terrain[k] === TERRAIN.water && k !== i)) continue;
    bridgeTest = line;
    break;
  }
}
const cb = new City({ name: '桥梁测试' });
let bridgeLine = null;
for (let z = 2; z < MAP.SIZE - 2 && !bridgeLine; z++) {
  for (let x = 2; x < MAP.SIZE - 2; x++) {
    const i = T(x, z);
    if (cb.terrain[i] !== TERRAIN.water) continue;
    bridgeLine = [T(x - 2, z), T(x - 1, z), i, T(x + 1, z), T(x + 2, z)];
    break;
  }
}
const br = cb.buildRoad(bridgeLine, 1);
check('跨水路段可以修路', br.ok, br.msg || '');
if (br.ok) {
  const mid = bridgeLine[2];
  check('水面上的路自动变成桥', cb.tiles[mid].bridge === 1, 'tile ' + (mid % MAP.SIZE) + ',' + Math.floor(mid / MAP.SIZE));
  check('桥面留出净空', Math.abs(cb.tiles[mid].roadH - ELEV.BRIDGE_CLEARANCE) < 0.01,
    '桥面 ' + cb.tiles[mid].roadH.toFixed(2) + ' m');
  // 相邻路面高差必须 <= MAX_RAMP（否则路网会断开）
  let maxDiff = 0;
  for (const k of bridgeLine) {
    const x = k % MAP.SIZE, z = Math.floor(k / MAP.SIZE);
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= MAP.SIZE || nz >= MAP.SIZE) continue;
      const j = T(nx, nz);
      if (!cb.tiles[j].road) continue;
      maxDiff = Math.max(maxDiff, Math.abs(cb.tiles[k].roadH - cb.tiles[j].roadH));
    }
  }
  check('桥面与岸边高差在坡度上限内', maxDiff <= ELEV.MAX_RAMP + 0.01, '最大 ' + maxDiff.toFixed(2) + ' m');
}
// 桥上不能有路口：在桥上再接一条支路 -> 必须被拒绝
const cj = new City({ name: '桥上路口测试' });
let waterTile = -1;
for (let z = 3; z < MAP.SIZE - 3 && waterTile < 0; z++) {
  for (let x = 3; x < MAP.SIZE - 3; x++) {
    const i = T(x, z);
    if (cj.tiles[i].terrain !== TERRAIN.water) continue;
    // 找一段两岸都是陆地的水（方便接支路）
    if (cj.terrain[T(x - 1, z)] === TERRAIN.water || cj.terrain[T(x + 1, z)] === TERRAIN.water) continue;
    waterTile = i; break;
  }
}
const wz = Math.floor(waterTile / MAP.SIZE), wx = waterTile % MAP.SIZE;
const mainLine = [T(wx - 1, wz), T(wx, wz), T(wx + 1, wz)];
cj.buildRoad(mainLine, 1);
const branch = [T(wx, wz - 1), T(wx, wz)];
const brRes = cj.buildRoad(branch, 1);
check('桥上不能有路口', !brRes.ok && /桥上不能有路口/.test(brRes.msg), brRes.msg || '竟然建成了');

// ---------------------------------------------------------------- 3. 隧道
console.log('\n[3] 隧道');
const ct = new City({ name: '隧道测试' });
// 人造一座山：山脊在 x=24（高 21 m），两侧每格升/降 3 m（远超 15% 坡度上限）
const mountainH = (x) => (x < 18 || x > 30) ? 0 : (x <= 24 ? (x - 17) * 3 : (31 - x) * 3);
for (let z = 0; z < MAP.SIZE; z++) {
  for (let x = 0; x < MAP.SIZE; x++) {
    ct.height[z * MAP.SIZE + x] = mountainH(x);
  }
}
// 穿山的 9 格直线（两端 9 m，中间 21 m）
const tunLine = [];
for (let x = 20; x <= 28; x++) tunLine.push(T(x, 24));
if (tunLine) {
  const plain = new City({ name: '隧道对照', flat: true });
  for (let z = 0; z < MAP.SIZE; z++) {
    for (let x = 0; x < MAP.SIZE; x++) {
      plain.height[z * MAP.SIZE + x] = mountainH(x);
    }
  }
  const plainRes = plain.buildRoad(tunLine, 1);
  check('同一条路直接修会因太陡失败', !plainRes.ok && /坡度/.test(plainRes.msg), plainRes.msg || '竟然建成了');
  const tr = ct.buildRoad(tunLine, 1, { tunnel: true });
  check('隧道可以开挖', tr.ok, tr.msg || '');
  if (tr.ok) {
    const midT = tunLine[3];
    check('隧道路面在地面以下', ct.tiles[midT].tunnel === 1 && ct.tiles[midT].roadH < ct.height[midT] - 1,
      '路面 ' + ct.tiles[midT].roadH.toFixed(1) + ' m / 地面 ' + ct.height[midT].toFixed(1) + ' m');
    let maxDiff = 0;
    for (const k of tunLine) {
      const x = k % MAP.SIZE, z = Math.floor(k / MAP.SIZE);
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= MAP.SIZE || nz >= MAP.SIZE) continue;
        const j = T(nx, nz);
        if (!ct.tiles[j].road) continue;
        maxDiff = Math.max(maxDiff, Math.abs(ct.tiles[k].roadH - ct.tiles[j].roadH));
      }
    }
    check('隧道坡度平缓（可通车）', maxDiff <= ELEV.MAX_RAMP * 1.7 + 0.01, '最大高差 ' + maxDiff.toFixed(2) + ' m');
  }
} else {
  check('找到可开隧道的山体', false);
}

// ---------------------------------------------------------------- 4. 实时财政
console.log('\n[4] 实时财政（结算步长）');
const cf = new City({ name: '财政测试', flat: true });
const road = [];
for (let x = 4; x < 30; x++) road.push(T(x, 20));
cf.buildRoad(road, 2);
cf.placeService(T(10, 14), 'power');
cf.placeService(T(20, 26), 'water');
cf.zoneTiles([T(12, 19), T(14, 19), T(16, 19), T(18, 19)], 'res');
cf.zoneTiles([T(12, 21), T(14, 21), T(16, 21)], 'com');
cf.zoneTiles([T(20, 19), T(22, 19)], 'ind');
cf.addEntrance(T(4, 20));
for (let h = 0; h < 48; h++) for (let m = 0; m < 60; m++) cf.advance(1);
const funds0 = cf.funds;
for (let m = 0; m < 60; m++) cf.advance(1);
const funds1 = cf.funds;
check('资金实时变动（不是月底台阶）', Math.abs(funds1 - funds0) > 0.01,
  '1 游戏小时变化 ' + (funds1 - funds0).toFixed(2) + ' §');
check('市政维护有支出', cf.stats.expense > 0, cf.stats.expense.toFixed(1) + ' §/时');
check('税收有收入', cf.stats.income > 0, cf.stats.income.toFixed(1) + ' §/时');
const led0 = cf.ledger.length;
for (let m = 0; m < 30; m++) cf.advance(1);
check('结算步长生效（默认每 10 分钟入账）', cf.ledger.length > led0, '流水 ' + led0 + ' -> ' + cf.ledger.length + ' 条');
const led1 = cf.ledger.length;
for (let m = 0; m < 30; m++) cf.advance(1);
const per10 = cf.ledger.length - led1;
cf.setSettleStep(1);
const led2 = cf.ledger.length;
for (let m = 0; m < 10; m++) cf.advance(1);
const per1 = cf.ledger.length - led2;
check('结算步长可调（1 分钟）', per1 >= 10, '10 分钟入账 ' + per1 + ' 次');
check('人口在实时变化', cf.demography.rate !== undefined && Number.isFinite(cf.demography.rate.net),
  '每小时 ' + (cf.demography.rate ? cf.demography.rate.net : '?') + ' 人');

console.log('\n' + (failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗') + '\n');
process.exit(failures === 0 ? 0 : 1);
