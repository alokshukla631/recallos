/**
 * Confidence decay for memory items.
 *
 * Memory items that haven't been reconfirmed recently should gradually
 * lose confidence. This prevents stale facts from being treated as
 * high-confidence when they haven't been mentioned in a long time.
 *
 * Decay model: exponential decay with a half-life of 30 days.
 * Only affects items that haven't been confirmed in the last 7 days.
 * Items below a minimum confidence threshold get marked as stale.
 */

import { queryAll, runSql } from "../db/index.js";
import { logAudit } from "./audit.js";

const DECAY_HALF_LIFE_DAYS = 30;
const GRACE_PERIOD_DAYS = 7; // Don't decay items confirmed in the last 7 days
const MIN_CONFIDENCE = 0.3; // Below this, mark as stale
const DECAY_FLOOR = 0.35; // Don't decay below this (keeps items visible but low-ranked)

export interface DecayResult {
  decayed: number;
  staled: number;
}

/**
 * Apply confidence decay to all active memory items.
 * Items not confirmed within the grace period lose confidence
 * based on how long since they were last confirmed.
 *
 * Returns count of items decayed and items marked stale.
 */
export function applyConfidenceDecay(): DecayResult {
  const now = Date.now();
  const graceMs = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  const graceCutoff = new Date(now - graceMs).toISOString();

  // Get active items that haven't been confirmed recently
  const items = queryAll(
    `SELECT id, key, confidence, last_confirmed_at, created_at
     FROM memory_items
     WHERE status = 'active'
       AND (last_confirmed_at IS NULL OR last_confirmed_at < ?)
       AND type != 'override'`,
    [graceCutoff]
  ) as Array<{
    id: string;
    key: string;
    confidence: number;
    last_confirmed_at: string | null;
    created_at: string;
  }>;

  let decayed = 0;
  let staled = 0;

  for (const item of items) {
    const referenceDate = item.last_confirmed_at || item.created_at;
    const ageMs = now - new Date(referenceDate).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    // Exponential decay: original_confidence * 0.5^(age/halfLife)
    // But we only apply decay for time beyond the grace period
    const decayDays = Math.max(0, ageDays - GRACE_PERIOD_DAYS);
    if (decayDays <= 0) continue;

    const decayFactor = Math.pow(0.5, decayDays / DECAY_HALF_LIFE_DAYS);
    const newConfidence = Math.max(DECAY_FLOOR, item.confidence * decayFactor);

    // Only update if confidence actually changed meaningfully
    if (Math.abs(newConfidence - item.confidence) < 0.01) continue;

    if (newConfidence <= MIN_CONFIDENCE) {
      runSql("UPDATE memory_items SET status = 'stale', confidence = ? WHERE id = ?", [
        newConfidence,
        item.id,
      ]);
      logAudit(item.id, "marked_stale", `Confidence decayed to ${newConfidence.toFixed(2)} (not confirmed in ${Math.round(ageDays)}d)`);
      staled++;
    } else {
      runSql("UPDATE memory_items SET confidence = ? WHERE id = ?", [
        parseFloat(newConfidence.toFixed(3)),
        item.id,
      ]);
      decayed++;
    }
  }

  return { decayed, staled };
}
