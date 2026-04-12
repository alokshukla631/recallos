/**
 * Duplicate detection for memory items.
 *
 * Finds items that are likely duplicates based on:
 * - Exact key match with different values
 * - High token overlap (Jaccard similarity) between values
 * - Same type and scope
 */

import { queryAll } from "../db/index.js";
import { tokenize } from "./ranking.js";

export interface DuplicateGroup {
  key: string;
  type: string;
  items: Array<{
    id: string;
    value: string;
    scope: string;
    confidence: number;
    pinned: number;
    created_at: string;
  }>;
  similarity: number;
  reason: string;
}

/**
 * Compute Jaccard similarity between two token sets.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Find groups of likely duplicate memory items.
 * Returns groups sorted by highest similarity first.
 */
export function findDuplicates(threshold = 0.6): DuplicateGroup[] {
  const items = queryAll(
    "SELECT id, key, type, value, scope, confidence, pinned, created_at FROM memory_items WHERE status = 'active' ORDER BY key, created_at"
  ) as any[];

  const groups: DuplicateGroup[] = [];

  // Strategy 1: Same key, same type - group these together
  const byKeyType = new Map<string, typeof items>();
  for (const item of items) {
    const k = `${item.key}|||${item.type}`;
    const group = byKeyType.get(k) || [];
    group.push(item);
    byKeyType.set(k, group);
  }

  for (const [, group] of byKeyType) {
    if (group.length < 2) continue;

    // Check pairwise similarity within the group
    const tokensPerItem = group.map((item) => new Set(tokenize(item.value)));
    let maxSim = 0;
    for (let i = 0; i < tokensPerItem.length - 1; i++) {
      for (let j = i + 1; j < tokensPerItem.length; j++) {
        const sim = jaccard(tokensPerItem[i], tokensPerItem[j]);
        if (sim > maxSim) maxSim = sim;
      }
    }

    if (maxSim >= threshold) {
      groups.push({
        key: group[0].key,
        type: group[0].type,
        items: group.map((g) => ({
          id: g.id,
          value: g.value,
          scope: g.scope,
          confidence: g.confidence,
          pinned: g.pinned,
          created_at: g.created_at,
        })),
        similarity: parseFloat(maxSim.toFixed(3)),
        reason: `Same key and type with ${Math.round(maxSim * 100)}% value overlap`,
      });
    }
  }

  // Strategy 2: Different keys but very similar values (cross-key duplicates)
  // Only check items of the same type to avoid false positives
  const byType = new Map<string, typeof items>();
  for (const item of items) {
    const group = byType.get(item.type) || [];
    group.push(item);
    byType.set(item.type, group);
  }

  for (const [type, typeGroup] of byType) {
    if (typeGroup.length < 2) continue;

    const tokenSets = typeGroup.map((item) => ({
      item,
      tokens: new Set(tokenize(`${item.key} ${item.value}`)),
    }));

    for (let i = 0; i < tokenSets.length - 1; i++) {
      for (let j = i + 1; j < tokenSets.length; j++) {
        // Skip if already in a same-key group
        if (tokenSets[i].item.key === tokenSets[j].item.key) continue;

        const sim = jaccard(tokenSets[i].tokens, tokenSets[j].tokens);
        if (sim >= 0.75) { // Higher threshold for cross-key matches
          groups.push({
            key: `${tokenSets[i].item.key} / ${tokenSets[j].item.key}`,
            type,
            items: [tokenSets[i].item, tokenSets[j].item].map((g) => ({
              id: g.id,
              value: g.value,
              scope: g.scope,
              confidence: g.confidence,
              pinned: g.pinned,
              created_at: g.created_at,
            })),
            similarity: parseFloat(sim.toFixed(3)),
            reason: `Different keys but ${Math.round(sim * 100)}% content overlap`,
          });
        }
      }
    }
  }

  // Sort by similarity descending
  groups.sort((a, b) => b.similarity - a.similarity);
  return groups;
}
