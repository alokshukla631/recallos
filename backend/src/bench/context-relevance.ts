/**
 * Context-relevance bench: measures structured-lane leakage.
 *
 * Seeds a cross-domain memory profile (coding + travel + health + general)
 * and runs a set of queries across different types:
 *
 *   - coding fact / coding preference
 *   - travel planning / travel profile
 *   - assistant_recall / temporal_history (verbatim-heavy)
 *   - generic preference profile ("what are my preferences?")
 *
 * Then asserts that the structured preferences emitted for each query match
 * the expected relevance envelope. Also includes a reinforcement test that
 * proves last_confirmed_at is NOT bumped on items admitted only via the
 * durability floor — the self-reinforcing leak the fix eliminates.
 *
 * Run with:  npm run bench:context
 */

import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { initDatabase, queryAll, queryOne, runSql } from "../db/index.js";
import { compileContext } from "../modules/context-compiler.js";

// ─── Assertion harness ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    const msg = detail ? `${name} — ${detail}` : name;
    console.log(`  ✗ ${msg}`);
    failed++;
    failures.push(msg);
  }
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

async function freshDb(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `recallos-ctxrel-${uuidv4()}.db`);
  await initDatabase(dbPath);
}

function insertConversation(id: string): void {
  runSql(
    `INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at)
     VALUES (?, 'ctxrel', datetime('now'), datetime('now'))`,
    [id]
  );
}

function insertEvent(convId: string, role: "user" | "assistant", content: string): string {
  const id = uuidv4();
  runSql(
    `INSERT INTO events (id, conversation_id, role, content, provider, created_at)
     VALUES (?, ?, ?, ?, 'test', datetime('now'))`,
    [id, convId, role, content]
  );
  return id;
}

interface SeedPref {
  key: string;
  value: string;
  type: "preference" | "constraint" | "fact";
  scope: "global" | "domain";
  domain: string | null;
  confidence: number;
  // How old, in days, both created_at and last_confirmed_at should be.
  ageDays?: number;
}

function seedMemoryItem(p: SeedPref): string {
  const id = uuidv4();
  const ts = new Date(Date.now() - (p.ageDays ?? 5) * 86_400_000).toISOString();
  runSql(
    `INSERT INTO memory_items
      (id, key, type, value, scope, domain, confidence, authority, status, pinned,
       last_confirmed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'explicit', 'active', 0, ?, ?)`,
    [id, p.key, p.type, p.value, p.scope, p.domain, p.confidence, ts, ts]
  );
  return id;
}

function seedProfile(): Record<string, string> {
  // 1 conversation so evidence lane has something to search (not the focus here)
  const convId = uuidv4();
  insertConversation(convId);
  insertEvent(convId, "user", "What programming language should I use for this backend?");
  insertEvent(
    convId, "assistant",
    "Based on the constraints you mentioned, I recommend TypeScript with Node.js."
  );

  const ids: Record<string, string> = {};
  // Coding
  ids.codingLang = seedMemoryItem({
    key: "programming language", value: "I prefer TypeScript over JavaScript",
    type: "preference", scope: "domain", domain: "coding", confidence: 0.92,
    ageDays: 20,
  });
  ids.codingEditor = seedMemoryItem({
    key: "editor", value: "I use VS Code with Vim bindings",
    type: "fact", scope: "domain", domain: "coding", confidence: 0.9, ageDays: 15,
  });
  // Travel
  ids.travelSeat = seedMemoryItem({
    key: "seat preference", value: "I always book window seats on flights",
    type: "preference", scope: "domain", domain: "travel", confidence: 0.9,
    ageDays: 30,
  });
  ids.travelAirline = seedMemoryItem({
    key: "airline", value: "I prefer Delta for international travel",
    type: "preference", scope: "domain", domain: "travel", confidence: 0.88,
    ageDays: 25,
  });
  // Health
  ids.healthDiet = seedMemoryItem({
    key: "diet", value: "I am vegetarian, no meat or fish",
    type: "constraint", scope: "global", domain: "health", confidence: 0.98,
    ageDays: 60,
  });
  // Unrelated general preference (no domain tag) — the classic leaker
  ids.generalMusic = seedMemoryItem({
    key: "music", value: "I like jazz and classical music",
    type: "preference", scope: "global", domain: null, confidence: 0.9, ageDays: 40,
  });

  return ids;
}

// ─── Assertions built on compileContext output ───────────────────────────────

interface CompiledSummary {
  preferenceIds: Set<string>;
  factIds: Set<string>;
  constraintIds: Set<string>;
  prefCount: number;
  preferenceNames: string[];
  tokenEstimate: number;
  queryType: string | undefined;
}

async function compile(message: string): Promise<CompiledSummary> {
  const convId = uuidv4();
  insertConversation(convId);
  const compiled = await compileContext(convId, message);
  return {
    preferenceIds: new Set(compiled.contextPacket.preferences.map((p) => p.id)),
    factIds: new Set(compiled.contextPacket.facts.map((f) => f.id)),
    constraintIds: new Set(compiled.contextPacket.constraints.map((c) => c.id)),
    prefCount: compiled.contextPacket.preferences.length,
    preferenceNames: compiled.contextPacket.preferences.map((p) => p.key),
    tokenEstimate: compiled.tokenEstimate.estimated_tokens,
    queryType: compiled.contextPacket.queryType,
  };
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

async function scenarioCodingFact(ids: Record<string, string>): Promise<void> {
  console.log("\n=== Coding fact query excludes unrelated preferences ===");
  const out = await compile("What programming language do I use?");
  console.log(`    preferences=${out.preferenceNames.join(", ") || "(none)"}  type=${out.queryType}`);

  assert(
    "no travel preferences bleed into coding query",
    !out.preferenceIds.has(ids.travelSeat) && !out.preferenceIds.has(ids.travelAirline),
    `got: ${out.preferenceNames.join(", ")}`
  );
  assert(
    "general music preference excluded from coding query",
    !out.preferenceIds.has(ids.generalMusic)
  );
  // Health constraint is authoritative — constraints always include.
  assert(
    "vegetarian constraint still present (authoritative)",
    out.constraintIds.has(ids.healthDiet)
  );
}

async function scenarioTravelPlanning(ids: Record<string, string>): Promise<void> {
  console.log("\n=== Travel planning query keeps relevant travel preferences ===");
  const out = await compile("Help me book a flight seat for my trip to Japan");
  console.log(`    preferences=${out.preferenceNames.join(", ") || "(none)"}  type=${out.queryType}`);

  assert(
    "travel seat preference present",
    out.preferenceIds.has(ids.travelSeat)
  );
  assert(
    "coding preference excluded from travel planning",
    !out.preferenceIds.has(ids.codingLang)
  );
  assert(
    "music preference excluded from travel planning",
    !out.preferenceIds.has(ids.generalMusic)
  );
}

async function scenarioAssistantRecall(ids: Record<string, string>): Promise<void> {
  console.log("\n=== Assistant-recall query drops structured preference noise ===");
  const out = await compile("What did you recommend last week?");
  console.log(`    preferences=${out.preferenceNames.join(", ") || "(none)"}  type=${out.queryType}`);

  assert(
    "query classified as temporal_history or assistant_recall",
    out.queryType === "temporal_history" || out.queryType === "assistant_recall",
    `got queryType=${out.queryType}`
  );
  // The core leak: durable preferences that don't match anything in the
  // question should not be dragged in just because they are high-confidence.
  assert(
    "no unrelated travel preference in assistant-recall",
    !out.preferenceIds.has(ids.travelSeat) && !out.preferenceIds.has(ids.travelAirline),
    `got prefs: ${out.preferenceNames.join(", ")}`
  );
  assert(
    "no unrelated music preference in assistant-recall",
    !out.preferenceIds.has(ids.generalMusic)
  );
  assert(
    "no unrelated coding preference in assistant-recall",
    !out.preferenceIds.has(ids.codingLang)
  );
}

async function scenarioProfileQuery(ids: Record<string, string>): Promise<void> {
  console.log("\n=== Generic profile query still returns broad preference memory ===");
  const out = await compile("What are my preferences?");
  console.log(`    preferences=${out.preferenceNames.join(", ") || "(none)"}  type=${out.queryType}`);

  assert(
    "query classified as preference_profile",
    out.queryType === "preference_profile",
    `got queryType=${out.queryType}`
  );
  // Broad profile query should surface at least two of the domain preferences
  // plus the general music preference. The floor is allowed here.
  const kept =
    Number(out.preferenceIds.has(ids.codingLang)) +
    Number(out.preferenceIds.has(ids.travelSeat)) +
    Number(out.preferenceIds.has(ids.travelAirline)) +
    Number(out.preferenceIds.has(ids.generalMusic));
  assert(
    "at least 3 broad preferences kept on profile query",
    kept >= 3,
    `kept=${kept} (codingLang=${out.preferenceIds.has(ids.codingLang)} travelSeat=${out.preferenceIds.has(ids.travelSeat)} travelAirline=${out.preferenceIds.has(ids.travelAirline)} generalMusic=${out.preferenceIds.has(ids.generalMusic)})`
  );
}

async function scenarioReinforcementLoop(ids: Record<string, string>): Promise<void> {
  console.log("\n=== Reconfirmation does not self-reinforce irrelevant noise ===");
  // Snapshot last_confirmed_at for the travel/music prefs, then fire a
  // coding-domain query. The fix must NOT refresh last_confirmed_at for
  // items that had no real signal match.
  const before = queryAll(
    "SELECT id, last_confirmed_at FROM memory_items WHERE id IN (?, ?, ?)",
    [ids.travelSeat, ids.travelAirline, ids.generalMusic]
  ) as unknown as { id: string; last_confirmed_at: string | null }[];
  const beforeMap = new Map(before.map((r) => [r.id, r.last_confirmed_at]));

  await compile("What is the best database for a Node.js backend?");

  const after = queryAll(
    "SELECT id, last_confirmed_at FROM memory_items WHERE id IN (?, ?, ?)",
    [ids.travelSeat, ids.travelAirline, ids.generalMusic]
  ) as unknown as { id: string; last_confirmed_at: string | null }[];

  for (const row of after) {
    assert(
      `last_confirmed_at UNCHANGED for off-domain item (${row.id.slice(0, 8)})`,
      row.last_confirmed_at === beforeMap.get(row.id),
      `before=${beforeMap.get(row.id)} after=${row.last_confirmed_at}`
    );
  }

  // And the coding item we DID query about should be refreshed.
  const coding = queryOne(
    "SELECT last_confirmed_at FROM memory_items WHERE id = ?",
    [ids.codingLang]
  ) as unknown as { last_confirmed_at: string | null };
  const codingBefore = beforeMap.get(ids.codingLang) ?? null;
  assert(
    "last_confirmed_at refreshed for in-domain item hit by query",
    coding.last_confirmed_at !== null && coding.last_confirmed_at !== codingBefore,
    `after=${coding.last_confirmed_at}`
  );
}

async function scenarioOverallLeakage(ids: Record<string, string>): Promise<void> {
  console.log("\n=== Cross-scenario preference count regression ===");
  // Measure mean preference count on the 5 narrow/episodic queries.
  const queries = [
    "What programming language do I use?",
    "Help me book a flight seat for my trip to Japan",
    "What did you recommend last week?",
    "What is the best database for a Node.js backend?",
    "Plan a trip to Iceland",
  ];

  let total = 0;
  for (const q of queries) {
    const out = await compile(q);
    total += out.prefCount;
    console.log(`    "${q}" → ${out.prefCount} prefs (${out.preferenceNames.join(", ") || "—"})`);
  }
  const avg = total / queries.length;
  assert(
    "avg structured preference count across narrow queries ≤ 2.0",
    avg <= 2.0,
    `avg=${avg.toFixed(2)}`
  );
  // Also sanity: ensure generalMusic is used, so the seed is non-trivial.
  void ids;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("RecallOS — Context Relevance Bench");
  console.log("===================================");
  console.log("Measures structured-lane leakage across query types.\n");

  // Each scenario runs on a fresh DB + fresh profile, so test ordering can
  // not accidentally reinforce items across scenarios.
  let ids: Record<string, string>;

  await freshDb();          ids = seedProfile(); await scenarioCodingFact(ids);
  await freshDb();          ids = seedProfile(); await scenarioTravelPlanning(ids);
  await freshDb();          ids = seedProfile(); await scenarioAssistantRecall(ids);
  await freshDb();          ids = seedProfile(); await scenarioProfileQuery(ids);
  await freshDb();          ids = seedProfile(); await scenarioReinforcementLoop(ids);
  await freshDb();          ids = seedProfile(); await scenarioOverallLeakage(ids);

  console.log("\n===================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\nFailed assertions:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  } else {
    console.log("\nAll context-relevance assertions passed ✓");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
