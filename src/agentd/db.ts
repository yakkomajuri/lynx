// The backend's one database. Only this process opens it, so there is no locking beyond SQLite's own.
import { DatabaseSync } from 'node:sqlite'

const MIGRATIONS: string[] = [
  `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    harness TEXT NOT NULL,
    cwd TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    labels TEXT NOT NULL DEFAULT '{}',
    provider_session_id TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX sessions_created ON sessions(created_at, id);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    status TEXT NOT NULL,
    spec TEXT NOT NULL,
    result TEXT,
    error TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    pid INTEGER,
    created_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT
  );
  CREATE INDEX runs_session ON runs(session_id, created_at, id);
  CREATE INDEX runs_status ON runs(status, created_at, id);

  -- seq is global, so one cursor orders a session's events and gaps between a session's seqs are normal.
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    run_id TEXT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX events_session ON events(session_id, seq);
  CREATE INDEX events_run ON events(run_id, type, seq);
  CREATE VIRTUAL TABLE events_fts USING fts5(text, content='events', content_rowid='seq', tokenize='porter unicode61');
  CREATE TRIGGER events_fts_insert AFTER INSERT ON events WHEN new.text != '' BEGIN
    INSERT INTO events_fts(rowid, text) VALUES (new.seq, new.text);
  END;

  CREATE TABLE inputs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    response TEXT,
    stale_reason TEXT,
    created_at TEXT NOT NULL,
    responded_at TEXT,
    delivered_at TEXT
  );
  CREATE INDEX inputs_run ON inputs(run_id, status);

  CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    headers TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE session_connections (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    connection_id TEXT NOT NULL REFERENCES connections(id),
    PRIMARY KEY (session_id, connection_id)
  );

  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cron TEXT,
    run_at TEXT,
    timezone TEXT NOT NULL,
    launch TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    next_fire_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL DEFAULT 'owner',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE TABLE schedule_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id TEXT NOT NULL REFERENCES schedules(id),
    scheduled_at TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (schedule_id, scheduled_at)
  );

  CREATE TABLE idempotency (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    hash TEXT NOT NULL,
    response TEXT NOT NULL,
    PRIMARY KEY (scope, key)
  );

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // Shell commands workspaces run through `exec`, their output and what was typed into them.
  `CREATE TABLE processes (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    spec TEXT NOT NULL,
    result TEXT,
    error TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    pid INTEGER,
    created_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT
  );
  CREATE INDEX processes_queued ON processes(status, created_at, id);
  CREATE TABLE process_output (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    process_id TEXT NOT NULL REFERENCES processes(id),
    stream TEXT NOT NULL,
    text TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX process_output_by_process ON process_output(process_id, seq);
  CREATE TABLE process_inputs (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL REFERENCES processes(id),
    data TEXT NOT NULL,
    eof INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  );`,
]

export function openDb(path: string) {
  const db = new DatabaseSync(path)
  // WAL with NORMAL sync survives the process dying at any point; only a power cut can lose the last commits.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000')
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  return db
}

/** Runs `f` in one transaction. Nested calls join the outer one. */
export function transaction(db: DatabaseSync) {
  let depth = 0
  return <T>(f: () => T): T => {
    if (depth) return f()
    depth++
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = f()
      db.exec('COMMIT')
      return value
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    } finally {
      depth--
    }
  }
}

export const now = () => new Date().toISOString()
export const json = (value: unknown) => JSON.stringify(value ?? null)
export const parse = <T = any>(text: unknown): T => (typeof text === 'string' ? JSON.parse(text) : (text as T))
