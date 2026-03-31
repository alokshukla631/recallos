import { queryAll } from "../db/index.js";
import type { MemoryItem } from "./memory-reconciler.js";

export interface ContextPacket {
  domain: string;
  goals: MemoryItem[];
  constraints: MemoryItem[];
  preferences: MemoryItem[];
  overrides: MemoryItem[];
  facts: MemoryItem[];
  ambiguities: string[];
}

export interface CompiledContext {
  contextPacket: ContextPacket;
  contextText: string;
  includedIds: string[];
  omittedIds: string[];
  rationale: Record<string, string>;
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

function scoreRelevance(item: MemoryItem, message: string): number {
  const messageWords = new Set(
    message
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );

  const itemWords = `${item.key} ${item.value} ${item.type}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (itemWords.length === 0) return 0;

  let overlap = 0;
  for (const word of itemWords) {
    if (messageWords.has(word)) overlap++;
  }

  return overlap / itemWords.length;
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

function detectDomain(items: MemoryItem[]): string {
  const travelKeywords = /\b(?:trip|travel|flight|hotel|book|destination|airport|airline|seat)\b/i;
  for (const item of items) {
    if (travelKeywords.test(item.value) || travelKeywords.test(item.key)) {
      return "travel";
    }
  }
  return "general";
}

export async function compileContext(
  conversationId: string,
  currentMessage: string,
  tripId?: string
): Promise<CompiledContext> {
  const allItems = getActiveMemoryItems(tripId);

  const scored = allItems.map((item) => ({
    item,
    score: scoreRelevance(item, currentMessage),
  }));

  const RELEVANCE_THRESHOLD = 0.05;
  const included: MemoryItem[] = [];
  const omitted: MemoryItem[] = [];
  const rationale: Record<string, string> = {};

  for (const { item, score } of scored) {
    const alwaysInclude = item.type === "override" || item.type === "constraint";
    if (score >= RELEVANCE_THRESHOLD || alwaysInclude) {
      included.push(item);
      rationale[item.id] = `Included: score=${score.toFixed(2)}, type=${item.type}`;
    } else {
      omitted.push(item);
      rationale[item.id] = `Omitted: score=${score.toFixed(2)}, below threshold`;
    }
  }

  const groups = groupByCategory(included);
  const domain = detectDomain(allItems);

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
    goals: groups.goal,
    constraints: groups.constraint,
    preferences: groups.preference,
    overrides: groups.override,
    facts: groups.fact,
    ambiguities,
  };

  const lines = [
    "User context for this request:",
    `- Domain: ${domain}`,
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
  };
}
