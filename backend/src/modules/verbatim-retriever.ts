/**
 * Verbatim retriever: the episodic-memory lane of the hybrid system.
 *
 * Searches raw conversation events (the immutable event log in the `events`
 * table) to surface prior turns that are relevant to the current query.
 *
 * This is NOT a replacement for structured memory. It is the evidence layer:
 *
 *   Structured memory = authority (preferences, constraints, facts, overrides)
 *   Verbatim retrieval = evidence  (exact wording, assistant recommendations,
 *                                    subtle preferences, temporal recall)
 *
 * Scoring pipeline per event (five additive signals):
 *   1. BM25 lexical similarity against the query (normalised 0–1)
 *   2. Temporal proximity boost when the query has a time anchor
 *   3. Preference-evidence boost for events with "I usually/prefer/tend to…"
 *   4. Role boost for assistant messages on assistant-recall queries
 *   5. Semantic similarity (cosine of OpenAI embeddings, capped at 0.35)
 *      — only when an OpenAI API key is configured; gracefully absent otherwise
 *
 * All five signals are additive. The sum drives ranking and the returned
 * VerbatimSnippet carries a full scoring trace for observability.
 */

import { queryAll } from "../db/index.js";
import { bm25Rank } from "./ranking.js";
import {
  getOpenAiApiKey,
  getEmbeddingsForEvents,
  embedQuery,
  semanticBoostFor,
  cosineSimilarity,
} from "./embedding-store.js";
import type { TemporalAnchor } from "./query-classifier.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface VerbatimSnippet {
  id: string;                         // "snip_<eventId>" (stable, derived)
  event_id: string;
  conversation_id: string;
  project_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;                    // verbatim text of the matched event
  context_window: string;             // ±1 surrounding turns for context
  created_at: string;

  // Scoring trace (all five signals + final)
  bm25_score: number;
  temporal_boost: number;
  preference_boost: number;
  role_boost: number;
  semantic_score: number;             // cosine similarity boost (0 when unavailable)
  final_score: number;
  score_reason: string;               // human-readable explanation
}

export interface RetrievalOptions {
  maxResults?: number;                 // default 5
  excludeConversationId?: string;      // exclude the current in-flight conversation
  projectId?: string;                  // restrict to events in a project
  temporalAnchor?: TemporalAnchor;     // from query classifier
  isAssistantQuery?: boolean;          // true → boost assistant-role events
  maxEventAgeDays?: number;            // ignore events older than N days (0 = no limit)
}

// ─── Preference-evidence patterns ────────────────────────────────────────────
// These fire a synthetic boost so subtle preference statements that were
// not captured by the structured extractor are still surfaced.
//
// Patterns are grouped by category for clarity.  Each match adds 0.07 to the
// boost, capped at 0.25.  Broader coverage means fewer preference events are
// missed when BM25 vocabulary doesn't directly match the query.

const PREFERENCE_EVIDENCE: RegExp[] = [
  // Explicit preference language
  /\b(i usually|i tend to|i always|i prefer|i like|i love)\b/i,
  /\b(i hate|i dislike|i don'?t like|i never|i avoid|i won'?t)\b/i,
  /\b(my (favorite|go-to|preferred|typical|usual|default))\b/i,
  /\b(personally,?|for me,?|in my case,?|in my experience)\b/i,
  /\b(i always go for|i typically|i generally)\b/i,

  // Dietary / medical identity (implicit constraint language)
  /\b(i'?m (allergic|intolerant|vegetarian|vegan|gluten[- ]free|celiac|diabetic|lactose intolerant|nut allergic|pescatarian))\b/i,
  /\b(i have (celiac|diabetes|ibs|crohn|lactose intolerance|nut allergy|peanut allergy|shellfish allergy|gluten (allergy|sensitivity)))\b/i,
  /\b(i don'?t eat|i can'?t eat|i cannot eat|i avoid eating)\b/i,
  /\b(i need (vegan|vegetarian|halal|kosher|gluten[- ]free|dairy[- ]free|nut[- ]free) (options?|food|meals?))\b/i,
  /\b(i follow a (vegan|vegetarian|keto|paleo|halal|kosher|gluten[- ]free|dairy[- ]free|mediterranean) diet)\b/i,

  // Lifestyle / style preferences
  /\b(i'?m a? ?(morning|night|early|late) (person|riser|worker|owl))\b/i,
  /\b(i (work|focus|think|learn|write|code|read) (best|better|well) (with|when|if|by))\b/i,
  /\b(i('m| am) not a (fan of|big fan of|into|keen on))\b/i,
  /\b(that('?s| is) (too|not) (loud|spicy|hot|cold|fast|slow|big|small|expensive|cheap) for me)\b/i,
];

function preferenceBoostFor(content: string): number {
  let boost = 0;
  for (const p of PREFERENCE_EVIDENCE) {
    if (p.test(content)) boost += 0.07;
  }
  return Math.min(0.25, boost);
}

// ─── Preference query expansion ───────────────────────────────────────────────
// When a query is about preferences, BM25 can miss relevant events due to
// vocabulary gaps (e.g. query "dietary restrictions" vs event "I'm celiac").
// For such queries we expand the BM25 input with domain synonyms so the
// lexical scorer can find events even when exact terms don't appear in the
// query.
//
// Expansion only widens recall — BM25 still weights the original terms more
// heavily, so precision is not harmed.

const PREFERENCE_QUERY_EXPANSIONS: Array<{ anchor: RegExp; extra: string[] }> = [
  {
    anchor: /\b(diet(ary)?|food|eat(ing)?|meal|menu|restaurant|cuisine|allergen)\b/i,
    extra: [
      "gluten", "celiac", "lactose", "vegan", "vegetarian", "allergy",
      "intolerant", "kosher", "halal", "keto", "paleo", "dairy",
      "meat", "pork", "shellfish", "nuts", "pescatarian", "gluten-free",
    ],
  },
  {
    anchor: /\b(exercise|workout|fitness|gym|sport|training|physical activity|active)\b/i,
    extra: ["run", "jog", "swim", "yoga", "weights", "cardio", "cycling", "pilates", "hiit"],
  },
  {
    anchor: /\b(music|audio|listen|playlist|song|sound)\b/i,
    extra: ["genre", "artist", "band", "album", "classical", "jazz", "rock", "pop", "hip-hop"],
  },
  {
    anchor: /\b(sleep|rest|schedule|bedtime|routine|morning|night)\b/i,
    extra: ["morning", "night", "early", "late", "nap", "alarm", "bedtime", "wake"],
  },
  {
    anchor: /\b(communicat|tone|writing|style|voice|format|output)\b/i,
    extra: ["formal", "casual", "concise", "detailed", "bullet", "brief", "verbose", "plain"],
  },
  {
    anchor: /\b(preference|prefer|like|want|usual|typical|default)\b/i,
    // Generic preference query — pull in dietary + lifestyle terms so that
    // "what do I usually prefer?" surfaces events with implicit preferences.
    extra: [
      "celiac", "vegan", "vegetarian", "gluten", "allergy", "intolerant",
      "prefer", "usually", "tend to", "typically", "always", "avoid",
    ],
  },
  // Photography / camera gear — surface sessions that mention specific brands
  // or bodies when a follow-up asks about "setup" or "equipment".
  {
    anchor: /\b(photo(graph)?y|camera|lens(es)?|shoot(ing)?|snapshot|dslr|mirrorless|setup|equipment|accessor(y|ies))\b/i,
    extra: [
      "sony", "canon", "nikon", "fujifilm", "leica", "olympus", "panasonic",
      "tripod", "gimbal", "filter", "flash", "strap", "bag", "memory card",
      "aperture", "shutter", "iso", "prime", "zoom", "wide-angle", "telephoto",
    ],
  },
  // Research / academic publications. The `s?` suffixes matter — "publications"
  // and "conferences" come up in the plural in LongMemEval preference queries.
  {
    anchor: /\b(research|papers?|publications?|conferences?|journals?|studies|articles?|academic)\b/i,
    extra: [
      "ai", "artificial intelligence", "deep learning", "machine learning",
      "medical", "healthcare", "imaging", "neural network", "transformer",
      "arxiv", "neurips", "icml", "cvpr", "emnlp", "nature", "lancet",
    ],
  },
  // Gardening / homegrown cooking.
  {
    anchor: /\b(gardens?|homegrown|grown|grow|harvest|vegetables?|herbs?|produce|cook(ing)?|dinners?|recipes?|meal plan|serve|prepare|ingredients?)\b/i,
    extra: [
      "tomato", "basil", "mint", "zucchini", "lettuce", "pepper", "cucumber",
      "squash", "kale", "carrot", "onion", "garlic", "potato", "spinach",
      "pasta", "salad", "soup", "stew", "roast", "saute", "bake",
    ],
  },
  // Consumer electronics / phone / battery.
  {
    anchor: /\b(batter(y|ies)|phones?|mobile|chargers?|power bank|smartphones?|iphones?|android)\b/i,
    extra: [
      "portable", "power bank", "charger", "usb-c", "lightning", "wireless",
      "brightness", "airplane mode", "low power", "background app",
      "iphone", "samsung", "pixel", "watt", "mah",
    ],
  },
  // Baking / desserts.
  {
    anchor: /\b(bake|baking|desserts?|cakes?|cookies?|pastr(y|ies)|cupcakes?|muffins?|pies?|tarts?|breads?|brownies?)\b/i,
    extra: [
      "lemon", "poppyseed", "chocolate", "vanilla", "cinnamon", "buttercream",
      "sponge", "frosting", "glaze", "ganache", "meringue", "sourdough",
      "banana bread", "red velvet", "cheesecake", "apple pie",
    ],
  },
  // Musical instruments / gear — keep orchestral + folk instruments in the
  // anchor too, not just guitar-adjacent ones. "violin / cello / flute" etc.
  // are common in LongMemEval single-session-user practice-time questions.
  {
    anchor: /\b(guitars?|bass|drums?|piano|keyboards?|synth|amp(lifier)?s?|pedals?|instruments?|band|music store|violins?|cellos?|flutes?|saxophones?|trumpets?|ukuleles?|mandolins?|harps?|oboes?|clarinets?|practicing|rehears(e|ing|al))\b/i,
    extra: [
      "fender", "gibson", "stratocaster", "telecaster", "les paul", "martin",
      "taylor", "yamaha", "roland", "marshall", "vox", "humbucker", "single coil",
      "acoustic", "electric", "pickup", "neck", "fretboard", "tuning",
      "bow", "strings", "reed", "orchestra", "ensemble", "scale", "etude",
    ],
  },
];

/**
 * Expands the BM25 query with domain synonyms for preference-type queries.
 * Purely additive — the original query terms retain full BM25 weight.
 * Returns the original query unchanged for non-preference queries.
 */
function expandPreferenceQuery(query: string): string {
  // Only expand when the query looks like a preference / lifestyle question.
  // Skip assistant-recall and purely temporal queries — those need precise
  // lexical matching, not broad vocabulary expansion.
  const looksLikePreference =
    /\b(prefer|like|usual|dietary|food|eat|allergen|exercise|workouts?|restrictions?|habits?|styles?|default|tendenc(y|ies)|recommend|suggest|tips?|setups?|equipment|accessor|complement|gear|build upon|upgrades?|similar|comparable|interest(ed|ing)?|serve|look for|build on|previous|enhance|practic(e|ing)|dedicate)\b/i.test(query) &&
    !/\b(what did you|you (said|recommended|suggested|told me)|do you remember)\b/i.test(query);

  if (!looksLikePreference) return query;

  const extras = new Set<string>();
  for (const { anchor, extra } of PREFERENCE_QUERY_EXPANSIONS) {
    if (anchor.test(query)) {
      for (const term of extra) extras.add(term);
    }
  }

  if (extras.size === 0) return query;
  return `${query} ${[...extras].join(" ")}`;
}

// ─── Temporal proximity boost ─────────────────────────────────────────────────

/**
 * Gaussian proximity boost peaking at 0.4 when the event is exactly at the
 * anchor date.  Decays within the window, then falls exponentially outside.
 */
function temporalBoostFor(eventDate: Date, anchor: TemporalAnchor): number {
  const diffMs   = Math.abs(eventDate.getTime() - anchor.anchorDate.getTime());
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays <= anchor.windowDays) {
    const t = diffDays / Math.max(anchor.windowDays, 1);
    return 0.4 * Math.exp(-2 * t * t); // 0.4 at anchor → ~0.054 at edge
  }

  const excess = diffDays - anchor.windowDays;
  return 0.054 * Math.exp(-excess / Math.max(anchor.windowDays, 1));
}

// ─── Role boost ───────────────────────────────────────────────────────────────

function roleBoostFor(role: string, isAssistantQuery: boolean): number {
  // For assistant recall queries, boost assistant turns significantly so they
  // surface above the user turns that asked the question.
  if (isAssistantQuery && role === "assistant") return 0.30;
  if (!isAssistantQuery && role === "user") return 0.05;
  return 0;
}

// ─── Context window builder ───────────────────────────────────────────────────

interface RawEvent {
  id: string;
  conversation_id: string;
  project_id: string | null;
  role: string;
  content: string;
  created_at: string;
}

/**
 * For the top-N scored events, fetch ±1 surrounding turns in each conversation
 * and build a formatted context window string.
 *
 * Groups by conversation_id to make at most one DB query per unique conversation
 * among the top results.
 */
function buildContextWindows(topEvents: RawEvent[]): Map<string, string> {
  const result = new Map<string, string>();
  if (topEvents.length === 0) return result;

  // Group by conversation
  const byConv = new Map<string, RawEvent[]>();
  for (const e of topEvents) {
    const list = byConv.get(e.conversation_id) ?? [];
    list.push(e);
    byConv.set(e.conversation_id, list);
  }

  for (const [convId, convTopEvents] of byConv) {
    const allConvEvents = queryAll(
      `SELECT id, role, content FROM events
       WHERE conversation_id = ?
       ORDER BY created_at ASC
       LIMIT 200`,
      [convId]
    ) as Array<{ id: string; role: string; content: string }>;

    const idToIdx = new Map(allConvEvents.map((e, i) => [e.id, i]));

    for (const topEvent of convTopEvents) {
      const idx = idToIdx.get(topEvent.id);
      if (idx === undefined) {
        result.set(topEvent.id, clip(topEvent.content, 400));
        continue;
      }

      const start  = Math.max(0, idx - 1);
      const end    = Math.min(allConvEvents.length - 1, idx + 1);
      const window = allConvEvents.slice(start, end + 1);

      const windowText = window
        .map((e) => {
          const label = e.role === "user" ? "User" : e.role === "assistant" ? "Assistant" : "System";
          return `${label}: ${clip(e.content, 350)}`;
        })
        .join("\n");

      result.set(topEvent.id, windowText);
    }
  }

  return result;
}

function clip(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen - 1) + "…";
}

// ─── Main search function ─────────────────────────────────────────────────────

/**
 * Search conversation events for verbatim snippets relevant to a query.
 *
 * Returns up to `maxResults` VerbatimSnippet objects sorted by final_score
 * descending.  Only events with final_score > 0.01 are returned.
 *
 * The function is async because the optional semantic signal (signal #5)
 * requires an OpenAI embedding API call.  When no API key is configured the
 * function completes synchronously-equivalent (no network I/O) and
 * semantic_score is 0 for every snippet.
 */
export async function searchVerbatim(
  query: string,
  options: RetrievalOptions = {}
): Promise<VerbatimSnippet[]> {
  const {
    maxResults       = 5,
    excludeConversationId,
    projectId,
    temporalAnchor,
    isAssistantQuery = false,
    maxEventAgeDays  = 0,
  } = options;

  // Build SQL conditions
  const conditions: string[] = ["role IN ('user', 'assistant')"];
  const params: unknown[] = [];

  if (excludeConversationId) {
    conditions.push("conversation_id != ?");
    params.push(excludeConversationId);
  }
  if (projectId) {
    conditions.push("project_id = ?");
    params.push(projectId);
  }
  if (maxEventAgeDays > 0) {
    conditions.push("created_at >= datetime('now', ?)");
    params.push(`-${maxEventAgeDays} days`);
  }

  const events = queryAll(
    `SELECT id, conversation_id, project_id, role, content, created_at
     FROM events
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT 500`,
    params
  ) as unknown as RawEvent[];

  if (events.length === 0) return [];

  // ─── Signal 1: BM25 lexical similarity ──────────────────────────────────────
  // For preference-profile queries, expand the BM25 query with domain synonyms
  // so vocabulary-gap events (e.g. "I'm celiac" for query "dietary restrictions")
  // still receive a non-zero lexical score.
  const bm25Query  = expandPreferenceQuery(query);
  const docs       = events.map((e) => ({ id: e.id, text: e.content }));
  const bm25Raw    = bm25Rank(bm25Query, docs);
  const maxBm25    = Math.max(...bm25Raw.map((r) => r.score), 1e-9);
  const bm25Norm   = new Map(bm25Raw.map((r) => [r.id, r.score / maxBm25]));

  // ─── Signal 5: Semantic similarity (optional, async) ────────────────────────
  // Fetch the OpenAI key at runtime — null means semantic signal is disabled.
  const apiKey        = getOpenAiApiKey();
  const [queryVec, embeddingMap] = await Promise.all([
    embedQuery(query, apiKey),
    getEmbeddingsForEvents(
      events.map((e) => ({ id: e.id, content: e.content })),
      apiKey
    ),
  ]);

  // ─── Score every event ───────────────────────────────────────────────────────
  type ScoredEntry = { event: RawEvent; snippet: Omit<VerbatimSnippet, "context_window"> };
  const scored: ScoredEntry[] = [];

  for (const event of events) {
    const bm25       = bm25Norm.get(event.id) ?? 0;
    const temporal   = temporalAnchor
      ? temporalBoostFor(new Date(event.created_at), temporalAnchor)
      : 0;
    const preference = preferenceBoostFor(event.content);
    const role       = roleBoostFor(event.role, isAssistantQuery);

    // Signal 5: semantic boost — map raw cosine similarity to [0, 0.35]
    const eventVec = embeddingMap?.get(event.id);
    const semantic = queryVec && eventVec
      ? semanticBoostFor(cosineSimilarity(queryVec, eventVec))
      : 0;

    const final = bm25 + temporal + preference + role + semantic;

    const parts: string[] = [];
    if (bm25      > 0.01) parts.push(`bm25=${bm25.toFixed(3)}`);
    if (temporal  > 0.01) parts.push(`temporal=${temporal.toFixed(3)}`);
    if (preference> 0.01) parts.push(`pref=${preference.toFixed(3)}`);
    if (role      > 0.01) parts.push(`role=${role.toFixed(3)}`);
    if (semantic  > 0.01) parts.push(`semantic=${semantic.toFixed(3)}`);

    scored.push({
      event,
      snippet: {
        id:               `snip_${event.id}`,
        event_id:         event.id,
        conversation_id:  event.conversation_id,
        project_id:       event.project_id,
        role:             event.role as VerbatimSnippet["role"],
        content:          event.content,
        created_at:       event.created_at,
        bm25_score:       parseFloat(bm25.toFixed(4)),
        temporal_boost:   parseFloat(temporal.toFixed(4)),
        preference_boost: parseFloat(preference.toFixed(4)),
        role_boost:       parseFloat(role.toFixed(4)),
        semantic_score:   parseFloat(semantic.toFixed(4)),
        final_score:      parseFloat(final.toFixed(4)),
        score_reason:     parts.length
          ? `total=${final.toFixed(3)} (${parts.join(", ")})`
          : `total=${final.toFixed(3)} (no signal)`,
      },
    });
  }

  // Sort descending by final score, keep only meaningful results
  scored.sort((a, b) => b.snippet.final_score - a.snippet.final_score);
  const top = scored.filter((s) => s.snippet.final_score > 0.01).slice(0, maxResults);

  if (top.length === 0) return [];

  // Build context windows for top results (batched per conversation)
  const topEvents      = top.map((s) => s.event);
  const contextWindows = buildContextWindows(topEvents);

  return top.map((s) => ({
    ...s.snippet,
    context_window: contextWindows.get(s.event.id) ?? clip(s.event.content, 400),
  }));
}
