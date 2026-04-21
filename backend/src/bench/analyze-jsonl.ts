/**
 * Aggregate a LongMemEval per-question JSONL log (concatenated from chunk runs
 * or produced directly) into per-category + overall R@5/R@10/NDCG/MRR numbers.
 *
 * Usage:  npx tsx src/bench/analyze-jsonl.ts path/to/longmemeval-*.jsonl [...more]
 *
 * When multiple paths are given the stats for each file print side by side,
 * which is handy for "baseline vs tuned" diffs.
 */
import fs from "node:fs";
import path from "node:path";

interface Row {
  question_id: string;
  question_type: string;
  rank: number | null;
  recall_at_5: number;
  recall_at_10: number;
  ndcg_at_5: number;
  ndcg_at_10: number;
  mrr: number;
  qa_correct?: number;
  classifier_type?: string;
}

interface Agg {
  n: number;
  r5: number;
  r10: number;
  ndcg5: number;
  ndcg10: number;
  mrr: number;
  qaCorrect: number;
  qaJudged: number;
}

const EMPTY: Agg = {
  n: 0,
  r5: 0,
  r10: 0,
  ndcg5: 0,
  ndcg10: 0,
  mrr: 0,
  qaCorrect: 0,
  qaJudged: 0,
};

function emptyAgg(): Agg {
  return { ...EMPTY };
}

function addRow(a: Agg, row: Row): void {
  a.n += 1;
  a.r5 += row.recall_at_5;
  a.r10 += row.recall_at_10;
  a.ndcg5 += row.ndcg_at_5;
  a.ndcg10 += row.ndcg_at_10;
  a.mrr += row.mrr;
  if (typeof row.qa_correct === "number") {
    a.qaJudged += 1;
    a.qaCorrect += row.qa_correct;
  }
}

function avg(sum: number, n: number): string {
  return n === 0 ? "0.000" : (sum / n).toFixed(3);
}

function loadRows(file: string): Row[] {
  const txt = fs.readFileSync(file, "utf8");
  const rows: Row[] = [];
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Row);
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

function report(file: string): void {
  const rows = loadRows(file);
  const perCat = new Map<string, Agg>();
  const overall = emptyAgg();
  for (const r of rows) {
    addRow(overall, r);
    const bucket = perCat.get(r.question_type) ?? emptyAgg();
    addRow(bucket, r);
    perCat.set(r.question_type, bucket);
  }
  console.log(`\n=== ${path.basename(file)} (rows=${rows.length}) ===`);
  const header =
    "Category                      N    R@5    R@10   NDCG@5 NDCG@10  MRR    QA-Acc";
  console.log(header);
  console.log("-".repeat(header.length));
  const categories = Array.from(perCat.keys()).sort();
  for (const cat of categories) {
    const b = perCat.get(cat)!;
    const qa = b.qaJudged > 0 ? avg(b.qaCorrect, b.qaJudged) : "  -  ";
    console.log(
      cat.padEnd(30) +
        String(b.n).padStart(3) +
        "  " +
        avg(b.r5, b.n).padStart(5) +
        "  " +
        avg(b.r10, b.n).padStart(5) +
        "  " +
        avg(b.ndcg5, b.n).padStart(5) +
        "  " +
        avg(b.ndcg10, b.n).padStart(6) +
        "  " +
        avg(b.mrr, b.n).padStart(5) +
        "  " +
        qa.padStart(5),
    );
  }
  console.log("-".repeat(header.length));
  const qaOverall = overall.qaJudged > 0 ? avg(overall.qaCorrect, overall.qaJudged) : "  -  ";
  console.log(
    "OVERALL".padEnd(30) +
      String(overall.n).padStart(3) +
      "  " +
      avg(overall.r5, overall.n).padStart(5) +
      "  " +
      avg(overall.r10, overall.n).padStart(5) +
      "  " +
      avg(overall.ndcg5, overall.n).padStart(5) +
      "  " +
      avg(overall.ndcg10, overall.n).padStart(6) +
      "  " +
      avg(overall.mrr, overall.n).padStart(5) +
      "  " +
      qaOverall.padStart(5),
  );
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: analyze-jsonl.ts <file.jsonl> [<file2.jsonl> ...]");
    process.exit(1);
  }
  for (const f of files) report(f);
}

void main();
