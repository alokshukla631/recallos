/**
 * Query classifier for hybrid memory retrieval routing.
 *
 * Classifies incoming queries so the context compiler can decide how much
 * weight to give structured memory vs. verbatim conversation retrieval.
 * The output drives both the retrieval strategy and the context text format
 * the model receives.
 *
 * Design:
 *   - Rule-based pattern matching (fast, explainable, no LLM call required)
 *   - Temporal reference detection with anchor-date estimation
 *   - Signals list for trace/debug output
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type QueryType =
  | "assistant_recall"    // "what did you recommend / say / suggest"
  | "preference_profile"  // "what do I prefer / my preference for X"
  | "temporal_history"    // "yesterday / last week / 2 weeks ago"
  | "episodic_search"     // "when did I / what happened / do you remember"
  | "planning"            // "help me plan / should I / what should"
  | "balanced";           // general queries

export interface TemporalAnchor {
  reference: string;    // matched phrase, e.g. "last week"
  anchorDate: Date;     // estimated actual date of the reference
  windowDays: number;   // proximity window for the temporal boost
}

export interface QueryClassification {
  type: QueryType;
  verbatimWeight: number;   // 0-1: how heavily to draw on verbatim snippets
  structuredWeight: number; // 0-1: how heavily to draw on structured memory
  temporalAnchor?: TemporalAnchor;
  signals: string[];        // human-readable list of detected signals
}

// ─── Signal patterns ──────────────────────────────────────────────────────────

const ASSISTANT_RECALL_PATTERNS: RegExp[] = [
  /\bwhat did you (recommend|say|suggest|tell me|advise|propose|come up with)\b/i,
  /\bwhat was your (recommendation|suggestion|advice|answer|response|plan)\b/i,
  /\byou (recommended|suggested|said|told me|advised|proposed)\b/i,
  /\bdo you remember (when|what|where|how|why|who)\b/i,
  /\bremind me (what|when|where|how)\b/i,
  /\bearlier you\b/i,
  /\blast time you\b/i,
  /\bpreviously you\b/i,
  /\bwhat (plan|advice|recommendation) did you\b/i,
  /\bwhat (did you|have you) (said|recommend|suggest|mention)\b/i,
];

const PREFERENCE_PROFILE_PATTERNS: RegExp[] = [
  /\bwhat (do|did) i (prefer|like|want|usually|tend to)\b/i,
  /\bwhat('?s| is) my (preference|favorite|go-to|usual|typical|default)\b/i,
  /\bmy (preference|favorite|go-to|usual)\b/i,
  /\bdo i (usually|typically|generally|always|tend to)\b/i,
  /\bwhat are my\b/i,
  /\bwhat (kind|type|style) (do i|of .* do i)\b/i,
  /\bam i (allergic|intolerant|vegetarian|vegan)\b/i,
];

const EPISODIC_SEARCH_PATTERNS: RegExp[] = [
  /\bdo you remember\b/i,
  /\bwhen did (i|we)\b/i,
  /\bwhat happened (with|to|when|after|before)\b/i,
  /\bthe (last|previous) time (i|we)\b/i,
  /\beach time i\b/i,
  /\bpreviously (i|we)\b/i,
  /\bhave (i|we) (ever|already|discussed|talked about|mentioned)\b/i,
  /\bcan you recall\b/i,
  /\bgoing back to\b/i,
];

const PLANNING_PATTERNS: RegExp[] = [
  /\bhelp me (plan|organize|schedule|prepare|decide)\b/i,
  /\bshould i\b/i,
  /\bwhat should (i|we)\b/i,
  /\bhow (should|can|do) i\b/i,
  /\bgive me a plan\b/i,
  /\badvice (on|for|about)\b/i,
  /\bwhat would you recommend\b/i,
];

// Temporal reference patterns.
// offsetDays: how far back from "now" the anchor is
// windowDays: radius of the temporal boost window around the anchor
const TEMPORAL_PATTERNS: Array<{
  pattern: RegExp;
  label: string;
  offsetDays: number;
  windowDays: number;
}> = [
  { pattern: /\bjust now\b/i,                        label: "just now",        offsetDays: 0,   windowDays: 1  },
  { pattern: /\btoday\b/i,                            label: "today",           offsetDays: 0,   windowDays: 1  },
  { pattern: /\bthis (morning|afternoon|evening)\b/i, label: "today",           offsetDays: 0,   windowDays: 1  },
  { pattern: /\byesterday\b/i,                        label: "yesterday",       offsetDays: 1,   windowDays: 1  },
  { pattern: /\blast night\b/i,                       label: "last night",      offsetDays: 1,   windowDays: 1  },
  { pattern: /\ba? ?few days? ago\b/i,                label: "a few days ago",  offsetDays: 3,   windowDays: 3  },
  { pattern: /\blast (week|7 days?)\b/i,              label: "last week",       offsetDays: 7,   windowDays: 5  },
  { pattern: /\b2 weeks? ago\b/i,                     label: "2 weeks ago",     offsetDays: 14,  windowDays: 5  },
  { pattern: /\b3 weeks? ago\b/i,                     label: "3 weeks ago",     offsetDays: 21,  windowDays: 5  },
  { pattern: /\blast month\b/i,                       label: "last month",      offsetDays: 30,  windowDays: 10 },
  { pattern: /\b2 months? ago\b/i,                    label: "2 months ago",    offsetDays: 60,  windowDays: 14 },
  { pattern: /\b3 months? ago\b/i,                    label: "3 months ago",    offsetDays: 90,  windowDays: 14 },
  { pattern: /\bearlier this (week|month|year)\b/i,   label: "earlier",         offsetDays: 10,  windowDays: 10 },
  { pattern: /\brecently\b/i,                         label: "recently",        offsetDays: 7,   windowDays: 10 },
  { pattern: /\ba while (ago|back)\b/i,               label: "a while ago",     offsetDays: 30,  windowDays: 20 },
  { pattern: /\bsome time ago\b/i,                    label: "some time ago",   offsetDays: 14,  windowDays: 14 },
  { pattern: /\bin the past\b/i,                      label: "in the past",     offsetDays: 14,  windowDays: 30 },
  { pattern: /\b(before|earlier|previously)\b/i,      label: "before",          offsetDays: 7,   windowDays: 30 },
];

// ─── Classifier ───────────────────────────────────────────────────────────────

/**
 * Classify a query to determine retrieval strategy.
 *
 * Priority order:
 *   temporal + recall/episodic > assistant_recall > temporal > episodic >
 *   preference_profile > planning > balanced
 */
export function classifyQuery(query: string, now: Date = new Date()): QueryClassification {
  const signals: string[] = [];

  // Detect temporal reference (first match wins since patterns are ordered
  // from most-specific to most-general)
  let temporalAnchor: TemporalAnchor | undefined;
  for (const tp of TEMPORAL_PATTERNS) {
    const match = query.match(tp.pattern);
    if (match) {
      signals.push(`temporal:${tp.label}`);
      temporalAnchor = {
        reference: match[0],
        anchorDate: new Date(now.getTime() - tp.offsetDays * 24 * 60 * 60 * 1000),
        windowDays: tp.windowDays,
      };
      break;
    }
  }

  const isAssistantRecall   = ASSISTANT_RECALL_PATTERNS.some(p => p.test(query));
  const isPreferenceProfile = PREFERENCE_PROFILE_PATTERNS.some(p => p.test(query));
  const isEpisodic          = EPISODIC_SEARCH_PATTERNS.some(p => p.test(query));
  const isPlanning          = PLANNING_PATTERNS.some(p => p.test(query));

  if (isAssistantRecall)   signals.push("assistant_recall");
  if (isPreferenceProfile) signals.push("preference_profile");
  if (isEpisodic)          signals.push("episodic_search");
  if (isPlanning)          signals.push("planning");

  // Temporal + recall/episodic: very verbatim-heavy
  if (temporalAnchor && (isAssistantRecall || isEpisodic)) {
    return { type: "temporal_history", verbatimWeight: 0.9, structuredWeight: 0.1, temporalAnchor, signals };
  }

  // Pure temporal: still verbatim-heavy
  if (temporalAnchor) {
    return { type: "temporal_history", verbatimWeight: 0.85, structuredWeight: 0.15, temporalAnchor, signals };
  }

  // Assistant recall: nearly all verbatim
  if (isAssistantRecall) {
    return { type: "assistant_recall", verbatimWeight: 0.85, structuredWeight: 0.15, signals };
  }

  // Episodic: mostly verbatim
  if (isEpisodic) {
    return { type: "episodic_search", verbatimWeight: 0.75, structuredWeight: 0.25, signals };
  }

  // Preference profile: structured first, verbatim for nuance
  if (isPreferenceProfile) {
    return { type: "preference_profile", verbatimWeight: 0.35, structuredWeight: 0.65, signals };
  }

  // Planning: balanced, slight structured bias
  if (isPlanning) {
    return { type: "planning", verbatimWeight: 0.40, structuredWeight: 0.60, signals };
  }

  // Default: mostly structured, light verbatim for context
  return { type: "balanced", verbatimWeight: 0.25, structuredWeight: 0.75, signals };
}
