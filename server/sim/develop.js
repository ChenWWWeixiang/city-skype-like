// ============================================================================
//  城市发展系统：服务覆盖 / 土地价值 / 建筑成长 / 需求 RCI / 幸福度 / 预算
// ============================================================================
import {
  MAP, ZONES, BUILDING_CAPS, DEMAND, LAND, HAPPINESS, ECON,
  SERVICE_BY_ID, TERRAIN, EFFICIENCY,
} from './constants.js';
import { tileIndex } from './roadnet.js';

const S = MAP.SIZE;

/** 清除地块上的建筑（保留地块本身） */
function _clearBuilding(t) {
  t.level = 0; t.pop = 0; t.jobs = 0; t.age = 0;
}

/** 是否与道路相邻 */
function hasRoadAccess(city, i) {
  const x = i % S, z = (i / S) | 0;
  if (x > 0 && city.tiles[i - 1].road) return true;
  if (x < S - 1 && city.tiles[i + 1].road) return true;
  if (z > 0 && city.tiles[i - S].road) return true;
  if (z < S - 1 && city.tiles[i + S].road) return true;
  return false;
}

/** 瓦片所连路段的拥堵度 0..1 */
function tileCongestion(city, i) {
  if (!city.net) return 0;
  const x = i % S, z = (i / S) | 0;
  let best = 0;
  const check = (ni) => {
    if (ni < 0 || ni >= city.tiles.length) return;
    const t = city.tiles[ni];
    if (!t.road) return;
    const eid = city.net.tileEdge[ni];
    if (eid < 0) return;
    const c = city.net.edges[eid].congestion;
    if (c > best) best = c;
  };
  if (x > 0) check(i - 1);
  if (x < S - 1) check(i + 1);
  if (z > 0) check(i - S);
  if (z < S - 1) check(i + S);
  return best;
}

/** 服务设施覆盖（含容量衰减） */
function updateCoverage(city) {
  const tiles = city.tiles;
  const powerMask = new Uint8Array(S * S);
  const waterMask = new Uint8Array(S * S);
  const serviceScore = new Float32Array(S * S);
  const parkScore = new Float32Array(S * S);

  const svcTiles = [];
  for (let i = 0; i < tiles.length; i++) if (tiles[i].service) svcTiles.push(i);

  for (const i of svcTiles) {
    const def = SERVICE_BY_ID[tiles[i].service];
    if (!def) continue;
    const cx = i % S, cz = (i / S) | 0;
    const rad = def.radius / MAP.TILE;
    const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(S - 1, Math.ceil(cx + rad));
    const z0 = Math.max(0, Math.floor(cz - rad)), z1 = Math.min(S - 1, Math.ceil(cz + rad));
    let servedPop = 0;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, z - cz);
        if (d > rad) continue;
        const ni = tileIndex(x, z);
        const falloff = 1 - (d / rad) * 0.55;
        if (def.id === 6) powerMask[ni] = 1;
        else if (def.id === 7) waterMask[ni] = 1;
        else if (def.id === 5) parkScore[ni] = Math.max(parkScore[ni], falloff);
        else {
          serviceScore[ni] += falloff;
          servedPop += tiles[ni].pop || 0;
        }
      }
    }
    // 容量衰减：服务人口超过容量则效果打折
    if (def.capacity && servedPop > def.capacity) {
      const k = def.capacity / servedPop;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x - cx, z - cz);
          if (d > rad) continue;
          const ni = tileIndex(x, z);
          if (serviceScore[ni] > 0) serviceScore[ni] = Math.min(serviceScore[ni], serviceScore[ni] * k);
        }
      }
    }
  }

  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    t.power = !!powerMask[i];
    t.water = !!waterMask[i];
    t.coverage = Math.min(1, serviceScore[i] / 2.2);
    t.park = parkScore[i];
  }
  let pw = 0, ww = 0;
  for (const i of city.residentialTiles || []) { if (tiles[i].power) pw++; }
  for (const i of city.residentialTiles || []) { if (tiles[i].water) ww++; }
  const resCount = Math.max(1, (city.residentialTiles || []).length);
  city.stats.powerCoverage = (pw / resCount) * 100;
  city.stats.waterCoverage = (ww / resCount) * 100;
}

/** 污染场（工业源扩散） */
function computePollution(city) {
  const poll = new Float32Array(S * S);
  for (let i = 0; i < city.tiles.length; i++) {
    const t = city.tiles[i];
    if (t.zone === 3 && t.level > 0) poll[i] += ZONES.ind.pollution * 100 * t.level;
  }
  for (let it = 0; it < 3; it++) {
    const next = new Float32Array(S * S);
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const i = tileIndex(x, z);
        let sum = 0, n = 0;
        if (x > 0) { sum += poll[i - 1]; n++; }
        if (x < S - 1) { sum += poll[i + 1]; n++; }
        if (z > 0) { sum += poll[i - S]; n++; }
        if (z < S - 1) { sum += poll[i + S]; n++; }
        next[i] = poll[i] * 0.55 + (n ? sum / n : 0) * 0.45;
      }
    }
    poll.set(next);
  }
  let max = 1;
  for (let i = 0; i < poll.length; i++) if (poll[i] > max) max = poll[i];
  for (let i = 0; i < poll.length; i++) city.tiles[i].pollution = (poll[i] / max) * 100;
}

/** 土地价值计算 */
function computeLandValue(city) {
  const tiles = city.tiles;
  computePollution(city);
  const raw = new Float32Array(S * S);
  let sum = 0, cnt = 0;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (t.terrain === TERRAIN.water) { raw[i] = 0; continue; }
    let v = LAND.BASE;
    const x = i % S, z = (i / S) | 0;
    // 临路加成
    let roadQ = 0;
    if (x > 0 && tiles[i - 1].road) roadQ = Math.max(roadQ, quality(tiles[i - 1].road));
    if (x < S - 1 && tiles[i + 1].road) roadQ = Math.max(roadQ, quality(tiles[i + 1].road));
    if (z > 0 && tiles[i - S].road) roadQ = Math.max(roadQ, quality(tiles[i - S].road));
    if (z < S - 1 && tiles[i + S].road) roadQ = Math.max(roadQ, quality(tiles[i + S].road));
    v += LAND.ROAD_BONUS * roadQ;
    // 服务与公园
    v += LAND.SERVICE_BONUS * t.coverage;
    v += LAND.PARK_BONUS * (t.park || 0);
    // 污染与拥堵
    v -= LAND.POLLUTION_PENALTY * (t.pollution / 100);
    v -= LAND.CONGESTION_PENALTY * tileCongestion(city, i);
    // 滨水加成
    let nearWater = false;
    for (let dz = -2; dz <= 2 && !nearWater; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= S || nz >= S) continue;
        if (tiles[tileIndex(nx, nz)].terrain === TERRAIN.water) { nearWater = true; break; }
      }
    }
    if (nearWater) v += LAND.WATER_BONUS;
    if (t.zone === 1) v += 5;
    if (t.zone === 2) v += 8;
    if (t.zone === 3) v -= 6;
    raw[i] = Math.max(LAND.MIN, Math.min(LAND.MAX, v));
    sum += raw[i]; cnt++;
  }
  // 空间扩散（平滑）
  let cur = raw;
  for (let it = 0; it < 2; it++) {
    const next = new Float32Array(S * S);
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const i = tileIndex(x, z);
        let sum2 = cur[i], n = 1;
        if (x > 0) { sum2 += cur[i - 1]; n++; }
        if (x < S - 1) { sum2 += cur[i + 1]; n++; }
        if (z > 0) { sum2 += cur[i - S]; n++; }
        if (z < S - 1) { sum2 += cur[i + S]; n++; }
        next[i] = cur[i] * LAND.DIFFUSE_RATE + (sum2 / n) * (1 - LAND.DIFFUSE_RATE);
      }
    }
    cur = next;
  }
  let s2 = 0, c2 = 0, zs = 0, zc = 0;
  for (let i = 0; i < tiles.length; i++) {
    const v = Math.round(Math.max(LAND.MIN, Math.min(LAND.MAX, cur[i])));
    if (Math.abs(v - tiles[i].land) >= 2) { tiles[i].land = v; city.markDirty(i); }
    if (tiles[i].terrain !== TERRAIN.water) { s2 += v; c2++; }
    if (tiles[i].zone) { zs += v; zc++; }
  }
  city.stats.landValueAvg = c2 ? s2 / c2 : 0;
  city.stats.landValueZoned = zc ? zs / zc : city.stats.landValueAvg;
}

function quality(roadType) {
  if (roadType === 2) return 1.35;
  if (roadType === 3) return 0.85;
  return 1;
}

/**
 * 拥堵 -> 效率：
 *   工业区原料进不来 / 货物出不去 -> 工厂无法按时开工，产出下降
 *   商业区客流与物流受阻       -> 营业额下降，长期则倒闭
 *   住宅区通勤受阻             -> 居民幸福度下降
 */
function updateEfficiency(city) {
  const tiles = city.tiles;
  let sumInd = 0, nInd = 0, sumCom = 0, nCom = 0, sumRes = 0, nRes = 0;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (!t.zone) { t.eff = 1; continue; }
    const cong = tileCongestion(city, i);
    const loss = t.zone === 3 ? EFFICIENCY.IND_LOSS : t.zone === 2 ? EFFICIENCY.COM_LOSS : EFFICIENCY.RES_LOSS;
    const utility = (t.power && t.water) ? 1 : 0.55;   // 断电断水同样停产
    t.eff = Math.max(0.12, (1 - cong * loss) * utility);
    if (t.zone === 3) { sumInd += t.eff; nInd++; }
    else if (t.zone === 2) { sumCom += t.eff; nCom++; }
    else { sumRes += t.eff; nRes++; }
  }
  city.stats.effIndustrial = nInd ? sumInd / nInd : 1;
  city.stats.effCommercial = nCom ? sumCom / nCom : 1;
  city.stats.effResidential = nRes ? sumRes / nRes : 1;
}

/** 建筑成长与衰退 */
function updateGrowth(city) {
  const tiles = city.tiles;
  const d = city.demand;
  const dByZone = { 1: d.res, 2: d.com, 3: d.ind };
  // 建筑等级门槛：地价越高越容易长成高层，郊区保持低层，形成城市天际线梯度
  const landThreshold = [0, 22, 52, 78];
  let changed = false;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (!t.zone) continue;
    t.age++;
    const demand = dByZone[t.zone] || 0;
    const access = hasRoadAccess(city, i);
    const ok = t.power && t.water;
    if (t.level === 0) {
      // 空地 -> 一级建筑
      if (access && ok && demand > 0.02 && t.land >= landThreshold[1]) {
        // 一级建筑发展较快：规划后 1~2 个游戏小时内就能看到房子冒出来
        const p = Math.min(0.9, demand * (t.land / 100) * 1.2);
        // 住宅是空的：人口由「人口账本」（外来车辆 + 新生儿）填进来；
        // 商业/工业开门即满编（岗位先于人口出现，移民才有工作可找）
        if (Math.random() < p) { t.level = 1; t.age = 0; t.occ = (t.zone === 1 ? 0 : 1); changed = true; }
      }
    } else if (t.level < 3) {
      // 升级
      if (access && ok && demand > 0.05 && t.land >= landThreshold[t.level + 1]) {
        // 逐级生长：一级->二级较快，二级->三级更慢（城市需要好多天才能长成）
        const p = demand * (t.land / 100) * (t.level === 1 ? 0.075 : 0.05);
        if (Math.random() < p) { t.level++; t.age = 0; t.occ = (t.zone === 1 ? 0 : 1); changed = true; }
      } else if (t.zone === 2 && t.eff < EFFICIENCY.CLOSE_THRESHOLD) {
        // 交通堵塞导致经营不善 -> 倒闭
        const p = EFFICIENCY.CLOSE_CHANCE * (1 - t.eff / EFFICIENCY.CLOSE_THRESHOLD);
        if (Math.random() < p) { t.level--; t.age = 0; changed = true; }
      } else if (!ok || demand < -0.15) {
        // 衰退一级
        const p = (!ok ? 0.06 : 0) + (demand < -0.15 ? -demand * 0.08 : 0);
        if (Math.random() < p) { t.level--; t.age = 0; changed = true; }
      }
    } else {
      // 满级后也可能衰退
      if (!ok || demand < -0.25) {
        const p = (!ok ? 0.05 : 0) + (demand < -0.25 ? -demand * 0.05 : 0);
        if (Math.random() < p) { t.level--; t.age = 0; changed = true; }
      }
    }
  }
  // 等级变化 -> 标记脏块并通知客户端
  if (!city._lastLevel) city._lastLevel = new Int32Array(tiles.length);
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].level !== city._lastLevel[i]) {
      city._lastLevel[i] = tiles[i].level;
      city.markDirty(i);
    }
  }
  if (changed) { city.refreshAggregates(); city.updateCoverage(); }
}

/**
 * 人口 / 岗位的「实时入住率」模型
 * -------------------------------------------------------------
 * 建筑建好不等于立刻满员：居民按需求、幸福度、拥堵程度分批搬入或搬出，
 * 于是人口是一个**随时在变**的连续数值，而不是建好那一刻就固定的台阶函数。
 *   - 住宅：入住率随住宅需求与幸福度变化（需求低 -> 居民搬走 -> 人口下降）
 *   - 商业/工业：岗位填充率随商业/工业需求变化（订单不足 -> 裁员 -> 岗位下降）
 */
function updateOccupancy(city, dtMin) {
  const d = city.demand;
  const st = city.stats;
  const happy = st.happiness === undefined ? 70 : st.happiness;
  const happyF = 0.45 + 0.55 * (happy / 100);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  // 昼夜节律：白天生意旺、客流大，夜间回落 —— 人口与岗位因此持续小幅波动
  const hour = city.hourOfDay;
  const daily = 0.86 + 0.26 * Math.sin((hour - 9) / 24 * Math.PI * 2);
  const comTarget = clamp01(0.18 + d.com * 0.95) * daily;
  const indTarget = clamp01(0.18 + d.ind * 0.95) * (0.9 + 0.2 * daily);
  // 每小时趋近目标 4%（入住/搬出是缓慢过程）
  const k = Math.min(0.4, 0.04 * (dtMin / 60));
  const tiles = city.tiles;
  // ---- 住宅：人口来自「人口账本」（外来车辆 + 新生儿），再分配到房子里 ----
  // 需求只影响「房子盖不盖、盖多高」（建筑成长），不再凭空变出人口。
  const dem = city.demography || { housed: 0, pop: 0, waiting: 0 };
  const resList = city.residentialTiles || [];
  const caps = BUILDING_CAPS.res;
  let capTotal = 0;
  let occupied = 0;
  for (const i of resList) {
    const t = tiles[i];
    if (!t.level) { t.occ = 0; continue; }
    const eff = t.eff === undefined ? 1 : t.eff;
    capTotal += caps[t.level] * eff;
    occupied += caps[t.level] * eff * t.occ;
  }
  // 待安置（移民到了但没房）：先挤进空着的房子，实在没房就露宿
  if (dem.waiting > 0 && capTotal > 0) {
    const free = Math.max(0, capTotal - occupied);
    const settle = Math.min(dem.waiting, free);
    if (settle > 0) {
      dem.waiting -= settle;
      dem.housed += settle;
    }
  }
  // 分配：等级高 / 地价高的房子先住满（真实的城市形态：一栋楼住满、另一栋空着）
  const resSorted = resList.slice().sort((a, b) => {
    const ta = tiles[a], tb = tiles[b];
    if ((tb.level || 0) !== (ta.level || 0)) return (tb.level || 0) - (ta.level || 0);
    return (tb.land || 0) - (ta.land || 0);
  });
  let remain = Math.max(0, dem.housed || 0);
  const k2 = Math.min(0.9, 0.6 * (dtMin / 60));
  for (const i of resSorted) {
    const t = tiles[i];
    if (!t.level) { t.occ = 0; continue; }
    const eff = t.eff === undefined ? 1 : t.eff;
    const cap = caps[t.level] * eff;
    const take = Math.min(remain, cap);
    remain -= take;
    const target = cap > 0 ? take / cap : 0;
    const diff = target - t.occ;
    // 变化很大时直接对齐（新车/移民入住），平时平滑过渡
    if (Math.abs(diff) > 0.25) t.occ = target;
    else t.occ += diff * k2;
    if (t.occ < 0.002) t.occ = 0;
    if (t.occ > 0.998) t.occ = 1;
  }
  dem.homeless = Math.max(0, dem.waiting);
  for (const i of city.commercialTiles || []) {
    const t = tiles[i];
    if (!t.level) { t.occ = 0; continue; }
    t.occ += (comTarget - t.occ) * k;
    if (t.occ < 0.002) t.occ = 0;
    if (t.occ > 0.998) t.occ = 1;
  }
  for (const i of city.industrialTiles || []) {
    const t = tiles[i];
    if (!t.level) { t.occ = 0; continue; }
    t.occ += (indTarget - t.occ) * k;
    if (t.occ < 0.002) t.occ = 0;
    if (t.occ > 0.998) t.occ = 1;
  }
}

/** RCI 需求 */
function updateDemand(city) {
  const st = city.stats;
  const pop = st.population, jobs = st.jobs;
  const cong = (city.traffic.stats.congestion || 0) / 100;
  const tax = city.tax;
  const happy = st.happiness;
  const landAvg = st.landValueZoned ?? st.landValueAvg;
  const jobsPerCap = jobs / Math.max(1, pop);
  const popPerJob = pop / Math.max(1, jobs);

  const landD = (landAvg - 40) / 100;
  const comJobs = st.comJobs || 0, indJobs = st.indJobs || 0;

  // 小城市阶段不因高失业率扼杀成长（避免开局死锁）
  const unempW = Math.min(1, pop / 260);
  // 住宅：取决于岗位供给（每 1 居民约需 0.45 岗位）
  let res = DEMAND.RES_BASE;
  res += (1 - st.unemployment) * 0.30 * (0.4 + 0.6 * unempW);
  // 失业惩罚设上限，避免"无岗位 -> 无住宅 -> 永远无岗位"的开局死锁
  res -= Math.min(0.28, st.unemployment * DEMAND.UNEMPLOY_RES * 0.45 * unempW);
  res += jobsPerCap > 0.42 ? 0.26 : (jobsPerCap > 0.12 ? 0.04 : -0.06);
  res -= tax.res * DEMAND.TAX_PENALTY;
  res -= cong * DEMAND.CONGESTION_PENALTY;
  res += ((happy - 60) / 100) * 0.45;
  res += landD * DEMAND.LANDVALUE_PULL;
  // 对外连接（高速出入口）= 城市对外来人口有吸引力：住宅需求提升
  const gateN = Math.min(4, (city.entrances || []).length);
  if (gateN) res += 0.07 * gateN * (1 - cong * 0.5);
  if (st.population > 0 && st.powerCoverage < 90) res -= DEMAND.BROWNOUT_PENALTY * (1 - st.powerCoverage / 100);
  // 住房缺口：已规划但尚未开发的住宅越多，越需要人口填充
  let resEmpty = 0, resTotal = 0;
  for (const i of city.residentialTiles || []) {
    resTotal++;
    if (city.tiles[i].level === 0) resEmpty++;
  }
  if (resTotal > 0 && resEmpty > resTotal * 0.35) {
    res += 0.32 * (resEmpty / resTotal);
  }

  // 商业：服务居民，商业岗位目标约为人口的 20%
  let com = DEMAND.COM_BASE;
  com += comJobs < pop * 0.20 ? 0.30 : -0.14;
  com += pop > 300 ? 0.10 : 0;
  com -= tax.com * DEMAND.TAX_PENALTY;
  com -= st.unemployment * DEMAND.UNEMPLOY_COM * 0.4 * unempW;
  com -= cong * DEMAND.CONGESTION_PENALTY * 0.55;
  com += landD * 0.5;

  // 工业：生产商品，工业岗位目标约为人口的 28%
  let ind = DEMAND.IND_BASE;
  ind += Math.min(1, pop / 700) * 0.30;
  ind += indJobs < pop * 0.28 ? 0.26 : -0.06;
  ind -= tax.ind * DEMAND.TAX_PENALTY;
  ind -= cong * DEMAND.CONGESTION_PENALTY * 0.35;
  ind += landD * 0.25;

  const clamp = (v) => Math.max(-1, Math.min(1, v));
  city.demand = { res: clamp(res), com: clamp(com), ind: clamp(ind) };
}

/** 幸福度 */
function updateHappiness(city) {
  const st = city.stats;
  const tiles = city.tiles;
  const resTiles = city.residentialTiles || [];
  let cov = 0, land = 0, n = 0;
  for (const i of resTiles) {
    cov += tiles[i].coverage;
    land += tiles[i].land;
    n++;
  }
  const avgCov = n ? cov / n : 0.6;
  const avgLand = n ? land / n : st.landValueAvg;
  const cong = (city.traffic.stats.congestion || 0) / 100;
  const avgTax = (city.tax.res + city.tax.com + city.tax.ind) / 3;
  let h = HAPPINESS.BASE;
  h += HAPPINESS.SERVICE_EFFECT * avgCov;
  h -= avgTax * HAPPINESS.TAX_EFFECT;
  h -= st.unemployment * HAPPINESS.UNEMPLOY_EFFECT;
  h -= cong * HAPPINESS.CONGESTION_EFFECT;
  // 通勤与物流不畅造成的效率损失同样压低幸福度
  h -= (1 - (st.effResidential === undefined ? 1 : st.effResidential)) * 60 * EFFICIENCY.HAPPY_COMMUTE;
  h += (avgLand - 40) * HAPPINESS.LAND_EFFECT;
  if (city.funds < 0) h -= 12;
  st.happiness = Math.round(Math.max(HAPPINESS.MIN, Math.min(HAPPINESS.MAX, h)));
}

/** 月度预算 */
function processBudget(city) {
  // 资金按「结算步长」持续结算；月度边界上把剩余的累计也落一次账。
  return settleBudget(city);
}

/**
 * 结算：把这段时间累计的收支写进财政流水。
 * 步长由玩家设置（默认每 10 个游戏分钟一次），
 * 于是面板上的钱是「随时在动」的，而不是每月才跳一次。
 */
function settleBudget(city) {
  const income = city._accIncome || 0;
  const expense = city._accExpense || 0;
  city._accIncome = 0;
  city._accExpense = 0;
  const entry = {
    tick: city.tick, date: city.date,
    income: Math.round(income), expense: Math.round(expense),
    net: Math.round(income - expense), funds: Math.round(city.funds),
    population: city.stats.population,
  };
  city.ledger.push(entry);
  if (city.ledger.length > 400) city.ledger.shift();
  city.lastSettlement = entry;
  return entry;
}

/**
 * 实时市政收支（口径：每「游戏小时」）
 * -------------------------------------------------------------
 * 市政维护是**实时**的：每一格道路、每一座设施每时每刻都在花钱，
 * 税收也随时在收。1x 速度下 1 游戏小时 = 30 真实秒，
 * 所以钱每秒都在动，而不是「每月结算一次」的台阶。
 */
function accrueBudget(city, dtHours = 1 / 60) {
  const st = city.stats;
  const tiles = city.tiles;
  let comJobs = 0, indJobs = 0;
  for (const i of city.commercialTiles || []) comJobs += tiles[i].jobs;
  for (const i of city.industrialTiles || []) indJobs += tiles[i].jobs;

  const income =
    st.population * ECON.TAX_BASE_RES * city.tax.res / 100 +
    comJobs * ECON.TAX_BASE_COM * city.tax.com / 100 +
    indJobs * ECON.TAX_BASE_IND * city.tax.ind / 100;

  let street = 0, ave = 0, hwy = 0;
  for (const t of tiles) {
    if (t.road === 1) street++; else if (t.road === 2) ave++; else if (t.road === 3) hwy++;
  }
  const roadUpkeep = street * ECON.ROAD_UPKEEP[1] + ave * ECON.ROAD_UPKEEP[2] + hwy * ECON.ROAD_UPKEEP[3];

  let svcUpkeep = 0;
  for (const i of city.serviceTiles || []) {
    const def = SERVICE_BY_ID[tiles[i].service];
    if (def) svcUpkeep += def.upkeep;
  }
  const expense = ECON.BASE_UPKEEP + roadUpkeep + svcUpkeep;
  const net = income - expense;
  city.funds += net * dtHours;
  city._accIncome = (city._accIncome || 0) + income * dtHours;
  city._accExpense = (city._accExpense || 0) + expense * dtHours;
  st.income = income; st.expense = expense;        // § / 游戏小时
  st.incomeHour = income; st.expenseHour = expense;
  st.netHour = net;
  st.incomeMin = income / 60; st.expenseMin = expense / 60; st.netMin = net / 60;
  st.roadUpkeep = roadUpkeep;
  st.svcUpkeep = svcUpkeep;
  st.adminUpkeep = ECON.BASE_UPKEEP;
  return {
    income, expense, net,
  };
}

export const development = {
  _clearBuilding,
  hasRoadAccess,
  updateCoverage,
  computeLandValue,
  updateEfficiency,
  updateGrowth,
  updateOccupancy,
  updateDemand,
  updateHappiness,
  processBudget,
  settleBudget,
  accrueBudget,
};
