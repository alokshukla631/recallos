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
  if (limit) {
    return queryAll(
      "SELECT * FROM events WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?",
      [conversationId, limit]
    ) as unknown as Event[];
  }
  return queryAll(
    "SELECT * FROM events WHERE conversation_id = ? ORDER BY created_at ASC",
    [conversationId]
  ) as unknown as Event[];
}

export async function getRecentTurns(
  conversationId: string,
  limit: number = 10
): Promise<Event[]> {
  const rows = queryAll(
    `SELECT * FROM events
     WHERE conversation_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [conversationId, limit]
  ) as unknown as Event[];

  return rows.reverse();
}
