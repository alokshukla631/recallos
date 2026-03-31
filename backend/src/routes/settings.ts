import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { queryAll, queryOne, runSql } from "../db/index.js";

const router = Router();

// GET /providers - list configured providers (mask API keys)
router.get("/providers", (_req: Request, res: Response) => {
  try {
    const rows = queryAll("SELECT id, provider, is_default, created_at FROM provider_settings ORDER BY provider");
    res.json(rows);
  } catch (err) {
    console.error("GET /api/settings/providers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /providers/default - get default provider
router.get("/providers/default", (_req: Request, res: Response) => {
  try {
    const row = queryOne("SELECT id, provider, is_default, created_at FROM provider_settings WHERE is_default = 1");
    if (!row) {
      res.json({ provider: null });
      return;
    }
    res.json(row);
  } catch (err) {
    console.error("GET /api/settings/providers/default error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /providers/default - set default provider
router.put("/providers/default", (req: Request, res: Response) => {
  try {
    const { provider } = req.body;
    if (!provider) {
      res.status(400).json({ error: "provider is required" });
      return;
    }

    const existing = queryOne("SELECT * FROM provider_settings WHERE provider = ?", [provider]);
    if (!existing) {
      res.status(404).json({ error: `Provider "${provider}" not configured` });
      return;
    }

    runSql("UPDATE provider_settings SET is_default = 0 WHERE is_default = 1");
    runSql("UPDATE provider_settings SET is_default = 1 WHERE provider = ?", [provider]);
    res.json({ message: `Default provider set to ${provider}` });
  } catch (err) {
    console.error("PUT /api/settings/providers/default error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /providers/:provider - save or update API key
router.put("/providers/:provider", (req: Request, res: Response) => {
  try {
    const { provider } = req.params;
    const { api_key } = req.body;

    if (!api_key) {
      res.status(400).json({ error: "api_key is required" });
      return;
    }

    const existing = queryOne("SELECT * FROM provider_settings WHERE provider = ?", [provider]);
    if (existing) {
      runSql("UPDATE provider_settings SET api_key = ? WHERE provider = ?", [api_key, provider]);
    } else {
      runSql(
        "INSERT INTO provider_settings (id, provider, api_key) VALUES (?, ?, ?)",
        [uuidv4(), provider, api_key]
      );
    }

    res.json({ message: `API key saved for ${provider}` });
  } catch (err) {
    console.error("PUT /api/settings/providers/:provider error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /providers/:provider - remove provider config
router.delete("/providers/:provider", (req: Request, res: Response) => {
  try {
    const existing = queryOne("SELECT * FROM provider_settings WHERE provider = ?", [req.params.provider]);
    if (!existing) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }

    runSql("DELETE FROM provider_settings WHERE provider = ?", [req.params.provider]);
    res.json({ message: `Provider ${req.params.provider} removed` });
  } catch (err) {
    console.error("DELETE /api/settings/providers/:provider error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
