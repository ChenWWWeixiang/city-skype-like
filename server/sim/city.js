// ============================================================================
//  城市主体：地块状态、游戏时钟、玩家指令
// ============================================================================
import {
  MAP, TIME, ROADS, ZONES, ECON, SERVICES, SERVICE_BY_ID,
  BUILDING_CAPS, TRAFFIC, LAND, TERRAIN, ELEV, LANE_TYPE_LIST, DEMOGRAPHY, hash2, SIGNAL,
} from './constants.js';
import { buildNetwork, tileIndex, pathDirMasks } from './roadnet.js';
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
    this.flat = !!opts.flat;      // 平地（无起伏）：测试与「平原城市」用
    // 自定义山体（示范城用）：[{x,z,r,h}] —— 指定了就不用随机山峰，
    // 这样「隧道正好从山中间穿过去」是可复现的（不会随机跑到平地上）。
    this.customPeaks = Array.isArray(opts.peaks) ? opts.peaks.map((p) => ({ ...p })) : null;
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
      // 每小时速率（人口随时在变 —— 面板上要能看到「涨/跌多少」）
      rate: { birth: 0, death: 0, immig: 0, emig: 0, net: 0 },
      _immigAcc: 0,    // 移民累积器
      _deathAcc: 0,
      _birthAcc: 0,
      _rBirth: 0, _rDeath: 0, _rImmig: 0, _rEmig: 0,
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
    // 财政结算步长（游戏分钟）：每 N 分钟把累计收支写进流水一次
    this.settleMinutes = ECON.SETTLE_MINUTES;
    // 城市设置（信号灯方案等）
    this.settings = { signalMode: SIGNAL.MODE.AUTO, routing: 'static' };
    this._settleAcc = 0;
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
    // 河流：南北走向，位于地图东侧（x ≈ 39）。
    // 地图被一条大河切成两半 —— 想把路修到东岸，就必须修桥。
    for (let x = 0; x < S; x++) {
      const c = 38.6 + Math.sin(x * 0.145 + (s % 11) * 0.7) * 3.0 + Math.sin(x * 0.33 + 1.7) * 1.3;
      const w = 1.55 + 0.7 * Math.sin(x * 0.21 + 1.1);
      for (let z = 0; z < S; z++) {
        if (Math.abs(x - c) < w) this.terrain[tileIndex(x, z)] = TERRAIN.water;
      }
    }
    // 一个小湖（西侧，靠主城区）—— 过湖要修桥
    for (let z = 20; z < 27; z++) {
      for (let x = 2; x < 8; x++) {
        const d = Math.hypot((x - 4.4) / 2.6, (z - 23.0) / 3.0);
        if (d < 1 + 0.25 * Math.sin(x * 2 + z)) this.terrain[tileIndex(x, z)] = TERRAIN.water;
      }
    }
    this._genHeight();
  }

  /**
   * 地形高程：山丘 + 河谷。
   * 高程决定道路能不能修 —— 相邻路段高差超过 MAX_RAMP(15% 坡度) 就修不了，
   * 玩家必须「绕山而行」；水面上的路自动变成桥。
   */
  _genHeight() {
    const S = MAP.SIZE;
    const s = this.seed;
    const noise = (x, z, f, sd) => {
      const xi = Math.floor(x), zi = Math.floor(z);
      const xf = x - xi, zf = z - zi;
      const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
      const a = hash2(xi, zi, sd), b = hash2(xi + 1, zi, sd);
      const c = hash2(xi, zi + 1, sd), d = hash2(xi + 1, zi + 1, sd);
      return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
    };
    const h = new Float32Array(S * S);
    // 1) 平原：起伏平缓（坡度普遍 < 10%），可以放心修路
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const i = z * S + x;
        if (this.flat) { h[i] = 0; continue; }   // 平地（测试用）
        let v = 0;
        v += 4.6 * noise(x * 0.034, z * 0.034, 1, s);          // 大地形（连绵的丘陵）
        v += 2.6 * noise(x * 0.088, z * 0.088, 1, s + 31);     // 中丘
        v += 0.9 * noise(x * 0.215, z * 0.215, 1, s + 77);     // 小起伏
        v += 0.25 * noise(x * 0.47, z * 0.47, 1, s + 131);     // 微地形
        // 盆地：地图中部（玩家起手区）地势低平，越靠边缘越抬高
        const d = Math.hypot(x - S * 0.46, z - S * 0.46);
        const u = Math.max(0, Math.min(1, (d - 14) / 17));
        v += 9 * Math.pow(u, 1.35);
        h[i] = Math.max(0, v);
      }
    }
    // 2) 山脉：坡度超过 22% —— 修不了路，必须绕山而行（或挖隧道穿过去）
    for (const p of (this.flat ? [] : (this.customPeaks || this._genPeaks()))) {
      const x0 = Math.max(0, Math.floor(p.x - p.r)), x1 = Math.min(S - 1, Math.ceil(p.x + p.r));
      const z0 = Math.max(0, Math.floor(p.z - p.r)), z1 = Math.min(S - 1, Math.ceil(p.z + p.r));
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const dd = Math.hypot(x - p.x, z - p.z);
          if (dd >= p.r) continue;
          const t = 1 - dd / p.r;
          h[z * S + x] += p.h * Math.pow(t, 1.45);
        }
      }
    }
    // 2.5) 城郊小丘：让城区周边也有起伏（不影响主干道的坡度）
    if (!this.flat) {
      const hills = [[34, 12, 2.8, 12], [34, 33, 2.8, 13], [2.5, 32, 2.8, 10], [14, 36, 2.6, 9]];
      for (const [hx, hz, hr, hh] of hills) {
        for (let z = Math.max(0, Math.floor(hz - hr)); z <= Math.min(S - 1, Math.ceil(hz + hr)); z++) {
          for (let x = Math.max(0, Math.floor(hx - hr)); x <= Math.min(S - 1, Math.ceil(hx + hr)); x++) {
            const dd = Math.hypot(x - hx, z - hz);
            if (dd >= hr) continue;
            const t = 1 - dd / hr;
            h[z * S + x] += hh * Math.pow(t, 1.3);
          }
        }
      }
    }
    // 3) 河岸 / 湖岸：水边留出缓坡，岸边高度固定为「刚好高出水面」
    const dist = new Int16Array(S * S).fill(999);
    const queue = [];
    for (let i = 0; i < S * S; i++) {
      if (this.terrain[i] === TERRAIN.water) { dist[i] = 0; queue.push(i); }
    }
    let head = 0;
    while (head < queue.length) {
      const i = queue[head++];
      const x = i % S, z = Math.floor(i / S);
      const nb = [[x, z - 1], [x + 1, z], [x, z + 1], [x - 1, z]];
      for (const [nx, nz] of nb) {
        if (nx < 0 || nz < 0 || nx >= S || nz >= S) continue;
        const ni = nz * S + nx;
        if (dist[ni] > dist[i] + 1) { dist[ni] = dist[i] + 1; queue.push(ni); }
      }
    }
    for (let i = 0; i < S * S; i++) {
      const d = dist[i];
      if (d === 0) { h[i] = ELEV.RIVER_BED; continue; }
      if (d <= ELEV.BANK_TILES) {
        // 河岸：线性缓坡，保证岸边每格高差都在坡度上限内（引桥才接得上桥面）
        const k = Math.min(1, (d - 1) / ELEV.BANK_TILES);
        h[i] = ELEV.BANK_TOP + (h[i] - ELEV.BANK_TOP) * k;
      }
    }
    this.height = h;
  }

  /** 山峰位置（确定性的，随种子变化）：主要分布在地图外围，中央留给玩家建城 */
  _genPeaks() {
    const S = MAP.SIZE;
    const s = this.seed;
    // 山岭分布：地图四周 + 中间的几座「城郊山丘」（隧道/绕行都用得上）
    const spots = [
      [0.03, 0.03], [0.93, 0.08], [0.94, 0.60], [0.10, 0.80], [0.42, 0.95],
    ];
    const peaks = [];
    for (let k = 0; k < spots.length; k++) {
      peaks.push({
        x: (spots[k][0] + (hash2(k, 1, s) - 0.5) * 0.05) * S,
        z: (spots[k][1] + (hash2(k, 2, s) - 0.5) * 0.05) * S,
        r: 3.6 + hash2(k, 3, s) * 2.6,
        h: 16 + hash2(k, 4, s) * 15,
      });
    }
    return peaks;
  }

  /** 地块地形高度（米） */
  elevAt(i) { return this.height ? (this.height[i] || 0) : 0; }

  /** 住宅总容量（能住多少人） */
  housingCapacity() {
    const caps = BUILDING_CAPS.res;
    let cap = 0;
    for (const i of this.residentialTiles || []) {
      const t = this.tiles[i];
      if (!t.level) continue;
      const eff = t.eff === undefined ? 1 : t.eff;
      cap += caps[t.level] * eff;
    }
    return cap;
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
        roadH: 0,      // 地面路面高程 (m)：随地形起伏 / 桥面 / 隧道
        bridge: 0,     // 1 = 桥（跨水）
        tunnel: 0,     // 1 = 隧道（路面在地面以下）
        lt: 0,         // 车道类型打包（每车道 2 bit）
        olt: 0,        // 高架层车道类型打包
        rd: 0,         // 地面道路走向位掩码（8 方向）：路网按它连通
        od: 0,         // 高架道路走向位掩码
        hcap: 0,      // 高度上限（0 = 不限）：限制这块地最高能盖到几级
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
    // 记录「这条路实际往哪走」—— 路网按它连通。
    // 之前靠「看邻居有没有路」推断，斜向道路旁边会凭空多出斜向捷径，
    // 在街区中间造出一个假的路口（多一个红绿灯 = 多一处堵点）。
    const dirMasks = pathDirMasks(tileList.filter((i) => i >= 0 && i < this.tiles.length));
    const dirKey = elevated ? 'od' : 'rd';
    const applyDirs = () => {
      for (const [i, m] of dirMasks) {
        const t = this.tiles[i];
        if (!t) continue;
        t[dirKey] = (t[dirKey] | 0) | m;
      }
    };
    // --- 坡度 / 桥 / 隧道 判定（自然规律：太陡修不了路，跨水自动成桥）---
    let plan = null;
    if (!elevated) {
      // 用完整的绘制路径算高程剖面（valid 里可能跳过了「已经是同款路」的地块）
      plan = this._planRoadHeights(tileList.filter((i) => i >= 0 && i < this.tiles.length), { tunnel: !!opts.tunnel });
      if (!plan.ok) return { ok: false, msg: plan.msg };
    }
    if (!this.canAfford(cost)) return { ok: false, msg: '资金不足' };
    this.funds -= cost;
    if (elevated) {
      // 高架道路：两端设坡道，中部抬升形成立体交叉（地面道路保持在下层）
      const n = valid.length;
      // 桥面高度：
      //   opts.height 显式指定（高架环线必须整圈等高，否则接缝会断开）
      //   否则取该段最高地面 + 标准桥高
      let deckH = opts.height;
      if (deckH === undefined) {
        let maxG = -Infinity;
        for (const i of valid) maxG = Math.max(maxG, this.elevAt(i));
        deckH = maxG + ELEV.BRIDGE_HEIGHT;
      }
      // 匝道（ramp）：一端贴地面（接地面路），另一端爬到高架高度（接高架）
      // —— 没有匝道，高架高速就是个「两头堵死的空中楼阁」，谁也上不去
      if (opts.ramp && n >= 2) {
        const up = opts.ramp === 'up';
        const startTile = up ? valid[0] : valid[n - 1];
        const endTile = up ? valid[n - 1] : valid[0];
        const hStart = (this.tiles[startTile].road && this.tiles[startTile].roadH !== undefined)
          ? this.tiles[startTile].roadH : this.elevAt(startTile);
        const endT = this.tiles[endTile];
        // 匝道顶端必须与高架板严丝合缝：优先用已建成的高架板高度
        const hEnd = opts.height !== undefined ? opts.height
          : (endT.over ? (endT.h || 0) : (hStart + ELEV.BRIDGE_HEIGHT));
        const rise = Math.abs(hEnd - hStart);
        if (rise > ELEV.MAX_RAMP * (n - 1) + 0.01) {
          return { ok: false, msg: '匝道太短，坡度超过 ' + Math.round(ELEV.MAX_RAMP / MAP.TILE * 100) + '%（请修长一点）' };
        }
        for (let k = 0; k < n; k++) {
          const i = valid[k];
          const t = this.tiles[i];
          if (!t.road) { t.zone = 0; t.level = 0; t.service = 0; }
          t.over = roadType;
          const u = up ? k / (n - 1) : 1 - k / (n - 1);
          t.h = hStart + (hEnd - hStart) * u;
          t.olt = 0;
          this.markDirty(i);
        }
        applyDirs();
        this.rebuildNetwork();
        this.refreshAggregates();
        return { ok: true, msg: '已架设高架匝道（-' + Math.round(cost) + ' §）', cost };
      }
      // 纯高架板（deck）：整段等高，两端的坡道由独立的匝道负责
      // —— 这是「高架环线」的做法：环线一圈都是平的，靠 4 条匝道上下。
      if (opts.deck) {
        for (let k = 0; k < n; k++) {
          const i = valid[k];
          const t = this.tiles[i];
          if (!t.road) { t.zone = 0; t.level = 0; t.service = 0; }
          t.over = roadType;
          t.h = deckH;
          t.olt = 0;
          this.markDirty(i);
        }
        applyDirs();
        this.rebuildNetwork();
        this.refreshAggregates();
        return {
          ok: true,
          msg: '已架设高架板（-' + Math.round(cost) + ' §，桥面高 ' + deckH.toFixed(1) + ' m）' +
            '　提示：两端需要匝道接上地面道路才能通车',
          cost,
        };
      }
      const profile = heightProfile(n, ELEV.BRIDGE_HEIGHT, ELEV.RAMP_TILES);
      // 桥面本身要平（两端等高、中间一段平台），这样跨过地面路才像真正的立交
      const endH = (i) => {
        const t = this.tiles[i];
        return (t.road && t.roadH !== undefined) ? t.roadH : this.elevAt(i);
      };
      const hA = endH(valid[0]), hB = endH(valid[n - 1]);
      for (let k = 0; k < n; k++) {
        const i = valid[k];
        const t = this.tiles[i];
        if (!t.road) { t.zone = 0; t.level = 0; t.service = 0; }
        t.over = roadType;
        // 基准面：两端与地面道路等高，中间按直线插值（桥面不会跟着地形起伏）
        const base = n > 1 ? hA + (hB - hA) * (k / (n - 1)) : hA;
        t.h = base + profile[k];
        t.olt = 0;
        this.markDirty(i);
      }
      applyDirs();
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
      const ph = plan && plan.heights.has(i) ? plan.heights.get(i) : this.elevAt(i);
      t.roadH = ph;                                            // 路面高程（随地形起伏）
      t.bridge = (t.terrain === TERRAIN.water && !opts.tunnel) ? 1 : 0;  // 跨水 -> 桥
      t.tunnel = opts.tunnel ? 1 : 0;
      this.markDirty(i);
    }
    applyDirs();
    this.rebuildNetwork();
    this.refreshAggregates();
    return {
      ok: true,
      msg: (upgrade ? '已升级 ' + upgrade + ' 处为' : '已建造 ') +
        def.name + '（-' + Math.round(cost) + ' §）' + (plan && plan.note ? '　' + plan.note : ''),
      cost,
    };
  }

  /**
   * 计算一段新路的路面高程，并做「自然规律」检查：
   *   1. 坡度：相邻路段高差超过 MAX_RAMP（15% 坡度）就修不了 —— 必须绕山；
   *   2. 跨水：水面上的路自动变成桥，桥面要留出净空；
   *   3. 桥上不能有路口：桥格最多只能有 2 个连接（只能直行通过）；
   *   4. 隧道：路面在地面以下，入口用坡道接回地面，中段是平滑的隧道断面。
   */
  _planRoadHeights(tiles, opts = {}) {
    const S = MAP.SIZE;
    const tunnel = !!opts.tunnel;
    const heights = new Map();
    const newSet = new Set(tiles);
    const n = tiles.length;
    const NEI = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    if (!n) return { ok: false, msg: '没有可施工的地块' };

    // ---------- 隧道：路面在地面以下，两端用坡道接回地面 ----------
    if (tunnel) {
      for (const i of tiles) {
        if (this.tiles[i].terrain === TERRAIN.water) {
          return { ok: false, msg: '隧道不能穿水（跨水请修桥）' };
        }
      }
      // 地面线（平滑后）+ 两端贴地的下沉曲线
      const nat = tiles.map((i) => this.elevAt(i));
      // --- 约束点：隧道两端 + 与已有道路相接处，路面高度必须与已有道路一致 ---
      const cons = new Map();
      const addCons = (k, h) => { if (!cons.has(k)) cons.set(k, h); };
      // 先收集「与已有道路接驳处」的高度（优先级最高），
      // 端点若没有接驳道路，再用地面高度兜底。
      for (let k = 0; k < n; k++) {
        const i = tiles[k];
        const x = i % S, z = Math.floor(i / S);
        for (const nb of NEI) {
          const nx = x + nb[0], nz = z + nb[1];
          if (nx < 0 || nz < 0 || nx >= S || nz >= S) continue;
          const ni = nz * S + nx;
          if (newSet.has(ni)) continue;
          const nt = this.tiles[ni];
          if (!nt || !nt.road) continue;
          addCons(k, nt.roadH === undefined ? this.elevAt(ni) : nt.roadH);
        }
      }
      if (!cons.has(0)) cons.set(0, nat[0]);
      if (!cons.has(n - 1)) cons.set(n - 1, nat[n - 1]);
      const consArr = [...cons.entries()].sort((a, b) => a[0] - b[0]);
      const alignAt = (k) => {
        if (consArr.length === 1) return consArr[0][1];
        if (k <= consArr[0][0]) {
          const [k0, h0] = consArr[0], [k1, h1] = consArr[1];
          return h0 + (h1 - h0) * (k - k0) / Math.max(1, (k1 - k0));
        }
        const last = consArr[consArr.length - 1];
        if (k >= last[0]) {
          const [k0, h0] = consArr[consArr.length - 2], [k1, h1] = last;
          return h1 + (h1 - h0) * (k - k1) / Math.max(1, (k1 - k0));
        }
        for (let i = 0; i < consArr.length - 1; i++) {
          const [k0, h0] = consArr[i], [k1, h1] = consArr[i + 1];
          if (k >= k0 && k <= k1) return h0 + (h1 - h0) * (k - k0) / Math.max(1, (k1 - k0));
        }
        return nat[0];
      };
      const align = nat.map((_, k) => alignAt(k));
      const exc = nat.map((v, k) => v - align[k]);
      const sm = exc.slice();
      const R = 2;
      for (let k = 0; k < n; k++) {
        let sum = 0, cnt = 0;
        for (let j = Math.max(0, k - R); j <= Math.min(n - 1, k + R); j++) { sum += exc[j]; cnt++; }
        sm[k] = sum / cnt;
      }
      const prof = new Array(n);
      for (let k = 0; k < n; k++) {
        // 离约束点越远越深（约束点处路面与已有道路齐平）
        let dmin = 1e9;
        for (const [ck] of consArr) { const d = Math.abs(k - ck); if (d < dmin) dmin = d; }
        // 下沉深度受坡度限制：离约束点 dmin 格，最多下沉 dmin * MAX_RAMP
        const maxDrop = Math.min(ELEV.TUNNEL_DEPTH, dmin * ELEV.MAX_RAMP);
        prof[k] = align[k] - Math.min(Math.max(0, sm[k]), maxDrop);
      }
      // 坡度限制：相邻两格高差必须 <= MAX_RAMP（否则路网会在此断开，车过不去）
      // 乘 0.96 留一点余量，避免浮点误差把路网掐断
      const limit = (k) => ELEV.MAX_RAMP * 0.96 * this._tileStep(tiles[k - 1], tiles[k]);
      for (let k = 1; k < n; k++) {
        const lim = limit(k);
        if (prof[k] - prof[k - 1] > lim) prof[k] = prof[k - 1] + lim;
        else if (prof[k - 1] - prof[k] > lim) prof[k] = prof[k - 1] - lim;
      }
      for (let k = n - 2; k >= 0; k--) {
        const lim = limit(k + 1);
        if (prof[k] - prof[k + 1] > lim) prof[k] = prof[k + 1] + lim;
        else if (prof[k + 1] - prof[k] > lim) prof[k] = prof[k + 1] - lim;
      }
      for (let k = 1; k < n; k++) {
        const step = this._tileStep(tiles[k - 1], tiles[k]);
        if (Math.abs(prof[k] - prof[k - 1]) > ELEV.MAX_RAMP * step + 0.01) {
          return { ok: false, msg: '隧道坡度太大（入口离山太远），请把隧道修长一点' };
        }
      }
      for (let k = 0; k < n; k++) heights.set(tiles[k], prof[k]);
      const bad = this._checkAgainstExisting(tiles, heights, ELEV.MAX_RAMP);
      if (bad) return { ok: false, msg: bad };
      return { ok: true, heights, note: '隧道（路面在地面以下）' };
    }

    // ---------- 地面道路 / 桥 ----------
    // 1) 目标高度：陆地 = 地面高程；水面 = 桥面（离水面留净空）
    const isWater = (i) => this.tiles[i].terrain === TERRAIN.water;
    const target = new Array(n);
    for (let k = 0; k < n; k++) {
      target[k] = isWater(tiles[k]) ? ELEV.BRIDGE_CLEARANCE : this.elevAt(tiles[k]);
    }
    // 2) 引道：紧贴水面的陆地格如果低于「桥面 - 一格最大爬升」，就抬高成引桥
    const approach = ELEV.BRIDGE_CLEARANCE - ELEV.MAX_RAMP;
    for (let k = 0; k < n; k++) {
      if (isWater(tiles[k])) continue;
      const nearWater = (k > 0 && isWater(tiles[k - 1])) || (k < n - 1 && isWater(tiles[k + 1]));
      if (nearWater && target[k] < approach) target[k] = approach;
    }
    // 3) 坡度检查（沿路径）
    for (let k = 1; k < n; k++) {
      const step = this._tileStep(tiles[k - 1], tiles[k]);
      const diff = Math.abs(target[k] - target[k - 1]);
      if (diff > ELEV.MAX_RAMP * step) {
        return {
          ok: false,
          msg: '坡度超过 ' + Math.round(ELEV.MAX_RAMP / MAP.TILE * 100) +
            '%（自然规律：这里修不了路，请绕山而行，或改修隧道穿过去）',
        };
      }
    }
    for (let k = 0; k < n; k++) heights.set(tiles[k], target[k]);
    // 4) 与已有道路的高差（接驳处也要满足坡度）
    const bad = this._checkAgainstExisting(tiles, heights, ELEV.MAX_RAMP);
    if (bad) return { ok: false, msg: bad };

    // 5) 桥上不能有路口
    const connCount = (i) => {
      let c = 0;
      const x = i % S, z = Math.floor(i / S);
      for (const nb of NEI) {
        const nx = x + nb[0], nz = z + nb[1];
        if (nx < 0 || nz < 0 || nx >= S || nz >= S) continue;
        const ni = nz * S + nx;
        if (newSet.has(ni) || (this.tiles[ni] && this.tiles[ni].road)) c++;
      }
      return c;
    };
    const isBridgeTile = (i) => {
      if (newSet.has(i)) return this.tiles[i].terrain === TERRAIN.water;
      const t = this.tiles[i];
      return !!(t && t.road && t.terrain === TERRAIN.water);
    };
    const bridgeFail = '桥上不能有路口：跨水路段只能直行通过（请另修一条路绕行）';
    for (const i of tiles) {
      if (isBridgeTile(i) && connCount(i) > 2) return { ok: false, msg: bridgeFail };
      // 已有桥格被新路段接入，也会变成路口
      const x = i % S, z = Math.floor(i / S);
      for (const nb of NEI) {
        const nx = x + nb[0], nz = z + nb[1];
        if (nx < 0 || nz < 0 || nx >= S || nz >= S) continue;
        const ni = nz * S + nx;
        if (newSet.has(ni)) continue;
        if (isBridgeTile(ni) && connCount(ni) > 2) return { ok: false, msg: bridgeFail };
      }
    }
    let note = '';
    for (const i of tiles) if (isWater(i)) { note = '跨水路段已架桥（桥上不能有路口）'; break; }
    return { ok: true, heights, note };
  }

  /** 两格之间的「格距」（斜线算 √2 倍，坡度限制按距离换算） */
  _tileStep(a, b) {
    const S = MAP.SIZE;
    const dx = (a % S) - (b % S);
    const dz = Math.floor(a / S) - Math.floor(b / S);
    return Math.max(1, Math.hypot(dx, dz));
  }

  /** 新路段与「已有道路」之间的高差检查（接驳处也要满足坡度） */
  _checkAgainstExisting(tiles, heights, limit) {
    const S = MAP.SIZE;
    const newSet = new Set(tiles);
    const NEI = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (const i of tiles) {
      const h = heights.get(i);
      const x = i % S, z = Math.floor(i / S);
      for (const nb of NEI) {
        const nx = x + nb[0], nz = z + nb[1];
        if (nx < 0 || nz < 0 || nx >= S || nz >= S) continue;
        const ni = nz * S + nx;
        if (newSet.has(ni)) continue;
        const nt = this.tiles[ni];
        if (!nt || !nt.road) continue;
        const nh = nt.roadH === undefined ? this.elevAt(ni) : nt.roadH;
        if (Math.abs(h - nh) > limit) {
          if (process.env.CITY_DEBUG) console.error('[check] tile', x + ',' + z, 'h=' + h.toFixed(2), 'neighbor', nx + ',' + nz, 'nh=' + nh.toFixed(2), 'limit', limit);
          return '与已有道路的高差超过 ' + Math.round(limit / MAP.TILE * 100) +
            '%（坡度太陡，请绕山而行）';
        }
      }
    }
    return null;
  }

  /** 让已有道路的高程平缓过渡（老存档从「平面地形」升级过来时用） */
  _relaxRoadHeights() {
    const S = MAP.SIZE;
    const NEI = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (let it = 0; it < 10; it++) {
      let moved = false;
      for (let z = 0; z < S; z++) {
        for (let x = 0; x < S; x++) {
          const i = z * S + x;
          const t = this.tiles[i];
          if (!t.road) continue;
          let sum = 0, n = 0;
          for (const nb of NEI) {
            const nx = x + nb[0], nz = z + nb[1];
            if (nx < 0 || nz < 0 || nx >= S || nz >= S) continue;
            const nt = this.tiles[nz * S + nx];
            if (!nt.road) continue;
            sum += nt.roadH; n++;
          }
          if (!n) continue;
          const avg = sum / n;
          if (Math.abs(avg - t.roadH) > ELEV.MAX_RAMP * 0.5) {
            t.roadH += (avg - t.roadH) * 0.35;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
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
        t.rd = 0; t.od = 0; t.lt = 0; t.olt = 0; t.roadH = 0; t.bridge = 0; t.tunnel = 0;
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
      { tile: T(14, 26), id: 'police' },     // 警察局：处理犯罪（否则罚款 + 幸福度下降）
      { tile: T(26, 16), id: 'fire' },       // 消防站：处理火灾（否则房子会烧掉）
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
      for (let h = 0; h < 24; h++) {
        this.advance(60);
        this.stepTraffic(TIME.TRAFFIC_PER_GAME_HOUR);
      }
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

  /** 切换选路方式：static = 按限速最短路（最快到达）/ adaptive = 动态绕开拥堵 */
  setRouting(mode) {
    const m = mode === 'adaptive' ? 'adaptive' : 'static';
    this.settings.routing = m;
    return {
      ok: true,
      msg: m === 'adaptive'
        ? '选路方式：动态绕行（车辆会主动躲开已经堵死的路段）'
        : '选路方式：按限速最短路（车辆按限速算最快到达，堵车由交通流自己跑出来）',
    };
  }

  /** 切换信号灯方案（四向分相 / 对向通行 / 自动） */
  setSignalMode(mode) {
    const m = Number(mode);
    if (!SIGNAL.MODE_LIST.some((x) => x.id === m)) return { ok: false, msg: '未知的信号灯方案' };
    this.settings.signalMode = m;
    this.traffic.rebuildSignalPlans();
    const def = SIGNAL.MODE_LIST.find((x) => x.id === m);
    return { ok: true, msg: '信号灯方案已切换为「' + def.name + '」：' + def.desc };
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

  /** 设置财政结算步长（游戏分钟）：每 N 分钟把累计收支入账一次 */
  setSettleStep(minutes) {
    const v = Math.max(1, Math.min(240, Math.round(Number(minutes) || ECON.SETTLE_MINUTES)));
    this.settleMinutes = v;
    // 立刻结算一次，避免玩家改步长后看不到变化
    this.settleBudget();
    return { ok: true, msg: '结算步长已设为每 ' + v + ' 个游戏分钟（1x 下约 ' + (v / 2).toFixed(1) + ' 秒入账一次）' };
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
      // 人口速率：按「上一个游戏小时」的实际发生量统计（面板实时显示涨/跌）
      this._rollDemographyRates();
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
    // 资金实时结算：市政维护每时每刻都在扣钱 -> 面板上的钱随时都在动
    this.accrueBudget(whole / 60);
    // 结算步长：每 N 个游戏分钟把累计收支写进财政流水
    this._settleAcc = (this._settleAcc || 0) + whole;
    const step = Math.max(1, this.settleMinutes || ECON.SETTLE_MINUTES);
    let guard = 0;
    while (this._settleAcc >= step && guard++ < 64) {
      this._settleAcc -= step;
      this.settleBudget();
    }
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
        dem._rBirth++;
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
        dem._rDeath++;
        dem.pop = Math.max(0, dem.pop - 1);
        if (dem.waiting > 0) dem.waiting--;
      }
    }

    // --- 移民：外来车辆从高速出入口开进来（没有出入口就没有移民）---
    if (entrances.length) {
      const jobs = this.stats.jobs || 0;
      // 岗位/人口比：没有工作就没有人愿意来（避免城市空转、盲目膨胀）
      const jobPerCap = dem.pop > 0 ? jobs / dem.pop : 1;
      // 岗位/人口比：没有工作就没有人愿意来。
      // 曲线必须够陡 —— 以前 0.5 以上都是满速，结果人口可以无限膨胀、
      // 失业率飙到 39%（城市看着热闹，其实全是失业人口）。
      // 现在低于 0.62 基本没人来，高于 0.85 才是满速。
      const jobFactor = Math.max(0, Math.min(DEMOGRAPHY.IMMIGRATION_JOB_FACTOR,
        ((jobPerCap - 0.62) / 0.23) * DEMOGRAPHY.IMMIGRATION_JOB_FACTOR));
      // 幸福度低的城市没人愿意来（堵车、缺服务 -> 人口流失）
      const happyNow = this.stats.happiness === undefined ? 70 : this.stats.happiness;
      const happyFactor = Math.max(0, Math.min(1, (happyNow - 20) / 45));
      // 住房不足时外来人口不会一直涌进来（要有地方住才搬家）
      const freeHousing = Math.max(0, this.housingCapacity() - (dem.housed || 0));
      const housingFactor = freeHousing > 60 ? 1 : freeHousing / 60;
      const base = DEMOGRAPHY.IMMIGRATION_BASE_PER_HOUR * jobFactor;
      const cap = DEMOGRAPHY.IMMIGRATION_MAX_PER_HOUR;
      const rate = Math.min(cap, base * happyFactor) * entrances.length * housingFactor;
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
    // 路堵死的时候人根本开不走：迁出速率要跟着通行能力一起下降。
    // 没有这一项会形成死亡螺旋（越堵 -> 越不幸福 -> 越想走 -> 路上车越多 -> 越堵）。
    const cong = Math.min(1, (this.traffic.stats.congestion || 0) / 60);
    const roadFactor = Math.max(0.08, 1 - cong * 0.92);
    const emRate = dem.pop * DEMOGRAPHY.EMIGRATION_RATE_PER_HOUR *
      (1 + unhappy * DEMOGRAPHY.EMIGRATION_UNHAPPY_FACTOR) * roadFactor;
    dem._emigAcc = (dem._emigAcc || 0) + emRate * hours;
    while (dem._emigAcc >= 1) {
      dem._emigAcc -= 1;
      if (!this.traffic.dispatchEmigrant()) { dem._emigAcc = 0; break; }
    }

    dem.housed = Math.max(0, dem.pop - dem.waiting);
  }

  /** 结算人口速率（每游戏小时）：移民 / 新生儿 / 死亡 / 迁出 */
  _rollDemographyRates() {
    const dem = this.demography;
    const r = dem.rate;
    r.birth = dem._rBirth;
    r.death = dem._rDeath;
    r.immig = dem._rImmig;
    r.emig = dem._rEmig;
    r.net = (dem._rImmig + dem._rBirth) - (dem._rDeath + dem._rEmig);
    dem._rBirth = 0; dem._rDeath = 0; dem._rImmig = 0; dem._rEmig = 0;
  }

  /** 估算当前的人口速率（新建城市 / 读档后立刻显示，不用等第一个整点） */
  _estimateDemographyRates() {
    const dem = this.demography;
    const r = dem.rate;
    const pop = dem.pop || 0;
    const happy = this.stats.happiness === undefined ? 70 : this.stats.happiness;
    const edu = this.educationFactor();
    r.birth = pop * DEMOGRAPHY.BIRTH_RATE_PER_HOUR * edu;
    r.death = pop * DEMOGRAPHY.DEATH_RATE_PER_HOUR;
    const jobs = this.stats.jobs || 0;
    const jobPerCap = pop > 0 ? jobs / pop : 1;
    const jobFactor = Math.max(0, Math.min(DEMOGRAPHY.IMMIGRATION_JOB_FACTOR,
      ((jobPerCap - 0.62) / 0.23) * DEMOGRAPHY.IMMIGRATION_JOB_FACTOR));
    const happyFactor = Math.max(0, Math.min(1, (happy - 20) / 45));
    const rate = Math.min(DEMOGRAPHY.IMMIGRATION_MAX_PER_HOUR,
      DEMOGRAPHY.IMMIGRATION_BASE_PER_HOUR * jobFactor * happyFactor);
    r.immig = rate * (this.entrances || []).length;
    const unhappy = Math.max(0, (70 - happy) / 70);
    r.emig = pop * DEMOGRAPHY.EMIGRATION_RATE_PER_HOUR * (1 + unhappy * DEMOGRAPHY.EMIGRATION_UNHAPPY_FACTOR);
    r.net = (r.immig + r.birth) - (r.death + r.emig);
  }

  /** 移民抵达：车上的人成为城市居民（等待安置 -> 找房子住） */
  onImmigrantsArrive(n) {
    const dem = this.demography;
    dem.immigrants += n;
    dem._rImmig += n;
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
    dem._rEmig += n;
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
      settleMinutes: this.settleMinutes,
      settings: {
        signalMode: (this.settings && this.settings.signalMode) || SIGNAL.MODE.AUTO,
        routing: (this.settings && this.settings.routing) || 'static',
      },
      trafficT: Math.round(this.traffic.t || 0),
      entrances: (this.entrances || []).slice(),
      terrain: Array.from(this.terrain),
      // 地形高程图：必须存档！否则旧存档用新算法重建地形，路面的高程就对不上，
      // 会出现「路悬在半空 / 被土埋住」。
      height: Array.from(this.height || [], (v) => Math.round(v * 10) / 10),
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
        Math.round((t.roadH || 0) * 10) / 10, t.bridge || 0, t.tunnel || 0,
        t.rd || 0, t.od || 0,
        t.hcap || 0,
      ]),
      ledger: this.ledger.slice(-240),
      createdAt: this.createdAt,
    };
  }

  static restore(data) {
    const city = new City({ id: data.id, name: data.name, seed: data.seed, funds: data.funds, tax: data.tax });
    // 优先使用存档里的高程图（老存档没有则按种子重建）
    if (Array.isArray(data.height) && data.height.length === city.tiles.length) {
      city.height = Float32Array.from(data.height);
    }
    city.tick = data.tick | 0;
    city.settleMinutes = data.settleMinutes || ECON.SETTLE_MINUTES;
    city.settings = {
      signalMode: (data.settings && data.settings.signalMode !== undefined)
        ? data.settings.signalMode : SIGNAL.MODE.AUTO,
      routing: (data.settings && data.settings.routing) || 'static',
    };
    let oldFormat = false;
    city.tiles.forEach((t, i) => {
      const a = data.tiles[i] || [0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0];
      t.zone = a[0]; t.level = a[1]; t.road = a[2]; t.service = a[3];
      t.land = a[4]; t.power = !!a[5]; t.water = !!a[6];
      t.h = a[7] || 0; t.lt = a[8] || 0; t.over = a[9] || 0;
      t.olt = a[10] || 0;
      t.occ = a.length > 11 ? (a[11] / 255) : (t.level ? 1 : 0);
      // 路面高程 / 桥 / 隧道（新存档字段；老存档按地形补齐）
      if (a.length > 14) {
        t.roadH = a[12] || 0;
        t.bridge = a[13] || 0;
        t.tunnel = a[14] || 0;
      } else {
        oldFormat = true;
        t.roadH = city.elevAt(i);
        t.bridge = t.road && t.terrain === TERRAIN.water ? 1 : 0;
        t.tunnel = 0;
      }
      // 道路走向位掩码（第 16、17 项）：老存档没有 -> 退回邻居推断
      t.rd = a.length > 15 ? (a[15] | 0) : 0;
      t.od = a.length > 16 ? (a[16] | 0) : 0;
      // 高度上限（第 19 项）：老存档没有 -> 不限高
      t.hcap = a.length > 18 ? (a[18] | 0) : 0;
    });
    if (oldFormat) city._relaxRoadHeights();
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
    // 老存档 / 旧版城市：把地块里已有的人口搬进账本（人口不会归零，账本与地块对齐）
    if (city.stats.population > 0) {
      city.demography.pop = city.stats.population;
      city.demography.housed = city.stats.population;
      city.demography.waiting = 0;
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
    // 读档后立刻给出人口速率（不用等第一个整点）
    city._estimateDemographyRates();
    return city;
  }
}

// 将 development 模块的方法以 City 实例为 this 绑定
for (const [key, fn] of Object.entries(development)) {
  City.prototype[key] = function (...args) { return fn.call(this, this, ...args); };
}
