/**
 * Memory decay - identifies items that are likely stale and can auto-mark them.
 *
 * An item decays when:
 * - It has never been confirmed and is older than `maxAgeDays`
 * - It was last confirmed more than `maxStaleDays` ago
 * - Its importance score is below `minImportance`
 *
 * Decay does NOT delete items. It marks them as "stale" so they are
 * excluded from future context compilations but remain queryable.
 */

import { queryAll, runSql } from "../db/index.js";
import { computeImportance } from "./importance.js";
import { logAudit } from "./audit.js";

export interface DecayConfig {
  maxAgeDays: number;       // Items older than this without confirmation are candidates
  maxStaleDays: number;     // Items last confirmed longer ago than this are candidates
  minImportance: number;    // Items below this score are candidates (0-100)
}

const DEFAULT_CONFIG: DecayConfig = {
  maxAgeDays: 90,
  maxStaleDays: 60,
  minImportance: 15,
};

export interface DecayCandidate {
  id: string;
  key: string;
  value: string;
  type: string;
  reason: string;
  importance: number;
  created_at: string;
  last_confirmed_at: string | null;
}

/**
 * Find items that match decay criteria but do not change their status.
 */
export function findDecayCandidates(config: Partial<DecayConfig> = {}): DecayCandidate[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();

  // Pinned items are exempt from decay
  const items = queryAll(
    "SELECT id, key, value, type, created_at, last_confirmed_at, confidence, pinned FROM memory_items WHERE status = 'active' AND pinned = 0"
  ) as any[];

  const candidates: DecayCandidate[] = [];

  for (const item of items) {
    const ageMs = now - new Date(item.created_at).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    const factors = computeImportance(item.id);

    // Check importance threshold
    if (factors.total < cfg.minImportance) {
      candidates.push({
        id: item.id,
        key: item.key,
        value: item.value,
        type: item.type,
        reason: `importance below threshold (${factors.total} < ${cfg.minImportance})`,
        importance: factors.total,
        created_at: item.created_at,
        last_confirmed_at: item.last_confirmed_at,
      });
      continue;
    }

    // Check never confirmed + old
    if (!item.last_confirmed_at && ageDays > cfg.maxAgeDays) {
      candidates.push({
        id: item.id,
        key: item.key,
        value: item.value,
        type: item.type,
        reason: `never confirmed and older than ${cfg.maxAgeDays} days`,
        importance: factors.total,
        created_at: item.created_at,
        last_confirmed_at: null,
      });
      continue;
    }

    // Check stale confirmation
    if (item.last_confirmed_at) {
      const sinceLast = (now - new Date(item.last_confirmed_at).getTime()) / (1000 * 60 * 60 * 24);
      if (sinceLast > cfg.maxStaleDays) {
        candidates.push({
          id: item.id,
          key: item.key,
          value: item.value,
          type: item.type,
          reason: `last confirmed ${Math.floor(sinceLast)} days ago (threshold: ${cfg.maxStaleDays})`,
          importance: factors.total,
          created_at: item.created_at,
          last_confirmed_at: item.last_confirmed_at,
        });
      }
    }
  }

  // Sort: lowest importance first
  candidates.sort((a, b) => a.importance - b.importance);
  return candidates;
}

/**
 * Mark all decay candidates as stale. Returns the count of affected items.
 */
export function applyDecay(config: Partial<DecayConfig> = {}): { marked: number; candidates: DecayCandidate[] } {
  const candidates = findDecayCandidates(config);

  for (const c of candidates) {
    runSql("UPDATE memory_items SET status = 'stale' WHERE id = ? AND status = 'active'", [c.id]);
    logAudit(c.id, "marked_stale", `Decay: ${c.reason}`);
  }

  return { marked: candidates.length, candidates };
}
