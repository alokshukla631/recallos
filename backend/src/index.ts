import express from "express";
import cors from "cors";
import path from "path";
import { initDatabase } from "./db/index.js";
import chatRouter from "./routes/chat.js";
import memoryRouter from "./routes/memory.js";
import settingsRouter from "./routes/settings.js";
import contextRouter from "./routes/context.js";
import tripsRouter from "./routes/trips.js";
import passportRouter from "./routes/passport.js";
import docsRouter from "./routes/docs.js";
import agentsRouter from "./routes/agents.js";
import scraperRouter from "./routes/scraper.js";
import { expireSessionMemory } from "./modules/session-cleanup.js";
import { applyConfidenceDecay } from "./modules/confidence-decay.js";
import { scrapeAll } from "./modules/log-scraper.js";

const app = express();
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "recallos.db");

app.use(cors());
app.use(express.json());

app.use("/api/chat", chatRouter);
app.use("/api/memory", memoryRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/context", contextRouter);
app.use("/api/trips", tripsRouter);
app.use("/api/passport", passportRouter);
app.use("/api/docs", docsRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/scraper", scraperRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Run every hour
const SCRAPER_INTERVAL_MS = parseInt(process.env.SCRAPER_INTERVAL_MS || "") || 4 * 60 * 60 * 1000; // Default: every 4 hours

async function start() {
  await initDatabase(DB_PATH);
  console.log(`Database initialized at ${DB_PATH}`);

  // Run session cleanup and confidence decay on startup and then every hour
  const expired = expireSessionMemory();
  if (expired > 0) console.log(`Session cleanup: expired ${expired} items on startup`);
  const decay = applyConfidenceDecay();
  if (decay.decayed > 0 || decay.staled > 0) {
    console.log(`Confidence decay: ${decay.decayed} decayed, ${decay.staled} staled on startup`);
  }

  setInterval(() => {
    const count = expireSessionMemory();
    if (count > 0) console.log(`Session cleanup: expired ${count} items`);
    const d = applyConfidenceDecay();
    if (d.decayed > 0 || d.staled > 0) {
      console.log(`Confidence decay: ${d.decayed} decayed, ${d.staled} staled`);
    }
  }, SESSION_CLEANUP_INTERVAL_MS);

  // Scheduled scraper (every 4 hours by default, configurable via SCRAPER_INTERVAL_MS env)
  if (process.env.DISABLE_SCRAPER !== "1") {
    setInterval(async () => {
      try {
        const results = await scrapeAll();
        const totalNew = results.reduce((sum, r) => sum + r.messagesNew, 0);
        const totalMemory = results.reduce((sum, r) => sum + r.memoryExtracted, 0);
        if (totalNew > 0 || totalMemory > 0) {
          console.log(`Scheduled scrape: ${totalNew} new messages, ${totalMemory} memory extracted`);
        }
      } catch (err) {
        console.error("Scheduled scrape error:", err);
      }
    }, SCRAPER_INTERVAL_MS);
    console.log(`Scheduled scraper: every ${Math.round(SCRAPER_INTERVAL_MS / 60000)}min`);
  }

  app.listen(PORT, () => {
    console.log(`RecallOS backend listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

export default app;
