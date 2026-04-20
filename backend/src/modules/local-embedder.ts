/**
 * Local sentence-transformer embeddings via ONNX (CPU).
 *
 * Wraps @xenova/transformers with the `Xenova/all-MiniLM-L6-v2` model —
 * the same small, fast, 384-dim encoder MemPalace uses for LongMemEval
 * (see https://github.com/memodb-io/memobase/issues/214). No API key,
 * no network after first model download, no vendor lock-in.
 *
 * Why a separate module:
 *  - Keeps the OpenAI path in embedding-store.ts untouched for folks who
 *    want higher-quality vectors and already pay for OpenAI.
 *  - Lets callers pick per-deployment (env flag) without code changes.
 *  - The model weights (~23 MB) are loaded lazily on first use and cached
 *    by transformers.js in ~/.cache/transformers — not in this repo.
 *
 * The returned vectors are L2-normalised and mean-pooled so cosine
 * similarity is just dot product; that matches what sentence-transformers
 * produces server-side, so scores are directly comparable to MemPalace.
 */

export const LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const LOCAL_EMBEDDING_CACHE_KEY = "all-MiniLM-L6-v2";
export const LOCAL_EMBEDDING_DIM = 384;

// transformers.js types are CommonJS-shaped. We pull the symbol lazily so
// importing this module at startup does not pull the ONNX runtime into
// memory until semantic scoring is actually enabled.
type FeatureExtractionPipeline = (
  texts: string | string[],
  options?: { pooling?: "mean" | "cls" | "none"; normalize?: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>;

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    // Dynamic import is the officially recommended way to use transformers.js
    // from ESM — keeps the ONNX runtime out of the startup bundle.
    const { pipeline, env } = await import("@xenova/transformers");
    // Don't try to hit the HF hub beyond the first download; local cache only
    // after that. transformers.js defaults are fine for first run.
    env.allowRemoteModels = true;
    const extractor = await pipeline(
      "feature-extraction",
      LOCAL_EMBEDDING_MODEL
    );
    return extractor as unknown as FeatureExtractionPipeline;
  })();
  return pipelinePromise;
}

/**
 * Warm-up call: preload the model without producing any embeddings.
 * Useful for benchmarks that don't want the first query to eat the
 * model-load cost.
 */
export async function warmLocalEmbedder(): Promise<void> {
  await getPipeline();
}

/**
 * Embed a single string. Returns a 384-dim L2-normalised vector.
 */
export async function localEmbedQuery(text: string): Promise<number[]> {
  const extractor = await getPipeline();
  const output = await extractor(text.slice(0, 8192), {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(output.data);
}

/**
 * Embed many strings. Returned in the same order as input.
 *
 * Uses mini-batches of MINI_BATCH_SIZE with transformers.js's built-in
 * batching. That's 5-10x faster than one-by-one, at the cost of some
 * padding waste on highly-variable-length inputs. Empirically this runs
 * at ~200-300 texts/sec on CPU with MiniLM-L6, which is what we need
 * for LongMemEval haystacks (~500 events per question).
 */
const MINI_BATCH_SIZE = 16;

export async function localEmbedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getPipeline();
  const out: number[][] = new Array(texts.length);

  for (let start = 0; start < texts.length; start += MINI_BATCH_SIZE) {
    const batch = texts
      .slice(start, start + MINI_BATCH_SIZE)
      .map((t) => t.slice(0, 8192));
    const output = await extractor(batch, {
      pooling: "mean",
      normalize: true,
    });
    // Output tensor is shape [batch, dim]; .data is Float32Array of length batch*dim.
    const [bs, dim] = output.dims;
    for (let i = 0; i < bs; i++) {
      const slice = new Array<number>(dim);
      for (let j = 0; j < dim; j++) {
        slice[j] = output.data[i * dim + j];
      }
      out[start + i] = slice;
    }
  }
  return out;
}

/**
 * True when the user has opted into local embeddings. Read at call time
 * so tests can flip the env var between scenarios without re-importing.
 */
export function isLocalEmbeddingEnabled(): boolean {
  const v = process.env.USE_LOCAL_EMBEDDINGS;
  return v === "1" || v === "true";
}
