import { v4 as uuidv4 } from "uuid";
import { queryAll, queryOne, runSql } from "../db/index.js";
import type { MemoryCandidate, MemoryType, MemoryScope } from "./memory-extractor.js";
import { logAudit } from "./audit.js";

export interface MemoryItem {
  id: string;
  key: string;
  type: MemoryType;
  value: string;
  scope: MemoryScope;
  trip_id: string | null;
  source_event_id: string | null;
  confidence: number;
  authority: string;
  status: "active" | "stale" | "superseded";
  superseded_by: string | null;
  valid_from: string | null;
  valid_to: string | null;
  last_confirmed_at: string | null;
  created_at: string;
}

export interface Conflict {
  id: string;
  key: string;
  memory_item_a_id: string;
  memory_item_b_id: string;
  resolution: "a_wins" | "b_wins" | "unresolved";
  explanation: string;
  created_at: string;
}

export interface ReconcileResult {
  added: MemoryItem[];
  updated: MemoryItem[];
  conflicts: Conflict[];
  duplicates: MemoryItem[];
}

/**
 * Normalizes a memory value for duplicate comparison.
 * Lowercases, collapses whitespace, strips trailing punctuation.
 */
function normalizeForDedup(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:"']+$/g, "")
    .trim();
}

/**
 * Checks if the candidate is a duplicate of an existing active item.
 * Duplicate = same key, same type, same normalized value, same scope (and trip if scoped).
 */
function findDuplicate(
  candidate: MemoryCandidate
): MemoryItem | undefined {
  const normalizedCandidate = normalizeForDedup(candidate.value);

  const rows =
    candidate.scope === "trip" && candidate.tripId
      ? (queryAll(
          `SELECT * FROM memory_items
           WHERE key = ? AND type = ? AND scope = 'trip' AND trip_id = ? AND status = 'active'`,
          [candidate.key, candidate.type, candidate.tripId]
        ) as unknown as MemoryItem[])
      : (queryAll(
          `SELECT * FROM memory_items
           WHERE key = ? AND type = ? AND scope = 'global' AND status = 'active'`,
          [candidate.key, candidate.type]
        ) as unknown as MemoryItem[]);

  for (const row of rows) {
    if (normalizeForDedup(row.value) === normalizedCandidate) {
      return row;
    }
  }
  return undefined;
}

/**
 * Re-confirms an existing memory item: bumps last_confirmed_at and
 * optionally raises confidence for repeated mentions.
 */
function reconfirmItem(itemId: string, currentConfidence: number): MemoryItem {
  const now = new Date().toISOString();
  // Cap at 0.99 so repeated mentions keep nudging it but never saturate
  const nextConfidence = Math.min(0.99, currentConfidence + 0.05);
  runSql(
    `UPDATE memory_items SET last_confirmed_at = ?, confidence = ? WHERE id = ?`,
    [now, nextConfidence, itemId]
  );
  return queryOne(
    "SELECT * FROM memory_items WHERE id = ?",
    [itemId]
  ) as unknown as MemoryItem;
}

/**
 * Precedence rules (highest to lowest):
 *   1. Explicit trip-specific override
 *   2. Explicit trip-specific preference
 *   3. Explicit global preference
 *   4. Inferred preference (lower confidence)
 *   5. Stale historical memory
 */
function getPrecedence(item: {
  type: string;
  scope: string;
  authority?: string;
  confidence: number;
  status?: string;
}): number {
  if (item.status === "stale") return 1;

  const isTrip = item.scope === "trip";
  const isExplicit = (item.authority ?? "explicit") === "explicit";
  const isOverride = item.type === "override";

  if (isTrip && isExplicit && isOverride) return 5;
  if (isTrip && isExplicit) return 4;
  if (isExplicit) return 3;
  if (!isExplicit) return 2;

  return 2;
}

function findExistingByKey(key: string, scope: string, tripId?: string): MemoryItem | undefined {
  if (scope === "trip" && tripId) {
    return queryOne(
      `SELECT * FROM memory_items
       WHERE key = ? AND scope = 'trip' AND trip_id = ? AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [key, tripId]
    ) as unknown as MemoryItem | undefined;
  }

  return queryOne(
    `SELECT * FROM memory_items
     WHERE key = ? AND scope = 'global' AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    [key]
  ) as unknown as MemoryItem | undefined;
}

function insertMemoryItem(candidate: MemoryCandidate, eventId: string): MemoryItem {
  const id = uuidv4();
  const now = new Date().toISOString();

  runSql(
    `INSERT INTO memory_items (id, key, type, value, scope, trip_id, source_event_id, confidence, authority, status, valid_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [id, candidate.key, candidate.type, candidate.value, candidate.scope, candidate.tripId ?? null, eventId, candidate.confidence, candidate.authority, now]
  );

  return queryOne("SELECT * FROM memory_items WHERE id = ?", [id]) as unknown as MemoryItem;
}

function supersedeItem(existingId: string, newId: string): void {
  runSql(
    `UPDATE memory_items SET status = 'superseded', superseded_by = ? WHERE id = ?`,
    [newId, existingId]
  );
}

function recordConflict(
  key: string,
  itemAId: string,
  itemBId: string,
  resolution: "a_wins" | "b_wins" | "unresolved",
  explanation: string
): Conflict {
  const id = uuidv4();

  runSql(
    `INSERT INTO conflicts (id, key, memory_item_a_id, memory_item_b_id, resolution, explanation)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, key, itemAId, itemBId, resolution, explanation]
  );

  return queryOne("SELECT * FROM conflicts WHERE id = ?", [id]) as unknown as Conflict;
}

export async function reconcileMemory(
  candidates: MemoryCandidate[],
  eventId: string
): Promise<ReconcileResult> {
  const added: MemoryItem[] = [];
  const updated: MemoryItem[] = [];
  const conflicts: Conflict[] = [];
  const duplicates: MemoryItem[] = [];

  for (const candidate of candidates) {
    // First, check for exact duplicates and re-confirm them
    const duplicate = findDuplicate(candidate);
    if (duplicate) {
      const reconfirmed = reconfirmItem(duplicate.id, duplicate.confidence);
      logAudit(duplicate.id, "reconfirmed", `Same value repeated: "${candidate.value.slice(0, 80)}"`);
      duplicates.push(reconfirmed);
      continue;
    }

    const existing = findExistingByKey(candidate.key, candidate.scope, candidate.tripId);

    if (!existing) {
      const item = insertMemoryItem(candidate, eventId);
      logAudit(item.id, "created", `Extracted from user message. Type=${candidate.type}, scope=${candidate.scope}`);
      added.push(item);
      continue;
    }

    const newPrecedence = getPrecedence(candidate);
    const existingPrecedence = getPrecedence(existing);

    if (newPrecedence > existingPrecedence) {
      const newItem = insertMemoryItem(candidate, eventId);
      supersedeItem(existing.id, newItem.id);
      logAudit(newItem.id, "created", `Supersedes existing (precedence ${newPrecedence} > ${existingPrecedence})`);
      logAudit(existing.id, "superseded", `Replaced by ${newItem.id} with higher precedence`);
      updated.push(newItem);

      const conflict = recordConflict(
        candidate.key,
        existing.id,
        newItem.id,
        "b_wins",
        `New item (precedence ${newPrecedence}) supersedes existing (precedence ${existingPrecedence})`
      );
      conflicts.push(conflict);
    } else if (newPrecedence === existingPrecedence) {
      const newItem = insertMemoryItem(candidate, eventId);
      supersedeItem(existing.id, newItem.id);
      logAudit(newItem.id, "created", `Same precedence (${newPrecedence}), newer wins`);
      logAudit(existing.id, "superseded", `Replaced by newer item ${newItem.id}`);
      updated.push(newItem);

      const conflict = recordConflict(
        candidate.key,
        existing.id,
        newItem.id,
        "b_wins",
        `Same precedence (${newPrecedence}), newer item wins`
      );
      conflicts.push(conflict);
    } else {
      const newItem = insertMemoryItem(candidate, eventId);
      runSql("UPDATE memory_items SET status = 'stale' WHERE id = ?", [newItem.id]);
      logAudit(newItem.id, "marked_stale", `Lower precedence (${newPrecedence} < ${existingPrecedence}), kept existing`);
      updated.push(newItem);

      const conflict = recordConflict(
        candidate.key,
        existing.id,
        newItem.id,
        "a_wins",
        `Existing item (precedence ${existingPrecedence}) retained over new (precedence ${newPrecedence})`
      );
      conflicts.push(conflict);
    }
  }

  return { added, updated, conflicts, duplicates };
}
