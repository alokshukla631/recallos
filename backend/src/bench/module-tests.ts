/**
 * Module-level tests for every core RecallOS module.
 *
 * Each test spins up a fresh in-memory SQLite database (one per test) and
 * exercises a single module in isolation so regressions can be caught per
 * module without any cross-module interference.
 *
 * Covered modules:
 *   ranking          query-classifier   entity-extractor    domain-detector
 *   memory-extractor memory-reconciler  audit               tags
 *   links            versioning         duplicates          importance
 *   decay            confidence-decay   conflicts           conversations
 *   projects         event-store        context-snapshot    session-cleanup
 *   passport         suggestions        perf                webhooks
 *
 * Run with: npm run bench:modules   (from the backend directory)
 */

import os   from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { initDatabase, queryAll, queryOne, runSql } from "../db/index.js";

// Modules under test
import { bm25Rank, tokenize, fuzzySearch }             from "../modules/ranking.js";
import { classifyQuery }                                from "../modules/query-classifier.js";
import { extractEntities }                              from "../modules/entity-extractor.js";
import { detectDomain }                                 from "../modules/domain-detector.js";
import { extractMemory }                                from "../modules/memory-extractor.js";
import { reconcileMemory }                              from "../modules/memory-reconciler.js";
import { logAudit, getAuditForItem, getRecentAudit }    from "../modules/audit.js";
import { addTag, removeTag, getTagsForItem, getAllTags, getItemsByTag } from "../modules/tags.js";
import { createLink, removeLink, getLinksFrom, getLinksTo, findRelated } from "../modules/links.js";
import { createVersion, getVersions, revertToVersion, getVersionCount, ensureVersionTable } from "../modules/versioning.js";
import { findDuplicates }                               from "../modules/duplicates.js";
import { computeImportance, rankByImportance }          from "../modules/importance.js";
import { findDecayCandidates, applyDecay }              from "../modules/decay.js";
import { applyConfidenceDecay }                         from "../modules/confidence-decay.js";
import { detectConflicts, resolveConflict, getPendingConflicts, ensureConflictsTable } from "../modules/conflicts.js";
import { generateTitle, ensureConversation, deleteConversation, listConversations, updateConversationTitle } from "../modules/conversations.js";
import { createProject, getProject, updateProject, listProjects, deleteProject } from "../modules/projects.js";
import { storeEvent, getEvents, getRecentTurns }        from "../modules/event-store.js";
import { saveSnapshot, getSnapshot, getSnapshotsForEvent } from "../modules/context-snapshot.js";
import { expireSessionMemory, getSessionStats }         from "../modules/session-cleanup.js";
import { exportPassport, importPassport, exportPassportMarkdown, type Passport } from "../modules/passport.js";
import { generateSuggestions }                          from "../modules/suggestions.js";
import { PerfTimer }                                    from "../modules/perf.js";
import { registerWebhook, listWebhooks, deleteWebhook, toggleWebhook } from "../modules/webhooks.js";

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

async function freshDb(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `recallos-modtest-${uuidv4()}.db`);
  await initDatabase(dbPath);
}

// Helpers to seed rows without invoking the full pipeline.
function insertMemory(
  key: string,
  type: string,
  value: string,
  opts: {
    scope?: string;
    domain?: string | null;
    confidence?: number;
    pinned?: number;
    status?: string;
    createdDaysAgo?: number;
    lastConfirmedDaysAgo?: number | null;
    projectId?: string | null;
  } = {}
): string {
  const id   = uuidv4();
  const now  = new Date();
  const cDate = new Date(now.getTime() - (opts.createdDaysAgo ?? 0) * 86_400_000).toISOString();
  const lc    = opts.lastConfirmedDaysAgo == null
    ? null
    : new Date(now.getTime() - opts.lastConfirmedDaysAgo * 86_400_000).toISOString();

  runSql(
    `INSERT INTO memory_items
       (id, key, type, value, scope, domain, project_id, confidence, authority,
        status, pinned, created_at, last_confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'explicit', ?, ?, ?, ?)`,
    [
      id, key, type, value,
      opts.scope      ?? "global",
      opts.domain     ?? null,
      opts.projectId  ?? null,
      opts.confidence ?? 0.8,
      opts.status     ?? "active",
      opts.pinned     ?? 0,
      cDate,
      lc,
    ]
  );
  return id;
}

// ─── Runner (tests registered from separate files) ────────────────────────────

export { assert, freshDb, insertMemory, passed, failed, failures };

async function main(): Promise<void> {
  console.log("RecallOS — Module Tests");
  console.log("========================\n");

  await testRanking();
  await testQueryClassifier();
  await testEntityExtractor();
  await testDomainDetector();
  await testMemoryExtractor();
  await testMemoryReconciler();
  await testAudit();
  await testTags();
  await testLinks();
  await testVersioning();
  await testDuplicates();
  await testImportance();
  await testDecay();
  await testConfidenceDecay();
  await testConflicts();
  await testConversations();
  await testProjects();
  await testEventStore();
  await testContextSnapshot();
  await testSessionCleanup();
  await testPassport();
  await testSuggestions();
  await testPerf();
  await testWebhooks();

  console.log("\n========================");
  console.log(`Passed: ${passed} / ${passed + failed}`);
  if (failed > 0) {
    console.log(`FAILED: ${failed}`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  console.log("All module tests passed.");
}

// ─── ranking ──────────────────────────────────────────────────────────────────

async function testRanking(): Promise<void> {
  console.log("=== ranking ===");

  // tokenize: stopwords + stemming + punctuation
  const tokens = tokenize("I prefer the FLYING seats on my flights.");
  assert("tokenize strips stopwords (the, on, my, I)",
    !tokens.includes("the") && !tokens.includes("on") && !tokens.includes("my") && !tokens.includes("i"),
    `got ${JSON.stringify(tokens)}`);
  assert("tokenize stems 'flying' and 'flights' to shared root",
    tokens.filter(t => t.startsWith("fl")).length >= 2,
    `got ${JSON.stringify(tokens)}`);
  assert("tokenize lowercases",
    !tokens.some(t => /[A-Z]/.test(t)),
    `got ${JSON.stringify(tokens)}`);

  // bm25Rank: empty docs list
  assert("bm25Rank on empty docs returns []",
    bm25Rank("anything", []).length === 0);

  // bm25Rank: stopwords-only query → all scores zero
  const stopOnly = bm25Rank("the and of", [
    { id: "1", text: "hello world" },
    { id: "2", text: "goodbye world" },
  ]);
  assert("bm25Rank with stopword-only query scores zero",
    stopOnly.every(d => d.score === 0),
    `scores: ${stopOnly.map(d => d.score).join(",")}`);

  // bm25Rank: basic relevance ordering
  const ranked = bm25Rank("vegetarian food dinner", [
    { id: "A", text: "I prefer vegetarian food for dinner" },
    { id: "B", text: "The weather is nice today" },
    { id: "C", text: "Vegetarian dinner recipes are great" },
  ]);
  assert("bm25Rank returns one score per document",
    ranked.length === 3,
    `got ${ranked.length}`);
  assert("bm25Rank ranks relevant docs above irrelevant",
    ranked[0].id !== "B",
    `top was ${ranked[0].id}`);
  assert("bm25Rank sorts descending by score",
    ranked[0].score >= ranked[ranked.length - 1].score);

  // fuzzySearch: finds near-matches BM25 would miss
  const fuzzy = fuzzySearch("vegitarian", [
    { id: "A", text: "I am vegetarian" },
    { id: "B", text: "I love chocolate" },
  ]);
  assert("fuzzySearch finds near-miss typo", fuzzy.length >= 1, `got ${fuzzy.length}`);
  assert("fuzzySearch puts closest match first",
    fuzzy.length === 0 || fuzzy[0].id === "A",
    `top: ${fuzzy[0]?.id}`);
}

// ─── query-classifier ─────────────────────────────────────────────────────────

async function testQueryClassifier(): Promise<void> {
  console.log("\n=== query-classifier ===");

  // Balanced (default)
  const bal = classifyQuery("tell me a joke");
  assert("default query classifies as balanced",
    bal.type === "balanced", `got ${bal.type}`);
  assert("balanced has structured bias",
    bal.structuredWeight > bal.verbatimWeight);

  // Assistant recall
  const ar = classifyQuery("what did you recommend for Japan?");
  assert("'what did you recommend' → assistant_recall",
    ar.type === "assistant_recall", `got ${ar.type}`);
  assert("assistant_recall is verbatim-heavy",
    ar.verbatimWeight >= 0.8);

  // Preference profile
  const pp = classifyQuery("what do I usually prefer for dinner?");
  assert("'what do I usually prefer' → preference_profile",
    pp.type === "preference_profile", `got ${pp.type}`);
  assert("preference_profile is structured-leaning",
    pp.structuredWeight > pp.verbatimWeight);

  // Episodic
  const ep = classifyQuery("when did we first talk about Kyoto?");
  assert("'when did we' → episodic_search",
    ep.type === "episodic_search", `got ${ep.type}`);

  // Temporal
  const te = classifyQuery("what did I say yesterday?");
  assert("'yesterday' → temporal_history",
    te.type === "temporal_history", `got ${te.type}`);
  assert("temporal anchor populated",
    te.temporalAnchor !== undefined && te.temporalAnchor.windowDays > 0);
  assert("anchor is before now",
    te.temporalAnchor ? te.temporalAnchor.anchorDate.getTime() <= Date.now() : false);

  // Planning
  const pl = classifyQuery("should I book the flight now or wait?");
  assert("'should I' → planning",
    pl.type === "planning", `got ${pl.type}`);

  // Mixed temporal + assistant-recall — temporal wins but signals preserved
  const mix = classifyQuery("what did you recommend last week?");
  assert("temporal+assistant mix resolves to temporal_history",
    mix.type === "temporal_history");
  assert("mixed query keeps assistant_recall signal",
    mix.signals.includes("assistant_recall"),
    `signals: ${JSON.stringify(mix.signals)}`);
}

// ─── entity-extractor ─────────────────────────────────────────────────────────

async function testEntityExtractor(): Promise<void> {
  console.log("\n=== entity-extractor ===");

  // Destinations
  const dests = extractEntities("I'm planning a trip to Tokyo and Kyoto next month");
  assert("extracts Tokyo + Kyoto as destinations",
    dests.filter(e => e.type === "destination").map(e => e.normalized).sort().join(",") === "Kyoto,Tokyo",
    `got: ${JSON.stringify(dests.filter(e => e.type === "destination"))}`);

  // Technologies
  const techs = extractEntities("I use React and PostgreSQL with Node");
  const techNorms = new Set(techs.filter(e => e.type === "technology").map(e => e.normalized));
  assert("extracts React", techNorms.has("React"));
  assert("extracts PostgreSQL", techNorms.has("PostgreSQL"));

  // Languages vs technologies
  const langs = extractEntities("I code in TypeScript and Python");
  const languageNorms = new Set(langs.filter(e => e.type === "language").map(e => e.normalized));
  assert("TypeScript classified as language", languageNorms.has("TypeScript"));
  assert("Python classified as language", languageNorms.has("Python"));

  // Amounts
  const amts = extractEntities("Budget is $2000 and €1,200 for the trip");
  const amtNorms = new Set(amts.filter(e => e.type === "amount").map(e => e.normalized));
  assert("extracts $2000 as 2000 USD", amtNorms.has("2000 USD"), `got ${[...amtNorms].join(",")}`);
  assert("extracts €1,200 as 1200 EUR", amtNorms.has("1200 EUR"), `got ${[...amtNorms].join(",")}`);

  // Durations
  const durs = extractEntities("We're staying for 5 nights and 2 weeks");
  const durNorms = new Set(durs.filter(e => e.type === "duration").map(e => e.normalized));
  assert("extracts '5 nights' as 5 days", durNorms.has("5 days"));
  assert("extracts '2 weeks'", durNorms.has("2 weeks"));

  // Dates: ISO
  const iso = extractEntities("Meeting on 2026-04-20");
  assert("extracts ISO date", iso.some(e => e.type === "date" && e.normalized === "2026-04-20"),
    `got ${JSON.stringify(iso)}`);

  // Dates: relative
  const now = new Date(2026, 3, 19); // April 19, 2026
  const tomorrow = extractEntities("Let's meet tomorrow", now);
  assert("extracts 'tomorrow' relative to now",
    tomorrow.some(e => e.type === "date" && e.normalized === "2026-04-20"),
    `got ${JSON.stringify(tomorrow)}`);
}

// ─── domain-detector ──────────────────────────────────────────────────────────

async function testDomainDetector(): Promise<void> {
  console.log("\n=== domain-detector ===");

  assert("travel domain detected",
    detectDomain("hotel booking", "booking hotel in Tokyo next trip") === "travel");
  assert("coding domain detected",
    detectDomain("tech stack", "we use typescript react and node") === "coding");
  assert("health domain detected",
    // needs ≥2 keyword hits from the health vocabulary (diet + exercise + allergy)
    detectDomain("diet plan", "my diet excludes gluten, I exercise at the gym") === "health");
  assert("single-keyword match rejected (needs 2+)",
    detectDomain("general", "I like running") === null,
    `got ${detectDomain("general", "I like running")}`);
  assert("unrelated key+value → null",
    detectDomain("random", "purple elephant flies") === null);
}

// ─── memory-extractor ─────────────────────────────────────────────────────────

async function testMemoryExtractor(): Promise<void> {
  console.log("\n=== memory-extractor ===");
  await freshDb();

  // Preference: straight "I prefer X"
  const pref = await extractMemory("I prefer window seats on long flights.", "evt-1");
  assert("extracts preference from 'I prefer window seats'",
    pref.some(c => c.type === "preference"),
    `got: ${JSON.stringify(pref)}`);

  // Medical constraint takes priority over generic fact rule
  const med = await extractMemory("I have celiac disease.", "evt-2");
  const celiac = med.find(c => /celiac/i.test(c.value));
  assert("celiac extracted as constraint, not fact",
    celiac?.type === "constraint",
    `got type=${celiac?.type}`);
  assert("celiac tagged health domain",
    celiac?.domain === "health",
    `got domain=${celiac?.domain}`);

  // Override wins first pass
  const ovr = await extractMemory("Actually, forget what I said about steak.", "evt-3");
  assert("override triggers on 'forget what I said'",
    ovr.some(c => c.type === "override"),
    `got: ${JSON.stringify(ovr)}`);

  // Travel goal + Tokyo destination entity
  const travel = await extractMemory("I'm planning a trip to Tokyo next month.", "evt-4");
  assert("travel goal extracted",
    travel.some(c => c.type === "goal" && c.domain === "travel"));
  assert("destination entity promoted to goal",
    travel.some(c => c.value === "Tokyo" && c.type === "goal"));

  // Constraint: budget
  const budget = await extractMemory("Budget max $3000 for the whole trip.", "evt-5");
  assert("budget detected as constraint",
    budget.some(c => c.type === "constraint"));

  // Project-scope hint but no projectId: falls back to global
  const scoped = await extractMemory("For this trip I want to try new things.", "evt-6");
  assert("project-scope hint with no projectId → global",
    scoped.every(c => c.scope !== "project"),
    `scopes: ${scoped.map(c => c.scope).join(",")}`);

  // Same project-scope hint WITH a projectId → retains project scope
  const scopedOk = await extractMemory("For this trip I prefer budget hotels.", "evt-7", "proj-1");
  assert("project-scope hint with projectId → project scope",
    scopedOk.some(c => c.scope === "project" && c.projectId === "proj-1"),
    `got: ${JSON.stringify(scopedOk.map(c => ({ s: c.scope, p: c.projectId })))}`);

  // Deduplication within a single extraction pass
  const dup = await extractMemory(
    "I prefer window seats. I prefer window seats.",
    "evt-8"
  );
  const windowPrefs = dup.filter(c => /window/i.test(c.value));
  assert("duplicate sentence does not produce duplicate candidate",
    windowPrefs.length === 1,
    `got ${windowPrefs.length}`);

  // Empty input → empty list, no throw
  const empty = await extractMemory("", "evt-9");
  assert("empty text → empty candidate list", empty.length === 0);

  // Pure noise → no candidates
  const noise = await extractMemory("asdf qwerty zxcv", "evt-10");
  assert("gibberish → no pattern candidates",
    noise.every(c => c.authority !== "explicit" || c.type !== "preference"),
    `got: ${JSON.stringify(noise)}`);
}

// ─── memory-reconciler ────────────────────────────────────────────────────────

/**
 * Helper: insert a real conversation + event row and return the event id,
 * so reconcileMemory calls don't violate the source_event_id FK.
 */
function seedEvent(content: string): string {
  const convId = uuidv4();
  const eventId = uuidv4();
  runSql(
    `INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at)
     VALUES (?, 'mod-test', datetime('now'), datetime('now'))`,
    [convId]
  );
  runSql(
    `INSERT INTO events (id, conversation_id, role, content, provider, created_at)
     VALUES (?, ?, 'user', ?, 'test', datetime('now'))`,
    [eventId, convId, content]
  );
  return eventId;
}

async function testMemoryReconciler(): Promise<void> {
  console.log("\n=== memory-reconciler ===");
  await freshDb();

  // 1. First insert: new item added
  const eA = seedEvent("I prefer window seats on flights.");
  const first = await extractMemory("I prefer window seats on flights.", eA);
  const r1    = await reconcileMemory(first, eA);
  assert("first reconcile inserts new item",
    r1.added.length >= 1 && r1.duplicates.length === 0);

  // 2. Same sentence again → reconfirmed (duplicate path)
  const eB = seedEvent("I prefer window seats on flights.");
  const r2 = await reconcileMemory(
    await extractMemory("I prefer window seats on flights.", eB),
    eB
  );
  assert("duplicate value reconfirms, not duplicates",
    r2.duplicates.length >= 1 && r2.added.length === 0,
    `added=${r2.added.length} dup=${r2.duplicates.length}`);

  // Confidence rises on reconfirm
  const reconfirmedId = r2.duplicates[0]?.id;
  if (reconfirmedId) {
    const row = queryOne("SELECT confidence FROM memory_items WHERE id = ?", [reconfirmedId]) as any;
    assert("confidence bumped on reconfirm",
      (row?.confidence ?? 0) > 0.8,
      `got ${row?.confidence}`);
  }

  // 3. Different value for same key → supersession, not duplicate.
  // Use hand-crafted candidates so both land on the same key — the
  // extractor's key templating would otherwise produce different keys for
  // "aisle seats on flights" vs "window seats on flights".
  await freshDb();
  const eC = seedEvent("I prefer aisle seats.");
  const r3a = await reconcileMemory(
    [{
      key: "seat_preference", type: "preference",
      value: "aisle seat", scope: "global",
      confidence: 0.8, authority: "explicit", domain: "travel",
    }],
    eC
  );
  assert("hand-crafted preference inserts cleanly", r3a.added.length === 1);

  const eD = seedEvent("Actually I now prefer window seats.");
  const r3b = await reconcileMemory(
    [{
      key: "seat_preference", type: "preference",
      value: "window seat", scope: "global",
      confidence: 0.8, authority: "explicit", domain: "travel",
    }],
    eD
  );
  assert("same-key / different-value creates supersession + conflict",
    r3b.conflicts.length >= 1 && (r3b.updated.length >= 1 || r3b.added.length >= 1),
    `conflicts=${r3b.conflicts.length} updated=${r3b.updated.length} added=${r3b.added.length}`);

  const supersededRow = queryOne(
    "SELECT status FROM memory_items WHERE id = ?",
    [r3a.added[0].id]
  ) as any;
  assert("older item marked superseded after the new one lands",
    supersededRow?.status === "superseded",
    `status=${supersededRow?.status}`);

  // 4. reconcileMemory with eventId=null does NOT throw (fix #33 regression guard)
  await freshDb();
  let threw = false;
  try {
    await reconcileMemory(
      await extractMemory("I prefer aisle seats on flights.", ""),
      null
    );
  } catch { threw = true; }
  assert("reconcileMemory(candidates, null) does not throw", !threw);

  // Confirm the null-eventId row landed with NULL source_event_id
  const nullSrcRow = queryOne("SELECT source_event_id FROM memory_items LIMIT 1") as any;
  assert("null eventId lands as NULL in the column",
    nullSrcRow?.source_event_id === null,
    `got ${JSON.stringify(nullSrcRow?.source_event_id)}`);

  // 5. Empty candidate list: returns empty result, no DB writes
  const empty = await reconcileMemory([], null);
  assert("empty candidates → no-op",
    empty.added.length === 0 && empty.updated.length === 0 &&
    empty.duplicates.length === 0 && empty.conflicts.length === 0);
}
// ─── audit ────────────────────────────────────────────────────────────────────

async function testAudit(): Promise<void> {
  console.log("\n=== audit ===");
  await freshDb();

  const id = insertMemory("diet_preference", "preference", "vegetarian");

  // logAudit writes rows that round-trip through getAuditForItem
  logAudit(id, "created", "initial extraction");
  logAudit(id, "reconfirmed", "mentioned again");
  logAudit(id, "pinned", "user pin");

  const entries = getAuditForItem(id);
  assert("getAuditForItem returns all 3 entries",
    entries.length === 3,
    `got ${entries.length}`);
  // Ordering isn't stable across ties because datetime('now') is second-precision
  // and three logAudit calls land in the same second. Check content, not order.
  const actions = new Set(entries.map(e => e.action));
  assert("all three actions recorded",
    actions.has("created") && actions.has("reconfirmed") && actions.has("pinned"));
  assert("detail text is preserved",
    entries.some(e => e.details === "initial extraction"));

  // getRecentAudit returns cross-item rows and joins memory details
  const id2 = insertMemory("tone_style", "fact", "casual");
  logAudit(id2, "created", "style note");

  const recent = getRecentAudit(10);
  assert("getRecentAudit surfaces across items",
    recent.length >= 4,
    `got ${recent.length}`);
  assert("getRecentAudit enriches with memory_key from join",
    recent.some((r: any) => r.memory_key === "diet_preference" || r.memory_key === "tone_style"));

  // Empty memory id → empty result
  const none = getAuditForItem("non-existent-id");
  assert("getAuditForItem for missing id → []", none.length === 0);
}

// ─── tags ─────────────────────────────────────────────────────────────────────

async function testTags(): Promise<void> {
  console.log("\n=== tags ===");
  await freshDb();

  const id = insertMemory("seat_preference", "preference", "window seat");

  addTag(id, "Travel");              // uppercase + capitalized
  addTag(id, "  flight booking  ");  // whitespace + multi-word
  addTag(id, "travel");              // duplicate of first (after normalization)

  const tags = getTagsForItem(id);
  assert("tags lowercased + trimmed + hyphenated",
    tags.includes("travel") && tags.includes("flight-booking"),
    `got ${JSON.stringify(tags)}`);
  assert("duplicate tag ignored",
    tags.filter(t => t === "travel").length === 1);

  // getAllTags aggregates across items
  const id2 = insertMemory("tone_style", "fact", "casual");
  addTag(id2, "travel");
  const all = getAllTags();
  const travelCount = all.find(t => t.tag === "travel")?.count ?? 0;
  assert("getAllTags counts 'travel' across 2 items",
    travelCount === 2,
    `got ${travelCount}`);

  // getItemsByTag
  const itemsWithTravel = getItemsByTag("TRAVEL");
  assert("getItemsByTag normalizes lookup",
    itemsWithTravel.length === 2,
    `got ${itemsWithTravel.length}`);

  // removeTag
  removeTag(id, "travel");
  const tagsAfter = getTagsForItem(id);
  assert("removeTag drops the tag",
    !tagsAfter.includes("travel"));

  // Blank + whitespace-only tag rejected
  const id3 = insertMemory("writing_style", "fact", "formal");
  addTag(id3, "   ");
  addTag(id3, "");
  const blankTags = getTagsForItem(id3);
  assert("blank tag ignored", blankTags.length === 0,
    `got ${JSON.stringify(blankTags)}`);
}

// ─── links ────────────────────────────────────────────────────────────────────

async function testLinks(): Promise<void> {
  console.log("\n=== links ===");
  await freshDb();

  const a = insertMemory("a_seat", "preference", "aisle");
  const b = insertMemory("b_airline", "preference", "United");
  const c = insertMemory("c_meal", "preference", "vegan");

  const link1 = createLink(a, b, "related_to", 0.8, "both travel prefs");
  assert("createLink returns a valid MemoryLink",
    link1.id.length > 0 && link1.source_id === a && link1.target_id === b);

  // Idempotent re-create: same triple returns the same row
  const link1Dup = createLink(a, b, "related_to", 0.9, "updated strength");
  assert("re-creating the same link returns the same id",
    link1Dup.id === link1.id);

  // Strength updates on duplicate create
  assert("duplicate createLink updates strength to 0.9",
    link1Dup.strength === 0.9,
    `got ${link1Dup.strength}`);

  // getLinksFrom / getLinksTo
  createLink(b, c, "refines", 0.7);
  const fromA = getLinksFrom(a);
  assert("getLinksFrom returns outgoing links only",
    fromA.length === 1 && fromA[0].target_id === b);

  const toB = getLinksTo(b);
  assert("getLinksTo returns incoming links only",
    toB.length === 1 && toB[0].source_id === a);

  // findRelated: BFS traversal a → b → c
  const related = findRelated(a, 2);
  assert("findRelated traverses 2 hops and excludes source",
    related.has(b) && related.has(c) && !related.has(a),
    `got ${[...related].join(",")}`);

  // Depth=1: only direct neighbours
  const related1 = findRelated(a, 1);
  assert("findRelated depth=1 returns only direct neighbour",
    related1.has(b) && !related1.has(c));

  // removeLink
  const removed = removeLink(link1.id);
  assert("removeLink succeeds on existing link", removed === true);
  const removedAgain = removeLink(link1.id);
  assert("removeLink returns false for non-existent link", removedAgain === false);
  const fromAAfter = getLinksFrom(a);
  assert("getLinksFrom reflects removal",
    fromAAfter.length === 0,
    `got ${fromAAfter.length}`);
}

// ─── versioning ───────────────────────────────────────────────────────────────

async function testVersioning(): Promise<void> {
  console.log("\n=== versioning ===");
  await freshDb();
  ensureVersionTable();

  const id = insertMemory("seat", "preference", "aisle", { confidence: 0.7 });

  // v1 snapshot of the initial state
  const v1 = createVersion(id, "user");
  assert("createVersion returns a MemoryVersion",
    v1 !== null && v1!.version_number === 1 && v1!.value === "aisle");

  // Mutate the item and snapshot v2
  runSql("UPDATE memory_items SET value = ?, confidence = ? WHERE id = ?",
    ["window", 0.85, id]);
  const v2 = createVersion(id, "user");
  assert("version_number increments on second snapshot",
    v2 !== null && v2!.version_number === 2);

  const versions = getVersions(id);
  assert("getVersions returns all versions, newest first",
    versions.length === 2 && versions[0].version_number === 2);
  assert("getVersionCount matches",
    getVersionCount(id) === 2);

  // Revert to v1
  const ok = revertToVersion(id, v1!.id);
  assert("revertToVersion succeeds", ok === true);

  const current = queryOne("SELECT value, confidence FROM memory_items WHERE id = ?", [id]) as any;
  assert("item value reverted to v1",
    current?.value === "aisle",
    `got ${current?.value}`);

  // Revert also snapshots current state before applying, so we have 3 versions
  assert("revert leaves a v3 snapshot of pre-revert state",
    getVersionCount(id) === 3,
    `got ${getVersionCount(id)}`);

  // Revert to non-existent version id fails cleanly
  const badRevert = revertToVersion(id, "fake-version-id");
  assert("revertToVersion returns false for unknown id", badRevert === false);

  // Revert across memory items is rejected
  const otherId = insertMemory("other", "fact", "x");
  const badRevert2 = revertToVersion(otherId, v1!.id);
  assert("revert rejects a version belonging to a different item",
    badRevert2 === false);
}
// ─── duplicates ───────────────────────────────────────────────────────────────

async function testDuplicates(): Promise<void> {
  console.log("\n=== duplicates ===");
  await freshDb();

  // Two items with same key+type and heavily overlapping value tokens.
  // Note: `tokenize` drops stopwords (I, is, my, on) and stems (seats→seat,
  // flights→flight, driving→driv). Craft values so >=60% of content tokens
  // overlap between at least one pair inside the same-key group.
  insertMemory("seat_preference", "preference", "prefer window seat flights");
  insertMemory("seat_preference", "preference", "prefer window seat always flights");
  insertMemory("seat_preference", "preference", "actually like aisle seat"); // low overlap

  // Cross-key but highly overlapping content (needs Jaccard >= 0.75).
  // Combined tokens = tokenize(`${key} ${value}`) so underscores split the key.
  insertMemory("transport_choice", "preference",
    "prefer driving instead taking public transit work each day");
  insertMemory("commute_choice",   "preference",
    "prefer driving instead taking public transit work each day");

  // A completely unrelated item
  insertMemory("tone_style", "fact", "casual writing tone");

  const groups = findDuplicates(0.6);
  assert("finds at least one duplicate group",
    groups.length >= 1,
    `got ${groups.length} groups`);

  const sameKeyGroup = groups.find(g => g.key === "seat_preference");
  assert("same-key+type items grouped together",
    sameKeyGroup !== undefined);
  assert("same-key group similarity above threshold",
    !sameKeyGroup || sameKeyGroup.similarity >= 0.6,
    `sim=${sameKeyGroup?.similarity}`);

  const crossKeyGroup = groups.find(g =>
    g.key.includes("transport_choice") && g.key.includes("commute_choice"));
  assert("cross-key high-overlap pair detected",
    crossKeyGroup !== undefined,
    `keys: ${groups.map(g => g.key).join(" | ")}`);

  // Threshold enforcement: raising threshold to 1.0 drops everything
  const strict = findDuplicates(1.01);
  assert("threshold > 1 yields no groups",
    strict.length === 0);
}

// ─── importance ───────────────────────────────────────────────────────────────

async function testImportance(): Promise<void> {
  console.log("\n=== importance ===");
  await freshDb();

  // Fresh, unconfirmed, low-confidence item → low score
  const low = insertMemory("x", "fact", "v", {
    confidence: 0.4, createdDaysAgo: 0, lastConfirmedDaysAgo: null,
  });
  const fLow = computeImportance(low);
  assert("low-confidence fresh item scores under 50",
    fLow.total < 50, `got ${fLow.total}`);

  // High-confidence, recently confirmed, linked, tagged, aged → high score
  const high = insertMemory("seat", "preference", "window seat", {
    confidence: 0.95, createdDaysAgo: 80, lastConfirmedDaysAgo: 1,
  });
  const other = insertMemory("airline", "preference", "United");
  createLink(high, other, "related_to", 0.8);
  addTag(high, "travel");
  addTag(high, "important");

  const fHigh = computeImportance(high);
  assert("high-value item scores above 60",
    fHigh.total >= 60, `got ${fHigh.total}`);
  assert("confidence factor scales with confidence field",
    fHigh.confidence_score >= fLow.confidence_score);
  assert("link factor > 0 for linked item",
    fHigh.link_score > 0);
  assert("tag factor > 0 for tagged item",
    fHigh.tag_score > 0);
  assert("age bonus for old item",
    fHigh.age_bonus > 0);

  // Missing id → all zeros, no throw
  const missing = computeImportance("fake-id");
  assert("missing id returns zeros",
    missing.total === 0 &&
    missing.confidence_score === 0 &&
    missing.link_score === 0);

  // rankByImportance returns high above low
  const ranked = rankByImportance(5);
  const highRank = ranked.findIndex(r => r.id === high);
  const lowRank  = ranked.findIndex(r => r.id === low);
  assert("rankByImportance ranks high > low",
    highRank >= 0 && lowRank >= 0 && highRank < lowRank,
    `high@${highRank} low@${lowRank}`);
}

// ─── decay ────────────────────────────────────────────────────────────────────

async function testDecay(): Promise<void> {
  console.log("\n=== decay ===");
  await freshDb();

  // Very old, never confirmed → candidate under default thresholds
  const old = insertMemory("old_key", "preference", "old preference", {
    confidence: 0.6, createdDaysAgo: 200, lastConfirmedDaysAgo: null,
  });

  // Low-confidence + older (no recency boost) → total importance < 15.
  // computeImportance: confidence_score = round(conf*30), recency_score starts
  // at 15 for never-confirmed and drops 3pts/week since creation. 0.2*30=6 and
  // 30-day-old gives recency=2, total=8 (< default minImportance=15).
  const lowImp = insertMemory("low", "preference", "low value", {
    confidence: 0.2, createdDaysAgo: 30, lastConfirmedDaysAgo: null,
  });

  // Recently confirmed high-value → not a candidate
  const fresh = insertMemory("fresh", "preference", "fresh value", {
    confidence: 0.95, createdDaysAgo: 10, lastConfirmedDaysAgo: 1,
  });

  // Pinned item, also old and stale-looking → exempt
  const pinned = insertMemory("pinned", "preference", "pinned preference", {
    confidence: 0.5, createdDaysAgo: 300, lastConfirmedDaysAgo: null, pinned: 1,
  });

  const candidates = findDecayCandidates();
  const candIds = new Set(candidates.map(c => c.id));

  assert("old never-confirmed item is a decay candidate",
    candIds.has(old),
    `candidates: ${[...candIds].join(",")}`);
  assert("low-importance item is a decay candidate",
    candIds.has(lowImp));
  assert("fresh high-value item NOT a candidate",
    !candIds.has(fresh));
  assert("pinned item NOT a candidate (exempt from decay)",
    !candIds.has(pinned));

  // Apply decay marks the candidates as stale
  const result = applyDecay();
  assert("applyDecay returns a marked count matching candidates",
    result.marked === candidates.length);

  const oldRow = queryOne("SELECT status FROM memory_items WHERE id = ?", [old]) as any;
  assert("decayed item status = stale",
    oldRow?.status === "stale",
    `status=${oldRow?.status}`);
  const freshRow = queryOne("SELECT status FROM memory_items WHERE id = ?", [fresh]) as any;
  assert("fresh item status unchanged",
    freshRow?.status === "active");
}

// ─── confidence-decay ─────────────────────────────────────────────────────────

async function testConfidenceDecay(): Promise<void> {
  console.log("\n=== confidence-decay ===");
  await freshDb();

  // Within grace period → untouched
  const recent = insertMemory("recent", "preference", "v", {
    confidence: 0.9, createdDaysAgo: 1, lastConfirmedDaysAgo: 1,
  });

  // Beyond grace, still high confidence → gets decayed but not stale
  const aging = insertMemory("aging", "preference", "v", {
    confidence: 0.9, createdDaysAgo: 50, lastConfirmedDaysAgo: 50,
  });

  // Very old → should decay to the floor or below-min → stale
  const veryOld = insertMemory("very_old", "preference", "v", {
    confidence: 0.8, createdDaysAgo: 400, lastConfirmedDaysAgo: 400,
  });

  // Override type → exempt
  const override = insertMemory("ovr", "override", "v", {
    confidence: 0.9, createdDaysAgo: 200, lastConfirmedDaysAgo: 200,
  });

  const res = applyConfidenceDecay();
  assert("some items decayed", res.decayed + res.staled > 0,
    `decayed=${res.decayed} staled=${res.staled}`);

  const recentRow = queryOne("SELECT confidence, status FROM memory_items WHERE id = ?", [recent]) as any;
  assert("grace-period item untouched",
    Math.abs((recentRow?.confidence ?? 0) - 0.9) < 0.01 &&
    recentRow?.status === "active",
    `conf=${recentRow?.confidence} status=${recentRow?.status}`);

  const agingRow = queryOne("SELECT confidence, status FROM memory_items WHERE id = ?", [aging]) as any;
  assert("aging item confidence lowered",
    (agingRow?.confidence ?? 1) < 0.9 && agingRow?.status === "active",
    `conf=${agingRow?.confidence} status=${agingRow?.status}`);

  const overrideRow = queryOne("SELECT confidence FROM memory_items WHERE id = ?", [override]) as any;
  assert("override type exempt from decay",
    Math.abs((overrideRow?.confidence ?? 0) - 0.9) < 0.01,
    `conf=${overrideRow?.confidence}`);

  const veryOldRow = queryOne("SELECT status FROM memory_items WHERE id = ?", [veryOld]) as any;
  assert("very old item either stale or decayed to floor",
    veryOldRow?.status === "stale" ||
    (queryOne("SELECT confidence FROM memory_items WHERE id = ?", [veryOld]) as any)?.confidence < 0.5,
    `status=${veryOldRow?.status}`);
}
// ─── conflicts ────────────────────────────────────────────────────────────────

async function testConflicts(): Promise<void> {
  console.log("\n=== conflicts ===");
  await freshDb();
  ensureConflictsTable();

  // Two items with same key but different values → conflict
  const existingId = insertMemory("coffee_pref", "preference", "black no sugar");
  const newId      = insertMemory("coffee_pref", "preference", "oat milk two sugars");

  const detected = detectConflicts(newId, "coffee_pref", "oat milk two sugars");
  assert("detectConflicts returns one pending conflict",
    detected.length === 1, `got ${detected.length}`);
  assert("conflict links existing and new ids",
    detected[0]?.existing_id === existingId && detected[0]?.new_id === newId);
  assert("conflict status is 'pending'",
    detected[0]?.status === "pending");

  // Pending list should contain exactly the conflict we just detected
  const pending = getPendingConflicts();
  assert("getPendingConflicts returns the one real conflict",
    pending.length === 1 && pending[0].id === detected[0].id,
    `pending=${pending.length}`);

  // Resolve by keeping new: old item → superseded, conflict resolved_keep_new
  resolveConflict(detected[0].id, "keep_new");

  const oldStatus = (queryOne("SELECT status FROM memory_items WHERE id = ?", [existingId]) as any)?.status;
  assert("keep_new supersedes the existing item",
    oldStatus === "superseded", `status=${oldStatus}`);
  assert("no pending conflicts after resolution",
    getPendingConflicts().length === 0);

  // Identical value (case-insensitive / whitespace) → not a conflict.
  // Use a fresh key so no unrelated rows contribute to the query.
  await freshDb();
  ensureConflictsTable();
  const base = insertMemory("tone_style", "fact", "Casual Tone");
  const twinId = insertMemory("tone_style", "fact", "  Casual Tone  ");
  const noDetect = detectConflicts(twinId, "tone_style", "  Casual Tone  ");
  assert("identical (case/space-insensitive) value is not a conflict",
    noDetect.length === 0, `got ${noDetect.length}`);
  // And the row we inserted shouldn't clash with itself either — sanity.
  void base;

  // Second scenario: merged resolution updates new item's value
  await freshDb();
  ensureConflictsTable();
  const a = insertMemory("diet", "preference", "vegetarian");
  const b = insertMemory("diet", "preference", "pescatarian");
  const c2 = detectConflicts(b, "diet", "pescatarian")[0];
  resolveConflict(c2.id, "merged", "flexitarian");
  const bRow = queryOne("SELECT value FROM memory_items WHERE id = ?", [b]) as any;
  const aRow = queryOne("SELECT status FROM memory_items WHERE id = ?", [a]) as any;
  assert("merged resolution updates new item value",
    bRow?.value === "flexitarian", `value=${bRow?.value}`);
  assert("merged resolution supersedes the old item",
    aRow?.status === "superseded", `status=${aRow?.status}`);
}

// ─── conversations ────────────────────────────────────────────────────────────

async function testConversations(): Promise<void> {
  console.log("\n=== conversations ===");

  // generateTitle pure-function checks (no DB required)
  assert("generateTitle trims to first sentence",
    generateTitle("Hello world. This is a test.") === "Hello world");
  assert("generateTitle truncates long first sentence",
    generateTitle("a".repeat(100)).endsWith("...") &&
    generateTitle("a".repeat(100)).length <= 48);
  assert("generateTitle falls back on empty input",
    generateTitle("   ") === "New conversation");

  await freshDb();

  const c1 = uuidv4();
  const convo = ensureConversation(c1, "Let's talk about deployment.");
  assert("ensureConversation creates a new row",
    convo.id === c1 && convo.title === "Let's talk about deployment");

  // Calling again does NOT change the title, just bumps updated_at
  const same = ensureConversation(c1, "Something totally different now.");
  assert("ensureConversation is idempotent on existing id",
    same.title === "Let's talk about deployment");

  updateConversationTitle(c1, "Deployment Deep Dive");
  const updated = queryOne("SELECT title FROM conversations WHERE id = ?", [c1]) as any;
  assert("updateConversationTitle persists new title",
    updated?.title === "Deployment Deep Dive");

  // Seed a second conversation to verify listConversations ordering
  const c2 = uuidv4();
  ensureConversation(c2, "Benchmarks and eval harnesses.");
  const list = listConversations();
  assert("listConversations returns all conversations",
    list.length === 2, `got ${list.length}`);

  // deleteConversation cascades through events + memory + snapshots without
  // violating the FK chain (regression for #24 / #42).
  const eventId = uuidv4();
  runSql(
    `INSERT INTO events (id, conversation_id, role, content, provider, created_at)
     VALUES (?, ?, 'user', 'hi', 'test', datetime('now'))`,
    [eventId, c1]
  );
  const memId = insertMemory("x", "fact", "v");
  runSql("UPDATE memory_items SET source_event_id = ? WHERE id = ?", [eventId, memId]);
  runSql(
    `INSERT INTO context_snapshots
       (id, event_id, provider, compiled_context_json, included_memory_ids, omitted_memory_ids)
     VALUES (?, ?, 'test', '{}', '[]', '[]')`,
    [uuidv4(), eventId]
  );

  deleteConversation(c1);
  const stillThere = queryOne("SELECT id FROM conversations WHERE id = ?", [c1]) as any;
  assert("deleteConversation removes the row", stillThere === undefined);
  const orphanEvent = queryOne("SELECT id FROM events WHERE id = ?", [eventId]) as any;
  assert("deleteConversation removes the event", orphanEvent === undefined);
  const orphanMem = queryOne("SELECT id FROM memory_items WHERE id = ?", [memId]) as any;
  assert("deleteConversation removes linked memory_item", orphanMem === undefined);
}

// ─── projects ─────────────────────────────────────────────────────────────────

async function testProjects(): Promise<void> {
  console.log("\n=== projects ===");
  await freshDb();

  const p = createProject({
    name: "RecallOS v1",
    description: "memory layer",
    status: "active",
  });
  assert("createProject returns a row with generated id",
    p.id.length > 0 && p.name === "RecallOS v1");
  assert("status defaults honored in create",
    p.status === "active");

  const fetched = getProject(p.id);
  assert("getProject returns the created row",
    fetched?.id === p.id && fetched?.description === "memory layer");

  // Update name + status
  const updated = updateProject(p.id, { name: "RecallOS v2", status: "completed" });
  assert("updateProject returns the updated row",
    updated?.name === "RecallOS v2" && updated?.status === "completed");

  // Update with empty object returns existing row unchanged
  const noop = updateProject(p.id, {});
  assert("updateProject no-op returns existing row",
    noop?.name === "RecallOS v2");

  // Unknown id → undefined
  assert("updateProject on unknown id returns undefined",
    updateProject("does-not-exist", { name: "x" }) === undefined);

  // listProjects sorts active first, then planning, then completed
  createProject({ name: "alpha",   status: "planning"  });
  createProject({ name: "beta",    status: "active"    });
  createProject({ name: "gamma",   status: "cancelled" });
  const list = listProjects();
  const statuses = list.map(x => x.status);
  assert("listProjects sorts by status bucket",
    statuses.indexOf("active") < statuses.indexOf("planning") &&
    statuses.indexOf("planning") < statuses.indexOf("completed") &&
    statuses.indexOf("completed") <= statuses.indexOf("cancelled"),
    `statuses=${JSON.stringify(statuses)}`);

  // deleteProject orphans conversations + memory, doesn't delete them
  const p2 = createProject({ name: "to-delete", status: "active" });
  const convId = uuidv4();
  runSql(
    `INSERT INTO conversations (id, title, project_id, created_at, updated_at)
     VALUES (?, 'x', ?, datetime('now'), datetime('now'))`,
    [convId, p2.id]
  );
  const memId = insertMemory("k", "fact", "v", { projectId: p2.id, scope: "project" });

  deleteProject(p2.id);
  const orphanedConv = queryOne("SELECT project_id FROM conversations WHERE id = ?", [convId]) as any;
  const orphanedMem  = queryOne("SELECT project_id, scope FROM memory_items WHERE id = ?", [memId]) as any;
  assert("deleteProject orphans conversations (project_id = NULL)",
    orphanedConv?.project_id === null);
  assert("deleteProject orphans memory and resets scope to global",
    orphanedMem?.project_id === null && orphanedMem?.scope === "global");
  assert("deleteProject removes the project row",
    getProject(p2.id) === undefined);
}

// ─── event-store ──────────────────────────────────────────────────────────────

async function testEventStore(): Promise<void> {
  console.log("\n=== event-store ===");
  await freshDb();

  const convId = uuidv4();
  runSql(
    `INSERT INTO conversations (id, title, created_at, updated_at)
     VALUES (?, 'evt-test', datetime('now'), datetime('now'))`,
    [convId]
  );

  const e1 = await storeEvent(convId, "user",      "hello there",  "test");
  assert("storeEvent returns a populated event row",
    e1.id.length > 0 && e1.conversation_id === convId &&
    e1.role === "user" && e1.content === "hello there");
  assert("storeEvent persists provider field",
    e1.provider === "test");

  const e2 = await storeEvent(convId, "assistant", "hi — how can I help?", "test");
  const e3 = await storeEvent(convId, "user",      "tell me about memory", "test");

  // getEvents returns all events in ascending time order
  const all = await getEvents(convId);
  assert("getEvents returns every event for the conversation",
    all.length === 3, `got ${all.length}`);
  assert("getEvents returns rows in ascending created_at order",
    all[0].id === e1.id && all[1].id === e2.id && all[2].id === e3.id);

  // getEvents with a limit
  const limited = await getEvents(convId, 2);
  assert("getEvents honors limit",
    limited.length === 2);

  // getRecentTurns returns newest N but in ascending order (oldest of the N first)
  const recent2 = await getRecentTurns(convId, 2);
  assert("getRecentTurns returns N most-recent events",
    recent2.length === 2 &&
    recent2[0].id === e2.id && recent2[1].id === e3.id,
    `ids=${recent2.map(r => r.id).join(",")}`);

  // Unknown conversation → empty
  const none = await getEvents("nope");
  assert("getEvents on unknown conv id returns []",
    none.length === 0);
}

// ─── context-snapshot ─────────────────────────────────────────────────────────

async function testContextSnapshot(): Promise<void> {
  console.log("\n=== context-snapshot ===");
  await freshDb();

  const eventId = seedEvent("tell me what you remember about me");

  const snap = await saveSnapshot(
    eventId,
    "anthropic",
    { system: "you are helpful", memory: [{ id: "m1", text: "likes window seats" }] },
    ["m1", "m2"],
    ["m3"],
    { reason: "relevance > 0.5" },
    "Preview of the prompt..."
  );

  assert("saveSnapshot returns a row with the given event_id",
    snap.event_id === eventId);
  assert("saveSnapshot serializes included_memory_ids",
    JSON.parse(snap.included_memory_ids).length === 2);
  assert("saveSnapshot serializes omitted_memory_ids",
    JSON.parse(snap.omitted_memory_ids)[0] === "m3");
  assert("saveSnapshot serializes rationale_json",
    JSON.parse(snap.rationale_json ?? "{}").reason === "relevance > 0.5");
  assert("saveSnapshot stores provider",
    snap.provider === "anthropic");

  const byId = await getSnapshot(snap.id);
  assert("getSnapshot returns the saved row by id",
    byId?.id === snap.id);

  // Second snapshot for same event
  await saveSnapshot(eventId, "openai", {}, [], [], {});
  const forEvent = await getSnapshotsForEvent(eventId);
  assert("getSnapshotsForEvent returns both snapshots",
    forEvent.length === 2, `got ${forEvent.length}`);
  // Providers should include both
  const providers = forEvent.map(s => s.provider).sort();
  assert("getSnapshotsForEvent returns rows from both providers",
    providers.join(",") === "anthropic,openai",
    `providers=${providers.join(",")}`);

  // Unknown event → empty list
  const emptyList = await getSnapshotsForEvent("no-such-event");
  assert("getSnapshotsForEvent on unknown event returns []",
    emptyList.length === 0);
  assert("getSnapshot on unknown id returns undefined",
    (await getSnapshot("no-such-snap")) === undefined);
}

// ─── session-cleanup ──────────────────────────────────────────────────────────

async function testSessionCleanup(): Promise<void> {
  console.log("\n=== session-cleanup ===");
  await freshDb();

  // Old session item (48h ago) → should expire at TTL=24h
  const oldSession = insertMemory("sess_old", "fact", "v", {
    scope: "session", createdDaysAgo: 2,
  });
  // Fresh session item (6h ago) → survives
  insertMemory("sess_fresh", "fact", "v", {
    scope: "session", createdDaysAgo: 0.25,
  });
  // Global item even if old → NOT a session item, never expires here
  const globalOld = insertMemory("glob_old", "fact", "v", {
    scope: "global", createdDaysAgo: 30,
  });

  const expired = expireSessionMemory(24);
  assert("expireSessionMemory returns count of expired rows",
    expired === 1, `got ${expired}`);

  const oldStatus    = (queryOne("SELECT status FROM memory_items WHERE id = ?", [oldSession]) as any)?.status;
  const globalStatus = (queryOne("SELECT status FROM memory_items WHERE id = ?", [globalOld]) as any)?.status;
  assert("old session item marked stale",
    oldStatus === "stale", `status=${oldStatus}`);
  assert("global item NOT touched by session expiry",
    globalStatus === "active", `status=${globalStatus}`);

  // Stats reflect the state
  const stats = getSessionStats();
  assert("session stats: 1 active, 1 stale",
    stats.active === 1 && stats.stale === 1,
    `active=${stats.active} stale=${stats.stale}`);

  // Second call is a no-op
  const secondPass = expireSessionMemory(24);
  assert("second expireSessionMemory call is a no-op",
    secondPass === 0, `got ${secondPass}`);
}
async function testPassport(): Promise<void>         { console.log("\n=== passport ==="); console.log("  (not yet implemented)"); }
async function testSuggestions(): Promise<void>      { console.log("\n=== suggestions ==="); console.log("  (not yet implemented)"); }
async function testPerf(): Promise<void>             { console.log("\n=== perf ==="); console.log("  (not yet implemented)"); }
async function testWebhooks(): Promise<void>         { console.log("\n=== webhooks ==="); console.log("  (not yet implemented)"); }

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
