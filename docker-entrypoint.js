/**
 * Production entrypoint for the Docker container.
 * Starts the backend API and serves the built frontend as static files.
 */
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dynamic import of the backend (it self-initialises the DB and routes)
const { default: app } = await import("./backend/dist/index.js");

// Serve the built frontend static files
const frontendDist = path.join(__dirname, "frontend", "dist");
app.use(express.static(frontendDist));

// SPA fallback: serve index.html for any non-API route
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/") || req.path === "/health") return;
  res.sendFile(path.join(frontendDist, "index.html"));
});

console.log(`RecallOS production server ready on port ${process.env.PORT || 3001}`);
console.log(`Database: ${process.env.DB_PATH || "recallos.db"}`);
console.log(`Frontend: ${frontendDist}`);
