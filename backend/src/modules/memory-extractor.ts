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
}

interface ExtractionRule {
  patterns: RegExp[];
  type: MemoryType;
  confidence: number;
}

const EXTRACTION_RULES: ExtractionRule[] = [
  {
    patterns: [
      /\b(?:instead|actually|changed my mind|override|no longer|not anymore|switch(?:ed)? to)\b/i,
    ],
    type: "override",
    confidence: 0.9,
  },
  {
    patterns: [
      /\b(?:budget|under|max|limit|cap|no more than|at most|ceiling|maximum)\b/i,
    ],
    type: "constraint",
    confidence: 0.85,
  },
  {
    patterns: [
      /\b(?:plan|book|trip|visit|travel to|go to|fly to|heading to|destination)\b/i,
    ],
    type: "goal",
    confidence: 0.75,
  },
  {
    patterns: [
      /\b(?:prefer|preference|like|want|always|love|enjoy|favor|rather)\b/i,
    ],
    type: "preference",
    confidence: 0.8,
  },
  {
    patterns: [
      /\b(?:I am|my name is|I live|I have|I work|I'm a|I speak|my (?:email|phone|age))\b/i,
    ],
    type: "fact",
    confidence: 0.85,
  },
];

const TRIP_SCOPE_PATTERNS = [
  /\b(?:for this trip|this time|just for now|on this trip|this booking|this reservation)\b/i,
];

function detectScope(text: string): MemoryScope {
  for (const pattern of TRIP_SCOPE_PATTERNS) {
    if (pattern.test(text)) return "trip";
  }
  return "global";
}

function extractKey(text: string, type: MemoryType): string {
  // Generate a snake_case key from the text
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();

  // Try to extract a meaningful key based on type
  switch (type) {
    case "preference": {
      const prefMatch = text.match(
        /(?:prefer|like|want|always|love|enjoy|favor|rather)\s+(.+?)(?:\.|$)/i
      );
      if (prefMatch) {
        return toSnakeCase(prefMatch[1].trim().slice(0, 40)) + "_preference";
      }
      break;
    }
    case "constraint": {
      const constMatch = text.match(
        /(?:budget|under|max|limit|cap|no more than|at most|maximum)\s+(.+?)(?:\.|$)/i
      );
      if (constMatch) {
        return toSnakeCase(constMatch[1].trim().slice(0, 40)) + "_constraint";
      }
      break;
    }
    case "goal": {
      const goalMatch = text.match(
        /(?:plan|book|trip|visit|travel to|go to|fly to)\s+(.+?)(?:\.|$)/i
      );
      if (goalMatch) {
        return toSnakeCase(goalMatch[1].trim().slice(0, 40)) + "_goal";
      }
      break;
    }
    case "fact": {
      const factMatch = text.match(
        /(?:I am|my name is|I live|I have|I work|I'm a)\s+(.+?)(?:\.|$)/i
      );
      if (factMatch) {
        return toSnakeCase(factMatch[1].trim().slice(0, 40)) + "_fact";
      }
      break;
    }
    case "override": {
      const overrideMatch = text.match(
        /(?:instead|actually|changed my mind|override|switch(?:ed)? to)\s*,?\s*(.+?)(?:\.|$)/i
      );
      if (overrideMatch) {
        return toSnakeCase(overrideMatch[1].trim().slice(0, 40)) + "_override";
      }
      break;
    }
  }

  // Fallback: use first few meaningful words
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
  // Return a cleaned version of the text as the value
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

/**
 * Parses user text to extract structured memory candidates using rule-based
 * keyword pattern matching. Returns an array of candidates without saving to DB.
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

      const scope = detectScope(sentence);
      const resolvedTripId = scope === "trip" ? tripId : undefined;

      const candidate: MemoryCandidate = {
        key: extractKey(sentence, rule.type),
        type: rule.type,
        value: extractValue(sentence),
        scope,
        tripId: resolvedTripId,
        confidence: rule.confidence,
        authority: rule.confidence >= 0.8 ? "explicit" : "inferred",
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
    switch (entity.type) {
      case "destination":
        entityType = "goal";
        key = `destination_${toSnakeCase(entity.normalized)}`;
        break;
      case "date":
        entityType = "fact";
        key = `date_${entity.normalized}`;
        break;
      case "amount":
        entityType = "constraint";
        key = `budget_${entity.normalized.replace(/\s+/g, "_")}`;
        break;
      case "duration":
        entityType = "fact";
        key = `duration_${entity.normalized.replace(/\s+/g, "_")}`;
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
