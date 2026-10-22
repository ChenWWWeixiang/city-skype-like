// ============================================================================
//  城市主体：地块状态、游戏时钟、玩家指令
// ============================================================================
import {
  MAP, TIME, ROADS, ZONES, ECON, SERVICES, SERVICE_BY_ID,
  BUILDING_CAPS, TRAFFIC, LAND, TERRAIN, ELEV, LANE_TYPE_LIST, DEMOGRAPHY,
} from './constants.js';
import { buildNetwork, tileIndex } from './roadnet.js';
import { TrafficSim } from './traffic.js';
import { development } from './develop.js';
import { EventSystem } from './events.js';

export const ROAD_BY_ID = { 1: ROADS.street, 2: ROADS.avenue, 3: ROADS.highway };

/** 地块是否临路（四周任一格有道路） */
function hasRoadNeighbor(city, i) {
  const x = i % MAP.SIZE, z = Math.floor(i / MAP.SIZE);
  if (x > 0 && city.tiles[i - 1].road) return true;
  if (x < MAP.SIZE - 1 && city.tiles[i + 1].road) return true;
  if (z > 0 && city.tiles[i - MAP.SIZE].road) return true;
  if (z < MAP.SIZE - 1 && city.tiles[i + MAP.SIZE].road) return true;
  return false;
}

/** 高架道路高度剖面：两端坡道 + 中部平台 */
export function heightProfile(n, H, ramp) {
  const out = new Array(n).fill(0);
  if (n < 8) return out;                       // 太短无法形成坡道
  const r = Math.min(ramp, Math.floor(n / 2));
  // 坡度受最大爬升限制（每格高差 <= MAX_RAMP）
  const h = Math.min(H, r * ELEV.MAX_RAMP * 0.9);
  for (let i = 0; i < n; i++) {
    const dEnd = Math.min(i, n - 1 - i);
    out[i] = dEnd >= r ? h : h * (dEnd / r);
  }
  return out;
}

let CITY_SEQ = 1;

export class City {
  constructor(opts = {}) {
    this.id = opts.id || ('c' + Date.now().toString(36) + (CITY_SEQ++).toString(36));
    this.name = opts.name || '新城市';
    this.seed = opts.seed ?? MAP.WATER_SEED;
    this.tick = 0;                       // 游戏分钟
    this.funds = opts.funds ?? ECON.START_FUNDS;
    this.tax = { ...ECON.DEFAULT_TAX };
    if (opts.tax) this.tax = { ...ECON.DEFAULT_TAX, ...opts.tax };
    this.speed = 1;                      // 索引到 TIME.SPEEDS
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    // 对外连接（高速出入口）：位于地图边缘的道路，车辆可由此进出城市
    this.entrances = [];
    // 人口账本：人口只来自「外来车辆（移民）」与「新生儿」，
    // 只流向「死亡」与「迁出（车开出城）」。人口 = 账本，不是凭空涨的。
    this.demography = {
      pop: 0,          // 城市真实人口（含待安置的）
      housed: 0,       // 已住进房子的人口
      waiting: 0,      // 到了城市但还没分配住房的人口
      births: 0, deaths: 0, immigrants: 0, emigrants: 0,
      homeless: 0,
      _immigAcc: 0,    // 移民累积器
      _deathAcc: 0,
      _birthAcc: 0,
    };
    // 车队登记处：车只会「在家里的车位」诞生，不会凭空出现在马路上
    this.fleet = { cars: 0, trucks: 0, bikes: 0, special: 0, total: 0 };
    this.messages = [];
    this.dirty = new Set();
    this.tiles = [];
    this.net = null;
    this.traffic = new TrafficSim(this);
    // 事件系统：火灾 / 犯罪 / 疾病 / 事故 / 学校
    this.events = new EventSystem(this);
    this.demand = { res: 0, com: 0, ind: 0 };
    this.stats = {
      population: 0, jobs: 0, unemployment: 0, happiness: 62,
      trafficCongestion: 0, avgSpeed: 0, powerCoverage: 0, waterCoverage: 0,
      residential: 0, commercial: 0, industrial: 0,
      income: 0, expense: 0, roadTiles: 0, serviceCount: 0,
      landValueAvg: 0, trafficIndex: 0,
    };
    this.ledger = [];
    this._genTerrain();
    this._initTiles();
    this._lastLevel = new Int32Array(this.tiles.length);
    this.rebuildNetwork();
    this.refreshAggregates();
    this.updateCoverage();
    this.updateEfficiency();
    this.computeLandValue();
    this.updateDemand();
  }

  // ---------------------------------------------------------------- 地形
  _genTerrain() {
    const S = MAP.SIZE;
    this.terrain = new Uint8Array(S * S);
    const s = this.seed;
    for (let x = 0; x < S; x++) {
      const c = S * 0.56 + Math.sin(x * 0.115 + (s % 13)) * 5.6 + Math.sin(x * 0.31 + 1.7) * 1.8;
      const w = 1.45 + 0.85 * Math.sin(x * 0.19 + 1.1);
      for (let z = 0; z < S; z++) {
        if (Math.abs(z - c) < w) this.terrain[tileIndex(x, z)] = TERRAIN.water;
      }
    }
    // 一个小湖
    for (let z = 38; z < 43; z++) {
      for (let x = 6; x < 11; x++) {
        const d = Math.hypot((x - 8.2) / 2.6, (z - 40.4) / 2.4);
        if (d < 1 + 0.25 * Math.sin(x * 2 + z)) this.terrain[tileIndex(x, z)] = TERRAIN.water;
      }
    }
  }

  _initTiles() {
    const N = MAP.SIZE * MAP.SIZE;
    this.tiles = new Array(N);
    for (let i = 0; i < N; i++) {
      this.tiles[i] = {
        terrain: this.terrain[i],
        zone: 0, level: 0, road: 0, service: 0,
        land: LAND.BASE, power: false, water: false,
        pop: 0, jobs: 0, age: 0, coverage: 0, pollution: 0,
        eff: 1,        // 运营效率（受拥堵/断电断水影响）
        occ: 0,        // 入住率 0~1（居民搬入/搬出，人口随之连续变化）
        over: 0,       // 高架层道路类型（可与地面道路同格并存 -> 立交）
        h: 0,          // 高架层高程 (m)
        lt: 0,         // 车道类型打包（每车道 2 bit）
        olt: 0,        // 高架层车道类型打包
      };
    }
  }

  // ---------------------------------------------------------------- 路网
  rebuildNetwork() {
    this.net = buildNetwork(this.tiles, ROAD_BY_ID);
    this.traffic.rebuild(this.net);
    this.stats.roadSegments = this.net.components;
  }

  // ---------------------------------------------------------------- 指令
  canAfford(cost) { return this.funds >= cost; }

  /** 道路：tileIdx 数组 */
  buildRoad(tileList, roadType, opts = {}) {
    const def = ROAD_BY_ID[roadType];
    if (!def) return { ok: false, msg: '未知的道路类型' };
    const elevated = !!opts.elevated;
    const valid = [];
    const seen = new Set();
    let cost = 0, upgrade = 0;
    for (const i of tileList) {
      if (i < 0 || i >= this.tiles.length) continue;
      if (seen.has(i)) continue;
      seen.add(i);
      const t = this.tiles[i];
      if (t.service) continue;
      const water = t.terrain === TERRAIN.water;
      if (elevated) {
        if (t.over === roadType) continue;
        cost += def.cost * (water ? 3 : 1);
        valid.push(i);
        continue;
      }
      if (t.road) {
        // 已有道路 -> 升级（只补差价）
        if (t.road === roadType) continue;
        if (t.road > roadType) continue;       // 不允许降级
        const oldCost = ROAD_BY_ID[t.road].cost * (water ? 3 : 1);
        const newCost = def.cost * (water ? 3 : 1);
        cost += newCost - oldCost;
        upgrade++;
        valid.push(i);
        continue;
      }
      cost += def.cost * (water ? 3 : 1);
      valid.push(i);
    }
    if (!valid.length) return { ok: false, msg: '没有可施工的地块' };
    if (!this.canAfford(cost)) return { ok: false, msg: '资金不足' };
    this.funds -= cost;
    if (elevated) {
      // 高架道路：两端设坡道，中部抬升形成立体交叉（地面道路保持在下层）
      const profile = heightProfile(valid.length, ELEV.BRIDGE_HEIGHT, ELEV.RAMP_TILES);
      for (let k = 0; k < valid.length; k++) {
        const i = valid[k];
        const t = this.tiles[i];
        if (!t.road) { t.zone = 0; t.level = 0; t.service = 0; }
        t.over = roadType;
        t.h = profile[k];
        t.olt = 0;
        this.markDirty(i);
      }
      this.rebuildNetwork();
      this.refreshAggregates();
      const ends = [this.tiles[valid[0]], this.tiles[valid[valid.length - 1]]];
      const connected = ends.some((t) => t.road);
      return {
        ok: true,
        msg: '已架设高架' + def.name + '（-' + Math.round(cost) + ' §）' +
          (connected ? '' : '　提示：高架两端需与地面道路相接才能通车'),
        cost,
      };
    }
    for (const i of valid) {
      const t = this.tiles[i];
      if (t.road) this._clearBuilding(t);
      t.road = roadType;
      // 注意：地面道路与高架道路可以同格并存（立交），不能互相清除
      t.zone = 0;
      t.level = 0;
      t.service = 0;
      t.lt = 0;
      this.markDirty(i);
    }
    this.rebuildNetwork();
    this.refreshAggregates();
    return {
      ok: true,
      msg: (upgrade ? '已升级 ' + upgrade + ' 处为' : '已建造 ') +
        def.name + '（-' + Math.round(cost) + ' §）',
      cost,
    };
  }

  /** 分区 */
  zoneTiles(tileList, zoneType) {
    const zone = ZONES[zoneType];
    if (!zone || zone.id === 0) return { ok: false, msg: '未知的分区类型' };
    const valid = [];
    let cost = 0;
    for (const i of tileList) {
      const t = this.tiles[i];
      if (!t || t.terrain === TERRAIN.water) continue;
      if (t.road || t.service) continue;
      if (t.zone === zone.id && t.level === 0) continue;
      cost += ECON.ZONE_COST[zoneType];
      valid.push(i);
    }
    if (!valid.length) return { ok: false, msg: '没有可规划的地块' };
    if (!this.canAfford(cost)) return { ok: false, msg: '资金不足' };
    this.funds -= cost;
    for (const i of valid) {
      const t = this.tiles[i];
      t.zone = zone.id;
      t.level = 0;
      t.pop = 0; t.jobs = 0; t.age = 0; t.occ = 0;
      this.markDirty(i);
    }
    this.refreshAggregates();
    this.updateDemand();
    // 反馈：告诉玩家哪些地块暂时长不出房子，以及缺什么
    let ready = 0, noUtility = 0, noAccess = 0, lowLand = 0;
    for (const i of valid) {
      const t = this.tiles[i];
      if (!hasRoadNeighbor(this, i)) noAccess++;
      else if (!(t.power && t.water)) noUtility++;
      else if (t.land < 22) lowLand++;
      else ready++;
    }
    let msg = '已规划 ' + zone.name + ' ' + valid.length + ' 格（-' + Math.round(cost) + ' §）';
    if (ready === valid.length) {
      msg += '　' + ready + ' 格可立即发展';
    } else {
      const hints = [];
      if (noUtility > 0) hints.push(noUtility + ' 格缺少电力/供水');
      if (noAccess > 0) hints.push(noAccess + ' 格没有临路');
      if (lowLand > 0) hints.push(lowLand + ' 格地价过低');
      msg += '　⚠ ' + hints.join('，') + '，这些地块暂时不会发展';
      if (!this._hasService(SERVICES.power.id)) msg += '（城市里还没有发电厂）';
      else if (!this._hasService(SERVICES.water.id)) msg += '（城市里还没有水塔）';
    }
    return { ok: true, msg, cost };
  }

  /** 城市中是否存在指定类型的服务设施 */
  _hasService(id) {
    for (let i = 0; i < this.tiles.length; i++) {
      if (this.tiles[i].service === id) return true;
    }
    return false;
  }

  /** 拆除 */
  bulldoze(tileList) {
    for (const i of tileList) this.removeEntrance(i);
    let refund = 0;
    let n = 0;
    for (const i of tileList) {
      const t = this.tiles[i];
      if (!t) continue;
      if (t.road || t.over) {
        if (t.road) refund += ROAD_BY_ID[t.road].cost * ECON.BULLDOZE_REFUND;
        if (t.over) refund += ROAD_BY_ID[t.over].cost * ECON.BULLDOZE_REFUND;
        t.road = 0; t.over = 0; t.h = 0; t.level = 0; t.zone = 0; t.pop = 0; t.jobs = 0;
        n++;
      } else if (t.service) {
        refund += SERVICE_BY_ID[t.service].cost * ECON.BULLDOZE_REFUND;
        // 特种建筑被拆 -> 它的特种车辆也随之消失（车队守恒）
        this.traffic.onServiceRemoved(i);
        t.service = 0; n++;
      } else if (t.zone || t.level) {
        const z = t.zone === 1 ? 'res' : t.zone === 2 ? 'com' : t.zone === 3 ? 'ind' : null;
        refund += (z ? ECON.ZONE_COST[z] : 0) * ECON.BULLDOZE_REFUND;
        t.zone = 0; t.level = 0; t.pop = 0; t.jobs = 0;
        n++;
      }
      this.markDirty(i);
    }
    if (!n) return { ok: false, msg: '没有可拆除的对象' };
    this.funds += refund;
    this.rebuildNetwork();
    this.refreshAggregates();
    this.updateCoverage();
    return { ok: true, msg: '已拆除 ' + n + ' 处（+' + Math.round(refund) + ' §）' };
  }

  /** 放置服务设施 */
  placeService(tileIdx, serviceType) {
    const def = SERVICES[serviceType];
    if (!def) return { ok: false, msg: '未知设施' };
    const t = this.tiles[tileIdx];
    if (!t) return { ok: false, msg: '无效地块' };
    if (t.terrain === TERRAIN.water) return { ok: false, msg: '不能在水面建设' };
    if (t.road || t.service) return { ok: false, msg: '地块已被占用（道路或已有设施）' };
    // 已规划的地块也允许直接放置设施（自动清除该格分区）
    const hadZone = t.zone;
    if (hadZone) { t.zone = 0; t.level = 0; t.pop = 0; t.jobs = 0; }
    if (!this.canAfford(def.cost)) return { ok: false, msg: '资金不足' };
    this.funds -= def.cost;
    t.service = def.id;
    t.level = 1;
    this.markDirty(tileIdx);
    this.updateCoverage();
    this.computeLandValue();
    this.refreshAggregates();
    // 特种建筑诞生时，对应的特种车辆同时诞生（警车/消防车/救护车/校车/环卫车）
    const born = this.traffic.onServiceBuilt(tileIdx, def.id);
    return {
      ok: true,
      msg: '已建造 ' + def.name + '（-' + def.cost + ' §）　覆盖半径 ' + def.radius + ' m' +
        (hadZone ? '　已清除该格分区' : '') +
        (born ? '　同时配备 ' + born + ' 辆特种车辆' : ''),
    };
  }

  /**
   * 一键生成「初级小城」：一条通向地图边缘的高速 + 主干道 + 街区 +
   * 住宅/商业/工业分区 + 发电厂/水塔/诊所 + 一个高速出入口。
   * 给新手的起手模板：打开就能看到车在跑。
   */
  buildStarter() {
    const S = MAP.SIZE;
    const T = (x, z) => z * S + x;
    const segX = (x0, x1, z) => { const o = []; for (let x = x0; x <= x1; x++) o.push(T(x, z)); return o; };
    const segZ = (x, z0, z1) => { const o = []; for (let z = z0; z <= z1; z++) o.push(T(x, z)); return o; };
    const block = (x0, x1, z0, z1) => {
      const o = [];
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) o.push(T(x, z));
      return o;
    };
    const roadPlan = [
      { tiles: segX(0, 12, 24), type: 3 },     // 高速公路：地图西边缘 -> 城内（对外通道）
      { tiles: segX(8, 32, 24), type: 2 },     // 大道（东西主干）
      { tiles: segZ(24, 10, 38), type: 2 },    // 大道（南北主干）
      { tiles: segX(12, 32, 14), type: 1 },    // 支路街道（围出 4 个街区）
      { tiles: segX(12, 32, 34), type: 1 },
      { tiles: segZ(12, 14, 34), type: 1 },
      { tiles: segZ(32, 14, 34), type: 1 },
    ];
    const zonePlan = [
      { tiles: block(13, 23, 15, 23), type: 'res' },   // 西北住宅
      { tiles: block(25, 31, 15, 23), type: 'com' },   // 东北商业
      { tiles: block(13, 23, 25, 33), type: 'ind' },   // 西南工业
      { tiles: block(25, 31, 25, 33), type: 'res' },   // 东南住宅
    ];
    const svcPlan = [
      { tile: T(20, 18), id: 'power' },      // 发电厂：没有电就不会长房子
      { tile: T(28, 30), id: 'water' },      // 水塔
      { tile: T(30, 18), id: 'clinic' },     // 诊所
    ];
    const gateTile = T(0, 24);               // 地图西边缘的高速出入口

    // ---- 先算总价（避免建到一半资金不足留下半截城市）----
    let cost = 0;
    for (const r of roadPlan) {
      const def = ROAD_BY_ID[r.type];
      for (const i of r.tiles) {
        const t = this.tiles[i];
        if (!t || t.service) continue;
        const w = t.terrain === TERRAIN.water ? 3 : 1;
        if (t.road) {
          if (t.road >= r.type) continue;              // 同级或更高级，不用花钱
          cost += (def.cost - ROAD_BY_ID[t.road].cost) * w;
        } else cost += def.cost * w;
      }
    }
    for (const z of zonePlan) {
      const def = ZONES[z.type];
      for (const i of z.tiles) {
        const t = this.tiles[i];
        if (!t || t.road || t.service) continue;
        if (t.zone === def.id) continue;
        cost += def.cost;
      }
    }
    for (const s of svcPlan) {
      const def = SERVICES[s.id];
      const t = this.tiles[s.tile];
      if (!t || t.service === def.id) continue;
      cost += def.cost;
    }
    if (!this.entrances.includes(gateTile)) cost += TRAFFIC.ENTRANCE_COST;
    if (cost > this.funds) {
      return {
        ok: false,
        msg: '资金不足：这座初级小城约需 ' + Math.round(cost) + ' §，当前只有 ' + Math.round(this.funds) + ' §',
      };
    }

    // ---- 建造（先修路，再放设施，最后分区）----
    for (const r of roadPlan) this.buildRoad(r.tiles, r.type);
    for (const s of svcPlan) this.placeService(s.tile, s.id);
    for (const z of zonePlan) this.zoneTiles(z.tiles, z.type);
    if (!this.entrances.includes(gateTile)) this.addEntrance(gateTile);
    this.rebuildNetwork();
    this.refreshAggregates();
    this.updateCoverage();
    this.computeLandValue();
    this.updateDemand();
    // 快进 3 个游戏日：房子长出来、人口从高速出入口涌进来、第一批车开上路，
    // 玩家点完「一键建城」立刻就能看到车流，而不是干等半天。
    for (let d = 0; d < 3; d++) {
      for (let h = 0; h < 24; h++) { this.advance(60); this.stepTraffic(TRAFFIC.SEC_PER_HOUR); }
    }
    this.speed = 2;                 // 直接给到 2×，车流更明显
    return {
      ok: true,
      msg: '已生成初级小城（-' + Math.round(cost) + ' §）：高速 + 主干道 + 4 个街区 + ' +
        '住宅/商业/工业 + 发电厂/水塔/诊所 + 高速出入口　人口 ' + Math.round(this.stats.population) +
        '，路上已经有车了（速度已设为 2×）',
      cost,
    };
  }

  /**
   * 建造「高速出入口」（对外连接）。
   * 必须建在地图边缘的道路上 —— 相当于城市的高速匝道，
   * 车辆可以从这里开进城市，也可以从这里驶离城市。
   * 有对外连接的城市更容易吸引人口（外来移民）进城工作。
   */
  addEntrance(tileIdx) {
    const t = this.tiles[tileIdx];
    if (!t) return { ok: false, msg: '无效地块' };
    if (!t.road) return { ok: false, msg: '请先在地图边缘的道路上建造出入口' };
    const x = tileIdx % MAP.SIZE, z = Math.floor(tileIdx / MAP.SIZE);
    const onEdge = x === 0 || x === MAP.SIZE - 1 || z === 0 || z === MAP.SIZE - 1;
    if (!onEdge) return { ok: false, msg: '出入口必须建在地图边缘（城市与外界的连接处）' };
    if (this.entrances.includes(tileIdx)) return { ok: false, msg: '这里已经有出入口了' };
    if (!this.canAfford(TRAFFIC.ENTRANCE_COST)) return { ok: false, msg: '资金不足' };
    this.funds -= TRAFFIC.ENTRANCE_COST;
    this.entrances.push(tileIdx);
    this.markDirty(tileIdx);
    this.updateDemand();
    return {
      ok: true,
      msg: '已建造高速出入口（-' + TRAFFIC.ENTRANCE_COST + ' §）　车辆可由此进出城市，' +
        '外来人口更容易流入',
    };
  }

  removeEntrance(tileIdx) {
    const k = this.entrances.indexOf(tileIdx);
    if (k < 0) return false;
    this.entrances.splice(k, 1);
    this.updateDemand();
    return true;
  }

  /** 修改某路段某条车道的类型（layer: 0=地面层, 1=高架层） */
  setLane(tileIdx, laneIndex, layer = 0) {
    const t = this.tiles[tileIdx];
    if (!t) return { ok: false, msg: '无效地块' };
    const over = layer === 1;
    const roadType = over ? t.over : t.road;
    if (!roadType) return { ok: false, msg: '该地块没有道路' };
    const def = ROAD_BY_ID[roadType];
    const n = def.lanes;
    if (laneIndex < 0 || laneIndex >= n) return { ok: false, msg: '车道序号超出范围' };
    const shift = laneIndex * 2;
    // 同一路段（含对向）的所有车道同步切换
    const edgeId = over ? this.net.overTileEdge[tileIdx] : this.net.tileEdge[tileIdx];
    const tilesOfEdge = edgeId >= 0 ? this.net.edges[edgeId].tiles : [tileIdx];
    const key = over ? 'olt' : 'lt';
    let cur = (t[key] || 0) >> shift & 3;
    const next = (cur + 1) % 4;
    for (const ti of tilesOfEdge) {
      const tt = this.tiles[ti];
      const lt = tt[key] || 0;
      tt[key] = (lt & ~(3 << shift)) | (next << shift);
      this.markDirty(ti);
    }
    this.rebuildNetwork();
    return {
      ok: true,
      msg: (over ? '高架' : '') + '车道 ' + (laneIndex + 1) + ' 已改为 ' + LANE_TYPE_LIST[next].name,
      lane: laneIndex, type: next,
    };
  }

  /** 查询地块道路信息（车道类型、高程） */
  roadInfo(tileIdx) {
    const t = this.tiles[tileIdx];
    if (!t || (!t.road && !t.over)) return null;
    const type = t.road || t.over;
    const def = ROAD_BY_ID[type];
    const lanes = [];
    for (let i = 0; i < def.lanes; i++) lanes.push((t.lt >> (i * 2)) & 3);
    const overLanes = [];
    for (let i = 0; i < def.lanes; i++) overLanes.push((t.olt >> (i * 2)) & 3);
    return { type, lanes, overLanes, height: t.h, over: !!t.over, lanesCount: def.lanes };
  }

  setTax(kind, value) {
    const v = Math.max(ECON.MIN_TAX, Math.min(ECON.MAX_TAX, Math.round(value)));
    this.tax[kind] = v;
    this.updateDemand();
    return { ok: true, msg: '税率已调整为 ' + v + '%' };
  }

  markDirty(i) { this.dirty.add(i); }

  // ---------------------------------------------------------------- 统计
  refreshAggregates() {
    const tiles = this.tiles;
    let pop = 0, jobs = 0, res = 0, com = 0, ind = 0, roadTiles = 0, svc = 0;
    this.residentialTiles = []; this.commercialTiles = []; this.industrialTiles = [];
    this.allJobTiles = []; this.serviceTiles = [];
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (t.road) roadTiles++;
      if (t.service) { svc++; this.serviceTiles.push(i); }
      if (t.zone && t.level > 0) {
        const caps = BUILDING_CAPS[t.zone === 1 ? 'res' : t.zone === 2 ? 'com' : 'ind'];
        // 交通拥堵 / 断电断水会折损实际人口与岗位（影响税收与经济）
        const eff = t.eff === undefined ? 1 : t.eff;
        // 再乘以实时入住率：人口 / 岗位是随时在变的连续数值
        const occ = t.occ === undefined ? 1 : t.occ;
        t.pop = t.zone === 1 ? Math.round(caps[t.level] * eff * occ) : 0;
        t.jobs = t.zone === 1 ? 0 : Math.round(caps[t.level] * eff * occ);
        pop += t.pop;
        jobs += t.jobs;
        if (t.zone === 1) { res++; this.residentialTiles.push(i); }
        else if (t.zone === 2) { com++; this.commercialTiles.push(i); this.allJobTiles.push(i); }
        else { ind++; this.industrialTiles.push(i); this.allJobTiles.push(i); }
      } else {
        t.pop = 0; t.jobs = 0;
        if (t.zone === 1) this.residentialTiles.push(i);
        else if (t.zone === 2) this.commercialTiles.push(i);
        else if (t.zone === 3) this.industrialTiles.push(i);
      }
    }
    this.stats.population = pop;
    this.stats.jobs = jobs;
    this.stats.residential = res;
    this.stats.commercial = com;
    this.stats.industrial = ind;
    this.stats.roadTiles = roadTiles;
    this.stats.serviceCount = svc;
    this.stats.unemployment = pop > 0 ? Math.max(0, 1 - jobs / pop) : 0;
    this.stats.comJobs = 0; this.stats.indJobs = 0;
    for (const i of this.commercialTiles) this.stats.comJobs += tiles[i].jobs;
    for (const i of this.industrialTiles) this.stats.indJobs += tiles[i].jobs;
  }

  // ---------------------------------------------------------------- 时钟
  get date() {
    const total = this.tick;
    const day = Math.floor(total / (TIME.HOURS_PER_DAY * 60)) + 1;
    const month = Math.floor((day - 1) / TIME.DAYS_PER_MONTH) + 1;
    const year = Math.floor((month - 1) / 12) + 1;
    const d = ((day - 1) % TIME.DAYS_PER_MONTH) + 1;
    const m = ((month - 1) % 12) + 1;
    const hour = Math.floor((total % (TIME.HOURS_PER_DAY * 60)) / 60);
    const minute = total % 60;
    return { year: 2024 + year, month: m, day: d, hour, minute };
  }

  get hourOfDay() { return Math.floor((this.tick % (TIME.HOURS_PER_DAY * 60)) / 60); }

  /** 推进 dt 游戏秒（交通物理） */
  stepTraffic(gameSeconds) {
    let remaining = gameSeconds;
    let guard = 0;
    while (remaining > 0 && guard++ < TIME.MAX_SUBSTEPS) {
      const dt = Math.min(TIME.TRAFFIC_DT, remaining);
      this.traffic.update(dt, this.tick);
      remaining -= dt;
    }
    if (gameSeconds > 0) {
      this._trafficAccum = (this._trafficAccum || 0) + gameSeconds;
      if (this._trafficAccum >= TRAFFIC.SAMPLE_CONGESTION) {
        this._trafficAccum = 0;
        this.traffic.sample();
      }
    }
  }

  /** 推进 dt 游戏分钟 */
  advance(minutes) {
    // 小数分钟要累积，不能直接丢弃 —— 否则 1x/2x/3x 速度下时钟永远不前进
    this._accMinutes = (this._accMinutes || 0) + minutes;
    const whole = Math.floor(this._accMinutes);
    if (whole <= 0) return;
    this._accMinutes -= whole;
    const prevTick = this.tick;
    this.tick += whole;
    const hoursCrossed = Math.floor(this.tick / 60) - Math.floor(prevTick / 60);
    if (hoursCrossed > 0) {
      for (let h = 0; h < hoursCrossed; h++) {
        // 出行需求由「交通时钟」自行驱动（见 traffic.update），此处只处理经济侧
        this.updateCoverage();
        this.computeLandValue();
        this.updateGrowth();
        this.traffic.computeParkedCars();
        this.updateEfficiency();
        this.updateDemand();
      }
    } else {
      // 未跨整点：若是新建/读档后的第一段时间，补一次出行强度，保证立即有车流
      this.traffic.ensureTripRate();
    }
    // 入住率每分钟微调 -> 人口 / 岗位是随时在变的连续数值
    this.updateOccupancy(whole);
    // 人口账本：移民（外来车辆）+ 新生儿 -> 人口；死亡 + 迁出 -> 人口减少
    this.updateDemography(whole);
    // 事件系统：火灾 / 犯罪 / 疾病 / 事故（需要特种车辆去处理）
    this.events.update(whole);
    // 车队规模跟随人口（家庭购车 / 老车报废）
    this.traffic.syncFleet();
    this.refreshAggregates();
    // 资金按分钟持续结算 -> 面板上的钱随时都在动
    this.accrueBudget(whole / 60);
    const daysCrossed = Math.floor(this.tick / 1440) - Math.floor(prevTick / 1440);
    if (daysCrossed > 0) this.updateDaily();
    const monthsCrossed = Math.floor(this.tick / 43200) - Math.floor(prevTick / 43200);
    if (monthsCrossed > 0) this.updateMonthly(monthsCrossed);
    this.updatedAt = Date.now();
  }

  updateDaily() {
    this.updateHappiness();
  }

  /**
   * 人口账本 —— 人口不会凭空出现或消失：
   *   来源：① 外来车辆（高速出入口开进来的移民）　② 新生儿
   *   出口：① 死亡　② 迁出（车开出城）
   */
  updateDemography(minutes) {
    const dem = this.demography;
    const hours = minutes / 60;
    const entrances = this.entrances || [];

    // --- 新生儿 ---
    // 学校（教育水平）会提高出生率：人口也来自「新生儿」
    const edu = this.educationFactor();
    if (dem.pop > 0) {
      dem._birthAcc += dem.pop * DEMOGRAPHY.BIRTH_RATE_PER_HOUR * edu * hours;
      while (dem._birthAcc >= 1) {
        dem._birthAcc -= 1;
        dem.births++;
        dem.pop++;
        dem.waiting++;          // 新生儿也要住房
      }
    }

    // --- 死亡 ---
    if (dem.pop > 0) {
      dem._deathAcc += dem.pop * DEMOGRAPHY.DEATH_RATE_PER_HOUR * hours;
      while (dem._deathAcc >= 1) {
        dem._deathAcc -= 1;
        dem.deaths++;
        dem.pop = Math.max(0, dem.pop - 1);
        if (dem.waiting > 0) dem.waiting--;
      }
    }

    // --- 移民：外来车辆从高速出入口开进来（没有出入口就没有移民）---
    if (entrances.length) {
      const jobs = this.stats.jobs || 0;
      const jobFactor = Math.min(DEMOGRAPHY.IMMIGRATION_JOB_FACTOR,
        (jobs + 25) / Math.max(45, dem.pop * 0.5));
      // 幸福度低的城市没人愿意来（堵车、缺服务 -> 人口流失）
      const happyNow = this.stats.happiness === undefined ? 70 : this.stats.happiness;
      const happyFactor = Math.max(0, Math.min(1, (happyNow - 20) / 45));
      const base = DEMOGRAPHY.IMMIGRATION_BASE_PER_HOUR * jobFactor;
      const cap = DEMOGRAPHY.IMMIGRATION_MAX_PER_HOUR;
      const rate = Math.min(cap, base * happyFactor) * entrances.length;
      dem._immigAcc += rate * hours;
      while (dem._immigAcc >= 1) {
        dem._immigAcc -= 1;
        // 让交通系统真的开一辆车进来（车到了城里，人就住下了）
        // 人口在车真正抵达新家时才计入（见 onImmigrantsArrive），避免重复计数
        if (!this.traffic.spawnImmigrantCar()) { dem._immigAcc = 0; break; }   // 没有可用通道 -> 暂停接纳
      }
    }

    // --- 迁出：幸福度低 -> 有人开车离开城市 ---
    const happy = this.stats.happiness === undefined ? 70 : this.stats.happiness;
    const unhappy = Math.max(0, (70 - happy) / 70);
    const emRate = dem.pop * DEMOGRAPHY.EMIGRATION_RATE_PER_HOUR *
      (1 + unhappy * DEMOGRAPHY.EMIGRATION_UNHAPPY_FACTOR);
    dem._emigAcc = (dem._emigAcc || 0) + emRate * hours;
    while (dem._emigAcc >= 1) {
      dem._emigAcc -= 1;
      if (!this.traffic.dispatchEmigrant()) { dem._emigAcc = 0; break; }
    }

    dem.housed = Math.max(0, dem.pop - dem.waiting);
  }

  /** 移民抵达：车上的人成为城市居民（等待安置 -> 找房子住） */
  onImmigrantsArrive(n) {
    const dem = this.demography;
    dem.immigrants += n;
    dem.pop += n;
    dem.waiting += n;
    dem.housed = Math.max(0, dem.pop - dem.waiting);
  }

  /** 教育水平（学校数量决定的出生率加成） */
  educationFactor() {
    let schools = 0;
    for (const i of this.serviceTiles || []) if (this.tiles[i].service === 4) schools++;
    return 1 + Math.min(0.8, schools * 0.18);
  }

  /** 迁出：车开出城，车上的人离城 */
  onEmigrantsLeave(n) {
    const dem = this.demography;
    dem.emigrants += n;
    dem.pop = Math.max(0, dem.pop - n);
    dem.waiting = Math.max(0, dem.waiting - n);
    dem.housed = Math.max(0, dem.pop - dem.waiting);
  }

  /** 依据现有特种建筑重建特种车队（读档 / 旧存档用：车随建筑来） */
  rebuildSpecialFleet() {
    this.traffic.specials = [];
    this.traffic.fleet.special = 0;
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      if (!t.service) continue;
      this.traffic.onServiceBuilt(i, t.service);
    }
  }

  updateMonthly(months = 1) {
    for (let m = 0; m < months; m++) this.processBudget();
  }

  // ---------------------------------------------------------------- 快照
  snapshot() {
    return {
      v: 1,
      id: this.id, name: this.name, seed: this.seed,
      tick: this.tick, funds: this.funds, tax: this.tax, speed: this.speed,
      trafficT: Math.round(this.traffic.t || 0),
      entrances: (this.entrances || []).slice(),
      terrain: Array.from(this.terrain),
      demography: {
        pop: this.demography.pop, housed: this.demography.housed,
        waiting: this.demography.waiting, births: this.demography.births,
        deaths: this.demography.deaths, immigrants: this.demography.immigrants,
        emigrants: this.demography.emigrants,
      },
      tiles: this.tiles.map((t) => [
        t.zone, t.level, t.road, t.service, Math.round(t.land),
        t.power ? 1 : 0, t.water ? 1 : 0,
        Math.round((t.h || 0) * 10) / 10, t.lt || 0, t.over || 0, t.olt || 0,
        Math.round((t.occ === undefined ? (t.level ? 1 : 0) : t.occ) * 255),
      ]),
      ledger: this.ledger.slice(-240),
      createdAt: this.createdAt,
    };
  }

  static restore(data) {
    const city = new City({ id: data.id, name: data.name, seed: data.seed, funds: data.funds, tax: data.tax });
    city.tick = data.tick | 0;
    city.tiles.forEach((t, i) => {
      const a = data.tiles[i] || [0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0];
      t.zone = a[0]; t.level = a[1]; t.road = a[2]; t.service = a[3];
      t.land = a[4]; t.power = !!a[5]; t.water = !!a[6];
      t.h = a[7] || 0; t.lt = a[8] || 0; t.over = a[9] || 0;
      t.olt = a[10] || 0;
      t.occ = a.length > 11 ? (a[11] / 255) : (t.level ? 1 : 0);
    });
    city.ledger = data.ledger || [];
    // 人口账本：老存档没有账本 -> 用地块里已有的人口初始化一次
    if (data.demography) {
      city.demography.pop = data.demography.pop || 0;
      city.demography.housed = data.demography.housed || 0;
      city.demography.waiting = data.demography.waiting || 0;
      city.demography.births = data.demography.births || 0;
      city.demography.deaths = data.demography.deaths || 0;
      city.demography.immigrants = data.demography.immigrants || 0;
      city.demography.emigrants = data.demography.emigrants || 0;
    }
    city.rebuildNetwork();
    city.refreshAggregates();
    if (!city.demography.pop && city.stats.population > 0) {
      // 老存档 / 旧版城市：把已有的人口搬进账本，人口不会归零
      city.demography.pop = city.stats.population;
      city.demography.housed = city.stats.population;
    }
    // 特种建筑 -> 特种车辆（车随建筑来）
    city.rebuildSpecialFleet();
    city.updateCoverage();
    city.updateEfficiency();
    city.computeLandValue();
    city.updateDemand();
    // 读档后立即按当前时段恢复出行强度（否则要等到下一个整点才有车）
    city.entrances = (data.entrances || []).slice();
    city.traffic.t = data.trafficT || (TRAFFIC.SEC_PER_HOUR * 8);
    city.traffic.hour = Math.floor(city.traffic.t / TRAFFIC.SEC_PER_HOUR) % 24;
    city.traffic._tripHour = city.traffic.hour;
    city.traffic.ensureTripRate();
    return city;
  }
}

// 将 development 模块的方法以 City 实例为 this 绑定
for (const [key, fn] of Object.entries(development)) {
  City.prototype[key] = function (...args) { return fn.call(this, this, ...args); };
}
