/**
 * LoCoMo runner — official dataset from the snap-research/locomo paper.
 *
 * Loads `backend/data/locomo/locomo10.json` (10 multi-session conversations,
 * ~2000 QA pairs total, 5 question categories) and scores RecallOS's retrieval
 * at the *turn* level (dia_id) — which is LoCoMo's native evaluation granularity.
 *
 * LoCoMo ≠ LongMemEval:
 *   - 10 long conversations (15–35 sessions each) instead of 500 independent
 *     haystacks of ~50 sessions each.
 *   - Evidence is a list of dia_ids (e.g. ["D2:3", "D4:11"]) — turn pointers,
 *     not session pointers.  We therefore score at event granularity: retrieve
 *     top-K events, check if any evidence dia_id is in that list, record the
 *     rank of the first hit.
 *   - Categories are numeric (1 single-hop, 2 multi-hop, 3 temporal, 4 open-
 *     domain, 5 adversarial).  Cat 5 typically has answer=null (the question
 *     is unanswerable given the conversation) and no evidence — we skip those
 *     from retrieval scoring since there is no gold to find.
 *
 * Critically, this runner calls exactly the same `searchVerbatim` entry point
 * as longmemeval.ts with zero retriever changes.  The goal is to stress-test
 * generalization: does the anchor/gate/aggregation tuning we did for
 * LongMemEval hold up on a different benchmark?
 *
 * Run:  npx tsx src/bench/locomo.ts [--samples 10] [--out path.jsonl]
 *   Flags:  --samples N   only run the first N of the 10 conversations
 *           --out path    write per-question JSONL results
 */

import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { initDatabase, runSql } from "../db/index.js";
import { classifyQuery } from "../modules/query-classifier.js";
import { searchVerbatim } from "../modules/verbatim-retriever.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type LCTurn = {
  speaker: string;
  dia_id: string;               // "D<session>:<turn>", e.g. "D1:3"
  text: string;
  blip_caption?: string;        // multimodal caption, ignored for text-only retrieval
  img_url?: string[];
};

type LCQuestion = {
  question: string;
  answer: string | null;
  evidence?: string[];          // list of dia_ids
  category: number;             // 1..5
  adversarial_answer?: string;  // for cat 5 when answer is null
};

type LCSample = {
  sample_id: string;
  qa: LCQuestion[];
  conversation: Record<string, unknown>; // session_N -> LCTurn[], session_N_date_time -> string
};

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const SAMPLES = flag("--samples") ? parseInt(flag("--samples")!, 10) : undefined;
const OUT_PATH = flag("--out");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse LoCoMo date strings like "1:56 pm on 8 May, 2023" → Date. */
function parseLCDate(s: string | undefined): Date {
  if (!s) return new Date("2023-01-01T12:00:00");
  // Strip weekday if present.  Replace "on" with a separator.
  const m = s.match(
    /(\d{1,2}):(\d{2})\s*(am|pm)\s*on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i
  );
  if (!m) return new Date("2023-01-01T12:00:00");
  let [, hh, mm, ap, dd, month, yyyy] = m;
  let hour = parseInt(hh, 10) % 12;
  if (ap.toLowerCase() === "pm") hour += 12;
  const mIdx: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7,
    sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  };
  const mi = mIdx[month.toLowerCase()];
  if (mi === undefined) return new Date("2023-01-01T12:00:00");
  const d = new Date(
    parseInt(yyyy, 10),
    mi,
    parseInt(dd, 10),
    hour,
    parseInt(mm, 10),
    0
  );
  return isNaN(d.getTime()) ? new Date("2023-01-01T12:00:00") : d;
}

/** Seed one sample's full conversation tree (all sessions, all turns). */
async function seedSample(sample: LCSample): Promise<void> {
  const conv = sample.conversation as Record<string, unknown>;
  const sessionKeys = Object.keys(conv)
    .filter((k) => /^session_\d+$/.test(k))
    .sort((a, b) => {
      const ai = parseInt(a.split("_")[1], 10);
      const bi = parseInt(b.split("_")[1], 10);
      return ai - bi;
    });

  for (const sk of sessionKeys) {
    const turns = conv[sk] as LCTurn[] | undefined;
    if (!turns || !Array.isArray(turns)) continue;

    const dateStr = conv[`${sk}_date_time`] as string | undefined;
    const sessDate = parseLCDate(dateStr);

    const convId = `${sample.sample_id}__${sk}`;
    runSql(
      `INSERT INTO conversations (id, title, created_at, updated_at)
       VALUES (?, 'locomo-session', ?, ?)`,
      [convId, sessDate.toISOString(), sessDate.toISOString()]
    );

    for (let ti = 0; ti < turns.length; ti++) {
      const t = turns[ti];
      if (!t.dia_id || !t.text) continue;
      const createdAt = new Date(sessDate.getTime() + ti * 60_000).toISOString();
      // Use dia_id directly as event.id so evidence matching is a trivial set
      // membership check after retrieval.  Prefix with sample so dia_ids are
      // globally unique if we ever merge samples.
      const eventId = `${sample.sample_id}__${t.dia_id}`;
      // Prepend the speaker to the content, matching LongMemEval's role tagging.
      // Treat the first speaker as "user" and the other as "assistant" for role-
      // boost scoring.  LoCoMo speakers are symmetric (two humans) so this
      // assignment is arbitrary but consistent within a sample.
      const role = t.speaker === (turns[0]?.speaker ?? t.speaker)
        ? "user"
        : "assistant";
      runSql(
        `INSERT INTO events (id, conversation_id, role, content, provider, created_at)
         VALUES (?, ?, ?, ?, 'locomo', ?)`,
        [eventId, convId, role, `${t.speaker}: ${t.text}`, createdAt]
      );
    }
  }
}

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

interface CategoryAgg {
  n: number;
  // Turn-level (LoCoMo native — gold is a list of dia_ids)
  r5: number;
  r10: number;
  ndcg5: number;
  ndcg10: number;
  mrr: number;
  // Session-level (first retrieved turn's conversation_id is the gold session)
  s_r5: number;
  s_r10: number;
  s_mrr: number;
}
function emptyAgg(): CategoryAgg {
  return {
    n: 0,
    r5: 0, r10: 0, ndcg5: 0, ndcg10: 0, mrr: 0,
    s_r5: 0, s_r10: 0, s_mrr: 0,
  };
}

const CATEGORY_NAME: Record<number, string> = {
  1: "single-hop",
  2: "multi-hop",
  3: "temporal",
  4: "open-domain",
  5: "adversarial",
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dataPath = path.join(process.cwd(), "data", "locomo", "locomo10.json");
  if (!fs.existsSync(dataPath)) {
    console.error(`Dataset not found at ${dataPath}`);
    console.error(
      "Download with:\n  gh api repos/snap-research/locomo/git/blobs/d95b872480b413d935821fdc3c84f8a8f5f29e73 \\\n" +
      "    --jq .content | base64 -d > backend/data/locomo/locomo10.json"
    );
    process.exit(1);
  }

  console.log("Loading LoCoMo dataset…");
  const allSamples = JSON.parse(
    fs.readFileSync(dataPath, "utf-8")
  ) as LCSample[];

  const samples = SAMPLES ? allSamples.slice(0, SAMPLES) : allSamples;
  const totalQA = samples.reduce((n, s) => n + s.qa.length, 0);
  console.log(
    `Running ${samples.length} conversations / ${totalQA} QA pairs\n`
  );

  const perCategory = new Map<number, CategoryAgg>();
  const perQuestionLog: Array<Record<string, unknown>> = [];
  let skippedNoEvidence = 0;
  let done = 0;
  const t0 = performance.now();

  for (let si = 0; si < samples.length; si++) {
    const sample = samples[si];
    const dbPath = path.join(os.tmpdir(), `recallos-locomo-${uuidv4()}.db`);
    await initDatabase(dbPath);
    await seedSample(sample);

    for (const q of sample.qa) {
      // Skip questions with no evidence (mostly cat 5 / adversarial — the
      // question is unanswerable from the conversation, so there's no gold
      // to retrieve).
      if (!q.evidence || q.evidence.length === 0) {
        skippedNoEvidence += 1;
        continue;
      }

      const classification = classifyQuery(q.question);
      const snippets = await searchVerbatim(q.question, {
        maxResults: 50,
        temporalAnchor: classification.temporalAnchor,
        isAssistantQuery: classification.type === "assistant_recall",
      });

      // Build the set of gold dia_ids, prefixed with sample_id to match how
      // we seeded them.
      const goldEventIds = new Set(
        q.evidence.map((d) => `${sample.sample_id}__${d}`)
      );
      // Also build the set of gold conversation_ids (session scope) — LoCoMo's
      // dia_id "D<N>:<T>" implies the session is "session_N".  We compute a
      // second rank at session granularity so the number is apples-to-apples
      // with LongMemEval-style session recall.
      const goldConvIds = new Set(
        q.evidence.map((d) => {
          const m = d.match(/^D(\d+):/);
          return m ? `${sample.sample_id}__session_${m[1]}` : "";
        })
      );

      // Turn-level rank: index+1 of the first retrieved event whose event_id
      // is gold.  This is LoCoMo's native evaluation granularity.
      let rank: number | null = null;
      for (let i = 0; i < snippets.length; i++) {
        if (goldEventIds.has(snippets[i].event_id)) {
          rank = i + 1;
          break;
        }
      }

      // Session-level rank: fold the event list to unique conversation_ids
      // (first-occurrence wins) and find the rank of the first gold session.
      // This mirrors the LongMemEval metric so cross-benchmark numbers are
      // directly comparable.
      let sessionRank: number | null = null;
      const seenConvs = new Set<string>();
      const sessionOrder: string[] = [];
      for (const s of snippets) {
        if (!seenConvs.has(s.conversation_id)) {
          seenConvs.add(s.conversation_id);
          sessionOrder.push(s.conversation_id);
        }
      }
      for (let i = 0; i < sessionOrder.length; i++) {
        if (goldConvIds.has(sessionOrder[i])) {
          sessionRank = i + 1;
          break;
        }
      }

      const m = metrics(rank);
      const mSess = metrics(sessionRank);

      const bucket = perCategory.get(q.category) ?? emptyAgg();
      bucket.n += 1;
      bucket.r5 += m.recall_at_5;
      bucket.r10 += m.recall_at_10;
      bucket.ndcg5 += m.ndcg_at_5;
      bucket.ndcg10 += m.ndcg_at_10;
      bucket.mrr += m.mrr;
      bucket.s_r5 += mSess.recall_at_5;
      bucket.s_r10 += mSess.recall_at_10;
      bucket.s_mrr += mSess.mrr;
      perCategory.set(q.category, bucket);

      perQuestionLog.push({
        sample_id: sample.sample_id,
        question: q.question,
        category: q.category,
        category_name: CATEGORY_NAME[q.category] ?? String(q.category),
        rank: m.rank,
        recall_at_5: m.recall_at_5,
        recall_at_10: m.recall_at_10,
        ndcg_at_5: m.ndcg_at_5,
        ndcg_at_10: m.ndcg_at_10,
        mrr: m.mrr,
        session_rank: mSess.rank,
        session_recall_at_5: mSess.recall_at_5,
        session_recall_at_10: mSess.recall_at_10,
        session_mrr: mSess.mrr,
        classifier_type: classification.type,
        n_evidence: q.evidence.length,
      });

      done += 1;
      if (done % 100 === 0) {
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        console.log(`[${done} scored] ${elapsed}s elapsed (sample ${si + 1}/${samples.length})`);
        if (OUT_PATH) {
          try {
            fs.writeFileSync(
              OUT_PATH,
              perQuestionLog.map((r) => JSON.stringify(r)).join("\n") + "\n"
            );
          } catch { /* ignore */ }
        }
      }
    }

    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }

  console.log("");
  if (skippedNoEvidence > 0) {
    console.log(
      `ℹ  ${skippedNoEvidence} questions skipped (no evidence — typically adversarial cat-5)\n`
    );
  }

  // ─── Report ────────────────────────────────────────────────────────────────
  // Two blocks: turn-level (LoCoMo native) and session-level (apples-to-apples
  // with LongMemEval).  Turn-level asks "did we retrieve the exact dia_id?";
  // session-level asks "did we retrieve the session containing it?" — the
  // question most LongMemEval-derived memory systems report against.
  const cats = [1, 2, 3, 4, 5];

  const renderBlock = (
    title: string,
    r5: (b: CategoryAgg) => number,
    r10: (b: CategoryAgg) => number,
    mrr: (b: CategoryAgg) => number
  ) => {
    console.log(`\n=== ${title} ===`);
    const header = "Category                      N    R@5    R@10   MRR";
    const rule = "─".repeat(header.length);
    console.log(header);
    console.log(rule);
    let tN = 0, tR5 = 0, tR10 = 0, tMrr = 0;
    for (const c of cats) {
      const b = perCategory.get(c);
      if (!b || b.n === 0) continue;
      const a = (v: number) => (v / b.n).toFixed(3);
      console.log(
        (CATEGORY_NAME[c] ?? String(c)).padEnd(28) +
          String(b.n).padStart(3) +
          "  " +
          a(r5(b)).padStart(5) +
          "  " +
          a(r10(b)).padStart(5) +
          "  " +
          a(mrr(b)).padStart(5)
      );
      tN += b.n; tR5 += r5(b); tR10 += r10(b); tMrr += mrr(b);
    }
    console.log(rule);
    const a = (v: number) => (v / tN).toFixed(3);
    console.log(
      "Overall".padEnd(28) +
        String(tN).padStart(3) +
        "  " +
        a(tR5).padStart(5) +
        "  " +
        a(tR10).padStart(5) +
        "  " +
        a(tMrr).padStart(5)
    );
  };

  renderBlock(
    "Turn-level recall (LoCoMo native — gold dia_id in top-K events)",
    (b) => b.r5, (b) => b.r10, (b) => b.mrr
  );
  renderBlock(
    "Session-level recall (apples-to-apples with LongMemEval)",
    (b) => b.s_r5, (b) => b.s_r10, (b) => b.s_mrr
  );

  if (OUT_PATH) {
    try {
      fs.writeFileSync(
        OUT_PATH,
        perQuestionLog.map((r) => JSON.stringify(r)).join("\n") + "\n"
      );
      console.log(`\nPer-question log written to ${OUT_PATH}`);
    } catch (err) {
      console.error(`\nFailed to write ${OUT_PATH}: ${err}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
