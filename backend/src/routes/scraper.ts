import { Router, Request, Response } from "express";
import { scrapeAll, getSources } from "../modules/log-scraper.js";

const router = Router();

// GET /sources - list available log sources and their status
router.get("/sources", (_req: Request, res: Response) => {
  try {
    const sources = getSources();
    res.json(sources);
  } catch (err) {
    console.error("GET /api/scraper/sources error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /run - trigger a scrape of all available sources
router.post("/run", async (_req: Request, res: Response) => {
  try {
    const results = await scrapeAll();
    res.json({
      scraped_at: new Date().toISOString(),
      results,
    });
  } catch (err) {
    console.error("POST /api/scraper/run error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
