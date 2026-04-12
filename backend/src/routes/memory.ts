import { Router, Request, Response } from "express";
import { queryAll, queryOne, runSql } from "../db/index.js";
import { logAudit, getAuditForItem, getRecentAudit } from "../modules/audit.js";
import { bm25Rank } from "../modules/ranking.js";
import { addTag, removeTag, getTagsForItem, getAllTags } from "../modules/tags.js";
import { createLink, removeLink, getLinksForItem } from "../modules/links.js";
import { expireSessionMemory, getSessionStats } from "../modules/session-cleanup.js";
import { extractMemory } from "../modules/memory-extractor.js";
import { reconcileMemory } from "../modules/memory-reconciler.js";
import { computeImportance, rankByImportance } from "../modules/importance.js";
import { findDecayCandidates, applyDecay } from "../modules/decay.js";

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

// GET /stats - memory analytics
router.get("/stats", (_req: Request, res: Response) => {
  try {
    const totalActive = queryOne(
      "SELECT COUNT(*) as count FROM memory_items WHERE status = 'active'"
    ) as any;
    const totalStale = queryOne(
      "SELECT COUNT(*) as count FROM memory_items WHERE status = 'stale'"
    ) as any;
    const totalSuperseded = queryOne(
      "SELECT COUNT(*) as count FROM memory_items WHERE status = 'superseded'"
    ) as any;

    const byType = queryAll(
      "SELECT type, COUNT(*) as count FROM memory_items WHERE status = 'active' GROUP BY type ORDER BY count DESC"
    );
    const byScope = queryAll(
      "SELECT scope, COUNT(*) as count FROM memory_items WHERE status = 'active' GROUP BY scope ORDER BY count DESC"
    );
    const byDomain = queryAll(
      "SELECT domain, COUNT(*) as count FROM memory_items WHERE status = 'active' AND domain IS NOT NULL GROUP BY domain ORDER BY count DESC"
    );

    // Confidence distribution
    const highConf = queryOne(
      "SELECT COUNT(*) as count FROM memory_items WHERE status = 'active' AND confidence >= 0.8"
    ) as any;
    const medConf = queryOne(
      "SELECT COUNT(*) as count FROM memory_items WHERE status = 'active' AND confidence >= 0.5 AND confidence < 0.8"
    ) as any;
    const lowConf = queryOne(
      "SELECT COUNT(*) as count FROM memory_items WHERE status = 'active' AND confidence < 0.5"
    ) as any;

    // Recent activity (last 7 days)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentCreated = queryOne(
      "SELECT COUNT(*) as count FROM memory_items WHERE created_at > ?",
      [weekAgo]
    ) as any;

    const recentAudit = queryAll(
      "SELECT action, COUNT(*) as count FROM memory_audit_log WHERE created_at > ? GROUP BY action ORDER BY count DESC",
      [weekAgo]
    );

    // Oldest and newest items
    const oldest = queryOne(
      "SELECT created_at FROM memory_items WHERE status = 'active' ORDER BY created_at ASC LIMIT 1"
    ) as any;
    const newest = queryOne(
      "SELECT created_at FROM memory_items WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
    ) as any;

    // Links count
    const linksCount = queryOne(
      "SELECT COUNT(*) as count FROM memory_links"
    ) as any;

    // Trips count
    const tripsCount = queryOne(
      "SELECT COUNT(*) as count FROM trips"
    ) as any;

    // Conversations count
    const convsCount = queryOne(
      "SELECT COUNT(*) as count FROM conversations"
    ) as any;

    res.json({
      totals: {
        active: totalActive?.count || 0,
        stale: totalStale?.count || 0,
        superseded: totalSuperseded?.count || 0,
      },
      by_type: byType,
      by_scope: byScope,
      by_domain: byDomain,
      confidence: {
        high: highConf?.count || 0,
        medium: medConf?.count || 0,
        low: lowConf?.count || 0,
      },
      recent: {
        created_last_7d: recentCreated?.count || 0,
        audit_last_7d: recentAudit,
      },
      timeline: {
        oldest_active: oldest?.created_at || null,
        newest_active: newest?.created_at || null,
      },
      links: linksCount?.count || 0,
      trips: tripsCount?.count || 0,
      conversations: convsCount?.count || 0,
    });
  } catch (err) {
    console.error("GET /api/memory/stats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /stats/retention - memory retention over time (created vs. still active per week)
router.get("/stats/retention", (_req: Request, res: Response) => {
  try {
    // Get all items with their creation date and current status
    const rows = queryAll(
      `SELECT
         strftime('%Y-%W', created_at) as week,
         COUNT(*) as created,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as survived
       FROM memory_items
       GROUP BY week
       ORDER BY week DESC
       LIMIT 26`
    ) as any[];

    // Reverse to chronological order
    const data = rows.reverse().map((r) => ({
      week: r.week,
      created: r.created,
      survived: r.survived,
      retention_pct: r.created > 0 ? Math.round((r.survived / r.created) * 100) : 0,
    }));

    // Overall stats
    const totalCreated = queryOne("SELECT COUNT(*) as count FROM memory_items") as any;
    const totalActive = queryOne("SELECT COUNT(*) as count FROM memory_items WHERE status = 'active'") as any;

    res.json({
      overall: {
        total_created: totalCreated?.count || 0,
        total_active: totalActive?.count || 0,
        retention_pct: totalCreated?.count > 0
          ? Math.round(((totalActive?.count || 0) / totalCreated.count) * 100)
          : 100,
      },
      weekly: data,
    });
  } catch (err) {
    console.error("GET /api/memory/stats/retention error:", err);
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

// POST /bulk - import memory from an array of text statements
router.post("/bulk", async (req: Request, res: Response) => {
  try {
    const { statements, trip_id } = req.body;
    if (!Array.isArray(statements) || statements.length === 0) {
      res.status(400).json({ error: "statements must be a non-empty array of strings" });
      return;
    }

    let totalExtracted = 0;
    let totalAdded = 0;
    let totalDuplicates = 0;

    for (const text of statements) {
      if (typeof text !== "string" || text.trim().length < 5) continue;
      const eventId = "bulk-" + Date.now().toString(36);
      const candidates = await extractMemory(text.trim(), eventId, trip_id);
      if (candidates.length > 0) {
        const result = await reconcileMemory(candidates, eventId);
        totalExtracted += candidates.length;
        totalAdded += result.added.length;
        totalDuplicates += result.duplicates.length;
      }
    }

    res.json({
      processed: statements.length,
      extracted: totalExtracted,
      added: totalAdded,
      duplicates: totalDuplicates,
    });
  } catch (err) {
    console.error("POST /api/memory/bulk error:", err);
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

// GET /importance - rank memory items by computed importance score
router.get("/importance", (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const ranked = rankByImportance(limit);
    res.json(ranked);
  } catch (err) {
    console.error("GET /api/memory/importance error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id/importance - get importance breakdown for a single item
router.get("/:id/importance", (req: Request, res: Response) => {
  try {
    const factors = computeImportance(req.params.id as string);
    res.json(factors);
  } catch (err) {
    console.error("GET /api/memory/:id/importance error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /decay - preview which items would be marked stale by decay rules
router.get("/decay", (req: Request, res: Response) => {
  try {
    const maxAgeDays = parseInt(req.query.max_age_days as string) || undefined;
    const maxStaleDays = parseInt(req.query.max_stale_days as string) || undefined;
    const minImportance = parseInt(req.query.min_importance as string) || undefined;
    const candidates = findDecayCandidates({ maxAgeDays, maxStaleDays, minImportance });
    res.json({ count: candidates.length, candidates });
  } catch (err) {
    console.error("GET /api/memory/decay error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /decay - apply decay rules and mark stale items
router.post("/decay", (req: Request, res: Response) => {
  try {
    const { max_age_days, max_stale_days, min_importance } = req.body || {};
    const result = applyDecay({
      maxAgeDays: max_age_days,
      maxStaleDays: max_stale_days,
      minImportance: min_importance,
    });
    res.json({ marked: result.marked, items: result.candidates });
  } catch (err) {
    console.error("POST /api/memory/decay error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /merge - merge two memory items into one
router.post("/merge", (req: Request, res: Response) => {
  try {
    const { source_id, target_id, merged_value } = req.body;
    if (!source_id || !target_id) {
      res.status(400).json({ error: "source_id and target_id are required" });
      return;
    }

    const source = queryOne("SELECT * FROM memory_items WHERE id = ?", [source_id]) as any;
    const target = queryOne("SELECT * FROM memory_items WHERE id = ?", [target_id]) as any;

    if (!source || !target) {
      res.status(404).json({ error: "One or both memory items not found" });
      return;
    }

    // Update target with merged value (or keep target value if not provided)
    const finalValue = merged_value || `${target.value}; ${source.value}`;
    const finalConfidence = Math.max(source.confidence, target.confidence);

    runSql(
      "UPDATE memory_items SET value = ?, confidence = ?, last_confirmed_at = datetime('now') WHERE id = ?",
      [finalValue, finalConfidence, target_id]
    );

    // Mark source as superseded by target
    runSql(
      "UPDATE memory_items SET status = 'superseded', superseded_by = ? WHERE id = ?",
      [target_id, source_id]
    );

    // Copy tags from source to target
    const sourceTags = getTagsForItem(source_id) as any[];
    for (const t of sourceTags) {
      try { addTag(target_id, t.tag); } catch { /* ignore duplicates */ }
    }

    logAudit(target_id, "reconfirmed", `Merged with ${source_id}`);
    logAudit(source_id, "superseded", `Merged into ${target_id}`);

    const updated = queryOne("SELECT * FROM memory_items WHERE id = ?", [target_id]);
    res.json(updated);
  } catch (err) {
    console.error("POST /api/memory/merge error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
