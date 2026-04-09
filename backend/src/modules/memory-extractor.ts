import { extractEntities } from "./entity-extractor.js";

export type MemoryType = "preference" | "constraint" | "fact" | "goal" | "override";
export type MemoryScope = "global" | "trip";

export interface MemoryCandidate {
  key: string;
  type: MemoryType;
  value: string;
  scope: MemoryScope;
  tripId?: string;
  confidence: number;
  authority: "explicit" | "inferred";
  domain?: string;
}

interface ExtractionRule {
  patterns: RegExp[];
  type: MemoryType;
  confidence: number;
  domain?: string;
}

// ---------------------------------------------------------------------------
// Extraction rules - ordered by priority (first match wins per sentence)
// ---------------------------------------------------------------------------

const EXTRACTION_RULES: ExtractionRule[] = [
  // Overrides (highest priority - user is changing something)
  {
    patterns: [
      /\b(?:instead|actually|changed my mind|override|no longer|not anymore|switch(?:ed)? to|forget what I said|scratch that|disregard|cancel that)\b/i,
    ],
    type: "override",
    confidence: 0.9,
  },

  // Constraints (hard limits across any domain)
  {
    patterns: [
      /\b(?:budget|under|max|limit|cap|no more than|at most|ceiling|maximum|minimum|at least|no fewer|must not|cannot|can't|must have|require|need to have|deadline|due by|expires?)\b/i,
    ],
    type: "constraint",
    confidence: 0.85,
  },

  // Goals - Travel
  {
    patterns: [
      /\b(?:plan|book|trip|visit|travel to|go to|fly to|heading to|destination|vacation|getaway|journey)\b/i,
    ],
    type: "goal",
    confidence: 0.75,
    domain: "travel",
  },

  // Goals - Coding / Tech
  {
    patterns: [
      /\b(?:build|develop|implement|create|deploy|ship|launch|migrate|refactor|debug|automate|set up|integrate)\b/i,
    ],
    type: "goal",
    confidence: 0.7,
    domain: "coding",
  },

  // Goals - Work / Professional
  {
    patterns: [
      /\b(?:finish|complete|deliver|submit|present|publish|hire|onboard|promote)\b/i,
    ],
    type: "goal",
    confidence: 0.7,
    domain: "work",
  },

  // Goals - Learning
  {
    patterns: [
      /\b(?:learn|study|practice|master|understand|prepare for|take a course|certification|exam)\b/i,
    ],
    type: "goal",
    confidence: 0.7,
    domain: "learning",
  },

  // Preferences (across all domains)
  {
    patterns: [
      /\b(?:prefer|preference|like|want|always|love|enjoy|favor|rather|usually|tend to|my go-to|my favorite|my style)\b/i,
    ],
    type: "preference",
    confidence: 0.8,
  },

  // Facts - Personal identity
  {
    patterns: [
      /\b(?:I am|my name is|I live|I have|I work|I'm a|I speak|my (?:email|phone|age|birthday)|I was born|my address)\b/i,
    ],
    type: "fact",
    confidence: 0.85,
    domain: "personal",
  },

  // Facts - Coding / Tech
  {
    patterns: [
      /\b(?:I (?:use|code in|develop (?:in|with)|program in)|my (?:stack|editor|IDE|setup|environment|framework|database|OS|operating system)|we use|our (?:stack|codebase|repo|infrastructure))\b/i,
    ],
    type: "fact",
    confidence: 0.85,
    domain: "coding",
  },

  // Facts - Work / Professional
  {
    patterns: [
      /\b(?:I work (?:at|for)|my (?:role|title|team|company|manager|department|position)|my job|my salary|I report to|I manage|my direct reports)\b/i,
    ],
    type: "fact",
    confidence: 0.85,
    domain: "work",
  },

  // Facts - Health / Dietary
  {
    patterns: [
      /\b(?:I'm (?:allergic|intolerant|diabetic|vegan|vegetarian|lactose)|I (?:don't|can't) eat|dietary|my (?:allergy|allergies|condition|medication|doctor)|gluten.free|nut.free)\b/i,
    ],
    type: "fact",
    confidence: 0.85,
    domain: "health",
  },

  // Facts - Finance
  {
    patterns: [
      /\b(?:my (?:income|salary|savings|investments|portfolio|bank|credit)|I (?:earn|save|invest|owe)|my (?:monthly|annual) (?:income|expenses|rent))\b/i,
    ],
    type: "fact",
    confidence: 0.85,
    domain: "finance",
  },

  // Facts - Communication / Schedule
  {
    patterns: [
      /\b(?:my timezone|I'm (?:in|based in|located in)|my (?:schedule|availability|hours|calendar)|I'm available|I'm (?:free|busy) (?:on|at|from|until))\b/i,
    ],
    type: "fact",
    confidence: 0.8,
    domain: "communication",
  },

  // Facts - Writing style
  {
    patterns: [
      /\b(?:my (?:writing|tone|voice|style) is|I write (?:in|with)|I (?:don't )?use (?:em dashes|oxford comma|semicolons)|keep it (?:casual|formal|simple|brief|short))\b/i,
    ],
    type: "fact",
    confidence: 0.8,
    domain: "writing",
  },
];

// ---------------------------------------------------------------------------
// Scope detection
// ---------------------------------------------------------------------------

const TRIP_SCOPE_PATTERNS = [
  /\b(?:for this trip|this time|just for now|on this trip|this booking|this reservation)\b/i,
];

// These patterns detect project/session scope but still map to "trip" in the DB
// since the schema currently only supports global/trip. The domain tag preserves context.
const PROJECT_SCOPE_PATTERNS = [
  /\b(?:for this project|in this repo|in this codebase|for this feature|for this task|this sprint)\b/i,
];

function detectScope(text: string): MemoryScope {
  for (const pattern of TRIP_SCOPE_PATTERNS) {
    if (pattern.test(text)) return "trip";
  }
  for (const pattern of PROJECT_SCOPE_PATTERNS) {
    if (pattern.test(text)) return "trip"; // maps to trip scope until schema supports more
  }
  return "global";
}

// ---------------------------------------------------------------------------
// Key extraction
// ---------------------------------------------------------------------------

// Domain-specific key extraction patterns
const KEY_PATTERNS: Array<{ regex: RegExp; suffix: string }> = [
  // Preferences
  { regex: /(?:prefer|like|want|always|love|enjoy|favor|rather|usually|my go-to|my favorite|my style)\s+(.+?)(?:\.|$)/i, suffix: "_preference" },
  // Constraints
  { regex: /(?:budget|under|max|limit|cap|no more than|at most|maximum|minimum|at least|deadline|due by)\s+(.+?)(?:\.|$)/i, suffix: "_constraint" },
  // Goals - travel
  { regex: /(?:plan|book|trip|visit|travel to|go to|fly to)\s+(.+?)(?:\.|$)/i, suffix: "_goal" },
  // Goals - coding
  { regex: /(?:build|develop|implement|create|deploy|ship|launch|migrate|refactor)\s+(.+?)(?:\.|$)/i, suffix: "_goal" },
  // Goals - work
  { regex: /(?:finish|complete|deliver|submit|present|publish)\s+(.+?)(?:\.|$)/i, suffix: "_goal" },
  // Goals - learning
  { regex: /(?:learn|study|practice|master|understand|prepare for)\s+(.+?)(?:\.|$)/i, suffix: "_goal" },
  // Facts - personal
  { regex: /(?:I am|my name is|I live|I have|I work|I'm a)\s+(.+?)(?:\.|$)/i, suffix: "_fact" },
  // Facts - coding
  { regex: /(?:I (?:use|code in|develop (?:in|with)|program in))\s+(.+?)(?:\.|$)/i, suffix: "_fact" },
  { regex: /(?:my (?:stack|editor|IDE|setup|framework|database|OS))\s+(?:is\s+)?(.+?)(?:\.|$)/i, suffix: "_fact" },
  // Facts - work
  { regex: /(?:I work (?:at|for))\s+(.+?)(?:\.|$)/i, suffix: "_fact" },
  { regex: /(?:my (?:role|title|team|company|manager|department))\s+(?:is\s+)?(.+?)(?:\.|$)/i, suffix: "_fact" },
  // Facts - health
  { regex: /(?:I'm (?:allergic|intolerant|diabetic|vegan|vegetarian))\s*(?:to\s+)?(.+?)(?:\.|$)/i, suffix: "_fact" },
  { regex: /(?:I (?:don't|can't) eat)\s+(.+?)(?:\.|$)/i, suffix: "_restriction" },
  // Overrides
  { regex: /(?:instead|actually|changed my mind|override|switch(?:ed)? to)\s*,?\s*(.+?)(?:\.|$)/i, suffix: "_override" },
  // Writing
  { regex: /(?:my (?:writing|tone|voice|style))\s+(?:is\s+)?(.+?)(?:\.|$)/i, suffix: "_style" },
];

function extractKey(text: string, type: MemoryType): string {
  for (const { regex, suffix } of KEY_PATTERNS) {
    const match = text.match(regex);
    if (match && match[1]) {
      return toSnakeCase(match[1].trim().slice(0, 40)) + suffix;
    }
  }

  // Fallback: use first few meaningful words
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
  const words = cleaned.split(/\s+/).slice(0, 4).join("_");
  return words || "unknown";
}

function toSnakeCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 50);
}

function extractValue(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Splits input text into individual sentences for per-sentence extraction.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

// ---------------------------------------------------------------------------
// Domain detection from text
// ---------------------------------------------------------------------------

const DOMAIN_KEYWORDS: Record<string, RegExp> = {
  travel: /\b(?:trip|travel|flight|hotel|book|destination|airport|airline|seat|vacation|resort|cruise|passport|visa|luggage)\b/i,
  coding: /\b(?:code|programming|developer|software|api|database|frontend|backend|deploy|git|repo|debug|compile|framework|library|npm|pip)\b/i,
  work: /\b(?:meeting|project|deadline|client|presentation|report|team|manager|stakeholder|sprint|roadmap|quarterly)\b/i,
  health: /\b(?:allergy|diet|vegetarian|vegan|exercise|medication|doctor|health|fitness|calories|weight|sleep)\b/i,
  finance: /\b(?:budget|salary|invest|savings|expense|income|tax|portfolio|stocks|crypto|retirement|loan)\b/i,
  learning: /\b(?:study|course|exam|tutorial|homework|lecture|certification|skill|lesson|training)\b/i,
  writing: /\b(?:writing|tone|voice|style|essay|article|blog|draft|edit|proofread|grammar|format)\b/i,
};

function detectDomainFromText(text: string): string | undefined {
  for (const [domain, regex] of Object.entries(DOMAIN_KEYWORDS)) {
    if (regex.test(text)) return domain;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Parses user text to extract structured memory candidates using rule-based
 * keyword pattern matching. Returns an array of candidates without saving to DB.
 *
 * Works across multiple domains: travel, coding, work, health, finance,
 * learning, writing, communication, and general personal facts.
 */
export async function extractMemory(
  text: string,
  eventId: string,
  tripId?: string
): Promise<MemoryCandidate[]> {
  const candidates: MemoryCandidate[] = [];
  const sentences = splitSentences(text);

  for (const sentence of sentences) {
    for (const rule of EXTRACTION_RULES) {
      const matched = rule.patterns.some((p) => p.test(sentence));
      if (!matched) continue;

      const detectedScope = detectScope(sentence);
      // Fall back to global if "this trip" was detected but no tripId is set,
      // otherwise the item would be orphaned (scope=trip, trip_id=null) and
      // never retrieved by the context compiler.
      const scope: MemoryScope =
        detectedScope === "trip" && !tripId ? "global" : detectedScope;
      const resolvedTripId = scope === "trip" ? tripId : undefined;

      // Detect domain from the sentence or use the rule's domain
      const domain = rule.domain || detectDomainFromText(sentence);

      const candidate: MemoryCandidate = {
        key: extractKey(sentence, rule.type),
        type: rule.type,
        value: extractValue(sentence),
        scope,
        tripId: resolvedTripId,
        confidence: rule.confidence,
        authority: rule.confidence >= 0.8 ? "explicit" : "inferred",
        domain,
      };

      // Avoid duplicate keys within same extraction pass
      const isDuplicate = candidates.some(
        (c) => c.key === candidate.key && c.value === candidate.value
      );
      if (!isDuplicate) {
        candidates.push(candidate);
      }

      // Only match the first (highest priority) rule per sentence
      break;
    }
  }

  // Entity pass: pull out structured entities and promote them to facts/goals/constraints
  const entities = extractEntities(text);
  const entityScope = tripId ? "trip" : "global";
  for (const entity of entities) {
    let entityType: MemoryType;
    let key: string;
    let domain: string | undefined;

    switch (entity.type) {
      case "destination":
        entityType = "goal";
        key = `destination_${toSnakeCase(entity.normalized)}`;
        domain = "travel";
        break;
      case "date":
        entityType = "fact";
        key = `date_${entity.normalized}`;
        break;
      case "amount":
        entityType = "constraint";
        key = `budget_${entity.normalized.replace(/\s+/g, "_")}`;
        domain = "finance";
        break;
      case "duration":
        entityType = "fact";
        key = `duration_${entity.normalized.replace(/\s+/g, "_")}`;
        break;
      case "technology":
        entityType = "fact";
        key = `tech_${toSnakeCase(entity.normalized)}`;
        domain = "coding";
        break;
      case "language":
        entityType = "fact";
        key = `language_${toSnakeCase(entity.normalized)}`;
        domain = "coding";
        break;
      default:
        continue;
    }

    const candidate: MemoryCandidate = {
      key,
      type: entityType,
      value: entity.normalized,
      scope: entityScope,
      tripId: entityScope === "trip" ? tripId : undefined,
      confidence: 0.88,
      authority: "explicit",
      domain,
    };

    const isDuplicate = candidates.some(
      (c) => c.key === candidate.key && c.value === candidate.value
    );
    if (!isDuplicate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}
