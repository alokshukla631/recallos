import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { queryAll, queryOne, runSql } from "../db/index.js";
import { logAudit, getAuditForItem, getRecentAudit } from "../modules/audit.js";
import { bm25Rank, fuzzySearch } from "../modules/ranking.js";
import { addTag, removeTag, getTagsForItem, getAllTags } from "../modules/tags.js";
import { createLink, removeLink, getLinksForItem } from "../modules/links.js";
import { expireSessionMemory, getSessionStats } from "../modules/session-cleanup.js";
import { extractMemory } from "../modules/memory-extractor.js";
import { reconcileMemory } from "../modules/memory-reconciler.js";
import { computeImportance, rankByImportance } from "../modules/importance.js";
import { findDecayCandidates, applyDecay } from "../modules/decay.js";
import { findDuplicates } from "../modules/duplicates.js";
import { generateSuggestions } from "../modules/suggestions.js";
import { fireWebhook } from "../modules/webhooks.js";
import { createVersion, getVersions, revertToVersion, ensureVersionTable } from "../modules/versioning.js";

// Ensure version table exists on module load
ensureVersionTable();

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

// POST / - create a memory item directly
router.post("/", (req: Request, res: Response) => {
  try {
    const { key, type, value, scope, domain, confidence, trip_id } = req.body;

    if (!key || typeof key !== "string" || !key.trim()) {
      res.status(400).json({ error: "key is required" });
      return;
    }
    if (!value || typeof value !== "string" || !value.trim()) {
      res.status(400).json({ error: "value is required" });
      return;
    }

    const validTypes = ["preference", "constraint", "fact", "goal", "override"];
    const itemType = validTypes.includes(type) ? type : "fact";
    const validScopes = ["global", "trip", "domain", "project", "session"];
    const itemScope = validScopes.includes(scope) ? scope : "global";
    const itemConfidence = typeof confidence === "number" ? Math.max(0, Math.min(1, confidence)) : 0.8;

    const id = uuidv4();
    const now = new Date().toISOString();

    runSql(
      `INSERT INTO memory_items (id, key, type, value, scope, domain, trip_id, confidence, authority, status, last_confirmed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'explicit', 'active', ?, ?)`,
      [id, key.trim(), itemType, value.trim(), itemScope, domain || null, trip_id || null, itemConfidence, now, now]
    );

    logAudit(id, "created", "Manually created by user");
    fireWebhook("created", { id, key: key.trim(), type: itemType, value: value.trim(), scope: itemScope });

    const created = queryOne("SELECT * FROM memory_items WHERE id = ?", [id]);
    res.status(201).json(created);
  } catch (err) {
    console.error("POST /api/memory error:", err);
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

// GET /:id/detail - comprehensive detail view for a single memory item
router.get("/:id/detail", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const item = queryOne("SELECT * FROM memory_items WHERE id = ?", [id]) as any;
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }

    // Importance breakdown
    const importance = computeImportance(id);

    // Tags
    const tags = getTagsForItem(id);

    // Links (both directions)
    const links = getLinksForItem(id);

    // Audit history
    const audit = getAuditForItem(id);

    // Superseded by / supersedes info
    let superseded_by_item = null;
    if (item.superseded_by) {
      superseded_by_item = queryOne(
        "SELECT id, key, value FROM memory_items WHERE id = ?",
        [item.superseded_by]
      );
    }
    const supersedes = queryAll(
      "SELECT id, key, value FROM memory_items WHERE superseded_by = ?",
      [id]
    );

    // Context usage: how many snapshots include this item
    const allSnapshots = queryAll(
      "SELECT included_memory_ids FROM context_snapshots"
    ) as any[];
    let contextAppearances = 0;
    for (const snap of allSnapshots) {
      try {
        const ids = JSON.parse(snap.included_memory_ids || "[]");
        if (ids.includes(id)) contextAppearances++;
      } catch { /* skip malformed */ }
    }

    // Version history
    const versions = getVersions(id);

    res.json({
      ...item,
      importance,
      tags,
      links,
      audit,
      versions,
      superseded_by_item,
      supersedes,
      context_appearances: contextAppearances,
    });
  } catch (err) {
    console.error("GET /api/memory/:id/detail error:", err);
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

    // Snapshot current value before updating
    if (value !== undefined) {
      createVersion(req.params.id as string, "user");
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
    let results = allItems
      .map((item) => ({
        ...item,
        search_score: scoreMap.get(item.id as string) ?? 0,
        search_method: "bm25" as string,
      }))
      .filter((item) => item.search_score > 0)
      .sort((a, b) => b.search_score - a.search_score)
      .slice(0, 50);

    // Fuzzy fallback: if BM25 found nothing, try edit-distance matching
    if (results.length === 0) {
      const fuzzyResults = fuzzySearch(q, docs, 2);
      const fuzzyMap = new Map(fuzzyResults.map((r) => [r.id, r.score]));
      results = allItems
        .map((item) => ({
          ...item,
          search_score: fuzzyMap.get(item.id as string) ?? 0,
          search_method: "fuzzy" as string,
        }))
        .filter((item) => item.search_score > 0)
        .sort((a, b) => b.search_score - a.search_score)
        .slice(0, 30);
    }

    res.json(results);
  } catch (err) {
    console.error("GET /api/memory/search error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /audit/heatmap - daily activity counts for the last N weeks
router.get("/audit/heatmap", (req: Request, res: Response) => {
  try {
    const weeks = Math.min(52, parseInt(req.query.weeks as string) || 12);
    const daysBack = weeks * 7;
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const rows = queryAll(
      `SELECT date(created_at) as day, action, COUNT(*) as count
       FROM memory_audit_log
       WHERE date(created_at) >= ?
       GROUP BY day, action
       ORDER BY day ASC`,
      [cutoff]
    ) as any[];

    // Aggregate by day
    const byDay: Record<string, { total: number; actions: Record<string, number> }> = {};
    for (const row of rows) {
      if (!byDay[row.day]) byDay[row.day] = { total: 0, actions: {} };
      byDay[row.day].total += row.count;
      byDay[row.day].actions[row.action] = (byDay[row.day].actions[row.action] || 0) + row.count;
    }

    // Build a complete array of days
    const days: Array<{ date: string; total: number; actions: Record<string, number> }> = [];
    const now = new Date();
    for (let i = daysBack - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      days.push({
        date: key,
        total: byDay[key]?.total || 0,
        actions: byDay[key]?.actions || {},
      });
    }

    const maxActivity = Math.max(1, ...days.map((d) => d.total));
    res.json({ days, max_activity: maxActivity, weeks });
  } catch (err) {
    console.error("GET /api/memory/audit/heatmap error:", err);
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

// POST /:id/reconfirm - manually mark an item as still valid
router.post("/:id/reconfirm", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const item = queryOne("SELECT id, status FROM memory_items WHERE id = ?", [id]) as any;
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }

    const now = new Date().toISOString();
    runSql("UPDATE memory_items SET last_confirmed_at = ?, status = 'active' WHERE id = ?", [now, id]);
    logAudit(id, "reconfirmed", "Manual reconfirmation by user");
    fireWebhook("reconfirmed", { id, last_confirmed_at: now });
    res.json({ message: "Memory item reconfirmed", last_confirmed_at: now });
  } catch (err) {
    console.error("POST /api/memory/:id/reconfirm error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/pin - pin a memory item (always included in context)
router.post("/:id/pin", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const item = queryOne("SELECT id FROM memory_items WHERE id = ?", [id]) as any;
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    runSql("UPDATE memory_items SET pinned = 1 WHERE id = ?", [id]);
    fireWebhook("pinned", { id });
    res.json({ message: "Memory item pinned", pinned: true });
  } catch (err) {
    console.error("POST /api/memory/:id/pin error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/unpin - unpin a memory item
router.post("/:id/unpin", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const item = queryOne("SELECT id FROM memory_items WHERE id = ?", [id]) as any;
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    runSql("UPDATE memory_items SET pinned = 0 WHERE id = ?", [id]);
    fireWebhook("unpinned", { id });
    res.json({ message: "Memory item unpinned", pinned: false });
  } catch (err) {
    console.error("POST /api/memory/:id/unpin error:", err);
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

// POST /batch - batch operations on multiple items (pin, unpin, delete, reconfirm)
router.post("/batch", (req: Request, res: Response) => {
  try {
    const { ids, action } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: "ids must be a non-empty array" });
      return;
    }
    if (!["pin", "unpin", "delete", "reconfirm"].includes(action)) {
      res.status(400).json({ error: "action must be one of: pin, unpin, delete, reconfirm" });
      return;
    }

    const now = new Date().toISOString();
    let affected = 0;

    for (const id of ids) {
      const item = queryOne("SELECT id FROM memory_items WHERE id = ?", [id]) as any;
      if (!item) continue;

      switch (action) {
        case "pin":
          runSql("UPDATE memory_items SET pinned = 1 WHERE id = ?", [id]);
          break;
        case "unpin":
          runSql("UPDATE memory_items SET pinned = 0 WHERE id = ?", [id]);
          break;
        case "delete":
          runSql("UPDATE memory_items SET status = 'stale' WHERE id = ?", [id]);
          logAudit(id, "deleted", "Batch delete");
          break;
        case "reconfirm":
          runSql("UPDATE memory_items SET last_confirmed_at = ?, status = 'active' WHERE id = ?", [now, id]);
          logAudit(id, "reconfirmed", "Batch reconfirmation");
          break;
      }
      affected++;
    }

    res.json({ action, affected, total_requested: ids.length });
  } catch (err) {
    console.error("POST /api/memory/batch error:", err);
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
    fireWebhook("deleted", { id: req.params.id });
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

// GET /:id/versions - get version history for a memory item
router.get("/:id/versions", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const item = queryOne("SELECT id FROM memory_items WHERE id = ?", [id]) as any;
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    const versions = getVersions(id);
    res.json(versions);
  } catch (err) {
    console.error("GET /api/memory/:id/versions error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/revert/:versionId - revert a memory item to a previous version
router.post("/:id/revert/:versionId", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const versionId = req.params.versionId as string;
    const item = queryOne("SELECT id FROM memory_items WHERE id = ?", [id]) as any;
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    const ok = revertToVersion(id, versionId);
    if (!ok) {
      res.status(404).json({ error: "Version not found or does not belong to this item" });
      return;
    }
    logAudit(id, "reconfirmed", `Reverted to version ${versionId}`);
    const updated = queryOne("SELECT * FROM memory_items WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("POST /api/memory/:id/revert/:versionId error:", err);
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
    if (result.marked > 0) {
      fireWebhook("decay_applied", { marked: result.marked, ids: result.candidates.map((c) => c.id) });
    }
    res.json({ marked: result.marked, items: result.candidates });
  } catch (err) {
    console.error("POST /api/memory/decay error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /graph - return nodes and edges for memory graph visualization
router.get("/graph", (_req: Request, res: Response) => {
  try {
    // Get all active memory items as nodes
    const items = queryAll(
      "SELECT id, key, type, value, scope, domain, confidence, pinned FROM memory_items WHERE status = 'active' ORDER BY created_at DESC LIMIT 200"
    ) as any[];

    // Get all links as edges
    const links = queryAll(
      "SELECT id, source_id, target_id, relation, strength FROM memory_links"
    ) as any[];

    // Compute importance for sizing nodes
    const nodes = items.map((item) => {
      const importance = computeImportance(item.id);
      return {
        id: item.id,
        key: item.key,
        type: item.type,
        value: item.value.slice(0, 80),
        scope: item.scope,
        domain: item.domain,
        pinned: !!item.pinned,
        importance: importance.total,
      };
    });

    // Only include edges where both nodes exist in the active set
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = links
      .filter((l) => nodeIds.has(l.source_id) && nodeIds.has(l.target_id))
      .map((l) => ({
        id: l.id,
        source: l.source_id,
        target: l.target_id,
        relation: l.relation,
        strength: l.strength,
      }));

    // Also add implicit edges for items sharing the same key (potential duplicates)
    const byKey: Record<string, string[]> = {};
    for (const n of nodes) {
      if (!byKey[n.key]) byKey[n.key] = [];
      byKey[n.key].push(n.id);
    }
    const implicitEdges: any[] = [];
    for (const ids of Object.values(byKey)) {
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length - 1; i++) {
        implicitEdges.push({
          id: `implicit-${ids[i]}-${ids[i + 1]}`,
          source: ids[i],
          target: ids[i + 1],
          relation: "same_key",
          strength: 0.5,
        });
      }
    }

    res.json({
      nodes,
      edges: [...edges, ...implicitEdges],
      stats: {
        node_count: nodes.length,
        edge_count: edges.length,
        implicit_edge_count: implicitEdges.length,
      },
    });
  } catch (err) {
    console.error("GET /api/memory/graph error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /duplicates - find groups of likely duplicate memory items
router.get("/duplicates", (req: Request, res: Response) => {
  try {
    const threshold = parseFloat(req.query.threshold as string) || 0.6;
    const groups = findDuplicates(threshold);
    res.json({ count: groups.length, groups });
  } catch (err) {
    console.error("GET /api/memory/duplicates error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /suggestions - smart suggestions for improving memory quality
router.get("/suggestions", (_req: Request, res: Response) => {
  try {
    const suggestions = generateSuggestions();
    res.json(suggestions);
  } catch (err) {
    console.error("GET /api/memory/suggestions error:", err);
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
    fireWebhook("merged", { source_id, target_id, kept_id: target_id });

    const updated = queryOne("SELECT * FROM memory_items WHERE id = ?", [target_id]);
    res.json(updated);
  } catch (err) {
    console.error("POST /api/memory/merge error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
