import { Router, Request, Response } from "express";
import { exportPassport, exportPassportMarkdown, importPassport, type Passport, type ExportFilters } from "../modules/passport.js";

const router = Router();

// GET /export - export memory as a portable JSON passport (supports filters)
router.get("/export", (req: Request, res: Response) => {
  try {
    const filters: ExportFilters = {};
    if (req.query.type) filters.type = req.query.type as string;
    if (req.query.scope) filters.scope = req.query.scope as string;
    if (req.query.domain) filters.domain = req.query.domain as string;
    if (req.query.tag) filters.tag = req.query.tag as string;
    if (req.query.pinned !== undefined) filters.pinned = req.query.pinned === "true";

    const passport = exportPassport(Object.keys(filters).length > 0 ? filters : undefined);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="recallos-passport-${new Date().toISOString().slice(0, 10)}.json"`
    );
    res.json(passport);
  } catch (err) {
    console.error("GET /api/passport/export error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});

// GET /export/csv - export memory items as CSV
router.get("/export/csv", (req: Request, res: Response) => {
  try {
    const filters: ExportFilters = {};
    if (req.query.type) filters.type = req.query.type as string;
    if (req.query.scope) filters.scope = req.query.scope as string;
    if (req.query.domain) filters.domain = req.query.domain as string;
    if (req.query.tag) filters.tag = req.query.tag as string;
    if (req.query.pinned !== undefined) filters.pinned = req.query.pinned === "true";

    const passport = exportPassport(Object.keys(filters).length > 0 ? filters : undefined);

    // Build CSV
    const headers = ["key", "type", "value", "scope", "confidence", "authority", "trip_name", "created_at", "last_confirmed_at"];
    const escapeCSV = (val: string | null): string => {
      if (val === null || val === undefined) return "";
      const s = String(val);
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const rows = [headers.join(",")];
    for (const item of passport.memory_items) {
      rows.push(headers.map((h) => escapeCSV((item as any)[h] ?? null)).join(","));
    }

    const csv = rows.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="recallos-memory-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.send(csv);
  } catch (err) {
    console.error("GET /api/passport/export/csv error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});

// GET /export/markdown - export all memory as readable Markdown
router.get("/export/markdown", (_req: Request, res: Response) => {
  try {
    const md = exportPassportMarkdown();
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="recallos-memory-${new Date().toISOString().slice(0, 10)}.md"`
    );
    res.send(md);
  } catch (err) {
    console.error("GET /api/passport/export/markdown error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});

// POST /import - import a passport JSON into the local database
router.post("/import", (req: Request, res: Response) => {
  try {
    const passport = req.body as Passport;

    if (!passport || !passport.format) {
      res.status(400).json({ error: "Invalid passport format. Expected a RecallOS passport JSON." });
      return;
    }

    const result = importPassport(passport);
    res.json({
      message: "Import complete",
      ...result,
    });
  } catch (err) {
    console.error("POST /api/passport/import error:", err);
    const message = err instanceof Error ? err.message : "Import failed";
    res.status(400).json({ error: message });
  }
});

export default router;
