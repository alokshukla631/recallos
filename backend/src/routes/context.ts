import { Router, Request, Response } from "express";
import { queryAll, queryOne } from "../db/index.js";

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

export default router;
