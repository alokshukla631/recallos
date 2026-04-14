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
import { rateLimits } from "./middleware/rate-limit.js";
import { queryOne } from "./db/index.js";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "recallos.db");

app.use(cors());
app.use(express.json());

// Rate limiting
app.use("/api/chat", rateLimits.chat);
app.use("/api/memory/bulk", rateLimits.bulk);
app.use("/api/memory/batch", rateLimits.bulk);
app.use("/api/memory/merge", rateLimits.write);
app.use("/api/memory/decay", rateLimits.write);
app.use("/api/memory", rateLimits.standard);
app.use("/api/context", rateLimits.standard);
app.use("/api/scraper", rateLimits.bulk);

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
  try {
    const memoryCount = queryOne("SELECT COUNT(*) as count FROM memory_items WHERE status = 'active'") as any;
    const pinnedCount = queryOne("SELECT COUNT(*) as count FROM memory_items WHERE pinned = 1") as any;
    const convCount = queryOne("SELECT COUNT(*) as count FROM conversations") as any;
    const providerCount = queryOne("SELECT COUNT(*) as count FROM provider_settings") as any;

    // Database file size
    let dbSizeBytes = 0;
    try {
      const stat = fs.statSync(DB_PATH);
      dbSizeBytes = stat.size;
    } catch {
      // file might not exist yet
    }

    res.json({
      status: "ok",
      version: "0.1.0",
      uptime_seconds: Math.floor(process.uptime()),
      database: {
        path: DB_PATH,
        size_bytes: dbSizeBytes,
        size_human: dbSizeBytes > 1024 * 1024
          ? `${(dbSizeBytes / (1024 * 1024)).toFixed(1)} MB`
          : `${(dbSizeBytes / 1024).toFixed(1)} KB`,
      },
      counts: {
        active_memories: memoryCount?.count || 0,
        pinned_memories: pinnedCount?.count || 0,
        conversations: convCount?.count || 0,
        providers: providerCount?.count || 0,
      },
    });
  } catch {
    res.json({ status: "ok" });
  }
});

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Run every hour
const DECAY_INTERVAL_MS = 60 * 60 * 1000; // Same as session cleanup
const SCRAPER_INTERVAL_MS = parseInt(process.env.SCRAPER_INTERVAL_MS || "") || 4 * 60 * 60 * 1000; // Default: every 4 hours

// Track scheduled task run times
const scheduledTaskState = {
  session_cleanup: { last_run: null as string | null, interval_ms: SESSION_CLEANUP_INTERVAL_MS },
  confidence_decay: { last_run: null as string | null, interval_ms: DECAY_INTERVAL_MS },
  scraper: { last_run: null as string | null, interval_ms: SCRAPER_INTERVAL_MS, enabled: process.env.DISABLE_SCRAPER !== "1" },
};

// GET /api/settings/scheduled-tasks - show scheduled background tasks
app.get("/api/settings/scheduled-tasks", (_req, res) => {
  const tasks = Object.entries(scheduledTaskState).map(([name, state]) => ({
    name,
    last_run: state.last_run,
    interval_ms: state.interval_ms,
    interval_human: state.interval_ms >= 3600000
      ? `${Math.round(state.interval_ms / 3600000)}h`
      : `${Math.round(state.interval_ms / 60000)}min`,
    enabled: "enabled" in state ? (state as any).enabled : true,
  }));
  res.json(tasks);
});

async function start() {
  await initDatabase(DB_PATH);
  console.log(`Database initialized at ${DB_PATH}`);

  // Run session cleanup and confidence decay on startup and then every hour
  const expired = expireSessionMemory();
  if (expired > 0) console.log(`Session cleanup: expired ${expired} items on startup`);
  scheduledTaskState.session_cleanup.last_run = new Date().toISOString();

  const decay = applyConfidenceDecay();
  if (decay.decayed > 0 || decay.staled > 0) {
    console.log(`Confidence decay: ${decay.decayed} decayed, ${decay.staled} staled on startup`);
  }
  scheduledTaskState.confidence_decay.last_run = new Date().toISOString();

  setInterval(() => {
    const count = expireSessionMemory();
    if (count > 0) console.log(`Session cleanup: expired ${count} items`);
    scheduledTaskState.session_cleanup.last_run = new Date().toISOString();
    const d = applyConfidenceDecay();
    if (d.decayed > 0 || d.staled > 0) {
      console.log(`Confidence decay: ${d.decayed} decayed, ${d.staled} staled`);
    }
    scheduledTaskState.confidence_decay.last_run = new Date().toISOString();
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
        scheduledTaskState.scraper.last_run = new Date().toISOString();
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
