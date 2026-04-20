import { v4 as uuidv4 } from "uuid";
import { queryAll, queryOne, runSql } from "../db/index.js";

export interface Event {
  id: string;
  conversation_id: string;
  project_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  provider: string | null;
  created_at: string;
}

export async function storeEvent(
  conversationId: string,
  role: "user" | "assistant" | "system",
  content: string,
  provider: string | null,
  projectId?: string
): Promise<Event> {
  const id = uuidv4();

  runSql(
    `INSERT INTO events (id, conversation_id, project_id, role, content, provider)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, conversationId, projectId ?? null, role, content, provider ?? null]
  );

  return queryOne("SELECT * FROM events WHERE id = ?", [id]) as unknown as Event;
}

export async function getEvents(
  conversationId: string,
  limit?: number
): Promise<Event[]> {
  // Secondary ORDER BY rowid tiebreaks events inserted within the same second
  // (datetime('now') is second-precision). Fix #44.
  if (limit) {
    return queryAll(
      "SELECT * FROM events WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?",
      [conversationId, limit]
    ) as unknown as Event[];
  }
  return queryAll(
    "SELECT * FROM events WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
    [conversationId]
  ) as unknown as Event[];
}

export async function getRecentTurns(
  conversationId: string,
  limit: number = 10
): Promise<Event[]> {
  // rowid DESC tiebreak ensures "last N" is deterministic under rapid writes.
  // Fix #44.
  const rows = queryAll(
    `SELECT * FROM events
     WHERE conversation_id = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?`,
    [conversationId, limit]
  ) as unknown as Event[];

  return rows.reverse();
}
