import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  email TEXT,
  name TEXT,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_states (
  state TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  verifier_enc TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('git','server','kubernetes')),
  name TEXT NOT NULL UNIQUE,
  url TEXT,
  scan_mode TEXT NOT NULL DEFAULT 'offer' CHECK (scan_mode IN ('standard','offer','ai')),
  credential_enc TEXT,
  agent_token_hash TEXT,
  linked_source_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','failed','running')),
  scan_error TEXT,
  scanned_by_ai INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}',
  last_scan_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  file TEXT,
  current TEXT NOT NULL,
  latest TEXT,
  bump TEXT NOT NULL DEFAULT '',
  cves TEXT NOT NULL DEFAULT '[]',
  locator TEXT,
  image TEXT,
  ai_found INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE (source_id, key)
);
CREATE TABLE IF NOT EXISTS updates (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  target_source_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'update' CHECK (kind IN ('update','rollback')),
  parent_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('pr','commit')),
  file TEXT NOT NULL,
  from_version TEXT NOT NULL,
  to_version TEXT NOT NULL,
  branch TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  commit_sha TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','merged','closed','committed','reverted','failed')),
  error TEXT,
  actor TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS summaries (
  item_id TEXT NOT NULL,
  latest TEXT NOT NULL,
  provider TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, latest)
);
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_id);
CREATE INDEX IF NOT EXISTS idx_updates_item ON updates(item_id);
`;

export function openDb(dataDir: string): Db {
  let db: Db;
  if (dataDir === ':memory:') {
    db = new DatabaseSync(':memory:');
  } else {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = join(dataDir, 'lxneye.db');
    db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* Dateisystem ohne Rechteverwaltung */
    }
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  ensureColumn(db, 'items', 'candidates', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'items', 'server', 'TEXT');
  ensureColumn(db, 'updates', 'group_id', 'TEXT');
  return db;
}

/** Fügt eine Spalte hinzu, falls eine ältere Datenbank sie noch nicht hat. */
function ensureColumn(db: Db, table: string, column: string, def: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

export const now = (): number => Date.now();

export function audit(db: Db, actor: string | null, action: string, detail?: string): void {
  db.prepare('INSERT INTO audit_log (ts, actor, action, detail) VALUES (?, ?, ?, ?)').run(now(), actor, action, detail ?? null);
}

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function deleteSetting(db: Db, key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/** Führt fn in einer Transaktion aus. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function cacheGet(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value, expires_at FROM cache WHERE key = ?').get(key) as
    | { value: string; expires_at: number }
    | undefined;
  if (!row || row.expires_at < now()) return null;
  return row.value;
}

export function cacheSet(db: Db, key: string, value: string, ttlMs: number): void {
  db.prepare(
    'INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
  ).run(key, value, now() + ttlMs);
}
