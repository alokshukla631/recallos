/**
 * Regression guard for the hybrid retriever.
 *
 * Runs a hand-picked slice of 13 LongMemEval-s question IDs and asserts
 * each one still hits at-or-above its pinned rank.  These are not
 * arbitrary questions — every ID in the canary list hits a specific
 * regression mode we've seen and fixed during tuning:
 *
 *   - 2 per category (12 total) — broad coverage of all 6 LongMemEval
 *     categories, so a silent category-wide regression can't sneak past.
 *   - 505af2f5 specifically — the "coffee creamer recipe" preference
 *     question that broke in v3 when the gardening domain-anchor fired
 *     on the word "recipe" and polluted the BM25 query with
 *     tomato/basil/lettuce extras.  The v4 fix (narrow the anchor) took
 *     it from R@5=0 back to R@5=1 at rank 3.  Pinned here so any
 *     future broadening of that anchor gets caught immediately.
 *
 * Runtime: ≈ 60–90 s on local MiniLM-L6 embeddings (13 questions ×
 * ~6 s each of seeding + scoring).  Cheap enough to run before every
 * PR, slow enough that we don't run it on every save.
 *
 * Usage:
 *   npx tsx src/bench/regression-guard.ts
 *   USE_LOCAL_EMBEDDINGS=1 EMBEDDING_MAX_NEW_PER_CALL=300 \
 *     npx tsx src/bench/regression-guard.ts
 *
 * Exit codes:
 *   0 — every canary still meets its pinned max rank.
 *   1 — at least one canary regressed.  The failing IDs and their
 *       current vs. pinned rank are printed so the diff is obvious.
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";

interface Canary {
  id: string;
  category: string;
  question: string;
  /** Rank must be ≤ this value for the guard to pass. */
  max_rank: number;
}

/**
 * Hand-picked canaries.  Pinned to the current (v4) 500-question result
 * from longmemeval-semantic-tuned-v4.jsonl.  When legitimately improving
 * the retriever, feel free to tighten these numbers — just make sure the
 * full 500-question run still clears 0.978 R@5 before you do.
 */
const CANARIES: Canary[] = [
  // single-session-user
  { id: "e47becba", category: "single-session-user", question: "What degree did I graduate with?",                                    max_rank: 1 },
  { id: "118b2229", category: "single-session-user", question: "How long is my daily commute to work?",                               max_rank: 1 },
  // multi-session
  { id: "0a995998",       category: "multi-session", question: "How many items of clothing do I need to pick up or return?",         max_rank: 1 },
  { id: "gpt4_59c863d7",  category: "multi-session", question: "How many model kits have I worked on or bought?",                    max_rank: 1 },
  // single-session-preference (includes the coffee-creamer canary)
  { id: "8a2466db",  category: "single-session-preference", question: "Can you recommend some resources where I can learn more about video editing?", max_rank: 1 },
  { id: "06878be2",  category: "single-session-preference", question: "Can you suggest some accessories that would complement my current photography setup?", max_rank: 1 },
  { id: "505af2f5",  category: "single-session-preference", question: "I was thinking of trying a new coffee creamer recipe. Any recommendations?",   max_rank: 5 },
  // temporal-reasoning
  { id: "gpt4_59149c77", category: "temporal-reasoning", question: "How many days passed between my visit to MoMA and the Ancient…", max_rank: 1 },
  { id: "gpt4_f49edff3", category: "temporal-reasoning", question: "Which three events happened in the order from first to last…",  max_rank: 1 },
  // knowledge-update
  { id: "6a1eabeb", category: "knowledge-update", question: "What was my personal best time in the charity 5K run?",                 max_rank: 1 },
  { id: "6aeb4375", category: "knowledge-update", question: "How many Korean restaurants have I tried in my city?",                  max_rank: 1 },
  // single-session-assistant
  { id: "7161e7e2", category: "single-session-assistant", question: "I'm checking our previous chat about the shift rotation sheet…",max_rank: 1 },
  { id: "c4f10528", category: "single-session-assistant", question: "I'm planning to visit Bandung again…",                          max_rank: 1 },
];

/** Run longmemeval.ts with --ids=<all canary ids> and wait for it to finish. */
function runBench(outPath: string): Promise<number> {
  const ids = CANARIES.map((c) => c.id).join(",");
  const env = {
    ...process.env,
    USE_LOCAL_EMBEDDINGS: process.env.USE_LOCAL_EMBEDDINGS ?? "1",
    EMBEDDING_MAX_NEW_PER_CALL: process.env.EMBEDDING_MAX_NEW_PER_CALL ?? "300",
  };
  const argv = ["tsx", "src/bench/longmemeval.ts", "--ids", ids, "--out", outPath];
  return new Promise((resolve) => {
    const child = spawn("npx", argv, { env, cwd: process.cwd(), shell: true });
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

async function main(): Promise<void> {
  const outPath = path.join(process.cwd(), `regression-guard-${Date.now()}.jsonl`);
  console.log(`=== Regression guard: ${CANARIES.length} canary questions ===\n`);

  const code = await runBench(outPath);
  if (code !== 0) {
    console.error(`\nBench subprocess exited ${code} before the guard could read results.`);
    process.exit(1);
  }

  if (!fs.existsSync(outPath)) {
    console.error(`\nBench produced no output file at ${outPath}.`);
    process.exit(1);
  }

  const lines = fs.readFileSync(outPath, "utf-8").split("\n").filter(Boolean);
  const resultsById = new Map<string, { rank: number | null; r5: number; category: string }>();
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      resultsById.set(r.question_id, {
        rank: r.rank ?? null,
        r5: r.recall_at_5 ?? 0,
        category: r.question_type ?? "unknown",
      });
    } catch {
      /* skip malformed */
    }
  }

  console.log("\n=== Guard report ===");
  console.log("ID                     Category                    Rank  Pinned  Status");
  console.log("─".repeat(80));
  let failed = 0;
  for (const c of CANARIES) {
    const actual = resultsById.get(c.id);
    const rank = actual?.rank ?? null;
    const status = rank !== null && rank <= c.max_rank ? "PASS" : "FAIL";
    if (status === "FAIL") failed++;
    const rankStr = rank === null ? "—" : String(rank);
    console.log(
      c.id.padEnd(22) +
        " " +
        c.category.padEnd(27) +
        " " +
        rankStr.padStart(4) +
        "  " +
        String(c.max_rank).padStart(6) +
        "  " +
        status
    );
  }
  console.log("─".repeat(80));
  console.log(`${CANARIES.length - failed} / ${CANARIES.length} canaries passed`);

  // Clean up the temp file unless the user asked to keep it.
  if (!process.env.KEEP_GUARD_JSONL) {
    try { fs.unlinkSync(outPath); } catch { /* ignore */ }
  } else {
    console.log(`\nPer-question JSONL: ${outPath}`);
  }

  if (failed > 0) {
    console.error(`\n✗ ${failed} canary question(s) regressed.  See the table above.`);
    console.error(
      `  Re-run with KEEP_GUARD_JSONL=1 to inspect the full retrieval trace, ` +
      `then run bench:longmemeval on the full 500-question set to quantify the regression.`
    );
    process.exit(1);
  }
  console.log(`\n✓ All ${CANARIES.length} canaries still rank ≤ pinned max.  Retriever is not regressed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
