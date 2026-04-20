/**
 * Embedding store: the semantic layer of the hybrid retrieval system.
 *
 * Generates and caches text embeddings for conversation events using
 * OpenAI's text-embedding-3-small model (1536 dimensions, low cost).
 * Falls back gracefully when no OpenAI API key is configured — in that
 * case the caller receives null and the semantic signal is simply omitted
 * from the scoring sum (BM25 + boosts continue to work as before).
 *
 * Design goals:
 *   - Cache-first: embeddings are stored in `event_embeddings` and reused
 *     across calls, so only new events ever require API calls.
 *   - Batch generation: all uncached embeddings for a retrieval call are
 *     sent in a single OpenAI request (up to MAX_NEW_PER_CALL).
 *   - Graceful degradation: any API error leaves BM25-only scoring intact.
 *   - Efficient persistence: all new embeddings in a batch are written in
 *     one transaction (single saveToFile call), not one per row.
 */

import OpenAI from "openai";
import { queryAll, queryOne, getDb, saveToFile } from "../db/index.js";
import {
  LOCAL_EMBEDDING_CACHE_KEY,
  isLocalEmbeddingEnabled,
  localEmbedBatch,
  localEmbedQuery,
} from "./local-embedder.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIM   = 1536;

/**
 * Label the active embedding model for cache rows. Local vectors are 384-dim
 * and OpenAI vectors are 1536-dim, so mixing them in the cache would corrupt
 * cosine scores — we key on model name to keep them disjoint.
 */
function activeModelLabel(): string {
  return isLocalEmbeddingEnabled() ? LOCAL_EMBEDDING_CACHE_KEY : EMBEDDING_MODEL;
}

/**
 * Maximum number of new embeddings to generate per retrieval call.
 * Guards against first-run latency spikes when there are many uncached events.
 * Already-cached events are never affected by this cap.
 *
 * Override with EMBEDDING_MAX_NEW_PER_CALL for benchmarks that want to embed
 * the full candidate pool (set to e.g. 1000 for LongMemEval haystacks).
 * Read at call time so tests can flip it between runs.
 */
function maxNewPerCall(): number {
  const raw = process.env.EMBEDDING_MAX_NEW_PER_CALL;
  if (!raw) return 100;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

// ─── Cosine similarity ────────────────────────────────────────────────────────

/**
 * Standard cosine similarity: dot(a, b) / (|a| * |b|).
 * Returns 0 when either vector is zero-length or dimensions mismatch.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Maps raw cosine similarity to a scoring boost in [0, 0.35].
 *
 * Threshold at 0.30 suppresses the noise floor (unrelated text typically
 * scores 0.2-0.4 with text-embedding-3-small).  Above the threshold the
 * signal scales linearly so that:
 *
 *   cosine = 0.30 →  0.00  (threshold)
 *   cosine = 0.55 →  0.13
 *   cosine = 0.75 →  0.23
 *   cosine = 0.90 →  0.30
 *   cosine = 1.00 →  0.35  (cap)
 *
 * The cap keeps the semantic signal comparable to the role_boost range (0.30)
 * so it complements BM25 without dominating the final ranking.
 */
export function semanticBoostFor(cosine: number): number {
  return Math.min(0.35, Math.max(0, (cosine - 0.30) * 0.5));
}

// ─── API key lookup ───────────────────────────────────────────────────────────

/**
 * Reads the OpenAI API key from provider_settings at call time.
 * Returns null when not configured (disables semantic scoring silently).
 */
export function getOpenAiApiKey(): string | null {
  try {
    const row = queryOne(
      "SELECT api_key FROM provider_settings WHERE provider = 'openai'",
      []
    ) as { api_key?: string } | undefined;
    return row?.api_key ?? null;
  } catch {
    return null;
  }
}

// ─── Cache layer ──────────────────────────────────────────────────────────────

interface CachedRow {
  event_id:  string;
  embedding: string;  // JSON-serialised number[]
}

function loadCached(eventIds: string[]): Map<string, number[]> {
  if (eventIds.length === 0) return new Map();
  const placeholders = eventIds.map(() => "?").join(",");
  const model = activeModelLabel();
  // Filter by model so 1536-dim OpenAI rows and 384-dim local rows don't
  // cross-contaminate cosine scoring when a user flips USE_LOCAL_EMBEDDINGS.
  const rows = queryAll(
    `SELECT event_id, embedding FROM event_embeddings
     WHERE model = ? AND event_id IN (${placeholders})`,
    [model, ...eventIds]
  ) as unknown as CachedRow[];

  const result = new Map<string, number[]>();
  for (const row of rows) {
    try {
      result.set(row.event_id, JSON.parse(row.embedding) as number[]);
    } catch {
      // corrupted entry — will be regenerated next call
    }
  }
  return result;
}

/**
 * Persist a batch of embeddings in one transaction (single saveToFile call).
 */
function saveEmbeddingsBatch(
  entries: Array<{ eventId: string; vec: number[] }>
): void {
  if (entries.length === 0) return;
  const database = getDb();
  const model = activeModelLabel();
  for (const { eventId, vec } of entries) {
    database.run(
      `INSERT OR REPLACE INTO event_embeddings (event_id, model, embedding)
       VALUES (?, ?, ?)`,
      [eventId, model, JSON.stringify(vec)]
    );
  }
  saveToFile();
}

// ─── OpenAI generation ────────────────────────────────────────────────────────

async function generateBatch(
  texts: string[],
  apiKey: string
): Promise<number[][]> {
  const client = new OpenAI({ apiKey });
  const response = await client.embeddings.create({
    model:           EMBEDDING_MODEL,
    input:           texts,
    encoding_format: "float",
  });
  // OpenAI guarantees order by index but sort defensively
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((e) => e.embedding);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns a vector map for a set of events (cache-first).
 *
 * 1. Loads cached embeddings from `event_embeddings`.
 * 2. Generates missing ones in a single batch call (capped at MAX_NEW_PER_CALL).
 * 3. Persists new embeddings in one transaction.
 *
 * Returns null when:
 *   - apiKey is null/empty
 *   - events array is empty
 *   - The batch API call fails AND the cache is empty
 *
 * In the null case the caller must treat semantic_score=0 for all events.
 */
export async function getEmbeddingsForEvents(
  events: Array<{ id: string; content: string }>,
  apiKey: string | null
): Promise<Map<string, number[]> | null> {
  if (events.length === 0) return null;

  const useLocal = isLocalEmbeddingEnabled();
  if (!useLocal && !apiKey) return null;

  const ids    = events.map((e) => e.id);
  const cached = loadCached(ids);

  const uncached = events
    .filter((e) => !cached.has(e.id))
    .slice(0, maxNewPerCall());

  if (uncached.length > 0) {
    try {
      const texts = uncached.map((e) => e.content.slice(0, 8192));
      const vecs  = useLocal
        ? await localEmbedBatch(texts)
        : await generateBatch(texts, apiKey as string);
      const toSave: Array<{ eventId: string; vec: number[] }> = [];

      for (let i = 0; i < uncached.length; i++) {
        const vec = vecs[i];
        if (vec) {
          cached.set(uncached[i].id, vec);
          toSave.push({ eventId: uncached[i].id, vec });
        }
      }

      saveEmbeddingsBatch(toSave);
    } catch {
      // Graceful degradation: use cached entries only (may be empty)
      return cached.size > 0 ? cached : null;
    }
  }

  return cached.size > 0 ? cached : null;
}

/**
 * Generates a single embedding for a query string.
 * Returns null on any error — callers must handle the null case.
 */
export async function embedQuery(
  query: string,
  apiKey: string | null
): Promise<number[] | null> {
  if (isLocalEmbeddingEnabled()) {
    try {
      return await localEmbedQuery(query);
    } catch {
      return null;
    }
  }
  if (!apiKey) return null;
  try {
    const client = new OpenAI({ apiKey });
    const response = await client.embeddings.create({
      model:           EMBEDDING_MODEL,
      input:           query.slice(0, 8192),
      encoding_format: "float",
    });
    return response.data[0]?.embedding ?? null;
  } catch {
    return null;
  }
}
