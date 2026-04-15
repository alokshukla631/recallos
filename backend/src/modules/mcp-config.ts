/**
 * MCP auto-config generator
 *
 * Generates the JSON config that users paste into Claude Desktop's
 * claude_desktop_config.json (or other MCP-compatible tools) to connect
 * to the RecallOS MCP server.
 */

import path from "path";
import fs from "fs";
import os from "os";

export interface McpConfigEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Returns the path to the RecallOS MCP server entry point.
 * Resolves relative to this file's location (backend/src/mcp-server.ts).
 */
function getMcpServerPath(): string {
  // Detect whether running from compiled JS (dist/) or TS source (src/).
  const isDev = __filename.endsWith(".ts");
  const ext = isDev ? ".ts" : ".js";
  return path.resolve(__dirname, "..", `mcp-server${ext}`);
}

/**
 * Returns the path to the RecallOS database file.
 */
function getDbPath(): string {
  return process.env.DB_PATH || path.join(process.cwd(), "recallos.db");
}

/**
 * Generate the MCP server config entry for Claude Desktop or any MCP client.
 */
export function generateMcpConfig(dbPath?: string): McpConfigEntry {
  const serverPath = getMcpServerPath();
  const resolvedDb = dbPath || getDbPath();
  const isDev = __filename.endsWith(".ts");

  return {
    command: isDev ? "npx" : "node",
    args: isDev ? ["tsx", serverPath] : [serverPath],
    env: {
      DB_PATH: resolvedDb,
    },
  };
}

/**
 * Returns the full claude_desktop_config.json content with RecallOS added.
 * Reads the existing config if present and merges the recallos entry.
 */
export function generateClaudeDesktopConfig(dbPath?: string): Record<string, unknown> {
  const configPath = getClaudeDesktopConfigPath();
  let existing: Record<string, unknown> = {};

  if (configPath && fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      // Start fresh if existing config is malformed
    }
  }

  const mcpServers = (existing.mcpServers || {}) as Record<string, unknown>;
  mcpServers["recallos"] = generateMcpConfig(dbPath);

  return {
    ...existing,
    mcpServers,
  };
}

/**
 * Returns the platform-specific path to Claude Desktop's config file.
 */
export function getClaudeDesktopConfigPath(): string | null {
  const platform = os.platform();

  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }

  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }

  if (platform === "linux") {
    return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
  }

  return null;
}

/**
 * Write the MCP config to the Claude Desktop config file.
 * Returns the path where the config was written.
 */
export function installClaudeDesktopConfig(dbPath?: string): string | null {
  const configPath = getClaudeDesktopConfigPath();
  if (!configPath) return null;

  const config = generateClaudeDesktopConfig(dbPath);
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
