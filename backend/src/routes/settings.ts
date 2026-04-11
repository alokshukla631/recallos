import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { queryAll, queryOne, runSql } from "../db/index.js";
import { generateMcpConfig, generateClaudeDesktopConfig, getClaudeDesktopConfigPath, installClaudeDesktopConfig } from "../modules/mcp-config.js";
import { registerWebhook, listWebhooks, deleteWebhook, toggleWebhook } from "../modules/webhooks.js";

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

// GET /mcp/config - get the MCP config entry for RecallOS
router.get("/mcp/config", (_req: Request, res: Response) => {
  try {
    const config = generateMcpConfig();
    const configPath = getClaudeDesktopConfigPath();
    res.json({
      config,
      claude_desktop_config_path: configPath,
      instructions: "Add this entry under 'mcpServers' in your Claude Desktop config, or use POST /api/settings/mcp/install to auto-install.",
    });
  } catch (err) {
    console.error("GET /api/settings/mcp/config error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /mcp/install - auto-install MCP config into Claude Desktop
router.post("/mcp/install", (req: Request, res: Response) => {
  try {
    const { db_path } = req.body;
    const writtenPath = installClaudeDesktopConfig(db_path);
    if (!writtenPath) {
      res.status(400).json({ error: "Could not determine Claude Desktop config path for this platform" });
      return;
    }
    res.json({
      installed: true,
      config_path: writtenPath,
      message: "RecallOS MCP server config installed. Restart Claude Desktop to connect.",
    });
  } catch (err) {
    console.error("POST /api/settings/mcp/install error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /webhooks - list all webhooks
router.get("/webhooks", (_req: Request, res: Response) => {
  try {
    res.json(listWebhooks());
  } catch (err) {
    console.error("GET /api/settings/webhooks error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /webhooks - register a new webhook
router.post("/webhooks", (req: Request, res: Response) => {
  try {
    const { url, events } = req.body;
    if (!url || typeof url !== "string") {
      res.status(400).json({ error: "url is required" });
      return;
    }
    const hook = registerWebhook(url, events || ["*"]);
    res.status(201).json(hook);
  } catch (err) {
    console.error("POST /api/settings/webhooks error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /webhooks/:id - toggle active/inactive
router.put("/webhooks/:id", (req: Request, res: Response) => {
  try {
    const { active } = req.body;
    const ok = toggleWebhook(req.params.id as string, !!active);
    if (!ok) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    res.json({ message: "Webhook updated" });
  } catch (err) {
    console.error("PUT /api/settings/webhooks/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /webhooks/:id - remove a webhook
router.delete("/webhooks/:id", (req: Request, res: Response) => {
  try {
    const ok = deleteWebhook(req.params.id as string);
    if (!ok) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    res.json({ message: "Webhook deleted" });
  } catch (err) {
    console.error("DELETE /api/settings/webhooks/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
