/**
 * LongMemEval runner — official dataset.
 *
 * Loads `backend/data/longmemeval/longmemeval_s.json` (500 questions across
 * 6 categories) and scores RecallOS's retrieval on the session-level Recall@K
 * metric MemPalace reports against.
 *
 * For each question:
 *   1. Spin up a fresh in-memory DB.
 *   2. Seed `haystack_sessions` (40-50 sessions, each a list of {role, content}
 *      turns) as `conversations` + `events` rows. Each event's created_at is
 *      derived from the session's haystack_date + per-turn offset so the
 *      temporal-anchor boost in searchVerbatim has realistic times to work with.
 *   3. Classify the query (assistant_recall / temporal_history / …) so the
 *      retriever gets the right signals.
 *   4. Call searchVerbatim with maxResults=50 (enough to compute R@5 and R@10
 *      at session granularity, since multiple events may come from the same
 *      session).
 *   5. Fold the ranked event list into a ranked *session* list (first
 *      occurrence of each conversation_id wins).
 *   6. Record the rank of the first `answer_session_id` in that list.
 *
 * Outputs per-category R@5, R@10, NDCG@5, NDCG@10, MRR, matching the reporting
 * format used by MemPalace and the LongMemEval paper.
 *
 * Run with: npm run bench:longmemeval  (from backend/)
 *   Flags:  --limit N   run only the first N questions (smoke test)
 *           --category X  only run questions whose question_type === X
 *           --out path.jsonl  write per-question results to disk
 */

import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { initDatabase, runSql } from "../db/index.js";
import { classifyQuery } from "../modules/query-classifier.js";
import { searchVerbatim } from "../modules/verbatim-retriever.js";

// ─── Types from the official dataset ──────────────────────────────────────────

type LMETurn = {
  role: "user" | "assistant";
  content: string;
};

type LMEQuestion = {
  question_id: string;
  question_type:
    | "single-session-user"
    | "single-session-assistant"
    | "single-session-preference"
    | "multi-session"
    | "temporal-reasoning"
    | "knowledge-update";
  question: string;
  question_date: string;
  answer: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: LMETurn[][];
};

// ─── CLI flags ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const LIMIT = flag("--limit") ? parseInt(flag("--limit")!, 10) : undefined;
const CATEGORY_FILTER = flag("--category");
const OUT_PATH = flag("--out");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse the LongMemEval date format "YYYY/MM/DD (DayName) HH:MM" into an ISO
 * string. Dates without time default to 12:00 local.
 */
function parseLMEDate(s: string): Date {
  // Strip "(Sat)" etc.
  const cleaned = s.replace(/\s*\([^)]+\)\s*/g, " ").trim();
  // Now "YYYY/MM/DD HH:MM" — replace /s for parseable form.
  const iso = cleaned.replace(/\//g, "-").replace(" ", "T");
  const d = new Date(iso.length > 10 ? iso + ":00" : iso + "T12:00:00");
  if (isNaN(d.getTime())) {
    // Fall back to a safe default.
    return new Date("2023-01-01T12:00:00");
  }
  return d;
}

/**
 * Compute session-level rank from an event-level ranking.
 * Returns the 1-based rank of the first event whose conversation_id (= session
 * id) is in `goldSessions`, or null if none found.
 */
function sessionRankFromEvents(
  snippetsOrdered: Array<{ conversation_id: string }>,
  goldSessions: Set<string>
): { rank: number | null; sessionOrder: string[] } {
  const seen = new Set<string>();
  const sessionOrder: string[] = [];
  for (const s of snippetsOrdered) {
    if (!seen.has(s.conversation_id)) {
      seen.add(s.conversation_id);
      sessionOrder.push(s.conversation_id);
    }
  }
  for (let i = 0; i < sessionOrder.length; i++) {
    if (goldSessions.has(sessionOrder[i])) {
      return { rank: i + 1, sessionOrder };
    }
  }
  return { rank: null, sessionOrder };
}

/** Per-question metric computation (binary relevance, one or more gold). */
function metrics(rank: number | null) {
  const recallAt = (k: number) => (rank !== null && rank <= k ? 1 : 0);
  const ndcgAt = (k: number) =>
    rank !== null && rank <= k ? 1 / Math.log2(rank + 1) : 0;
  const mrr = rank !== null && rank <= 10 ? 1 / rank : 0;
  return {
    rank,
    recall_at_5: recallAt(5),
    recall_at_10: recallAt(10),
    ndcg_at_5: ndcgAt(5),
    ndcg_at_10: ndcgAt(10),
    mrr,
  };
}

/** Seed one question's haystack into the current DB.
 *  Some questions have the same session_id listed twice (data artefact);
 *  dedupe on first occurrence so conversations.id stays unique.
 */
async function seedHaystack(q: LMEQuestion): Promise<void> {
  const seenSessions = new Set<string>();
  const sessionCount = q.haystack_sessions.length;
  for (let si = 0; si < sessionCount; si++) {
    const sessId = q.haystack_session_ids[si];
    if (seenSessions.has(sessId)) continue;
    seenSessions.add(sessId);

    const sessDate = parseLMEDate(q.haystack_dates[si]);
    const turns = q.haystack_sessions[si];

    // Insert the conversation row (id = session id)
    runSql(
      `INSERT INTO conversations (id, title, created_at, updated_at)
       VALUES (?, 'lme-session', ?, ?)`,
      [sessId, sessDate.toISOString(), sessDate.toISOString()]
    );

    // Insert each turn as an event, spacing them 1 minute apart so ordering
    // inside a session is deterministic and the rowid tiebreak stays stable.
    for (let ti = 0; ti < turns.length; ti++) {
      const turn = turns[ti];
      const createdAt = new Date(sessDate.getTime() + ti * 60_000).toISOString();
      runSql(
        `INSERT INTO events (id, conversation_id, role, content, provider, created_at)
         VALUES (?, ?, ?, ?, 'longmemeval', ?)`,
        [uuidv4(), sessId, turn.role, turn.content, createdAt]
      );
    }
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

interface CategoryAgg {
  n: number;
  r5: number;
  r10: number;
  ndcg5: number;
  ndcg10: number;
  mrr: number;
}

function emptyAgg(): CategoryAgg {
  return { n: 0, r5: 0, r10: 0, ndcg5: 0, ndcg10: 0, mrr: 0 };
}

async function main(): Promise<void> {
  const dataPath = path.join(
    process.cwd(),
    "data",
    "longmemeval",
    "longmemeval_s.json"
  );
  if (!fs.existsSync(dataPath)) {
    console.error(`Dataset not found at ${dataPath}`);
    console.error(
      "Download with:\n  curl -L --ssl-no-revoke -o backend/data/longmemeval/longmemeval_s.json \\\n" +
      "    https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json"
    );
    process.exit(1);
  }

  console.log("Loading LongMemEval dataset…");
  const allQuestions = JSON.parse(
    fs.readFileSync(dataPath, "utf-8")
  ) as LMEQuestion[];

  let questions = allQuestions;
  if (CATEGORY_FILTER) {
    questions = questions.filter((q) => q.question_type === CATEGORY_FILTER);
  }
  if (LIMIT) {
    questions = questions.slice(0, LIMIT);
  }

  console.log(
    `Running ${questions.length} questions` +
      (CATEGORY_FILTER ? ` (category=${CATEGORY_FILTER})` : "") +
      (LIMIT ? ` (limit=${LIMIT})` : "") +
      "\n"
  );

  const perCategory = new Map<string, CategoryAgg>();
  const perQuestionLog: Array<Record<string, unknown>> = [];

  const t0 = performance.now();
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];

    // Fresh DB per question — haystacks are independent.
    const dbPath = path.join(os.tmpdir(), `recallos-lme-${uuidv4()}.db`);
    await initDatabase(dbPath);

    await seedHaystack(q);

    const classification = classifyQuery(q.question);
    const isAssistantQuery =
      q.question_type === "single-session-assistant" ||
      classification.type === "assistant_recall";

    const snippets = await searchVerbatim(q.question, {
      maxResults: 50,
      temporalAnchor: classification.temporalAnchor,
      isAssistantQuery,
    });

    const gold = new Set(q.answer_session_ids);
    const { rank } = sessionRankFromEvents(snippets, gold);
    const m = metrics(rank);

    // Aggregate
    const bucket = perCategory.get(q.question_type) ?? emptyAgg();
    bucket.n += 1;
    bucket.r5 += m.recall_at_5;
    bucket.r10 += m.recall_at_10;
    bucket.ndcg5 += m.ndcg_at_5;
    bucket.ndcg10 += m.ndcg_at_10;
    bucket.mrr += m.mrr;
    perCategory.set(q.question_type, bucket);

    perQuestionLog.push({
      question_id: q.question_id,
      question_type: q.question_type,
      rank: m.rank,
      recall_at_5: m.recall_at_5,
      recall_at_10: m.recall_at_10,
      ndcg_at_5: m.ndcg_at_5,
      ndcg_at_10: m.ndcg_at_10,
      mrr: m.mrr,
      classifier_type: classification.type,
    });

    // Progress indicator
    if ((i + 1) % 10 === 0 || i + 1 === questions.length) {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      process.stdout.write(
        `\r[${i + 1}/${questions.length}] ${elapsed}s elapsed`
      );
    }

    // Clean up the temp DB file so we don't fill /tmp
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }

  console.log("\n");

  // ─── Report ────────────────────────────────────────────────────────────────
  const header =
    "Category                      N    R@5    R@10   NDCG@5 NDCG@10  MRR";
  const rule = "─".repeat(header.length);
  console.log(header);
  console.log(rule);

  const categories = [
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
    "multi-session",
    "temporal-reasoning",
    "knowledge-update",
  ];

  let total = emptyAgg();
  for (const cat of categories) {
    const b = perCategory.get(cat);
    if (!b || b.n === 0) continue;
    const avg = (v: number) => (v / b.n).toFixed(3);
    console.log(
      cat.padEnd(28) +
        String(b.n).padStart(3) +
        "  " +
        avg(b.r5).padStart(5) +
        "  " +
        avg(b.r10).padStart(5) +
        "  " +
        avg(b.ndcg5).padStart(5) +
        "  " +
        avg(b.ndcg10).padStart(6) +
        "   " +
        avg(b.mrr).padStart(5)
    );
    total.n += b.n;
    total.r5 += b.r5;
    total.r10 += b.r10;
    total.ndcg5 += b.ndcg5;
    total.ndcg10 += b.ndcg10;
    total.mrr += b.mrr;
  }

  console.log(rule);
  if (total.n > 0) {
    const avg = (v: number) => (v / total.n).toFixed(3);
    console.log(
      "Overall".padEnd(28) +
        String(total.n).padStart(3) +
        "  " +
        avg(total.r5).padStart(5) +
        "  " +
        avg(total.r10).padStart(5) +
        "  " +
        avg(total.ndcg5).padStart(5) +
        "  " +
        avg(total.ndcg10).padStart(6) +
        "   " +
        avg(total.mrr).padStart(5)
    );
  }

  // Optional per-question dump for later analysis
  if (OUT_PATH) {
    fs.writeFileSync(
      OUT_PATH,
      perQuestionLog.map((r) => JSON.stringify(r)).join("\n") + "\n"
    );
    console.log(`\nPer-question log written to ${OUT_PATH}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
