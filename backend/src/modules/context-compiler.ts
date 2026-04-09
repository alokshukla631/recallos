import { queryAll } from "../db/index.js";
import { bm25Rank } from "./ranking.js";
import type { MemoryItem } from "./memory-reconciler.js";

export interface ContextPacket {
  domain: string;
  domains: string[];
  goals: MemoryItem[];
  constraints: MemoryItem[];
  preferences: MemoryItem[];
  overrides: MemoryItem[];
  facts: MemoryItem[];
  ambiguities: string[];
}

export interface TraceEntry {
  memory_item_id: string;
  key: string;
  type: string;
  value: string;
  scope: string;
  bm25_score: number;
  recency_boost: number;
  final_score: number;
  decision: "included" | "omitted";
  reason: string;
}

export interface CompiledContext {
  contextPacket: ContextPacket;
  contextText: string;
  includedIds: string[];
  omittedIds: string[];
  rationale: Record<string, string>;
  trace: TraceEntry[];
}

function getActiveMemoryItems(tripId?: string): MemoryItem[] {
  if (tripId) {
    return queryAll(
      `SELECT * FROM memory_items
       WHERE status = 'active'
         AND (scope = 'global' OR (scope = 'trip' AND trip_id = ?))
       ORDER BY created_at DESC`,
      [tripId]
    ) as unknown as MemoryItem[];
  }

  return queryAll(
    `SELECT * FROM memory_items
     WHERE status = 'active' AND scope = 'global'
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
  tripId?: string
): Promise<CompiledContext> {
  const allItems = getActiveMemoryItems(tripId);

  const scoreMap = scoreAllBm25(allItems, currentMessage);

  const RELEVANCE_THRESHOLD = 0.1;
  const included: MemoryItem[] = [];
  const omitted: MemoryItem[] = [];
  const rationale: Record<string, string> = {};
  const trace: TraceEntry[] = [];

  for (const item of allItems) {
    const bm25Score = scoreMap.get(item.id) ?? 0;
    const recency = recencyBoost(item);
    const finalScore = bm25Score + recency;
    const alwaysInclude = item.type === "override" || item.type === "constraint";

    if (finalScore >= RELEVANCE_THRESHOLD || alwaysInclude) {
      included.push(item);
      const reason = alwaysInclude && finalScore < RELEVANCE_THRESHOLD
        ? `Always included (type=${item.type})`
        : `Score ${finalScore.toFixed(3)} above threshold (bm25=${bm25Score.toFixed(3)}, recency=${recency.toFixed(3)})`;
      rationale[item.id] = `Included: score=${finalScore.toFixed(2)}, type=${item.type}`;
      trace.push({
        memory_item_id: item.id,
        key: item.key,
        type: item.type,
        value: item.value,
        scope: item.scope,
        bm25_score: parseFloat(bm25Score.toFixed(4)),
        recency_boost: parseFloat(recency.toFixed(4)),
        final_score: parseFloat(finalScore.toFixed(4)),
        decision: "included",
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
        bm25_score: parseFloat(bm25Score.toFixed(4)),
        recency_boost: parseFloat(recency.toFixed(4)),
        final_score: parseFloat(finalScore.toFixed(4)),
        decision: "omitted",
        reason: `Score ${finalScore.toFixed(3)} below threshold (bm25=${bm25Score.toFixed(3)}, recency=${recency.toFixed(3)})`,
      });
    }
  }

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

  const contextText = lines.join("\n");

  return {
    contextPacket,
    contextText,
    includedIds: included.map((i) => i.id),
    omittedIds: omitted.map((i) => i.id),
    rationale,
    trace,
  };
}
