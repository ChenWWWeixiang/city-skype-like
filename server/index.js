// ============================================================================
//  HTTP + WebSocket 服务：静态资源 / REST API / 实时同步
// ============================================================================
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { manager } from './game.js';
import { repo, compress } from './db.js';
import { MAP, TIME, ROADS, ZONES, SERVICES, ECON, LANE_TYPE_LIST, SIGNAL, ELEV } from './sim/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 5173;

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// ---------------------------------------------------------------- 配置
app.get('/api/config', (req, res) => {
  res.json({
    mapSize: MAP.SIZE,
    tile: MAP.TILE,
    speeds: TIME.SPEEDS,
    speedLabels: TIME.SPEED_LABELS,
    roads: Object.values(ROADS).map((r) => ({
      id: r.id, name: r.name, cost: r.cost, upkeep: r.upkeep, width: r.width, lanes: r.lanes, v0: r.v0,
    })),
    zones: ['res', 'com', 'ind'].map((k) => ({ key: k, name: ZONES[k].name, cost: ECON.ZONE_COST[k] })),
    laneTypes: LANE_TYPE_LIST.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    signal: { green: SIGNAL.GREEN, yellow: SIGNAL.YELLOW, allRed: SIGNAL.ALL_RED },
    services: Object.values(SERVICES).map((s) => ({
      key: Object.keys(SERVICES).find((k) => SERVICES[k].id === s.id),
      id: s.id, name: s.name, cost: s.cost, upkeep: s.upkeep, radius: s.radius, color: s.color,
    })),
    startFunds: ECON.START_FUNDS,
    defaultTax: ECON.DEFAULT_TAX,
    econ: {
      baseUpkeep: ECON.BASE_UPKEEP,
      roadUpkeep: ECON.ROAD_UPKEEP,
      settleSteps: ECON.SETTLE_STEPS,
      settleMinutes: ECON.SETTLE_MINUTES,
    },
    elev: { maxRamp: ELEV.MAX_RAMP, bridgeClearance: ELEV.BRIDGE_CLEARANCE, tunnelDepth: ELEV.TUNNEL_DEPTH },
  });
});

// ---------------------------------------------------------------- 城市 CRUD
app.get('/api/cities', (req, res) => {
  const rows = repo.listCities();
  const live = new Set(manager.games.keys());
  res.json(rows.map((r) => ({ ...r, live: live.has(r.id) })));
});

// 默认落地城（示范城）：外部访问不带 ?c= 时直接打开它。
// 里面已经是一座能跑起来的小城：高架环线 + 匝道 + 穿山隧道 + 跨河大桥。
app.get('/api/cities/featured', (req, res) => {
  const id = repo.getFeatured();
  if (!id) return res.json({ id: null });
  const game = manager.get(id) || manager.loadFromDb(id);
  if (!game) return res.json({ id: null });
  res.json({ id, name: game.city.name, population: game.city.stats.population });
});

// 把某座城市置为默认落地城（示范城用）
app.post('/api/cities/:id/feature', (req, res) => {
  const game = manager.get(req.params.id) || manager.loadFromDb(req.params.id);
  if (!game) return res.status(404).json({ error: '城市不存在' });
  repo.setFeatured(game.city.id);
  res.json({ ok: true, id: game.city.id });
});

app.post('/api/cities', (req, res) => {
  const name = String(req.body?.name || '新城市').slice(0, 40);
  const game = manager.create({ name, seed: req.body?.seed });
  res.json({ id: game.id, name: game.city.name });
});

app.get('/api/cities/:id', (req, res) => {
  const game = manager.get(req.params.id) || manager.loadFromDb(req.params.id);
  if (!game) return res.status(404).json({ error: '城市不存在' });
  const c = game.city;
  res.json({
    id: c.id, name: c.name, tick: c.tick, funds: Math.round(c.funds),
    population: c.stats.population, jobs: c.stats.jobs,
    happiness: c.stats.happiness, updatedAt: c.updatedAt,
    ledger: repo.listLedger(c.id),
  });
});

app.post('/api/cities/:id/clone', (req, res) => {
  let game = manager.get(req.params.id) || manager.loadFromDb(req.params.id);
  if (!game) return res.status(404).json({ error: '城市不存在' });
  const snap = JSON.parse(compress(game.city.snapshot()).length ? JSON.stringify(game.city.snapshot()) : '{}');
  const copy = manager.create({ name: (req.body?.name || game.city.name + ' 副本').slice(0, 40), seed: snap.seed });
  copy.city.tick = snap.tick;
  copy.city.funds = snap.funds;
  copy.city.tax = { ...snap.tax };
  snap.tiles.forEach((a, i) => {
    const t = copy.city.tiles[i];
    if (!t) return;
    t.zone = a[0]; t.level = a[1]; t.road = a[2]; t.service = a[3];
    t.land = a[4]; t.power = !!a[5]; t.water = !!a[6];
    t.h = a[7] || 0; t.lt = a[8] || 0; t.over = a[9] || 0; t.olt = a[10] || 0;
  });
  copy.city.ledger = snap.ledger || [];
  copy.city.rebuildNetwork();
  copy.city.refreshAggregates();
  copy.city.updateCoverage();
  copy.city.computeLandValue();
  copy.city.updateDemand();
  copy.markDirtyAll();
  copy.save(true);
  res.json({ id: copy.id, name: copy.city.name });
});

app.delete('/api/cities/:id', (req, res) => {
  manager.remove(req.params.id);
  res.json({ ok: true });
});

app.get('/api/cities/:id/ledger', (req, res) => {
  res.json(repo.listLedger(req.params.id));
});

app.get('/api/cities/:id/events', (req, res) => {
  res.json(repo.listEvents(req.params.id));
});

app.get('/api/cities/:id/snapshot', (req, res) => {
  const game = manager.get(req.params.id) || manager.loadFromDb(req.params.id);
  if (!game) return res.status(404).json({ error: '城市不存在' });
  res.json(game.city.snapshot());
});

app.post('/api/cities/:id/snapshot', (req, res) => {
  const game = manager.get(req.params.id) || manager.loadFromDb(req.params.id);
  if (!game) return res.status(404).json({ error: '城市不存在' });
  const snap = req.body?.snapshot;
  if (!snap) return res.status(400).json({ error: '缺少快照数据' });
  const copy = manager.create({ name: String(req.body?.name || '导入城市').slice(0, 40), seed: snap.seed });
  copy.city.tick = snap.tick | 0;
  copy.city.funds = snap.funds ?? ECON.START_FUNDS;
  copy.city.tax = { ...ECON.DEFAULT_TAX, ...(snap.tax || {}) };
  snap.tiles.forEach((a, i) => {
    const t = copy.city.tiles[i];
    if (!t) return;
    t.zone = a[0]; t.level = a[1]; t.road = a[2]; t.service = a[3];
    t.land = a[4]; t.power = !!a[5]; t.water = !!a[6];
    t.h = a[7] || 0; t.lt = a[8] || 0; t.over = a[9] || 0; t.olt = a[10] || 0;
  });
  copy.city.ledger = snap.ledger || [];
  copy.city.rebuildNetwork();
  copy.city.refreshAggregates();
  copy.city.updateCoverage();
  copy.city.computeLandValue();
  copy.city.updateDemand();
  copy.markDirtyAll();
  copy.save(true);
  res.json({ id: copy.id, name: copy.city.name });
});

// ---------------------------------------------------------------- WebSocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.cityId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      const id = String(msg.cityId || '');
      let game = null;
      if (id.startsWith('lab')) {
        // 车辆仿真实验室：lab1 ~ lab6
        const stage = Math.max(1, Math.min(6, parseInt(id.slice(3), 10) || 1));
        game = manager.ensureLab(stage);
      } else {
        game = manager.get(id);
        if (!game) game = manager.loadFromDb(id);
        if (!game) {
          // 全新城市
          game = manager.create({ name: String(msg.name || '新城市').slice(0, 40) });
        }
      }
      if (ws.cityId) {
        const old = String(ws.cityId).startsWith('lab') ? manager.labGame : manager.get(ws.cityId);
        if (old) old.clients.delete(ws);
      }
      ws.cityId = game.id;
      game.clients.add(ws);
      game.broadcast(true);
      game.markDirtyAll();
      ws.send(JSON.stringify({ type: 'joined', cityId: game.id, name: game.city.name }));
      return;
    }

    if (msg.type === 'command') {
      if (String(ws.cityId || '').startsWith('lab')) {
        // 实验室指令：切换阶段 / 暂停 / 倍速
        const lab = manager.lab;
        if (!lab) return;
        if (msg.action === 'labStage') {
          manager.ensureLab(Math.max(1, Math.min(6, msg.stage | 0)));
          manager.labGame.broadcast(true);
        } else if (msg.action === 'labPause') {
          lab.paused = !!msg.value;
        } else if (msg.action === 'labSpeed') {
          lab.speed = Math.max(0.1, Math.min(3, Number(msg.value) || 1));
        }
        return;
      }
      const game = manager.get(ws.cityId);
      if (!game) return;
      game.handleCommand(msg, ws);
      game.markDirtyAll();
      game.broadcast(false);
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
    }
  });

  ws.on('close', () => {
    const game = String(ws.cityId || '').startsWith('lab') ? manager.labGame : manager.get(ws.cityId);
    if (game) game.clients.delete(ws);
  });
});

// 心跳：清理断开的连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000).unref();

manager.start();

server.listen(PORT, () => {
  console.log('\n  城市天际线 · 浏览器版');
  console.log('  ------------------------------------------');
  console.log('  打开 http://localhost:' + PORT + ' 即可开始建设');
  console.log('  数据库: ' + (process.env.CITY_DB || 'data/city.db'));
  console.log('  ------------------------------------------\n');
});

process.on('SIGINT', () => { manager.stop(); process.exit(0); });
process.on('SIGTERM', () => { manager.stop(); process.exit(0); });
