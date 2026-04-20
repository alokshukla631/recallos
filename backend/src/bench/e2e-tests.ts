/**
 * End-to-end tests for the RecallOS chat pipeline.
 *
 * Drives the same sequence of calls that POST /api/chat runs, minus the
 * provider-adapter round-trip (which would need a real API key). For each
 * scenario we:
 *   1. ensureConversation
 *   2. storeEvent(user)
 *   3. extractMemory + reconcileMemory
 *   4. compileContext
 *   5. storeEvent(assistant) with a stubbed reply
 *   6. saveSnapshot with the rationale/trace
 *
 * Then we assert persisted state (memory_items, conversations, events,
 * context_snapshots) so regressions anywhere in the pipeline surface here.
 *
 * Adversarial coverage includes: empty/very-long messages, unicode, SQL-
 * looking strings, concurrent-looking bursts within the same second, and a
 * moderately noisy haystack.
 *
 * Run with: npm run bench:e2e   (from the backend directory)
 */

import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { initDatabase, queryAll, queryOne, runSql } from "../db/index.js";

import { ensureConversation, deleteConversation }  from "../modules/conversations.js";
import { storeEvent, getRecentTurns, getEvents }   from "../modules/event-store.js";
import { extractMemory }                            from "../modules/memory-extractor.js";
import { reconcileMemory }                          from "../modules/memory-reconciler.js";
import { compileContext }                           from "../modules/context-compiler.js";
import { saveSnapshot, getSnapshotsForEvent }       from "../modules/context-snapshot.js";

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
  const dbPath = path.join(os.tmpdir(), `recallos-e2e-${uuidv4()}.db`);
  await initDatabase(dbPath);
}

/**
 * Runs the same sequence as the POST /api/chat route, minus the provider
 * adapter call. Returns a handle with every id written so tests can assert
 * against persisted state.
 */
async function runTurn(
  convId: string,
  userMessage: string,
  assistantReply: string,
  opts: { projectId?: string } = {}
) {
  ensureConversation(convId, userMessage, opts.projectId);
  const userEvent = await storeEvent(convId, "user", userMessage, "test", opts.projectId);
  const candidates = await extractMemory(userMessage, userEvent.id, opts.projectId);
  const reconciled = await reconcileMemory(candidates, userEvent.id);
  const compiled = await compileContext(convId, userMessage, opts.projectId);
  const assistantEvent = await storeEvent(convId, "assistant", assistantReply, "test", opts.projectId);
  const snapshot = await saveSnapshot(
    userEvent.id,
    "test",
    compiled.contextPacket,
    compiled.includedIds,
    compiled.omittedIds,
    { rationale: compiled.rationale, trace: compiled.trace },
    compiled.contextText
  );
  return { userEvent, assistantEvent, reconciled, compiled, snapshot };
}

// ─── full pipeline: basic turn ────────────────────────────────────────────────

async function testPipelineBasic(): Promise<void> {
  console.log("=== pipeline: basic turn ===");
  await freshDb();

  const convId = uuidv4();
  const t = await runTurn(convId, "I prefer window seats on flights.", "Noted.");

  assert("pipeline stores a user event",
    t.userEvent.role === "user" && t.userEvent.content.startsWith("I prefer"));
  assert("pipeline extracts at least one memory candidate",
    t.reconciled.added.length >= 1,
    `added=${t.reconciled.added.length} updated=${t.reconciled.updated.length}`);
  assert("reconciled candidates are all linked to the source event",
    t.reconciled.added.every(a => a.source_event_id === t.userEvent.id),
    `ids=${t.reconciled.added.map(a => a.source_event_id).join(",")}`);
  assert("compileContext returns a non-empty contextText",
    t.compiled.contextText.length > 0,
    `text.length=${t.compiled.contextText.length}`);
  assert("snapshot persists with included+omitted memory ids",
    t.snapshot.event_id === t.userEvent.id);

  // Persisted state checks
  const events = await getEvents(convId);
  assert("pipeline persisted 2 events (user + assistant)",
    events.length === 2, `got ${events.length}`);

  const memRows = queryAll("SELECT * FROM memory_items WHERE status = 'active'") as any[];
  assert("at least one active memory item exists after turn",
    memRows.length >= 1, `got ${memRows.length}`);
  assert("memory items reference the user event as source",
    memRows.every(r => r.source_event_id === t.userEvent.id));

  const snaps = await getSnapshotsForEvent(t.userEvent.id);
  assert("one snapshot saved for the user event",
    snaps.length === 1);
}

// ─── full pipeline: multi-turn memory survives and influences context ────────

async function testPipelineMultiTurn(): Promise<void> {
  console.log("\n=== pipeline: multi-turn ===");
  await freshDb();

  const convId = uuidv4();

  // Turn 1: state a strong preference.
  await runTurn(convId, "I prefer window seats on flights.", "Got it.");

  // Turn 2: unrelated question.
  await runTurn(convId, "What's a good restaurant in Tokyo?", "Sukiyabashi Jiro.");

  // Turn 3: query that should surface the preference via context.
  const t3 = await runTurn(convId, "Help me plan a flight to Tokyo.", "Planning...");
  const contextText = t3.compiled.contextText.toLowerCase();

  assert("prior preference survives across intervening turn",
    contextText.includes("window") || contextText.includes("seat"),
    `context=${t3.compiled.contextText.slice(0, 200)}`);

  // Three user turns + three assistant turns = 6 events total.
  const events = await getEvents(convId);
  assert("multi-turn conversation has 6 events (3 user + 3 assistant)",
    events.length === 6, `got ${events.length}`);

  // getRecentTurns with limit preserves ordering tiebreak (fix #44).
  const recent4 = await getRecentTurns(convId, 4);
  assert("getRecentTurns returns the N most recent in chronological order",
    recent4.length === 4 &&
    recent4[0].created_at <= recent4[recent4.length - 1].created_at);
}

// ─── full pipeline: project scoping keeps memory isolated ────────────────────

async function testPipelineProjectScoping(): Promise<void> {
  console.log("\n=== pipeline: project scoping ===");
  await freshDb();

  const projA = uuidv4();
  const projB = uuidv4();
  runSql(`INSERT INTO projects (id, name, status) VALUES (?, 'Project A', 'active')`, [projA]);
  runSql(`INSERT INTO projects (id, name, status) VALUES (?, 'Project B', 'active')`, [projB]);

  const convA = uuidv4();
  const convB = uuidv4();

  await runTurn(convA, "For this project I prefer a serverless stack.", "Noted.", { projectId: projA });
  await runTurn(convB, "For this project I prefer a monolithic stack.",  "Noted.", { projectId: projB });

  // Project A's context should not contain Project B's preference and vice versa.
  const tA = await runTurn(convA, "Remind me what I prefer.", "—", { projectId: projA });
  const tB = await runTurn(convB, "Remind me what I prefer.", "—", { projectId: projB });

  const aText = tA.compiled.contextText.toLowerCase();
  const bText = tB.compiled.contextText.toLowerCase();

  assert("project A context mentions serverless",
    aText.includes("serverless"),
    `A=${aText.slice(0, 200)}`);
  assert("project A context does NOT mention monolithic",
    !aText.includes("monolithic"),
    `A=${aText.slice(0, 200)}`);
  assert("project B context mentions monolithic",
    bText.includes("monolithic"),
    `B=${bText.slice(0, 200)}`);
  assert("project B context does NOT mention serverless",
    !bText.includes("serverless"),
    `B=${bText.slice(0, 200)}`);
}

// ─── adversarial: empty / very-long / unicode / SQL-looking input ────────────

async function testAdversarialInputs(): Promise<void> {
  console.log("\n=== adversarial: inputs ===");
  await freshDb();

  // 1. Empty user message → pipeline should still complete (0 memory, 1 turn)
  const conv1 = uuidv4();
  let threw = false;
  try {
    await runTurn(conv1, " ", "");
  } catch {
    threw = true;
  }
  assert("empty message does not throw", !threw);
  const ev1 = await getEvents(conv1);
  assert("empty-message conversation still stored 2 events",
    ev1.length === 2, `got ${ev1.length}`);

  // 2. Very long message (60 KB) → stored verbatim without truncation errors
  const conv2 = uuidv4();
  const longMsg = "I really really love " + "sushi ".repeat(10_000);
  let threw2 = false;
  try {
    await runTurn(conv2, longMsg, "ok");
  } catch {
    threw2 = true;
  }
  assert("60KB message pipeline does not throw", !threw2);
  const row2 = queryOne(
    "SELECT LENGTH(content) as len FROM events WHERE conversation_id = ? AND role = 'user'",
    [conv2]
  ) as any;
  assert("long message persisted at full length",
    row2?.len === longMsg.length, `len=${row2?.len} expected=${longMsg.length}`);

  // 3. Unicode / emoji
  const conv3 = uuidv4();
  const unicodeMsg = "私の好きな飲み物は抹茶です。😊🍵 Café résumé — naïve";
  await runTurn(conv3, unicodeMsg, "👍");
  const row3 = queryOne(
    "SELECT content FROM events WHERE conversation_id = ? AND role = 'user'",
    [conv3]
  ) as any;
  assert("unicode + emoji content round-trips unchanged",
    row3?.content === unicodeMsg, `got=${row3?.content?.slice(0, 30)}`);

  // 4. SQL-injection-looking string stays a literal
  const conv4 = uuidv4();
  const sqlMsg = "My password is '; DROP TABLE memory_items; --";
  await runTurn(conv4, sqlMsg, "oh no");
  // memory_items table should still exist and be queryable
  const stillThere = queryAll("SELECT COUNT(*) as c FROM memory_items") as any[];
  assert("SQL-injection attempt does NOT drop memory_items",
    Array.isArray(stillThere) && typeof stillThere[0]?.c === "number");
  const row4 = queryOne(
    "SELECT content FROM events WHERE conversation_id = ? AND role = 'user'",
    [conv4]
  ) as any;
  assert("SQL-looking message stored as plain content",
    row4?.content === sqlMsg);

  // 5. Rapid-fire writes within the same second — ordering stays deterministic
  const conv5 = uuidv4();
  ensureConversation(conv5, "burst start");
  const bursts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const e = await storeEvent(conv5, "user", `burst ${i}`, "test");
    bursts.push(e.id);
  }
  const recent = await getRecentTurns(conv5, 4);
  // recent returns chronological order: should be bursts[2..5]
  assert("rapid-fire burst is retrieved in insertion order",
    recent.length === 4 &&
    recent.map(r => r.id).join(",") === bursts.slice(2).join(","),
    `got=${recent.map(r => r.content).join(",")}`);
}

// ─── adversarial: noisy haystack still surfaces the relevant memory ──────────

async function testNoisyHaystack(): Promise<void> {
  console.log("\n=== adversarial: noisy haystack ===");
  await freshDb();

  const convId = uuidv4();

  // State a clear preference buried in the middle of 20 unrelated turns.
  const noise = [
    "What's the weather like in Tokyo?",
    "Can you recommend a book about machine learning?",
    "What is the best programming language for web scraping?",
    "How do I fix a leaky faucet?",
    "What are some healthy breakfast options?",
    "Tell me about the history of the Roman Empire.",
    "What's a good exercise routine for beginners?",
    "How do I start a vegetable garden?",
    "What are the rules of chess?",
    "Can you help me write a haiku?",
  ];

  for (let i = 0; i < 10; i++) {
    await runTurn(convId, noise[i], "short answer");
  }

  await runTurn(convId,
    "Important: I am severely allergic to peanuts. Always exclude peanuts from any food suggestion.",
    "Understood — noted.");

  for (let i = 0; i < 10; i++) {
    await runTurn(convId, noise[i] + " (again)", "short answer");
  }

  // Query whose structured/verbatim lanes should retrieve the peanut warning.
  const q = await runTurn(convId, "Can you recommend a dessert for dinner?", "—");
  const ctx = q.compiled.contextText.toLowerCase();

  assert("haystack: peanut allergy surfaced in context for food query",
    ctx.includes("peanut") || ctx.includes("allerg"),
    `ctx=${ctx.slice(0, 300)}`);

  // And the context must respect the token budget — not dump all 42 events.
  assert("haystack: context did not blow up to >50 items",
    q.compiled.includedIds.length <= 30,
    `included=${q.compiled.includedIds.length}`);
}

// ─── adversarial: delete conversation cleans up everything ───────────────────

async function testAdversarialDeleteCleanup(): Promise<void> {
  console.log("\n=== adversarial: delete conversation cleans up ===");
  await freshDb();

  const convId = uuidv4();
  await runTurn(convId, "I prefer aisle seats.", "noted");
  await runTurn(convId, "I also prefer vegetarian meals.", "noted");

  // Confirm state exists
  const before = queryAll(
    "SELECT (SELECT COUNT(*) FROM events WHERE conversation_id = ?) as e, (SELECT COUNT(*) FROM context_snapshots WHERE event_id IN (SELECT id FROM events WHERE conversation_id = ?)) as s, (SELECT COUNT(*) FROM memory_items WHERE source_event_id IN (SELECT id FROM events WHERE conversation_id = ?)) as m",
    [convId, convId, convId]
  ) as any[];
  assert("before delete: events > 0",  before[0].e > 0);
  assert("before delete: snapshots > 0", before[0].s > 0);
  assert("before delete: memory > 0",  before[0].m > 0);

  // Delete
  let threw = false;
  try {
    deleteConversation(convId);
  } catch {
    threw = true;
  }
  assert("deleteConversation does not throw under FK enforcement", !threw);

  const after = queryAll(
    "SELECT (SELECT COUNT(*) FROM events WHERE conversation_id = ?) as e, (SELECT COUNT(*) FROM context_snapshots WHERE event_id IN (SELECT id FROM events WHERE conversation_id = ?)) as s, (SELECT COUNT(*) FROM memory_items WHERE source_event_id IN (SELECT id FROM events WHERE conversation_id = ?)) as m, (SELECT COUNT(*) FROM conversations WHERE id = ?) as c",
    [convId, convId, convId, convId]
  ) as any[];
  assert("after delete: 0 events",    after[0].e === 0);
  assert("after delete: 0 snapshots", after[0].s === 0);
  assert("after delete: 0 memory",    after[0].m === 0);
  assert("after delete: 0 conversation row", after[0].c === 0);
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("RecallOS — End-to-End Tests");
  console.log("============================\n");

  await testPipelineBasic();
  await testPipelineMultiTurn();
  await testPipelineProjectScoping();
  await testAdversarialInputs();
  await testNoisyHaystack();
  await testAdversarialDeleteCleanup();

  console.log("\n============================");
  console.log(`Passed: ${passed} / ${passed + failed}`);
  if (failed > 0) {
    console.log(`FAILED: ${failed}`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  console.log("All end-to-end tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
