import initSqlJs, { type Database } from "sql.js";
import fs from "fs";
import path from "path";

let db: Database | null = null;
let dbPath: string = "";

export async function initDatabase(filePath: string): Promise<Database> {
  dbPath = filePath;
  const SQL = await initSqlJs();

  // Load existing database file if it exists
  if (fs.existsSync(filePath)) {
    const buffer = fs.readFileSync(filePath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run("PRAGMA foreign_keys = ON;");

  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      trip_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      trip_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      provider TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('preference', 'constraint', 'fact', 'goal', 'override')),
      value TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'trip')),
      trip_id TEXT,
      source_event_id TEXT REFERENCES events(id),
      confidence REAL DEFAULT 0.8,
      authority TEXT DEFAULT 'explicit',
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'stale', 'superseded')),
      superseded_by TEXT REFERENCES memory_items(id),
      valid_from TEXT,
      valid_to TEXT,
      last_confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      memory_item_a_id TEXT REFERENCES memory_items(id),
      memory_item_b_id TEXT REFERENCES memory_items(id),
      resolution TEXT CHECK (resolution IN ('a_wins', 'b_wins', 'unresolved')),
      explanation TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS context_snapshots (
      id TEXT PRIMARY KEY,
      event_id TEXT REFERENCES events(id),
      provider TEXT NOT NULL,
      compiled_context_json TEXT NOT NULL,
      included_memory_ids TEXT NOT NULL DEFAULT '[]',
      omitted_memory_ids TEXT NOT NULL DEFAULT '[]',
      rationale_json TEXT,
      prompt_preview TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS provider_settings (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL UNIQUE,
      api_key TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Persist to disk
  saveToFile();

  return db;
}

export function getDb(): Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase(dbPath) first.");
  }
  return db;
}

/**
 * Persist the in-memory database to disk.
 * Call this after write operations.
 */
export function saveToFile(): void {
  if (!db || !dbPath) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(dbPath, buffer);
}

/**
 * Helper: run a query and return all matching rows as objects.
 */
export function queryAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const database = getDb();
  const stmt = database.prepare(sql);
  stmt.bind(params as any[]);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as Record<string, unknown>);
  }
  stmt.free();
  return rows;
}

/**
 * Helper: run a query and return the first matching row as an object, or undefined.
 */
export function queryOne(sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
  const rows = queryAll(sql, params);
  return rows[0];
}

/**
 * Helper: run a write statement (INSERT, UPDATE, DELETE).
 */
export function runSql(sql: string, params: unknown[] = []): void {
  const database = getDb();
  database.run(sql, params as any[]);
  saveToFile();
}
