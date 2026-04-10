import { Router, Request, Response } from "express";
import { queryAll, queryOne, runSql } from "../db/index.js";
import { logAudit, getAuditForItem, getRecentAudit } from "../modules/audit.js";
import { bm25Rank } from "../modules/ranking.js";
import { addTag, removeTag, getTagsForItem, getAllTags } from "../modules/tags.js";
import { createLink, removeLink, getLinksForItem } from "../modules/links.js";
import { expireSessionMemory, getSessionStats } from "../modules/session-cleanup.js";

const router = Router();

// GET / - list memory items with optional filters
router.get("/", (req: Request, res: Response) => {
  try {
    const { scope, type, status = "active", trip_id } = req.query;

    let sql = "SELECT * FROM memory_items WHERE 1=1";
    const params: unknown[] = [];

    if (status && status !== "all") {
      sql += " AND status = ?";
      params.push(status);
    }
    if (scope && scope !== "all") {
      sql += " AND scope = ?";
      params.push(scope);
    }
    if (type && type !== "all") {
      sql += " AND type = ?";
      params.push(type);
    }
    if (trip_id) {
      sql += " AND trip_id = ?";
      params.push(trip_id);
    }

    sql += " ORDER BY created_at DESC";
    res.json(queryAll(sql, params));
  } catch (err) {
    console.error("GET /api/memory error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id - get single memory item
router.get("/:id", (req: Request, res: Response) => {
  try {
    const row = queryOne("SELECT * FROM memory_items WHERE id = ?", [req.params.id]);
    if (!row) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    res.json(row);
  } catch (err) {
    console.error("GET /api/memory/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /:id - update a memory item
router.put("/:id", (req: Request, res: Response) => {
  try {
    const existing = queryOne("SELECT * FROM memory_items WHERE id = ?", [req.params.id]);
    if (!existing) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }

    const { value, status, scope } = req.body;
    const updates: string[] = [];
    const params: unknown[] = [];

    if (value !== undefined) { updates.push("value = ?"); params.push(value); }
    if (status !== undefined) { updates.push("status = ?"); params.push(status); }
    if (scope !== undefined) { updates.push("scope = ?"); params.push(scope); }

    if (updates.length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    params.push(req.params.id);
    runSql(`UPDATE memory_items SET ${updates.join(", ")} WHERE id = ?`, params);
    res.json(queryOne("SELECT * FROM memory_items WHERE id = ?", [req.params.id]));
  } catch (err) {
    console.error("PUT /api/memory/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /search - full-text search across memory items using BM25
router.get("/search", (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string || "").trim();
    if (!q) {
      res.json([]);
      return;
    }

    const allItems = queryAll(
      "SELECT * FROM memory_items WHERE status = 'active' ORDER BY created_at DESC"
    ) as any[];

    if (allItems.length === 0) {
      res.json([]);
      return;
    }

    const docs = allItems.map((item) => ({
      id: item.id as string,
      text: `${item.key} ${item.value} ${item.type}`,
    }));

    const ranked = bm25Rank(q, docs);
    const scoreMap = new Map(ranked.map((r) => [r.id, r.score]));

    // Filter out zero-score results and sort by score
    const results = allItems
      .map((item) => ({
        ...item,
        search_score: scoreMap.get(item.id as string) ?? 0,
      }))
      .filter((item) => item.search_score > 0)
      .sort((a, b) => b.search_score - a.search_score)
      .slice(0, 50);

    res.json(results);
  } catch (err) {
    console.error("GET /api/memory/search error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /audit/recent - get recent audit log entries
router.get("/audit/recent", (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(getRecentAudit(limit));
  } catch (err) {
    console.error("GET /api/memory/audit/recent error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /audit/:id - get audit log for a specific memory item
router.get("/audit/:id", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    res.json(getAuditForItem(id));
  } catch (err) {
    console.error("GET /api/memory/audit/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /tags - list all tags with counts
router.get("/tags", (_req: Request, res: Response) => {
  try {
    res.json(getAllTags());
  } catch (err) {
    console.error("GET /api/memory/tags error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id/tags - get tags for a specific memory item
router.get("/:id/tags", (req: Request, res: Response) => {
  try {
    res.json(getTagsForItem(req.params.id as string));
  } catch (err) {
    console.error("GET /api/memory/:id/tags error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/tags - add a tag to a memory item
router.post("/:id/tags", (req: Request, res: Response) => {
  try {
    const { tag } = req.body;
    if (!tag || typeof tag !== "string" || !tag.trim()) {
      res.status(400).json({ error: "tag is required" });
      return;
    }
    const id = req.params.id as string;
    const existing = queryOne("SELECT id FROM memory_items WHERE id = ?", [id]);
    if (!existing) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    addTag(id, tag);
    res.json(getTagsForItem(id));
  } catch (err) {
    console.error("POST /api/memory/:id/tags error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:id/tags/:tag - remove a tag from a memory item
router.delete("/:id/tags/:tag", (req: Request, res: Response) => {
  try {
    removeTag(req.params.id as string, req.params.tag as string);
    res.json(getTagsForItem(req.params.id as string));
  } catch (err) {
    console.error("DELETE /api/memory/:id/tags/:tag error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id/links - get all links for a memory item
router.get("/:id/links", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const existing = queryOne("SELECT id FROM memory_items WHERE id = ?", [id]);
    if (!existing) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    res.json(getLinksForItem(id));
  } catch (err) {
    console.error("GET /api/memory/:id/links error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/links - create a link from this item to another
router.post("/:id/links", (req: Request, res: Response) => {
  try {
    const sourceId = req.params.id as string;
    const { target_id, relation, strength, note } = req.body;

    if (!target_id || !relation) {
      res.status(400).json({ error: "target_id and relation are required" });
      return;
    }

    const validRelations = ["related_to", "depends_on", "conflicts_with", "refines", "derived_from"];
    if (!validRelations.includes(relation)) {
      res.status(400).json({ error: `relation must be one of: ${validRelations.join(", ")}` });
      return;
    }

    // Verify both items exist
    const source = queryOne("SELECT id FROM memory_items WHERE id = ?", [sourceId]);
    const target = queryOne("SELECT id FROM memory_items WHERE id = ?", [target_id]);
    if (!source) {
      res.status(404).json({ error: "Source memory item not found" });
      return;
    }
    if (!target) {
      res.status(404).json({ error: "Target memory item not found" });
      return;
    }

    const link = createLink(sourceId, target_id, relation, strength ?? 1.0, note);
    res.status(201).json(link);
  } catch (err) {
    console.error("POST /api/memory/:id/links error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /links/:linkId - remove a link
router.delete("/links/:linkId", (req: Request, res: Response) => {
  try {
    const removed = removeLink(req.params.linkId as string);
    if (!removed) {
      res.status(404).json({ error: "Link not found" });
      return;
    }
    res.json({ message: "Link removed" });
  } catch (err) {
    console.error("DELETE /api/memory/links/:linkId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /session/stats - get session memory stats
router.get("/session/stats", (_req: Request, res: Response) => {
  try {
    res.json(getSessionStats());
  } catch (err) {
    console.error("GET /api/memory/session/stats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /session/cleanup - expire old session memory items
router.post("/session/cleanup", (req: Request, res: Response) => {
  try {
    const ttl = parseInt(req.body.ttl_hours as string) || 24;
    const expired = expireSessionMemory(ttl);
    res.json({ expired_count: expired, ttl_hours: ttl });
  } catch (err) {
    console.error("POST /api/memory/session/cleanup error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:id - soft delete
router.delete("/:id", (req: Request, res: Response) => {
  try {
    const existing = queryOne("SELECT * FROM memory_items WHERE id = ?", [req.params.id]);
    if (!existing) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    runSql("UPDATE memory_items SET status = 'stale' WHERE id = ?", [req.params.id]);
    logAudit(req.params.id as string, "deleted", "Manually deleted by user");
    res.json({ message: "Memory item marked as stale" });
  } catch (err) {
    console.error("DELETE /api/memory/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
