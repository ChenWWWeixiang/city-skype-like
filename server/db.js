// ============================================================================
//  SQLite 持久层：城市快照 / 存档 / 财政流水 / 事件
// ============================================================================
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = process.env.CITY_DB || path.join(DATA_DIR, 'city.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS cities (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  seed         INTEGER NOT NULL,
  tick         INTEGER NOT NULL DEFAULT 0,
  funds        REAL NOT NULL DEFAULT 0,
  population   INTEGER NOT NULL DEFAULT 0,
  is_public    INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  snapshot     BLOB
);
CREATE TABLE IF NOT EXISTS saves (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id      TEXT NOT NULL,
  label        TEXT,
  created_at   INTEGER NOT NULL,
  snapshot     BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id      TEXT NOT NULL,
  tick         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  income       REAL NOT NULL,
  expense      REAL NOT NULL,
  net          REAL NOT NULL,
  funds        REAL NOT NULL,
  population   INTEGER NOT NULL,
  detail       TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id      TEXT NOT NULL,
  tick         INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  text         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_city ON ledger(city_id, id);
CREATE INDEX IF NOT EXISTS idx_saves_city ON saves(city_id, id);
`);

const q = {
  upsertCity: db.prepare(`
    INSERT INTO cities (id,name,seed,tick,funds,population,is_public,created_at,updated_at,snapshot)
    VALUES (@id,@name,@seed,@tick,@funds,@population,@is_public,@created_at,@updated_at,@snapshot)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, tick=excluded.tick, funds=excluded.funds,
      population=excluded.population, updated_at=excluded.updated_at, snapshot=excluded.snapshot`),
  getCity: db.prepare('SELECT * FROM cities WHERE id = ?'),
  listCities: db.prepare(`
    SELECT id,name,seed,tick,funds,population,is_public,created_at,updated_at
    FROM cities ORDER BY updated_at DESC`),
  deleteCity: db.prepare('DELETE FROM cities WHERE id = ?'),
  insertSave: db.prepare(`
    INSERT INTO saves (city_id,label,created_at,snapshot) VALUES (?,?,?,?)`),
  listSaves: db.prepare('SELECT id,label,created_at FROM saves WHERE city_id = ? ORDER BY id DESC'),
  getSave: db.prepare('SELECT * FROM saves WHERE id = ?'),
  insertLedger: db.prepare(`
    INSERT INTO ledger (city_id,tick,created_at,income,expense,net,funds,population,detail)
    VALUES (?,?,?,?,?,?,?,?,?)`),
  listLedger: db.prepare(`
    SELECT tick,created_at,income,expense,net,funds,population FROM ledger
    WHERE city_id = ? ORDER BY id ASC`),
  insertEvent: db.prepare(
    'INSERT INTO events (city_id,tick,kind,text,created_at) VALUES (?,?,?,?,?)'),
  listEvents: db.prepare(
    'SELECT tick,kind,text,created_at FROM events WHERE city_id = ? ORDER BY id DESC LIMIT 100'),
};

export function compress(obj) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'), { level: 6 });
}
export function decompress(buf) {
  return JSON.parse(zlib.gunzipSync(Buffer.from(buf)).toString('utf8'));
}

export const repo = {
  saveCity(city, snapshotBuf) {
    q.upsertCity.run({
      id: city.id, name: city.name, seed: city.seed, tick: city.tick,
      funds: city.funds, population: city.stats.population,
      is_public: 1, created_at: city.createdAt, updated_at: Date.now(),
      snapshot: snapshotBuf,
    });
  },
  loadCity(id) {
    const row = q.getCity.get(id);
    if (!row || !row.snapshot) return null;
    return { row, snapshot: decompress(row.snapshot) };
  },
  listCities() { return q.listCities.all(); },
  deleteCity(id) { q.deleteCity.run(id); },
  saveSnapshot(cityId, label, snapshotBuf) {
    const r = q.insertSave.run(cityId, label || null, Date.now(), snapshotBuf);
    return r.lastInsertRowid;
  },
  listSaves(cityId) { return q.listSaves.all(cityId); },
  loadSave(id) {
    const row = q.getSave.get(id);
    if (!row) return null;
    return { row, snapshot: decompress(row.snapshot) };
  },
  appendLedger(cityId, entry) {
    q.insertLedger.run(
      cityId, entry.tick, Date.now(), entry.income, entry.expense,
      entry.net, entry.funds, entry.population || 0, JSON.stringify(entry.date || null),
    );
  },
  listLedger(cityId) { return q.listLedger.all(cityId); },
  logEvent(cityId, tick, kind, text) {
    q.insertEvent.run(cityId, tick, kind, text, Date.now());
  },
  listEvents(cityId) { return q.listEvents.all(cityId); },
};
