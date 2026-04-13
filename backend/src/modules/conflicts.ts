/**
 * Conflict detection module.
 * Identifies when a new memory value contradicts an existing one for the same key.
 * Uses simple heuristics: same key + different value + both active = potential conflict.
 */

import { queryAll, queryOne, runSql } from "../db/index.js";
import { logAudit } from "./audit.js";

export interface Conflict {
  id: string;
  existing_id: string;
  new_id: string;
  key: string;
  existing_value: string;
  new_value: string;
  status: "pending" | "resolved_keep_new" | "resolved_keep_old" | "resolved_merged";
  created_at: string;
}

export function ensureConflictsTable(): void {
  runSql(`CREATE TABLE IF NOT EXISTS memory_conflicts (
    id TEXT PRIMARY KEY,
    existing_id TEXT NOT NULL,
    new_id TEXT NOT NULL,
    key TEXT NOT NULL,
    existing_value TEXT NOT NULL,
    new_value TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  )`);
}

/**
 * Check if a memory item conflicts with existing items.
 * A conflict exists when there is an active item with the same key but a different value.
 */
export function detectConflicts(newId: string, key: string, value: string): Conflict[] {
  const existing = queryAll(
    `SELECT id, key, value FROM memory_items
     WHERE key = ? AND status = 'active' AND id != ?`,
    [key, newId]
  ) as Array<{ id: string; key: string; value: string }>;

  const conflicts: Conflict[] = [];

  for (const item of existing) {
    // Only flag if values are meaningfully different
    if (item.value.trim().toLowerCase() === value.trim().toLowerCase()) continue;

    const conflictId = crypto.randomUUID();
    runSql(
      `INSERT INTO memory_conflicts (id, existing_id, new_id, key, existing_value, new_value, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [conflictId, item.id, newId, key, item.value, value]
    );

    conflicts.push({
      id: conflictId,
      existing_id: item.id,
      new_id: newId,
      key,
      existing_value: item.value,
      new_value: value,
      status: "pending",
      created_at: new Date().toISOString(),
    });
  }

  return conflicts;
}

/**
 * Get all pending conflicts.
 */
export function getPendingConflicts(): Conflict[] {
  return queryAll(
    `SELECT * FROM memory_conflicts WHERE status = 'pending' ORDER BY created_at DESC`
  ) as unknown as Conflict[];
}

/**
 * Get all conflicts (with optional status filter).
 */
export function getConflicts(status?: string): Conflict[] {
  if (status && status !== "all") {
    return queryAll(
      `SELECT * FROM memory_conflicts WHERE status = ? ORDER BY created_at DESC`,
      [status]
    ) as unknown as Conflict[];
  }
  return queryAll(
    `SELECT * FROM memory_conflicts ORDER BY created_at DESC`
  ) as unknown as Conflict[];
}

/**
 * Resolve a conflict by choosing which memory to keep.
 */
export function resolveConflict(
  conflictId: string,
  resolution: "keep_new" | "keep_old" | "merged",
  mergedValue?: string
): void {
  const conflict = queryOne(
    `SELECT * FROM memory_conflicts WHERE id = ?`,
    [conflictId]
  ) as unknown as Conflict | null;

  if (!conflict) throw new Error("Conflict not found");

  const now = new Date().toISOString();

  switch (resolution) {
    case "keep_new":
      // Mark old item as superseded
      runSql(`UPDATE memory_items SET status = 'superseded' WHERE id = ?`, [conflict.existing_id]);
      logAudit(conflict.existing_id, "superseded", `Conflict resolved: keep new (${conflict.new_id})`);
      runSql(
        `UPDATE memory_conflicts SET status = 'resolved_keep_new', resolved_at = ? WHERE id = ?`,
        [now, conflictId]
      );
      break;

    case "keep_old":
      // Mark new item as superseded
      runSql(`UPDATE memory_items SET status = 'superseded' WHERE id = ?`, [conflict.new_id]);
      logAudit(conflict.new_id, "superseded", `Conflict resolved: keep old (${conflict.existing_id})`);
      runSql(
        `UPDATE memory_conflicts SET status = 'resolved_keep_old', resolved_at = ? WHERE id = ?`,
        [now, conflictId]
      );
      break;

    case "merged":
      // Update new item with merged value, supersede old
      if (mergedValue) {
        runSql(`UPDATE memory_items SET value = ? WHERE id = ?`, [mergedValue, conflict.new_id]);
      }
      runSql(`UPDATE memory_items SET status = 'superseded' WHERE id = ?`, [conflict.existing_id]);
      logAudit(conflict.existing_id, "superseded", `Conflict resolved: merged into ${conflict.new_id}`);
      logAudit(conflict.new_id, "reconfirmed", `Merged value from conflict resolution`);
      runSql(
        `UPDATE memory_conflicts SET status = 'resolved_merged', resolved_at = ? WHERE id = ?`,
        [now, conflictId]
      );
      break;
  }
}

/**
 * Get count of pending conflicts.
 */
export function getPendingConflictCount(): number {
  const row = queryOne(
    `SELECT COUNT(*) as count FROM memory_conflicts WHERE status = 'pending'`
  ) as { count: number } | null;
  return row?.count || 0;
}
