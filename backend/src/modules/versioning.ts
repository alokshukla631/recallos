/**
 * Memory item versioning.
 *
 * Tracks historical values for memory items so users can see the change
 * history and revert to a previous version if needed.
 */

import { v4 as uuidv4 } from "uuid";
import { queryAll, queryOne, runSql } from "../db/index.js";

export interface MemoryVersion {
  id: string;
  memory_item_id: string;
  version_number: number;
  value: string;
  confidence: number;
  changed_by: string;
  created_at: string;
}

/**
 * Ensure the versions table exists.
 */
export function ensureVersionTable(): void {
  const db = queryOne(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_versions'"
  );
  if (!db) {
    runSql(`
      CREATE TABLE memory_versions (
        id TEXT PRIMARY KEY,
        memory_item_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL,
        changed_by TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(memory_item_id, version_number)
      )
    `);
  }
}

/**
 * Snapshot the current state of a memory item as a new version.
 * Call this before updating the item's value.
 */
export function createVersion(memoryItemId: string, changedBy: string = "user"): MemoryVersion | null {
  const item = queryOne("SELECT * FROM memory_items WHERE id = ?", [memoryItemId]) as any;
  if (!item) return null;

  // Get the next version number
  const latest = queryOne(
    "SELECT MAX(version_number) as max_ver FROM memory_versions WHERE memory_item_id = ?",
    [memoryItemId]
  ) as any;
  const nextVersion = (latest?.max_ver || 0) + 1;

  const id = uuidv4();
  runSql(
    `INSERT INTO memory_versions (id, memory_item_id, version_number, value, confidence, changed_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, memoryItemId, nextVersion, item.value, item.confidence, changedBy]
  );

  return {
    id,
    memory_item_id: memoryItemId,
    version_number: nextVersion,
    value: item.value,
    confidence: item.confidence,
    changed_by: changedBy,
    created_at: new Date().toISOString(),
  };
}

/**
 * Get all versions for a memory item, ordered newest first.
 */
export function getVersions(memoryItemId: string): MemoryVersion[] {
  return queryAll(
    "SELECT * FROM memory_versions WHERE memory_item_id = ? ORDER BY version_number DESC",
    [memoryItemId]
  ) as unknown as MemoryVersion[];
}

/**
 * Get a specific version.
 */
export function getVersion(versionId: string): MemoryVersion | null {
  const row = queryOne("SELECT * FROM memory_versions WHERE id = ?", [versionId]) as any;
  return row || null;
}

/**
 * Revert a memory item to a specific version.
 * Creates a new version snapshot of the current state first, then applies the old value.
 */
export function revertToVersion(memoryItemId: string, versionId: string): boolean {
  const version = getVersion(versionId);
  if (!version || version.memory_item_id !== memoryItemId) return false;

  // Snapshot current state before reverting
  createVersion(memoryItemId, "revert");

  // Apply the old value
  runSql(
    "UPDATE memory_items SET value = ?, confidence = ?, last_confirmed_at = datetime('now') WHERE id = ?",
    [version.value, version.confidence, memoryItemId]
  );

  return true;
}

/**
 * Get the version count for a memory item.
 */
export function getVersionCount(memoryItemId: string): number {
  const row = queryOne(
    "SELECT COUNT(*) as count FROM memory_versions WHERE memory_item_id = ?",
    [memoryItemId]
  ) as any;
  return row?.count || 0;
}
