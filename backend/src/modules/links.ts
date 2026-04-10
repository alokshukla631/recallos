import { v4 as uuidv4 } from "uuid";
import { queryAll, queryOne, runSql } from "../db/index.js";

export type LinkRelation = "related_to" | "depends_on" | "conflicts_with" | "refines" | "derived_from";

export interface MemoryLink {
  id: string;
  source_id: string;
  target_id: string;
  relation: LinkRelation;
  strength: number;
  note: string | null;
  created_at: string;
}

/**
 * Creates a link between two memory items.
 * Returns the new link, or the existing one if an identical link already exists.
 */
export function createLink(
  sourceId: string,
  targetId: string,
  relation: LinkRelation,
  strength: number = 1.0,
  note?: string
): MemoryLink {
  // Check for existing identical link
  const existing = queryOne(
    "SELECT * FROM memory_links WHERE source_id = ? AND target_id = ? AND relation = ?",
    [sourceId, targetId, relation]
  );
  if (existing) {
    // Update strength and note if provided
    if (strength !== (existing.strength as number) || note) {
      runSql(
        "UPDATE memory_links SET strength = ?, note = ? WHERE id = ?",
        [strength, note ?? existing.note, existing.id]
      );
    }
    return queryOne("SELECT * FROM memory_links WHERE id = ?", [existing.id]) as unknown as MemoryLink;
  }

  const id = uuidv4();
  runSql(
    "INSERT INTO memory_links (id, source_id, target_id, relation, strength, note) VALUES (?, ?, ?, ?, ?, ?)",
    [id, sourceId, targetId, relation, strength, note ?? null]
  );
  return queryOne("SELECT * FROM memory_links WHERE id = ?", [id]) as unknown as MemoryLink;
}

/**
 * Removes a link by ID.
 */
export function removeLink(linkId: string): boolean {
  const existing = queryOne("SELECT * FROM memory_links WHERE id = ?", [linkId]);
  if (!existing) return false;
  runSql("DELETE FROM memory_links WHERE id = ?", [linkId]);
  return true;
}

/**
 * Get all links originating from a memory item.
 */
export function getLinksFrom(memoryItemId: string): MemoryLink[] {
  return queryAll(
    "SELECT * FROM memory_links WHERE source_id = ? ORDER BY strength DESC",
    [memoryItemId]
  ) as unknown as MemoryLink[];
}

/**
 * Get all links pointing to a memory item.
 */
export function getLinksTo(memoryItemId: string): MemoryLink[] {
  return queryAll(
    "SELECT * FROM memory_links WHERE target_id = ? ORDER BY strength DESC",
    [memoryItemId]
  ) as unknown as MemoryLink[];
}

/**
 * Get all links for a memory item (both directions), with the linked item details.
 */
export function getLinksForItem(memoryItemId: string): Array<MemoryLink & { linked_key: string; linked_value: string; linked_type: string; direction: "outgoing" | "incoming" }> {
  const outgoing = queryAll(
    `SELECT ml.*, mi.key as linked_key, mi.value as linked_value, mi.type as linked_type
     FROM memory_links ml
     JOIN memory_items mi ON ml.target_id = mi.id
     WHERE ml.source_id = ?
     ORDER BY ml.strength DESC`,
    [memoryItemId]
  ) as any[];

  const incoming = queryAll(
    `SELECT ml.*, mi.key as linked_key, mi.value as linked_value, mi.type as linked_type
     FROM memory_links ml
     JOIN memory_items mi ON ml.source_id = mi.id
     WHERE ml.target_id = ?
     ORDER BY ml.strength DESC`,
    [memoryItemId]
  ) as any[];

  return [
    ...outgoing.map((l) => ({ ...l, direction: "outgoing" as const })),
    ...incoming.map((l) => ({ ...l, direction: "incoming" as const })),
  ];
}

/**
 * Find related memory items by traversing links up to a given depth.
 * Returns a set of related item IDs (excluding the starting item).
 */
export function findRelated(memoryItemId: string, maxDepth: number = 2): Set<string> {
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: memoryItemId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    if (depth >= maxDepth) continue;

    // Get all linked items in both directions
    const links = queryAll(
      `SELECT target_id as linked_id FROM memory_links WHERE source_id = ?
       UNION
       SELECT source_id as linked_id FROM memory_links WHERE target_id = ?`,
      [id, id]
    ) as any[];

    for (const link of links) {
      if (!visited.has(link.linked_id)) {
        queue.push({ id: link.linked_id, depth: depth + 1 });
      }
    }
  }

  // Remove the starting item itself
  visited.delete(memoryItemId);
  return visited;
}
