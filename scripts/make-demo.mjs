// ============================================================================
//  生成「天际示范城」：布局合理的示范城市（含大桥、高架立交、
//  住宅/商业/工业区与全套服务设施），并快进模拟若干游戏日。
//  运行： node scripts/make-demo.mjs [游戏天数]
// ============================================================================
import { City } from '../server/sim/city.js';
import { repo, compress } from '../server/db.js';
import { MAP, TRAFFIC } from '../server/sim/constants.js';

const T = (x, z) => z * MAP.SIZE + x;
const DAYS = Number(process.argv[2] || 45);

const city = new City({ id: 'demo_skyline', name: '天际示范城' });
city.funds = 4000000;

// ---------------------------------------------------------------- 道路网
const AVE = [6, 18, 30, 42];        // 大道（4 车道）
const ST = [12, 24, 36];            // 街道（2 车道）
const line = (fixed, from, to) => {
  const out = [];
  for (let i = from; i <= to; i++) out.push(fixed === 'x' ? T(i, 0) : T(0, i));
  return out;
};
const seg = (x0, x1, z) => { const o = []; for (let x = x0; x <= x1; x++) o.push(T(x, z)); return o; };
const segZ = (x, z0, z1) => { const o = []; for (let z = z0; z <= z1; z++) o.push(T(x, z)); return o; };

// 横向
for (const z of AVE) city.buildRoad(seg(2, 45, z), 2);       // 大道
for (const z of ST) city.buildRoad(seg(4, 43, z), 1);         // 街道
// 纵向
for (const x of AVE) city.buildRoad(segZ(x, 2, 45), 2);
for (const x of ST) city.buildRoad(segZ(x, 4, 43), 1);
// 外环高速公路（右下角 L 形），一直延伸到地图边缘 -> 在边缘开「高速出入口」
city.buildRoad(seg(0, 45, 45), 3);
city.buildRoad(segZ(45, 0, 45), 3);
// 高速出入口（城市与外界的连接）：外来通勤车从这里开进来上班、再从这里驶离
city.addEntrance(T(0, 45));
city.addEntrance(T(45, 0));
// 高架：沿街区上方跨越中央大道，形成立体交叉（两端坡道落地接入街道）
city.buildRoad(segZ(25, 13, 23), 2, { elevated: true });

console.log('道路完成，路网节点', city.net.nodes.length, '连通块', city.net.components);

// ---------------------------------------------------------------- 分区
// 街区（5x5 格）编号：bx 0..5 -> x 7-11,13-17,19-23,25-29,31-35,37-41
const BX = [[7, 11], [13, 17], [19, 23], [25, 29], [31, 35], [37, 41]];
const isWater = (i) => city.tiles[i].terrain === 1;
const res = [], com = [], ind = [];
for (let bx = 0; bx < 6; bx++) {
  for (let bz = 0; bz < 6; bz++) {
    const [x0, x1] = BX[bx], [z0, z1] = BX[bz];
    // 工业区：东北角（靠近高速）
    const isInd = (bx === 4 || bx === 5) && bz <= 1;
    // 商业区：市中心
    const isCom = (bx === 2 && bz === 2) || (bx === 3 && bz === 2) || (bx === 3 && bz === 3);
    // 住宅区：西北 + 西侧
    const isRes = (bx <= 1 && bz <= 1) || (bx === 0 && bz >= 2 && bz <= 4) || (bx === 1 && bz === 4) || (bx === 2 && bz === 4);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const i = T(x, z);
        if (isWater(i)) continue;
        // 只开发临街的沿街地块（街区内圈留作街心花园/院落）
        const frontage = (x === x0 || x === x1 || z === z0 || z === z1);
        if (!frontage) continue;
        if (isInd) ind.push(i); else if (isCom) com.push(i); else if (isRes) res.push(i);
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
svc(38, 9, 'power');    // 发电厂（工业区）
svc(31, 13, 'park');     // 街心公园
svc(43, 43, 'park');     // 河畔公园
svc(35, 21, 'water');    // 水塔（东南）
svc(11, 9, 'water');     // 水塔（西北）
svc(21, 21, 'police');   // 警察局
svc(27, 27, 'fire');     // 消防站
svc(27, 21, 'clinic');   // 诊所
svc(13, 13, 'school');   // 学校
svc(13, 27, 'park');     // 公园

// ---------------------------------------------------------------- 快进模拟
console.log('快进模拟 ' + DAYS + ' 游戏日 ...');
const t0 = Date.now();
const TRAFFIC_DAYS = 8;      // 最后几天开启完整交通模拟（其余时间只跑发展/经济）
for (let d = 0; d < DAYS; d++) {
  const withTraffic = d >= DAYS - TRAFFIC_DAYS;
  for (let m = 0; m < 1440; m++) {
    city.advance(1);
    // 交通时钟与经济时钟是解耦的（正式游戏里交通慢 30 倍），
    // 快进时同样按这个比例推进，否则会算出失真的拥堵
    if (withTraffic) city.stepTraffic(2);   // 2 = 与正式游戏完全一致的时钟比例
  }
  if (d % 5 === 0 || d === DAYS - 1) {
    let rt = 0, lv = { 1: 0, 2: 0, 3: 0 }, sumPop = 0;
    for (const t of city.tiles) if (t.zone === 1) { rt++; if (t.level) { lv[t.level]++; sumPop += t.pop; } }
    console.log('   [住宅地块 ' + rt + ' 等级 ' + JSON.stringify(lv) + ' 地块人口和 ' + sumPop + ']');
    console.log('  第 ' + (d + 1) + ' 日  人口 ' + city.stats.population +
      ' 岗位 ' + city.stats.jobs + ' 资金 ' + Math.round(city.funds) +
      ' 拥堵 ' + (city.traffic.stats.congestion || 0).toFixed(1) + '%' +
      ' 在途 ' + city.traffic.stats.vehicles);
  }
}

// 把时钟对齐到早上 8 点，打开就有早高峰车流（城市时钟 + 交通时钟都要对齐）
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
console.log('  车辆统计', JSON.stringify(city.traffic.stats));
