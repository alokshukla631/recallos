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

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

async function start() {
  await initDatabase(DB_PATH);
  console.log(`Database initialized at ${DB_PATH}`);

  app.listen(PORT, () => {
    console.log(`RecallOS backend listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

export default app;
