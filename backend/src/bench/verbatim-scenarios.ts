/**
 * Verbatim retrieval bench scenarios.
 *
 * Tests the evidence lane of the hybrid memory system end-to-end:
 *   - assistant recall retrieval
 *   - subtle preference retrieval via preference-evidence boost
 *   - temporal proximity ranking
 *   - query classifier output correctness
 *   - structured override beats old verbatim evidence
 *   - noisy-history: relevant needle in irrelevant haystack
 *   - mixed retrieval (structured + verbatim both needed)
 *
 * Run with: npm run bench:verbatim (from the backend directory).
 *
 * Each case:
 *   1. Resets an in-memory SQLite database
 *   2. Inserts test events at specific (possibly simulated) timestamps
 *   3. Calls searchVerbatim() and/or classifyQuery()
 *   4. Asserts expected outcomes
 */

import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { initDatabase, runSql } from "../db/index.js";
import { classifyQuery } from "../modules/query-classifier.js";
import { searchVerbatim } from "../modules/verbatim-retriever.js";
import { cosineSimilarity, semanticBoostFor } from "../modules/embedding-store.js";
import { storeEvent } from "../modules/event-store.js";
import { extractMemory } from "../modules/memory-extractor.js";
import { reconcileMemory } from "../modules/memory-reconciler.js";
import { compileContext } from "../modules/context-compiler.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Insert a raw event row at a specific timestamp (for time-travel testing). */
function insertEventAt(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  daysAgo: number,
  projectId?: string
): string {
  const id        = uuidv4();
  const timestamp = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  runSql(
    `INSERT INTO events (id, conversation_id, project_id, role, content, provider, created_at)
     VALUES (?, ?, ?, ?, ?, 'bench', ?)`,
    [id, conversationId, projectId ?? null, role, content, timestamp]
  );
  return id;
}

/** Insert a conversation row (needed for FK constraints). */
function insertConversation(conversationId: string): void {
  runSql(
    `INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at)
     VALUES (?, 'bench-conv', datetime('now'), datetime('now'))`,
    [conversationId]
  );
}

let passed  = 0;
let failed  = 0;
const failures: string[] = [];

function assert(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? `: ${detail}` : ""}`);
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─── Test cases ───────────────────────────────────────────────────────────────

async function testQueryClassifier(): Promise<void> {
  console.log("\n=== Query Classifier ===");

  const cases: Array<{
    query: string;
    expectedType: string;
    expectTemporal?: boolean;
    desc: string;
  }> = [
    {
      query: "what did you recommend for my laptop?",
      expectedType: "assistant_recall",
      desc: "explicit assistant recommendation recall",
    },
    {
      query: "remind me what you said about seat preferences",
      expectedType: "assistant_recall",
      desc: "remind me phrasing",
    },
    {
      query: "what did you suggest last week?",
      expectedType: "temporal_history",
      expectTemporal: true,
      desc: "assistant recall + temporal anchor",
    },
    {
      query: "what do I usually prefer for hotel rooms?",
      expectedType: "preference_profile",
      desc: "preference profile query",
    },
    {
      query: "when did I last mention my dietary restrictions?",
      expectedType: "episodic_search",
      desc: "episodic search (when did I)",
    },
    {
      query: "what happened last month with my project?",
      expectedType: "temporal_history",
      expectTemporal: true,
      desc: "pure temporal query",
    },
    {
      query: "help me plan my next trip to Japan",
      expectedType: "planning",
      desc: "planning query",
    },
    {
      query: "what is the capital of France?",
      expectedType: "balanced",
      desc: "general knowledge (balanced)",
    },
    {
      query: "recently what have we discussed about budgets?",
      expectedType: "temporal_history",
      expectTemporal: true,
      desc: "recently = temporal",
    },
  ];

  for (const tc of cases) {
    const result = classifyQuery(tc.query);
    assert(
      `type for "${tc.desc}"`,
      result.type === tc.expectedType,
      `got ${result.type}, want ${tc.expectedType}`
    );
    if (tc.expectTemporal !== undefined) {
      assert(
        `temporal anchor for "${tc.desc}"`,
        tc.expectTemporal ? result.temporalAnchor !== undefined : result.temporalAnchor === undefined,
        tc.expectTemporal ? "expected anchor, got none" : "expected no anchor, got one"
      );
    }
  }
}

async function testAssistantRecall(dbFile: string): Promise<void> {
  console.log("\n=== Assistant Recall Retrieval ===");

  await initDatabase(dbFile);

  // Put historical events in a PAST conversation so the current query
  // conversation can exclude itself without hiding the history.
  const pastConv    = uuidv4();
  const currentConv = uuidv4();
  insertConversation(pastConv);
  insertConversation(currentConv);

  // Irrelevant turns in past conversation
  insertEventAt(pastConv, "user",      "I'm planning a trip to Tokyo.",                   8);
  insertEventAt(pastConv, "assistant", "Great choice! Tokyo is wonderful.",                8);
  // Relevant turns: user asks about laptop, assistant recommends MacBook Pro
  insertEventAt(pastConv, "user",      "Which laptop should I get for software development?", 5);
  insertEventAt(pastConv, "assistant", "I recommend the MacBook Pro M3 — excellent for development workflows and battery life.", 5);
  // More irrelevant turns
  insertEventAt(pastConv, "user",      "Any good restaurant recommendations in Shibuya?", 3);
  insertEventAt(pastConv, "assistant", "Try Ichiran ramen or a sushi counter in Tsukiji.", 3);

  const snippets = await searchVerbatim("which laptop did you recommend for development?", {
    isAssistantQuery:      true,
    maxResults:            3,
    excludeConversationId: currentConv,  // exclude current conv, keep past
  });

  assert(
    "returns at least one snippet",
    snippets.length >= 1
  );
  if (snippets.length > 0) {
    // MacBook Pro should appear in top result (assistant turn or its context window)
    const hasMacBook = snippets.some(
      (s) =>
        s.content.toLowerCase().includes("macbook") ||
        s.context_window.toLowerCase().includes("macbook")
    );
    assert(
      "a top-3 snippet mentions MacBook Pro",
      hasMacBook,
      `top content: "${snippets[0].content.slice(0, 80)}"`
    );
    // The top-ranked assistant snippet should have a positive role_boost
    const assistantSnip = snippets.find((s) => s.role === "assistant");
    assert(
      "at least one assistant snippet returned",
      assistantSnip !== undefined,
      `roles returned: ${snippets.map(s => s.role).join(", ")}`
    );
    if (assistantSnip) {
      assert(
        "role_boost is positive for assistant snippet",
        assistantSnip.role_boost > 0,
        `role_boost=${assistantSnip.role_boost}`
      );
    }
  }
}

async function testPreferenceEvidenceBoost(dbFile: string): Promise<void> {
  console.log("\n=== Preference Evidence Boost ===");

  await initDatabase(dbFile);

  const convId = uuidv4();
  insertConversation(convId);
  // Events with neutral content
  insertEventAt(convId, "user",      "Let's book a flight to Paris.",                   10);
  insertEventAt(convId, "assistant", "I can help with that. Any date in mind?",          10);
  insertEventAt(convId, "user",      "Probably early July.",                             9);
  // Event with preference language — should get preference boost
  insertEventAt(convId, "user",      "I always prefer window seats on long-haul flights — I like watching the clouds.", 8);
  insertEventAt(convId, "assistant", "Noted! I'll keep window seats in mind for your flights.", 8);
  // More neutral
  insertEventAt(convId, "user",      "What's the visa situation for France?",            7);
  insertEventAt(convId, "assistant", "US citizens get 90 days in the Schengen zone.",    7);

  const snippets = await searchVerbatim("what kind of seat do I like on flights?", {
    maxResults: 5,
  });

  assert(
    "returns at least one snippet",
    snippets.length >= 1
  );

  // The preference-language event should appear in the results with pref boost
  const prefSnippet = snippets.find((s) =>
    s.content.toLowerCase().includes("window seats")
  );
  assert(
    "preference event appears in results",
    prefSnippet !== undefined
  );
  if (prefSnippet) {
    assert(
      "preference_boost is positive",
      prefSnippet.preference_boost > 0,
      `preference_boost=${prefSnippet.preference_boost}`
    );
  }
}

async function testTemporalProximityBoost(dbFile: string): Promise<void> {
  console.log("\n=== Temporal Proximity Boost ===");

  await initDatabase(dbFile);

  const convId = uuidv4();
  insertConversation(convId);
  // Old event about budgets (30 days ago)
  insertEventAt(convId, "user",      "My budget for the Japan trip is $3000.",           30);
  // Recent event about budgets (5 days ago) — should score higher with "last week" anchor
  insertEventAt(convId, "user",      "I updated my budget to $4000 for the Japan trip.", 5);
  // Unrelated recent event
  insertEventAt(convId, "user",      "What's a good ramen restaurant in Tokyo?",         2);

  // Simulate a temporal query: "what did I say last week about budget?"
  const classification = classifyQuery("what did I say last week about my budget?");
  assert(
    "query classified as temporal_history",
    classification.type === "temporal_history"
  );
  assert("temporal anchor is set", classification.temporalAnchor !== undefined);

  const snippets = await searchVerbatim("budget Japan trip", {
    maxResults: 3,
    temporalAnchor: classification.temporalAnchor,
  });

  assert("returns at least one snippet", snippets.length >= 1);

  if (snippets.length >= 1) {
    // The 5-days-ago event should be closer to the "last week" anchor (7 days ago)
    // than the 30-days-ago event
    const recentBudget = snippets.find((s) => s.content.includes("$4000"));
    const oldBudget    = snippets.find((s) => s.content.includes("$3000"));

    assert(
      "recent budget event is present",
      recentBudget !== undefined
    );

    if (recentBudget && oldBudget) {
      assert(
        "recent event has higher temporal boost than old event",
        recentBudget.temporal_boost >= oldBudget.temporal_boost,
        `recent=${recentBudget.temporal_boost.toFixed(3)}, old=${oldBudget.temporal_boost.toFixed(3)}`
      );
    }
  }
}

async function testNoisyHistory(dbFile: string): Promise<void> {
  console.log("\n=== Noisy History (Signal in Noise) ===");

  await initDatabase(dbFile);

  const convA = uuidv4();
  const convB = uuidv4();
  const convC = uuidv4();
  insertConversation(convA);
  insertConversation(convB);
  insertConversation(convC);

  // Lots of irrelevant travel noise
  for (let d = 1; d <= 10; d++) {
    insertEventAt(convA, "user",      `Day ${d}: planning itinerary for Tokyo trip.`,   d);
    insertEventAt(convA, "assistant", `Here are some Tokyo spots for day ${d}.`,        d);
  }

  // One clearly relevant event about Postgres deep in another conversation
  insertEventAt(convB, "user",      "I've been using Postgres for all my projects. I find it more reliable than MySQL.", 15);
  insertEventAt(convB, "assistant", "Good choice — Postgres has excellent JSONB support and ACID compliance.", 15);

  // Unrelated cooking conversation
  insertEventAt(convC, "user",      "I want to learn how to make ramen at home.",       6);
  insertEventAt(convC, "assistant", "Start with a tonkotsu broth base.",                6);

  const snippets = await searchVerbatim(
    "what database do I prefer for my development projects?",
    { maxResults: 5 }
  );

  assert("returns at least one snippet", snippets.length >= 1);

  const pgSnippet = snippets.find((s) =>
    s.content.toLowerCase().includes("postgres")
  );
  assert(
    "Postgres snippet is returned despite noise",
    pgSnippet !== undefined,
    `top snippet: "${snippets[0]?.content?.slice(0, 60) ?? "(none)"}"`
  );
  if (pgSnippet && snippets.length > 0) {
    assert(
      "Postgres snippet is in top 3 results",
      snippets.indexOf(pgSnippet) < 3,
      `rank=${snippets.indexOf(pgSnippet)}`
    );
  }
}

async function testStructuredOverrideBeat(dbFile: string): Promise<void> {
  console.log("\n=== Structured Override Beats Old Verbatim ===");

  await initDatabase(dbFile);

  // Simulate: user said they prefer window seats in the past (verbatim event),
  // but later explicitly set an override in structured memory for aisle seats.
  const convId = uuidv4();
  insertConversation(convId);
  insertEventAt(convId, "user", "I used to prefer window seats on all flights.", 20);

  // Add a structured override via the full pipeline
  const eventId = uuidv4();
  const now     = new Date().toISOString();
  runSql(
    `INSERT INTO events (id, conversation_id, role, content, provider, created_at)
     VALUES (?, ?, 'user', 'For all future flights, I want aisle seats only.', 'bench', ?)`,
    [eventId, convId, now]
  );
  const candidates = await extractMemory(
    "For all future flights, I want aisle seats only.",
    eventId
  );
  await reconcileMemory(candidates, eventId);

  // Compile context for a seat-preference question
  const compiled = await compileContext(convId, "which seat should I pick?");

  // Structured context must mention aisle (via memory item or verbatim)
  assert(
    "structured context includes aisle preference",
    compiled.contextText.toLowerCase().includes("aisle"),
    `context preview: "${compiled.contextText.slice(0, 200)}"`
  );

  // If verbatim snippets are present for window seats, structured must still win
  // (structured memory is the authority — the override row is active)
  const overrideItems = compiled.contextPacket.overrides;
  const preferenceItems = compiled.contextPacket.preferences;
  const hasAisle =
    overrideItems.some((i) => i.value.toLowerCase().includes("aisle")) ||
    preferenceItems.some((i) => i.value.toLowerCase().includes("aisle"));

  assert(
    "aisle preference/override exists in structured memory",
    hasAisle,
    `overrides: ${overrideItems.map((i) => i.value).join(", ")}` +
    ` | prefs: ${preferenceItems.map((i) => i.value).join(", ")}`
  );
}

async function testMixedRetrieval(dbFile: string): Promise<void> {
  console.log("\n=== Mixed Retrieval (Structured + Verbatim) ===");

  await initDatabase(dbFile);

  // Historical conversation (past — verbatim evidence lives here)
  const pastConv    = uuidv4();
  const currentConv = uuidv4();
  insertConversation(pastConv);
  insertConversation(currentConv);

  // Store a durable structured preference via the full pipeline
  const prefEventId = uuidv4();
  const prefTs      = new Date(Date.now() - 10 * 86400000).toISOString();
  runSql(
    `INSERT INTO events (id, conversation_id, role, content, provider, created_at)
     VALUES (?, ?, 'user', 'I prefer vegetarian options for all my meals.', 'bench', ?)`,
    [prefEventId, pastConv, prefTs]
  );
  const candidates = await extractMemory("I prefer vegetarian options for all my meals.", prefEventId);
  await reconcileMemory(candidates, prefEventId);

  // Also add verbatim episodic turns in the PAST conversation
  insertEventAt(
    pastConv, "user",
    "When I visited that Italian place, I had the mushroom risotto — absolutely loved it. I always prefer vegetarian dishes.",
    7
  );
  insertEventAt(
    pastConv, "assistant",
    "The mushroom risotto at vegetarian-friendly Italian restaurants is often excellent.",
    7
  );

  // Compile context for a NEW (current) conversation — this excludes currentConv
  // but still searches pastConv events via verbatim retrieval
  const compiled = await compileContext(currentConv, "what kind of food do I usually eat?");

  assert(
    "query classified as preference_profile or balanced",
    ["preference_profile", "balanced", "planning"].includes(compiled.queryClassification?.type ?? ""),
    `got: ${compiled.queryClassification?.type}`
  );

  assert(
    "structured vegetarian preference is in context",
    compiled.contextText.toLowerCase().includes("vegetarian"),
    `context: "${compiled.contextText.slice(0, 200)}"`
  );

  // The pastConv verbatim events should appear since they are NOT excluded
  const hasVerbatim =
    compiled.verbatimTrace !== undefined &&
    compiled.verbatimTrace.length > 0;
  assert(
    "verbatim trace has entries from past conversation",
    hasVerbatim,
    `verbatimTrace count: ${compiled.verbatimTrace?.length ?? 0}`
  );
}

async function testQueryClassifierWeights(): Promise<void> {
  console.log("\n=== Query Classifier Weight Contracts ===");

  // Verbatim-heavy queries must have verbatimWeight > 0.7
  const heavyVerbatim = [
    "what did you recommend for my trip?",
    "what did you say last week?",
    "do you remember what I said about my diet?",
  ];
  for (const q of heavyVerbatim) {
    const c = classifyQuery(q);
    assert(
      `verbatimWeight > 0.7 for "${q.slice(0, 40)}"`,
      c.verbatimWeight >= 0.7,
      `got ${c.verbatimWeight}`
    );
  }

  // Structured-heavy queries must have structuredWeight > 0.55
  const heavyStructured = [
    "what do I prefer for hotel rooms?",
    "what is my usual breakfast?",
    "help me plan my next trip",
    "what's the weather in Tokyo?",
  ];
  for (const q of heavyStructured) {
    const c = classifyQuery(q);
    assert(
      `structuredWeight > 0.55 for "${q.slice(0, 40)}"`,
      c.structuredWeight >= 0.55,
      `got ${c.structuredWeight}`
    );
  }

  // Temporal queries must have temporalAnchor
  const temporal = [
    { q: "what did I say yesterday?",       label: "yesterday" },
    { q: "what happened last week?",         label: "last week" },
    { q: "remind me what we discussed recently", label: "recently" },
    { q: "what did you suggest 2 weeks ago?", label: "2 weeks ago" },
  ];
  for (const { q, label } of temporal) {
    const c = classifyQuery(q);
    assert(
      `temporal anchor set for "${label}"`,
      c.temporalAnchor !== undefined,
      `signals: ${c.signals.join(", ")}`
    );
    if (c.temporalAnchor) {
      assert(
        `anchor reference contains "${label}"`,
        c.temporalAnchor.reference.toLowerCase().includes(label.split(" ")[0]),
        `reference: "${c.temporalAnchor.reference}"`
      );
    }
  }
}

/**
 * Phase 2: Semantic scoring — fallback and unit tests.
 *
 * Since the bench runs without a live OpenAI API key, all embeddings
 * will be absent and semantic_score must be 0.  The test verifies:
 *
 *   1. cosineSimilarity() is numerically correct for known vectors.
 *   2. semanticBoostFor() applies the expected threshold and cap.
 *   3. VerbatimSnippet objects always carry semantic_score (no key → 0).
 *   4. Adding the semantic_score field doesn't break final_score ordering.
 */
async function testSemanticScoreFallback(dbFile: string): Promise<void> {
  console.log("\n=== Semantic Score Fallback (no API key) ===");

  await initDatabase(dbFile);

  // ── Unit: cosineSimilarity ──────────────────────────────────────────────────
  const a = [1, 0, 0];
  const b = [0, 1, 0];
  const c = [1, 0, 0];

  assert(
    "cosine([1,0,0], [0,1,0]) = 0 (orthogonal)",
    cosineSimilarity(a, b) === 0,
    `got ${cosineSimilarity(a, b)}`
  );
  assert(
    "cosine([1,0,0], [1,0,0]) = 1 (identical)",
    cosineSimilarity(a, c) === 1,
    `got ${cosineSimilarity(a, c)}`
  );
  assert(
    "cosine of empty vectors = 0",
    cosineSimilarity([], []) === 0
  );

  // ── Unit: semanticBoostFor ──────────────────────────────────────────────────
  assert(
    "semanticBoostFor(0.0) = 0 (below threshold)",
    semanticBoostFor(0.0) === 0,
    `got ${semanticBoostFor(0.0)}`
  );
  assert(
    "semanticBoostFor(0.3) = 0 (at threshold)",
    semanticBoostFor(0.3) === 0,
    `got ${semanticBoostFor(0.3)}`
  );
  assert(
    "semanticBoostFor(0.5) > 0 (above threshold)",
    semanticBoostFor(0.5) > 0,
    `got ${semanticBoostFor(0.5)}`
  );
  assert(
    "semanticBoostFor(0.5) = 0.1 (mid-range)",
    Math.abs(semanticBoostFor(0.5) - 0.10) < 0.001,
    `got ${semanticBoostFor(0.5)}`
  );
  assert(
    "semanticBoostFor(1.0) = 0.35 (cap)",
    Math.abs(semanticBoostFor(1.0) - 0.35) < 0.001,
    `got ${semanticBoostFor(1.0)}`
  );

  // ── Integration: semantic_score = 0 when no API key ─────────────────────────
  const convId = uuidv4();
  const otherConv = uuidv4();
  insertConversation(convId);
  insertConversation(otherConv);

  insertEventAt(otherConv, "user",      "I usually prefer window seats on flights.", 3);
  insertEventAt(otherConv, "assistant", "Noted, I'll always prioritise window seats for you.", 3);
  insertEventAt(otherConv, "user",      "Also, I am vegetarian so no meat dishes please.", 3);

  // No provider_settings row → getOpenAiApiKey() returns null → semantic_score=0
  const snippets = await searchVerbatim("what are my travel preferences?", {
    maxResults:           5,
    excludeConversationId: convId,
  });

  assert(
    "snippets returned despite no OpenAI key",
    snippets.length > 0,
    `got ${snippets.length} snippets`
  );

  const allHaveSemanticField = snippets.every((s) => typeof s.semantic_score === "number");
  assert(
    "all snippets have numeric semantic_score field",
    allHaveSemanticField
  );

  const allZeroSemantic = snippets.every((s) => s.semantic_score === 0);
  assert(
    "semantic_score is 0 for all snippets when no API key",
    allZeroSemantic,
    `scores: ${snippets.map((s) => s.semantic_score).join(", ")}`
  );

  // final_score must still be > 0 (driven by BM25 + preference boost)
  const allPositiveFinal = snippets.every((s) => s.final_score > 0);
  assert(
    "final_score is still positive without semantic signal",
    allPositiveFinal,
    `final scores: ${snippets.map((s) => s.final_score.toFixed(3)).join(", ")}`
  );

  // score_reason must NOT mention semantic when signal is 0
  const noSemanticInReason = snippets.every((s) => !s.score_reason.includes("semantic=0.000"));
  assert(
    "score_reason omits semantic=0.000 entries",
    noSemanticInReason,
    `reasons: ${snippets.map((s) => s.score_reason).join(" | ")}`
  );
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("RecallOS verbatim retrieval bench");
  console.log("==================================");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recallos-verbatim-"));

  // Query classifier doesn't need DB, run first
  await testQueryClassifierWeights();
  await testQueryClassifier();

  // DB-dependent tests each get a fresh database
  for (const test of [
    testAssistantRecall,
    testPreferenceEvidenceBoost,
    testTemporalProximityBoost,
    testNoisyHistory,
    testStructuredOverrideBeat,
    testMixedRetrieval,
    testSemanticScoreFallback,
  ]) {
    const dbFile = path.join(tmpDir, `${uuidv4()}.db`);
    await test(dbFile);
  }

  console.log("\n──────────────────────────────────────");
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log("\nFailed assertions:");
    for (const f of failures) {
      console.log(`  • ${f}`);
    }
    process.exit(1);
  } else {
    console.log("All assertions passed.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Bench error:", err);
  process.exit(1);
});
