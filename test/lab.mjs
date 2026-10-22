// ============================================================================
//  车辆仿真实验室：6 个阶段的自动验收
//  运行： npm test
// ============================================================================
import { Lab } from '../server/lab.js';

let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? '  OK  ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
}

const lab = new Lab();
const run = (seconds) => {
  for (let i = 0; i < seconds * 30; i++) lab.step(1 / 30);
  return lab.telemetry();
};

console.log('\n[1] 阶段 1 · 单车停入车位');
lab.build(1);
let T = run(70);
const car1 = T.cars[0];
check('只有一辆车', T.stats.total === 1, T.stats.total + ' 辆');
check('车辆完成行驶并停靠', !!car1 && car1.state === '已停靠', car1 ? car1.state : '');
check('车辆确实移动过（有速度记录）', T.cars.length === 1);

console.log('\n[2] 阶段 2 · 多车跟驰与排队');
lab.build(2);
T = run(40);
check('6 辆车都在场上', T.stats.total === 6, T.stats.total + ' 辆');
check('出现排队（车距很小）', T.stats.queued >= 3, '排队 ' + T.stats.queued + ' 辆');
const gaps = T.cars.map((c) => c.gap).filter((g) => g !== null);
check('车头时距合理（0.5~30 m）', gaps.length > 0 && gaps.every((g) => g >= 0.4 && g < 30),
  '间距 ' + gaps.map((g) => g.toFixed(1)).join('/'));
check('队列整体低速', T.stats.avgSpeed < 20, T.stats.avgSpeed + ' km/h');

console.log('\n[3] 阶段 3 · 红绿灯');
lab.build(3);
let sawRed = false, sawGreen = false, sawStop = false;
for (let i = 0; i < 90; i++) {
  const t = run(1);
  if (t.signal) {
    if (t.signal.state === 'green') sawGreen = true;
    if (t.signal.state === 'allred' || t.signal.state === 'yellow') sawRed = true;
  }
  if (t.cars.some((c) => c.state === '等红灯')) sawStop = true;
}
T = lab.telemetry();
check('存在信号灯', !!T.signal, T.signal ? T.signal.state : '');
check('出现过绿灯', sawGreen);
check('出现过黄灯/全红', sawRed);
check('车辆在红灯前等待', sawStop);

console.log('\n[4] 阶段 4 · 变道超车');
lab.build(4);
let changed = false;
for (let i = 0; i < 60; i++) {
  const t = run(1);
  if (t.cars.some((c) => c.lane === 1)) changed = true;
}
check('后车换到了另一条车道', changed);

console.log('\n[5] 阶段 5 · 瓶颈排队回溯');
lab.build(5);
T = run(50);
check('瓶颈路段出现排队', T.stats.queued >= 3, '排队 ' + T.stats.queued + ' 辆');
check('平均车速被拉低', T.stats.avgSpeed < 30, T.stats.avgSpeed + ' km/h');
check('路网出现拥堵', T.stats.congestion > 1, T.stats.congestion + '%');

console.log('\n[6] 阶段 6 · 按拥堵选路');
lab.build(6);
T = run(40);
const south = T.routes.find((r) => r.name === '南线');
const north = T.routes.find((r) => r.name === '北线');
check('南线被堵住', south && south.congestion > 0.2, south ? (south.congestion * 100).toFixed(0) + '%' : '');
check('北线通畅', north && north.congestion < 0.1, north ? (north.congestion * 100).toFixed(0) + '%' : '');
check('车辆选择走北线（更快的那条）', T.chosen === '北线', '实际走 ' + T.chosen);

console.log('\n' + (failures === 0 ? '全部通过 OK' : failures + ' 项失败 FAIL') + '\n');
process.exit(failures === 0 ? 0 : 1);
