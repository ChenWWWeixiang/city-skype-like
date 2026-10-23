// ============================================================================
//  生成「天际示范城 2.0」并快进模拟后入库
//    · 非网格路网（环路 + 放射线 + 斜向大道 + 圆弧支路）
//    · 高架环线（真·交通枢纽）：整圈平桥面 + 4 条匝道上下高速
//    · 穿山隧道（北部大山 + 西南丘陵）+ 跨河大桥 + 3 个高速出入口
//  运行： node scripts/make-demo.mjs [游戏天数]
// ============================================================================
import { repo, compress } from '../server/db.js';
import { MAP, TRAFFIC, TIME } from '../server/sim/constants.js';
import { buildDemoCity } from './demo-city.mjs';

const DAYS = Number(process.argv[2] || 40);
const NOSAVE = process.env.DEMO_NOSAVE === '1';

const city = buildDemoCity();

console.log('快进模拟 ' + DAYS + ' 游戏日 ...');
const t0 = Date.now();
const TRAFFIC_DAYS = Math.min(16, Math.max(4, Math.floor(DAYS / 2)));  // 最后这些天跑交通：人口从高速出入口进来
for (let d = 0; d < DAYS; d++) {
  const withTraffic = d >= DAYS - TRAFFIC_DAYS;
  for (let m = 0; m < 1440; m++) {
    city.advance(1);
    if (withTraffic) city.stepTraffic(TIME.TRAFFIC_PER_GAME_HOUR / 60);
  }
  if (d % 5 === 0 || d === DAYS - 1) {
    const tr = city.traffic;
    console.log('  第 ' + (d + 1) + ' 日  人口 ' + city.stats.population +
      ' 岗位 ' + city.stats.jobs + ' 资金 ' + Math.round(city.funds) +
      ' 拥堵 ' + (tr.stats.congestion || 0).toFixed(1) + '%' +
      ' 在途 ' + tr.stats.vehicles +
      ' 均速 ' + ((tr.stats.avgSpeed || 0) * 3.6).toFixed(1) + 'km/h');
  }
}

// 时钟对齐到早上 8 点，打开就有早高峰
city.tick = Math.floor(city.tick / 1440) * 1440 + 8 * 60;
city.traffic.t = TRAFFIC.SEC_PER_HOUR * 8;
city.traffic.hour = 8;
city.traffic._tripHour = 8;
city.traffic.ensureTripRate(8);

if (!NOSAVE) {
  repo.saveCity(city, compress(city.snapshot()));
  repo.setFeatured(city.id);        // 外部访问不带 ?c= 时默认打开这座示范城
}
console.log((NOSAVE ? '[未保存] ' : '已保存 ') + 'demo_skyline  人口 ' + city.stats.population +
  ' 岗位 ' + city.stats.jobs + ' 资金 ' + Math.round(city.funds) +
  '  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

// ---------------------------------------------------------------- 诊断
const tr = city.traffic;
let hiVeh = 0, tunnelVeh = 0, bridgeVeh = 0, hiEdges = 0;
for (const e of city.net.edges) {
  if (e.layer === 1) hiEdges++;
  const tun = e.tiles.some((t) => city.tiles[t].tunnel);
  const bri = e.tiles.some((t) => city.tiles[t].bridge);
  for (const id of [e.forwardArc, e.backwardArc]) {
    const arc = city.net.arcs[id];
    if (arc.layer === 1) hiVeh += arc.vehicles.length;
    if (tun) tunnelVeh += arc.vehicles.length;
    if (bri) bridgeVeh += arc.vehicles.length;
  }
}
console.log('  高架路段 ' + hiEdges + ' 段，高架上的车 ' + hiVeh + '，隧道里的车 ' + tunnelVeh + '，桥上的车 ' + bridgeVeh);
console.log('  路网连通块 ' + city.net.components + '（1 = 全城连通）  节点 ' + city.net.nodes.length);
console.log('  交通：拥堵 ' + (tr.stats.congestion || 0).toFixed(1) + '%  在途 ' + tr.stats.vehicles +
  '  平均车速 ' + ((tr.stats.avgSpeed || 0) * 3.6).toFixed(1) + ' km/h 车队 ' + tr.fleet.total);
const hist = { 1: [0, 0, 0, 0], 2: [0, 0, 0, 0], 3: [0, 0, 0, 0] };
for (const t of city.tiles) { if (t.zone && t.level) hist[t.zone][t.level]++; }
const names = { 1: '住宅', 2: '商业', 3: '工业' };
for (const z of [1, 2, 3]) {
  console.log('  ' + names[z] + ' 建筑等级 1级 ' + hist[z][1] + ' / 2级 ' + hist[z][2] + ' / 3级 ' + hist[z][3]);
}
console.log('  住房容量 ' + Math.round(city.housingCapacity()) + ' 人，已入住 ' + Math.round(city.demography.housed) +
  '，人口 ' + Math.round(city.demography.pop) + '，岗位 ' + city.stats.jobs +
  '，失业率 ' + Math.round((city.stats.unemployment || 0) * 100) + '%，幸福度 ' + Math.round(city.stats.happiness));
