/**
 * Unit tests for the LME judge output parser.
 * Runs offline — no provider key required.
 *
 *   npm run bench:judge-tests   (from backend/)
 */

import { parseJudgeOutput, pickJudgeProvider } from "./lme-judge.js";

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

console.log("=== parseJudgeOutput ===");

// Happy path: clean JSON.
{
  const r = parseJudgeOutput(`{"correct": 1, "why": "matches gold"}`);
  assert(r.correct === 1, "correct=1 parses as 1");
}
{
  const r = parseJudgeOutput(`{"correct": 0, "why": "different"}`);
  assert(r.correct === 0, "correct=0 parses as 0");
}

// Accept boolean too — some models return {correct: true}.
{
  const r = parseJudgeOutput(`{"correct": true, "why": "ok"}`);
  assert(r.correct === 1, "correct=true parses as 1");
}
{
  const r = parseJudgeOutput(`{"correct": false, "why": "no"}`);
  assert(r.correct === 0, "correct=false parses as 0");
}

// Junk prefix / suffix around the JSON (common with chatty models).
{
  const r = parseJudgeOutput(
    `Here is my verdict: {"correct": 1, "why": "good"}\n\nLet me know if you need more.`
  );
  assert(r.correct === 1, "JSON embedded in prose still parses");
}

// Code-fenced JSON.
{
  const r = parseJudgeOutput(
    `\`\`\`json\n{"correct": 1, "why": "yep"}\n\`\`\``
  );
  assert(r.correct === 1, "fenced JSON still parses");
}

// No JSON at all → safe default is 0 (incorrect).
{
  const r = parseJudgeOutput("Yes, the answer is correct.");
  assert(r.correct === 0, "prose-only output defaults to 0");
}

// Malformed JSON → safe default is 0.
{
  const r = parseJudgeOutput("{correct: 1"); // missing closing brace / quoting
  assert(r.correct === 0, "malformed JSON defaults to 0");
}

// Weird value types → coerce to 0.
{
  const r = parseJudgeOutput(`{"correct": "yes", "why": "s"}`);
  assert(r.correct === 0, "string 'yes' in correct field -> 0");
}

// Raw is always preserved.
{
  const raw = `{"correct": 1, "why": "match"}`;
  const r = parseJudgeOutput(raw);
  assert(r.raw === raw, "raw is preserved verbatim");
}

console.log("\n=== pickJudgeProvider ===");

// Snapshot + clear env keys so we can probe each branch.
const saved = {
  a: process.env.ANTHROPIC_API_KEY,
  o: process.env.OPENAI_API_KEY,
  g: process.env.GEMINI_API_KEY,
};
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;

assert(pickJudgeProvider() === "none", "no keys -> 'none'");

process.env.GEMINI_API_KEY = "g";
assert(pickJudgeProvider() === "gemini", "gemini only -> 'gemini'");

process.env.OPENAI_API_KEY = "o";
assert(pickJudgeProvider() === "openai", "openai beats gemini");

process.env.ANTHROPIC_API_KEY = "a";
assert(pickJudgeProvider() === "anthropic", "anthropic beats openai + gemini");

// Restore.
process.env.ANTHROPIC_API_KEY = saved.a;
process.env.OPENAI_API_KEY    = saved.o;
process.env.GEMINI_API_KEY    = saved.g;
if (!saved.a) delete process.env.ANTHROPIC_API_KEY;
if (!saved.o) delete process.env.OPENAI_API_KEY;
if (!saved.g) delete process.env.GEMINI_API_KEY;

console.log(`\n========================\nPassed: ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.error("Some judge tests failed.");
  process.exit(1);
}
console.log("All judge tests passed.");
