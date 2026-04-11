import { Router, Request, Response } from "express";
import { exportPassport, exportPassportMarkdown, importPassport, type Passport } from "../modules/passport.js";

const router = Router();

// GET /export - export all memory as a portable JSON passport
router.get("/export", (_req: Request, res: Response) => {
  try {
    const passport = exportPassport();
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
