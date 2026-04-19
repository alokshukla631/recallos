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
import {
  ensureConflictsTable,
  detectConflicts,
  getConflicts,
  getPendingConflicts,
  resolveConflict,
  getPendingConflictCount,
} from "../modules/conflicts.js";
import { detectDomain } from "../modules/domain-detector.js";

// Lazy initialization: these tables are created on first request, not at import time,
// because router modules are imported before initDatabase() runs in index.ts.
let _tablesInitialized = false;
function ensureTables() {
  if (_tablesInitialized) return;
  ensureVersionTable();
  ensureConflictsTable();
  _tablesInitialized = true;
}

const router = Router();

// Middleware: ensure extra tables exist before handling any request
router.use((_req, _res, next) => {
  ensureTables();
  next();
});

// GET / - list memory items with optional filters
router.get("/", (req: Request, res: Response) => {
  try {
    const { scope, type, status = "active", project_id } = req.query;

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
    if (project_id) {
      sql += " AND project_id = ?";
      params.push(project_id);
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
    const { key, type, value, scope, domain, confidence, project_id } = req.body;

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
    const validScopes = ["global", "domain", "project", "session"];
    const itemScope = validScopes.includes(scope) ? scope : "global";
    const itemConfidence = typeof confidence === "number" ? Math.max(0, Math.min(1, confidence)) : 0.8;

    const id = uuidv4();
    const now = new Date().toISOString();

    // Auto-detect domain if not provided
    const itemDomain = domain || detectDomain(key.trim(), value.trim());

    runSql(
      `INSERT INTO memory_items (id, key, type, value, scope, domain, project_id, confidence, authority, status, last_confirmed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'explicit', 'active', ?, ?)`,
      [id, key.trim(), itemType, value.trim(), itemScope, itemDomain, project_id || null, itemConfidence, now, now]
    );

    logAudit(id, "created", "Manually created by user");
    fireWebhook("created", { id, key: key.trim(), type: itemType, value: value.trim(), scope: itemScope });

    // Detect conflicts with existing items
    const conflicts = detectConflicts(id, key.trim(), value.trim());
    if (conflicts.length > 0) {
      fireWebhook("conflict", { id, key: key.trim(), conflicts: conflicts.length });
    }

    const created = queryOne("SELECT * FROM memory_items WHERE id = ?", [id]);
    res.status(201).json({ ...created as object, conflicts });
  } catch (err) {
    console.error("POST /api/memory error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /recently-deleted - list recently deleted items
router.get("/recently-deleted", (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const items = queryAll(
      `SELECT mi.*, al.created_at AS deleted_at
       FROM memory_items mi
       INNER JOIN memory_audit_log al ON al.memory_item_id = mi.id AND al.action = 'deleted'
       WHERE mi.status IN ('stale', 'superseded')
       ORDER BY al.created_at DESC
       LIMIT ?`,
      [limit]
    );
    res.json(items);
  } catch (err) {
    console.error("GET /api/memory/recently-deleted error:", err);
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
    const projectsCount = queryOne(
      "SELECT COUNT(*) as count FROM projects"
    ) as any;

    // Conversations count
    const convsCount = queryOne(
      "SELECT COUNT(*) as count FROM conversations"
    ) as any;

    // Pending conflicts
    const pendingConflictsCount = getPendingConflictCount();

    // Pinned count
    const pinnedCount = queryOne(
      "SELECT COUNT(*) as count FROM memory_items WHERE pinned = 1 AND status = 'active'"
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
      projects: projectsCount?.count || 0,
      conversations: convsCount?.count || 0,
      pending_conflicts: pendingConflictsCount,
      pinned: pinnedCount?.count || 0,
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

// GET /stats/trends - daily counts over time (created, deleted, restored)
router.get("/stats/trends", (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const trends = queryAll(
      `SELECT
         date(created_at) as day,
         action,
         COUNT(*) as count
       FROM memory_audit_log
       WHERE created_at >= datetime('now', '-' || ? || ' days')
       GROUP BY day, action
       ORDER BY day ASC`,
      [days]
    ) as Array<{ day: string; action: string; count: number }>;

    // Pivot by day
    const byDay: Record<string, Record<string, number>> = {};
    for (const row of trends) {
      if (!byDay[row.day]) byDay[row.day] = {};
      byDay[row.day][row.action] = row.count;
    }

    const result = Object.entries(byDay).map(([day, actions]) => ({
      day,
      ...actions,
      total: Object.values(actions).reduce((s, c) => s + c, 0),
    }));

    res.json(result);
  } catch (err) {
    console.error("GET /api/memory/stats/trends error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /stats/analytics - advanced memory analytics
router.get("/stats/analytics", (_req: Request, res: Response) => {
  try {
    // Growth rate: items created per week for last 8 weeks
    const weeklyGrowth = queryAll(
      `SELECT strftime('%Y-W%W', created_at) as week, COUNT(*) as created
       FROM memory_items
       WHERE created_at >= datetime('now', '-56 days')
       GROUP BY week ORDER BY week ASC`
    );

    // Top 10 most confirmed keys (join to memory_items to resolve the key name;
    // memory_audit_log has memory_item_id, not a memory_key column)
    const mostConfirmed = queryAll(
      `SELECT mi.key AS key, COUNT(*) AS confirmations
       FROM memory_audit_log al
       LEFT JOIN memory_items mi ON mi.id = al.memory_item_id
       WHERE al.action = 'reconfirmed' AND mi.key IS NOT NULL
       GROUP BY mi.key ORDER BY confirmations DESC LIMIT 10`
    );

    // Items by status
    const byStatus = queryAll(
      `SELECT status, COUNT(*) as count FROM memory_items GROUP BY status`
    );

    // Average confidence by type
    const avgConfidenceByType = queryAll(
      `SELECT type, ROUND(AVG(confidence), 3) as avg_confidence, COUNT(*) as count
       FROM memory_items WHERE status = 'active'
       GROUP BY type ORDER BY avg_confidence DESC`
    );

    // Pinned items by domain
    const pinnedByDomain = queryAll(
      `SELECT COALESCE(domain, 'none') as domain, COUNT(*) as count
       FROM memory_items WHERE pinned = 1
       GROUP BY domain ORDER BY count DESC`
    );

    // Memory age stats
    const ageStats = queryOne(
      `SELECT
         MIN(created_at) as oldest,
         MAX(created_at) as newest,
         COUNT(*) as total
       FROM memory_items WHERE status = 'active'`
    );

    // Most linked items (top 10)
    const mostLinked = queryAll(
      `SELECT m.key, m.type, COUNT(DISTINCT l.id) as link_count
       FROM memory_items m
       JOIN memory_links l ON m.id = l.source_id OR m.id = l.target_id
       WHERE m.status = 'active'
       GROUP BY m.id ORDER BY link_count DESC LIMIT 10`
    );

    // Context inclusion rate (how often items get included)
    const totalSnapshots = queryOne(`SELECT COUNT(*) as count FROM context_snapshots`);

    res.json({
      weekly_growth: weeklyGrowth,
      most_confirmed: mostConfirmed,
      by_status: byStatus,
      avg_confidence_by_type: avgConfidenceByType,
      pinned_by_domain: pinnedByDomain,
      age_stats: ageStats || {},
      most_linked: mostLinked,
      total_snapshots: (totalSnapshots as any)?.count || 0,
    });
  } catch (err) {
    console.error("GET /api/memory/stats/analytics error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /stats/quality - memory quality score and recommendations
router.get("/stats/quality", (_req: Request, res: Response) => {
  try {
    // Total active items
    const totalRow = queryOne(
      `SELECT COUNT(*) as count FROM memory_items WHERE status = 'active'`
    ) as any;
    const totalActive = totalRow?.count || 0;

    // Items with low confidence (<0.5)
    const lowConfRow = queryOne(
      `SELECT COUNT(*) as count FROM memory_items WHERE status = 'active' AND confidence < 0.5`
    ) as any;
    const lowConfidence = lowConfRow?.count || 0;

    // Items never confirmed (no reconfirmation in audit log)
    const neverConfirmedRow = queryOne(
      `SELECT COUNT(*) as count FROM memory_items m
       WHERE m.status = 'active' AND m.last_confirmed_at IS NULL
       AND m.created_at < datetime('now', '-7 days')`
    ) as any;
    const neverConfirmed = neverConfirmedRow?.count || 0;

    // Items with no tags
    const noTagsRow = queryOne(
      `SELECT COUNT(*) as count FROM memory_items m
       WHERE m.status = 'active'
       AND m.id NOT IN (SELECT memory_item_id FROM memory_tags)`
    ) as any;
    const noTags = noTagsRow?.count || 0;

    // Items with no links
    const noLinksRow = queryOne(
      `SELECT COUNT(*) as count FROM memory_items m
       WHERE m.status = 'active'
       AND m.id NOT IN (SELECT source_id FROM memory_links UNION SELECT target_id FROM memory_links)`
    ) as any;
    const noLinks = noLinksRow?.count || 0;

    // Duplicate key groups (same key, multiple active items)
    const dupGroups = queryAll(
      `SELECT key, COUNT(*) as count FROM memory_items
       WHERE status = 'active' GROUP BY key HAVING count > 1`
    ) as any[];

    // Short values (<20 chars, likely low quality)
    const shortValuesRow = queryOne(
      `SELECT COUNT(*) as count FROM memory_items
       WHERE status = 'active' AND LENGTH(value) < 20`
    ) as any;
    const shortValues = shortValuesRow?.count || 0;

    // Stale items count
    const staleRow = queryOne(
      `SELECT COUNT(*) as count FROM memory_items WHERE status = 'stale'`
    ) as any;
    const staleCount = staleRow?.count || 0;

    // Calculate quality score (0-100)
    let score = 100;
    const issues: Array<{ type: string; severity: string; message: string; count: number }> = [];

    // Deduct for low confidence items (high severity)
    if (totalActive > 0) {
      const lowConfPct = lowConfidence / totalActive;
      if (lowConfPct > 0.3) {
        score -= 20;
        issues.push({ type: "low_confidence", severity: "high", message: `${lowConfidence} items have confidence below 50%`, count: lowConfidence });
      } else if (lowConfPct > 0.1) {
        score -= 10;
        issues.push({ type: "low_confidence", severity: "medium", message: `${lowConfidence} items have confidence below 50%`, count: lowConfidence });
      }
    }

    // Deduct for never-confirmed items
    if (neverConfirmed > 5) {
      score -= 10;
      issues.push({ type: "never_confirmed", severity: "medium", message: `${neverConfirmed} items created over 7 days ago have never been confirmed`, count: neverConfirmed });
    }

    // Deduct for duplicate keys
    if (dupGroups.length > 3) {
      score -= 15;
      issues.push({ type: "duplicate_keys", severity: "high", message: `${dupGroups.length} keys have multiple active items -- consider merging`, count: dupGroups.length });
    } else if (dupGroups.length > 0) {
      score -= 5;
      issues.push({ type: "duplicate_keys", severity: "low", message: `${dupGroups.length} keys have multiple active items`, count: dupGroups.length });
    }

    // Deduct for short values
    if (shortValues > 5) {
      score -= 10;
      issues.push({ type: "short_values", severity: "medium", message: `${shortValues} items have very short values (under 20 chars)`, count: shortValues });
    }

    // Deduct for too many stale items
    if (staleCount > totalActive * 0.5 && staleCount > 10) {
      score -= 10;
      issues.push({ type: "stale_buildup", severity: "medium", message: `${staleCount} stale items -- consider running cleanup`, count: staleCount });
    }

    // Bonus for good practices
    const taggedPct = totalActive > 0 ? (totalActive - noTags) / totalActive : 0;
    const linkedPct = totalActive > 0 ? (totalActive - noLinks) / totalActive : 0;

    // Recommendations
    const recommendations: Array<{ action: string; description: string; priority: string }> = [];

    if (lowConfidence > 0) {
      recommendations.push({ action: "reconfirm", description: `Reconfirm ${lowConfidence} low-confidence items to boost their scores`, priority: "high" });
    }
    if (dupGroups.length > 0) {
      recommendations.push({ action: "merge_duplicates", description: `Merge ${dupGroups.length} duplicate key groups`, priority: dupGroups.length > 3 ? "high" : "medium" });
    }
    if (noTags > totalActive * 0.5 && totalActive > 5) {
      recommendations.push({ action: "add_tags", description: `Add tags to improve organization (${noTags} items have no tags)`, priority: "low" });
    }
    if (noLinks > totalActive * 0.7 && totalActive > 10) {
      recommendations.push({ action: "add_links", description: `Create links between related items (${noLinks} items are unlinked)`, priority: "low" });
    }
    if (shortValues > 0) {
      recommendations.push({ action: "improve_values", description: `${shortValues} items have very short values -- add more detail`, priority: "medium" });
    }
    if (staleCount > 10) {
      recommendations.push({ action: "clean_stale", description: `Clear ${staleCount} stale items from the database`, priority: "medium" });
    }
    if (neverConfirmed > 5) {
      recommendations.push({ action: "confirm_old", description: `Review and confirm ${neverConfirmed} unconfirmed items over 7 days old`, priority: "medium" });
    }

    score = Math.max(0, Math.min(100, score));

    res.json({
      score,
      grade: score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F",
      total_active: totalActive,
      breakdown: {
        low_confidence: lowConfidence,
        never_confirmed: neverConfirmed,
        no_tags: noTags,
        no_links: noLinks,
        duplicate_keys: dupGroups.length,
        short_values: shortValues,
        stale_count: staleCount,
        tagged_pct: Math.round(taggedPct * 100),
        linked_pct: Math.round(linkedPct * 100),
      },
      issues,
      recommendations,
    });
  } catch (err) {
    console.error("GET /api/memory/stats/quality error:", err);
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
    // Boost confidence by 5% on each reconfirmation (capped at 1.0)
    const full = queryOne("SELECT confidence FROM memory_items WHERE id = ?", [id]) as any;
    const currentConf = full?.confidence ?? 0.8;
    const boosted = Math.min(1.0, currentConf + 0.05);
    runSql(
      "UPDATE memory_items SET last_confirmed_at = ?, status = 'active', confidence = ? WHERE id = ?",
      [now, boosted, id]
    );
    logAudit(id, "reconfirmed", `Manual reconfirmation (confidence ${Math.round(currentConf * 100)}% -> ${Math.round(boosted * 100)}%)`);
    fireWebhook("reconfirmed", { id, last_confirmed_at: now, confidence: boosted });
    res.json({ message: "Memory item reconfirmed", last_confirmed_at: now, confidence: boosted });
  } catch (err) {
    console.error("POST /api/memory/:id/reconfirm error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/pin - pin a memory item (always included in context)
router.post("/:id/pin", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const reason = req.body?.reason || "";
    const item = queryOne("SELECT id FROM memory_items WHERE id = ?", [id]) as any;
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    runSql("UPDATE memory_items SET pinned = 1 WHERE id = ?", [id]);
    logAudit(id, "pinned", reason ? `Pinned: ${reason}` : "Pinned by user");
    fireWebhook("pinned", { id, reason });
    res.json({ message: "Memory item pinned", pinned: true, reason });
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
    logAudit(id, "unpinned", "Unpinned by user");
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
    const { statements, project_id } = req.body;
    if (!Array.isArray(statements) || statements.length === 0) {
      res.status(400).json({ error: "statements must be a non-empty array of strings" });
      return;
    }

    let totalExtracted = 0;
    let totalAdded = 0;
    let totalDuplicates = 0;

    for (const text of statements) {
      if (typeof text !== "string" || text.trim().length < 5) continue;
      // Pass null as source_event_id — bulk text has no backing event row,
      // so a synthetic ID would violate the FK constraint on memory_items.
      const candidates = await extractMemory(text.trim(), "", project_id);
      if (candidates.length > 0) {
        const result = await reconcileMemory(candidates, null);
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
          logAudit(id, "pinned", "Batch pin");
          break;
        case "unpin":
          runSql("UPDATE memory_items SET pinned = 0 WHERE id = ?", [id]);
          logAudit(id, "unpinned", "Batch unpin");
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

// POST /import - bulk import memories from JSON array
router.post("/import", (req: Request, res: Response) => {
  try {
    const { items: importItems } = req.body;
    if (!Array.isArray(importItems) || importItems.length === 0) {
      res.status(400).json({ error: "items must be a non-empty array" });
      return;
    }
    if (importItems.length > 200) {
      res.status(400).json({ error: "Maximum 200 items per import" });
      return;
    }

    const now = new Date().toISOString();
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const entry of importItems) {
      const { key, value, type, scope, domain, confidence } = entry;
      if (!key || !value) {
        skipped++;
        errors.push(`Missing key or value for entry: ${key || "(no key)"}`);
        continue;
      }

      const validTypes = ["preference", "constraint", "fact", "goal", "override"];
      const validScopes = ["global", "domain", "project", "session"];
      const itemType = validTypes.includes(type) ? type : "fact";
      const itemScope = validScopes.includes(scope) ? scope : "global";
      const itemConfidence = typeof confidence === "number" ? Math.min(1, Math.max(0, confidence)) : 0.8;

      const id = uuidv4();
      runSql(
        `INSERT INTO memory_items (id, key, value, type, scope, domain, confidence, status, pinned, created_at, last_confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
        [id, key, value, itemType, itemScope, domain || null, itemConfidence, now, now]
      );
      logAudit(id, "imported", `Bulk import`);
      imported++;
    }

    fireWebhook("imported", { imported, skipped });
    res.json({ imported, skipped, errors: errors.slice(0, 10) });
  } catch (err) {
    console.error("POST /api/memory/import error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /conflicts - list conflicts
router.get("/conflicts", (req: Request, res: Response) => {
  try {
    const status = req.query.status as string || "pending";
    const conflicts = getConflicts(status);
    const pendingCount = getPendingConflictCount();
    res.json({ pending_count: pendingCount, conflicts });
  } catch (err) {
    console.error("GET /api/memory/conflicts error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /conflicts/:id/resolve - resolve a conflict
router.post("/conflicts/:id/resolve", (req: Request, res: Response) => {
  try {
    const conflictId = req.params.id as string;
    const { resolution, merged_value } = req.body;
    if (!["keep_new", "keep_old", "merged"].includes(resolution)) {
      res.status(400).json({ error: "resolution must be keep_new, keep_old, or merged" });
      return;
    }
    resolveConflict(conflictId, resolution, merged_value);
    fireWebhook("conflict_resolved", { conflict_id: conflictId, resolution });
    res.json({ message: "Conflict resolved", conflict_id: conflictId, resolution });
  } catch (err: any) {
    console.error("POST /api/memory/conflicts/:id/resolve error:", err);
    res.status(err.message === "Conflict not found" ? 404 : 500).json({
      error: err.message || "Internal server error",
    });
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

// POST /:id/restore - restore a deleted/stale item back to active
router.post("/:id/restore", (req: Request, res: Response) => {
  try {
    const existing = queryOne("SELECT * FROM memory_items WHERE id = ?", [req.params.id]);
    if (!existing) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    if ((existing as any).status === "active") {
      res.json({ message: "Item is already active" });
      return;
    }
    runSql("UPDATE memory_items SET status = 'active', superseded_by = NULL WHERE id = ?", [req.params.id]);
    logAudit(req.params.id as string, "restored", "Restored to active status");
    fireWebhook("restored", { id: req.params.id });
    res.json({ message: "Memory item restored" });
  } catch (err) {
    console.error("POST /api/memory/:id/restore error:", err);
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
    // Only include params that were actually provided. Passing undefined
    // values would overwrite the defaults in findDecayCandidates.
    const config: Record<string, number> = {};
    if (req.query.max_age_days) config.maxAgeDays = parseInt(req.query.max_age_days as string);
    if (req.query.max_stale_days) config.maxStaleDays = parseInt(req.query.max_stale_days as string);
    if (req.query.min_importance) config.minImportance = parseInt(req.query.min_importance as string);
    const candidates = findDecayCandidates(config);
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
    // Only include params that were actually provided to avoid overwriting defaults.
    const decayConfig: Record<string, number> = {};
    if (max_age_days != null) decayConfig.maxAgeDays = max_age_days;
    if (max_stale_days != null) decayConfig.maxStaleDays = max_stale_days;
    if (min_importance != null) decayConfig.minImportance = min_importance;
    const result = applyDecay(decayConfig);
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

    // Validate merge compatibility — merging items of different types produces
    // incoherent memory (e.g. mixing a preference with a constraint).
    if (source.type !== target.type) {
      res.status(400).json({
        error: `Cannot merge items of different types: "${source.type}" vs "${target.type}"`,
      });
      return;
    }

    // Collect non-fatal warnings for scope/domain mismatches so the caller
    // can decide whether to proceed.
    const mergeWarnings: string[] = [];
    if (source.scope !== target.scope) {
      mergeWarnings.push(`scope mismatch: "${source.scope}" vs "${target.scope}"`);
    }
    if (source.domain !== target.domain) {
      mergeWarnings.push(
        `domain mismatch: "${source.domain || "none"}" vs "${target.domain || "none"}"`
      );
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
    res.json({
      ...(updated as object),
      merge_warnings: mergeWarnings,
    });
  } catch (err) {
    console.error("POST /api/memory/merge error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Parametric GET routes MUST be registered last so they don't shadow
// static paths like /stats, /tags, /search, /conflicts, /graph, etc.
// ---------------------------------------------------------------------------

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

export default router;
