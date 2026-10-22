// ============================================================================
//  网络层：WebSocket 实时同步 + 本地状态镜像
// ============================================================================
import { MAP } from './constants.js';

const N = MAP.SIZE * MAP.SIZE;

export const state = {
  cityId: null, name: '', tick: 0, funds: 0, tax: { res: 9, com: 9, ind: 9 }, speed: 1,
  date: { year: 2024, month: 1, day: 1, hour: 0, minute: 0 },
  demand: { res: 0, com: 0, ind: 0 },
  stats: {}, traffic: {}, ledger: [],
  lab: null,
  // 瓦片镜像
  zone: new Uint8Array(N), level: new Uint8Array(N), road: new Uint8Array(N),
  mask: new Uint8Array(N), service: new Uint8Array(N), land: new Uint8Array(N),
  power: new Uint8Array(N), water: new Uint8Array(N), terrain: new Uint8Array(N),
  h: new Float32Array(N), lt: new Uint8Array(N),
  over: new Uint8Array(N), overMask: new Uint8Array(N),
  olt: new Uint8Array(N),
  height: new Float32Array(N),     // 地形高度图（米）
  roadH: new Float32Array(N),      // 地面路面高程（米）
  bridge: new Uint8Array(N),       // 1 = 桥
  tunnel: new Uint8Array(N),       // 1 = 隧道
  congestion: new Uint8Array(N),
  entrances: [],
  events: [],
  eventStats: {},
  demography: { pop: 0, housed: 0, waiting: 0, births: 0, deaths: 0, immigrants: 0, emigrants: 0 },
  fleet: { total: 0, cars: 0, trucks: 0, special: 0, scrapped: 0 },
  signals: new Uint8Array(N),
  vehicles: new Float32Array(0),
  settleMinutes: 10,
  // 变更回调
  changedTiles: new Set(),
  congestionDirty: true,
  signalsDirty: true,
  roadsDirty: true,
  buildingsDirty: true,
  terrainDirty: true,
};

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = { state: [], message: [], joined: [], ready: [] };
    this.retry = 0;
    this.connected = false;
    // 车辆帧缓冲：客户端据此做插值 + 航位推算，得到高帧率（60fps）平滑运动
    this.vehFrames = [];
    this.vehStride = 7;        // [x, z, y, heading, typeId, id, speed]
    this.trafficRate = 4;      // 交通秒/真实秒（服务端下发），用于把 m/s 换算成真实速度
    this._vbuf = new Float32Array(0);
  }

  on(evt, fn) { this.handlers[evt].push(fn); return this; }
  emit(evt, data) { for (const fn of this.handlers[evt]) fn(data); }

  connect(cityId) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = proto + '//' + location.host + '/ws';
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.ws.send(JSON.stringify({ type: 'join', cityId }));
      this.emit('ready');
    };
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'msg') this.emit('message', m);
        else if (m.type === 'joined') { state.cityId = m.cityId; state.name = m.name; this.emit('joined', m); }
        return;
      }
      this.handleFrame(ev.data);
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.retry = Math.min(this.retry + 1, 6);
      setTimeout(() => this.connect(cityId), 400 * this.retry);
    };
    this.ws.onerror = () => { try { this.ws.close(); } catch {} };
  }

  handleFrame(buf) {
    const dv = new DataView(buf);
    const hlen = dv.getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen)));
    const vOff = 4 + hlen;
    // 帧结构: [4B 头长度][JSON 头][车辆 Float32][拥堵贴图 N][信号灯贴图 N]
    const vBytes = Math.max(0, buf.byteLength - vOff - N * 2);
    const veh = new Float32Array(buf.slice(vOff, vOff + vBytes));
    state.vehicles = veh;
    this.pushVehFrame(veh);

    const cong = new Uint8Array(buf.slice(vOff + vBytes));
    let congChanged = false;
    for (let i = 0; i < N; i++) {
      if (cong[i] !== state.congestion[i]) { congChanged = true; break; }
    }
    state.congestion = cong;
    state.congestionDirty = true;

    // 信号灯贴图（紧随拥堵贴图）
    const sigOff = vOff + vBytes + N;
    state.signals = new Uint8Array(buf.slice(sigOff, sigOff + N));
    state.signalsDirty = true;

    this.applyHeader(header);
    this.emit('state', header);
  }

  /** 存入一帧车辆快照（保留最近若干帧用于插值 / 外推） */
  pushVehFrame(veh) {
    const t = performance.now();
    const S = this.vehStride;
    const n = Math.floor(veh.length / S);
    const map = new Map();
    for (let i = 0; i < n; i++) map.set(veh[i * S + 5], i);
    this.vehFrames.push({ t, veh, map });
    while (this.vehFrames.length > 10) this.vehFrames.shift();
  }

  /**
   * 取用于渲染的车辆快照（目标时刻 = now - delay）。
   *
   * 渲染思路（为了 30~60fps 的连续运动）：
   *   1) 服务端只广播 30Hz 的关键帧；客户端在相邻两帧之间按「车辆 ID」做线性插值，
   *      位置与最短弧朝向一起插值 —— 得到 60fps 的平滑轨迹。
   *   2) 若目标时刻已经越过最新关键帧，则用该车的速度做航位推算（dead reckoning），
   *      这样即使网络抖动掉了一帧，车也不会「卡住」再突然跳一下。
   *   3) 输出缓冲区复用，主循环零分配。
   */
  vehiclesAt(now, delayMs = 45) {
    const fs = this.vehFrames;
    if (!fs.length) return null;
    const target = now - delayMs;
    let a = null, b = null;
    for (let i = fs.length - 1; i >= 0; i--) {
      if (fs[i].t <= target) { a = fs[i]; b = fs[i + 1] || null; break; }
      b = fs[i];
    }
    if (!a) { a = fs[0]; b = fs[1] || null; }
    const S = this.vehStride;
    if (!b) {
      // 只有一帧可用：直接用这一帧（外推不了）
      if (this._vbuf.length < a.veh.length) this._vbuf = new Float32Array(a.veh.length);
      this._vbuf.set(a.veh);
      return { data: this._vbuf, alpha: 0 };
    }
    const span = b.t - a.t;
    const alpha = span > 0 ? Math.max(0, Math.min(3, (target - a.t) / span)) : 0;
    const n = Math.floor(b.veh.length / S);
    if (this._vbuf.length < n * S) this._vbuf = new Float32Array(n * S);
    const out = this._vbuf;
    const rate = this.trafficRate || 1;
    for (let i = 0; i < n; i++) {
      const o = i * S;
      const id = b.veh[o + 5];
      const p = a.map.get(id);
      out[o + 4] = b.veh[o + 4];
      out[o + 5] = id;
      out[o + 6] = b.veh[o + 6];
      if (p === undefined) {
        // 新出现的车（这一帧刚生成）：直接用新位置
        out[o] = b.veh[o]; out[o + 1] = b.veh[o + 1]; out[o + 2] = b.veh[o + 2]; out[o + 3] = b.veh[o + 3];
        continue;
      }
      const q = p * S;
      if (alpha <= 0) {
        out[o] = a.veh[q]; out[o + 1] = a.veh[q + 1]; out[o + 2] = a.veh[q + 2]; out[o + 3] = a.veh[q + 3];
        continue;
      }
      out[o] = a.veh[q] + (b.veh[o] - a.veh[q]) * alpha;
      out[o + 1] = a.veh[q + 1] + (b.veh[o + 1] - a.veh[q + 1]) * alpha;
      out[o + 2] = a.veh[q + 2] + (b.veh[o + 2] - a.veh[q + 2]) * alpha;
      // 朝向按最短弧插值
      let h0 = a.veh[q + 3], h1 = b.veh[o + 3];
      let d = h1 - h0;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      out[o + 3] = h0 + d * alpha;
      // 航位推算：目标时刻超过最新关键帧时，用车速沿当前朝向外推（最多 ~60ms）
      // 这样即使服务端掉了一帧，车也只是平滑地继续走，而不是「卡住 -> 跳一下」
      if (alpha > 1) {
        const over = Math.min(0.09, (alpha - 1) * span / 1000);
        const spd = (b.veh[o + 6] || 0) * rate;
        if (spd > 0.01) {
          const h = out[o + 3];
          out[o] += Math.sin(h) * spd * over;
          out[o + 1] += Math.cos(h) * spd * over;
        }
      }
    }
    return { data: out, alpha };
  }

  applyHeader(h) {
    state.cityId = h.cityId; state.name = h.name;
    state.tick = h.tick; state.funds = h.funds; state.tax = h.tax; state.speed = h.speed;
    state.date = h.date; state.demand = h.demand; state.stats = h.stats;
    if (h.trafficRate) this.trafficRate = h.trafficRate;
    if (h.entrances) {
      const same = h.entrances.length === state.entrances.length &&
        h.entrances.every((v, i) => v === state.entrances[i]);
      if (!same) { state.entrances = h.entrances.slice(); state.roadsDirty = true; }
    }
    state.traffic = h.traffic; state.ledger = h.ledger || [];
    state.lab = h.lab || null;
    if (h.settleMinutes) state.settleMinutes = h.settleMinutes;
    if (h.demography) state.demography = h.demography;
    if (h.fleet) state.fleet = h.fleet;
    if (h.events) state.events = h.events;
    if (h.eventStats) state.eventStats = h.eventStats;
    // 地形高度图（只在完整状态里带一次）
    if (h.height) {
      for (let i = 0; i < N; i++) state.height[i] = h.height[i] || 0;
      state.terrainDirty = true;
    }
    const d = h.diffs || [];
    for (let i = 0; i < d.length; i += 18) {
      const t = d[i];
      if (state.road[t] !== d[i + 3] || state.mask[t] !== d[i + 4]) state.roadsDirty = true;
      if (state.zone[t] !== d[i + 1] || state.level[t] !== d[i + 2] || state.service[t] !== d[i + 5]) state.buildingsDirty = true;
      if (state.terrain[t] !== d[i + 9]) state.terrainDirty = true;
      if (state.h[t] !== d[i + 10] || state.lt[t] !== d[i + 11] ||
          state.over[t] !== d[i + 12] || state.overMask[t] !== d[i + 13] ||
          state.olt[t] !== d[i + 14] || state.roadH[t] !== d[i + 15] ||
          state.bridge[t] !== d[i + 16] || state.tunnel[t] !== d[i + 17]) state.roadsDirty = true;
      // 路面高程变了 -> 地形（隧道沟槽 / 路基）也要重画
      if (state.roadH[t] !== d[i + 15] || state.tunnel[t] !== d[i + 17]) state.terrainDirty = true;
      state.zone[t] = d[i + 1]; state.level[t] = d[i + 2]; state.road[t] = d[i + 3];
      state.mask[t] = d[i + 4]; state.service[t] = d[i + 5]; state.land[t] = d[i + 6];
      state.power[t] = d[i + 7]; state.water[t] = d[i + 8]; state.terrain[t] = d[i + 9];
      state.h[t] = d[i + 10]; state.lt[t] = d[i + 11];
      state.over[t] = d[i + 12]; state.overMask[t] = d[i + 13];
      state.olt[t] = d[i + 14];
      state.roadH[t] = d[i + 15]; state.bridge[t] = d[i + 16]; state.tunnel[t] = d[i + 17];
      state.changedTiles.add(t);
    }
  }

  send(cmd) {
    if (this.ws && this.ws.readyState === 1) {
      const { name, ...rest } = cmd;
      this.ws.send(JSON.stringify({ type: 'command', action: name, ...rest }));
    }
  }
}

export const net = new Net();
