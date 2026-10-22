// ============================================================================
//  生成「天际示范城」：主城区 + 外环高架立交 + 穿山隧道 + 跨河大桥 + 山地森林
//  运行： node scripts/make-demo.mjs [游戏天数]
// ============================================================================
import { City } from '../server/sim/city.js';
import { repo, compress } from '../server/db.js';
import { MAP, TRAFFIC, TERRAIN, TIME } from '../server/sim/constants.js';

const T = (x, z) => z * MAP.SIZE + x;
const DAYS = Number(process.argv[2] || 45);

const city = new City({ id: 'demo_skyline', name: '天际示范城' });
city.funds = 4000000;

// ---------------------------------------------------------------- 道路网
// 主城区 x 8..30 / z 8..28，外围是山岭（西南/南/东/东北）与大河（东侧 x≈38）
const AVE_X = [10, 18, 26];      // 南北向大道
const AVE_Z = [10, 18, 26];      // 东西向大道
const ST_X = [14, 22];           // 南北向街道
const ST_Z = [14, 22];           // 东西向街道
const segX = (x0, x1, z) => { const o = []; for (let x = x0; x <= x1; x++) o.push(T(x, z)); return o; };
const segZ = (x, z0, z1) => { const o = []; for (let z = z0; z <= z1; z++) o.push(T(x, z)); return o; };

let built = 0, tunnels = 0, bridges = 0, failed = 0;
function lay(tiles, type, label, opts = {}) {
  let r = city.buildRoad(tiles, type, opts);
  if (r.ok) {
    built++;
    if (opts.tunnel) tunnels++;
    for (const t of tiles) if (city.tiles[t].terrain === TERRAIN.water) bridges++;
    return true;
  }
  if (opts.tunnel) { failed++; console.log('  ! ' + label + ' 失败: ' + r.msg); return false; }
  const why = r.msg;
  // 地面修不了 -> 挖隧道（整段规划才有完整剖面）
  r = city.buildRoad(tiles, type, { tunnel: true });
  if (r.ok) {
    built++; tunnels++;
    console.log('  ~ ' + label + ' 自动改为隧道（' + why + '）');
    for (const t of tiles) if (city.tiles[t].terrain === TERRAIN.water) bridges++;
    return true;
  }
  failed++; console.log('  ! ' + label + ' 失败: ' + why + ' / 隧道: ' + r.msg);
  return false;
}

// --- 主城区骨架 ---
for (const x of AVE_X) lay(segZ(x, 8, 28), 2, '大道 x=' + x);
for (const z of AVE_Z) lay(segX(8, 30, z), 2, '大道 z=' + z);
for (const x of ST_X) lay(segZ(x, 8, 28), 1, '街道 x=' + x);
for (const z of ST_Z) lay(segX(8, 30, z), 1, '街道 z=' + z);
// --- 外环（西/北/东三条腿，南边用高架高速封闭）---
lay(segZ(6, 8, 34), 2, '外环西路 x=6');       // 过湖 -> 自动架桥
lay(segZ(30, 8, 44), 2, '外环东路 x=30');     // 南段接南岸高速
lay(segX(6, 30, 8), 2, '外环北路 z=8');
// --- 立交：南侧外环用高架高速，跨过 x=10 / 18 / 26 三条大道 -> 三座立交桥 ---
const sky = city.buildRoad(segX(6, 30, 30), 3, { elevated: true });
console.log('  高架高速（3 座立交）', sky.ok ? 'OK' : sky.msg);
if (!sky.ok) failed++;
// --- 南岸高速：穿山（隧道）+ 跨河（大桥），直通地图东、西两侧 ---
lay(segX(0, 14, 44), 3, '南岸高速 西段');
lay(segX(15, 22, 44), 3, '南岸高速 穿山隧道', { tunnel: true });   // 强行穿山 -> 隧道
lay(segX(23, 32, 44), 3, '南岸高速 中段');
lay(segX(33, 44, 44), 3, '南岸高速 跨河大桥');
// 西侧外环穿西南山体（隧道），与南岸高速接上
lay(segZ(6, 35, 43), 2, '外环西路 穿山隧道', { tunnel: true });
// --- 高速出入口（城市与外界的唯一通道）---
// 北部入口支线
lay(segZ(10, 0, 8), 2, '入口支线 x=10');
const gate1 = city.addEntrance(T(0, 44));
const gate2 = city.addEntrance(T(10, 0));
console.log('  高速出入口 西:', gate1.ok ? 'OK' : gate1.msg, ' 北:', gate2.ok ? 'OK' : gate2.msg);
console.log('道路完成：路段 ' + built + ' 段，隧道 ' + tunnels + ' 段，跨水格 ' + bridges + '，失败 ' + failed +
  '　路网节点 ' + city.net.nodes.length + '，连通块 ' + city.net.components);

// ---------------------------------------------------------------- 分区
const BX = [[11, 13], [15, 17], [19, 21], [23, 25], [27, 29]];
const res = [], com = [], ind = [];
for (let bx = 0; bx < BX.length; bx++) {
  for (let bz = 0; bz < BX.length; bz++) {
    const [x0, x1] = BX[bx], [z0, z1] = BX[bz];
    // 工业区：东南工业园 7 个街区（靠近高速出入口）；商业区：市中心 6 个街区
    const isInd = (bx >= 3 && bz >= 2) || (bx === 2 && bz === 4);
    const isCom = (bx === 2 && bz === 2) || (bx === 1 && bz === 2) || (bx === 2 && bz === 1)
      || (bx === 2 && bz === 3) || (bx === 1 && bz === 3) || (bx === 3 && bz === 1);
    const isRes = !isInd && !isCom;
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const i = T(x, z);
        if (city.tiles[i].terrain === TERRAIN.water) continue;
        const frontage = (x === x0 || x === x1 || z === z0 || z === z1);
        if (!frontage) continue;
        if (isInd) ind.push(i); else if (isCom) com.push(i); else res.push(i);
      }
    }
  }
}
city.zoneTiles(res, 'res');
city.zoneTiles(com, 'com');
city.zoneTiles(ind, 'ind');
console.log('分区完成 住宅', res.length, '商业', com.length, '工业', ind.length);

// ---------------------------------------------------------------- 服务设施
const svc = (x, z, type) => {
  const r = city.placeService(T(x, z), type);
  console.log('  ' + type.padEnd(7), x + ',' + z, r.ok ? 'OK' : r.msg);
};
svc(28, 9, 'power');    // 发电厂
svc(9, 27, 'water');     // 水塔（西南）
svc(27, 27, 'water');    // 水塔（东南）
svc(12, 12, 'police');   // 警察局
svc(27, 12, 'fire');     // 消防站
svc(19, 19, 'clinic');   // 诊所
svc(7, 10, 'school');    // 学校
svc(21, 12, 'park');     // 公园

// ---------------------------------------------------------------- 快进模拟
console.log('快进模拟 ' + DAYS + ' 游戏日 ...');
const t0 = Date.now();
const TRAFFIC_DAYS = 10;      // 最后几天开启完整交通模拟
for (let d = 0; d < DAYS; d++) {
  const withTraffic = d >= DAYS - TRAFFIC_DAYS;
  for (let m = 0; m < 1440; m++) {
    city.advance(1);
    if (withTraffic) city.stepTraffic(TIME.TRAFFIC_PER_GAME_HOUR / 60);
  }
  if (d % 10 === 0 || d === DAYS - 1) {
    console.log('  第 ' + (d + 1) + ' 日  人口 ' + city.stats.population +
      ' 岗位 ' + city.stats.jobs + ' 资金 ' + Math.round(city.funds) +
      ' 拥堵 ' + (city.traffic.stats.congestion || 0).toFixed(1) + '%' +
      ' 在途 ' + city.traffic.stats.vehicles + ' 净收支 ' + (city.stats.netHour || 0).toFixed(1) + ' §/时');
  }
}

// 把时钟对齐到早上 8 点，打开就有早高峰车流
city.tick = Math.floor(city.tick / 1440) * 1440 + 8 * 60;
city.traffic.t = TRAFFIC.SEC_PER_HOUR * 8;
city.traffic.hour = 8;
city.traffic._tripHour = 8;
city.traffic.ensureTripRate(8);

// ---------------------------------------------------------------- 保存
repo.saveCity(city, compress(city.snapshot()));
console.log('已保存 demo_skyline  人口', city.stats.population, ' 岗位', city.stats.jobs,
  ' 资金', Math.round(city.funds), ' 用时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('交通：拥堵', (city.traffic.stats.congestion || 0).toFixed(1) + '%',
  ' 在途', city.traffic.stats.vehicles,
  ' 平均车速', (city.traffic.stats.avgSpeed || 0).toFixed(1) + ' km/h',
  ' 特种出动', city.traffic.stats.dispatched || 0);
let mv = 0, msum = 0, mstop = 0;
for (const v of city.traffic.vehicles) { if (v.parked || v.dwell > 0) continue; mv++; msum += v.v; if (v.v < 1) mstop++; }
console.log('  行驶中车辆', mv, ' 平均速度', (msum / Math.max(1, mv) * 3.6).toFixed(1), 'km/h 几乎停住', mstop,
  ' 停靠中', city.traffic.vehicles.length - mv);
// 城市结构诊断
const hist = { 1: [0, 0, 0, 0], 2: [0, 0, 0, 0], 3: [0, 0, 0, 0] };
for (const t of city.tiles) { if (t.zone && t.level) hist[t.zone][t.level]++; }
const names = { 1: '住宅', 2: '商业', 3: '工业' };
for (const z of [1, 2, 3]) {
  console.log('  ' + names[z] + ' 建筑等级分布 1级 ' + hist[z][1] + ' / 2级 ' + hist[z][2] + ' / 3级 ' + hist[z][3]);
}
console.log('  住房容量 ' + Math.round(city.housingCapacity()) + ' 人，已入住 ' + Math.round(city.demography.housed) +
  '，待安置 ' + Math.round(city.demography.waiting) + '，人口 ' + Math.round(city.demography.pop) +
  '，岗位 ' + city.stats.jobs + '，失业率 ' + Math.round((city.stats.unemployment || 0) * 100) + '%');
console.log('  需求 R' + (city.demand.res || 0).toFixed(2) + ' C' + (city.demand.com || 0).toFixed(2) +
  ' I' + (city.demand.ind || 0).toFixed(2) + '　幸福度 ' + Math.round(city.stats.happiness) +
  '　商业效率 ' + Math.round((city.stats.effCommercial || 0) * 100) + '%');
