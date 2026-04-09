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

/**
 * Export all active memory, trips, and unresolved conflicts into a
 * portable JSON passport.
 */
export function exportPassport(): Passport {
  const memories = queryAll(
    `SELECT mi.*, t.name AS trip_name
     FROM memory_items mi
     LEFT JOIN trips t ON mi.trip_id = t.id
     WHERE mi.status = 'active'
     ORDER BY mi.created_at ASC`
  ) as unknown as (Record<string, unknown> & { trip_name: string | null })[];

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
