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

// Placeholder stubs (implemented in later commits)
async function testMemoryExtractor(): Promise<void>  { console.log("\n=== memory-extractor ==="); console.log("  (not yet implemented)"); }
async function testMemoryReconciler(): Promise<void> { console.log("\n=== memory-reconciler ==="); console.log("  (not yet implemented)"); }
async function testAudit(): Promise<void>            { console.log("\n=== audit ==="); console.log("  (not yet implemented)"); }
async function testTags(): Promise<void>             { console.log("\n=== tags ==="); console.log("  (not yet implemented)"); }
async function testLinks(): Promise<void>            { console.log("\n=== links ==="); console.log("  (not yet implemented)"); }
async function testVersioning(): Promise<void>       { console.log("\n=== versioning ==="); console.log("  (not yet implemented)"); }
async function testDuplicates(): Promise<void>       { console.log("\n=== duplicates ==="); console.log("  (not yet implemented)"); }
async function testImportance(): Promise<void>       { console.log("\n=== importance ==="); console.log("  (not yet implemented)"); }
async function testDecay(): Promise<void>            { console.log("\n=== decay ==="); console.log("  (not yet implemented)"); }
async function testConfidenceDecay(): Promise<void>  { console.log("\n=== confidence-decay ==="); console.log("  (not yet implemented)"); }
async function testConflicts(): Promise<void>        { console.log("\n=== conflicts ==="); console.log("  (not yet implemented)"); }
async function testConversations(): Promise<void>    { console.log("\n=== conversations ==="); console.log("  (not yet implemented)"); }
async function testProjects(): Promise<void>         { console.log("\n=== projects ==="); console.log("  (not yet implemented)"); }
async function testEventStore(): Promise<void>       { console.log("\n=== event-store ==="); console.log("  (not yet implemented)"); }
async function testContextSnapshot(): Promise<void>  { console.log("\n=== context-snapshot ==="); console.log("  (not yet implemented)"); }
async function testSessionCleanup(): Promise<void>   { console.log("\n=== session-cleanup ==="); console.log("  (not yet implemented)"); }
async function testPassport(): Promise<void>         { console.log("\n=== passport ==="); console.log("  (not yet implemented)"); }
async function testSuggestions(): Promise<void>      { console.log("\n=== suggestions ==="); console.log("  (not yet implemented)"); }
async function testPerf(): Promise<void>             { console.log("\n=== perf ==="); console.log("  (not yet implemented)"); }
async function testWebhooks(): Promise<void>         { console.log("\n=== webhooks ==="); console.log("  (not yet implemented)"); }

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
