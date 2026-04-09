/**
 * User-defined tags for memory items.
 *
 * Tags let users categorize memory items freely (e.g. "food", "hotels",
 * "japan-2026", "work-travel") beyond the built-in type/scope fields.
 */
import { v4 as uuidv4 } from "uuid";
import { queryAll, runSql } from "../db/index.js";

export interface MemoryTag {
  id: string;
  memory_item_id: string;
  tag: string;
  created_at: string;
}

/**
 * Add a tag to a memory item. Silently ignores duplicates.
 */
export function addTag(memoryItemId: string, tag: string): void {
  const normalized = tag.toLowerCase().trim().replace(/\s+/g, "-");
  if (!normalized) return;
  try {
    runSql(
      `INSERT OR IGNORE INTO memory_tags (id, memory_item_id, tag)
       VALUES (?, ?, ?)`,
      [uuidv4(), memoryItemId, normalized]
    );
  } catch {
    // ignore duplicate
  }
}

/**
 * Remove a tag from a memory item.
 */
export function removeTag(memoryItemId: string, tag: string): void {
  const normalized = tag.toLowerCase().trim().replace(/\s+/g, "-");
  runSql(
    "DELETE FROM memory_tags WHERE memory_item_id = ? AND tag = ?",
    [memoryItemId, normalized]
  );
}

/**
 * Get all tags for a specific memory item.
 */
export function getTagsForItem(memoryItemId: string): string[] {
  const rows = queryAll(
    "SELECT tag FROM memory_tags WHERE memory_item_id = ? ORDER BY tag",
    [memoryItemId]
  );
  return rows.map((r) => r.tag as string);
}

/**
 * Get all tags in use across all memory items, with counts.
 */
export function getAllTags(): { tag: string; count: number }[] {
  return queryAll(
    `SELECT tag, COUNT(*) as count
     FROM memory_tags
     GROUP BY tag
     ORDER BY count DESC, tag ASC`
  ) as unknown as { tag: string; count: number }[];
}

/**
 * Get memory item IDs that have a specific tag.
 */
export function getItemsByTag(tag: string): string[] {
  const normalized = tag.toLowerCase().trim().replace(/\s+/g, "-");
  const rows = queryAll(
    "SELECT memory_item_id FROM memory_tags WHERE tag = ?",
    [normalized]
  );
  return rows.map((r) => r.memory_item_id as string);
}
