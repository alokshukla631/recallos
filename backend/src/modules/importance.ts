/**
 * Memory importance scoring.
 *
 * Computes a 0-100 importance score for a memory item based on:
 * - confidence (weight: 30%)
 * - recency of last confirmation (weight: 25%)
 * - number of links (weight: 20%)
 * - number of tags (weight: 15%)
 * - age survival bonus - older active items get credit (weight: 10%)
 */

import { queryOne, queryAll } from "../db/index.js";

export interface ImportanceFactors {
  confidence_score: number;
  recency_score: number;
  link_score: number;
  tag_score: number;
  age_bonus: number;
  total: number;
}

export function computeImportance(memoryId: string): ImportanceFactors {
  const item = queryOne("SELECT * FROM memory_items WHERE id = ?", [memoryId]) as any;
  if (!item) {
    return { confidence_score: 0, recency_score: 0, link_score: 0, tag_score: 0, age_bonus: 0, total: 0 };
  }

  // Confidence: 0-1 mapped to 0-30
  const confidence_score = Math.round((item.confidence ?? 0.5) * 30);

  // Recency: how recently was it confirmed? More recent = higher score
  let recency_score = 0;
  if (item.last_confirmed_at) {
    const daysSinceConfirm = (Date.now() - new Date(item.last_confirmed_at).getTime()) / (1000 * 60 * 60 * 24);
    recency_score = Math.round(Math.max(0, 25 - (daysSinceConfirm / 7) * 5)); // Drops 5 pts per week
  } else {
    // Never confirmed beyond creation - give partial credit based on creation date
    const daysSinceCreation = (Date.now() - new Date(item.created_at).getTime()) / (1000 * 60 * 60 * 24);
    recency_score = Math.round(Math.max(0, 15 - (daysSinceCreation / 7) * 3));
  }

  // Links: more connected items are more important (cap at 20)
  const linkCount = queryOne(
    "SELECT COUNT(*) as count FROM memory_links WHERE source_id = ? OR target_id = ?",
    [memoryId, memoryId]
  ) as any;
  const link_score = Math.min(20, (linkCount?.count || 0) * 5);

  // Tags: tagged items are curated (cap at 15)
  const tagCount = queryOne(
    "SELECT COUNT(*) as count FROM memory_tags WHERE memory_item_id = ?",
    [memoryId]
  ) as any;
  const tag_score = Math.min(15, (tagCount?.count || 0) * 5);

  // Age bonus: items that survived a long time without going stale get credit
  const ageInDays = (Date.now() - new Date(item.created_at).getTime()) / (1000 * 60 * 60 * 24);
  const age_bonus = item.status === "active" ? Math.min(10, Math.floor(ageInDays / 7)) : 0;

  const total = Math.min(100, confidence_score + recency_score + link_score + tag_score + age_bonus);

  return { confidence_score, recency_score, link_score, tag_score, age_bonus, total };
}

/**
 * Compute importance for all active items and return sorted by score descending.
 */
export function rankByImportance(limit: number = 20): Array<{ id: string; key: string; value: string; importance: number }> {
  const items = queryAll(
    "SELECT id, key, value FROM memory_items WHERE status = 'active' ORDER BY created_at DESC LIMIT 200"
  ) as any[];

  const scored = items.map((item) => {
    const factors = computeImportance(item.id);
    return { id: item.id, key: item.key, value: item.value, importance: factors.total };
  });

  scored.sort((a, b) => b.importance - a.importance);
  return scored.slice(0, limit);
}
