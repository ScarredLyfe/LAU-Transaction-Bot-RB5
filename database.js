// Firebase-backed database layer.
// Keeps the SAME synchronous db.prepare().get/all/run API every command already uses,
// but the source of truth is FIREBASE — data is loaded into a tiny local SQLite cache on
// startup and written back to Firebase whenever anything changes. Nothing important lives
// on the server's disk, so the bot can run on any host (even ones that wipe storage).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const os = require('os');

const FB = (process.env.FIREBASE_URL || 'https://laurb5data-production.up.railway.app').replace(/\/+$/, '');
const SNAP_KEY = process.env.BOT_DB_KEY || 'bot_db';
const DATA_KEY = process.env.DATA_API_KEY || '';
const _wHdr = (h) => Object.assign({ 'Content-Type': 'application/json' }, DATA_KEY ? { 'X-Api-Key': DATA_KEY } : {}, h || {});

const DB_PATH = path.join(process.env.DB_DIR || os.tmpdir(), 'league_cache.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    transaction_channel_id TEXT,
    lfp_channel_id TEXT,
    roster_size INTEGER DEFAULT 10,
    max_demands INTEGER DEFAULT 2,
    signings_enabled INTEGER DEFAULT 1,
    releases_enabled INTEGER DEFAULT 1,
    demands_enabled INTEGER DEFAULT 1,
    bot_name TEXT,
    bot_logo TEXT,
    signed_role_id TEXT,
    free_agent_role_id TEXT,
    verified_role_id TEXT,
    unverified_role_id TEXT,
    scores_channel_id TEXT,
    event_ping_role_id TEXT,
    media_ping_role_id TEXT,
    stream_alert_role_id TEXT,
    franchise_channel_id TEXT,
    franchise_message_id TEXT
  );

  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    role_id TEXT NOT NULL,
    emoji TEXT,
    owner_id TEXT,
    coach1_id TEXT,
    coach2_id TEXT,
    UNIQUE(guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS players (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    team_id INTEGER,
    demands_used INTEGER DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS admin_roles (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS coach_roles (
    guild_id TEXT NOT NULL,
    position TEXT NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, position)
  );

  CREATE TABLE IF NOT EXISTS pending_offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    team_id INTEGER NOT NULL,
    coach_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    dm_channel_id TEXT,
    message_id TEXT,
    roster_size INTEGER,
    team_name TEXT,
    team_emoji TEXT,
    team_color INTEGER,
    team_logo TEXT,
    created_at INTEGER,
    expires_at INTEGER,
    status TEXT DEFAULT 'pending'
  );
`);

// Safe migrations for existing databases (ignored if the column already exists).
function addColumn(table, definition) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition};`); } catch {}
}
addColumn('guild_settings', 'signed_role_id TEXT');
addColumn('guild_settings', 'free_agent_role_id TEXT');
addColumn('guild_settings', 'verified_role_id TEXT');
addColumn('guild_settings', 'unverified_role_id TEXT');
addColumn('guild_settings', 'scores_channel_id TEXT');
addColumn('guild_settings', 'event_ping_role_id TEXT');
addColumn('guild_settings', 'media_ping_role_id TEXT');
addColumn('guild_settings', 'stream_alert_role_id TEXT');
addColumn('guild_settings', 'franchise_channel_id TEXT');
addColumn('guild_settings', 'franchise_message_id TEXT');
addColumn('teams', 'coach1_id TEXT');
addColumn('teams', 'coach2_id TEXT');

function ensureGuild(guildId) {
  db.prepare('INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)').run(guildId);
}

// ---------- Firebase persistence ----------
function listTables() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
}
function snapshot() {
  const snap = {};
  for (const t of listTables()) { try { snap[t] = db.prepare(`SELECT * FROM ${t}`).all(); } catch { snap[t] = []; } }
  return snap;
}
async function saveToFirebase() {
  try {
    await fetch(`${FB}/${SNAP_KEY}.json`, { method: 'PUT', headers: _wHdr(), body: JSON.stringify(snapshot()) });
  } catch (e) { console.error('[db] save to Firebase failed', e); }
}
async function loadFromFirebase() {
  try {
    const snap = await (await fetch(`${FB}/${SNAP_KEY}.json`)).json();
    const hasData = snap && typeof snap === 'object' &&
      listTables().some(t => Array.isArray(snap[t]) && snap[t].length);
    if (!hasData) {
      console.log('[db] no Firebase snapshot yet — seeding it from local data');
      await saveToFirebase();
      return;
    }
    for (const table of listTables()) {
      const rows = snap[table];
      if (!Array.isArray(rows)) continue;
      db.exec(`DELETE FROM ${table}`);
      for (const row of rows) {
        const cols = Object.keys(row);
        if (!cols.length) continue;
        try {
          db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
            .run(...cols.map(c => row[c]));
        } catch (e) { /* skip incompatible row */ }
      }
    }
    console.log('[db] loaded from Firebase');
  } catch (e) { console.error('[db] load from Firebase failed', e); }
}

let _saveTimer = null;
function scheduleSave() { if (_saveTimer) clearTimeout(_saveTimer); _saveTimer = setTimeout(() => { _saveTimer = null; saveToFirebase(); }, 1500); }

const _prepare = db.prepare.bind(db);
db.prepare = function (sql) {
  const stmt = _prepare(sql);
  if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) {
    const _run = stmt.run.bind(stmt);
    stmt.run = function (...args) { const r = _run(...args); scheduleSave(); return r; };
  }
  return stmt;
};

setInterval(() => { if (!_saveTimer) saveToFirebase(); }, 60000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveToFirebase().finally(() => process.exit(0)); });

const ready = loadFromFirebase();

module.exports = { db, ensureGuild, ready, saveToFirebase, loadFromFirebase };