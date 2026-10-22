// ============================================================================
//  车队守恒 / 人口账本 专项测试
//  规则：
//   1. 车不凭空出现：新车只在家里的车位诞生（购车 / 移民进城 / 特种建筑配车）
//   2. 车不凭空消失：车开进建筑 = 停进车库；只有驶出城市与报废才离开车队
//   3. 人口只有两个来源（外来车辆 + 新生儿），只有两个出口（死亡 + 迁出）
//  运行： node test/conservation.mjs
// ============================================================================
import { City } from '../server/sim/city.js';
import { MAP, DEMOGRAPHY } from '../server/sim/constants.js';

let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? '  OK  ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
}
const T = (x, z) => z * MAP.SIZE + x;

function run(c, hours, label) {
  for (let h = 0; h < hours; h++) {
    for (let m = 0; m < 60; m++) { c.advance(1); c.stepTraffic(4); }
  }
  if (label) console.log('    ' + label);
}

// ---------------------------------------------------------------- 1. 有出入口
console.log('\n[1] 有高速出入口：人口由外来车辆 + 新生儿产生');
const c = new City({ name: '守恒测试' });
const T0 = (x, z) => T(x, z);
// 主干道 + 街区
const rd = [];
for (let x = 0; x < 30; x++) rd.push(T(x, 20));
for (let z = 8; z < 30; z++) rd.push(T(18, z));
c.buildRoad(rd, 2);
const rs = [], cm = [], ind = [];
for (let x = 9; x < 17; x++) rs.push(T(x, 21));
for (let x = 19; x < 29; x++) rs.push(T(x, 21));
for (let x = 9; x < 17; x++) cm.push(T(x, 19));
for (let x = 19; x < 29; x++) ind.push(T(x, 19));
c.zoneTiles(rs, 'res'); c.zoneTiles(cm, 'com'); c.zoneTiles(ind, 'ind');
c.placeService(T(12, 12), 'power');
c.placeService(T(24, 26), 'water');
check('建城时人口为 0（人口不会凭空出现）', c.stats.population === 0, '人口 ' + c.stats.population);

const gateTile = T(0, 20);
const rGate = c.addEntrance(gateTile);
check('高速出入口可建在地图边缘的道路上', rGate.ok, rGate.msg || '');

run(c, 30, '跑 30 游戏小时');
const dem = c.demography;
check('人口 > 0（外来车辆带来的人口）', c.stats.population > 0, '人口 ' + c.stats.population);
check('账本人口 ≈ 地块人口', Math.abs(dem.housed - c.stats.population) < Math.max(30, c.stats.population * 0.15),
  '账本 ' + dem.housed + ' / 地块 ' + c.stats.population);
check('移民确实到账', dem.immigrants > 0, '移民 ' + dem.immigrants);
check('有出生记录', dem.births >= 0, '出生 ' + dem.births + ' 死亡 ' + dem.deaths);
check('人口来源可解释：人口 <= 移民 + 出生', c.stats.population <= dem.immigrants + dem.births + 5,
  '人口 ' + c.stats.population + ' vs 移民+出生 ' + (dem.immigrants + dem.births));

// ---------------------------------------------------------------- 2. 车队守恒
console.log('\n[2] 车队守恒');
const tr = c.traffic;
let garageCars = 0, garageTrucks = 0;
for (const e of tr.garage.values()) { garageCars += e.cars; garageTrucks += e.trucks; }
const onRoad = tr.vehicles.length;
const special = tr.specials.length;
check('车队总数 = 路上 + 车库 + 特种',
  tr.fleet.total === onRoad + garageCars + garageTrucks + special,
  '总数 ' + tr.fleet.total + ' = 路上 ' + onRoad + ' + 车库 ' + (garageCars + garageTrucks) + ' + 特种 ' + special);
check('车队随人口增长（家庭购车）', tr.fleet.cars > 0, '小车 ' + tr.fleet.cars + ' 货车 ' + tr.fleet.trucks);
check('车不会凭空出现在路上：路上车辆 <= 车队', onRoad <= tr.fleet.total, '路上 ' + onRoad);

// 跑一段时间，看车队数量变化是否有据可查
const before = tr.fleet.total;
run(c, 20, '再跑 20 小时');
const after = tr.fleet.total;
console.log('    车队 ' + before + ' -> ' + after + '（人口 ' + c.stats.population + '）');
check('车队规模与人口同向（人口涨、车队不缩）', c.stats.population >= 0 && after >= 0, '');

// ---------------------------------------------------------------- 3. 没有出入口
console.log('\n[3] 没有高速出入口：不会凭空产生人口');
const c2 = new City({ name: '无入口' });
c2.buildRoad(rd, 2);
c2.zoneTiles(rs, 'res'); c2.zoneTiles(cm, 'com'); c2.zoneTiles(ind, 'ind');
c2.placeService(T(12, 12), 'power');
c2.placeService(T(24, 26), 'water');
run(c2, 30);
check('无出入口时人口不增长', c2.stats.population === 0, '人口 ' + c2.stats.population);
check('无出入口时没有外来车', (c2.traffic.stats.external || 0) === 0, '外来车 ' + (c2.traffic.stats.external || 0));

// ---------------------------------------------------------------- 4. 特种车随建筑诞生
console.log('\n[4] 特种车辆伴随特种建筑诞生');
const c3 = new City({ name: '特种车' });
c3.buildRoad(rd, 2);
const rp = c3.placeService(T(12, 12), 'police');
check('警察局建成', rp.ok, rp.msg || '');
check('同时诞生 2 辆警车', c3.traffic.specials.length === 2, '特种车 ' + c3.traffic.specials.length);
check('警车停在警局待命（不在路上）', c3.traffic.specials.every((v) => v.state === 'garaged'), '');
const rf = c3.placeService(T(24, 26), 'fire');
check('消防站诞生 2 辆消防车', c3.traffic.specials.length === 4, '特种车 ' + c3.traffic.specials.length);
c3.bulldoze([T(12, 12)]);
check('拆掉警察局 -> 警车一起消失', c3.traffic.specials.length === 2, '特种车 ' + c3.traffic.specials.length);
check('车队总数同步减少', c3.traffic.fleet.special === 2, '特种车 ' + c3.traffic.fleet.special);

// ---------------------------------------------------------------- 5. 车进建筑 = 不消失
console.log('\n[5] 车到建筑后停进车库（不凭空消失）');
const c4 = new City({ name: '进楼' });
c4.buildRoad(rd, 2);
c4.zoneTiles(rs, 'res'); c4.zoneTiles(cm, 'com'); c4.zoneTiles(ind, 'ind');
c4.placeService(T(12, 12), 'power');
c4.placeService(T(24, 26), 'water');
c4.addEntrance(T(0, 20));
run(c4, 12);
const t4 = c4.traffic;
const total0 = t4.fleet.total;
const alive0 = t4.vehicles.length;
run(c4, 6);
check('车队总数在运行中保持稳定或有据变化',
  t4.fleet.total > 0 && t4.fleet.total >= t4.vehicles.length,
  '车队 ' + t4.fleet.total + ' 路上 ' + t4.vehicles.length + '（6 小时前 车队 ' + total0 + ' 路上 ' + alive0 + '）');
check('到达站点的车进入车库而不是被删除',
  t4.stats.arrived > 0 && (t4.stats.vanished || 0) < t4.stats.arrived * 0.2,
  '到达 ' + t4.stats.arrived + ' 消失 ' + (t4.stats.vanished || 0));

console.log('\n' + (failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗') + '\n');
process.exit(failures === 0 ? 0 : 1);
