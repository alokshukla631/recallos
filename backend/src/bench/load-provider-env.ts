/**
 * Populate ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY from the local
 * recallos.db `provider_settings` table if they are not already set in env.
 *
 * Rationale:  the bench's --qa mode needs an LLM provider, but in everyday
 * use the app stores provider keys in its own SQLite database (via the
 * Settings page).  Without this bridge, users have to `export` each key
 * manually before running the bench even though the app already knows them.
 *
 * Any key already present in env wins — this never overwrites.  Missing DB,
 * missing table, or missing rows are silently ignored (the bench will just
 * report "no provider key in env" and skip --qa).
 */

import fs from "fs";
import path from "path";
import initSqlJs from "sql.js";

const ENV_FOR_PROVIDER: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai:    "OPENAI_API_KEY",
  gemini:    "GEMINI_API_KEY",
};

export async function loadProviderKeysIntoEnv(): Promise<string[]> {
  const loaded: string[] = [];

  // Skip the DB read entirely if every target var is already set.
  if (Object.values(ENV_FOR_PROVIDER).every((v) => process.env[v])) {
    return loaded;
  }

  const dbPath = process.env.DB_PATH || path.join(process.cwd(), "recallos.db");
  if (!fs.existsSync(dbPath)) return loaded;

  try {
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(dbPath));

    // Tolerate missing table (older DBs).
    const hasTable = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='provider_settings'"
    );
    if (!hasTable[0]?.values.length) { db.close(); return loaded; }

    const rows = db.exec("SELECT provider, api_key FROM provider_settings");
    for (const row of rows[0]?.values ?? []) {
      const provider = String(row[0] ?? "").toLowerCase();
      const key = String(row[1] ?? "");
      const envName = ENV_FOR_PROVIDER[provider];
      if (!envName || !key) continue;
      if (process.env[envName]) continue; // env wins
      process.env[envName] = key;
      loaded.push(envName);
    }
    db.close();
  } catch {
    // Swallow — if the DB is locked / corrupt / schema-mismatched, the bench
    // just stays in retrieval-only mode.
  }

  return loaded;
}
