import { queryAll, runSql } from "../db/index.js";
import { bm25Rank } from "./ranking.js";
import { findRelated } from "./links.js";
import type { MemoryItem } from "./memory-reconciler.js";
import { classifyQuery } from "./query-classifier.js";
import type { QueryClassification, QueryType } from "./query-classifier.js";
import { searchVerbatim } from "./verbatim-retriever.js";
import type { VerbatimSnippet } from "./verbatim-retriever.js";

export interface ContextPacket {
  domain: string;
  domains: string[];
  goals: MemoryItem[];
  constraints: MemoryItem[];
  preferences: MemoryItem[];
  overrides: MemoryItem[];
  facts: MemoryItem[];
  ambiguities: string[];
  // Verbatim retrieval lane (Phase 1 hybrid upgrade)
  verbatimSnippets?: VerbatimSnippet[];
  queryType?: QueryType;
}

/**
 * Scoring trace entry for a verbatim snippet.
 * Mirrors TraceEntry for structured memory but covers the evidence layer.
 * Includes all five scoring signals (semantic_score is 0 when no OpenAI key).
 */
export interface VerbatimTrace {
  event_id: string;
  conversation_id: string;
  role: string;
  content_preview: string;   // first 120 chars
  created_at: string;
  bm25_score: number;
  temporal_boost: number;
  preference_boost: number;
  role_boost: number;
  semantic_score: number;    // cosine similarity boost (Phase 2; 0 when unavailable)
  final_score: number;
  reason: string;
}

export interface TraceEntry {
  memory_item_id: string;
  key: string;
  type: string;
  value: string;
  scope: string;
  domain: string | null;
  bm25_score: number;
  recency_boost: number;
  domain_boost: number;
  final_score: number;
  decision: "included" | "omitted";
  // True when the item cleared the threshold via BM25 / domain / link / always-include
  // rather than only via the durability floor or residual recency. Drives which
  // items qualify for last_confirmed_at refresh (see auto-reconfirm block).
  earned?: boolean;
  reason: string;
}

export interface TokenEstimate {
  char_count: number;
  word_count: number;
  estimated_tokens: number;
  budget_pct: number; // percentage of a typical 4096-token context window
}

export interface CompiledContext {
  contextPacket: ContextPacket;
  contextText: string;
  includedIds: string[];
  omittedIds: string[];
  rationale: Record<string, string>;
  trace: TraceEntry[];
  // Verbatim retrieval results (Phase 1 hybrid upgrade)
  verbatimTrace?: VerbatimTrace[];
  queryClassification?: QueryClassification;
  tokenEstimate: TokenEstimate;
}

/**
 * Fetches active memory items respecting the scope hierarchy:
 *   global + domain + trip/project (if projectId given) + session
 * All global and domain-scoped items are always included.
 * Project-scoped items are included only when a projectId is provided.
 * Session-scoped items are ephemeral and always included (they expire naturally).
 */
function getActiveMemoryItems(projectId?: string): MemoryItem[] {
  if (projectId) {
    return queryAll(
      `SELECT * FROM memory_items
       WHERE status = 'active'
         AND (
           scope IN ('global', 'domain', 'session')
           OR ((scope = 'project') AND project_id = ?)
         )
       ORDER BY created_at DESC`,
      [projectId]
    ) as unknown as MemoryItem[];
  }

  return queryAll(
    `SELECT * FROM memory_items
     WHERE status = 'active'
       AND scope IN ('global', 'domain', 'session')
     ORDER BY created_at DESC`
  ) as unknown as MemoryItem[];
}

/**
 * Scores each memory item against the current message using BM25 ranking.
 * Returns a map of itemId -> score (normalized to 0..1 based on max score).
 */
function scoreAllBm25(items: MemoryItem[], message: string): Map<string, number> {
  const docs = items.map((item) => ({
    id: item.id,
    text: `${item.key} ${item.value} ${item.type}`,
  }));

  const ranked = bm25Rank(message, docs);
  const maxScore = Math.max(...ranked.map((r) => r.score), 0);

  const normalized = new Map<string, number>();
  for (const { id, score } of ranked) {
    normalized.set(id, maxScore > 0 ? score / maxScore : 0);
  }
  return normalized;
}

/**
 * Calculates a recency boost for a memory item based on its age.
 * Newer items get a higher boost (up to 0.15), older items decay toward 0.
 * Half-life: 7 days (items lose half their recency boost every 7 days).
 */
function recencyBoost(item: MemoryItem): number {
  const MAX_BOOST = 0.15;
  const HALF_LIFE_DAYS = 7;

  const createdAt = item.last_confirmed_at || item.created_at;
  if (!createdAt) return 0;

  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  // Exponential decay: boost * 0.5^(age/halfLife)
  return MAX_BOOST * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

function groupByCategory(items: MemoryItem[]): Record<string, MemoryItem[]> {
  const groups: Record<string, MemoryItem[]> = {
    goal: [],
    constraint: [],
    preference: [],
    override: [],
    fact: [],
  };

  for (const item of items) {
    if (groups[item.type]) {
      groups[item.type].push(item);
    }
  }

  return groups;
}

function formatItemList(items: MemoryItem[]): string {
  if (items.length === 0) return "None";
  return items.map((i) => `${i.value} (${i.scope})`).join("; ");
}

// ---------------------------------------------------------------------------
// Multi-domain detection
// ---------------------------------------------------------------------------

const DOMAIN_PATTERNS: Record<string, RegExp> = {
  travel: /\b(?:trip|travel|flight|hotel|book|destination|airport|airline|seat|vacation|resort|cruise|passport|visa|luggage|itinerary)\b/i,
  coding: /\b(?:code|programming|developer|software|api|database|frontend|backend|deploy|git|repo|debug|compile|framework|library|npm|pip|typescript|javascript|python|rust)\b/i,
  work: /\b(?:meeting|project|deadline|client|presentation|report|team|manager|stakeholder|sprint|roadmap|quarterly|office|colleague)\b/i,
  health: /\b(?:allergy|diet|vegetarian|vegan|exercise|medication|doctor|health|fitness|calories|weight|sleep|medical)\b/i,
  finance: /\b(?:budget|salary|invest|savings|expense|income|tax|portfolio|stocks|crypto|retirement|loan|mortgage|payment)\b/i,
  learning: /\b(?:study|course|exam|tutorial|homework|lecture|certification|skill|lesson|training|curriculum)\b/i,
  writing: /\b(?:writing|tone|voice|style|essay|article|blog|draft|edit|proofread|grammar|format|prose)\b/i,
};

/**
 * Detects domains from the user's message text alone.
 * Called BEFORE scoring so domain-aware boosts can be applied.
 */
function detectMessageDomains(message: string): Set<string> {
  const detected = new Set<string>();
  for (const [domain, pattern] of Object.entries(DOMAIN_PATTERNS)) {
    if (pattern.test(message)) {
      detected.add(domain);
    }
  }
  return detected;
}

/**
 * Detects all relevant domains from included memory items and the current message.
 * Returns the primary domain and the full list of detected domains.
 */
function detectDomains(items: MemoryItem[], message: string): { primary: string; all: string[] } {
  const scores: Record<string, number> = {};

  // Score domains from the message (weighted 2x since it represents current intent)
  for (const [domain, pattern] of Object.entries(DOMAIN_PATTERNS)) {
    const messageMatches = (message.match(pattern) || []).length;
    scores[domain] = (scores[domain] || 0) + messageMatches * 2;
  }

  // Score domains from included memory items
  for (const item of items) {
    const text = `${item.key} ${item.value}`;
    for (const [domain, pattern] of Object.entries(DOMAIN_PATTERNS)) {
      if (pattern.test(text)) {
        scores[domain] = (scores[domain] || 0) + 1;
      }
    }
  }

  // Collect domains with any score, sorted by score descending
  const detected = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([domain]) => domain);

  return {
    primary: detected[0] || "general",
    all: detected.length > 0 ? detected : ["general"],
  };
}

// ---------------------------------------------------------------------------
// Main compilation function
// ---------------------------------------------------------------------------

export async function compileContext(
  conversationId: string,
  currentMessage: string,
  projectId?: string
): Promise<CompiledContext> {
  const allItems = getActiveMemoryItems(projectId);

  const scoreMap = scoreAllBm25(allItems, currentMessage);

  // Detect the message domain BEFORE scoring so we can boost same-domain
  // items and dampen cross-domain recency. Without this, recent items from
  // unrelated domains (e.g. coding memories when asking about a trip) ride
  // in on recency alone and pollute the context.
  const messageDomains = detectMessageDomains(currentMessage);

  // Classify the query BEFORE structured scoring. The structured lane has to
  // know whether this is an assistant_recall / temporal_history / episodic
  // query so it can stop admitting unrelated durable preferences via the
  // confidence floor or stale-reconfirm recency. Previously classification
  // only ran for the verbatim lane, so the structured lane behaved uniformly
  // across every query type and leaked noise into episodic/temporal queries.
  const classification = classifyQuery(currentMessage);
  const verbatimHeavy =
    classification.type === "assistant_recall" ||
    classification.type === "temporal_history" ||
    classification.type === "episodic_search";
  const broadProfileQuery =
    classification.type === "preference_profile" ||
    classification.type === "planning";

  const RELEVANCE_THRESHOLD = 0.1;
  const LINK_BOOST = 0.08;          // Boost for items linked to high-scoring items
  const DOMAIN_MATCH_BOOST = 0.1;   // Boost for items matching the message domain
  const DOMAIN_MISMATCH_FACTOR = 0.3; // Recency multiplier for cross-domain items
  // High-confidence preferences survive recency decay (relevance > recency policy).
  // A global/domain preference with confidence ≥ 0.85 gets a floor of
  //   confidence × 0.12   →  0.85 → 0.102, 0.95 → 0.114
  // so it stays just above RELEVANCE_THRESHOLD even when BM25 is zero and the
  // item is months old.  Lower-confidence / session-scoped prefs still need
  // BM25 or recency to earn inclusion.
  //
  // IMPORTANT: the floor is only applied when an item is *eligible* for it —
  // see preferenceFloorEligible() below. Prior to that fix it applied
  // unconditionally and bled travel/music preferences into coding queries.
  const CONFIDENCE_FLOOR_FACTOR = 0.12;
  const CONFIDENCE_FLOOR_MIN    = 0.85;

  // Per-query-type recency multipliers for structured preference/fact items.
  // Verbatim-heavy queries should be answered from past conversation evidence,
  // not from durable preferences that happen to have been reconfirmed recently.
  // Balanced queries get a smaller dampening so preferences need lexical or
  // domain signal to win, not just recency.
  const STRUCTURED_RECENCY_FACTOR_VERBATIM = 0.25;
  const STRUCTURED_RECENCY_FACTOR_BALANCED = 0.6;

  /**
   * Is this item eligible for the durable-preference confidence floor on the
   * current query?
   *
   *  - assistant_recall / temporal_history / episodic_search   → never
   *      (these queries should lean on the evidence lane; structured prefs
   *       must earn inclusion via BM25 or domain match, not durability)
   *  - message has detected domains AND item has a domain tag → only when
   *    the item's domain matches a detected domain
   *  - message has no detected domain AND query is a broad preference profile
   *    or planning query → allowed (these want the full durable profile)
   *  - otherwise (balanced / no domains / domain-less item) → allowed
   */
  function preferenceFloorEligible(item: MemoryItem): boolean {
    if (item.type !== "preference") return false;
    if (item.confidence < CONFIDENCE_FLOOR_MIN) return false;
    if (item.scope !== "global" && item.scope !== "domain") return false;

    // Verbatim-heavy queries never get the durability floor for preferences.
    if (verbatimHeavy) return false;

    // Domain-aware gating: if the query has detectable domains and the item
    // is tagged with a domain, require a match. Domain-less items (no tag)
    // remain eligible because they are the "general profile" memory.
    if (messageDomains.size > 0 && item.domain) {
      return messageDomains.has(item.domain);
    }

    // No detectable domain in the message: only allow the floor on queries
    // that genuinely want the broad durable profile.
    if (messageDomains.size === 0) {
      return broadProfileQuery || classification.type === "balanced";
    }

    // Message has domains but the item doesn't — let it through only on
    // broad profile/planning queries so we don't bleed tagless prefs into
    // domain-specific asks.
    return broadProfileQuery;
  }

  const included: MemoryItem[] = [];
  const omitted: MemoryItem[] = [];
  const rationale: Record<string, string> = {};
  const trace: TraceEntry[] = [];

  // Helper: compute domain-aware recency for an item.
  // Also dampens recency for structured preference/fact items on verbatim-heavy
  // queries and (more mildly) on balanced queries, so that a recently
  // reconfirmed but off-topic preference cannot ride into an episodic /
  // assistant-recall answer on recency alone.
  function domainAwareRecency(item: MemoryItem): { recency: number; domainBoost: number } {
    let recency = recencyBoost(item);
    let domainBoost = 0;

    // Only apply domain logic when the message has a detectable domain
    // and the item has a domain tag. Items with domain=null are general
    // purpose and keep their normal scores.
    if (messageDomains.size > 0 && item.domain) {
      if (messageDomains.has(item.domain)) {
        domainBoost = DOMAIN_MATCH_BOOST;
      } else {
        // Dampen recency for cross-domain items so they do not ride into
        // context on recency alone when the conversation topic changed.
        recency *= DOMAIN_MISMATCH_FACTOR;
      }
    }

    // Structured recency dampening by query type. Preferences and facts are
    // the items most susceptible to stale-reconfirm bleed; constraints /
    // overrides / goals are authoritative and keep full recency.
    if (item.type === "preference" || item.type === "fact") {
      if (verbatimHeavy) {
        recency *= STRUCTURED_RECENCY_FACTOR_VERBATIM;
      } else if (classification.type === "balanced" && item.type === "preference") {
        recency *= STRUCTURED_RECENCY_FACTOR_BALANCED;
      }
    }

    return { recency, domainBoost };
  }

  // First pass: find items that score above threshold (these are "anchor" items).
  // Anchors are defined WITHOUT the durability floor — we only want items that
  // pulled themselves into consideration via real signals (BM25, recency,
  // domain match). This also prevents the confidence floor from dragging
  // unrelated preferences into the anchor set, which would then spread via
  // link boosts.
  const anchorIds = new Set<string>();
  for (const item of allItems) {
    const bm25Score = scoreMap.get(item.id) ?? 0;
    const { recency, domainBoost } = domainAwareRecency(item);
    if (bm25Score + recency + domainBoost >= RELEVANCE_THRESHOLD || item.type === "override" || item.type === "constraint") {
      anchorIds.add(item.id);
    }
  }

  // Second pass: find items related to anchors via memory links, give them a boost
  const linkedToAnchors = new Set<string>();
  for (const anchorId of anchorIds) {
    const related = findRelated(anchorId, 1); // 1-hop neighbors only for context
    for (const relatedId of related) {
      linkedToAnchors.add(relatedId);
    }
  }

  for (const item of allItems) {
    const bm25Score = scoreMap.get(item.id) ?? 0;
    const { recency, domainBoost } = domainAwareRecency(item);
    const linkBoost = linkedToAnchors.has(item.id) && !anchorIds.has(item.id) ? LINK_BOOST : 0;

    // Confidence floor: well-established global/domain preferences keep a
    // minimum score so they are not evicted purely due to recency decay —
    // but only when the item is *eligible* for the floor on this query
    // (see preferenceFloorEligible). Off-domain / assistant-recall / temporal
    // queries do not get the floor, which was the main leak path.
    const confFloor = preferenceFloorEligible(item)
      ? item.confidence * CONFIDENCE_FLOOR_FACTOR
      : 0;

    const finalScore = bm25Score + recency + linkBoost + domainBoost + confFloor;
    const alwaysInclude = item.type === "override" || item.type === "constraint" || item.pinned === 1;

    // "Earned inclusion" = admitted via signals that genuinely matched the
    // current query (lexical, domain, link) or the item is authoritative
    // (override / constraint / pinned). Items that cleared the threshold
    // only because of the durability floor or residual recency do NOT count
    // as earned — we will not refresh their last_confirmed_at.
    const BM25_EARNED_THRESHOLD = 0.05;
    const earnedInclusion =
      alwaysInclude ||
      bm25Score >= BM25_EARNED_THRESHOLD ||
      domainBoost > 0 ||
      linkBoost > 0;

    if (finalScore >= RELEVANCE_THRESHOLD || alwaysInclude) {
      included.push(item);
      const reason = item.pinned === 1 && finalScore < RELEVANCE_THRESHOLD
        ? "Pinned by user"
        : alwaysInclude && finalScore < RELEVANCE_THRESHOLD
        ? `Always included (type=${item.type})`
        : `Score ${finalScore.toFixed(3)} above threshold (bm25=${bm25Score.toFixed(3)}, recency=${recency.toFixed(3)}, domain=${domainBoost.toFixed(3)}${confFloor > 0 ? `, conf_floor=${confFloor.toFixed(3)}` : ""})`;
      rationale[item.id] = `Included: score=${finalScore.toFixed(2)}, type=${item.type}, domain=${item.domain || "general"}`;
      trace.push({
        memory_item_id: item.id,
        key: item.key,
        type: item.type,
        value: item.value,
        scope: item.scope,
        domain: item.domain,
        bm25_score: parseFloat(bm25Score.toFixed(4)),
        recency_boost: parseFloat(recency.toFixed(4)),
        domain_boost: parseFloat(domainBoost.toFixed(4)),
        final_score: parseFloat(finalScore.toFixed(4)),
        decision: "included",
        earned: earnedInclusion,
        reason,
      });
    } else {
      omitted.push(item);
      rationale[item.id] = `Omitted: score=${finalScore.toFixed(2)}, below threshold`;
      trace.push({
        memory_item_id: item.id,
        key: item.key,
        type: item.type,
        value: item.value,
        scope: item.scope,
        domain: item.domain,
        bm25_score: parseFloat(bm25Score.toFixed(4)),
        recency_boost: parseFloat(recency.toFixed(4)),
        domain_boost: parseFloat(domainBoost.toFixed(4)),
        final_score: parseFloat(finalScore.toFixed(4)),
        decision: "omitted",
        earned: false,
        reason: `Score ${finalScore.toFixed(3)} below threshold (bm25=${bm25Score.toFixed(3)}, recency=${recency.toFixed(3)}, domain=${domainBoost.toFixed(3)}${confFloor > 0 ? `, conf_floor=${confFloor.toFixed(3)}` : ""})`,
      });
    }
  }

  // Set of item ids that genuinely earned inclusion on this query. Only these
  // will have last_confirmed_at refreshed below. Keeping the set in sync with
  // the trace's earned=true flag means the debug view always explains which
  // items the system treats as "relevance-anchored" for this turn.
  const earnedIds = new Set<string>(
    trace.filter((t) => t.decision === "included" && t.earned).map((t) => t.memory_item_id)
  );

  // Sort trace: included first (by final score desc), then omitted (by final score desc)
  trace.sort((a, b) => {
    if (a.decision !== b.decision) return a.decision === "included" ? -1 : 1;
    return b.final_score - a.final_score;
  });

  const groups = groupByCategory(included);
  const { primary: domain, all: domains } = detectDomains(included, currentMessage);

  const ambiguities: string[] = [];
  const keyGroups = new Map<string, MemoryItem[]>();
  for (const item of included) {
    const existing = keyGroups.get(item.key) ?? [];
    existing.push(item);
    keyGroups.set(item.key, existing);
  }
  for (const [key, items] of keyGroups) {
    if (items.length > 1) {
      ambiguities.push(
        `Multiple values for "${key}": ${items.map((i) => i.value).join(" vs ")}`
      );
    }
    for (const item of items) {
      if (item.confidence < 0.6) {
        ambiguities.push(`Low confidence for "${key}": ${item.value} (${item.confidence})`);
      }
    }
  }

  const contextPacket: ContextPacket = {
    domain,
    domains,
    goals: groups.goal,
    constraints: groups.constraint,
    preferences: groups.preference,
    overrides: groups.override,
    facts: groups.fact,
    ambiguities,
  };

  // Build context text with domain awareness
  const lines = [
    "User context for this request:",
    `- Domain: ${domain}${domains.length > 1 ? ` (also relevant: ${domains.slice(1).join(", ")})` : ""}`,
    `- Active goals: ${formatItemList(groups.goal)}`,
    `- Hard constraints: ${formatItemList(groups.constraint)}`,
    `- Preferences: ${formatItemList(groups.preference)}`,
    `- Temporary overrides: ${formatItemList(groups.override)}`,
    `- Known facts: ${formatItemList(groups.fact)}`,
  ];

  if (ambiguities.length > 0) {
    lines.push(`- Unresolved questions: ${ambiguities.join("; ")}`);
  } else {
    lines.push("- Unresolved questions: None");
  }

  lines.push(
    "",
    "Use this context when answering. If uncertain or if context conflicts with the user's latest instruction, ask a clarifying question."
  );

  const structuredContextText = lines.join("\n");

  // Auto-reconfirm: only items that *earned* inclusion via real signals
  // (BM25 lexical match, domain boost, link boost, or authoritative types
  // like override / constraint / pinned). Items admitted purely by the
  // durability floor or residual recency do NOT get their last_confirmed_at
  // refreshed — otherwise noisy inclusion would reinforce itself: a recently
  // reconfirmed off-topic preference stays fresh, ranks higher on the next
  // query, gets included again, refreshes again, and the leak compounds.
  const reconfirmIds = included
    .filter((i) => earnedIds.has(i.id))
    .map((i) => i.id);
  if (reconfirmIds.length > 0) {
    const now = new Date().toISOString();
    const placeholders = reconfirmIds.map(() => "?").join(",");
    runSql(
      `UPDATE memory_items SET last_confirmed_at = ? WHERE id IN (${placeholders})`,
      [now, ...reconfirmIds]
    );
  }

  // ─── Verbatim retrieval lane ───────────────────────────────────────────────
  // `classification` was computed above so the structured lane could be
  // query-aware. Re-use it here to drive snippet budget and role boosting.

  // Number of verbatim snippets to include scales with verbatim weight:
  //   assistant_recall / temporal_history → up to 5
  //   episodic_search                     → up to 4
  //   preference_profile / planning       → up to 3
  //   balanced                            → up to 2
  const snippetBudget =
    classification.type === "assistant_recall"  ? 5 :
    classification.type === "temporal_history"  ? 5 :
    classification.type === "episodic_search"   ? 4 :
    classification.type === "preference_profile"? 3 :
    classification.type === "planning"          ? 3 :
    2; // balanced

  // isAssistantQuery is true both for pure assistant_recall queries AND for
  // temporal_history queries that also carry an assistant_recall signal
  // (e.g. "what did you recommend last week?").  Without this, the role boost
  // that surfaces assistant turns is silently dropped on the latter.
  const isAssistantQuery =
    classification.type === "assistant_recall" ||
    classification.signals.includes("assistant_recall");

  const verbatimSnippets = await searchVerbatim(currentMessage, {
    maxResults:             snippetBudget,
    excludeConversationId:  conversationId,
    projectId,
    temporalAnchor:         classification.temporalAnchor,
    isAssistantQuery,
  });

  // Append verbatim section to context text when there are results.
  let contextText = structuredContextText;
  if (verbatimSnippets.length > 0) {
    const evidenceLines: string[] = [
      "",
      "[PAST CONVERSATION EVIDENCE]",
    ];
    for (const snippet of verbatimSnippets) {
      const d = new Date(snippet.created_at);
      const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      evidenceLines.push(`-- ${dateStr}, ${snippet.role} --`);
      evidenceLines.push(snippet.context_window);
      evidenceLines.push("");
    }
    evidenceLines.push(
      "Note: The structured context above is the authority source.",
      "Use past conversations as supporting evidence for episodic recall,",
      "subtle preferences, and prior assistant recommendations."
    );
    contextText = structuredContextText + "\n" + evidenceLines.join("\n");
  }

  // Build verbatim trace (mirrors TraceEntry for the evidence layer)
  const verbatimTrace: VerbatimTrace[] = verbatimSnippets.map((s) => ({
    event_id:         s.event_id,
    conversation_id:  s.conversation_id,
    role:             s.role,
    content_preview:  s.content.slice(0, 120),
    created_at:       s.created_at,
    bm25_score:       s.bm25_score,
    temporal_boost:   s.temporal_boost,
    preference_boost: s.preference_boost,
    role_boost:       s.role_boost,
    semantic_score:   s.semantic_score,
    final_score:      s.final_score,
    reason:           s.score_reason,
  }));

  // ─── Token estimation (from final contextText including verbatim) ──────────
  const CONTEXT_BUDGET = 4096;
  const charCount       = contextText.length;
  const wordCount       = contextText.split(/\s+/).filter(Boolean).length;
  const estimatedTokens = Math.ceil(charCount / 4);
  const tokenEstimate: TokenEstimate = {
    char_count:       charCount,
    word_count:       wordCount,
    estimated_tokens: estimatedTokens,
    budget_pct:       Math.round((estimatedTokens / CONTEXT_BUDGET) * 100),
  };

  return {
    contextPacket: {
      ...contextPacket,
      verbatimSnippets,
      queryType: classification.type,
    },
    contextText,
    includedIds: included.map((i) => i.id),
    omittedIds:  omitted.map((i) => i.id),
    rationale,
    trace,
    verbatimTrace,
    queryClassification: classification,
    tokenEstimate,
  };
}
