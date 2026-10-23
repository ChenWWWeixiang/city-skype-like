
// ============================================================================
//  堵车模拟器专项测试
//   1) 红灯时车辆停在【停止线】外（不压路口）
//   2) 选路按「限速算最快到达」（不是按当前拥堵绕路）
//   3) 路口通行权：绿灯放行、黄灯清空、全红不放行
//   4) 排队回溯：红灯时后面的车依次排到停止线后面
//  运行： npm test
// ============================================================================
import { City } from '../server/sim/city.js';
import { MAP, SIGNAL, TRAFFIC } from '../server/sim/constants.js';

const T = (x, z) => z * MAP.SIZE + x;
let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? '  OK  ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
}

// ---------------------------------------------------------------- 十字路口
const c = new City({ name: '堵车测试', flat: true });
const row = [], col = [];
for (let x = 8; x < 34; x++) row.push(T(x, 20));
for (let z = 8; z < 34; z++) col.push(T(20, z));
c.buildRoad(row, 2);
c.buildRoad(col, 2);
const node = c.net.nodes.find((n) => n.hasSignal && n.approaches.length === 4);
check('十字路口有信号灯', !!node, node ? node.x + ',' + node.z : '');

// 西侧进口（从西往东）
const westArcId = node.approaches.find((a) => a.dir === 'W').arcs[0];
const westArc = c.net.arcs[westArcId];
const stopLine = node.stopLine.W;
check('停止线在路口外', stopLine > 4, '停止线距路口中心 ' + stopLine.toFixed(1) + ' m');

// 放 4 辆车在西侧进口道上，间距 12m
const cars = [];
for (let i = 0; i < 4; i++) {
  const v = c.traffic.spawnScripted({
    arc: westArcId, lane: 0, dist: 14 + i * 12, type: 'car', originTile: T(10, 20),
    stops: [{ tile: T(30, 19), purpose: 'work', dwell: 0 }], maxSpeed: 1,
  });
  if (v) { v.v = 12; cars.push(v); }
}
check('测试车辆已就位', cars.length === 4, cars.length + ' 辆');

// 把信号灯强制切到「南北放行」相位（西侧进口必须等灯）
const sig = node.signal;
function forcePhase(idx) {
  const cyc = sig.cycle || SIGNAL.CYCLE;
  const per = cyc / sig.plan.length;
  sig.t = ((idx * per + 1) - sig.offset + cyc * 2) % cyc;
}
forcePhase(0);   // 0 = 南北相位（西侧是红灯）

// 跑 8 个交通秒：车应该停在停止线外
// （每个子步都重新锁相位，保证整段模拟都是红灯）
for (let i = 0; i < 80; i++) { forcePhase(0); c.traffic.update(0.25, c.tick + i); }
const distToNode = cars.map((v) => westArc.length - v.dist);
const stopped = cars.filter((v) => v.v < 0.6).length;
check('红灯时车辆在停止线前停车', distToNode.every((d) => d >= stopLine - 0.6),
  '距路口 ' + distToNode.map((d) => d.toFixed(1)).join('/') + ' m（停止线 ' + stopLine.toFixed(1) + '）');
check('红灯时车辆已停住', stopped >= 4, stopped + ' 辆停下（应全部停住）');
check('红灯时没有车压进路口', c.net.nodes[node.id].passing === 0, '路口内 ' + node.passing + ' 辆');

// 切到东西相位：车应该放行
forcePhase(1);
for (let i = 0; i < 40; i++) c.traffic.update(0.25, c.tick + 40 + i);
const moved = cars.filter((v) => westArc.length - v.dist > stopLine + 6).length;
check('绿灯放行后车辆驶过停止线', moved >= 1, moved + ' 辆进入路口');

// ---------------------------------------------------------------- 选路
console.log('\n[2] 选路：按限速算最快到达');
const c2 = new City({ name: '选路测试', flat: true });
// 两条并行的 L 形路线，接在同一对路口上：
//   北线 = 高速（限速 100），南线 = 大道（限速 60）
const fast = [], slow = [];
for (let x = 6; x <= 29; x++) fast.push(T(x, 14));
for (let z = 14; z <= 30; z++) fast.push(T(29, z));
for (let z = 14; z <= 30; z++) slow.push(T(6, z));
for (let x = 6; x <= 29; x++) slow.push(T(x, 30));
c2.buildRoad(fast, 3);      // 高速
c2.buildRoad(slow, 2);      // 大道
const net2 = c2.net;
const slowEdge = net2.edges.find((e) => e.type === 2 && e.tiles.length > 10);
const fastEdge = net2.edges.find((e) => e.type === 3 && e.tiles.length > 10);
check('两条路线都在路网里', !!slowEdge && !!fastEdge);
if (slowEdge && fastEdge) {
  const tSlow = slowEdge.length / slowEdge.v0;
  const tFast = fastEdge.length / fastEdge.v0;
  check('高速按限速更快', tFast < tSlow,
    '高速 ' + tFast.toFixed(1) + 's vs 大道 ' + tSlow.toFixed(1) + 's');
  // 两条 L 形路线共用同一对端点：(6,14) 与 (29,30)
  //   北线 = 高速 z=14 走 x=6..29，再沿 x=29 走到 z=30
  //   南线 = 大道 x=6 走到 z=30，再沿 z=30 走 x=6..29
  const from = net2.nodes.find((n) => n.x === 6 && n.z === 14).id;
  const to = net2.nodes.find((n) => n.x === 29 && n.z === 30).id;
  const path = c2.traffic.findPath(from, to);
  const usedFast = path && path.some((id) => net2.arcs[id].type === 3);
  const pathTime = path ? path.reduce((s, id) => s + net2.arcs[id].length / net2.arcs[id].v0, 0) : Infinity;
  check('按限速选路：走限速更高（更快到达）的那条', !!usedFast,
    (usedFast ? '走高速' : '没有走高速') + '（用时 ' + pathTime.toFixed(1) + 's）');
  // 把大道人为堵死（弧的 congestion = 1）：按限速选路仍不改变
  const jamArcs = (e) => {
    const a = net2.arcs[e.forwardArc], b = net2.arcs[e.backwardArc];
    a.congestion = 1; b.congestion = 1;
  };
  const clearArcs = (e) => {
    const a = net2.arcs[e.forwardArc], b = net2.arcs[e.backwardArc];
    a.congestion = 0; b.congestion = 0;
  };
  jamArcs(slowEdge);
  const path1 = c2.traffic.findPath(from, to);
  const stillFast = path1 && path1.some((id) => net2.arcs[id].type === 3);
  check('按限速选路：不因当前拥堵改道', !!stillFast, stillFast ? '仍走高速' : '改走了');
  // 切成动态绕行：应该改走没堵的大道
  c2.settings.routing = 'adaptive';
  const path2 = c2.traffic.findPath(from, to);
  const stillFast2 = path2 && path2.some((id) => net2.arcs[id].type === 3);
  check('动态绕行模式：避开已经堵死的大道', !!stillFast2, stillFast2 ? '仍走高速（绕开堵车大道）' : '走大道');
  // 反过来：把高速堵死，动态绕行应该改走大道
  clearArcs(slowEdge);
  jamArcs(fastEdge);
  const path3 = c2.traffic.findPath(from, to);
  const usedSlow3 = path3 && path3.some((id) => net2.arcs[id].type === 2);
  check('动态绕行模式：高速堵死时改走大道', !!usedSlow3, usedSlow3 ? '走大道' : '还是走高速');
}

// ---------------------------------------------------------------- 排队回溯
console.log('\n[3] 红灯排队回溯');
const c3 = new City({ name: '排队测试', flat: true });
const r3 = [];
for (let x = 4; x < 40; x++) r3.push(T(x, 20));
for (let z = 20; z < 40; z++) r3.push(T(20, z));
c3.buildRoad(r3, 2);
const n3 = c3.net.nodes.find((n) => n.hasSignal);
const w3 = n3.approaches.find((a) => a.dir === 'W').arcs[0];
const a3 = c3.net.arcs[w3];
const queue = [];
for (let i = 0; i < 10; i++) {
  const v = c3.traffic.spawnScripted({
    arc: w3, lane: 0, dist: 12 + i * 11, type: 'car', originTile: T(6, 20),
    stops: [{ tile: T(36, 19), purpose: 'work', dwell: 0 }], maxSpeed: 1,
  });
  if (v) { v.v = 14; queue.push(v); }
}
const s3 = n3.signal;
const cyc3 = s3.cycle || SIGNAL.CYCLE;
const per3 = cyc3 / s3.plan.length;
s3.t = ((1) - s3.offset + cyc3 * 2) % cyc3;      // 东西相位 -> 西侧是绿灯
for (let i = 0; i < 60; i++) c3.traffic.update(0.25, c3.tick + i);
const still = queue.filter((v) => v.arc === w3 && a3.length - v.dist < n3.stopLine.W + 30).length;
check('绿灯时车队开始放行', still < queue.length || queue.some((v) => v.arc !== w3),
  queue.length + ' 辆中 ' + still + ' 辆还在路口前');

// ---------------------------------------------------------------- 高架 + 斜路
console.log('\n[4] 高架环线与斜向道路');
const c4 = new City({ name: '高架测试', flat: true });
const g1 = [], g2 = [];
for (let x = 6; x <= 14; x++) g1.push(T(x, 14));      // 地面横路（匝道落地点）
for (let x = 8; x <= 20; x++) g2.push(T(x, 8));
const ramp = [];
for (let z = 8; z <= 14; z++) ramp.push(T(10, z));     // 匝道：从高架 z=8 落到地面 z=14
c4.buildRoad(g1, 2);
const deck = c4.buildRoad(g2, 3, { elevated: true, deck: true, height: 9 });
check('高架板建成', deck.ok, deck.msg);
const rp = c4.buildRoad(ramp, 3, { elevated: true, ramp: 'down', height: 9 });
check('匝道建成', rp.ok, rp.msg);
const hiEdges = c4.net.edges.filter((e) => e.layer === 1);
check('高架层有路段', hiEdges.length >= 1, hiEdges.length + ' 段');
check('高架是高速等级（限速 100km/h）', hiEdges.every((e) => e.type === 3 && e.v0 > 20),
  hiEdges.map((e) => e.type).join(','));
check('高架通过匝道接入地面路网', c4.net.components === 1, c4.net.components + ' 个连通块');
const deckArc = c4.net.edges.find((e) => e.layer === 1).forwardArc;
const car = c4.traffic.spawnScripted({
  arc: deckArc, lane: 0, dist: 8, type: 'car', originTile: T(10, 14),
  stops: [{ tile: T(12, 13), purpose: 'work', dwell: 0 }], maxSpeed: 1,
});
check('高架上可以生成车辆', !!car);
if (car) {
  for (let i = 0; i < 60; i++) c4.traffic.update(0.25, c4.tick + i);
  check('车辆在高架上行驶', car.dist > 8,
    '行驶 ' + car.dist.toFixed(0) + ' m，速度 ' + car.v.toFixed(1) + ' m/s');
}

// 斜向道路：只按「实际画出来的走向」连通，不会在旁边凭空多出斜向捷径
const c5 = new City({ name: '斜路测试', flat: true });
const diag = [];
for (let i = 0; i < 6; i++) diag.push(T(11 + i, 15 + i));
const cross = [];
for (let x = 6; x <= 20; x++) cross.push(T(x, 14));
c5.buildRoad(diag, 1);
c5.buildRoad(cross, 1);
const diagNodes = c5.net.nodes.filter((n) => n.x >= 11 && n.x <= 16 && n.z >= 15 && n.z <= 20);
check('斜向道路本身连通（不被切碎）', diagNodes.length <= 2, diagNodes.length + ' 个节点');
const fake = c5.net.nodes.filter((n) => n.z === 14 && n.x > 6 && n.x < 20);
check('横路中间没有多出假路口', fake.length === 0, fake.map((n) => n.x).join(','));

console.log(failures ? '\n' + failures + ' 项失败 FAIL' : '\n全部通过 OK');
process.exit(failures ? 1 : 0);
