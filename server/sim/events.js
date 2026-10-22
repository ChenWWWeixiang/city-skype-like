// ============================================================================
//  事件系统：火灾 / 犯罪 / 疾病 / 事故 / 学校
//  ---------------------------------------------------------------------------
//  设计要点：
//   * 事件不是「随机扣血」，而是**需要城市服务去处理的事件**：
//       起火 -> 消防车必须真的开过去（没有消防车就烧掉房子）
//       犯罪 -> 警察必须真的开过去（没人管 -> 罚款 + 幸福度下降）
//       疾病 -> 救护车必须真的开过去（没人管 -> 病人死亡）
//       事故 -> 占用车道 -> 真的会把车流堵住（这是最直观的堵车模拟）
//       学校 -> 教育提升出生率与幸福度，并在上下学时间制造额外车流
//   * 特种车辆不是凭空出现：它们随特种建筑诞生，没车就处理不了事件。
// ============================================================================
import { MAP, INCIDENTS, SERVICE_DISPATCH, SERVICES, TRAFFIC } from './constants.js';

let INCIDENT_SEQ = 1;

export class EventSystem {
  constructor(city) {
    this.city = city;
    this.list = [];          // 当前进行中的事件
    this.history = [];       // 最近事件（给 UI 显示）
    this._timer = 0;
    this.stats = {
      fire: 0, crime: 0, disease: 0, accident: 0, school: 0,
      resolved: 0, failed: 0, casualties: 0, fines: 0,
    };
  }

  /** 每游戏分钟调用一次 */
  update(minutes) {
    const city = this.city;
    if (!city.tiles) return;
    this._timer += minutes;
    // 每 5 分钟做一次「是否发生新事件」的判定（省 CPU）
    while (this._timer >= 5) {
      this._timer -= 5;
      this._maybeSpawn();
    }
    this._progress(minutes);
    this._cleanup();
  }

  // ---------------------------------------------------------------- 产生事件
  _maybeSpawn() {
    const city = this.city;
    const hours = 5 / 60;
    const pop = city.stats.population || 0;
    // 城市越小，事件越少（小城市不会一天发生 8 起火灾）
    const popScale = Math.min(2, 0.4 + pop / 1200);
    const hour = city.hourOfDay;
    // 事件太密集会毁掉可玩性 -> 同时进行的同类事件有上限
    const cap = 3;
    for (const key of ['fire', 'crime', 'disease', 'accident']) {
      const cfg = INCIDENTS[key];
      const alive = this.list.filter((e) => e.type === key).length;
      if (alive >= cap) continue;
      let rate = 0;
      if (key === 'fire') {
        let n = 0;
        for (const i of city.serviceTiles) n++;
        const buildings = city.residentialTiles.length + city.commercialTiles.length + city.industrialTiles.length;
        rate = cfg.ratePerBuildingHour * buildings * hours;
        // 工业区更容易起火
        rate += cfg.ratePerBuildingHour * cfg.industrialBonus * city.industrialTiles.length * hours;
      } else if (key === 'crime') {
        let n = 0;
        for (const i of city.commercialTiles) n++;
        rate = cfg.ratePerBuildingHour * (city.commercialTiles.length + city.industrialTiles.length) * hours;
        if (hour >= 20 || hour < 6) rate *= cfg.nightBonus;      // 夜间治安更差
      } else if (key === 'disease') {
        rate = cfg.ratePerBuildingHour * city.residentialTiles.length * hours;
        rate *= 1 + Math.min(1.2, pop / 3000);                   // 人口越密集越容易传播
      } else if (key === 'accident') {
        const veh = city.traffic.vehicles.length;
        // 事故按「交通小时」计算（车实际行驶用的是交通时钟）
        rate = cfg.ratePerVehicleHour * veh * this._trafficHours();
        rate *= 1 + (city.traffic.stats.congestion || 0) / 40 * cfg.congestionBonus;
      }
      if (Math.random() < rate * popScale) {
        const tile = this._pickTile(key);
        if (tile >= 0) this.spawn(key, tile);
      }
    }
  }

  /** 自上次判定以来经过的交通小时数 */
  _trafficHours() {
    const t = this.city.traffic.t || 0;
    if (this._lastTrafficT === undefined) { this._lastTrafficT = t; return 0; }
    const dt = Math.max(0, t - this._lastTrafficT);
    this._lastTrafficT = t;
    return dt / TRAFFIC.SEC_PER_HOUR;
  }

  _pickTile(type) {
    const city = this.city;
    const pool = type === 'fire' ? (city.residentialTiles.concat(city.commercialTiles, city.industrialTiles))
      : type === 'crime' ? (city.commercialTiles.concat(city.industrialTiles))
        : type === 'disease' ? city.residentialTiles
          : city.tiles.map((t, i) => (t.road ? i : -1)).filter((i) => i >= 0);
    if (!pool.length) return -1;
    for (let k = 0; k < 8; k++) {
      const t = pool[(Math.random() * pool.length) | 0];
      if (t === undefined || t < 0) continue;
      if (this.list.some((e) => e.tile === t)) continue;
      if (type === 'accident' && !city.tiles[t].road) continue;
      return t;
    }
    return -1;
  }

  /** 产生一个事件 */
  spawn(type, tile) {
    const cfg = INCIDENTS[type];
    if (!cfg) return null;
    const e = {
      id: INCIDENT_SEQ++,
      type, tile,
      name: cfg.name,
      icon: cfg.icon,
      color: cfg.color,
      severity: 0.25,
      age: 0,                  // 游戏小时
      handled: false,
      responded: false,
      vehicleId: -1,
      startedAt: this.city.tick,
    };
    this.list.push(e);
    this.stats[type] = (this.stats[type] || 0) + 1;
    if (type === 'accident') this._blockRoad(e);
    return e;
  }

  // ---------------------------------------------------------------- 事件推进
  _progress(minutes) {
    const city = this.city;
    const hours = minutes / 60;
    for (const e of this.list) {
      const cfg = INCIDENTS[e.type];
      e.age += hours;
      e.severity = Math.min(1, e.severity + cfg.growPerHour * hours);
      // 派车：找对应特种车辆（没有车就没人处理）
      if (!e.responded) {
        const dispatch = SERVICE_DISPATCH[this._serviceIdOf(e.type)];
        if (dispatch) {
          const veh = city.traffic._takeSpecialVehicle(dispatch.type, undefined);
          if (veh) {
            veh.onDuty = true;
            e.vehicleId = veh.id;
            e.responded = true;
            const target = e.tile;
            const dw = dispatch.dwell;
            const dwell = dw[0] + Math.random() * (dw[1] - dw[0]);
            const ok = city.traffic.dispatchSpecial(veh, target, dwell);
            if (!ok) { e.responded = false; e.vehicleId = -1; veh.onDuty = false; }
          }
        }
      }
      // 处置完成（车到了现场并处理完）
      if (e.responded && e.vehicleId >= 0) {
        const veh = city.traffic.vehicles.find((v) => v.id === e.vehicleId);
        if (!veh) {
          // 车已经处理完并回站 -> 事件结束
          this._resolve(e, true);
          continue;
        }
        if (veh.dwell > 0 && veh.purpose === 'service') {
          // 车已到现场开始处置 -> 事件结束（按「已处理」计算后果）
          this._resolve(e, true);
          continue;
        }
      }
      // 没人管 -> 后果
      if (!e.responded && e.age > cfg.resolveHours) {
        this._resolve(e, false);
      }
    }
  }

  _serviceIdOf(type) {
    if (type === 'fire') return 2;        // 消防站
    if (type === 'crime') return 1;       // 警察局
    if (type === 'disease') return 3;     // 诊所
    if (type === 'accident') return 1;    // 警察局
    return -1;
  }

  /** 事件结束：resolved=true 表示被处理好 */
  _resolve(e, resolved) {
    const city = this.city;
    const cfg = INCIDENTS[e.type];
    const idx = this.list.indexOf(e);
    if (idx >= 0) this.list.splice(idx, 1);
    if (resolved) {
      this.stats.resolved++;
      if (e.type === 'fire') {
        // 火灾扑灭但房子可能受损
        const t = city.tiles[e.tile];
        if (t && t.level > 0 && Math.random() < 0.35) {
          t.level = Math.max(0, t.level - 1);
          city.markDirty(e.tile);
        }
      }
      if (e.type === 'accident') this._unblockRoad(e);
      e.handled = true;
    } else {
      this.stats.failed++;
      this._applyConsequences(e);
    }
    this.history.unshift({ type: e.type, name: e.name, tile: e.tile, resolved, age: e.age, at: city.tick });
    if (this.history.length > 24) this.history.pop();
  }

  /** 事件没被处理 -> 造成实际后果 */
  _applyConsequences(e) {
    const city = this.city;
    const cfg = INCIDENTS[e.type];
    const t = city.tiles[e.tile];
    if (e.type === 'fire') {
      // 房子烧掉，住在里面的人没了
      if (t) {
        const lost = t.pop || 0;
        this.stats.casualties += lost;
        city.demography.pop = Math.max(0, city.demography.pop - lost);
        city.demography.housed = Math.max(0, city.demography.housed - lost);
        city.demography.waiting = Math.max(0, city.demography.waiting - Math.min(city.demography.waiting, lost));
        t.level = 0; t.pop = 0; t.jobs = 0; t.occ = 0;
        city.markDirty(e.tile);
      }
      city.stats.happiness = Math.max(0, (city.stats.happiness || 70) - cfg.happinessHit);
    } else if (e.type === 'crime') {
      // 罚款随城市规模放大（小城市不至于被一次犯罪拖垮）
      const scale = 1 + Math.min(6, (city.stats.population || 0) / 700);
      const fine = Math.round((cfg.fine + Math.random() * cfg.fine) * scale);
      city.funds = Math.max(0, city.funds - fine);
      this.stats.fines += fine;
      city.stats.happiness = Math.max(0, (city.stats.happiness || 70) - cfg.happinessHit);
    } else if (e.type === 'disease') {
      const lost = Math.max(1, Math.round((t && t.pop ? t.pop : 4) * cfg.fatality * Math.random()));
      this.stats.casualties += lost;
      city.demography.pop = Math.max(0, city.demography.pop - lost);
      city.demography.housed = Math.max(0, city.demography.housed - lost);
      city.stats.happiness = Math.max(0, (city.stats.happiness || 70) - cfg.happinessHit);
    } else if (e.type === 'accident') {
      city.stats.happiness = Math.max(0, (city.stats.happiness || 70) - cfg.happinessHit);
      this._unblockRoad(e);
    }
  }

  // ---------------------------------------------------------------- 事故占道
  _blockRoad(e) {
    const city = this.city;
    const t = city.tiles[e.tile];
    if (!t || !t.road) return;
    const net = city.net;
    if (!net) return;
    const edgeId = net.tileEdge[e.tile];
    if (edgeId < 0) return;
    const edge = net.edges[edgeId];
    const off = net.tileOffset[e.tile] || 0;
    for (const arcId of [edge.forwardArc, edge.backwardArc]) {
      const arc = net.arcs[arcId];
      if (!arc) continue;
      const d = (arcId === edge.forwardArc) ? off : (edge.length - off);
      // 事故占用一条车道 -> 后面的车必须排队（真的堵车）
      arc.incident = { type: 'accident', dist: d, until: (city.traffic.t || 0) + 60 * 12 };
      arc.incidentTile = e.tile;
    }
  }
  _unblockRoad(e) {
    const city = this.city;
    const net = city.net;
    if (!net) return;
    const edgeId = net.tileEdge[e.tile];
    if (edgeId < 0) return;
    const edge = net.edges[edgeId];
    for (const arcId of [edge.forwardArc, edge.backwardArc]) {
      const arc = net.arcs[arcId];
      if (arc && arc.incident && arc.incidentTile === e.tile) arc.incident = null;
    }
  }

  /** 事故是否已过期（占道时间到） */
  _cleanup() {
    const t = this.city.traffic.t || 0;
    for (const arc of (this.city.net ? this.city.net.arcs : [])) {
      if (arc.incident && arc.incident.until < t) arc.incident = null;
    }
  }

  /** 给客户端的精简列表 */
  forClient() {
    return this.list.map((e) => ({
      id: e.id, type: e.type, tile: e.tile, name: e.name, icon: e.icon,
      color: e.color, severity: +e.severity.toFixed(2),
      responded: e.responded, age: +e.age.toFixed(1),
    }));
  }
}
