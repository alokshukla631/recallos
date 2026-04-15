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

  // ---------------------------------------------------------------------------
  // Migration: rename trips -> projects, trip_id -> project_id
  // ---------------------------------------------------------------------------
  const hasOldTrips = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='trips'"
  );
  if (hasOldTrips.length > 0 && hasOldTrips[0].values.length > 0) {
    db.run("ALTER TABLE trips RENAME TO projects");
    // Rename destination -> description for domain-agnostic naming
    const projCols = db.exec("PRAGMA table_info(projects)");
    const projColNames = projCols[0]?.values.map((row: unknown[]) => row[1]) || [];
    if (projColNames.includes("destination") && !projColNames.includes("description")) {
      db.run("ALTER TABLE projects RENAME COLUMN destination TO description");
    }
  }

  // Rename trip_id -> project_id in conversations
  {
    const convCols = db.exec("PRAGMA table_info(conversations)");
    const convColNames = convCols[0]?.values.map((row: unknown[]) => row[1]) || [];
    if (convColNames.includes("trip_id") && !convColNames.includes("project_id")) {
      db.run("ALTER TABLE conversations RENAME COLUMN trip_id TO project_id");
    }
  }

  // Rename trip_id -> project_id in events
  {
    const evtCols = db.exec("PRAGMA table_info(events)");
    const evtColNames = evtCols[0]?.values.map((row: unknown[]) => row[1]) || [];
    if (evtColNames.includes("trip_id") && !evtColNames.includes("project_id")) {
      db.run("ALTER TABLE events RENAME COLUMN trip_id TO project_id");
    }
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      start_date TEXT,
      end_date TEXT,
      status TEXT DEFAULT 'planning' CHECK (status IN ('planning', 'active', 'completed', 'cancelled')),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      project_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      provider TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ---------------------------------------------------------------------------
  // memory_items - with migration for expanded scope and trip->project rename
  // ---------------------------------------------------------------------------
  const tableExists = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_items'"
  );

  if (tableExists.length > 0 && tableExists[0].values.length > 0) {
    const columns = db.exec("PRAGMA table_info(memory_items)");
    const colNames = columns[0]?.values.map((row: unknown[]) => row[1]) || [];
    const hasDomainCol = colNames.includes("domain");
    const hasOldTripId = colNames.includes("trip_id") && !colNames.includes("project_id");

    if (!hasDomainCol || hasOldTripId) {
      // Recreate with the current schema: project_id instead of trip_id,
      // 'trip' scope merged into 'project', domain column added.
      db.run("PRAGMA foreign_keys = OFF;");

      db.run(`
        CREATE TABLE memory_items_new (
          id TEXT PRIMARY KEY,
          key TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('preference', 'constraint', 'fact', 'goal', 'override')),
          value TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'domain', 'project', 'session')),
          domain TEXT,
          project_id TEXT,
          source_event_id TEXT REFERENCES events(id),
          confidence REAL DEFAULT 0.8,
          authority TEXT DEFAULT 'explicit',
          status TEXT DEFAULT 'active' CHECK (status IN ('active', 'stale', 'superseded', 'deleted')),
          superseded_by TEXT REFERENCES memory_items(id),
          valid_from TEXT,
          valid_to TEXT,
          last_confirmed_at TEXT,
          deleted_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      // Copy data, renaming trip_id -> project_id and scope 'trip' -> 'project'
      const srcCol = colNames.includes("trip_id") ? "trip_id" : (colNames.includes("project_id") ? "project_id" : "NULL");
      const hasDomain = colNames.includes("domain");
      const hasDeletedAt = colNames.includes("deleted_at");
      db.run(`
        INSERT INTO memory_items_new (id, key, type, value, scope, domain, project_id,
          source_event_id, confidence, authority, status, superseded_by, valid_from, valid_to,
          last_confirmed_at, deleted_at, created_at)
        SELECT id, key, type, value,
          CASE WHEN scope = 'trip' THEN 'project' ELSE scope END,
          ${hasDomain ? "domain" : "NULL"},
          ${srcCol},
          source_event_id, confidence, authority, status, superseded_by, valid_from, valid_to,
          last_confirmed_at, ${hasDeletedAt ? "deleted_at" : "NULL"}, created_at
        FROM memory_items
      `);

      db.run("DROP TABLE memory_items");
      db.run("ALTER TABLE memory_items_new RENAME TO memory_items");
      db.run("PRAGMA foreign_keys = ON;");
    }
  } else {
    // Fresh database - create with current schema
    db.run(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('preference', 'constraint', 'fact', 'goal', 'override')),
        value TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'domain', 'project', 'session')),
        domain TEXT,
        project_id TEXT,
        source_event_id TEXT REFERENCES events(id),
        confidence REAL DEFAULT 0.8,
        authority TEXT DEFAULT 'explicit',
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'stale', 'superseded', 'deleted')),
        superseded_by TEXT REFERENCES memory_items(id),
        valid_from TEXT,
        valid_to TEXT,
        last_confirmed_at TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  // Migration: add pinned column if missing
  {
    const cols = db.exec("PRAGMA table_info(memory_items)");
    const colNames = cols[0]?.values.map((row: unknown[]) => row[1]) || [];
    if (!colNames.includes("pinned")) {
      db.run("ALTER TABLE memory_items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    }
  }

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
    CREATE TABLE IF NOT EXISTS agent_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed', 'cancelled')),
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_steps (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES agent_plans(id),
      step_index INTEGER NOT NULL,
      description TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'skipped')),
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_checkpoints (
      id TEXT PRIMARY KEY,
      plan_id TEXT REFERENCES agent_plans(id),
      label TEXT NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS memory_tags (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL REFERENCES memory_items(id),
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(memory_item_id, tag)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS memory_links (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES memory_items(id),
      target_id TEXT NOT NULL REFERENCES memory_items(id),
      relation TEXT NOT NULL CHECK (relation IN ('related_to', 'depends_on', 'conflicts_with', 'refines', 'derived_from')),
      strength REAL DEFAULT 1.0,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_id, target_id, relation)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS memory_audit_log (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('created', 'superseded', 'reconfirmed', 'marked_stale', 'imported', 'deleted', 'pinned', 'unpinned', 'restored')),
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration: widen the audit action CHECK constraint if the table already exists
  // with the old constraint. SQLite does not allow ALTER CHECK, so we must recreate.
  {
    const auditInfo = db.exec("PRAGMA table_info(memory_audit_log)");
    if (auditInfo.length > 0) {
      // Try inserting a test row with a new action value; if it fails, migrate
      try {
        db.run("INSERT INTO memory_audit_log (id, memory_item_id, action) VALUES ('__check__', '__check__', 'pinned')");
        db.run("DELETE FROM memory_audit_log WHERE id = '__check__'");
      } catch {
        // CHECK constraint failed - recreate the table with the expanded constraint
        db.run("PRAGMA foreign_keys = OFF;");
        db.run(`
          CREATE TABLE memory_audit_log_new (
            id TEXT PRIMARY KEY,
            memory_item_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('created', 'superseded', 'reconfirmed', 'marked_stale', 'imported', 'deleted', 'pinned', 'unpinned', 'restored')),
            details TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        db.run(`
          INSERT INTO memory_audit_log_new (id, memory_item_id, action, details, created_at)
          SELECT id, memory_item_id, action, details, created_at
          FROM memory_audit_log
        `);
        db.run("DROP TABLE memory_audit_log");
        db.run("ALTER TABLE memory_audit_log_new RENAME TO memory_audit_log");
        db.run("PRAGMA foreign_keys = ON;");
      }
    }
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS provider_settings (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL UNIQUE,
      api_key TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '["*"]',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
