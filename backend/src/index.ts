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

async function start() {
  await initDatabase(DB_PATH);
  console.log(`Database initialized at ${DB_PATH}`);

  // Run session cleanup on startup and then every hour
  const expired = expireSessionMemory();
  if (expired > 0) console.log(`Session cleanup: expired ${expired} items on startup`);

  setInterval(() => {
    const count = expireSessionMemory();
    if (count > 0) console.log(`Session cleanup: expired ${count} items`);
  }, SESSION_CLEANUP_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`RecallOS backend listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

export default app;
