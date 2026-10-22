// ============================================================================
//  生成「天际示范城」：布局合理的示范城市（含大桥、高架立交、穿山隧道、
//  住宅/商业/工业区与全套服务设施），并快进模拟若干游戏日。
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
// 示范城建在河西岸的平原上（x 2..32），东岸隔着一条大河（要想过河得修桥）
const AVE_X = [6, 18, 30];       // 南北向大道
const AVE_Z = [6, 18, 30];       // 东西向大道
const ST_X = [12, 24];           // 南北向街道
const ST_Z = [12, 24];           // 东西向街道
const segX = (x0, x1, z) => { const o = []; for (let x = x0; x <= x1; x++) o.push(T(x, z)); return o; };
const segZ = (x, z0, z1) => { const o = []; for (let z = z0; z <= z1; z++) o.push(T(x, z)); return o; };

// 分段修建（每段 5 格）：
//   1) 太平地 -> 地面道路
//   2) 穿山太陡 -> 自动改挖隧道
//   3) 跨水 -> 自动架桥
let built = 0, tunnels = 0, bridges = 0, failed = 0;
function lay(tiles, type, label, opts = {}) {
  // 整段先试一次（隧道必须整段规划才有完整剖面）
  let r = city.buildRoad(tiles, type, opts);
  if (r.ok) {
    built++;
    if (opts.tunnel) tunnels++;
    for (const t of tiles) if (city.tiles[t].terrain === TERRAIN.water) bridges++;
    return;
  }
  if (opts.tunnel) { failed++; console.log('  ! ' + label + ' 失败: ' + r.msg); return; }
  // 再按 5 格分段：太平地就修地面路，穿山就自动改挖隧道
  for (let i = 0; i < tiles.length; i += 5) {
    const chunk = tiles.slice(i, i + 5);
    let rr = city.buildRoad(chunk, type);
    if (!rr.ok) {
      rr = city.buildRoad(chunk, type, { tunnel: true });
      if (rr.ok) tunnels++;
    }
    if (!rr.ok) { failed++; console.log('  ! ' + label + ' 失败: ' + rr.msg); continue; }
    built++;
    for (const t of chunk) if (city.tiles[t].terrain === TERRAIN.water) bridges++;
  }
}
// 东西向（主干道一直通到南边的快速路）
for (const z of AVE_Z) lay(segX(2, 30, z), 2, '大道 z=' + z);
for (const z of ST_Z) lay(segX(2, 30, z), 1, '街道 z=' + z);
// 南北向：主干道从北岸一直修到南岸的快速路
for (const x of AVE_X) lay(segZ(x, 2, 44), 2, '大道 x=' + x);
for (const x of ST_X) lay(segZ(x, 2, 30), 1, '街道 x=' + x);
// 穿山隧道：中间那座山太陡，修不了地面路 —— 挖隧道从山腹穿过
// （隧道两端必须接在地面道路上，所以这里单独修一段，不与其它路交叉）
const tunLine = segZ(23, 1, 4);
lay(tunLine, 1, '穿山隧道 x=23', { tunnel: true });
// 南侧快速路：一直延伸到地图西边缘 -> 在边缘开「高速出入口」
//   途中会跨过大河 -> 自动架桥（桥上不能有路口）
lay(segX(0, 44, 44), 3, '南侧快速路 z=44');
// 高速出入口（城市与外界的连接）：外来通勤车从这里开进来上班、再从这里驶离
const gate = city.addEntrance(T(0, 44));
console.log('  高速出入口', gate.ok ? 'OK' : gate.msg);
// 高架：沿街区上方跨越中央大道，形成立体交叉（两端坡道落地接入街道）
const sky = [];
for (let z = 11; z <= 25; z++) sky.push(T(24, z));
const skyRes = city.buildRoad(sky, 2, { elevated: true });
console.log('  高架', skyRes.ok ? 'OK' : skyRes.msg);
console.log('道路完成：路段 ' + built + ' 段，隧道 ' + tunnels + ' 段，跨水格 ' + bridges + '，失败 ' + failed +
  '　路网节点 ' + city.net.nodes.length + '，连通块 ' + city.net.components);

// ---------------------------------------------------------------- 分区
const BX = [[7, 11], [13, 17], [19, 23], [25, 29]];
const res = [], com = [], ind = [];
for (let bx = 0; bx < BX.length; bx++) {
  for (let bz = 0; bz < BX.length; bz++) {
    const [x0, x1] = BX[bx], [z0, z1] = BX[bz];
    const isInd = bx === 3 && bz <= 1;                       // 工业区：东南（靠近高速）
    const isCom = (bx === 2 && bz === 2) || (bx === 2 && bz === 1);   // 商业区：市中心
    const isRes = !isInd && !isCom;                          // 其余是住宅
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
svc(11, 9, 'police');    // 警察局
svc(27, 9, 'fire');      // 消防站
svc(19, 19, 'clinic');   // 诊所
svc(7, 19, 'school');    // 学校
svc(21, 7, 'park');      // 公园

// ---------------------------------------------------------------- 快进模拟
console.log('快进模拟 ' + DAYS + ' 游戏日 ...');
const t0 = Date.now();
const TRAFFIC_DAYS = 10;      // 最后几天开启完整交通模拟（其余时间只跑发展/经济）
for (let d = 0; d < DAYS; d++) {
  const withTraffic = d >= DAYS - TRAFFIC_DAYS;
  for (let m = 0; m < 1440; m++) {
    city.advance(1);
    if (withTraffic) city.stepTraffic(TIME.TRAFFIC_PER_GAME_HOUR / 60);   // 与正式游戏完全一致的时钟比例
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
