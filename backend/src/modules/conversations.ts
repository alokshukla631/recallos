import { queryOne, queryAll, runSql } from "../db/index.js";

export interface Conversation {
  id: string;
  title: string | null;
  trip_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Generates a short title from the first user message.
 * Keeps the first sentence or first ~48 chars, whichever is shorter.
 */
export function generateTitle(message: string): string {
  const trimmed = message.trim();
  const firstSentence = trimmed.split(/[.!?\n]/)[0] ?? trimmed;
  const title = firstSentence.length <= 48
    ? firstSentence
    : firstSentence.slice(0, 45).trimEnd() + "...";
  return title || "New conversation";
}

/**
 * Ensures a conversation row exists. Creates one with a generated title
 * if this is the first message in the conversation.
 */
export function ensureConversation(
  conversationId: string,
  firstMessage: string,
  tripId?: string
): Conversation {
  const existing = queryOne(
    "SELECT * FROM conversations WHERE id = ?",
    [conversationId]
  ) as unknown as Conversation | undefined;

  if (existing) {
    // Bump the updated_at timestamp
    runSql(
      "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?",
      [conversationId]
    );
    return existing;
  }

  const title = generateTitle(firstMessage);
  runSql(
    `INSERT INTO conversations (id, title, trip_id) VALUES (?, ?, ?)`,
    [conversationId, title, tripId ?? null]
  );

  return queryOne(
    "SELECT * FROM conversations WHERE id = ?",
    [conversationId]
  ) as unknown as Conversation;
}

export function listConversations(): Conversation[] {
  return queryAll(
    `SELECT c.*,
            (SELECT COUNT(*) FROM events WHERE conversation_id = c.id) AS message_count
     FROM conversations c
     ORDER BY c.updated_at DESC`
  ) as unknown as Conversation[];
}

export function getConversation(id: string): Conversation | undefined {
  return queryOne(
    "SELECT * FROM conversations WHERE id = ?",
    [id]
  ) as unknown as Conversation | undefined;
}

export function updateConversationTitle(id: string, title: string): void {
  runSql(
    "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?",
    [title, id]
  );
}

export function deleteConversation(id: string): void {
  runSql("DELETE FROM events WHERE conversation_id = ?", [id]);
  runSql("DELETE FROM conversations WHERE id = ?", [id]);
}
