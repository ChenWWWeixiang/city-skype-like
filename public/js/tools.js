// ============================================================================
//  交互工具：修路 / 分区 / 设施 / 拆除
// ============================================================================
import * as THREE from 'three';
import { MAP, HALF } from './constants.js';

const S = MAP.SIZE;
const idx = (x, z) => z * S + x;
const clamp = (v) => Math.max(0, Math.min(S - 1, v));

export class Tools {
  constructor(opts) {
    this.dom = opts.dom;
    this.camera = opts.camera;
    this.net = opts.net;
    this.ui = opts.ui;
    this.overlay = opts.overlay;
    this.state = opts.state;
    this.ground = opts.ground;      // 地形网格：有起伏时必须按地形拾取，否则高亮会错位
    this.tool = 'select';
    this.opt = {
      roadType: 1, zone: 'res', service: 'police', overlay: 'none',
      elevated: false, tunnel: false, curvature: 0.0,
    };
    this.dragging = false;
    this.startTile = -1;
    this.lastTile = -1;
    this.painted = [];
    this.hoverTile = -1;
    this.ray = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.hit = new THREE.Vector3();
    this.ndc = new THREE.Vector2();
    this.bind();
  }

  bind() {
    this.dom.addEventListener('pointerdown', (e) => this.onDown(e));
    this.dom.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    this.dom.addEventListener('pointerleave', () => { this.hoverTile = -1; this.overlay.setHover(-1); });
  }

  setTool(t) {
    this.tool = t;
    this.dragging = false;
    this.painted = [];
    this.overlay.setPreview([]);
    this.ui.renderToolOptions(t, this.opt);
    this.updateCursor();
  }

  updateCursor() {
    this.dom.style.cursor = this.tool === 'select' ? 'default' : 'crosshair';
  }

  pick(e) {
    const r = this.dom.getBoundingClientRect();
    this.ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.ray.setFromCamera(this.ndc, this.camera);
    let px = null, pz = null;
    // 优先与「地形网格」求交 —— 地形有起伏时，纯平面拾取会算错格子
    if (this.ground) {
      const hits = this.ray.intersectObject(this.ground, false);
      if (hits.length) { px = hits[0].point.x; pz = hits[0].point.z; }
    }
    if (px === null) {
      if (!this.ray.ray.intersectPlane(this.plane, this.hit)) return -1;
      px = this.hit.x; pz = this.hit.z;
    }
    const x = Math.floor((px + HALF) / MAP.TILE);
    const z = Math.floor((pz + HALF) / MAP.TILE);
    if (x < 0 || z < 0 || x >= S || z >= S) return -1;
    return idx(x, z);
  }

  onDown(e) {
    if (e.button !== 0) return;
    const t = this.pick(e);
    if (t < 0) return;
    if (this.tool === 'select') {
      this.ui.showTileInfo(t);
      return;
    }
    if (this.tool === 'service') {
      this.net.send({ name: 'service', tile: t, service: this.opt.service });
      this.updateRadiusPreview(t);
      return;
    }
    if (this.tool === 'entrance') {
      const res = this.net.send({ name: 'entrance', tile: t });
      void res;
      return;
    }
    if (this.tool === 'lane') {
      this.editLane(e);
      return;
    }
    this.dragging = true;
    this.startTile = t;
    this.lastTile = t;
    this.painted = [t];
    this.updatePreview();
  }

  onMove(e) {
    const t = this.pick(e);
    if (t !== this.hoverTile) {
      this.hoverTile = t;
      this.overlay.setHover(t);
      this.updateRadiusPreview(t);
      if (this.ui && this.ui.setHoverInfo) this.ui.setHoverInfo(t);
    }
    if (!this.dragging || t < 0) return;
    if (this.tool === 'road') {
      // 道路默认「吸附成一条直线」：手抖一下不会画出一条歪歪扭扭的斜线。
      // 按住 Shift / Alt 才是自由模式（可以画斜线）。
      const target = this.snapRoadTarget(this.startTile, t, e);
      this.painted = roadPath(this.startTile, target, this.opt.curvature || 0);
    } else {
      for (const p of lineTiles(this.lastTile, t)) {
        if (!this.painted.includes(p)) this.painted.push(p);
      }
      this.lastTile = t;
    }
    this.updatePreview();
  }

  /**
   * 道路端点吸附：把终点拉回起点所在的行或列（取位移较大的那个方向），
   * 于是横向拖 = 水平直线，纵向拖 = 垂直直线，绝不会画出歪路。
   * 按住 Shift/Alt 则不做吸附（自由斜线）。
   */
  snapRoadTarget(a, b, e) {
    if (e && (e.shiftKey || e.altKey)) return b;
    const ax = a % S, az = Math.floor(a / S);
    const bx = b % S, bz = Math.floor(b / S);
    const dx = Math.abs(bx - ax), dz = Math.abs(bz - az);
    // --- 节点吸附：终点附近已有道路时，自动贴上去接成干净的路口 ---
    const node = this.findRoadNear(b, 1);
    if (node >= 0) {
      const nx = node % S, nz = Math.floor(node / S);
      if (dx >= dz && Math.abs(nz - az) <= 1) {
        const sx = bx >= nx ? nx - 1 : nx + 1;
        if (sx >= 0 && sx < S) return idx(sx, az);
      } else if (dz > dx && Math.abs(nx - ax) <= 1) {
        const sz = bz >= nz ? nz - 1 : nz + 1;
        if (sz >= 0 && sz < S) return idx(ax, sz);
      }
    }
    if (dx >= dz) return idx(clamp(bx), az);   // 水平直线
    return idx(ax, clamp(bz));                  // 垂直直线
  }

  /** 附近是否已有道路（节点吸附用） */
  findRoadNear(tile, radius = 1) {
    const st = this.state;
    if (!st) return -1;
    const ax = tile % S, az = Math.floor(tile / S);
    let best = -1, bestD = radius + 0.001;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = ax + dx, z = az + dz;
        if (x < 0 || z < 0 || x >= S || z >= S) continue;
        const i = idx(x, z);
        if (!st.road[i] && !(st.over && st.over[i])) continue;
        const d = Math.hypot(dx, dz);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    return best;
  }

  onUp() {
    if (!this.dragging) return;
    this.dragging = false;
    const tiles = this.painted.slice();
    this.painted = [];
    this.overlay.setPreview([]);
    if (!tiles.length) return;
    if (this.tool === 'road') {
      this.net.send({
        name: 'road', tiles, roadType: this.opt.roadType,
        elevated: !!this.opt.elevated, tunnel: !!this.opt.tunnel,
      });
    } else if (this.tool === 'zone') {
      this.net.send({ name: 'zone', tiles, zone: this.opt.zone });
    } else if (this.tool === 'bulldoze') {
      this.net.send({ name: 'bulldoze', tiles });
    }
  }

  /** 车道编辑：点击道路某条车道循环切换类型（自动区分地面层 / 高架层） */
  editLane(e) {
    const st = this.state;
    if (!st) return;
    const hit = this.findRoadTarget(e);
    if (!hit) { if (this.ui) this.ui.toast('请点击一段道路', 'err'); return; }
    const { tile, layer, def, isX } = hit;
    const cx = (tile % MAP.SIZE + 0.5) * MAP.TILE - HALF;
    const cz = Math.floor(tile / MAP.SIZE + 0.5) * MAP.TILE - HALF;
    const dx = hit.px - cx, dz = hit.pz - cz;
    // 道路主方向
    const off = isX ? dz : dx;
    const laneW = def.width / def.lanes;
    let lane = Math.floor((off + def.width / 2) / laneW);
    lane = Math.max(0, Math.min(def.lanes - 1, lane));
    this.net.send({ name: 'lane', tile, lane, layer });
  }

  /**
   * 射线拾取道路：同时考虑地面层与高架层，取离相机最近的一处
   * 返回 { tile, layer, def, isX, px, pz, t } 或 null
   */
  findRoadTarget(e) {
    const st = this.state;
    if (!st || !this.ui || !this.ui.config) return null;
    const r = this.dom.getBoundingClientRect();
    this.ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.ray.setFromCamera(this.ndc, this.camera);
    const ro = this.ray.ray.origin, rd = this.ray.ray.direction;
    if (rd.y >= -1e-6) return null;                 // 视线朝上，无法命中地面
    let best = null;
    const consider = (tile, layer, h) => {
      const t = (h - ro.y) / rd.y;
      if (t <= 0) return;
      const px = ro.x + rd.x * t, pz = ro.z + rd.z * t;
      let ti = tile;
      if (ti === undefined) {
        const x = Math.floor((px + HALF) / MAP.TILE);
        const z = Math.floor((pz + HALF) / MAP.TILE);
        if (x < 0 || z < 0 || x >= S || z >= S) return;
        ti = z * S + x;
      }
      const roadType = layer === 1 ? st.over[ti] : st.road[ti];
      if (!roadType) return;
      const def = this.ui.config.roads.find((rr) => rr.id === roadType);
      if (!def) return;
      const x = ti % S, z = Math.floor(ti / S);
      const cx = (x + 0.5) * MAP.TILE - HALF, cz = (z + 0.5) * MAP.TILE - HALF;
      const m = layer === 1 ? st.overMask[ti] : st.mask[ti];
      const alongX = (m & 4) || (m & 64);
      const alongZ = (m & 1) || (m & 16);
      const isX = alongX && !alongZ ? true : alongZ && !alongX ? false : (m & 4) !== 0;
      const lateral = isX ? (pz - cz) : (px - cx);
      if (Math.abs(lateral) > def.width / 2 + 1.0) return;
      const along = isX ? (px - cx) : (pz - cz);
      const half = MAP.TILE / 2;
      if (Math.abs(along) > half + MAP.TILE) return;      // 允许命中相邻路段臂
      const contains = Math.abs(along) <= half + 0.01;
      let better = false;
      if (!best) better = true;
      else if (t < best.t - 0.05) better = true;
      else if (Math.abs(t - best.t) <= 0.05) {
        if (contains !== best.contains) better = contains;
        else if (layer !== best.layer) better = layer < best.layer;
      }
      if (better) {
        best = { tile: ti, layer, def, isX, px, pz, t, contains };
      }
    };
    consider(undefined, 0, 0);
    for (let i = 0; i < st.over.length; i++) {
      if (!st.over[i]) continue;
      const h = st.h[i] || 0;
      if (h > 0.4) consider(i, 1, h);
      else consider(i, 1, 0);       // 坡道落地段与地面同高
    }
    return best;
  }

  /** 服务工具下显示覆盖半径 */
  updateRadiusPreview(tile) {
    if (this.tool !== 'service' || tile < 0) {
      this.overlay.setRadius(-1);
      return;
    }
    const cfg = this.ui && this.ui.config;
    if (!cfg) return;
    const def = cfg.services.find((s) => s.key === this.opt.service);
    if (!def) return;
    this.overlay.setRadius(tile, def.radius, def.color);
  }

  updatePreview() {
    if (this.tool === 'road') {
      this.overlay.setPreview(this.painted, 0xffffff);
    } else if (this.tool === 'zone') {
      const c = { res: 0x3f9d5c, com: 0x3f7fd0, ind: 0xd09a3f }[this.opt.zone];
      // 缺电 / 缺水 / 不临路的地块标红，提前提示玩家为什么长不出房子
      const st = this.state;
      const colors = this.painted.map((t) => {
        if (!st) return c;
        const x = t % S, z = Math.floor(t / S);
        const road = (x > 0 && st.road[t - 1]) || (x < S - 1 && st.road[t + 1]) ||
          (z > 0 && st.road[t - S]) || (z < S - 1 && st.road[t + S]);
        const utility = st.power[t] && st.water[t];
        return (road && utility) ? c : 0xe0553f;
      });
      this.overlay.setPreview(this.painted, c, colors);
    } else if (this.tool === 'bulldoze') {
      this.overlay.setPreview(this.painted, 0xd9483f);
    } else {
      this.overlay.setPreview([]);
    }
  }
}

/**
 * 生成道路路径：支持斜向与曲率
 * curvature = 0 直线；> 0 生成带弧度的二次贝塞尔曲线
 */
export function roadPath(a, b, curvature = 0) {
  const ax = a % S, az = Math.floor(a / S);
  const bx = b % S, bz = Math.floor(b / S);
  const p0 = { x: ax + 0.5, z: az + 0.5 };
  const p1 = { x: bx + 0.5, z: bz + 0.5 };
  const dx = p1.x - p0.x, dz = p1.z - p0.z;
  const len = Math.hypot(dx, dz);
  const pts = [];
  if (curvature > 0.02 && len > 3) {
    // 控制点向垂直方向偏移 -> 圆弧
    const k = curvature * 0.22;   // 曲率 0~1 -> 轻微到明显的弧线
    const cx = (p0.x + p1.x) / 2 - dz * k;
    const cz = (p0.z + p1.z) / 2 + dx * k;
    const steps = Math.max(10, Math.ceil(len * 3));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, it = 1 - t;
      pts.push({
        x: it * it * p0.x + 2 * it * t * cx + t * t * p1.x,
        z: it * it * p0.z + 2 * it * t * cz + t * t * p1.z,
      });
    }
  } else {
    const steps = Math.max(1, Math.ceil(len * 3));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push({ x: p0.x + dx * t, z: p0.z + dz * t });
    }
  }
  const out = [];
  let last = -1;
  for (const p of pts) {
    const x = Math.floor(p.x), z = Math.floor(p.z);
    if (x < 0 || z < 0 || x >= S || z >= S) continue;
    const t = idx(x, z);
    if (t !== last) { out.push(t); last = t; }
  }
  return simplifyPath(out);
}

/** 拉绳简化：在保持连通的前提下把阶梯状路径拉直 */
function simplifyPath(path) {
  if (path.length <= 2) return path.slice();
  const adj = (a, b) => {
    const adx = Math.abs((a % S) - (b % S));
    const adz = Math.abs(Math.floor(a / S) - Math.floor(b / S));
    return adx <= 1 && adz <= 1;
  };
  // 保留起点与终点，保证与既有路网能够对接
  const out = [path[0]];
  let i = 1;
  while (i < path.length) {
    let j = path.length - 1;
    while (j > i) {
      if (adj(out[out.length - 1], path[j])) break;
      j--;
    }
    out.push(path[j]);
    i = j + 1;
  }
  return out;
}

/** 自由画笔：两格之间经过的格子 */
export function lineTiles(a, b) {
  if (a < 0) return [b];
  const ax = a % S, az = Math.floor(a / S);
  const bx = b % S, bz = Math.floor(b / S);
  const out = [];
  const steps = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
  if (steps === 0) return [b];
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(ax + (bx - ax) * i / steps);
    const z = Math.round(az + (bz - az) * i / steps);
    const t = idx(x, z);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
