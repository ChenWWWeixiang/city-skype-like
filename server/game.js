// ============================================================================
//  游戏引擎：权威模拟循环、状态广播、指令处理、持久化
// ============================================================================
import { City } from './sim/city.js';
import { MAP, TIME, ROADS, ZONES, SERVICES, ECON } from './sim/constants.js';
import { repo, compress } from './db.js';
import { lab as labSim } from './lab.js';

const BROADCAST_HZ = 30;      // 状态 + 车辆关键帧广播频率（客户端插值到 60fps）
const SAVE_INTERVAL_MS = 12000;

export class Game {
  constructor(city) {
    this.city = city;
    this.clients = new Set();
    this.dirtyAll = true;
    this.lastSave = Date.now();
    this.ledgerSaved = 0;
    this.congestionMap = new Uint8Array(MAP.SIZE * MAP.SIZE);
    this.signalMap = new Uint8Array(MAP.SIZE * MAP.SIZE);
    this._lastBroadcast = 0;
    this.headerExtra = null;      // 实验室等特殊场景可注入额外状态
  }

  get id() { return this.city.id; }

  markDirtyAll() { this.dirtyAll = true; }

  /** 收集需要发送给客户端的瓦片增量 */
  collectDiffs() {
    const city = this.city;
    const out = [];
    const push = (i) => {
      const t = city.tiles[i];
      out.push(i, t.zone, t.level, t.road, city.net.masks[i], t.service,
        Math.round(t.land), t.power ? 1 : 0, t.water ? 1 : 0, t.terrain,
        Math.round((t.h || 0) * 10) / 10, t.lt || 0, t.over || 0, city.net.overMasks[i],
        t.olt || 0);
    };
    if (this.dirtyAll) {
      for (let i = 0; i < city.tiles.length; i++) push(i);
      this.dirtyAll = false;
      city.dirty.clear();
    } else {
      for (const i of city.dirty) push(i);
      city.dirty.clear();
    }
    return out;
  }

  /** 更新每格拥堵贴图 */
  updateCongestionMap() {
    const net = this.city.net;
    const map = this.congestionMap;
    map.fill(0);
    for (const e of net.edges) {
      const v = Math.max(0, Math.min(255, Math.round(e.congestion * 255)));
      for (const t of e.tiles) map[t] = v;
    }
  }

  /**
   * 打包车辆数据（行驶中 + 路边停放）
   * 每辆车 7 个 float: [x, z, y, heading, typeId, id, speed]
   * speed 单位是「交通秒」下的 m/s，客户端结合 trafficRate 换算成真实速度做航位推算。
   */
  packVehicles() {
    const list = [];
    for (const veh of this.city.traffic.vehicles) {
      // 停靠中的车（进站/上班/回家）已经停在车道中间，
      // 画出来会和后车穿模，而且它对交通可视化没有意义 —— 直接不发给客户端。
      if (veh.dwell > 0 || veh.parked) continue;
      list.push(veh.x, veh.z, veh.y || 0, veh.heading, veh.typeId, veh.id, veh.v || 0);
    }
    let parkedId = -1;
    for (const p of this.city.traffic.parkedCars || []) {
      // typeId: 0 轿车 / 1 货车（客户端据此选模型）
      list.push(p.x, p.z, p.y || 0, p.heading, p.type === 1 ? 1 : 0, parkedId--, 0);
    }
    return new Float32Array(list);
  }

  /** 更新信号灯贴图：bit0 有灯, bit1-2 状态(0绿1黄2全红), bit3 相位, bit4 层级 */
  updateSignalMap() {
    const map = this.signalMap;
    map.fill(0);
    const net = this.city.net;
    if (!net) return;
    for (const node of net.nodes) {
      if (!node.hasSignal) continue;
      const cur = map[node.tile];
      if (cur !== 0 && (cur & 16) === 0) continue;   // 同格已有地面层信号灯则优先
      const s = node.signal;
      const st = s.state === 'green' ? 0 : s.state === 'yellow' ? 1 : 2;
      map[node.tile] = 1 | (st << 1) | ((s.phase & 1) << 3) | ((node.layer & 1) << 4);
    }
  }

  buildHeader(full) {
    const c = this.city;
    const st = c.stats;
    const ts = c.traffic.stats;
    return {
      type: 'state',
      full: !!full,
      cityId: c.id,
      name: c.name,
      tick: c.tick,
      funds: Math.round(c.funds),
      tax: c.tax,
      speed: c.speed,
      date: c.date,
      demand: c.demand,
      stats: {
        population: st.population, jobs: st.jobs, unemployment: st.unemployment,
        happiness: st.happiness, residential: st.residential, commercial: st.commercial,
        industrial: st.industrial, roadTiles: st.roadTiles, serviceCount: st.serviceCount,
        landValueAvg: Math.round(st.landValueAvg), powerCoverage: Math.round(st.powerCoverage),
        roadSegments: st.roadSegments || 0,
        effIndustrial: st.effIndustrial === undefined ? 1 : st.effIndustrial,
        effCommercial: st.effCommercial === undefined ? 1 : st.effCommercial,
        effResidential: st.effResidential === undefined ? 1 : st.effResidential,
        waterCoverage: Math.round(st.waterCoverage), income: Math.round(st.income),
        expense: Math.round(st.expense), comJobs: st.comJobs || 0, indJobs: st.indJobs || 0,
      },
      trafficRate: TIME.TRAFFIC_SPEEDS[c.speed] || 0,   // 交通秒/真实秒
      entrances: c.entrances || [],        // 高速出入口（对外连接）
      // 人口账本（人口只来自外来车辆与新生儿）
      demography: {
        pop: c.demography.pop, housed: c.demography.housed, waiting: c.demography.waiting,
        births: c.demography.births, deaths: c.demography.deaths,
        immigrants: c.demography.immigrants, emigrants: c.demography.emigrants,
      },
      // 车队（守恒：路上 + 车库 + 特种）
      fleet: {
        total: c.traffic.fleet.total, cars: c.traffic.fleet.cars,
        trucks: c.traffic.fleet.trucks, special: c.traffic.fleet.special,
        scrapped: c.traffic.fleet.scrapped,
      },
      // 事件（火灾 / 犯罪 / 疾病 / 事故）
      events: c.events ? c.events.forClient() : [],
      eventStats: c.events ? c.events.stats : {},
      traffic: {
        vehicles: ts.vehicles, moving: ts.moving, jammed: ts.jammed,
        avgSpeed: +(ts.avgSpeed || 0).toFixed(1), congestion: +(ts.congestion || 0).toFixed(1),
        travelIndex: +(ts.travelIndex || 0).toFixed(1), avgTripTime: Math.round(ts.avgTripTime || 0),
        unreachable: ts.unreachable || 0, arrived: ts.arrived || 0,
        spawned: ts.spawned || 0, vanished: ts.vanished || 0, dropped: ts.dropped || 0,
        noTrip: ts.noTrip || 0, noAccess: ts.noAccess || 0, noPath: ts.noPath || 0,
        sameNode: ts.sameNode || 0, noRoute: ts.noRoute || 0, lastFail: ts.lastFail || '',
        dispatched: ts.dispatched || 0, emergency: ts.emergency || 0,
        dwelling: ts.dwelling || 0, byPurpose: ts.byPurpose || {},
      },
      lab: this.headerExtra ? this.headerExtra() : undefined,
      ledger: c.ledger.slice(-24),
      diffs: this.collectDiffs(),
    };
  }

  broadcast(full = false) {
    if (!this.clients.size) return;
    this.updateCongestionMap();
    this.updateSignalMap();
    const header = this.buildHeader(full);
    const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
    const vehicles = this.packVehicles();
    const len = Buffer.alloc(4);
    len.writeUInt32LE(headerBuf.length, 0);
    const frame = Buffer.concat([
      len, headerBuf,
      Buffer.from(vehicles.buffer, vehicles.byteOffset, vehicles.byteLength),
      Buffer.from(this.congestionMap.buffer, this.congestionMap.byteOffset, this.congestionMap.byteLength),
      Buffer.from(this.signalMap.buffer, this.signalMap.byteOffset, this.signalMap.byteLength),
    ]);
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(frame, { binary: true });
    }
  }

  save(force = false) {
    const c = this.city;
    const now = Date.now();
    if (!force && now - this.lastSave < SAVE_INTERVAL_MS) return;
    this.lastSave = now;
    const snap = compress(c.snapshot());
    repo.saveCity(c, snap);
    // 财政流水落库
    while (this.ledgerSaved < c.ledger.length) {
      const e = c.ledger[this.ledgerSaved++];
      repo.appendLedger(c.id, e);
    }
  }

  handleCommand(cmd, ws) {
    const c = this.city;
    const reply = (res) => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'msg', ok: res.ok !== false, text: res.msg || '' }));
      }
      if (res.ok !== false && res.msg) {
        repo.logEvent(c.id, c.tick, 'cmd', res.msg);
      }
    };
    switch (cmd.action) {
      case 'road': {
        const res = c.buildRoad(cmd.tiles || [], cmd.roadType || 1, { elevated: !!cmd.elevated });
        if (res.ok) this.markDirtyAll();
        reply(res);
        break;
      }
      case 'zone': {
        const res = c.zoneTiles(cmd.tiles || [], cmd.zone || 'res');
        if (res.ok) this.markDirtyAll();
        reply(res);
        break;
      }
      case 'bulldoze': {
        const res = c.bulldoze(cmd.tiles || []);
        if (res.ok) this.markDirtyAll();
        reply(res);
        break;
      }
      case 'service': {
        const res = c.placeService(cmd.tile, cmd.service);
        if (res.ok) this.markDirtyAll();
        reply(res);
        break;
      }
      case 'tax': {
        const res = c.setTax(cmd.kind, cmd.value);
        reply(res);
        break;
      }
      case 'starter': {
        const res = c.buildStarter();
        this.markDirtyAll();
        reply(res);
        break;
      }
      case 'entrance': {
        const res = c.addEntrance(cmd.tile | 0);
        reply(res);
        break;
      }
      case 'lane': {
        const res = c.setLane(cmd.tile, cmd.lane | 0, cmd.layer | 0);
        if (res.ok) this.markDirtyAll();
        reply(res);
        break;
      }
      case 'speed': {
        c.speed = Math.max(0, Math.min(TIME.SPEEDS.length - 1, cmd.value | 0));
        reply({ ok: true, msg: '' });
        break;
      }
      case 'rename': {
        c.name = String(cmd.cityName || '').slice(0, 40) || c.name;
        this.save(true);
        reply({ ok: true, msg: '城市已重命名' });
        break;
      }
      case 'save': {
        this.save(true);
        repo.saveSnapshot(c.id, cmd.label || '手动存档', compress(c.snapshot()));
        reply({ ok: true, msg: '已保存到服务器数据库' });
        break;
      }
      default:
        reply({ ok: false, msg: '未知指令' });
    }
  }
}

export class GameManager {
  constructor() {
    this.games = new Map();
    this.lab = null;
    this.labGame = null;
    this.lastTime = Date.now();
    this.timer = null;
    this._lastBroadcast = 0;
  }

  create(opts = {}) {
    const city = new City(opts);
    const game = new Game(city);
    this.games.set(city.id, game);
    this.saveAll(true);
    return game;
  }

  get(id) { return this.games.get(id); }

  /** 车辆仿真实验室：不入库，单独一个 Game 实例 */
  ensureLab(stage) {
    if (!this.lab) this.lab = labSim;
    if (this.lab.stage !== stage) this.lab.build(stage);
    if (!this.labGame) {
      this.labGame = new Game(this.lab.city);
      this.labGame.headerExtra = () => this.lab.telemetry();
      this.labGame.markDirtyAll();
    } else {
      this.labGame.city = this.lab.city;
      this.labGame.markDirtyAll();
    }
    return this.labGame;
  }

  loadFromDb(id) {
    const rec = repo.loadCity(id);
    if (!rec) return null;
    const city = City.restore(rec.snapshot);
    const game = new Game(city);
    game.markDirtyAll();
    this.games.set(city.id, game);
    return game;
  }

  remove(id) {
    this.games.delete(id);
    repo.deleteCity(id);
  }

  saveAll(force = false) {
    for (const g of this.games.values()) g.save(force);
  }

  start() {
    const tick = () => {
      const now = Date.now();
      const dt = Math.min(0.25, (now - this.lastTime) / 1000);
      this.lastTime = now;
      for (const game of this.games.values()) {
        const c = game.city;
        const gps = TIME.SPEEDS[c.speed] || 0;
        const tps = TIME.TRAFFIC_SPEEDS[c.speed] || 0;
        if (gps > 0) {
          // 城市（经济）时钟与交通时钟解耦：
          //   经济按游戏分钟推进（人口/税收随时在变）
          //   交通按真实秒推进（车速在屏幕上连续可读，不会瞬移）
          c.advance(gps * dt);
          if (tps > 0) c.stepTraffic(tps * dt);
        }
        game.save(false);
      }
      // 车辆仿真实验室（独立于玩家城市，不进数据库）
      if (this.lab) {
        this.lab.step(dt);
        if (this.labGame) this.labGame.broadcast(false);
      }
      const t = Date.now();
      if (t - this._lastBroadcast >= 1000 / BROADCAST_HZ) {
        this._lastBroadcast = t;
        for (const game of this.games.values()) game.broadcast(false);
      }
    };
    this.timer = setInterval(tick, 1000 / 30);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.saveAll(true);
  }
}

export const manager = new GameManager();
