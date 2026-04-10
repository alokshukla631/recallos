import { Router, Request, Response } from "express";
import { queryAll, queryOne } from "../db/index.js";
import { extractMemory } from "../modules/memory-extractor.js";
import { compileContext } from "../modules/context-compiler.js";
import { PerfTimer } from "../modules/perf.js";

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
    const { message, trip_id } = req.body;
    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const timer = new PerfTimer();

    timer.begin("extraction");
    const candidates = await extractMemory(message, "benchmark-" + Date.now().toString(36), trip_id);

    timer.begin("context_compilation");
    const compiled = await compileContext("benchmark", message, trip_id);

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

export default router;
