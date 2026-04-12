/**
 * Memory Passport: export and import memory as portable JSON.
 *
 * The passport format is model-agnostic and human-readable. It contains
 * all active memory items, trips, and conflicts. It does NOT contain
 * conversation history or API keys, keeping the export lightweight and
 * safe to share.
 */
import { v4 as uuidv4 } from "uuid";
import { queryAll, queryOne, runSql } from "../db/index.js";

export interface PassportMemoryItem {
  key: string;
  type: string;
  value: string;
  scope: string;
  trip_name: string | null;
  confidence: number;
  authority: string;
  status: string;
  valid_from: string | null;
  valid_to: string | null;
  last_confirmed_at: string | null;
  created_at: string;
}

export interface PassportTrip {
  name: string;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  notes: string | null;
}

export interface PassportConflict {
  key: string;
  resolution: string;
  explanation: string | null;
  created_at: string;
}

export interface Passport {
  format: "recallos-passport-v1";
  exported_at: string;
  stats: {
    memory_items: number;
    trips: number;
    conflicts: number;
  };
  memory_items: PassportMemoryItem[];
  trips: PassportTrip[];
  conflicts: PassportConflict[];
}

export interface ExportFilters {
  type?: string;
  scope?: string;
  domain?: string;
  tag?: string;
  pinned?: boolean;
}

/**
 * Export active memory, trips, and unresolved conflicts into a
 * portable JSON passport. Optional filters narrow the export.
 */
export function exportPassport(filters?: ExportFilters): Passport {
  const conditions: string[] = ["mi.status = 'active'"];
  const params: unknown[] = [];

  if (filters?.type) {
    conditions.push("mi.type = ?");
    params.push(filters.type);
  }
  if (filters?.scope) {
    conditions.push("mi.scope = ?");
    params.push(filters.scope);
  }
  if (filters?.domain) {
    conditions.push("mi.domain = ?");
    params.push(filters.domain);
  }
  if (filters?.pinned !== undefined) {
    conditions.push("mi.pinned = ?");
    params.push(filters.pinned ? 1 : 0);
  }

  let sql = `SELECT mi.*, t.name AS trip_name
     FROM memory_items mi
     LEFT JOIN trips t ON mi.trip_id = t.id
     WHERE ${conditions.join(" AND ")}`;

  if (filters?.tag) {
    sql = `SELECT mi.*, t.name AS trip_name
     FROM memory_items mi
     LEFT JOIN trips t ON mi.trip_id = t.id
     INNER JOIN memory_tags mt ON mt.memory_item_id = mi.id AND mt.tag = ?
     WHERE ${conditions.join(" AND ")}`;
    params.unshift(filters.tag);
  }

  sql += " ORDER BY mi.created_at ASC";

  const memories = queryAll(sql, params) as unknown as (Record<string, unknown> & { trip_name: string | null })[];

  const trips = queryAll(
    `SELECT name, destination, start_date, end_date, status, notes
     FROM trips
     ORDER BY created_at ASC`
  ) as unknown as PassportTrip[];

  const conflicts = queryAll(
    `SELECT key, resolution, explanation, created_at
     FROM conflicts
     ORDER BY created_at ASC`
  ) as unknown as PassportConflict[];

  const items: PassportMemoryItem[] = memories.map((m) => ({
    key: m.key as string,
    type: m.type as string,
    value: m.value as string,
    scope: m.scope as string,
    trip_name: m.trip_name ?? null,
    confidence: m.confidence as number,
    authority: m.authority as string,
    status: m.status as string,
    valid_from: (m.valid_from as string) ?? null,
    valid_to: (m.valid_to as string) ?? null,
    last_confirmed_at: (m.last_confirmed_at as string) ?? null,
    created_at: m.created_at as string,
  }));

  return {
    format: "recallos-passport-v1",
    exported_at: new Date().toISOString(),
    stats: {
      memory_items: items.length,
      trips: trips.length,
      conflicts: conflicts.length,
    },
    memory_items: items,
    trips: trips,
    conflicts: conflicts,
  };
}

export interface ImportResult {
  trips_created: number;
  trips_skipped: number;
  memories_created: number;
  memories_skipped: number;
  conflicts_created: number;
}

/**
 * Import a passport into the local database.
 *
 * Strategy:
 *  - Trips are matched by name. If a trip with the same name exists, skip it.
 *  - Memory items are matched by key + type + scope. If a match exists with
 *    the same normalized value, skip it. Otherwise, create it as new.
 *  - Conflicts are imported as-is.
 */
/**
 * Export memory as human-readable Markdown.
 * Grouped by type, with metadata as inline annotations.
 */
export function exportPassportMarkdown(): string {
  const passport = exportPassport();
  const lines: string[] = [];

  lines.push("# RecallOS Memory Export");
  lines.push("");
  lines.push(`Exported: ${passport.exported_at.slice(0, 10)}`);
  lines.push(`Items: ${passport.stats.memory_items} | Trips: ${passport.stats.trips} | Conflicts: ${passport.stats.conflicts}`);
  lines.push("");

  // Group items by type
  const byType = new Map<string, PassportMemoryItem[]>();
  for (const item of passport.memory_items) {
    const group = byType.get(item.type) || [];
    group.push(item);
    byType.set(item.type, group);
  }

  for (const [type, items] of byType) {
    lines.push(`## ${type.charAt(0).toUpperCase() + type.slice(1)}s`);
    lines.push("");
    for (const item of items) {
      const meta: string[] = [];
      meta.push(`scope: ${item.scope}`);
      if (item.trip_name) meta.push(`trip: ${item.trip_name}`);
      meta.push(`confidence: ${item.confidence}`);
      if (item.authority !== "explicit") meta.push(`authority: ${item.authority}`);

      lines.push(`- **${item.key}**: ${item.value}`);
      lines.push(`  _${meta.join(" | ")}_`);
    }
    lines.push("");
  }

  if (passport.trips.length > 0) {
    lines.push("## Trips");
    lines.push("");
    for (const trip of passport.trips) {
      const dates = [trip.start_date, trip.end_date].filter(Boolean).join(" to ");
      lines.push(`- **${trip.name}**${trip.destination ? ` - ${trip.destination}` : ""}`);
      if (dates) lines.push(`  Dates: ${dates}`);
      lines.push(`  Status: ${trip.status}`);
      if (trip.notes) lines.push(`  Notes: ${trip.notes}`);
    }
    lines.push("");
  }

  if (passport.conflicts.length > 0) {
    lines.push("## Unresolved Conflicts");
    lines.push("");
    for (const c of passport.conflicts) {
      lines.push(`- **${c.key}**: ${c.resolution}${c.explanation ? ` - ${c.explanation}` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function importPassport(passport: Passport): ImportResult {
  if (passport.format !== "recallos-passport-v1") {
    throw new Error(
      `Unknown passport format: ${passport.format}. Expected recallos-passport-v1.`
    );
  }

  const result: ImportResult = {
    trips_created: 0,
    trips_skipped: 0,
    memories_created: 0,
    memories_skipped: 0,
    conflicts_created: 0,
  };

  // Build a name-to-id map for trips
  const tripNameToId = new Map<string, string>();

  // Import trips
  for (const trip of passport.trips ?? []) {
    const existing = queryOne(
      "SELECT id FROM trips WHERE name = ?",
      [trip.name]
    );
    if (existing) {
      tripNameToId.set(trip.name, existing.id as string);
      result.trips_skipped++;
      continue;
    }
    const id = uuidv4();
    runSql(
      `INSERT INTO trips (id, name, destination, start_date, end_date, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        trip.name,
        trip.destination ?? null,
        trip.start_date ?? null,
        trip.end_date ?? null,
        trip.status ?? "planning",
        trip.notes ?? null,
      ]
    );
    tripNameToId.set(trip.name, id);
    result.trips_created++;
  }

  // Import memory items
  for (const mem of passport.memory_items ?? []) {
    const tripId = mem.trip_name ? tripNameToId.get(mem.trip_name) ?? null : null;

    // Check for duplicate: same key, type, scope, active
    const existing = queryOne(
      `SELECT id, value FROM memory_items
       WHERE key = ? AND type = ? AND scope = ? AND status = 'active'
       LIMIT 1`,
      [mem.key, mem.type, mem.scope]
    );

    if (existing) {
      const existingValue = (existing.value as string).toLowerCase().trim();
      const newValue = mem.value.toLowerCase().trim();
      if (existingValue === newValue) {
        result.memories_skipped++;
        continue;
      }
    }

    const id = uuidv4();
    runSql(
      `INSERT INTO memory_items
         (id, key, type, value, scope, trip_id, confidence, authority, status, valid_from, valid_to, last_confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [
        id,
        mem.key,
        mem.type,
        mem.value,
        mem.scope,
        tripId,
        mem.confidence ?? 0.8,
        mem.authority ?? "explicit",
        mem.valid_from ?? null,
        mem.valid_to ?? null,
        mem.last_confirmed_at ?? null,
      ]
    );
    result.memories_created++;
  }

  // Import conflicts
  for (const conflict of passport.conflicts ?? []) {
    const id = uuidv4();
    runSql(
      `INSERT INTO conflicts (id, key, memory_item_a_id, memory_item_b_id, resolution, explanation)
       VALUES (?, ?, '', '', ?, ?)`,
      [id, conflict.key, conflict.resolution, conflict.explanation ?? null]
    );
    result.conflicts_created++;
  }

  return result;
}
