/**
 * Memory audit log.
 *
 * Records every significant action on memory items so users can trace
 * how their memory evolved over time.
 */
import { v4 as uuidv4 } from "uuid";
import { queryAll, runSql } from "../db/index.js";

export type AuditAction =
  | "created"
  | "superseded"
  | "reconfirmed"
  | "marked_stale"
  | "imported"
  | "deleted";

export interface AuditEntry {
  id: string;
  memory_item_id: string;
  action: AuditAction;
  details: string | null;
  created_at: string;
}

/**
 * Record an audit entry for a memory item.
 */
export function logAudit(
  memoryItemId: string,
  action: AuditAction,
  details?: string
): void {
  const id = uuidv4();
  runSql(
    `INSERT INTO memory_audit_log (id, memory_item_id, action, details)
     VALUES (?, ?, ?, ?)`,
    [id, memoryItemId, action, details ?? null]
  );
}

/**
 * Get audit entries for a specific memory item, newest first.
 */
export function getAuditForItem(memoryItemId: string): AuditEntry[] {
  return queryAll(
    `SELECT * FROM memory_audit_log
     WHERE memory_item_id = ?
     ORDER BY created_at DESC`,
    [memoryItemId]
  ) as unknown as AuditEntry[];
}

/**
 * Get recent audit entries across all memory items.
 */
export function getRecentAudit(limit: number = 50): AuditEntry[] {
  return queryAll(
    `SELECT al.*, mi.key AS memory_key, mi.value AS memory_value, mi.type AS memory_type
     FROM memory_audit_log al
     LEFT JOIN memory_items mi ON al.memory_item_id = mi.id
     ORDER BY al.created_at DESC
     LIMIT ?`,
    [limit]
  ) as unknown as AuditEntry[];
}
