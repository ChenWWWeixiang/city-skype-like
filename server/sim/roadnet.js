// ============================================================================
//  路网图构建（双层：地面层 / 高架层）
//  瓦片 -> 连接掩码(8方向) -> 节点(交叉口/断头路) + 有向路段(带折线几何与高程)
//  同一条道路可以"上跨"另一条道路：地面层与高架层各自成网，
//  仅在坡道端点（高程≈0）处合并，从而形成真正的立体交叉。
// ============================================================================
import { MAP, ELEV, SIGNAL } from './constants.js';

export const DIRS = [
  { dx: 0, dz: -1, bit: 1, name: 'N', opp: 16, axis: 'z', ang: 0 },
  { dx: 1, dz: -1, bit: 2, name: 'NE', opp: 32, axis: 'd', ang: 45 },
  { dx: 1, dz: 0, bit: 4, name: 'E', opp: 64, axis: 'x', ang: 90 },
  { dx: 1, dz: 1, bit: 8, name: 'SE', opp: 128, axis: 'd', ang: 135 },
  { dx: 0, dz: 1, bit: 16, name: 'S', opp: 1, axis: 'z', ang: 180 },
  { dx: -1, dz: 1, bit: 32, name: 'SW', opp: 2, axis: 'd', ang: 225 },
  { dx: -1, dz: 0, bit: 64, name: 'W', opp: 8, axis: 'x', ang: 270 },
  { dx: -1, dz: -1, bit: 128, name: 'NW', opp: 4, axis: 'd', ang: 315 },
];

export const tileIndex = (x, z) => z * MAP.SIZE + x;
export const worldX = (x) => (x + 0.5) * MAP.TILE - (MAP.SIZE * MAP.TILE) / 2;
export const worldZ = (z) => (z + 0.5) * MAP.TILE - (MAP.SIZE * MAP.TILE) / 2;
export const dirByBit = (bit) => DIRS.find((d) => d.bit === bit);

function popcount(m) {
  let c = 0;
  while (m) { m &= m - 1; c++; }
  return c;
}
function isOppositePair(m) {
  return m === 0b00010001 || m === 0b01000100 || m === 0b00100010 || m === 0b10001000;
}

/** 收集层格点：地面层(road) 与 高架层(over) */
function collectLayers(tiles) {
  const list = [];
  const at = new Map();   // tile -> [layerIndex...]
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const idxs = [];
    if (t.road) { idxs.push(list.length); list.push({ tile: i, type: t.road, h: 0, layer: 0, mask: 0 }); }
    if (t.over) { idxs.push(list.length); list.push({ tile: i, type: t.over, h: t.h || 0, layer: 1, mask: 0 }); }
    if (idxs.length) at.set(i, idxs);
  }
  return { list, at };
}

/** 两个层格点能否直接相连 */
function canConnect(a, b) {
  if (a.layer === b.layer) return Math.abs(a.h - b.h) <= ELEV.MAX_RAMP;
  // 跨层仅在坡道落地处连通
  return a.h <= 0.6 && b.h <= 0.6;
}

export function computeMasks(tiles) {
  const { list, at } = collectLayers(tiles);
  const S = MAP.SIZE;
  for (const a of list) {
    const x = a.tile % S, z = Math.floor(a.tile / S);
    for (const d of DIRS) {
      const nx = x + d.dx, nz = z + d.dz;
      if (nx < 0 || nz < 0 || nx >= S || nz >= S) continue;
      const nbIdx = at.get(tileIndex(nx, nz));
      if (!nbIdx) continue;
      // 斜向连接：只有当这两格同属一条连续的斜向道路时才建立
      // （斜向至少连成 2 格的一串）。否则十字路口的两个转角格会被
      // 误判为斜路，从而生成大量"抄近路"的对角边，破坏轴向与信号灯相位。
      if (d.axis === 'd') {
        const b = tileIndex(nx, nz);
        const bx = nx + d.dx, bz = nz + d.dz;      // 同方向再往前一格
        const cx = x - d.dx, cz = z - d.dz;         // 同方向再往前一格
        let run = false;
        if (bx >= 0 && bz >= 0 && bx < S && bz < S) {
          const t2 = tiles[tileIndex(bx, bz)];
          if (t2 && (t2.road || t2.over)) run = true;
        }
        if (!run && cx >= 0 && cz >= 0 && cx < S && cz < S) {
          const t0 = tiles[tileIndex(cx, cz)];
          if (t0 && (t0.road || t0.over)) run = true;
        }
        if (!run) continue;
      }
      let hit = null;
      for (const bi of nbIdx) {
        const b = list[bi];
        if (!canConnect(a, b)) continue;
        if (hit && b.layer !== hit.layer) {
          // 优先同层
          if (a.layer === hit.layer) continue;
        }
        hit = b;
        if (b.layer === a.layer) break;
      }
      if (hit) a.mask |= d.bit;
    }
  }
  const masks = new Uint8Array(S * S);
  const overMasks = new Uint8Array(S * S);
  for (const a of list) {
    if (a.layer === 0) masks[a.tile] |= a.mask;
    else overMasks[a.tile] |= a.mask;
  }
  return { masks, overMasks, list, at };
}

export function buildNetwork(tiles, roadDefs) {
  const S = MAP.SIZE;
  const { masks, overMasks, list, at } = computeMasks(tiles);

  // ---- 分组：同格的两层（高程均≈0）合并为同一路口；直行段不设节点 ----
  const groupOf = new Int32Array(list.length).fill(-1);
  const groups = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (groupOf[i] !== -1) continue;
    const g = { id: groups.length, layerTiles: [i], mask: a.mask, x: a.tile % S, z: Math.floor(a.tile / S) };
    groupOf[i] = g.id;
    for (let k = 0; k < list.length; k++) {
      const b = list[k];
      if (k !== i && b.tile === a.tile && b.layer !== a.layer && a.h <= 0.6 && b.h <= 0.6) {
        groupOf[k] = g.id;
        g.layerTiles.push(k);
        g.mask |= b.mask;
        break;
      }
    }
    g.wx = worldX(g.x); g.wz = worldZ(g.z);
    g.tile = a.tile;
    groups.push(g);
  }
  // 节点判定按层分别进行（合并路口的任一层是节点即为节点）
  const isNodeGroup = groups.map((g) => g.layerTiles.some((k) => {
    const c = popcount(list[k].mask);
    return !(c === 2 && isOppositePair(list[k].mask));
  }));

  // ---- 路网节点（只包含交叉口 / 断头路 / 弯道） ----
  const nodes = [];
  const nodeIdOfGroup = new Int32Array(groups.length).fill(-1);
  for (const g of groups) {
    if (!isNodeGroup[g.id]) continue;
    nodeIdOfGroup[g.id] = nodes.length;
    // 该路口节点所属的层：含地面层 -> 0，否则为高架层 1
    const nodeLayer = g.layerTiles.some((k) => list[k].layer === 0) ? 0 : 1;
    nodes.push({
      id: nodes.length, tile: g.tile, x: g.x, z: g.z, wx: g.wx, wz: g.wz,
      arcs: [], passing: 0, layer: nodeLayer, hasSignal: false,
      signal: {
        // 相位偏移沿 x/z 递减 -> 形成沿走廊推进的"绿波"
        offset: ((-(g.x + g.z) * SIGNAL.WAVE) % SIGNAL.CYCLE + SIGNAL.CYCLE) % SIGNAL.CYCLE,
        t: (nodes.length * 7) % SIGNAL.CYCLE,
        phase: 0,
        state: 'green',
        split: 0.5,        // 主方向相位占整个周期的比例
        majorPhase: 0,     // 主方向对应的相位号
      },
    });
  }
  // ---- 抽取无向路段 ----
  const edges = [];
  const tileEdge = new Int32Array(S * S).fill(-1);
  const tileOffset = new Float32Array(S * S);
  const overTileEdge = new Int32Array(S * S).fill(-1);
  const seenEdges = new Set();
  const overTileOffset = new Float32Array(S * S);

  const neighborLayer = (ltIdx, d) => {
    const a = list[ltIdx];
    const x = a.tile % S, z = Math.floor(a.tile / S);
    const nx = x + d.dx, nz = z + d.dz;
    if (nx < 0 || nz < 0 || nx >= S || nz >= S) return -1;
    const nbIdx = at.get(tileIndex(nx, nz));
    if (!nbIdx) return -1;
    // 与 computeMasks 保持一致的斜向判定
    if (d.axis === 'd') {
      const c1 = tiles[tileIndex(a.tile % S + d.dx, Math.floor(a.tile / S))];
      const c2 = tiles[tileIndex(a.tile % S, Math.floor(a.tile / S) + d.dz)];
      const b1 = c1.road || c1.over, b2 = c2.road || c2.over;
      if (b1 && b2) return -1;
    }
    let hit = -1;
    for (const bi of nbIdx) {
      const b = list[bi];
      if (!canConnect(a, b)) continue;
      if (hit !== -1) {
        const cur = list[hit];
        if (cur.layer === a.layer) continue;
        if (b.layer === a.layer) { hit = bi; break; }
        continue;
      }
      hit = bi;
      if (b.layer === a.layer) break;
    }
    return hit;
  };

  for (const u of groups) {
    if (!isNodeGroup[u.id]) continue;
    const uNode = nodeIdOfGroup[u.id];
    for (const ltIdx of u.layerTiles) {
      const L = list[ltIdx];
      if (!L) continue;
      for (const d of DIRS) {
        if (!(L.mask & d.bit)) continue;
        const poly = [{ x: u.wx, z: u.wz, y: L.h }];
        const eTiles = [L.tile];
        let curLt = neighborLayer(ltIdx, d);
        let dir = d;
        let endUnit = -1;
        let guard = 0;
        while (curLt !== -1 && guard++ < 400) {
          const C = list[curLt];
          poly.push({ x: worldX(C.tile % S), z: worldZ(Math.floor(C.tile / S)), y: C.h });
          eTiles.push(C.tile);
          const cg = groupOf[curLt];
          if (isNodeGroup[cg]) { endUnit = nodeIdOfGroup[cg]; break; }
          // 中间段：出口是"非回头"的方向
          let exitBit = 0;
          for (const dd of DIRS) {
            if ((C.mask & dd.bit) && dd.bit !== dir.opp) { exitBit = dd.bit; break; }
          }
          if (!exitBit) break;
          dir = dirByBit(exitBit);
          curLt = neighborLayer(curLt, dir);
        }
        if (endUnit === -1) continue;
        const ekey = Math.min(uNode, endUnit) + '-' + Math.max(uNode, endUnit) + '-' + L.layer;
        if (seenEdges.has(ekey)) continue;
        seenEdges.add(ekey);

        const type = eTiles.reduce((mn, t) => Math.min(mn, tiles[t].road || tiles[t].over || 99), 99);
        const def = roadDefs[type];
        const laneTypes = [];
        // 地面层与高架层各自维护车道类型
        const laneSrc = L.layer === 1 ? (tiles[eTiles[0]].olt || 0) : (tiles[eTiles[0]].lt || 0);
        for (let l = 0; l < def.lanes; l++) {
          laneTypes.push((laneSrc >> (l * 2)) & 3);
        }
        const edge = {
          id: edges.length, nodes: [uNode, endUnit], tiles: eTiles,
          length: polyLength(poly), type, def, layer: L.layer,
          // lanes = 道路总车道数（双向）；lanesPerDir = 单向车道数
          lanes: def.lanes, lanesPerDir: Math.max(1, Math.floor(def.lanes / 2)),
          v0: def.v0, congestion: 0,
          density: 0, avgSpeed: def.v0, flow: 0, laneTypes,
        };
        edges.push(edge);
        const arr = L.layer === 1 ? overTileEdge : tileEdge;
        const arrOff = L.layer === 1 ? overTileOffset : tileOffset;
        for (let k = 0; k < eTiles.length; k++) {
          const ti = eTiles[k];
          if (arr[ti] === -1) { arr[ti] = edge.id; arrOff[ti] = k * MAP.TILE; }
        }
      }
    }
  }

  // ---- 有向路段 ----

  const arcs = [];
  for (const edge of edges) {
    const a = nodes[edge.nodes[0]], b = nodes[edge.nodes[1]];
    const forward = { id: arcs.length, edge: edge.id, from: a.id, to: b.id, dir: 1 };
    const backward = { id: arcs.length + 1, edge: edge.id, from: b.id, to: a.id, dir: -1 };
    const polyF = edgePoly(edge, nodes, tiles);
    for (const arc of [forward, backward]) {
      arc.poly = arc.dir === 1 ? polyF : polyF.slice().reverse();
      arc.length = edge.length;
      arc.type = edge.type;
      // 单向车道数：道路总车道数的一半（左右各一半）
      arc.lanes = edge.lanesPerDir;
      arc.v0 = edge.v0;
      arc.def = edge.def;
      arc.layer = edge.layer;
      // 该方向占道路的哪一侧：side = -1 表示「渲染坐标的负半侧」
      // （X 向道路的负半侧 = -Z，Z 向道路的负半侧 = -X）
      const p0 = arc.poly[0], p1 = arc.poly[arc.poly.length - 1];
      const ddx = p1.x - p0.x, ddz = p1.z - p0.z;
      arc.side = arc.axis === 'x' ? (ddx > 0 ? -1 : 1) : (ddz > 0 ? 1 : -1);
      // 车道类型按方向重排：lane 0 = 该方向最右侧车道
      const N = edge.lanes;
      arc.laneTypes = [];
      for (let k = 0; k < arc.lanes; k++) {
        const g = arc.side < 0 ? k : (N - 1 - k);
        arc.laneTypes.push(edge.laneTypes[g] || 0);
      }
      arc.laneVehicles = Array.from({ length: arc.lanes }, () => []);
      arc.vehicles = [];
      arc.congestion = 0;
      arc.axis = arc.poly.length > 1 ? dominantAxis(arc.poly) : 'z';
      arcs.push(arc);
    }
    edge.forwardArc = forward.id;
    edge.backwardArc = backward.id;
    a.arcs.push(forward.id);
    b.arcs.push(backward.id);
  }

  // ---- 连通分量 ----
  // ---- 信号灯资格：真正的交叉口（>=3 个方向）且不是纯高速互通 ----
  for (const node of nodes) {
    const deg = node.arcs.length;
    const allHighway = node.arcs.length > 0 &&
      node.arcs.every((id) => arcs[id].type === 3);
    // 信号灯布设：
    //   四岔及以上、且有主干道（大道/高速）参与 -> 设灯
    //   三岔口只有两条主干道相交                -> 设灯
    //   纯支路交叉 / 死头路                     -> 让行
    const majorZ = node.arcs.filter((id) => arcs[id].type >= 2 && arcs[id].axis !== 'x').length;
    const majorX = node.arcs.filter((id) => arcs[id].type >= 2 && arcs[id].axis === 'x').length;
    const majorArcs = majorZ + majorX;
    node.hasSignal = !allHighway && (deg >= 4 ? majorArcs > 0 : majorArcs >= 4);
    // 主次方向不对称配时：主干道方向绿灯更长（现实中主干道优先放行）
    if (node.hasSignal) {
      if (majorZ >= 2 && majorX >= 2) {
        node.signal.split = 0.5;      // 两条主干道相交 -> 平分绿灯
        node.signal.majorPhase = 0;
      } else if (majorZ >= 2) {
        node.signal.split = 0.62;     // 南北主干 -> 南北多放行
        node.signal.majorPhase = 0;
      } else {
        node.signal.split = 0.38;
        node.signal.majorPhase = 1;
      }
    }
  }

  let components = 0;
  {
    const seen = new Uint8Array(nodes.length);
    for (const start of nodes) {
      if (seen[start.id]) continue;
      components++;
      const stack = [start.id];
      seen[start.id] = 1;
      while (stack.length) {
        const id = stack.pop();
        for (const arcId of nodes[id].arcs) {
          const to = arcs[arcId].to;
          if (!seen[to]) { seen[to] = 1; stack.push(to); }
        }
      }
    }
  }

  return {
    nodes, arcs, edges, masks, overMasks, tileEdge, tileOffset,
    overTileEdge, overTileOffset, components,
  };
}

export function polyLength(poly) {
  let len = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    len += Math.hypot(poly[i + 1].x - poly[i].x, poly[i + 1].z - poly[i].z);
  }
  return len;
}

function dominantAxis(poly) {
  let dx = 0, dz = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    dx += Math.abs(poly[i + 1].x - poly[i].x);
    dz += Math.abs(poly[i + 1].z - poly[i].z);
  }
  if (Math.abs(dx - dz) < 4) return 'd';
  return dx > dz ? 'x' : 'z';
}

function edgePoly(edge, nodes, tiles) {
  const a = nodes[edge.nodes[0]], b = nodes[edge.nodes[1]];
  const pts = [{ x: a.wx, z: a.wz, y: edge.layer === 1 ? (tiles[edge.tiles[0]].h || 0) : 0 }];
  for (let k = 1; k < edge.tiles.length - 1; k++) {
    const ti = edge.tiles[k];
    pts.push({
      x: worldX(ti % MAP.SIZE), z: worldZ(Math.floor(ti / MAP.SIZE)),
      y: edge.layer === 1 ? (tiles[ti].h || 0) : 0,
    });
  }
  const last = edge.tiles[edge.tiles.length - 1];
  pts.push({ x: b.wx, z: b.wz, y: edge.layer === 1 ? (tiles[last].h || 0) : 0 });
  return pts;
}

/** 折线上距离 -> 世界坐标 / 朝向 / 高度 / 坡度 */
export function polyPoint(poly, dist, total) {
  const d = Math.max(0, Math.min(dist, total));
  let acc = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (acc + seg >= d || i === poly.length - 2) {
      const t = seg > 0 ? Math.min(1, Math.max(0, (d - acc) / seg)) : 0;
      return {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        y: (a.y || 0) + ((b.y || 0) - (a.y || 0)) * t,
        heading: Math.atan2(b.x - a.x, b.z - a.z),
        grade: seg > 0 ? ((b.y || 0) - (a.y || 0)) / seg : 0,
        segIndex: i,
      };
    }
    acc += seg;
  }
  const a = poly[0];
  return { x: a.x, z: a.z, y: a.y || 0, heading: 0, grade: 0, segIndex: 0 };
}
