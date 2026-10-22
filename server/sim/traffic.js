// ============================================================================
//  微观车流仿真
//  - IDM (Intelligent Driver Model) 跟驰
//  - 多车道 + 换道 (MOBIL-lite)
//  - 交叉口容量控制 -> 排队溢出 (spillback) -> 真实拥堵
//  - 拥堵感知的 Dijkstra 路径规划
// ============================================================================
import {
  MAP, TRAFFIC, hash2, SIGNAL, ELEV, LANE_TYPES, TRIP, SERVICE_DISPATCH, SERVICES,
  DEMOGRAPHY, SERVICE_FLEET,
} from './constants.js';
import { polyPoint } from './roadnet.js';

/** 简易二叉堆 */
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a; a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].d <= a[i].d) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].d < a[m].d) m = l;
        if (r < a.length && a[r].d < a[m].d) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

let VEHICLE_SEQ = 1;

export class TrafficSim {
  constructor(city) {
    this.city = city;
    this.net = null;
    this.vehicles = [];
    this.pendingTrips = 0;
    this.nextSpawn = 0;
    // ---- 交通时钟（与城市经济时钟解耦）---------------------------------
    // t  : 交通秒。1 交通小时 = TRAFFIC.SEC_PER_HOUR 交通秒
    // hour: 当前交通小时（0..23），用于生成出行需求（早晚高峰）
    // 起始定在早高峰 8 点：一打开城市就有车流，而不是空城等 15 分钟
    this.t = TRAFFIC.SEC_PER_HOUR * 8;
    this.hour = 8;
    this._tripHour = -1;          // -1 => 第一帧 update() 就会生成出行需求
    this.tripRate = 0;          // 每交通秒新发出的车辆数
    this.stats = {
      vehicles: 0, moving: 0, jammed: 0, avgSpeed: 0,
      congestion: 0, travelIndex: 0, unreachable: 0, dropped: 0,
      arrived: 0, avgTripTime: 0, totalTrips: 0,
    };
    this._tripSamples = [];
    // ---- 车队（守恒）：车只在家里的车位诞生，只有「驶出城市」与「报废」才消失 ----
    // garage: 家住地块 -> 该户的车数（停在车位里的车不上路，不参与仿真，省 CPU）
    this.garage = new Map();
    this.garageTiles = [];        // 有车的地块列表（快速随机取车）
    this.specials = [];            // 特种车辆（随特种建筑诞生，常驻车站）
    this.fleet = { cars: 0, trucks: 0, bikes: 0, special: 0, total: 0, scrapped: 0, arrived: 0 };
    this._heap = new MinHeap();
    this._dist = null;
    this._prev = null;
    this._nextArc = null;
    this._visited = null;
    this._nodeStamp = 0;
  }

  /** 路网变化后重建索引 */
  rebuild(net) {
    this.net = net;
    const N = net.nodes.length;
    this._dist = new Float64Array(N);
    this._prev = new Int32Array(N);
    this._nextArc = new Int32Array(N);
    this._visited = new Int32Array(N);
    // 保留仍在网络上的车辆，丢弃失效车辆
    this.vehicles = this.vehicles.filter((veh) => veh.arc < net.arcs.length);
    for (const veh of this.vehicles) {
      const arc = net.arcs[veh.arc];
      veh.lane = Math.min(veh.lane, arc.lanes - 1);
      arc.laneVehicles[veh.lane].push(veh);
      arc.vehicles.push(veh);
    }
    this._recomputeTileAccess();
    // 路网通行能力（辆/交通秒）：约每 25km 单向车道可承载 1 辆/秒的稳态流量
    let laneM = 0;
    for (const a of net.arcs) laneM += a.length * a.lanes;
    this.capacityRate = laneM / 25000;
    this.computeParkedCars();
  }

  _recomputeTileAccess() {
    const city = this.city, net = this.net;
    const S = MAP.SIZE;
    this.tileAccess = new Int32Array(S * S).fill(-1);
    this.tileAccessDist = new Float32Array(S * S);
    this.tileAccessNode = new Int32Array(S * S).fill(-1);
    this.tileAccessOffset = new Float32Array(S * S);   // 接入道路格沿边段的偏移
    for (let i = 0; i < S * S; i++) {
      const t = city.tiles[i];
      if (!t || t.road) continue;
      // 找相邻道路瓦片
      const x = i % S, z = (i / S) | 0;
      let found = -1;
      const nb = [[x, z - 1], [x + 1, z], [x, z + 1], [x - 1, z]];
      for (const [nx, nz] of nb) {
        if (nx < 0 || nz < 0 || nx >= S || nz >= S) continue;
        const ni = nz * S + nx;
        if (city.tiles[ni].road) { found = ni; break; }
      }
      if (found < 0) continue;
      const edgeId = net.tileEdge[found];
      if (edgeId < 0) continue;
      const edge = net.edges[edgeId];
      const forwardArc = edge.forwardArc, backwardArc = edge.backwardArc;
      const offset = net.tileOffset[found];
      // 取"离该地块更近"的方向作为默认行驶方向
      const arc = forwardArc;
      this.tileAccess[i] = arc;
      this.tileAccessDist[i] = Math.min(offset, edge.length - offset);
      this.tileAccessNode[i] = net.arcs[arc].to;
      this.tileAccessOffset[i] = offset;
    }
  }

  /** 生成出行需求（每小时调用） */
  generateTrips(hour) {
    const city = this.city;
    const w = TRAFFIC.HOUR_WEIGHTS[hour % 24];
    const daily = (city.stats.population || 0) * TRAFFIC.TRIPS_PER_RESIDENT_DAY +
                  (city.stats.jobs || 0) * TRAFFIC.TRIPS_PER_JOB_DAY;
    // HOUR_WEIGHTS 的 24 小时均值约 1.0375，除以它可让全天平均出行量 = daily
    // 需求曲线压缩：夜间 0.22x / 平峰 0.9x / 早高峰 1.8x（相对全天均值）
    const f = 0.15 + 1.65 * Math.pow(w / 3, 0.75);
    let rate = (daily / TRAFFIC.DAY_SEC) * f;
    // 安全阀：出行需求不能超过路网本身的通行能力（否则人口一多就全城死锁）。
    // 超出部分记入 demandOverflow，UI 上能看到「需求溢出」而不是默默堵死。
    const cap = this.capacityRate || 0;
    if (cap > 0 && rate > cap) {
      this.stats.demandOverflow = (this.stats.demandOverflow || 0) + (rate - cap) * TRAFFIC.SEC_PER_HOUR;
      rate = cap;
    }
    this.tripRate = rate;
    this.pendingTrips += rate * TRAFFIC.SEC_PER_HOUR;
    this.stats.totalTrips = (this.stats.totalTrips || 0) + rate * TRAFFIC.SEC_PER_HOUR;
  }

  /**
   * 确保出行强度已初始化。
   * 新建城市 / 从存档读档后 tripRate 仍是 undefined，
   * 在第一个整点到来之前不会有任何市民车辆 —— 这里按当前时段补一次。
   */
  ensureTripRate(hour) {
    if (!this.tripRate) {
      this.generateTrips(hour === undefined ? this.hour : hour);
      return true;
    }
    return false;
  }

  /** 车辆外形参数（普通车 + 特种车） */
  _vehDef(typeName) {
    return TRAFFIC.VEHICLE_TYPES[typeName] || TRAFFIC.SPECIAL_TYPES[typeName] || TRAFFIC.VEHICLE_TYPES.car;
  }

  /**
   * 重力模型挑选目的地：吸引力(岗位/人口) / 出行阻抗(距离^2)
   * 同时尽量避开与起点同一个路口（同一路口没有可行驶路径）
   */
  _pickGravity(arr, fromTile) {
    if (!arr || !arr.length) return undefined;
    const city = this.city;
    const acc = this.tileAccess || [];
    const fromNode = (fromTile >= 0 && this.tileAccessNode) ? this.tileAccessNode[fromTile] : -1;
    // 按「吸引力 ^0.4 / 距离阻抗」加权随机挑一个目的地。
    // 早期版本直接取 argmax，结果全城车流涌向少数几个大地块，
    // 那几条路瞬间被塞满 -> 排队回溯 -> 全城堵死。
    // 加权随机保留「大中心更吸引人」的真实倾向，同时把流量摊开。
    const cands = [];
    let total = 0;
    const CAND = 12;
    let fallback = undefined;
    for (let k = 0; k < CAND; k++) {
      const cand = arr[(Math.random() * arr.length) | 0];
      if (acc[cand] < 0) continue;
      if (fallback === undefined) fallback = cand;
      if (fromNode >= 0 && this.tileAccessNode && this.tileAccessNode[cand] === fromNode) continue;
      const dx = (cand % MAP.SIZE) - (fromTile % MAP.SIZE);
      const dz = Math.floor(cand / MAP.SIZE) - Math.floor(fromTile / MAP.SIZE);
      const dist = Math.sqrt(dx * dx + dz * dz);
      const attract = (city.tiles[cand].jobs || city.tiles[cand].pop || 1);
      const w = Math.pow(attract, 0.4) / (18 + dist * 1.4);
      cands.push({ cand, w });
      total += w;
    }
    if (!cands.length) return fallback;
    let r = Math.random() * total;
    for (const c of cands) { r -= c.w; if (r <= 0) return c.cand; }
    return cands[cands.length - 1].cand;
  }

  /** 沿指定弧计算某地块接入点的位置 */
  _offsetOnArc(arcId, tile) {
    const net = this.net;
    const arc = net.arcs[arcId];
    if (!arc) return 0;
    const edge = net.edges[arc.edge];
    const off = this.tileAccessOffset[tile] || 0;
    return (arcId === edge.forwardArc) ? off : edge.length - off;
  }

  /** 道路格在弧上的位置（道路格没有接入偏移，用路段自身的偏移） */
  _roadOffsetOnArc(arcId, tile) {
    const net = this.net;
    const arc = net.arcs[arcId];
    if (!arc) return 0;
    const edge = net.edges[arc.edge];
    const off = net.tileOffset[tile] || 0;
    return (arcId === edge.forwardArc) ? off : (edge.length - off);
  }

  /** 拥堵感知的最短路（Dijkstra） */
  findPath(fromNode, toNode) {
    if (fromNode === toNode) {
      this.stats.sameNode = (this.stats.sameNode || 0) + 1;
      return [];
    }
    const net = this.net, nodes = net.nodes;
    const dist = this._dist, prev = this._prev, nextArc = this._nextArc, visited = this._visited;
    const stamp = ++this._nodeStamp;
    const heap = this._heap; heap.a.length = 0;
    dist[fromNode] = 0; prev[fromNode] = -1; nextArc[fromNode] = -1; visited[fromNode] = stamp;
    heap.push({ d: 0, n: fromNode });
    let found = false;
    let guard = 0;
    while (heap.size && guard++ < 20000) {
      const cur = heap.pop();
      if (cur.n === toNode) { found = true; break; }
      if (cur.d > dist[cur.n] + 1e-9) continue;
      const node = nodes[cur.n];
      for (const arcId of node.arcs) {
        const arc = net.arcs[arcId];
        const v0 = arc.v0 * (1 - 0.75 * arc.congestion);
        const travel = arc.length / Math.max(2.5, v0);
        const nd = dist[cur.n] + travel;
        if (visited[arc.to] === stamp && dist[arc.to] <= nd) continue;
        visited[arc.to] = stamp;
        dist[arc.to] = nd; prev[arc.to] = cur.n; nextArc[arc.to] = arcId;
        heap.push({ d: nd, n: arc.to });
      }
    }
    if (!found) {
      this.stats.noRoute = (this.stats.noRoute || 0) + 1;
      this.stats.lastFail = fromNode + '->' + toNode + ' nodes=' + net.nodes.length;
      return null;
    }
    const path = [];
    let n = toNode;
    while (n !== fromNode) {
      const a = nextArc[n];
      if (a < 0) return null;
      path.push(a);
      n = prev[n];
      if (path.length > TRAFFIC.MAX_PATH_NODES) return null;
    }
    path.reverse();
    return path;
  }

  /**
   * 发车：从「车库」取一辆已经属于这座城的车上路，并安排完整行程：
   *   市民：家 -> 上班 -> 购物 -> 家
   *   货车：工业区 -> 商业区送货 -> 回仓库
   *
   * 关键：车不会凭空出现。它必须先存在于某个家庭的车库里（由人口 / 购车产生），
   * 然后才开出门；到家后重新停回车库，车队数量始终守恒。
   */
  spawnVehicle() {
    if (this.vehicles.length >= TRAFFIC.MAX_VEHICLES) { this.stats.dropped++; return false; }
    const city = this.city;
    // 约 14% 的出行是货车配送，其余是居民开车
    const wantTruck = Math.random() < TRAFFIC.TRUCK_RATIO;
    const home = wantTruck ? this._pickGarageTile('truck') : this._pickGarageTile('car');
    if (home === undefined) {
      // 车库空 = 没有车可用（城市还很小 / 车都出门了）-> 这次出行取消
      this.stats.noTrip = (this.stats.noTrip || 0) + 1;
      return false;
    }
    const typeName = wantTruck ? 'truck' : (Math.random() < TRAFFIC.BIKE_RATIO ? 'bike' : 'car');
    const type = this._vehDef(typeName);
    const oArc = this.tileAccess[home];
    if (oArc === undefined || oArc < 0) {
      this.stats.unreachable++; this.stats.noAccess = (this.stats.noAccess || 0) + 1;
      return false;
    }
    const veh = {
      id: VEHICLE_SEQ++,
      type: typeName,
      typeId: type.id,
      len: type.len,
      width: type.width,
      arc: oArc,
      lane: 0,
      dist: this.tileAccessOffset[home] || 0,
      v: 0,
      path: [], pathIdx: 0,
      stops: [], stop: null, dwell: 0, parked: false,
      purpose: '', destOffset: undefined,
      originTile: home, destTile: home,
      born: 0, wait: 0, tripTime: 0,
      x: 0, z: 0, y: 0, heading: 0, grade: 0,
      homeTile: home,          // 家（车库所在地）
      state: 'driving',
    };
    veh.stops = this._buildItinerary(veh, home, wantTruck ? 'freight' : 'citizen');
    if (!veh.stops.length) { this.stats.noTrip = (this.stats.noTrip || 0) + 1; return false; }
    veh.stop = veh.stops[0];
    if (!this._planLeg(veh)) { this.stats.noPath = (this.stats.noPath || 0) + 1; return false; }
    const arc = this.net.arcs[veh.arc];
    // 找一个车身不与其它车重叠的位置（真实车流里绝不会凭空叠车）
    const place = this._placeInArcNear(arc, veh, typeName, this.tileAccessOffset[home] || 0);
    if (!place) {
      // 门口停满了 -> 这次出行取消（车留在车库）
      this.stats.noSpace = (this.stats.noSpace || 0) + 1;
      return false;
    }
    veh.lane = place.lane;
    veh.dist = place.dist;
    veh.v = type.speedFactor * arc.v0 * 0.5;
    arc.laneVehicles[veh.lane].push(veh);
    arc.vehicles.push(veh);
    this.vehicles.push(veh);
    this._takeFromGarage(home, wantTruck ? 'truck' : 'car');
    this.stats.spawned = (this.stats.spawned || 0) + 1;
    return true;
  }

  // ------------------------------------------------------------ 车库（车队守恒）
  /**
   * 往某户的车库里放一台车。
   * 只有「新车的存在被解释」时才会增加车队规模：家庭购车、移民开车进城、特种建筑配车。
   */
  _addToGarage(tile, kind) {
    const key = kind === 'truck' ? 'trucks' : 'cars';
    let e = this.garage.get(tile);
    if (!e) { e = { cars: 0, trucks: 0 }; this.garage.set(tile, e); this.garageTiles.push(tile); }
    e[key]++;
    this.fleet[key]++;
    this.fleet.total++;
    return true;
  }

  /** 从车库取走一台车（开出家门）——车队规模不变，只是从车位挪到路上 */
  _takeFromGarage(tile, kind) {
    const key = kind === 'truck' ? 'trucks' : 'cars';
    const e = this.garage.get(tile);
    if (!e) return false;
    e[key]--;
    if (e.cars <= 0 && e.trucks <= 0) {
      this.garage.delete(tile);
      const k = this.garageTiles.indexOf(tile);
      if (k >= 0) this.garageTiles.splice(k, 1);
    }
    return true;
  }

  /** 车回家：重新停回车库（车队数量不变，只是从「在路上」变成「在车位上」） */
  _returnToGarage(veh, tile, kind) {
    const t = (tile === undefined || tile < 0) ? veh.homeTile : tile;
    if (t === undefined || t < 0) return;
    const key = kind === 'truck' ? 'trucks' : 'cars';
    let e = this.garage.get(t);
    if (!e) { e = { cars: 0, trucks: 0 }; this.garage.set(t, e); this.garageTiles.push(t); }
    e[key]++;
  }

  /** 随机挑一个有车的家庭（车库里有车） */
  _pickGarageTile(kind) {
    const key = kind === 'truck' ? 'trucks' : 'cars';
    if (!this.garageTiles.length) return undefined;
    for (let k = 0; k < 6; k++) {
      const idx = (Math.random() * this.garageTiles.length) | 0;
      const tile = this.garageTiles[idx];
      const e = this.garage.get(tile);
      if (e && e[key] > 0 && this.tileAccess[tile] >= 0) return tile;
    }
    return undefined;
  }

  /**
   * 车队规模跟随人口：人口增加 -> 家庭购车（车在家里的车位诞生）；
   * 人口减少 -> 老车报废。车队数量只在有明确原因时变化。
   */
  syncFleet() {
    const city = this.city;
    const pop = city.demography ? (city.demography.housed || 0) : (city.stats.population || 0);
    const carTarget = Math.ceil(pop / DEMOGRAPHY.PEOPLE_PER_CAR);
    const truckTarget = Math.ceil((city.stats.indJobs || 0) / 16);
    let guard = 0;
    // 购车：放在住宅地块（那里才有停车位）
    while (this.fleet.cars < carTarget && guard++ < 24) {
      const tile = this._pickGravity(city.residentialTiles, -1);
      if (tile === undefined) break;
      if (this.tileAccess[tile] < 0) continue;
      this._addToGarage(tile, 'car');
    }
    guard = 0;
    while (this.fleet.trucks < truckTarget && guard++ < 10) {
      const tile = this._pickGravity(city.industrialTiles, -1);
      if (tile === undefined) break;
      if (this.tileAccess[tile] < 0) continue;
      this._addToGarage(tile, 'truck');
    }
    // 报废：人口减少时老车退出车队
    guard = 0;
    while (this.fleet.cars > carTarget * 1.5 + 3 && this.garageTiles.length && guard++ < 16) {
      const idx = (Math.random() * this.garageTiles.length) | 0;
      const tile = this.garageTiles[idx];
      const e = this.garage.get(tile);
      if (!e || e.cars <= 0) { guard++; continue; }
      e.cars--; this.fleet.cars--; this.fleet.total--; this.fleet.scrapped++;
      if (e.cars <= 0 && e.trucks <= 0) {
        this.garage.delete(tile);
        this.garageTiles.splice(idx, 1);
      }
    }
  }

  /**
   * 特种建筑诞生 -> 对应的特种车辆同时诞生（并停在车库里待命）。
   * 返回新生的车辆数量（用于提示文案）。
   */
  onServiceBuilt(tileIdx, serviceId) {
    const plan = SERVICE_FLEET[serviceId];
    if (!plan) return 0;
    let born = 0;
    for (const p of plan) {
      const type = this._vehDef(p.type);
      for (let k = 0; k < p.count; k++) {
        const veh = {
          id: VEHICLE_SEQ++, type: p.type, typeId: type.id, len: type.len, width: type.width,
          arc: -1, lane: 0, dist: 0, v: 0,
          path: [], pathIdx: 0, stops: [], stop: null, dwell: 0, parked: false,
          purpose: 'service', destOffset: undefined,
          originTile: tileIdx, destTile: tileIdx, serviceTile: tileIdx,
          born: 0, wait: 0, tripTime: 0, x: 0, z: 0, y: 0, heading: 0, grade: 0,
          homeTile: tileIdx, state: 'garaged', onDuty: false,
        };
        this.specials.push(veh);
        this.fleet.special++;
        this.fleet.total++;
        born++;
      }
    }
    return born;
  }

  /** 特种建筑被拆 -> 它的特种车辆随之消失（车队守恒） */
  onServiceRemoved(tileIdx) {
    const keep = [];
    for (const v of this.specials) {
      if (v.serviceTile === tileIdx) {
        this.fleet.special--;
        this.fleet.total--;
        // 正在路上的那辆也要从路网里撤掉
        const idx = this.vehicles.indexOf(v);
        if (idx >= 0) { this._removeFromArc(v, this.net.arcs[v.arc]); this.vehicles.splice(idx, 1); }
      } else keep.push(v);
    }
    this.specials = keep;
  }

  /** 取一辆在车站待命的特种车辆（没有车 -> 事件只能干等着） */
  _takeSpecialVehicle(typeName, serviceTile) {
    for (const v of this.specials) {
      if (v.type !== typeName) continue;
      if (v.onDuty) continue;
      if (serviceTile !== undefined && v.serviceTile !== serviceTile) continue;
      v.onDuty = true;
      return v;
    }
    return null;
  }

  /** 特种车辆回站待命 */
  _specialHome(veh) {
    veh.onDuty = false;
    veh.state = 'garaged';
    veh.dwell = 0;
    veh.parked = false;
    const idx = this.vehicles.indexOf(veh);
    if (idx >= 0) { this._removeFromArc(veh, this.net.arcs[veh.arc]); this.vehicles.splice(idx, 1); }
  }

  /**
   * 在路段上为新车找一个「不与任何车辆重叠」的位置。
   * 车道内按车身长度 + 保险杠间距切分，找最大的空隙；
   * 找不到空隙说明这条路已经排满 -> 放弃本次发车（而不是叠车）。
   */
  _placeInArc(arc, veh, typeName) {
    return this._placeInArcNear(arc, veh, typeName, undefined);
  }

  /**
   * 与 _placeInArc 相同，但可以指定「期望位置」（比如高速出入口）。
   * 不给 preferDist 时就是经典的「找最大的空隙」。
   */
  _placeInArcNear(arc, veh, typeName, preferDist) {
    const need = veh.len + TRAFFIC.BODY_GAP + TRAFFIC.BODY_PAD;
    let bestLane = -1, bestDist = -1, bestScore = -Infinity;
    for (let l = 0; l < arc.lanes; l++) {
      const lt = (arc.laneTypes || [])[l] || 0;
      if (!this._laneAllowed(lt, typeName)) continue;
      const list = arc.laneVehicles[l];
      // 车道内车辆按位置排序，扫描所有空隙
      const sorted = list.length ? list.slice().sort((a, b) => a.dist - b.dist) : [];
      let cursor = 0;
      const consider = (gap, start) => {
        if (gap < need) return;
        const center = start + (gap - need) / 2;
        // 有期望位置时选「离它最近」的空隙，否则选最大的空隙
        const score = preferDist === undefined ? gap : -Math.abs(center - preferDist);
        if (score > bestScore) { bestScore = score; bestLane = l; bestDist = center; }
      };
      for (const o of sorted) {
        consider(o.dist - cursor, cursor);
        cursor = Math.max(cursor, o.dist + o.len + TRAFFIC.BODY_GAP);
      }
      consider(arc.length - 2 - cursor, cursor);
    }
    if (bestLane < 0) return null;
    return { lane: bestLane, dist: bestDist };
  }

  /** 该路段是否还有能塞下一辆车的空位 */
  _hasFreeSpot(arc, len, typeName) {
    if (!arc) return false;
    const need = len + TRAFFIC.BODY_GAP + TRAFFIC.BODY_PAD;
    for (let l = 0; l < arc.lanes; l++) {
      const lt = (arc.laneTypes || [])[l] || 0;
      if (!this._laneAllowed(lt, typeName)) continue;
      const list = arc.laneVehicles[l];
      let cursor = 0;
      const sorted = list.length ? list.slice().sort((a, b) => a.dist - b.dist) : [];
      for (const o of sorted) {
        if (o.dist - cursor >= need) return true;
        cursor = Math.max(cursor, o.dist + o.len + TRAFFIC.BODY_GAP);
      }
      if (arc.length - 2 - cursor >= need) return true;
    }
    return false;
  }

  /**
   * 脚本化发车（实验室 / 演示用）：
   * 指定路段、车道、起点与行程站点，精确控制每一辆车的行为。
   */
  spawnScripted(opts) {
    const net = this.net;
    const arc = net.arcs[opts.arc];
    if (!arc) return null;
    const type = this._vehDef(opts.type || 'car');
    const veh = {
      id: VEHICLE_SEQ++,
      type: opts.type || 'car',
      typeId: type.id,
      len: type.len,
      width: type.width,
      arc: opts.arc,
      lane: Math.max(0, Math.min(arc.lanes - 1, opts.lane || 0)),
      dist: opts.dist || 0,
      v: opts.v || 0,
      path: [], pathIdx: 0,
      stops: [], stop: null, dwell: 0, parked: false,
      purpose: '', destOffset: undefined,
      originTile: opts.originTile === undefined ? -1 : opts.originTile,
      destTile: opts.originTile === undefined ? -1 : opts.originTile,
      born: 0, wait: 0, tripTime: 0,
      x: 0, z: 0, y: 0, heading: 0, grade: 0,
      note: opts.note || '',
      noDespawn: !!opts.noDespawn,
      maxSpeed: opts.maxSpeed === undefined ? 1 : opts.maxSpeed,
      holdDist: opts.hold === undefined ? undefined : opts.hold,
    };
    veh.stops = (opts.stops || []).map((s) => ({
      tile: s.tile, purpose: s.purpose || 'work', dwell: s.dwell || 0,
    }));
    if (!veh.stops.length) return null;
    veh.stop = veh.stops[0];
    if (!this._planLeg(veh)) return null;
    if (opts.dist === undefined) {
      const place = this._placeInArc(arc, veh, veh.type);
      if (!place) return null;
      veh.lane = place.lane;
      veh.dist = place.dist;
    }
    arc.laneVehicles[veh.lane].push(veh);
    arc.vehicles.push(veh);
    this.vehicles.push(veh);
    this.stats.spawned = (this.stats.spawned || 0) + 1;
    return veh;
  }

  /**
   * 外来移民车：城市人口唯一的「外部来源」。
   * 车从高速出入口开进来，车上的人（1~4 人）随车抵达新家后成为城市居民。
   * 没有出入口的城市 -> 没有人来 -> 人口不会凭空增长。
   */
  spawnImmigrantCar() {
    const city = this.city;
    const entrances = city.entrances || [];
    if (!entrances.length) return 0;
    if (this.vehicles.length >= TRAFFIC.MAX_VEHICLES) return 0;
    const gate = entrances[(Math.random() * entrances.length) | 0];
    const entry = this._entranceArc(gate);
    if (!entry) return 0;
    // 找一个能安家的住宅地块（没有住宅 -> 只能当过客，进城干活再驶离）
    const home = this._pickGravity(city.residentialTiles, gate);
    const type = this._vehDef('car');
    const passengers = DEMOGRAPHY.PASSENGERS_MIN +
      Math.floor(Math.random() * (DEMOGRAPHY.PASSENGERS_MAX - DEMOGRAPHY.PASSENGERS_MIN + 1));
    const edge = this.net.edges[this.net.arcs[entry.arc].edge];
    const exitArc = (entry.arc === edge.forwardArc) ? edge.backwardArc : edge.forwardArc;
    const veh = {
      id: VEHICLE_SEQ++, type: 'car', typeId: type.id, len: type.len, width: type.width,
      arc: entry.arc, lane: 0, dist: entry.dist, v: 0,
      path: [], pathIdx: 0,
      stops: [], stop: null, dwell: 0, parked: false,
      purpose: '', destOffset: undefined,
      originTile: gate, destTile: home >= 0 ? home : gate,
      born: 0, wait: 0, tripTime: 0,
      x: 0, z: 0, y: 0, heading: 0, grade: 0,
      homeTile: home >= 0 ? home : gate, state: 'driving',
      external: true, passengers, exitArc,
    };
    veh.stops = this._buildItinerary(veh, veh.homeTile, home >= 0 ? 'immigrant' : 'commuter');
    if (!veh.stops.length) return 0;
    veh.stop = veh.stops[0];
    if (!this._planLeg(veh)) { this.stats.noPath = (this.stats.noPath || 0) + 1; return 0; }
    const arc = this.net.arcs[veh.arc];
    const place = this._placeInArcNear(arc, veh, 'car', entry.dist);
    if (!place) { this.stats.noSpace = (this.stats.noSpace || 0) + 1; return 0; }
    veh.lane = place.lane;
    veh.dist = place.dist;
    veh.v = type.speedFactor * arc.v0 * 0.5;
    arc.laneVehicles[veh.lane].push(veh);
    arc.vehicles.push(veh);
    this.vehicles.push(veh);
    this.fleet.cars++; this.fleet.total++;
    this.stats.spawned = (this.stats.spawned || 0) + 1;
    this.stats.external = (this.stats.external || 0) + 1;
    this.stats.immigrants = (this.stats.immigrants || 0) + passengers;
    return passengers;
  }

  /**
   * 迁出：挑一辆车开去高速出入口驶离城市，车上的人随之离城（人口减少）。
   */
  dispatchEmigrant() {
    const city = this.city;
    const entrances = city.entrances || [];
    if (!entrances.length) return 0;
    const home = this._pickGarageTile('car');
    if (home === undefined) return 0;
    const gate = entrances[(Math.random() * entrances.length) | 0];
    const entry = this._entranceArc(gate);
    if (!entry) return 0;
    const edge = this.net.edges[this.net.arcs[entry.arc].edge];
    const exitArc = (entry.arc === edge.forwardArc) ? edge.backwardArc : edge.forwardArc;
    const type = this._vehDef('car');
    const passengers = 1 + Math.floor(Math.random() * 3);
    const veh = {
      id: VEHICLE_SEQ++, type: 'car', typeId: type.id, len: type.len, width: type.width,
      arc: this.tileAccess[home], lane: 0, dist: this.tileAccessOffset[home] || 0, v: 0,
      path: [], pathIdx: 0,
      stops: [{ tile: gate, purpose: 'exit', dwell: 0, arc: exitArc }], stop: null,
      dwell: 0, parked: false, purpose: 'exit', destOffset: undefined,
      originTile: home, destTile: gate,
      born: 0, wait: 0, tripTime: 0,
      x: 0, z: 0, y: 0, heading: 0, grade: 0,
      homeTile: home, state: 'driving', emigrating: true, passengers,
    };
    veh.stop = veh.stops[0];
    if (!this._planLeg(veh)) { this.stats.noPath = (this.stats.noPath || 0) + 1; return 0; }
    const arc = this.net.arcs[veh.arc];
    const place = this._placeInArcNear(arc, veh, 'car', this.tileAccessOffset[home] || 0);
    if (!place) { this.stats.noSpace = (this.stats.noSpace || 0) + 1; return 0; }
    veh.lane = place.lane;
    veh.dist = place.dist;
    veh.v = type.speedFactor * arc.v0 * 0.4;
    arc.laneVehicles[veh.lane].push(veh);
    arc.vehicles.push(veh);
    this.vehicles.push(veh);
    this._takeFromGarage(home, 'car');
    this.stats.spawned = (this.stats.spawned || 0) + 1;
    return 1;     // 返回 1 = 安排了一辆车去离城（真正的人口扣减在它抵达出入口时）
  }

  /**
   * 出入口所在的道路格 -> 「驶入城市」方向的有向路段 + 入口在该弧上的位置。
   * 出入口只能建在地图边缘，所以取该路段两个方向中朝向地图内部的那个。
   */
  _entranceArc(tileIdx) {
    const net = this.net;
    if (!net) return null;
    const edgeId = net.tileEdge[tileIdx];
    if (edgeId < 0) return null;
    const edge = net.edges[edgeId];
    const S = MAP.SIZE;
    const gx = tileIdx % S, gz = Math.floor(tileIdx / S);
    const inX = gx < S / 2 ? 1 : (gx > S / 2 ? -1 : 0);
    const inZ = gz < S / 2 ? 1 : (gz > S / 2 ? -1 : 0);
    let best = -1, bestScore = -Infinity;
    for (const arcId of [edge.forwardArc, edge.backwardArc]) {
      const arc = net.arcs[arcId];
      if (!arc || !arc.poly || arc.poly.length < 2) continue;
      const p0 = arc.poly[0], p1 = arc.poly[1];
      const dx = p1.x - p0.x, dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz) || 1;
      const score = (dx / len) * inX + (dz / len) * inZ;
      if (score > bestScore) { bestScore = score; best = arcId; }
    }
    if (best < 0) return null;
    const off = net.tileOffset[tileIdx] || 0;
    const dist = (best === edge.forwardArc) ? off : (edge.length - off);
    return { arc: best, dist: Math.max(0, Math.min(dist, edge.length - 1)) };
  }

  /** 安排行程站点（带停留时间） */
  _buildItinerary(veh, homeTile, kind) {
    const city = this.city;
    const stops = [];
    const R = (a, b) => a + Math.random() * (b - a);
    if (kind === 'immigrant') {
      // 移民：驶入新家（落地安家）-> 上班 -> 购物 -> 回新家
      stops.push({ tile: homeTile, purpose: 'home', dwell: 0, settle: true });
      const job = this._pickGravity(city.allJobTiles, homeTile);
      if (job !== undefined && job !== homeTile) {
        stops.push({ tile: job, purpose: 'work', dwell: R(TRIP.WORK_DWELL[0], TRIP.WORK_DWELL[1]) });
        if (Math.random() < TRIP.SHOP_CHANCE) {
          const shop = this._pickGravity(city.commercialTiles, job);
          if (shop !== undefined && shop !== job) {
            stops.push({ tile: shop, purpose: 'shop', dwell: R(TRIP.SHOP_DWELL[0], TRIP.SHOP_DWELL[1]) });
          }
        }
      }
      stops.push({ tile: homeTile, purpose: 'home', dwell: 0 });
    } else if (kind === 'commuter') {
      // 没有住房的过客：进城干活，傍晚从入口驶离（不增加人口）
      const job = this._pickGravity(city.allJobTiles, homeTile);
      if (job !== undefined && job !== homeTile) {
        stops.push({ tile: job, purpose: 'work', dwell: R(TRIP.WORK_DWELL[0], TRIP.WORK_DWELL[1]) });
      }
      stops.push({ tile: homeTile, purpose: 'exit', dwell: 0, arc: veh.exitArc });
    } else if (kind === 'freight') {
      // 工业产出 -> 商业区销售
      const shop = this._pickGravity(city.allJobTiles, homeTile);
      if (shop !== undefined && shop !== homeTile) {
        stops.push({ tile: shop, purpose: 'freight', dwell: R(TRIP.FREIGHT_DWELL[0], TRIP.FREIGHT_DWELL[1]) });
      }
      stops.push({ tile: homeTile, purpose: 'home', dwell: 0 });
    } else {
      // 市民：家 -> 上班 -> 购物 -> 家
      const job = this._pickGravity(city.allJobTiles, homeTile);
      if (job !== undefined && job !== homeTile) {
        stops.push({ tile: job, purpose: 'work', dwell: R(TRIP.WORK_DWELL[0], TRIP.WORK_DWELL[1]) });
        if (Math.random() < TRIP.SHOP_CHANCE) {
          const shop = this._pickGravity(city.commercialTiles, job);
          if (shop !== undefined && shop !== job) {
            stops.push({ tile: shop, purpose: 'shop', dwell: R(TRIP.SHOP_DWELL[0], TRIP.SHOP_DWELL[1]) });
          }
        }
      } else {
        const shop = this._pickGravity(city.commercialTiles, homeTile);
        if (shop !== undefined && shop !== homeTile) {
          stops.push({ tile: shop, purpose: 'shop', dwell: R(TRIP.SHOP_DWELL[0], TRIP.SHOP_DWELL[1]) });
        }
      }
      stops.push({ tile: homeTile, purpose: 'home', dwell: 0 });
    }
    return stops;
  }

  /** 为当前站点规划路径 */
  _planLeg(veh) {
    const stop = veh.stop;
    if (!stop) return false;
    const net = this.net;
    // 普通站点用「地块接入弧」；驶出城市的站点直接指定弧（出入口是道路格，没有接入弧）
    const byArc = (stop.arc !== undefined && stop.arc >= 0);
    const dArc = byArc ? stop.arc : this.tileAccess[stop.tile];
    if (dArc < 0) return false;
    const destNode = net.arcs[dArc].to;
    const curNode = net.arcs[veh.arc].to;
    let path = [];
    if (curNode !== destNode) {
      path = this.findPath(curNode, destNode);
      if (!path || !path.length) return false;
    } else if (dArc !== veh.arc) {
      path = [dArc];                    // 同一节点但接入弧不同，直接转入接入弧
    }
    veh.path = [veh.arc, ...path];
    veh.pathIdx = 0;
    veh.purpose = stop.purpose;
    veh.destTile = stop.tile;
    // 目的地在最后一段弧上的位置（若在身后则由绕行处理）
    const lastArc = veh.path[veh.path.length - 1];
    const off = byArc ? this._roadOffsetOnArc(lastArc, stop.tile)
      : this._offsetOnArc(lastArc, stop.tile);
    veh.destOffset = (off >= veh.dist - 0.6) ? off : undefined;
    return true;
  }

  /** 到达站点：停留 -> 下一站 -> 或收车 */
  _arrive(veh, index) {
    const stop = veh.stop;
    veh.v = 0;
    // 移民车抵达新家 -> 这一车人正式成为城市居民
    if (stop && stop.settle && !veh._settled) {
      veh._settled = true;
      if (this.city.onImmigrantsArrive) this.city.onImmigrantsArrive(veh.passengers || 1);
    }
    veh.dwell = stop ? stop.dwell : 0;
    if (veh.dwell > 0) {
      this._allocParkSpot(veh, this.net.arcs[veh.arc]);
      this._park(veh);
      return;
    }
    veh.stops.shift();
    if (!veh.stops.length) { this._finishTrip(veh, index); return; }
    veh.stop = veh.stops[0];
    if (!this._planLeg(veh)) this._finishTrip(veh, index);
  }

  /**
   * 行程结束：车开进建筑里（车库）。
   * 车并没有消失 —— 它只是从「在路上」变成「停在车位上」，车队数量不变。
   * 只有真正驶出城市（迁出）才会离开车队。
   */
  _finishTrip(veh, index) {
    const arc = this.net.arcs[veh.arc];
    if (arc) this._removeFromArc(veh, arc);
    const i = this.vehicles.indexOf(veh);
    if (i >= 0) this.vehicles.splice(i, 1);
    this.stats.arrived++;
    if (veh.purpose === 'exit' || veh.emigrating) {
      // 驶出城市：车与车上的人一起离开
      this.fleet.cars--; this.fleet.total--;
      this.stats.emigrated = (this.stats.emigrated || 0) + 1;
      if (this.city.onEmigrantsLeave) this.city.onEmigrantsLeave(veh.passengers || 1);
      return;
    }
    if (veh.serviceTile !== undefined) { this._specialHome(veh); return; }   // 特种车回站待命
    this._returnToGarage(veh, veh.homeTile, veh.type === 'truck' ? 'truck' : 'car');
    veh.state = 'garaged';
    veh.parked = false;
    veh.dwell = 0;
  }

  /** 驶出停靠点 */
  _resume(veh) {
    this._unpark(veh);
    veh.stops.shift();
    if (!veh.stops.length) return false;
    veh.stop = veh.stops[0];
    return this._planLeg(veh);
  }

  /**
   * 停靠：车停进目的地。
   * 注意：车辆要留在 laneVehicles 里（作为后车的「前车」），
   * 否则后车看不见停着的车，会直接开过去造成穿模/叠车；
   * 但要从 arc.vehicles 里移除（它不参与行驶密度统计）。
   */
  _park(veh) {
    if (veh.parked) return;
    const arc = this.net.arcs[veh.arc];
    if (arc) {
      // 停下的车要移出「行驶车辆」列表：
      //   - arc.vehicles 只统计行驶密度
      //   - laneVehicles 里留着它，后车就会永远跟着一辆停死的车排队（死锁）
      const k = arc.vehicles.indexOf(veh);
      if (k >= 0) arc.vehicles.splice(k, 1);
      const l = arc.laneVehicles[veh.lane];
      const kk = l.indexOf(veh);
      if (kk >= 0) l.splice(kk, 1);
      if (!arc.parkedVehicles) arc.parkedVehicles = [];
      arc.parkedVehicles.push(veh);
    }
    // 停靠时必须立刻释放交叉口通行权，
    // 否则这辆车会在整个停留期间一直占着路口名额 -> 路口很快被占满 -> 全城死锁。
    if (veh.nodeRelease) { veh.nodeRelease.passing--; veh.nodeRelease = null; }
    veh.parked = true;
  }

  _unpark(veh) {
    if (!veh.parked) return;
    const arc = this.net.arcs[veh.arc];
    if (arc) {
      veh.lane = Math.min(veh.lane, arc.lanes - 1);
      if (arc.vehicles.indexOf(veh) < 0) arc.vehicles.push(veh);
      if (arc.laneVehicles[veh.lane].indexOf(veh) < 0) arc.laneVehicles[veh.lane].push(veh);
      if (arc.parkedVehicles) {
        const k = arc.parkedVehicles.indexOf(veh);
        if (k >= 0) arc.parkedVehicles.splice(k, 1);
      }
    }
    veh.parked = false;
  }

  /**
   * 找一个不与已停放车辆重叠的车位（沿路段方向往后找）。
   * 没有重叠车位就直接停在原地（轻微重叠可接受，总比死锁好）。
   */
  _allocParkSpot(veh, arc) {
    if (!arc) return;
    if (!arc.parkedVehicles) arc.parkedVehicles = [];
    let d = veh.dist;
    for (let k = 0; k < 5; k++) {
      let conflict = false;
      for (const p of arc.parkedVehicles) {
        if (Math.abs(p.dist - d) < veh.len + 1.2) { conflict = true; break; }
      }
      if (!conflict) break;
      d += veh.len + 1.4;
      if (d > arc.length - 2) { d = veh.dist; break; }
    }
    veh.dist = Math.max(0, Math.min(d, arc.length));
  }

  /** 特种车辆出动：服务设施 -> 事件现场 -> 返回 */
  spawnServiceVehicle(serviceTile, targetTile, cfg) {
    // 特种车辆不是「需要时凭空出现」，而是随特种建筑一起诞生、停在车库里待命。
    // 没有待命车辆 -> 这次事件只能干等着（警力不足 / 消防车不够）。
    const veh = this._takeSpecialVehicle(cfg.type, serviceTile);
    if (!veh) return false;
    const d = cfg.dwell || [30, 80];
    const ok = this.dispatchSpecial(veh, targetTile, d[0] + Math.random() * (d[1] - d[0]));
    if (!ok) veh.onDuty = false;
    return ok;
  }

  /**
   * 把一辆待命的特种车派往现场（事件系统 / 调度器共用）。
   * 车是真的从车站开出去，处理完再开回车站待命。
   */
  dispatchSpecial(veh, targetTile, dwell) {
    const net = this.net;
    const type = TRAFFIC.SPECIAL_TYPES[veh.type];
    if (!type) return false;
    if (this.vehicles.length >= TRAFFIC.MAX_VEHICLES) return false;
    // 车站本身不一定临路，就近找有道路接入的地块发车
    const spawnTile = this._findSpawnPoint(veh.serviceTile);
    if (spawnTile < 0) return false;
    const oArc = this.tileAccess[spawnTile];
    if (oArc < 0) return false;
    veh.arc = oArc;
    veh.lane = 0;
    veh.dist = this.tileAccessOffset[spawnTile] || 0;
    veh.v = 0;
    veh.path = []; veh.pathIdx = 0;
    veh.dwell = 0; veh.parked = false; veh.state = 'driving';
    veh.originTile = veh.serviceTile; veh.destTile = targetTile;
    veh.wait = 0; veh.tripTime = 0;
    veh.stops = [
      { tile: targetTile, purpose: 'service', dwell: dwell },
      { tile: veh.serviceTile, purpose: 'home', dwell: 0 },
    ];
    veh.stop = veh.stops[0];
    if (!this._planLeg(veh)) return false;
    const arc = net.arcs[veh.arc];
    const place = this._placeInArc(arc, veh, veh.type);
    if (!place) return false;
    veh.lane = place.lane;
    veh.dist = place.dist;
    veh.v = type.speedFactor * arc.v0 * 0.4;
    arc.laneVehicles[veh.lane].push(veh);
    arc.vehicles.push(veh);
    this.vehicles.push(veh);
    this.stats.dispatched = (this.stats.dispatched || 0) + 1;
    return true;
  }

  /** 按需调度特种车辆 */
  _dispatchServices(dt) {
    const city = this.city;
    if (!city.serviceTiles || !city.serviceTiles.length) return;
    this._svcTimer = (this._svcTimer || 0) + dt;
    if (this._svcTimer < 45) return;
    this._svcTimer = 0;
    const pop = city.stats.population || 1;
    for (const si of city.serviceTiles) {
      const t = city.tiles[si];
      const cfg = SERVICE_DISPATCH[t.service];
      if (!cfg) continue;
      // 学校：校车只在上下学时间出车
      if (t.service === 4) {
        const h = this.hour === undefined ? 8 : this.hour;
        if (!((h >= 7 && h < 9) || (h >= 15 && h < 17))) continue;
      }
      // 只有「车站里还有待命的特种车」才能出动
      let idle = 0;
      for (const v of this.specials) {
        if (v.serviceTile === si && v.type === cfg.type && !v.onDuty) idle++;
      }
      if (idle <= 0) { this.stats.noUnit = (this.stats.noUnit || 0) + 1; continue; }
      // 需求随人口上升但设上限，避免大城市里特种车辆泛滥
      if (Math.random() > cfg.need * Math.min(2.6, 0.6 + pop / 2600)) continue;
      const target = this._pickIncident(si, cfg.radius);
      if (target < 0) continue;
      this.spawnServiceVehicle(si, target, cfg);
    }
  }

  /** 以某点为中心向外找最近的有道路接入的地块 */
  _findSpawnPoint(fromTile, maxR = 8) {
    if (this.tileAccess[fromTile] >= 0) return fromTile;
    const S = MAP.SIZE;
    const sx = fromTile % S, sz = Math.floor(fromTile / S);
    for (let r = 1; r <= maxR; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = sx + dx, z = sz + dz;
          if (x < 0 || z < 0 || x >= S || z >= S) continue;
          const ti = z * S + x;
          if (this.tileAccess[ti] >= 0) return ti;
        }
      }
    }
    return -1;
  }

  /** 在服务设施覆盖范围内随机挑一个事件地点 */
  _pickIncident(serviceTile, radiusFactor) {
    const city = this.city;
    const def = SERVICES[Object.keys(SERVICES).find((k) => SERVICES[k].id === city.tiles[serviceTile].service)];
    if (!def) return -1;
    const rad = Math.ceil((def.radius / MAP.TILE) * radiusFactor);
    const sx = serviceTile % MAP.SIZE, sz = Math.floor(serviceTile / MAP.SIZE);
    const pool = [];
    for (let z = Math.max(0, sz - rad); z <= Math.min(MAP.SIZE - 1, sz + rad); z++) {
      for (let x = Math.max(0, sx - rad); x <= Math.min(MAP.SIZE - 1, sx + rad); x++) {
        const ti = z * MAP.SIZE + x;
        const t = city.tiles[ti];
        if (!t || !t.zone || t.level === 0) continue;
        if (this.tileAccess[ti] < 0) continue;
        pool.push(ti);
      }
    }
    if (!pool.length) return -1;
    return pool[(Math.random() * pool.length) | 0];
  }

  /** 车辆类型允许使用的车道 */
  _laneAllowed(laneType, vehicleType) {
    if (laneType === 1) return vehicleType === 'bus';
    if (laneType === 2) return vehicleType === 'bike';
    if (laneType === 3) return vehicleType !== 'bike' && vehicleType !== 'bus';
    return vehicleType !== 'bike' || TRAFFIC.SPECIAL_TYPES[vehicleType] !== undefined;
  }

  /** 选择最空闲的可用车道 */
  _chooseLane(arc, vehicleType) {
    let lane = -1, best = -1;
    const types = arc.laneTypes || [];
    for (let l = 0; l < arc.lanes; l++) {
      const lt = types[l] || 0;
      if (!this._laneAllowed(lt, vehicleType)) continue;
      const near = this._nearestAhead(arc.laneVehicles[l], 0);
      const gap = near ? near.dist : Infinity;
      if (gap > best) { best = gap; lane = l; }
    }
    if (lane < 0) {
      // 没有专用车道可用时回退到常规车道
      for (let l = 0; l < arc.lanes; l++) {
        if ((types[l] || 0) === 0) { lane = l; break; }
      }
      if (lane < 0) lane = 0;
    }
    return lane;
  }

  /** 同车道中位于 dist 之后最近的车 */
  _nearestAhead(laneList, dist) {
    let best = null;
    for (const v of laneList) {
      if (v.dist > dist + 0.01 && (!best || v.dist < best.dist)) best = v;
    }
    return best;
  }

  /** 更新交叉口信号灯 */
  _updateSignals(dt) {
    for (const node of this.net.nodes) {
      if (!node.hasSignal) continue;      // 断头路 / 弯道 / 高速互通不设信号灯
      const sig = node.signal;
      sig.t = (sig.t + dt) % SIGNAL.CYCLE;
      const c = (sig.t + sig.offset) % SIGNAL.CYCLE;
      // 主次方向不对称配时：主干道方向的相位更长
      const split = sig.split === undefined ? 0.5 : sig.split;
      const majorPhase = sig.majorPhase === undefined ? 0 : sig.majorPhase;
      const len = SIGNAL.CYCLE * split;
      let local, greenLen;
      if (c < len) {
        sig.phase = majorPhase; local = c;
        greenLen = len - SIGNAL.YELLOW - SIGNAL.ALL_RED;
      } else {
        sig.phase = 1 - majorPhase; local = c - len;
        greenLen = SIGNAL.CYCLE - len - SIGNAL.YELLOW - SIGNAL.ALL_RED;
      }
      if (local < greenLen) sig.state = 'green';
      else if (local < greenLen + SIGNAL.YELLOW) sig.state = 'yellow';
      else sig.state = 'allred';
    }
  }

  /** 某进口方向是否可通行 */
  _canGo(node, axis) {
    const sig = node.signal;
    if (!sig || !node.hasSignal) return true;
    if (sig.state === 'allred') return false;
    // phase 0: 南北放行(含斜向)  phase 1: 东西放行
    if (sig.phase === 0) return axis !== 'x';
    return axis === 'x';
  }

  /** 推进 dt 交通秒（交通时钟，与城市经济时钟解耦） */
  update(dt, gameSeconds) {
    const net = this.net;
    if (!net) return;
    // 交通时钟：每跨过一个交通小时重新计算出行强度（早晚高峰）
    this.t += dt;
    const hour = Math.floor(this.t / TRAFFIC.SEC_PER_HOUR) % 24;
    if (hour !== this._tripHour) {
      this._tripHour = hour;
      this.hour = hour;
      this.generateTrips(hour);
    }
    this._updateSignals(dt);
    this._dispatchServices(dt);
    // 逐步投放车辆：按小时出行需求均匀释放（每游戏秒约 tripRate 辆）
    this.tripBudget = (this.tripBudget || 0) + (this.tripRate || 0) * dt;
    const budget = Math.min(6, Math.floor(this.tripBudget));
    if (budget > 0) {
      this.tripBudget -= budget;
      this.pendingTrips -= budget;
      for (let k = 0; k < budget; k++) {
        if (!this.spawnVehicle()) break;
      }
    }

    const vehicles = this.vehicles;
    for (let i = vehicles.length - 1; i >= 0; i--) {
      const veh = vehicles[i];
      let arc = net.arcs[veh.arc];
      if (!arc) { vehicles.splice(i, 1); this.stats.vanished = (this.stats.vanished || 0) + 1; continue; }
      veh.tripTime += dt;
      let dead = false;

      // --- 停靠站点（停车等待）---
      if (veh.dwell > 0) {
        if (!isFinite(veh.dwell)) veh.dwell = 0;      // 防御：非法停留时间
        veh.dwell -= dt;
        veh.v = 0;
        veh.wait += dt;
        if (veh.nodeRelease) { veh.nodeRelease.passing--; veh.nodeRelease = null; }
        if (veh.dwell <= 0) {
          veh.dwell = 0;
          if (!this._resume(veh)) { this._finishTrip(veh, i); dead = true; }
        }
        const pp = polyPoint(arc.poly, veh.dist, arc.length);
        this._placeOnLane(veh, arc, pp);
        if (dead) continue;
        continue;
      }

      // --- 前车 ---
      const laneList = arc.laneVehicles[veh.lane];
      const leader = this._nearestAhead(laneList, veh.dist);
      let gap = Infinity, leadV = veh.v;
      if (leader) {
        gap = leader.dist - veh.dist - leader.len;
        leadV = leader.v;
      }

      // --- 终点障碍（路段末端） ---
      const isLast = veh.pathIdx >= veh.path.length - 1;
      let stopDist = Infinity;
      let reachedStop = false;
      if (isLast) {
        const remain = arc.length - veh.dist;
        if (veh.destOffset !== undefined) {
          // 目的地就在本路段上（同路段短途出行）：停在目的地所在位置
          stopDist = Math.max(0, veh.destOffset - veh.dist);
          // 容差必须 >= IDM 的最小停车间距 s0(2m)，否则车辆会永远停在原地到不了站
          if (veh.dist >= veh.destOffset - 2.5) reachedStop = true;
        } else {
          // 目的地在路段末端（交叉口）：以路段末端为目标减速，到位即视为抵达
          stopDist = Math.max(0, remain);
          if (remain <= 3.0) reachedStop = true;
        }
      } else {
        const nextArcId = veh.path[veh.pathIdx + 1];
        const nextArc = net.arcs[nextArcId];
        const node = net.nodes[arc.to];
        let canEnter = node.passing < SIGNAL.NODE_CAPACITY;
        if (canEnter) {
          // 红绿灯：非放行方向需在停止线等待
          if (!this._canGo(node, nextArc.axis)) canEnter = false;
        }
        if (canEnter) {
          // 目标路段入口是否有空间（且车道类型允许）
          let laneOk = false;
          for (let l = 0; l < nextArc.lanes; l++) {
            const lt = (nextArc.laneTypes || [])[l] || 0;
            if (!this._laneAllowed(lt, veh.type)) continue;
            const near = this._nearestAhead(nextArc.laneVehicles[l], -1);
            const first = near ? this._minDist(nextArc.laneVehicles[l]) : Infinity;
            if (first > TRAFFIC.ENTRY_GAP + veh.len) { laneOk = true; veh.nextLane = l; break; }
          }
          canEnter = laneOk;
        }
        if (!canEnter) stopDist = arc.length - veh.dist - 4;
      }

      // --- 事故占道：后车必须停在事故现场前 -> 真实的排队回溯 ---
      if (arc.incident) {
        const d = arc.incident.dist - veh.dist;
        if (d > 0.5 && d < stopDist) stopDist = Math.max(0, d - 3.0);
      }

      // --- 到达本段目的地（站点）：进入停留 / 下一段行程 ---
      // 被前车挡住时不能"提前到站"（否则会穿过前车凭空消失）
      const blockedAhead = leader && (leader.dist - leader.len - veh.dist) < 3.0;
      if (reachedStop && !blockedAhead) {
        veh.dist = Math.min(veh.dist, arc.length);
        veh.v = 0;
        this._arrive(veh, i);
        dead = true;
        const qq = polyPoint(arc.poly, arc.length ? veh.dist : 0, arc.length);
        this._placeOnLane(veh, arc, qq);
        continue;
      }
      // 车位已被前面的车占用：排在它后面等车位（真实城市里就是排队找车位）
      if (!dead && reachedStop && blockedAhead && veh.v < 0.4 && veh.wait > 4) {
        veh.v = 0;
        this._arrive(veh, i);
        dead = true;
        continue;
      }

      // --- 占道车辆（实验室/瓶颈演示）：开到指定位置后永久停住，一直占着车道 ---
      if (veh.holdDist !== undefined && veh.dist >= veh.holdDist) {
        veh.v = 0;
        veh.dist = Math.min(veh.dist, veh.holdDist);
        const hp = polyPoint(arc.poly, veh.dist, arc.length);
        this._placeOnLane(veh, arc, hp);
        continue;
      }

      // --- IDM 跟驰 ---
      const def = arc.def;
      // 坡度影响自由流速度：上坡减速、下坡略加速
      const grade = veh.grade || 0;
      let gradeFactor = 1 - ELEV.GRADE_SPEED_PENALTY * Math.max(0, grade) / 0.1
        + 0.25 * Math.max(0, -grade);
      gradeFactor = Math.max(0.45, Math.min(1.15, gradeFactor));
      const v0 = arc.v0 * this._vehDef(veh.type).speedFactor * gradeFactor * (veh.maxSpeed || 1);
      let accel = 0;
      const obstacleGap = Math.min(gap, stopDist);
      if (obstacleGap < Infinity) {
        const s = Math.max(0.6, obstacleGap);
        const dv = veh.v - (stopDist < gap ? 0 : leadV);
        const sStar = def.s0 + Math.max(0, veh.v * def.T + (veh.v * dv) / (2 * Math.sqrt(def.a * def.b)));
        accel = def.a * (1 - Math.pow(veh.v / v0, 4) - Math.pow(sStar / s, 2));
        if (stopDist < gap) {
          // 前方是停车点：用停车公式约束
          const dStop = Math.max(0.4, stopDist);
          const vSafe = Math.sqrt(2 * def.b * dStop);
          if (veh.v > vSafe) accel = Math.min(accel, -def.b * 0.9);
        }
      } else {
        accel = def.a * (1 - Math.pow(veh.v / v0, 4));
      }
      if (veh.v < 0.2) accel = Math.max(accel, 0.4);

      veh.v = Math.max(0, veh.v + accel * dt);
      veh.v = Math.min(veh.v, v0 * 1.05);
      veh.dist += veh.v * dt;

      // 硬性碰撞约束：任何情况下都不允许车身穿过前车。
      // IDM 是「软」模型，急刹车时可能刹不住，这里做一次位置钳制，
      // 保证车辆之间始终留出间隙（屏幕上就是车不会叠在一起）。
      if (leader && leader.dist - leader.len - 0.4 < veh.dist) {
        veh.dist = Math.max(0, leader.dist - leader.len - 0.4);
        if (veh.v > leader.v) veh.v = leader.v;
      }

      // --- 换道 ---
      if (veh.v < v0 * 0.55 && arc.lanes > 1) {
        this._tryLaneChange(veh, arc);
      }

      // --- 位移（支持一步跨越多个路段） ---
      let move = veh.v * dt;
      let guardMove = 0;
      while (move > 1e-6 && guardMove++ < 8) {
        const toEnd = arc.length - veh.dist;
        if (move < toEnd) { veh.dist += move; move = 0; break; }
        move -= toEnd;
        const last = veh.pathIdx >= veh.path.length - 1;
        if (last) {
          veh.dist = arc.length;
          this._arrive(veh, i);
          dead = true;
          break;
        }
        const nextArcId = veh.path[veh.pathIdx + 1];
        const nextArc = net.arcs[nextArcId];
        const node = net.nodes[arc.to];
        const lane = Math.min(veh.nextLane ?? 0, nextArc.lanes - 1);
        const first = this._minDist(nextArc.laneVehicles[lane]);
        if (node.passing < SIGNAL.NODE_CAPACITY && first > TRAFFIC.ENTRY_GAP + veh.len &&
            this._canGo(node, nextArc.axis)) {
          // 进入新路段前先释放上一个路口的通行权
          // （否则同一 tick 内连续通过两个路口会覆盖 nodeRelease，导致计数泄漏、路口永久堵塞）
          if (veh.nodeRelease) { veh.nodeRelease.passing--; veh.nodeRelease = null; }
          this._removeFromArc(veh, arc);
          veh.arc = nextArcId;
          veh.lane = lane;
          veh.dist = 0;
          veh.pathIdx++;
          node.passing++;
          veh.nodeRelease = node;
          nextArc.laneVehicles[lane].push(veh);
          nextArc.vehicles.push(veh);
          arc = net.arcs[veh.arc];
          veh.nextLane = undefined;
        } else {
          // 无法进入下一段：停在路口前排队（溢出交通回溯）
          veh.dist = arc.length - 0.5;
          veh.v = 0;
          move = 0;
          break;
        }
      }
      if (dead) continue;
      // 释放交叉口通行权：车辆驶离路口即释放（否则在下游红灯前停车会永久占位造成死锁）
      if (veh.nodeRelease) {
        // 驶离路口区域即释放；长时间停滞则强制释放以避免永久死锁
        if (veh.dist > 6 || (veh.v < 0.3 && veh.wait > 8)) {
          veh.nodeRelease.passing--;
          veh.nodeRelease = null;
        }
      }

      // 位置与朝向（按车道做横向偏移）
      const p = polyPoint(arc.poly, veh.dist, arc.length);
      this._placeOnLane(veh, arc, p);
      if (veh.v < 0.5) veh.wait += dt; else veh.wait = 0;
    }
  }

  /**
   * 把车辆放到它所在车道的横向位置上。
   * 路网几何是「中心线 + 车道序号」，如果不做横向偏移，
   * 4 车道的 avenue 上所有车都会叠在同一条线上（看起来像一列蚂蚁）。
   */
  _placeOnLane(veh, arc, p) {
    // 车道几何必须和渲染端一致：道路总车道数 N，单车道宽 laneW = width / N，
    // 第 g 条车道（全局编号）的横向位置 = (g - (N-1)/2) * laneW。
    // arc.lane 是「本方向」的车道序号（0 = 最右），需要换算成全局编号 g。
    const N = arc.def.lanes;
    const laneW = arc.def.width / N;
    const g = arc.side < 0 ? veh.lane : (N - 1 - veh.lane);
    let off = arc.side * (g - (N - 1) / 2) * laneW;
    // 停放的车挪到马路牙子外侧（路肩），避免和行驶车辆穿模
    if (veh.parked) off = arc.side * (arc.def.width / 2 + 0.95);
    const nx = Math.cos(p.heading), nz = -Math.sin(p.heading);
    veh.x = p.x + nx * off;
    veh.z = p.z + nz * off;
    veh.y = p.y;
    veh.heading = p.heading;
    veh.grade = p.grade;
  }

  _minDist(laneList) {
    let m = Infinity;
    for (const v of laneList) if (v.dist < m) m = v.dist;
    return m;
  }

  _tryLaneChange(veh, arc) {
    const lane = veh.lane;
    for (const target of [lane - 1, lane + 1]) {
      if (target < 0 || target >= arc.lanes) continue;
      // 目标车道的类型必须允许本车通行（不能变道进公交道/自行车道）
      const lt = (arc.laneTypes || [])[target] || 0;
      if (!this._laneAllowed(lt, veh.type)) continue;
      const tl = arc.laneVehicles[target];
      // 目标车道后方最近车辆
      let backGap = Infinity, backV = 0;
      for (const o of tl) {
        if (o.dist <= veh.dist) {
          const g = veh.dist - o.dist - o.len;
          if (g < backGap) { backGap = g; backV = o.v; }
        }
      }
      if (backGap < TRAFFIC.LANE_CHANGE_MIN_GAP) continue;
      const ahead = this._nearestAhead(tl, veh.dist);
      if (ahead && ahead.dist - veh.dist - ahead.len < TRAFFIC.LANE_CHANGE_MIN_GAP) continue;
      // 换道条件：本车明显慢于前车/目标车道前车更快
      const ownLeader = this._nearestAhead(arc.laneVehicles[lane], veh.dist);
      const refV = ahead ? ahead.v : (ownLeader ? ownLeader.v : veh.v);
      // 被前车拖住（明显慢于自由流速度）时也会考虑换道超车
      const v0Lane = arc.v0 * this._vehDef(veh.type).speedFactor;
      const heldBack = ownLeader && ownLeader.v < v0Lane * 0.72;
      if (refV - veh.v > 1.5 || veh.wait > 4 || heldBack) {
        this._removeFromArc(veh, arc);
        veh.lane = target;
        arc.laneVehicles[target].push(veh);
        arc.vehicles.push(veh);
        return;
      }
    }
  }

  _removeFromArc(veh, arc) {
    const l = arc.laneVehicles[veh.lane];
    const k = l.indexOf(veh);
    if (k >= 0) l.splice(k, 1);
    const m = arc.vehicles.indexOf(veh);
    if (m >= 0) arc.vehicles.splice(m, 1);
  }

  _despawn(veh, index, arrived) {
    const arc = this.net.arcs[veh.arc];
    if (arc) {
      this._removeFromArc(veh, arc);
      if (arc.parkedVehicles) {
        const k = arc.parkedVehicles.indexOf(veh);
        if (k >= 0) arc.parkedVehicles.splice(k, 1);
      }
    }
    if (veh.nodeRelease) veh.nodeRelease.passing--;
    this.vehicles.splice(index, 1);
    if (arrived) {
      this.stats.arrived++;
      this._tripSamples.push(veh.tripTime);
      if (this._tripSamples.length > 200) this._tripSamples.shift();
    }
  }

  /** 计算路边停放车辆（视觉真实感） */
  computeParkedCars() {
    const city = this.city, net = this.net;
    if (!net) return;
    const out = [];
    const S = MAP.SIZE;
    for (let i = 0; i < city.tiles.length; i++) {
      const t = city.tiles[i];
      if (!t.road) continue;
      const eid = net.tileEdge[i];
      if (eid < 0) continue;
      const edge = net.edges[eid];
      // 周边开发强度 -> 停放数量
      const x = i % S, z = (i / S) | 0;
      let dev = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= S || nz >= S) continue;
          const nt = city.tiles[nz * S + nx];
          if (!nt.road && nt.level > 0) dev += nt.level;
        }
      }
      if (dev <= 0) continue;
      if (out.length >= TRAFFIC.MAX_PARKED_CARS) break;
      // 只有街道两侧有足够的路肩可以停车（大道/高速的路肩太窄，硬塞会压到房子）
      const arc0 = net.arcs[edge.forwardArc];
      const roadDef = arc0.def;
      const verge = 5.9 - roadDef.width / 2;      // 建筑退线之外还剩多少路肩
      if (verge < 1.9) continue;
      const r = hash2(x, z, 991);
      const count = Math.min(3, Math.floor(r * 2.4) + (dev > 4 ? 1 : 0));
      for (let k = 0; k < count; k++) {
        if (out.length >= TRAFFIC.MAX_PARKED_CARS) break;
        const arc = arc0;
        const base = net.tileOffset[i] + 3 + k * 6.5;
        if (base > arc.length - 2) continue;
        const p = polyPoint(arc.poly, base, arc.length);
        const dx = Math.sin(p.heading), dz = Math.cos(p.heading);
        const nx = dz, nz = -dx;                     // 行车方向的右侧法线
        // 停在「左侧路肩」：与右侧停靠的市民车辆互不重叠
        const off = -(roadDef.width / 2 + 0.95);
        const isTruck = hash2(x + k, z, 77) < TRAFFIC.TRUCK_RATIO * 0.6;
        out.push({
          x: p.x + nx * off, z: p.z + nz * off, y: (city.tiles[i].h || 0),
          heading: p.heading, type: isTruck ? 1 : 0, parked: true,
        });
      }
    }
    this.parkedCars = out;
  }
  /** 每 TRAFFIC.SAMPLE_CONGESTION 秒统计一次拥堵 */
  sample() {
    const net = this.net;
    if (!net) return;
    let sumSpeed = 0, n = 0, jam = 0;
    let vSum = 0, vCount = 0;          // 按车辆加权的平均车速
    for (const arc of net.arcs) {
      const vlist = arc.vehicles;   // 已排除停靠中的车辆
      const density = vlist.length / Math.max(1, arc.length * arc.lanes);
      const jamDensity = 1 / (arc.def.s0 + 7);
      // 只统计已进入稳态的车辆，避免刚起步的车辆把空路误判为拥堵
      let sp = 0, cnt = 0;
      for (const v of vlist) {
        vSum += v.v; vCount++;
        if (v.tripTime < 12 && v.v < arc.v0 * 0.75) continue;
        sp += v.v; cnt++;
      }
      const avg = cnt ? sp / cnt
        : (vlist.length ? vlist.reduce((a, v) => a + v.v, 0) / vlist.length : arc.v0);
      const deficit = 1 - Math.min(1, avg / arc.v0);
      const dens = Math.min(1, density / jamDensity);
      // 密度为主、速度损失为辅；稀疏路段几乎不拥堵
      arc.congestion = Math.max(0, Math.min(1, dens + deficit * 0.45 * Math.min(1, dens * 4)));
      arc.avgSpeed = avg;
      arc.density = density;
      if (vlist.length) {
        sumSpeed += avg; n++;
        if (avg < arc.v0 * 0.45) jam += vlist.length;
      }
    }
    const s = this.stats;
    s.vehicles = this.vehicles.length;
    // 出行目的分布 + 特种车辆数（供 UI 展示）
    const byPurpose = {};
    let emergency = 0, dwelling = 0;
    for (const v of this.vehicles) {
      const pp = v.purpose || 'other';
      byPurpose[pp] = (byPurpose[pp] || 0) + 1;
      if (TRAFFIC.SPECIAL_TYPES[v.type]) emergency++;
      if (v.dwell > 0) dwelling++;
    }
    s.byPurpose = byPurpose;
    s.emergency = emergency;
    s.dwelling = dwelling;
    s.dispatched = this.stats.dispatched || 0;
    s.moving = this.vehicles.length - jam;
    s.jammed = jam;
    s.avgSpeed = vCount ? vSum / vCount : (n ? sumSpeed / n : 0);
    let csum = 0, cn = 0;
    for (const e of net.edges) {
      const a = net.arcs[e.forwardArc], b = net.arcs[e.backwardArc];
      const c = Math.max(a.congestion, b.congestion);
      e.congestion = c;
      csum += c; cn++;
    }
    s.congestion = cn ? (csum / cn) * 100 : 0;
    // 出行时间指数：自由流时间 vs 实际
    if (this._tripSamples.length) {
      const avg = this._tripSamples.reduce((a, b) => a + b, 0) / this._tripSamples.length;
      s.avgTripTime = avg;
      s.travelIndex = Math.min(100, (avg / 300) * 100);
    }
  }
}
