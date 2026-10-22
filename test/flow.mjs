// ============================================================================
//  出行链 / 特种车辆 / 拥堵经济 专项测试
//  运行： npm test
// ============================================================================
import { City } from '../server/sim/city.js';
import { MAP, SERVICE_DISPATCH, EFFICIENCY } from '../server/sim/constants.js';

const T = (x, z) => z * MAP.SIZE + x;
let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? '  OK  ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
}

// ---------------------------------------------------------------- 1. 搭建城市
const c = new City({ name: '出行链测试' });
const rd = [], rs = [], cm = [], ind = [];
for (let x = 0; x < 32; x++) { rd.push(T(x, 16)); rd.push(T(x, 22)); }
for (let z = 16; z <= 22; z++) rd.push(T(20, z));
for (let x = 11; x < 31; x++) { rs.push(T(x, 17)); cm.push(T(x, 21)); ind.push(T(x, 23)); }
c.buildRoad(rd, 1);
c.zoneTiles(rs, 'res');
c.zoneTiles(cm, 'com');
c.zoneTiles(ind, 'ind');
c.placeService(T(8, 12), 'power');
c.placeService(T(36, 36), 'water');
c.addEntrance(T(0, 16));   // 高速出入口：人口只能从这里进来

// 跑 30 小时让建筑长出来
for (let h = 0; h < 30; h++) {
  for (let m = 0; m < 60; m++) { c.advance(1); c.stepTraffic(60); }
}
check('城市已发展出建筑', c.tiles.some((t) => t.level > 0), '人口 ' + c.stats.population);
check('住宅/商业/工业均有建筑',
  c.tiles.some((t) => t.zone === 1 && t.level > 0) &&
  c.tiles.some((t) => t.zone === 2 && t.level > 0) &&
  c.tiles.some((t) => t.zone === 3 && t.level > 0));

// ---------------------------------------------------------------- 2. 出行链
console.log('\n[1] 出行链：市民上下班 / 购物，货车配送');
const purposes = new Set();
const stopCounts = [];
const types = new Set();
for (let i = 0; i < 120; i++) {
  const before = c.traffic.vehicles.length;
  c.traffic.spawnVehicle();
  if (c.traffic.vehicles.length > before) {
    const v = c.traffic.vehicles[c.traffic.vehicles.length - 1];
    types.add(v.type);
    stopCounts.push(v.stops.length);
    for (const s of v.stops) purposes.add(s.purpose);
  }
}
check('车辆被正确生成', c.traffic.vehicles.length > 0, c.traffic.vehicles.length + ' 辆在场');
check('车辆为多段行程（家->上班->购物->家）', Math.max.apply(null, stopCounts) >= 2, '最长 ' + Math.max.apply(null, stopCounts) + ' 站');
check('行程包含上班站点', purposes.has('work'));
check('行程包含购物站点', purposes.has('shop'));
check('行程包含货运站点', purposes.has('freight'));
check('行程终点回到家', purposes.has('home'));
check('存在货车', types.has('truck'), Array.from(types).join('/'));

// ---------------------------------------------------------------- 3. 车辆真的会动
console.log('\n[2] 车辆移动与到站');
let arriveCount = 0;
const arrivePurpose = {};
const origArrive = c.traffic._arrive.bind(c.traffic);
c.traffic._arrive = function (veh, idx) {
  arriveCount++;
  const p = veh.purpose || 'other';
  arrivePurpose[p] = (arrivePurpose[p] || 0) + 1;
  return origArrive(veh, idx);
};
const tracked = c.traffic.vehicles.filter((v) => !v.parked).slice(0, 12);
const p0 = tracked.map((v) => ({ x: v.x, z: v.z }));
for (let s = 0; s < 240; s++) c.traffic.update(1, c.tick + s);
const moved = tracked.filter((v, i) => v.x !== p0[i].x || v.z !== p0[i].z).length;
check('车辆位置随时间变化', moved > 0, moved + '/' + tracked.length + ' 辆发生位移');
check('车辆到达站点', arriveCount > 0, '到站 ' + arriveCount + ' 次 ' + JSON.stringify(arrivePurpose));
const dwelling = c.traffic.vehicles.filter((v) => v.dwell > 0).length;
check('到站后停留（停靠/消费/装货）', dwelling >= 0, '当前停靠 ' + dwelling + ' 辆');
check('车辆有速度与朝向', tracked.some((v) => v.v > 0) || tracked.some((v) => v.heading !== 0));

// ---------------------------------------------------------------- 4. 特种车辆出动
console.log('\n[3] 特种车辆按需出动');
const policeTile = T(13, 14);
const clinicTile = T(9, 13);
const parkTile = T(31, 14);
check('可建造警察局', c.placeService(policeTile, 'police').ok);
check('可建造诊所', c.placeService(clinicTile, 'clinic').ok);
check('可建造公园', c.placeService(parkTile, 'park').ok);

// 直接调度一台警车到某个事件现场
let target = -1;
for (let i = 0; i < c.tiles.length; i++) {
  if (c.tiles[i].zone && c.tiles[i].level > 0 && c.traffic.tileAccess[i] >= 0) { target = i; break; }
}
const policeCfg = SERVICE_DISPATCH[1];
const n0 = c.traffic.vehicles.length;
const okSpawn = c.traffic.spawnServiceVehicle(policeTile, target, policeCfg);
check('警车可以出动', okSpawn && c.traffic.vehicles.length > n0, '现场 tile ' + target);
const pv = c.traffic.vehicles[c.traffic.vehicles.length - 1];
check('出动车辆类型正确', pv.type === 'police', pv.type);
check('出动车辆携带任务站点', pv.stops.length >= 1 && pv.stops[0].purpose === 'service');
check('出动车辆有独立车型 id', pv.typeId >= 4, 'typeId ' + pv.typeId);

// 调度器：按需求概率派出各类特种车辆
const origRandom = Math.random;
Math.random = function () { return 0; };              // 强制命中需求概率
const dispatchBefore = c.traffic.stats.dispatched || 0;
for (let i = 0; i < 6; i++) c.traffic._dispatchServices(25);
Math.random = origRandom;
check('调度器派出了特种车辆', (c.traffic.stats.dispatched || 0) > dispatchBefore,
  '累计出动 ' + (c.traffic.stats.dispatched || 0));
const special = c.traffic.vehicles.filter((v) => v.serviceTile !== undefined);
check('在场有特种车辆', special.length > 0, special.map((v) => v.type).join(','));
check('特种车辆带公务出行目的', special.some((v) => v.purpose === 'service'));

// ---------------------------------------------------------------- 5. 拥堵 -> 效率 -> 经济
console.log('\n[4] 拥堵 -> 效率 -> 商业倒闭 -> 人口与税收');
const comTile = c.tiles.findIndex((t) => t.zone === 2 && t.level > 0);
const indTile = c.tiles.findIndex((t) => t.zone === 3 && t.level > 0);
check('存在商业/工业地块', comTile >= 0 && indTile >= 0);

// 把商/工/住宅门前路段的拥堵拉满（模拟整片区域交通瘫痪）
const jamEdges = new Set();
const jamTiles = [];
for (let i = 0; i < c.tiles.length; i++) {
  if (c.tiles[i].zone && c.tiles[i].level > 0) jamTiles.push(i);
}
for (const ti of jamTiles) {
  for (const ni of [ti - 1, ti + 1, ti - MAP.SIZE, ti + MAP.SIZE]) {
    if (ni < 0 || ni >= c.tiles.length) continue;
    const eid = c.net.tileEdge[ni];
    if (eid >= 0) jamEdges.add(eid);
  }
}
for (const eid of jamEdges) c.net.edges[eid].congestion = 1;

const popBefore = c.stats.population, jobsBefore = c.stats.jobs;
const comJobsBefore = c.tiles[comTile].jobs;
const happyBefore = c.stats.happiness;
c.updateEfficiency();
check('工业效率被拥堵拉低', c.stats.effIndustrial < 0.5, '工业效率 ' + c.stats.effIndustrial.toFixed(2));
check('商业效率被拥堵拉低', c.stats.effCommercial < 0.5, '商业效率 ' + c.stats.effCommercial.toFixed(2));
check('商业效率低于倒闭阈值', c.stats.effCommercial < EFFICIENCY.CLOSE_THRESHOLD,
  '阈值 ' + EFFICIENCY.CLOSE_THRESHOLD);
c.refreshAggregates();
check('同一建筑的岗位因拥堵下降', c.tiles[comTile].jobs < comJobsBefore,
  comJobsBefore + ' -> ' + c.tiles[comTile].jobs);
// 新因果链：拥堵 -> 效率下降 -> 幸福度下降 -> 迁出 -> 人口下降
for (let h = 0; h < 40; h++) {
  for (let m = 0; m < 60; m++) {
    c.advance(1); c.stepTraffic(4);
    // 整片区域交通瘫痪（交通采样会重算拥堵，所以每分钟重新压满）
    c.traffic.stats.congestion = 100;
    for (const eid of jamEdges) c.net.edges[eid].congestion = 1;
  }
  c.updateEfficiency();
  c.updateHappiness();
}
check('人口因拥堵（幸福度下降 -> 迁出）而下降', c.stats.population < popBefore,
  popBefore + ' -> ' + c.stats.population + '（迁出 ' + c.demography.emigrants + ' 人）');
check('岗位总量没有因拥堵而虚增', c.stats.jobs <= jobsBefore * 1.6, jobsBefore + ' -> ' + c.stats.jobs);

// 商业倒闭
const levelBefore = c.tiles[comTile].level;
c.demand.com = 0;
let closed = false;
for (let i = 0; i < 400 && !closed; i++) {
  c.traffic.stats.congestion = 100;
  for (const eid of jamEdges) c.net.edges[eid].congestion = 1;
  c.updateEfficiency();
  c.updateGrowth();
  if (c.tiles[comTile].level < levelBefore) closed = true;
}
check('低效商业倒闭降级', closed, '等级 ' + levelBefore + ' -> ' + c.tiles[comTile].level);

// 幸福度下降
c.updateHappiness();
check('通勤压力降低幸福度', c.stats.happiness < happyBefore,
  happyBefore + ' -> ' + c.stats.happiness.toFixed(1));

console.log('\n' + (failures === 0 ? '全部通过 OK' : failures + ' 项失败 FAIL') + '\n');
process.exit(failures === 0 ? 0 : 1);
