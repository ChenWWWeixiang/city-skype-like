// ============================================================================
//  道路路径生成（服务端版）
//   - 直线、斜线、圆弧（折线转角用二次贝塞尔切角）
//   - 保证 8 方向连通，且「斜向段至少 3 格」
//     （路网里斜向连接要求「同方向再往前一格也有路」，
//       否则一条斜路会在中间断开，车过不去）
// ============================================================================
import { MAP } from './constants.js';

const S = MAP.SIZE;

export const idx = (x, z) => z * S + x;
const xOf = (i) => i % S;
const zOf = (i) => Math.floor(i / S);

const dist2 = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

/** 把折线的拐角切成圆弧（每段用二次贝塞尔） */
function roundCorners(pts, radius) {
  if (pts.length < 3 || radius <= 0) return pts.map((p) => ({ x: p.x, z: p.z }));
  const out = [{ x: pts[0].x, z: pts[0].z }];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], a = pts[i - 1], b = pts[i + 1];
    const la = dist2(a, p), lb = dist2(p, b);
    if (la < 0.01 || lb < 0.01) continue;
    const r = Math.min(radius, la / 2, lb / 2);
    const s = { x: p.x + (a.x - p.x) / la * r, z: p.z + (a.z - p.z) / la * r };
    const e = { x: p.x + (b.x - p.x) / lb * r, z: p.z + (b.z - p.z) / lb * r };
    out.push(s);
    const N = 8;
    for (let k = 1; k < N; k++) {
      const t = k / N, it = 1 - t;
      out.push({
        x: it * it * s.x + 2 * it * t * p.x + t * t * e.x,
        z: it * it * s.z + 2 * it * t * p.z + t * t * e.z,
      });
    }
    out.push(e);
  }
  out.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].z });
  return out;
}

/** 密采样折线 -> 量化成瓦片序列（保证相邻格 8 连通） */
function rasterize(pts) {
  const tiles = [];
  let last = -1;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const steps = Math.max(1, Math.ceil(dist2(a, b) * 5));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = Math.floor(a.x + (b.x - a.x) * t);
      const z = Math.floor(a.z + (b.z - a.z) * t);
      if (x < 0 || z < 0 || x >= S || z >= S) continue;
      const t2 = idx(x, z);
      if (t2 !== last) { tiles.push(t2); last = t2; }
    }
  }
  return tiles;
}

/** 相邻两格的方向（0..7：N,NE,E,SE,S,SW,W,NW） */
function stepDir(a, b) {
  const dx = xOf(b) - xOf(a), dz = zOf(b) - zOf(a);
  if (dx === 0 && dz < 0) return 0;
  if (dx > 0 && dz < 0) return 1;
  if (dx > 0 && dz === 0) return 2;
  if (dx > 0 && dz > 0) return 3;
  if (dx === 0 && dz > 0) return 4;
  if (dx < 0 && dz > 0) return 5;
  if (dx < 0 && dz === 0) return 6;
  if (dx < 0 && dz < 0) return 7;
  return -1;
}

/**
 * 把「太短的斜向段」改成直角折线 ——
 * 斜向段不足 3 格时路网不会把两格连起来（斜向连接需要同方向再往前一格也有路）。
 */
function fixShortDiagonals(tiles) {
  if (tiles.length < 3) return tiles.slice();
  const runs = [];
  for (let i = 1; i < tiles.length; i++) {
    const d = stepDir(tiles[i - 1], tiles[i]);
    if (d < 0) continue;
    const last = runs[runs.length - 1];
    if (last && last.dir === d) last.end = i;
    else runs.push({ dir: d, start: i - 1, end: i });
  }
  const drop = new Set();
  for (const r of runs) {
    const isDiag = r.dir % 2 === 1;
    const len = r.end - r.start;
    if (!isDiag || len >= 3) continue;
    for (let i = r.start + 1; i <= r.end; i++) drop.add(i);
  }
  if (!drop.size) return tiles.slice();
  const out = [tiles[0]];
  for (let i = 1; i < tiles.length; i++) {
    if (drop.has(i)) {
      const a = tiles[i - 1], b = tiles[i];
      const mid = idx(xOf(b), zOf(a));
      if (mid !== out[out.length - 1]) out.push(mid);
    }
    out.push(tiles[i]);
  }
  return out;
}

/**
 * 生成一条道路的瓦片路径。
 * @param {Array<{x,z}>} waypoints 控制点（整数瓦片坐标）
 * @param {number} radius 拐角圆弧半径（0 = 折线，>=1 = 圆滑曲线）
 */
export function roadPath(waypoints, radius = 0) {
  const pts = waypoints.map((p) => ({ x: p.x, z: p.z }));
  const tiles = rasterize(roundCorners(pts, radius));
  return fixShortDiagonals(tiles);
}

/** 直线（轴向）路径 */
export function straightPath(x0, z0, x1, z1) {
  const out = [];
  const dx = x1 - x0, dz = z1 - z0;
  const n = Math.max(Math.abs(dx), Math.abs(dx === 0 && dz === 0 ? 1 : 0), Math.abs(dz));
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + dx * i / n), z = Math.round(z0 + dz * i / n);
    out.push(idx(x, z));
  }
  return out;
}
