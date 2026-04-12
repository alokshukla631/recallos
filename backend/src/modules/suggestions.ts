/**
 * Smart suggestions: recommends actions based on current memory state.
 *
 * Returns a prioritized list of suggestions for improving memory quality.
 */

import { queryAll, queryOne } from "../db/index.js";
import { findDuplicates } from "./duplicates.js";
import { findDecayCandidates } from "./decay.js";
import { rankByImportance } from "./importance.js";

export interface Suggestion {
  type: "merge" | "pin" | "decay" | "confirm" | "tag" | "info";
  priority: "high" | "medium" | "low";
  title: string;
  description: string;
  action_endpoint?: string;
  action_body?: Record<string, unknown>;
  item_ids?: string[];
}

export function generateSuggestions(): Suggestion[] {
  const suggestions: Suggestion[] = [];

  // 1. Check for duplicates
  const duplicates = findDuplicates(0.65);
  if (duplicates.length > 0) {
    const topDup = duplicates[0];
    suggestions.push({
      type: "merge",
      priority: "high",
      title: `Merge ${duplicates.length} duplicate group${duplicates.length > 1 ? "s" : ""}`,
      description: `"${topDup.key}" has ${topDup.items.length} similar entries (${Math.round(topDup.similarity * 100)}% overlap). Consider merging them.`,
      item_ids: topDup.items.map((i) => i.id),
    });
  }

  // 2. Check for stale items
  const staleCandidates = findDecayCandidates();
  if (staleCandidates.length > 0) {
    suggestions.push({
      type: "decay",
      priority: staleCandidates.length > 5 ? "high" : "medium",
      title: `${staleCandidates.length} item${staleCandidates.length > 1 ? "s" : ""} may be stale`,
      description: `These items have low importance or haven't been confirmed recently. Run decay to clean them up.`,
      action_endpoint: "POST /api/memory/decay",
      item_ids: staleCandidates.slice(0, 5).map((c) => c.id),
    });
  }

  // 3. High-importance items that are not pinned
  const topItems = rankByImportance(10);
  const unpinnedHighValue = topItems.filter((item) => {
    const full = queryOne("SELECT pinned FROM memory_items WHERE id = ?", [item.id]) as any;
    return full && !full.pinned && item.importance >= 60;
  });
  if (unpinnedHighValue.length > 0) {
    suggestions.push({
      type: "pin",
      priority: "low",
      title: `Consider pinning ${unpinnedHighValue.length} high-value item${unpinnedHighValue.length > 1 ? "s" : ""}`,
      description: `Items like "${unpinnedHighValue[0].key}" score ${unpinnedHighValue[0].importance}/100 but are not pinned. Pinning ensures they always appear in context.`,
      item_ids: unpinnedHighValue.map((i) => i.id),
    });
  }

  // 4. Items with no tags
  const untaggedCount = queryOne(
    `SELECT COUNT(*) as count FROM memory_items mi
     WHERE mi.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM memory_tags mt WHERE mt.memory_item_id = mi.id)`
  ) as any;
  const totalActive = queryOne("SELECT COUNT(*) as count FROM memory_items WHERE status = 'active'") as any;
  const untaggedPct = totalActive?.count > 0 ? Math.round(((untaggedCount?.count || 0) / totalActive.count) * 100) : 0;

  if (untaggedPct > 70 && (untaggedCount?.count || 0) > 3) {
    suggestions.push({
      type: "tag",
      priority: "low",
      title: `${untaggedPct}% of items have no tags`,
      description: `Adding tags helps organize memory and makes it easier to export or filter specific subsets.`,
    });
  }

  // 5. Memory size info
  const activeCount = totalActive?.count || 0;
  if (activeCount > 100) {
    suggestions.push({
      type: "info",
      priority: "low",
      title: `${activeCount} active items`,
      description: `Large memory sets can slow context compilation. Consider running decay or archiving old items to keep things fast.`,
    });
  }

  // Sort by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return suggestions;
}
