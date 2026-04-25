/**
 * Signal-ablation runner for the hybrid retriever.
 *
 * Runs the LongMemEval bench 6 times on the same question slice:
 *   1. baseline         — all 5 signals enabled
 *   2. no-bm25          — BM25 zeroed
 *   3. no-temporal      — temporal-proximity zeroed
 *   4. no-preference    — preference-evidence zeroed
 *   5. no-role          — role-boost zeroed
 *   6. no-semantic      — semantic cosine zeroed
 *
 * For each run it spawns a fresh `npx tsx src/bench/longmemeval.ts` subprocess
 * with DISABLE_SIGNALS=<name> in its env (the verbatim retriever reads that
 * var once at module load).  Individual per-question JSONL outputs land in
 * ablation-<signal>-limit<N>.jsonl so you can diff them afterwards.
 *
 * At the end, this script prints a table of overall R@5 per ablation vs the
 * baseline, so you can read off each signal's marginal contribution.
 *
 * Usage:
 *   npx tsx src/bench/ablation.ts --limit 50
 *     (scores 5 × 50 questions ≈ 75 minutes on CPU embeddings)
 *
 *   npx tsx src/bench/ablation.ts --limit 500
 *     (full 500-question ablation; ~12 hours, only run unattended)
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const LIMIT = flag("--limit") ? parseInt(flag("--limit")!, 10) : 50;
const CATEGORY = flag("--category");
/**
 * `--stratified` makes each subprocess pick the first floor(LIMIT/6) questions
 * from each of the 6 LongMemEval categories instead of slicing linearly from
 * the start.  Without this, a 50-question ablation only exercises BM25 on
 * single-session-user and reports 0 contribution for temporal / preference
 * / role / semantic — which is meaningless.
 */
const STRATIFIED = args.includes("--stratified");

const SIGNALS = ["bm25", "temporal", "preference", "role", "semantic"] as const;
type Signal = typeof SIGNALS[number];

interface RunSummary {
  name: string;
  r5: number | null;
  r10: number | null;
  ndcg5: number | null;
  mrr: number | null;
  out_path: string;
}

/** Kick off a child tsx process, wait for it to exit, return its stdout. */
function runBenchOnce(label: string, disableSignals: string): Promise<{ out: string; err: string; code: number }> {
  const tag = `${STRATIFIED ? "strat" : "limit"}${LIMIT}${CATEGORY ? `-${CATEGORY}` : ""}`;
  const outPath = `ablation-${label}-${tag}.jsonl`;
  const env = { ...process.env, USE_LOCAL_EMBEDDINGS: "1", EMBEDDING_MAX_NEW_PER_CALL: "300", DISABLE_SIGNALS: disableSignals };
  const argv = ["tsx", "src/bench/longmemeval.ts", "--limit", String(LIMIT), "--out", outPath];
  if (CATEGORY) argv.push("--category", CATEGORY);
  if (STRATIFIED) argv.push("--stratified");

  return new Promise((resolve) => {
    const child = spawn("npx", argv, { env, cwd: process.cwd(), shell: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString(); process.stdout.write(d); });
    child.stderr.on("data", (d) => { err += d.toString(); process.stderr.write(d); });
    child.on("close", (code) => resolve({ out, err, code: code ?? -1 }));
  });
}

/** Compute overall metrics from a per-question JSONL file. */
function summarize(label: string, jsonlPath: string): RunSummary {
  if (!fs.existsSync(jsonlPath)) {
    return { name: label, r5: null, r10: null, ndcg5: null, mrr: null, out_path: jsonlPath };
  }
  const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
  if (lines.length === 0) {
    return { name: label, r5: null, r10: null, ndcg5: null, mrr: null, out_path: jsonlPath };
  }
  let r5 = 0, r10 = 0, ndcg5 = 0, mrr = 0;
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      r5 += r.recall_at_5 ?? 0;
      r10 += r.recall_at_10 ?? 0;
      ndcg5 += r.ndcg_at_5 ?? 0;
      mrr += r.mrr ?? 0;
    } catch { /* skip */ }
  }
  return {
    name: label,
    r5: r5 / lines.length,
    r10: r10 / lines.length,
    ndcg5: ndcg5 / lines.length,
    mrr: mrr / lines.length,
    out_path: jsonlPath,
  };
}

async function main(): Promise<void> {
  const tag = `${STRATIFIED ? "strat" : "limit"}${LIMIT}${CATEGORY ? `-${CATEGORY}` : ""}`;
  console.log(
    `=== Signal ablation: limit=${LIMIT}${CATEGORY ? ` category=${CATEGORY}` : ""}` +
      `${STRATIFIED ? " (stratified across categories)" : ""} ===\n`
  );
  const summaries: RunSummary[] = [];

  // Baseline first.
  console.log(">>> Run 1/6: baseline (all signals enabled)");
  await runBenchOnce("baseline", "");
  summaries.push(summarize("baseline", `ablation-baseline-${tag}.jsonl`));

  // One signal-off run per signal.
  for (let i = 0; i < SIGNALS.length; i++) {
    const sig: Signal = SIGNALS[i];
    console.log(`\n>>> Run ${i + 2}/6: no-${sig}`);
    await runBenchOnce(`no-${sig}`, sig);
    summaries.push(summarize(`no-${sig}`, `ablation-no-${sig}-${tag}.jsonl`));
  }

  // ─── Report ────────────────────────────────────────────────────────────────
  console.log("\n\n=== Ablation summary ===");
  const header = "Run                N    R@5    R@10   NDCG@5  MRR    Δ R@5 vs baseline";
  console.log(header);
  console.log("─".repeat(header.length));
  const baselineR5 = summaries[0]?.r5 ?? null;
  for (const s of summaries) {
    const delta = s.r5 !== null && baselineR5 !== null && s.name !== "baseline"
      ? `   ${(s.r5 - baselineR5 >= 0 ? "+" : "")}${(s.r5 - baselineR5).toFixed(3)}`
      : "       —";
    const n = fs.existsSync(s.out_path)
      ? fs.readFileSync(s.out_path, "utf-8").split("\n").filter(Boolean).length
      : 0;
    const fmt = (v: number | null) => v === null ? "  —  " : v.toFixed(3);
    console.log(
      s.name.padEnd(17) +
        String(n).padStart(3) +
        "  " +
        fmt(s.r5).padStart(5) +
        "  " +
        fmt(s.r10).padStart(5) +
        "  " +
        fmt(s.ndcg5).padStart(5) +
        "   " +
        fmt(s.mrr).padStart(5) +
        delta
    );
  }
  console.log("\nSignals ranked by marginal R@5 (baseline − no-signal):");
  const contribs = summaries
    .filter((s) => s.name !== "baseline" && s.r5 !== null && baselineR5 !== null)
    .map((s) => ({ signal: s.name.replace("no-", ""), contrib: (baselineR5 ?? 0) - (s.r5 ?? 0) }))
    .sort((a, b) => b.contrib - a.contrib);
  for (const c of contribs) {
    console.log(`  ${c.signal.padEnd(12)} +${c.contrib.toFixed(3)} R@5`);
  }

  // Write the summary as JSON so the writeup/regression scripts can pick it up.
  const summaryPath = `ablation-summary-${tag}.json`;
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      { limit: LIMIT, category: CATEGORY ?? null, stratified: STRATIFIED, summaries, contribs },
      null,
      2
    )
  );
  console.log(`\nSummary written to ${summaryPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
