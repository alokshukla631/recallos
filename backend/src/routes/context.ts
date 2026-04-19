import { Router, Request, Response } from "express";
import { queryAll, queryOne } from "../db/index.js";
import { extractMemory } from "../modules/memory-extractor.js";
import { compileContext } from "../modules/context-compiler.js";
import { PerfTimer } from "../modules/perf.js";
import { classifyQuery } from "../modules/query-classifier.js";
import { searchVerbatim } from "../modules/verbatim-retriever.js";

const router = Router();

// GET /snapshots - list context snapshots
router.get("/snapshots", (req: Request, res: Response) => {
  try {
    const { event_id } = req.query;

    if (event_id) {
      const rows = queryAll(
        "SELECT * FROM context_snapshots WHERE event_id = ? ORDER BY created_at DESC",
        [event_id]
      );
      res.json(rows);
      return;
    }

    const rows = queryAll("SELECT * FROM context_snapshots ORDER BY created_at DESC LIMIT 50");
    res.json(rows);
  } catch (err) {
    console.error("GET /api/context/snapshots error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /snapshots/compare - compare two snapshots
// MUST be registered before /snapshots/:id to avoid being shadowed
router.get("/snapshots/compare", (req: Request, res: Response) => {
  try {
    const { a, b } = req.query;
    if (!a || !b) {
      res.status(400).json({ error: "Both query params 'a' and 'b' (snapshot IDs) are required" });
      return;
    }

    const snapA = queryOne("SELECT * FROM context_snapshots WHERE id = ?", [a]);
    const snapB = queryOne("SELECT * FROM context_snapshots WHERE id = ?", [b]);

    if (!snapA || !snapB) {
      res.status(404).json({ error: "One or both snapshots not found" });
      return;
    }

    const includedA: string[] = JSON.parse(snapA.included_memory_ids as string || "[]");
    const includedB: string[] = JSON.parse(snapB.included_memory_ids as string || "[]");
    const omittedA: string[] = JSON.parse(snapA.omitted_memory_ids as string || "[]");
    const omittedB: string[] = JSON.parse(snapB.omitted_memory_ids as string || "[]");

    const setA = new Set(includedA);
    const setB = new Set(includedB);

    const added = includedB.filter((id) => !setA.has(id));
    const removed = includedA.filter((id) => !setB.has(id));
    const kept = includedA.filter((id) => setB.has(id));

    // Fetch details for changed items
    const fetchItems = (ids: string[]) => {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(",");
      return queryAll(
        `SELECT id, key, type, value, scope, domain FROM memory_items WHERE id IN (${placeholders})`,
        ids
      );
    };

    res.json({
      snapshot_a: {
        id: snapA.id,
        event_id: snapA.event_id,
        provider: snapA.provider,
        created_at: snapA.created_at,
        included_count: includedA.length,
        omitted_count: omittedA.length,
      },
      snapshot_b: {
        id: snapB.id,
        event_id: snapB.event_id,
        provider: snapB.provider,
        created_at: snapB.created_at,
        included_count: includedB.length,
        omitted_count: omittedB.length,
      },
      diff: {
        added: fetchItems(added),
        removed: fetchItems(removed),
        kept_count: kept.length,
        total_changes: added.length + removed.length,
      },
    });
  } catch (err) {
    console.error("GET /api/context/snapshots/compare error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /snapshots/:id - get a specific snapshot
router.get("/snapshots/:id", (req: Request, res: Response) => {
  try {
    const row = queryOne("SELECT * FROM context_snapshots WHERE id = ?", [req.params.id]);
    if (!row) {
      res.status(404).json({ error: "Snapshot not found" });
      return;
    }

    // Parse JSON fields for the response
    res.json({
      ...row,
      compiled_context_json: JSON.parse(row.compiled_context_json as string || "{}"),
      included_memory_ids: JSON.parse(row.included_memory_ids as string || "[]"),
      omitted_memory_ids: JSON.parse(row.omitted_memory_ids as string || "[]"),
      rationale_json: row.rationale_json ? JSON.parse(row.rationale_json as string) : null,
    });
  } catch (err) {
    console.error("GET /api/context/snapshots/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /benchmark - run the pipeline without calling a provider, return timing
router.post("/benchmark", async (req: Request, res: Response) => {
  try {
    const { message, project_id } = req.body;
    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const timer = new PerfTimer();

    timer.begin("extraction");
    const candidates = await extractMemory(message, "benchmark-" + Date.now().toString(36), project_id);

    timer.begin("context_compilation");
    const compiled = await compileContext("benchmark", message, project_id);

    const timing = timer.finish();

    res.json({
      timing,
      extraction: {
        candidates_count: candidates.length,
        candidates: candidates.map((c) => ({ key: c.key, type: c.type, domain: c.domain })),
      },
      context: {
        included_count: compiled.includedIds.length,
        omitted_count: compiled.omittedIds.length,
        domain: compiled.contextPacket.domain,
        domains: compiled.contextPacket.domains,
      },
    });
  } catch (err) {
    console.error("POST /api/context/benchmark error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /verbatim - direct verbatim search over conversation events
// Exposes the evidence lane for testing, debugging, and direct querying.
router.post("/verbatim", (req: Request, res: Response) => {
  try {
    const {
      query,
      max_results    = 5,
      project_id,
      exclude_conversation_id,
      max_event_age_days = 0,
    } = req.body;

    if (!query || typeof query !== "string") {
      res.status(400).json({ error: "query (string) is required" });
      return;
    }

    const classification = classifyQuery(query);

    const snippets = searchVerbatim(query, {
      maxResults:            Math.min(Number(max_results) || 5, 20),
      excludeConversationId: exclude_conversation_id,
      projectId:             project_id,
      temporalAnchor:        classification.temporalAnchor,
      isAssistantQuery:      classification.type === "assistant_recall",
      maxEventAgeDays:       Number(max_event_age_days) || 0,
    });

    res.json({
      query,
      classification,
      snippets,
      count: snippets.length,
    });
  } catch (err) {
    console.error("POST /api/context/verbatim error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
