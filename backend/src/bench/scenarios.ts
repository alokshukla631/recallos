/**
 * End-to-end scenario tests for the RecallOS memory pipeline.
 *
 * These scenarios exercise the full pipeline (extract → reconcile → compile)
 * against an isolated in-memory database, without calling any LLM provider.
 * Run with: npm run bench (from the backend directory).
 */
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import os from "os";
import { initDatabase, queryOne } from "../db/index.js";
import { storeEvent } from "../modules/event-store.js";
import { extractMemory } from "../modules/memory-extractor.js";
import { reconcileMemory } from "../modules/memory-reconciler.js";
import { compileContext } from "../modules/context-compiler.js";
import { extractEntities } from "../modules/entity-extractor.js";

interface ScenarioStep {
  user: string;
  projectId?: string;
  expect: {
    memoryAddedMin?: number;
    memoryUpdatedMin?: number;
    contextIncludesAny?: string[];
    contextExcludesAll?: string[];
    entityTypes?: Array<"date" | "destination" | "amount" | "duration">;
  };
}

interface Scenario {
  name: string;
  description: string;
  steps: ScenarioStep[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "Durable preference + topical retrieval",
    description:
      "User states a durable travel preference, then asks a related question. The context should include the preference.",
    steps: [
      {
        user: "I prefer aisle seats on flights.",
        expect: {
          memoryAddedMin: 1,
          contextIncludesAny: ["aisle"],
        },
      },
      {
        user: "I'm planning to fly to Tokyo next month. Which seat should I pick?",
        expect: {
          contextIncludesAny: ["aisle"],
          entityTypes: ["destination", "date"],
        },
      },
    ],
  },
  {
    name: "Explicit override wins over earlier preference",
    description:
      "User states a preference, then overrides it for a specific trip. Both must be stored with override taking precedence.",
    steps: [
      {
        user: "I usually prefer budget hotels under $100 per night.",
        expect: {
          memoryAddedMin: 1,
          contextIncludesAny: ["budget", "100"],
        },
      },
      {
        user: "For this trip, I actually want to switch to a luxury hotel instead.",
        expect: {
          memoryAddedMin: 1,
          contextIncludesAny: ["luxury"],
        },
      },
    ],
  },
  {
    name: "Duplicate re-confirmation",
    description:
      "Stating the same preference twice should not create two rows. The second mention should re-confirm the first.",
    steps: [
      {
        user: "I prefer window seats.",
        expect: {
          memoryAddedMin: 1,
        },
      },
      {
        user: "I prefer window seats.",
        expect: {
          memoryAddedMin: 0,
        },
      },
    ],
  },
  {
    name: "Entity extraction: dates and destinations",
    description:
      "A multi-entity message should have date, destination, and amount entities pulled out.",
    steps: [
      {
        user: "Plan a trip to Paris on July 15 with a budget of $2000.",
        expect: {
          memoryAddedMin: 1,
          entityTypes: ["date", "destination", "amount"],
          contextIncludesAny: ["Paris", "2000"],
        },
      },
    ],
  },
  {
    name: "Hard constraint always included",
    description:
      "Constraints should be included in the context even when the query is unrelated.",
    steps: [
      {
        user: "My budget is capped at $5000 for any trip.",
        expect: {
          memoryAddedMin: 1,
        },
      },
      {
        user: "What's the weather like in Iceland in winter?",
        expect: {
          contextIncludesAny: ["budget", "5000", "capped"],
        },
      },
    ],
  },
];

interface StepResult {
  ok: boolean;
  errors: string[];
  stats: {
    added: number;
    updated: number;
    duplicates: number;
    included: number;
    omitted: number;
    contextText: string;
    entityTypes: string[];
  };
}

async function runStep(
  conversationId: string,
  step: ScenarioStep
): Promise<StepResult> {
  const errors: string[] = [];
  const userEvent = await storeEvent(
    conversationId,
    "user",
    step.user,
    "bench",
    step.projectId
  );

  const candidates = await extractMemory(step.user, userEvent.id, step.projectId);
  const reconcile = await reconcileMemory(candidates, userEvent.id);
  const compiled = await compileContext(conversationId, step.user, step.projectId);

  const entities = extractEntities(step.user);
  const entityTypes = Array.from(new Set(entities.map((e) => e.type)));

  if (
    step.expect.memoryAddedMin != null &&
    reconcile.added.length < step.expect.memoryAddedMin
  ) {
    errors.push(
      `expected >= ${step.expect.memoryAddedMin} memories added, got ${reconcile.added.length}`
    );
  }

  if (
    step.expect.memoryUpdatedMin != null &&
    reconcile.updated.length < step.expect.memoryUpdatedMin
  ) {
    errors.push(
      `expected >= ${step.expect.memoryUpdatedMin} memories updated, got ${reconcile.updated.length}`
    );
  }

  if (step.expect.contextIncludesAny) {
    const hay = compiled.contextText.toLowerCase();
    const hit = step.expect.contextIncludesAny.some((needle) =>
      hay.includes(needle.toLowerCase())
    );
    if (!hit) {
      errors.push(
        `context did not include any of: ${step.expect.contextIncludesAny.join(", ")}`
      );
    }
  }

  if (step.expect.contextExcludesAll) {
    const hay = compiled.contextText.toLowerCase();
    const leaked = step.expect.contextExcludesAll.filter((needle) =>
      hay.includes(needle.toLowerCase())
    );
    if (leaked.length > 0) {
      errors.push(`context should not include: ${leaked.join(", ")}`);
    }
  }

  if (step.expect.entityTypes) {
    for (const expected of step.expect.entityTypes) {
      if (!entityTypes.includes(expected)) {
        errors.push(`expected entity type "${expected}" not found`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      added: reconcile.added.length,
      updated: reconcile.updated.length,
      duplicates: reconcile.duplicates.length,
      included: compiled.includedIds.length,
      omitted: compiled.omittedIds.length,
      contextText: compiled.contextText,
      entityTypes,
    },
  };
}

async function runScenario(scenario: Scenario): Promise<boolean> {
  console.log(`\n--- ${scenario.name} ---`);
  console.log(`${scenario.description}`);

  const convId = uuidv4();
  let allOk = true;

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];
    const result = await runStep(convId, step);
    const status = result.ok ? "PASS" : "FAIL";
    console.log(
      `  [${status}] step ${i + 1}: "${step.user.slice(0, 60)}${step.user.length > 60 ? "..." : ""}"`
    );
    console.log(
      `         added=${result.stats.added} updated=${result.stats.updated} dup=${result.stats.duplicates} included=${result.stats.included}/${result.stats.included + result.stats.omitted} entities=[${result.stats.entityTypes.join(",")}]`
    );
    if (!result.ok) {
      for (const e of result.errors) console.log(`         ! ${e}`);
      allOk = false;
    }
  }

  return allOk;
}

async function main() {
  // Use an isolated temp DB so we don't pollute the real one
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recallos-bench-"));
  const dbPath = path.join(tmpDir, "bench.db");
  await initDatabase(dbPath);

  console.log("Running RecallOS pipeline benchmarks...");
  console.log(`DB: ${dbPath}`);

  let passed = 0;
  let failed = 0;

  for (const scenario of SCENARIOS) {
    const ok = await runScenario(scenario);
    if (ok) passed++;
    else failed++;
  }

  // Print summary stats from the DB
  const memoryCount = queryOne("SELECT COUNT(*) as c FROM memory_items") as
    | { c: number }
    | undefined;
  const eventCount = queryOne("SELECT COUNT(*) as c FROM events") as
    | { c: number }
    | undefined;

  console.log("\n=== Summary ===");
  console.log(`Scenarios: ${passed} passed, ${failed} failed, ${SCENARIOS.length} total`);
  console.log(`Memory items: ${memoryCount?.c ?? 0}`);
  console.log(`Events: ${eventCount?.c ?? 0}`);

  // Clean up the temp DB so the next run is clean
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Bench failed to run:", err);
  process.exit(1);
});
