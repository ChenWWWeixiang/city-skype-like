// ============================================================================
//  车辆仿真实验室：把车流物理拆成 6 个可单独观察的阶段
//    1 单车：启动 -> 巡航 -> 减速 -> 停入车位
//    2 多车：跟驰与排队（车头时距 / 排队长度）
//    3 红绿灯：红灯停车排队、绿灯放行
//    4 变道：前方慢车 -> 换道绕行
//    5 拥堵：瓶颈路段排队回溯（spillback）
//    6 选路：两条路线对比，按实时拥堵自动选更快的一条
//  全部跑的是与正式游戏完全相同的微观车流物理（IDM + 排队 + 路径规划）
// ============================================================================
import { City } from './sim/city.js';
import { MAP, TRAFFIC, TIME } from './sim/constants.js';

const LAB_RATE = 2.5;      // 实验室推进倍率（真实秒 -> 交通秒）
const T = (x, z) => z * MAP.SIZE + x;
const segX = (x0, x1, z) => { const o = []; for (let x = x0; x <= x1; x++) o.push(T(x, z)); return o; };
const segZ = (x, z0, z1) => { const o = []; for (let z = z0; z <= z1; z++) o.push(T(x, z)); return o; };

export const LAB_STAGES = [
  {
    id: 1,
    title: '阶段 1 · 单车：启动 → 巡航 → 减速 → 停入车位',
    desc: '一辆车从道路西端出发，按 IDM 模型加速到自由流速度，接近车位时减速，最后停进车位（车身完全停住并占住车位）。',
    watch: '看车速曲线：起步加速 → 巡航 → 刹车进位',
  },
  {
    id: 2,
    title: '阶段 2 · 多车：跟驰与排队',
    desc: '同一条路上连续放入 6 辆车。后车用 IDM 跟驰保持车头时距，第一辆车停进车位后，后面依次排成一列 —— 这就是排队（queue）的形成。',
    watch: '看「与前车距离」：稳定跟驰时约等于 s0 + v·T',
  },
  {
    id: 3,
    title: '阶段 3 · 红绿灯：停车排队与放行',
    desc: '加入一个带信号灯的十字路口。红灯时车辆在停止线前排队，绿灯时按路口通行能力依次放行，黄灯与全红用于清空路口。',
    watch: '看「信号灯状态」与「排队车辆数」随相位变化',
  },
  {
    id: 4,
    title: '阶段 4 · 变道：绕开前方慢车',
    desc: '右车道前方有一辆低速货车挡路，后车在车速低于自由流 55% 时评估换道，确认目标车道前后都留得下整车后完成变道超车。',
    watch: '看「车道」列：0 → 1 就是一次变道',
  },
  {
    id: 5,
    title: '阶段 5 · 拥堵：瓶颈排队回溯',
    desc: '一条两车道道路被一辆慢车占住一条车道，车流只能挤用剩余车道，队列不断向上游延伸 —— 即「排队回溯 spillback」，平均车速崩塌。',
    watch: '看「排队车辆数」持续上升、平均车速持续下降',
  },
  {
    id: 6,
    title: '阶段 6 · 选路：按实时拥堵自动绕行',
    desc: '南北两条并行路线通往同一个终点，其中一条已经被堵死。路径规划用「当前拥堵下的实际通行时间」做边权，于是车辆自发选择更快的那条。',
    watch: '看「本次路线」与两条路线的拥堵度对比',
  },
];

export class Lab {
  constructor() {
    this.stage = 1;
    this.time = 0;
    this.paused = false;
    this.speed = 1;
    this.acc = 0;
    this.build(1);
  }

  // ---------------------------------------------------------------- 构建
  build(stage) {
    this.stage = Math.max(1, Math.min(6, stage | 0));
    this.time = 0;
    this.acc = 0;
    // 实验室用平地：变量只有「车流」，不受地形坡度干扰
    this.city = new City({ name: '车辆仿真实验室 · 阶段 ' + this.stage, flat: true });
    this.city.speed = 1;
    this.markers = [];
    this.routes = [];
    this.spawnQueue = [];
    this.notes = [];
    switch (this.stage) {
      case 1: this._stage1(); break;
      case 2: this._stage2(); break;
      case 3: this._stage3(); break;
      case 4: this._stage4(); break;
      case 5: this._stage5(); break;
      case 6: this._stage6(); break;
    }
  }

  _parkingSpot(tile, label) {
    this.markers.push({ tile, color: 0x38e08a, label: label || '车位' });
  }
  _obstacle(tile, label) {
    this.markers.push({ tile, color: 0xff5533, label: label || '慢车/占道' });
  }

  _stage1() {
    const c = this.city;
    c.buildRoad(segX(8, 40, 24), 2);                 // 大道（4 车道）
    const parkTile = T(38, 23);
    this._parkingSpot(parkTile);
    const startTile = T(8, 23);
    const arc = c.traffic.tileAccess[startTile];
    c.traffic.spawnScripted({
      arc, lane: 0, dist: 0, type: 'car', originTile: startTile,
      stops: [{ tile: parkTile, purpose: 'park', dwell: 999999 }],
      note: '前往车位',
    });
  }

  _stage2() {
    const c = this.city;
    c.buildRoad(segX(8, 40, 24), 2);                 // 大道（每个方向 2 条车道）
    const parkTile = T(38, 23);
    this._parkingSpot(parkTile);
    const startTile = T(8, 23);
    const arc = c.traffic.tileAccess[startTile];
    // 内侧车道设为公交车道 -> 小汽车只能走外侧车道（右侧通行：车道 0 = 最右 = 外侧）
    // 全局车道号从 0（左）到 N-1（右）；本方向的内侧车道号随 side 而变
    const arcDef = c.traffic.net.arcs[arc];
    const innerGlobal = arcDef.side < 0
      ? Math.floor(arcDef.def.lanes / 2)
      : Math.floor(arcDef.def.lanes / 2) - 1;
    c.setLane(T(20, 24), innerGlobal);
    // 6 辆车排成一列（车头间距 22m）：#1 是前方慢车（最终停进车位），其余 5 辆依次跟驰并排队
    for (let i = 0; i < 6; i++) {
      c.traffic.spawnScripted({
        arc, lane: 0, dist: (5 - i) * 22, type: i === 2 ? 'truck' : 'car', originTile: startTile,
        stops: [{ tile: parkTile, purpose: 'park', dwell: i === 0 ? 999999 : 0 }],
        note: '#' + (i + 1),
        maxSpeed: i === 0 ? 0.12 : 1,
        // 头车最终停在半路并一直占着车道（后面的车只能排队跟驰）
        hold: i === 0 ? 450 : undefined,
      });
    }
    this._obstacle(T(28, 24), '前方慢车');
  }

  _stage3() {
    const c = this.city;
    c.buildRoad(segX(8, 40, 24), 2);                 // 东西向大道
    c.buildRoad(segZ(24, 14, 34), 2);                // 南北向大道 -> 形成信号十字路口
    const parkTile = T(38, 23);
    this._parkingSpot(parkTile);
    const startTile = T(8, 23);
    const arc = c.traffic.tileAccess[startTile];
    // 内侧车道设为公交车道 -> 车流全部挤在外侧车道排队
    c.setLane(T(20, 24), (c.traffic.net.arcs[arc].side < 0 ? 1 : c.traffic.net.arcs[arc].def.lanes - 2));
    for (let i = 0; i < 6; i++) {
      c.traffic.spawnScripted({
        arc, lane: 0, dist: 0, type: 'car', originTile: startTile,
        stops: [{ tile: parkTile, purpose: 'park', dwell: i === 0 ? 999999 : 0 }],
        note: '#' + (i + 1),
      });
    }
  }

  _stage4() {
    const c = this.city;
    c.buildRoad(segX(8, 40, 24), 2);                 // 大道（每个方向 2 条车道）-> 变道更明显
    const parkTile = T(38, 23);
    this._parkingSpot(parkTile);
    const startTile = T(8, 23);
    const arc = c.traffic.tileAccess[startTile];
    // 前车：一辆低速货车（占住右车道）
    const slow = c.traffic.spawnScripted({
      arc, lane: 0, dist: 150, type: 'truck', originTile: startTile,
      stops: [{ tile: parkTile, purpose: 'park', dwell: 999999 }],
      note: '慢车', maxSpeed: 0.3,
    });
    this._obstacle(T(18, 24), '慢车（占右车道）');
    // 后车：紧跟在慢车后面，需要变道绕过
    c.traffic.spawnScripted({
      arc, lane: 0, dist: 95, type: 'car', originTile: startTile,
      stops: [{ tile: parkTile, purpose: 'park', dwell: 999999 }],
      note: '要超车的车',
    });
    this.slowId = slow ? slow.id : 0;
  }

  _stage5() {
    const c = this.city;
    c.buildRoad(segX(8, 40, 24), 2);                 // 大道（每个方向 2 条车道）
    const parkTile = T(38, 23);
    this._parkingSpot(parkTile);
    const startTile = T(8, 23);
    const arc = c.traffic.tileAccess[startTile];
    // 两条车道各有一辆慢车，开到 260m 处后永久占道 -> 整条路被卡死
    // -> 队列必然向上游回溯（hold 的车一直留在车道里，后车会真的被挡住）
    for (let l = 0; l < 2; l++) {
      c.traffic.spawnScripted({
        arc, lane: l, dist: 240, type: 'truck', originTile: startTile,
        stops: [{ tile: parkTile, purpose: 'park', dwell: 999999 }],
        note: '占道慢车', maxSpeed: 0.25, hold: 262,
      });
    }
    this._obstacle(T(30, 24), '瓶颈（占一条车道）');
    // 持续放车进入 -> 队列不断增长并向上游回溯
    this.spawnQueue = { t: 0, every: 2.2 };
  }

  _stage6() {
    // 阶段 6 专门演示「动态绕行」：把选路方式切成 adaptive
    if (this.city) this.city.settings.routing = 'adaptive';
    const c = this.city;
    c.buildRoad(segX(8, 40, 16), 2);                 // 北线
    c.buildRoad(segX(8, 40, 32), 1);                 // 南线（窄一点，更容易堵）
    c.buildRoad(segZ(8, 16, 32), 2);                 // 西侧连接
    c.buildRoad(segZ(40, 16, 32), 2);                // 东侧连接
    const startTile = T(9, 24);
    const endTile = T(39, 24);
    this._parkingSpot(endTile, '终点');
    // 南线放一堆车把它堵死
    const arcS = c.traffic.tileAccess[T(9, 31)];
    for (let i = 0; i < 26; i++) {
      c.traffic.spawnScripted({
        arc: arcS, lane: i % 2, dist: 40 + i * 11, type: i % 3 === 0 ? 'truck' : 'car',
        originTile: T(9, 31), maxSpeed: 0.02,
        stops: [{ tile: T(9, 31), purpose: 'park', dwell: 999999 }],
        note: '堵车',
      });
    }
    this._obstacle(T(20, 32), '南线拥堵');
    this.routes = [
      { name: '北线', tiles: segX(9, 39, 16) },
      { name: '南线', tiles: segX(9, 39, 32) },
    ];
    // 决策车：等南线堵死之后再出发
    this.decision = { t: 0, at: 14, sent: false };
  }

  // ---------------------------------------------------------------- 步进
  step(dtReal) {
    if (this.paused) return;
    // 实验室用真实时间的 2.5 倍推进：车速 ~27 m/s，屏幕上是连续可读的运动
    const gameSeconds = Math.min(1.2, dtReal * this.speed * LAB_RATE);
    this.time += gameSeconds;
    const c = this.city;
    const tr = c.traffic;

    // 阶段 5：持续放车
    if (this.spawnQueue) {
      this.spawnQueue.t += gameSeconds;
      while (this.spawnQueue.t >= this.spawnQueue.every) {
        this.spawnQueue.t -= this.spawnQueue.every;
        const arc = tr.tileAccess[T(8, 23)];
        tr.spawnScripted({
          arc, lane: 0, dist: 0, type: 'car', originTile: T(8, 23),
          stops: [{ tile: T(38, 23), purpose: 'park', dwell: 0 }],
          note: '入城',
        });
      }
    }
    // 阶段 6：南线堵死后放出决策车
    if (this.decision && !this.decision.sent) {
      this.decision.t += gameSeconds;
      if (this.decision.t >= this.decision.at) {
        this.decision.sent = true;
        const arc = tr.tileAccess[T(9, 24)];
        const veh = tr.spawnScripted({
          arc, lane: 0, dist: 0, type: 'car', originTile: T(9, 24),
          stops: [{ tile: T(39, 24), purpose: 'work', dwell: 999999 }],
          note: '决策车',
        });
        this.decisionCarId = veh ? veh.id : 0;
      }
    }

    // 物理推进（与正式游戏同一套微观仿真）
    const steps = Math.max(1, Math.round(gameSeconds / TIME.TRAFFIC_DT));
    const dt = gameSeconds / steps;
    for (let i = 0; i < steps; i++) tr.update(dt, this.time);
    // 定期统计路段拥堵（选路与效率都依赖它）
    this._sampleAcc = (this._sampleAcc || 0) + gameSeconds;
    if (this._sampleAcc >= TRAFFIC.SAMPLE_CONGESTION) {
      this._sampleAcc = 0;
      tr.sample();
    }
  }

  // ---------------------------------------------------------------- 遥测
  telemetry() {
    const c = this.city;
    const tr = c.traffic;
    const meta = LAB_STAGES.find((s) => s.id === this.stage) || LAB_STAGES[0];
    const cars = [];
    let sumV = 0, moving = 0, stopped = 0, queued = 0;
    for (const v of tr.vehicles) {
      const arc = tr.net.arcs[v.arc];
      const leader = arc ? tr._nearestAhead(arc.laneVehicles[v.lane], v.dist) : null;
      const gap = leader ? leader.dist - v.dist - leader.len : null;
      const kmh = v.v * 3.6;
      // 是否正在红灯前等待
      let waitingLight = false;
      const isLast = v.pathIdx >= v.path.length - 1;
      if (!isLast && arc) {
        const next = tr.net.arcs[v.path[v.pathIdx + 1]];
        const node = tr.net.nodes[arc.to];
        if (node && node.hasSignal && !tr._canGo(node, arc, next)) waitingLight = true;
      }
      if (v.parked || v.dwell > 0) {
        // 已停靠 / 停入车位
      } else if (v.v > 0.5) { sumV += v.v; moving++; } else { stopped++; }
      // 排队判定：跟车距离很近（无论是否完全停住）都算在队列里
      if (!v.parked && v.dwell <= 0 && gap !== null && gap < 25 && v.v < 6) queued++;
      cars.push({
        id: v.id,
        note: v.note || '',
        speed: +kmh.toFixed(1),
        lane: v.lane,
        gap: gap === null ? null : +gap.toFixed(1),
        wait: +v.wait.toFixed(1),
        state: (v.parked || v.dwell > 0) ? '已停靠' : (waitingLight ? '等红灯'
          : (v.v < 0.5 ? (gap !== null && gap < 30 ? '排队' : '停车') : '行驶')),
        light: waitingLight,
      });
    }
    // 信号灯状态
    const sig = tr.net.nodes.find((n) => n.hasSignal);
    const signal = sig ? { state: sig.signal.state, phase: sig.signal.phase, t: +sig.signal.t.toFixed(1) } : null;
    // 各条路线的拥堵
    const routes = this.routes.map((r) => {
      let sum = 0, n = 0;
      for (const ti of r.tiles) {
        const eid = c.net.tileEdge[ti];
        if (eid < 0) continue;
        sum += c.net.edges[eid].congestion; n++;
      }
      return { name: r.name, congestion: n ? +(sum / n).toFixed(2) : 0 };
    });
    // 决策车走的路线（用经过的地块近似）
    let chosen = null;
    if (this.decisionCarId) {
      const v = tr.vehicles.find((x) => x.id === this.decisionCarId);
      if (v) {
        const arc = tr.net.arcs[v.arc];
        if (arc) {
          const edge = c.net.edges[arc.edge];
          let k = Math.max(0, Math.min(edge.tiles.length - 1, Math.floor(v.dist / MAP.TILE)));
          if (arc.dir === -1) k = edge.tiles.length - 1 - k;
          const tile = edge.tiles[k];
          const z = Math.floor(tile / MAP.SIZE);
          chosen = z < 24 ? '北线' : '南线';
        }
      }
    }
    return {
      stage: this.stage,
      title: meta.title,
      desc: meta.desc,
      watch: meta.watch,
      paused: this.paused,
      speed: this.speed,
      cars,
      signal,
      routes,
      chosen,
      markers: this.markers,
      stats: {
        total: tr.vehicles.length,
        moving,
        stopped,
        queued,
        avgSpeed: moving ? +(sumV / moving * 3.6).toFixed(1) : 0,
        congestion: +(tr.stats.congestion || 0).toFixed(1),
      },
    };
  }
}

export const lab = new Lab();
