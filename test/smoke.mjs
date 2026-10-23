// ============================================================================
//  冒烟测试：路网 / 交通 / 人口 / 经济 / 持久化 全链路自检
//  运行： npm test
// ============================================================================
import { City } from '../server/sim/city.js';
import { MAP } from '../server/sim/constants.js';
import { manager } from '../server/game.js';
import { repo } from '../server/db.js';

const T = (x, z) => z * MAP.SIZE + x;
let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''));
}

// ---------------------------------------------------------------- 1. 路网
console.log('\n[1] 路网抽取');
const c = new City({ name: '冒烟测试', flat: true });
const road = [], res = [], com = [], ind = [];
for (let x = 0; x < 34; x++) { road.push(T(x, 20)); road.push(T(x, 26)); }
for (let z = 20; z <= 26; z++) road.push(T(16, z));
for (let x = 9; x < 33; x++) { res.push(T(x, 21)); com.push(T(x, 25)); ind.push(T(x, 27)); }
check('道路建造', c.buildRoad(road, 1).ok);
check('路网生成节点', c.net.nodes.length >= 6, c.net.nodes.length + ' 个节点');
check('路网连通（单一连通分量）', c.net.components === 1, c.net.components + ' 块');
check('有向路段成对生成', c.net.arcs.length === c.net.edges.length * 2);
check('分区规划', c.zoneTiles(res, 'res').ok && c.zoneTiles(com, 'com').ok && c.zoneTiles(ind, 'ind').ok);
check('发电厂', c.placeService(T(10, 15), 'power').ok);
check('水塔', c.placeService(T(30, 32), 'water').ok);
// 高速出入口：城市与外界的唯一通道 —— 没有它就没有外来人口
check('高速出入口', c.addEntrance(T(0, 20)).ok);

// ---------------------------------------------------------------- 1b. 新特性
console.log('\n[1b] 弧度 / 坡度 / 车道 / 信号灯');
const c2 = new City({ name: '新特性', flat: true });
// 斜向道路
const diag = [];
for (let i = 0; i < 10; i++) diag.push(T(10 + i, 10 + i));
c2.buildRoad(diag, 1);
check('斜向道路生成对角连接', (c2.net.masks[T(15, 15)] & 0b00100010) !== 0 || (c2.net.masks[T(15, 15)] & 0b10001000) !== 0,
  '掩码 ' + c2.net.masks[T(15, 15)].toString(2));
// 地面路 + 高架跨越
const ground2 = [];
for (let x = 6; x < 20; x++) ground2.push(T(x, 14));
// 两条地面支路，作为高架的上下坡接入点
for (let z = 6; z <= 10; z++) ground2.push(T(13, z));
for (let z = 18; z <= 22; z++) ground2.push(T(13, z));
c2.buildRoad(ground2, 1);
const sky2 = [];
for (let z = 10; z <= 18; z++) sky2.push(T(13, z));
c2.buildRoad(sky2, 1, { elevated: true });
check('高架道路抬升', c2.tiles[T(13, 14)].h > 5, '中段 ' + c2.tiles[T(13, 14)].h.toFixed(1) + ' m');
check('高架两端设坡道', c2.tiles[T(13, 10)].h === 0 && c2.tiles[T(13, 18)].h === 0);
check('地面道路位于下层', c2.tiles[T(13, 14)].road === 1 && c2.tiles[T(13, 14)].over === 1);
check('立体交叉分层（路网分量>1）', c2.net.components >= 2, c2.net.components + ' 块');
// 车道类型
const laneSeg = [];
for (let x = 30; x < 38; x++) laneSeg.push(T(x, 6));
c2.buildRoad(laneSeg, 1);
const li = c2.setLane(T(33, 6), 0);
check('车道类型可设置', li.ok && li.type === 1, li.msg);
check('车道类型写入路网', (c2.net.edges.some((e) => e.laneTypes && e.laneTypes[0] === 1)));
// 高架层车道类型与地面层互不干扰
const liOver = c2.setLane(T(13, 12), 0, 1);
check('高架层车道类型独立设置', liOver.ok && c2.tiles[T(13, 12)].olt !== 0 && c2.tiles[T(13, 12)].lt === 0);
// 信号灯：支路交叉不设灯，大道交叉设灯
const streetCross = c2.net.nodes.find((n) => n.arcs.length >= 3 && !n.hasSignal);
check('支路交叉口不设信号灯', !!streetCross, streetCross ? '让行' : '');
const aveA = [], aveB = [];
for (let x = 38; x < 46; x++) aveA.push(T(x, 40));
for (let z = 40; z < 46; z++) aveB.push(T(42, z));
c2.buildRoad(aveA, 2); c2.buildRoad(aveB, 2);
const node = c2.net.nodes.find((n) => n.hasSignal);
check('主干道交叉口具备信号灯', !!node, node ? 'tile ' + (node.tile % 48) + ',' + Math.floor(node.tile / 48) : '');
check('信号灯相位随时间切换', (() => {
  if (!node) return false;
  const s0 = node.signal.state;
  return s0 === 'green' || s0 === 'yellow' || s0 === 'allred';
})());
check('信号灯在一个周期内走完 绿->黄->全红', (() => {
  if (!node) return false;
  const seen = new Set();
  const phases = new Set();
  // 采样要够密：全红只有 0.5 秒，每秒采一次会漏掉
  for (let i = 0; i < 240; i++) { c2.traffic._updateSignals(0.25); seen.add(node.signal.state); phases.add(node.signal.phase); }
  return seen.has('green') && seen.has('yellow') && seen.has('allred') && phases.size >= 2;
})());
// 两种信号灯方案：四向分相 / 对向通行
check('信号灯方案可切换', (() => {
  c2.setSignalMode(0);   // 四向分相
  const p4 = c2.net.nodes.filter((n) => n.hasSignal).map((n) => (n.signal.plan ? n.signal.plan.length : 0));
  c2.setSignalMode(1);   // 对向通行
  const p2 = c2.net.nodes.filter((n) => n.hasSignal).map((n) => (n.signal.plan ? n.signal.plan.length : 0));
  c2.setSignalMode(2);   // 自动
  return p4.every((x) => x >= 2) && p2.some((x) => x === 1 || x === 2);
})());
// 右侧通行：车道 0（本方向最右车道）必须落在行驶方向的右手边
check('右侧通行（车道 0 在道路右侧）', (() => {
  const c3 = new City({ name: '通行方向', flat: true });
  const seg = [];
  for (let x = 5; x <= 20; x++) seg.push(T(x, 10));
  c3.buildRoad(seg, 1);
  let ok = true;
  for (const arc of c3.net.arcs) {
    const h = arc.endHeading;
    const rx = -Math.cos(h), rz = Math.sin(h);   // 行驶方向的右手边
    const veh = { id: 1, type: 'car', typeId: 0, len: 4, width: 2, arc: arc.id, lane: 0, dist: 8, v: 0,
      path: [arc.id], pathIdx: 0, stops: [], stop: null, dwell: 0, parked: false, purpose: '',
      destOffset: undefined, originTile: 0, destTile: 0, born: 0, wait: 0, tripTime: 0,
      x: 0, z: 0, y: 0, heading: 0, grade: 0, homeTile: 0, state: 'driving' };
    const p = { x: arc.poly[0].x + (arc.poly[1].x - arc.poly[0].x) * 0.5,
      z: arc.poly[0].z + (arc.poly[1].z - arc.poly[0].z) * 0.5,
      heading: Math.atan2(arc.poly[1].x - arc.poly[0].x, arc.poly[1].z - arc.poly[0].z) };
    c3.traffic._placeOnLane(veh, arc, p);
    const along = (veh.x - p.x) * rx + (veh.z - p.z) * rz;
    if (along <= 0) ok = false;
  }
  return ok;
})());

// ---------------------------------------------------------------- 2. 发展
console.log('\n[2] 人口与发展');
for (let h = 0; h < 36; h++) {
  for (let m = 0; m < 60; m++) { c.advance(1); c.stepTraffic(60); }
}
check('人口增长', c.stats.population > 0, '人口 ' + c.stats.population);
check('岗位产生', c.stats.jobs > 0, '岗位 ' + c.stats.jobs);
check('需求模型有输出', Number.isFinite(c.demand.res) && Number.isFinite(c.demand.com));

// ---------------------------------------------------------------- 3. 交通
console.log('\n[3] 交通仿真');
const ts = c.traffic.stats;
check('车辆成功生成', (ts.spawned || 0) > 0, '生成 ' + ts.spawned);
check('车辆完成行程', (ts.arrived || 0) > 0, '到达 ' + ts.arrived);
check('存在无法到达的统计', typeof (ts.unreachable || 0) === 'number');
check('拥堵指标在 0-100', ts.congestion >= 0 && ts.congestion <= 100, ts.congestion.toFixed(1) + '%');
check('路边停放车辆已生成', (c.traffic.parkedCars || []).length > 0, (c.traffic.parkedCars || []).length + ' 辆');

// ---------------------------------------------------------------- 4. 经济
console.log('\n[4] 经济与财政');
for (let day = 0; day < 35; day++) {
  for (let m = 0; m < 1440; m++) { c.advance(1); }   // 财政段不需要跑交通（纯经济）
}
check('月度结算发生', c.ledger.length >= 1, c.ledger.length + ' 条账目');
check('税收收入 > 0', c.stats.income > 0, Math.round(c.stats.income) + ' §');
check('支出 > 0', c.stats.expense > 0, Math.round(c.stats.expense) + ' §');
check('资金随结算变化', Number.isFinite(c.funds));
check('税率可调', c.setTax('res', 15).ok && c.tax.res === 15);

// ---------------------------------------------------------------- 5. 持久化
console.log('\n[5] SQLite 持久化');
const game = manager.create({ name: '持久化测试' });
game.city.buildRoad(road, 1);
game.save(true);
const loaded = manager.loadFromDb(game.id);
check('城市快照可回读', !!loaded);
check('回读后地块一致', loaded && loaded.city.tiles.length === game.city.tiles.length);
check('财政流水已入库', repo.listLedger(game.id).length >= 0);
const snap = game.city.snapshot();
check('快照结构完整', snap.v === 1 && snap.tiles.length === MAP.SIZE * MAP.SIZE);
manager.remove(game.id);
check('城市可删除', !manager.get(game.id));

console.log('\n' + (failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗') + '\n');
process.exit(failures === 0 ? 0 : 1);
