// ============================================================================
//  路网图构建（双层：地面层 / 高架层）
//  瓦片 -> 连接掩码(8方向) -> 节点(交叉口/断头路) + 有向路段(带折线几何与高程)
//  同一条道路可以"上跨"另一条道路：地面层与高架层各自成网，
//  仅在坡道端点（高程≈0）处合并，从而形成真正的立体交叉。
// ============================================================================
import { MAP, ELEV, SIGNAL, TRAFFIC } from './constants.js';

export const DIRS = [
  { dx: 0, dz: -1, bit: 1, name: 'N', opp: 16, axis: 'z', ang: 0 },
  { dx: 1, dz: -1, bit: 2, name: 'NE', opp: 32, axis: 'd', ang: 45 },
  { dx: 1, dz: 0, bit: 4, name: 'E', opp: 64, axis: 'x', ang: 90 },
  { dx: 1, dz: 1, bit: 8, name: 'SE', opp: 128, axis: 'd', ang: 135 },
  { dx: 0, dz: 1, bit: 16, name: 'S', opp: 1, axis: 'z', ang: 180 },
  { dx: -1, dz: 1, bit: 32, name: 'SW', opp: 2, axis: 'd', ang: 225 },
  { dx: -1, dz: 0, bit: 64, name: 'W', opp: 4, axis: 'x', ang: 270 },
  { dx: -1, dz: -1, bit: 128, name: 'NW', opp: 8, axis: 'd', ang: 315 },
];

export const tileIndex = (x, z) => z * MAP.SIZE + x;
export const worldX = (x) => (x + 0.5) * MAP.TILE - (MAP.SIZE * MAP.TILE) / 2;
export const worldZ = (z) => (z + 0.5) * MAP.TILE - (MAP.SIZE * MAP.TILE) / 2;
export const dirByBit = (bit) => DIRS.find((d) => d.bit === bit);

/** 两个瓦片之间的方向位（与 DIRS 的 bit 一致） */
export function dirBitBetween(a, b) {
  const ax = a % MAP.SIZE, az = Math.floor(a / MAP.SIZE);
  const bx = b % MAP.SIZE, bz = Math.floor(b / MAP.SIZE);
  const dx = bx - ax, dz = bz - az;
  if (dx === 0 && dz === 0) return 0;
  if (dx === 0) return dz < 0 ? 1 : 16;
  if (dz === 0) return dx > 0 ? 4 : 64;
  if (dx > 0) return dz < 0 ? 2 : 8;
  return dz > 0 ? 32 : 128;
}

/**
 * 一条道路路径 -> 每格的道路走向位掩码（8 方向）。
 * 路网连接关系直接用这个掩码，而不是「看邻居有没有路」——
 * 后者会在斜向道路旁边凭空造出斜向捷径（在街区中间多出一个路口）。
 */
export function pathDirMasks(tiles) {
  const out = new Map();
  const set = (i, bit) => { out.set(i, (out.get(i) || 0) | bit); };
  for (let k = 1; k < tiles.length; k++) {
    const a = tiles[k - 1], b = tiles[k];
    // 必须是相邻的两格（8 连通）。调用方有时会一次传入一堆不按顺序排的瓦片
    // （比如「同时建三条路」），这种就整个放弃记录，退回邻居推断。
    const adx = Math.abs(a % MAP.SIZE - b % MAP.SIZE);
    const adz = Math.abs(Math.floor(a / MAP.SIZE) - Math.floor(b / MAP.SIZE));
    if (adx > 1 || adz > 1) return new Map();
    const bit = dirBitBetween(a, b);
    if (!bit) continue;
    set(a, bit);
    set(b, dirBitBetween(b, a));
  }
  return out;
}

/**
 * 由「驶入路口的行驶方向」反推进口方向：
 *   朝南开(+Z) 的人来自北方 -> 'N'；朝北开的人来自南方 -> 'S'；
 *   朝东开(+X) 的人来自西方 -> 'W'；朝西开的人来自东方 -> 'E'。
 */
export function approachDir(heading) {
  const fx = Math.sin(heading), fz = Math.cos(heading);
  if (Math.abs(fz) >= Math.abs(fx)) return fz > 0 ? 'N' : 'S';
  return fx > 0 ? 'W' : 'E';
}

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
    // 地面层的高度 = 路面高程（随地形起伏；桥面 / 隧道也在这里）
    if (t.road) { idxs.push(list.length); list.push({ tile: i, type: t.road, h: t.roadH || 0, layer: 0, mask: 0 }); }
    if (t.over) { idxs.push(list.length); list.push({ tile: i, type: t.over, h: t.h || 0, layer: 1, mask: 0 }); }
    if (idxs.length) at.set(i, idxs);
  }
  return { list, at };
}

/** 两个层格点能否直接相连 */
function canConnect(a, b) {
  // 留一点容差：路面高程是浮点运算，恰好等于坡度上限时会因为舍入而断开路网
  if (a.layer === b.layer) return Math.abs(a.h - b.h) <= ELEV.MAX_RAMP + 0.12;
  // 跨层仅在坡道落地处连通（两层路面高度一致）
  return Math.abs(a.h - b.h) <= 0.6;
}

/** 该格记录的道路走向掩码（新存档有；老存档为 0） */
function storedDirs(tiles, tile, layer) {
  const t = tiles[tile];
  if (!t) return 0;
  return layer === 1 ? (t.od | 0) : (t.rd | 0);
}

export function computeMasks(tiles) {
  const { list, at } = collectLayers(tiles);
  const S = MAP.SIZE;
  for (const a of list) {
    const x = a.tile % S, z = Math.floor(a.tile / S);
    // 新存档：直接用「这条路实际往哪走」决定连通关系。
    // 旧存档没有记录，退回邻居推断（斜向要同方向再往前一格也有路）。
    const dirs = storedDirs(tiles, a.tile, a.layer);
    for (const d of DIRS) {
      // 记录了走向 -> 只沿着这条路真正延伸的方向连通
      if (dirs && !(dirs & d.bit)) continue;
      const nx = x + d.dx, nz = z + d.dz;
      if (nx < 0 || nz < 0 || nx >= S || nz >= S) continue;
      const nbIdx = at.get(tileIndex(nx, nz));
      if (!nbIdx) continue;
      // 斜向连接：只有当这两格同属一条连续的斜向道路时才建立
      // （斜向至少连成 2 格的一串）。否则十字路口的两个转角格会被
      // 误判为斜路，从而生成大量"抄近路"的对角边，破坏轴向与信号灯相位。
      if (d.axis === 'd' && !dirs) {
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
      if (k !== i && b.tile === a.tile && b.layer !== a.layer && Math.abs(a.h - b.h) <= 0.6) {
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
      mask: g.mask,
      // 进口方向（从哪个方向开进来）与「是否大型路口」由 traffic.rebuild 补全
      approaches: [], slip: null, wide: false,
      signal: {
        // 相位偏移沿 x/z 递减 -> 形成沿走廊推进的"绿波"
        offset: ((-(g.x + g.z) * SIGNAL.WAVE) % SIGNAL.CYCLE + SIGNAL.CYCLE) % SIGNAL.CYCLE,
        baseOffset: ((-(g.x + g.z) * SIGNAL.WAVE) % SIGNAL.CYCLE + SIGNAL.CYCLE) % SIGNAL.CYCLE,
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
    // 与 computeMasks 保持一致的斜向判定（新存档有走向记录时以记录为准）
    if (d.axis === 'd' && !storedDirs(tiles, a.tile, a.layer)) {
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

  /** 只找「同层」的邻居（用于挑边时优先走同层直连） */
  const neighborSameLayer = (ltIdx, d) => {
    const a = list[ltIdx];
    const x = a.tile % S, z = Math.floor(a.tile / S);
    const nx = x + d.dx, nz = z + d.dz;
    if (nx < 0 || nz < 0 || nx >= S || nz >= S) return -1;
    const nbIdx = at.get(tileIndex(nx, nz));
    if (!nbIdx) return -1;
    if (d.axis === 'd' && !storedDirs(tiles, a.tile, a.layer)) {
      const c1 = tiles[tileIndex(a.tile % S + d.dx, Math.floor(a.tile / S))];
      const c2 = tiles[tileIndex(a.tile % S, Math.floor(a.tile / S) + d.dz)];
      const b1 = c1.road || c1.over, b2 = c2.road || c2.over;
      if (b1 && b2) return -1;
    }
    for (const bi of nbIdx) {
      const b = list[bi];
      if (b.layer !== a.layer) continue;
      if (!canConnect(a, b)) continue;
      return bi;
    }
    return -1;
  };

  for (const u of groups) {
    if (!isNodeGroup[u.id]) continue;
    const uNode = nodeIdOfGroup[u.id];
    // 每个方向最多建一条边。同一节点上地面层与高架层常常同时存在
    // （立交 / 匝道落地点），如果每个层各走一遍，就会生成
    // 「一层地面 + 一层高架」的重复边，而且那条边的等级/限速/高程
    // 会取错层 —— 表现为隧道里的车悬空、地面隧道被当成高速。
    // 规则：优先「同层直连」，没有才用跨层连接。
    for (const d of DIRS) {
      if (!(u.mask & d.bit)) continue;
      let ltIdx = -1, fallback = -1;
      for (const k of u.layerTiles) {
        if (!(list[k].mask & d.bit)) continue;
        if (fallback < 0) fallback = k;
        if (neighborSameLayer(k, d) >= 0) { ltIdx = k; break; }
      }
      if (ltIdx < 0) ltIdx = fallback;
      if (ltIdx < 0) continue;
      {
        const L = list[ltIdx];
        if (!L) continue;
        const poly = [{ x: u.wx, z: u.wz, y: L.h }];
        const eTiles = [L.tile];
        const eLayer = [L.layer];
        let curLt = neighborLayer(ltIdx, d);
        let dir = d;
        let endUnit = -1;
        let guard = 0;
        while (curLt !== -1 && guard++ < 400) {
          const C = list[curLt];
          poly.push({ x: worldX(C.tile % S), z: worldZ(Math.floor(C.tile / S)), y: C.h });
          eTiles.push(C.tile);
          eLayer.push(C.layer);
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

        // 道路等级必须按「本层」取：地面层看 road，高架层看 over。
        // 之前用 min(road, over) 会让「高架高速跨过大道路面」的那几格
        // 把整条高架高速的等级算成大道 —— 于是限速、车道数、宽度全都不对，
        // 高架上也就永远没有车（太慢没人愿意走）。
        const type = eTiles.reduce((mn, t, k) => {
          const v = eLayer[k] === 1 ? (tiles[t].over || 0) : (tiles[t].road || 0);
          return v ? Math.min(mn, v) : mn;
        }, 99);
        const def = roadDefs[type];
        const laneTypes = [];
        // 地面层与高架层各自维护车道类型
        const laneSrc = eLayer[0] === 1 ? (tiles[eTiles[0]].olt || 0) : (tiles[eTiles[0]].lt || 0);
        for (let l = 0; l < def.lanes; l++) {
          laneTypes.push((laneSrc >> (l * 2)) & 3);
        }
        const edge = {
          id: edges.length, nodes: [uNode, endUnit], tiles: eTiles,
          length: polyLength(poly), type, def, layer: L.layer, tileLayer: eLayer,
          // lanes = 道路总车道数（双向）；lanesPerDir = 单向车道数
          lanes: def.lanes, lanesPerDir: Math.max(1, Math.floor(def.lanes / 2)),
          v0: def.v0, congestion: 0,
          density: 0, avgSpeed: def.v0, flow: 0, laneTypes,
        };
        edges.push(edge);
        for (let k = 0; k < eTiles.length; k++) {
          const ti = eTiles[k];
          const arr = eLayer[k] === 1 ? overTileEdge : tileEdge;
          const arrOff = eLayer[k] === 1 ? overTileOffset : tileOffset;
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
      arc.axis = arc.poly.length > 1 ? dominantAxis(arc.poly) : 'z';
      // 该方向占道路的哪一侧：side = -1 表示「渲染坐标的负半侧」
      // （X 向道路的负半侧 = -Z，Z 向道路的负半侧 = -X）
      // 注意：arc.axis 必须先算出来 —— 之前 side 用的是 undefined 的 axis，
      // 于是所有东西向道路都按「Z 向」处理，西行车道的车道类型被镜像了。
      const p0 = arc.poly[0], p1 = arc.poly[arc.poly.length - 1];
      const ddx = p1.x - p0.x, ddz = p1.z - p0.z;
      arc.side = arc.axis === 'x' ? (ddx > 0 ? -1 : 1) : (ddz > 0 ? 1 : -1);
      // 车道类型按方向重排：lane 0 = 该方向最右侧车道（右侧通行）
      const N = edge.lanes;
      arc.laneTypes = [];
      for (let k = 0; k < arc.lanes; k++) {
        // 右侧通行：本方向最右侧车道 = 全局车道号中「靠行车方向右侧」的那一条。
        // （原来这里是镜像的 —— 等于整个城市在靠左行驶）
        const g = arc.side < 0 ? (N - 1 - k) : k;
        arc.laneTypes.push(edge.laneTypes[g] || 0);
      }
      arc.laneVehicles = Array.from({ length: arc.lanes }, () => []);
      arc.vehicles = [];
      arc.congestion = 0;
      // 段首 / 段尾的行驶方向（转向判定要用，避免每帧重算几何）
      arc.startHeading = arc.poly.length > 1
        ? Math.atan2(arc.poly[1].x - arc.poly[0].x, arc.poly[1].z - arc.poly[0].z) : 0;
      const L2 = arc.poly.length - 1;
      arc.endHeading = arc.poly.length > 1
        ? Math.atan2(arc.poly[L2].x - arc.poly[L2 - 1].x, arc.poly[L2].z - arc.poly[L2 - 1].z) : 0;
      // 弯道限速：拐弯越急，能跑的速度越低（真实道路就是这样）
      const turn = maxTurnAngle(arc.poly);
      arc.turnAngle = turn;
      arc.curveLimit = turn > TRAFFIC.CURVE_ANGLE ? arc.v0 * TRAFFIC.CURVE_SPEED : arc.v0;
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
    //   两条以上主干道（大道/高速）相交 -> 设灯（三岔口也算）
    //   四岔口 + 至少一条主干道         -> 设灯
    //   纯支路交叉 / 死头路              -> 让行
    // 注意：同一条路的两端算「一条路」，要用 edge 去重（否则三岔口会漏判）
    const majorEdges = new Set();
    for (const arcId of node.arcs) {
      const a = arcs[arcId];
      if (a.type >= 2) majorEdges.add(a.edge);
    }
    node.hasSignal = !allHighway && (majorEdges.size >= 2 || (deg >= 4 && majorEdges.size >= 1));

    // ---- 进口方向 & 弧形右转通道 ---------------------------------------
    // 一个路口的「进口」= 从哪个方向开进来的车道。
    // 右侧通行下：进口在北(N) -> 右转出口在西(W)，用的是路口的西北角。
    const ARM_BIT = { N: 1, E: 4, S: 16, W: 64 };
    const RIGHT_EXIT = { N: 'W', E: 'N', S: 'E', W: 'S' };
    const CORNER_BIT = { N: 128, E: 2, S: 32, W: 8 };
    const acc = {};
    for (const arcId of node.arcs) {
      // node.arcs 里存的是「从本节点出发」的有向段；
      // 驶入本节点的那一条是同一条路的反向段（to === node.id）。
      const outArc = arcs[arcId];
      const edge = edges[outArc.edge];
      const inArcId = (arcId === edge.forwardArc) ? edge.backwardArc : edge.forwardArc;
      const arc = arcs[inArcId];
      if (!arc || arc.to !== node.id) continue;
      const p = polyPoint(arc.poly, arc.length, arc.length);
      const dir = approachDir(p.heading);
      const a = acc[dir] || (acc[dir] = {
        dir, axis: (dir === 'N' || dir === 'S') ? 'z' : 'x', arcs: [], lanes: 0, width: 0, type: 0,
      });
      a.arcs.push(inArcId);
      a.lanes = Math.max(a.lanes, arc.lanes);
      a.width = Math.max(a.width, arc.def.width);
      a.type = Math.max(a.type, arc.type);
    }
    node.approaches = Object.keys(acc).map((k) => acc[k]);
    // 停止线：路口的近边（垂直方向那条路的半宽 + 余量）
    // 车辆应该在路口外的停止线前停车，而不是压在路口里。
    node.stopLine = {};
    node.clearDist = 6;
    for (const a of node.approaches) {
      const crossAxis = a.axis === 'x' ? 'z' : 'x';
      let hw = 0;
      for (const b of node.approaches) {
        if (b.axis !== crossAxis) continue;
        hw = Math.max(hw, b.width / 2);
      }
      if (!hw) hw = a.width / 2;
      node.stopLine[a.dir] = hw + 1.2;
      node.clearDist = Math.max(node.clearDist, hw + 2.5);
    }
    // 大型路口：至少两条「双向多车道 / 大道级」的路相交
    node.wide = node.approaches.filter((a) => a.lanes >= 2 || a.type >= 2).length >= 2;
    // 弧形右转通道（slip lane）：四岔大路口 + 路口角上没有别的路 -> 右转走外侧弧线
    node.slip = {};
    for (const a of node.approaches) {
      const ex = RIGHT_EXIT[a.dir];
      const exitArm = (node.mask & ARM_BIT[ex]) !== 0;
      const cornerFree = (node.mask & CORNER_BIT[a.dir]) === 0;
      node.slip[a.dir] = !!(node.wide && node.approaches.length >= 4 && exitArm && cornerFree);
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

/** 折线上最大的转角（弧度）—— 用来判断是不是「急弯」 */
function maxTurnAngle(poly) {
  let m = 0;
  for (let i = 1; i < poly.length - 1; i++) {
    const a1 = Math.atan2(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z);
    const a2 = Math.atan2(poly[i + 1].x - poly[i].x, poly[i + 1].z - poly[i].z);
    let d = a2 - a1;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const ad = Math.abs(d);
    if (ad > m) m = ad;
  }
  return m;
}

function edgePoly(edge, nodes, tiles) {
  const a = nodes[edge.nodes[0]], b = nodes[edge.nodes[1]];
  // 每格按「它自己所在的那一层」取高程：混合边（地面 -> 匝道 -> 高架）
  // 每一格的高度都不同，用整条边的层号会让隧道里的车悬空 7 米。
  const layers = edge.tileLayer || [];
  const yOf = (k) => {
    const ti = edge.tiles[k];
    return (layers[k] === 1) ? (tiles[ti].h || 0) : (tiles[ti].roadH || 0);
  };
  const pts = [{ x: a.wx, z: a.wz, y: yOf(0) }];
  for (let k = 1; k < edge.tiles.length - 1; k++) {
    const ti = edge.tiles[k];
    pts.push({
      x: worldX(ti % MAP.SIZE), z: worldZ(Math.floor(ti / MAP.SIZE)),
      y: yOf(k),
    });
  }
  const last = edge.tiles[edge.tiles.length - 1];
  pts.push({ x: b.wx, z: b.wz, y: yOf(edge.tiles.length - 1) });
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
