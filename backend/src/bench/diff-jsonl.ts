/**
 * Diff two per-question LongMemEval JSONL logs: show questions whose rank or
 * R@5 changed between the two runs.
 *
 * Usage:  npx tsx src/bench/diff-jsonl.ts before.jsonl after.jsonl
 */
import fs from "node:fs";
import path from "node:path";

interface Row {
  question_id: string;
  question_type: string;
  rank: number | null;
  recall_at_5: number;
  classifier_type?: string;
}

function load(file: string): Map<string, Row> {
  const map = new Map<string, Row>();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Row;
      map.set(row.question_id, row);
    } catch {
      // skip
    }
  }
  return map;
}

function main(): void {
  const [beforeFile, afterFile] = process.argv.slice(2);
  if (!beforeFile || !afterFile) {
    console.error("usage: diff-jsonl.ts before.jsonl after.jsonl");
    process.exit(1);
  }
  const before = load(beforeFile);
  const after = load(afterFile);
  const ids = new Set<string>([...before.keys(), ...after.keys()]);
  let improved = 0;
  let regressed = 0;
  const changes: Array<{
    id: string;
    cat: string;
    beforeRank: number | null;
    afterRank: number | null;
    delta: number;
  }> = [];
  for (const id of ids) {
    const b = before.get(id);
    const a = after.get(id);
    if (!b || !a) continue;
    if (b.recall_at_5 !== a.recall_at_5 || b.rank !== a.rank) {
      const delta = (a.recall_at_5 ?? 0) - (b.recall_at_5 ?? 0);
      if (delta > 0) improved++;
      else if (delta < 0) regressed++;
      changes.push({
        id,
        cat: a.question_type || b.question_type,
        beforeRank: b.rank ?? null,
        afterRank: a.rank ?? null,
        delta,
      });
    }
  }
  console.log(
    `=== ${path.basename(beforeFile)}  ->  ${path.basename(afterFile)} ===`,
  );
  console.log(
    `improved=${improved} regressed=${regressed} total-changed=${changes.length}`,
  );
  changes.sort(
    (x, y) =>
      x.delta - y.delta || x.cat.localeCompare(y.cat) || x.id.localeCompare(y.id),
  );
  for (const c of changes) {
    const arrow = c.delta > 0 ? "++" : c.delta < 0 ? "--" : "==";
    console.log(
      `${arrow} ${c.cat.padEnd(28)} ${c.id.padEnd(12)} rank ${String(
        c.beforeRank,
      ).padStart(3)} -> ${String(c.afterRank).padStart(3)}`,
    );
  }
}

main();
