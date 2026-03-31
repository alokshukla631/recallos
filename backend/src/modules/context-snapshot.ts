import { v4 as uuidv4 } from "uuid";
import { queryAll, queryOne, runSql } from "../db/index.js";

export interface ContextSnapshot {
  id: string;
  event_id: string;
  provider: string;
  compiled_context_json: string;
  included_memory_ids: string;
  omitted_memory_ids: string;
  rationale_json: string | null;
  prompt_preview: string | null;
  created_at: string;
}

export async function saveSnapshot(
  eventId: string,
  provider: string,
  compiledContext: object,
  includedIds: string[],
  omittedIds: string[],
  rationale: object,
  promptPreview?: string
): Promise<ContextSnapshot> {
  const id = uuidv4();

  runSql(
    `INSERT INTO context_snapshots
       (id, event_id, provider, compiled_context_json, included_memory_ids, omitted_memory_ids, rationale_json, prompt_preview)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      eventId,
      provider,
      JSON.stringify(compiledContext),
      JSON.stringify(includedIds),
      JSON.stringify(omittedIds),
      JSON.stringify(rationale),
      promptPreview ?? null,
    ]
  );

  return queryOne("SELECT * FROM context_snapshots WHERE id = ?", [id]) as unknown as ContextSnapshot;
}

export async function getSnapshot(id: string): Promise<ContextSnapshot | undefined> {
  return queryOne("SELECT * FROM context_snapshots WHERE id = ?", [id]) as unknown as ContextSnapshot | undefined;
}

export async function getSnapshotsForEvent(eventId: string): Promise<ContextSnapshot[]> {
  return queryAll(
    "SELECT * FROM context_snapshots WHERE event_id = ? ORDER BY created_at ASC",
    [eventId]
  ) as unknown as ContextSnapshot[];
}
