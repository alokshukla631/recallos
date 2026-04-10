/**
 * Session memory cleanup
 *
 * Session-scoped memory items are temporary and should expire after a
 * configurable time-to-live (default: 24 hours). This module provides
 * a cleanup function that marks expired session items as stale.
 */

import { queryAll, runSql } from "../db/index.js";
import { logAudit } from "./audit.js";

const DEFAULT_SESSION_TTL_HOURS = 24;

/**
 * Mark session-scoped memory items as stale if they are older than the TTL.
 * Returns the number of items expired.
 */
export function expireSessionMemory(ttlHours: number = DEFAULT_SESSION_TTL_HOURS): number {
  const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000).toISOString();

  const expired = queryAll(
    `SELECT id, key, value FROM memory_items
     WHERE scope = 'session' AND status = 'active' AND created_at < ?`,
    [cutoff]
  ) as Array<{ id: string; key: string; value: string }>;

  for (const item of expired) {
    runSql("UPDATE memory_items SET status = 'stale' WHERE id = ?", [item.id]);
    logAudit(item.id as string, "marked_stale", `Session memory expired after ${ttlHours}h TTL`);
  }

  return expired.length;
}

/**
 * Get stats on session memory: active count, expired count, oldest active.
 */
export function getSessionStats(): {
  active: number;
  stale: number;
  oldest_active: string | null;
} {
  const active = queryAll(
    "SELECT COUNT(*) as count FROM memory_items WHERE scope = 'session' AND status = 'active'"
  ) as any[];

  const stale = queryAll(
    "SELECT COUNT(*) as count FROM memory_items WHERE scope = 'session' AND status = 'stale'"
  ) as any[];

  const oldest = queryAll(
    "SELECT created_at FROM memory_items WHERE scope = 'session' AND status = 'active' ORDER BY created_at ASC LIMIT 1"
  ) as any[];

  return {
    active: active[0]?.count || 0,
    stale: stale[0]?.count || 0,
    oldest_active: oldest[0]?.created_at || null,
  };
}
