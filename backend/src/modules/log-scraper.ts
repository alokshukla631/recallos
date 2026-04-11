/**
 * Log Scraper - Cross-tool continuity
 *
 * Watches local chat logs from AI tools (Claude Code, Cursor, VS Code)
 * and extracts memory from conversations that happened outside RecallOS.
 *
 * This is the core "talk to Claude in the morning, ChatGPT in the afternoon,
 * both get the same context" feature.
 */

import fs from "fs";
import path from "path";
import { extractMemory } from "./memory-extractor.js";
import { reconcileMemory } from "./memory-reconciler.js";
import { logAudit } from "./audit.js";
import { queryOne, runSql } from "../db/index.js";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScrapedMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  source: string; // e.g. "claude-code", "cursor", "vscode"
}

export interface ScrapeResult {
  source: string;
  messagesFound: number;
  messagesNew: number;
  memoryExtracted: number;
  errors: string[];
}

interface ScraperState {
  lastScrapeTime: Record<string, string>; // source -> ISO timestamp
  processedFiles: Record<string, string[]>; // source -> list of processed file hashes
}

// ---------------------------------------------------------------------------
// Platform paths
// ---------------------------------------------------------------------------

function getAppDataPath(): string {
  return process.env.APPDATA || path.join(process.env.HOME || "", "AppData", "Roaming");
}

function getHomePath(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

// ---------------------------------------------------------------------------
// Claude Code scraper
// ---------------------------------------------------------------------------

interface ClaudeCodeMessage {
  type: "user" | "assistant";
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  };
  timestamp?: string;
}

function findClaudeCodeTranscripts(): string[] {
  const projectsDir = path.join(getHomePath(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return [];

  const files: string[] = [];
  try {
    const projectDirs = fs.readdirSync(projectsDir);
    for (const projectDir of projectDirs) {
      const fullDir = path.join(projectsDir, projectDir);
      if (!fs.statSync(fullDir).isDirectory()) continue;

      // Look for JSONL transcript files directly in the project dir
      const entries = fs.readdirSync(fullDir);
      for (const entry of entries) {
        if (entry.endsWith(".jsonl")) {
          files.push(path.join(fullDir, entry));
        }
      }
    }
  } catch {
    // Permission errors or missing dirs are ok
  }
  return files;
}

function parseClaudeCodeTranscript(filePath: string): ScrapedMessage[] {
  const messages: ScrapedMessage[] = [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ClaudeCodeMessage;
        if (entry.type !== "user" && entry.type !== "assistant") continue;
        if (!entry.message?.content) continue;

        let text: string;
        if (typeof entry.message.content === "string") {
          text = entry.message.content;
        } else if (Array.isArray(entry.message.content)) {
          text = entry.message.content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
        } else {
          continue;
        }

        // Skip system/tool messages and very short messages
        if (text.length < 10) continue;
        // Skip messages that look like tool calls or system tags
        if (text.startsWith("<") && text.endsWith(">")) continue;

        messages.push({
          role: entry.type as "user" | "assistant",
          content: text.slice(0, 2000), // Cap at 2000 chars per message
          source: "claude-code",
        });
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File read errors
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Cursor scraper
// ---------------------------------------------------------------------------

function findCursorDb(): string | null {
  const dbPath = path.join(getAppDataPath(), "Cursor", "User", "globalStorage", "state.vscdb");
  return fs.existsSync(dbPath) ? dbPath : null;
}

async function parseCursorComposerData(): Promise<ScrapedMessage[]> {
  const dbPath = findCursorDb();
  if (!dbPath) return [];

  const messages: ScrapedMessage[] = [];
  try {
    // Use sql.js to read the Cursor SQLite database
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    // Read composer.content.* keys from cursorDiskKV
    const stmt = db.prepare(
      "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composer.content.%' ORDER BY key"
    );

    while (stmt.step()) {
      try {
        const row = stmt.getAsObject() as { key: string; value: any };
        const valueStr = typeof row.value === "string"
          ? row.value
          : row.value instanceof Uint8Array
            ? new TextDecoder().decode(row.value)
            : String(row.value);

        const data = JSON.parse(valueStr);

        // Cursor composer data typically has a conversation array
        const conversation = data.conversation || data.messages || data.bubbles || [];
        if (!Array.isArray(conversation)) continue;

        for (const msg of conversation) {
          const role = msg.role || msg.type || (msg.sender === "user" ? "user" : "assistant");
          const content = msg.content || msg.text || msg.message || "";
          if (!content || content.length < 10) continue;
          if (role !== "user" && role !== "assistant" && role !== "human") continue;

          messages.push({
            role: role === "human" ? "user" : role as "user" | "assistant",
            content: String(content).slice(0, 2000),
            source: "cursor",
          });
        }
      } catch {
        // Skip unparseable entries
      }
    }
    stmt.free();
    db.close();
  } catch {
    // DB read errors
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Windsurf scraper
// ---------------------------------------------------------------------------

function findWindsurfDb(): string | null {
  const dbPath = path.join(getAppDataPath(), "Windsurf", "User", "globalStorage", "state.vscdb");
  return fs.existsSync(dbPath) ? dbPath : null;
}

async function parseWindsurfData(): Promise<ScrapedMessage[]> {
  const dbPath = findWindsurfDb();
  if (!dbPath) return [];

  const messages: ScrapedMessage[] = [];
  try {
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    // Windsurf uses a similar structure to Cursor
    const stmt = db.prepare(
      "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composer.content.%' ORDER BY key"
    );

    while (stmt.step()) {
      try {
        const row = stmt.getAsObject() as { key: string; value: any };
        const valueStr = typeof row.value === "string"
          ? row.value
          : row.value instanceof Uint8Array
            ? new TextDecoder().decode(row.value)
            : String(row.value);

        const data = JSON.parse(valueStr);
        const conversation = data.conversation || data.messages || data.bubbles || [];
        if (!Array.isArray(conversation)) continue;

        for (const msg of conversation) {
          const role = msg.role || msg.type || (msg.sender === "user" ? "user" : "assistant");
          const content = msg.content || msg.text || msg.message || "";
          if (!content || content.length < 10) continue;
          if (role !== "user" && role !== "assistant" && role !== "human") continue;

          messages.push({
            role: role === "human" ? "user" : role as "user" | "assistant",
            content: String(content).slice(0, 2000),
            source: "windsurf",
          });
        }
      } catch {
        // Skip unparseable entries
      }
    }
    stmt.free();
    db.close();
  } catch {
    // DB read errors
  }
  return messages;
}

// ---------------------------------------------------------------------------
// ChatGPT export scraper
// ---------------------------------------------------------------------------

/**
 * Looks for a ChatGPT conversations.json export in common locations:
 * - Downloads folder
 * - A dedicated recallos imports folder
 */
function findChatGPTExport(): string | null {
  const home = getHomePath();
  const candidates = [
    path.join(home, "Downloads", "conversations.json"),
    path.join(home, "Downloads", "chatgpt-export", "conversations.json"),
    path.join(home, ".recallos", "imports", "conversations.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

interface ChatGPTConversation {
  title?: string;
  mapping?: Record<string, {
    message?: {
      author?: { role: string };
      content?: { parts?: string[] };
      create_time?: number;
    };
  }>;
}

function parseChatGPTExport(filePath: string): ScrapedMessage[] {
  const messages: ScrapedMessage[] = [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const conversations: ChatGPTConversation[] = JSON.parse(content);

    for (const conv of conversations) {
      if (!conv.mapping) continue;

      for (const node of Object.values(conv.mapping)) {
        if (!node.message) continue;
        const msg = node.message;
        const role = msg.author?.role;
        if (role !== "user" && role !== "assistant") continue;

        const parts = msg.content?.parts || [];
        const text = parts.filter((p) => typeof p === "string").join("\n");
        if (text.length < 10) continue;

        messages.push({
          role: role as "user" | "assistant",
          content: text.slice(0, 2000),
          source: "chatgpt",
          timestamp: msg.create_time
            ? new Date(msg.create_time * 1000).toISOString()
            : undefined,
        });
      }
    }
  } catch {
    // Parse errors
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Scraper state persistence
// ---------------------------------------------------------------------------

function getStatePath(): string {
  return path.join(getHomePath(), ".claude", "recallos-scraper-state.json");
}

function loadState(): ScraperState {
  try {
    const raw = fs.readFileSync(getStatePath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { lastScrapeTime: {}, processedFiles: {} };
  }
}

function saveState(state: ScraperState): void {
  const dir = path.dirname(getStatePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Simple content hash (for dedup without crypto dep)
// ---------------------------------------------------------------------------

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash.toString(36);
}

// ---------------------------------------------------------------------------
// Main scrape function
// ---------------------------------------------------------------------------

/**
 * Scrapes chat logs from local AI tools, extracts memory from user messages,
 * and stores it in the RecallOS database.
 *
 * Only processes user messages (not assistant responses) since those contain
 * the user's actual preferences, facts, and goals.
 *
 * Deduplicates across runs using a persistent state file.
 */
export async function scrapeAll(): Promise<ScrapeResult[]> {
  const results: ScrapeResult[] = [];
  const state = loadState();

  // --- Claude Code ---
  const ccResult: ScrapeResult = {
    source: "claude-code",
    messagesFound: 0,
    messagesNew: 0,
    memoryExtracted: 0,
    errors: [],
  };

  try {
    const transcripts = findClaudeCodeTranscripts();
    const processed = new Set(state.processedFiles["claude-code"] || []);

    for (const file of transcripts) {
      const fileHash = simpleHash(file + fs.statSync(file).mtimeMs.toString());
      if (processed.has(fileHash)) continue;

      const messages = parseClaudeCodeTranscript(file);
      ccResult.messagesFound += messages.length;

      // Only extract memory from user messages
      const userMessages = messages.filter((m) => m.role === "user");
      for (const msg of userMessages) {
        const contentHash = simpleHash(msg.content);
        // Check if we already ingested this exact content
        const existing = queryOne(
          "SELECT id FROM events WHERE content = ? AND role = 'user' LIMIT 1",
          [contentHash]
        );
        if (existing) continue;

        ccResult.messagesNew++;
        const eventId = "scrape-cc-" + uuidv4().slice(0, 8);
        const candidates = await extractMemory(msg.content, eventId);
        if (candidates.length > 0) {
          const result = await reconcileMemory(candidates, eventId);
          ccResult.memoryExtracted += result.added.length;
        }
      }

      processed.add(fileHash);
    }

    state.processedFiles["claude-code"] = Array.from(processed).slice(-500); // Keep last 500
  } catch (err: any) {
    ccResult.errors.push(err.message || "Unknown error");
  }

  results.push(ccResult);

  // --- Cursor ---
  const cursorResult: ScrapeResult = {
    source: "cursor",
    messagesFound: 0,
    messagesNew: 0,
    memoryExtracted: 0,
    errors: [],
  };

  try {
    const messages = await parseCursorComposerData();
    cursorResult.messagesFound = messages.length;

    const userMessages = messages.filter((m) => m.role === "user");
    for (const msg of userMessages) {
      const contentHash = simpleHash(msg.content);
      const existing = queryOne(
        "SELECT id FROM events WHERE content = ? AND role = 'user' LIMIT 1",
        [contentHash]
      );
      if (existing) continue;

      cursorResult.messagesNew++;
      const eventId = "scrape-cursor-" + uuidv4().slice(0, 8);
      const candidates = await extractMemory(msg.content, eventId);
      if (candidates.length > 0) {
        const result = await reconcileMemory(candidates, eventId);
        cursorResult.memoryExtracted += result.added.length;
      }
    }
  } catch (err: any) {
    cursorResult.errors.push(err.message || "Unknown error");
  }

  results.push(cursorResult);

  // --- ChatGPT export ---
  const chatgptResult: ScrapeResult = {
    source: "chatgpt",
    messagesFound: 0,
    messagesNew: 0,
    memoryExtracted: 0,
    errors: [],
  };

  try {
    const chatgptFile = findChatGPTExport();
    if (chatgptFile) {
      const messages = parseChatGPTExport(chatgptFile);
      chatgptResult.messagesFound = messages.length;

      const userMessages = messages.filter((m) => m.role === "user");
      for (const msg of userMessages) {
        const contentHash = simpleHash(msg.content);
        const existing = queryOne(
          "SELECT id FROM events WHERE content = ? AND role = 'user' LIMIT 1",
          [contentHash]
        );
        if (existing) continue;

        chatgptResult.messagesNew++;
        const eventId = "scrape-chatgpt-" + uuidv4().slice(0, 8);
        const candidates = await extractMemory(msg.content, eventId);
        if (candidates.length > 0) {
          const result = await reconcileMemory(candidates, eventId);
          chatgptResult.memoryExtracted += result.added.length;
        }
      }
    }
  } catch (err: any) {
    chatgptResult.errors.push(err.message || "Unknown error");
  }

  results.push(chatgptResult);

  // --- Windsurf ---
  const windsurfResult: ScrapeResult = {
    source: "windsurf",
    messagesFound: 0,
    messagesNew: 0,
    memoryExtracted: 0,
    errors: [],
  };

  try {
    const messages = await parseWindsurfData();
    windsurfResult.messagesFound = messages.length;

    const userMessages = messages.filter((m) => m.role === "user");
    for (const msg of userMessages) {
      const contentHash = simpleHash(msg.content);
      const existing = queryOne(
        "SELECT id FROM events WHERE content = ? AND role = 'user' LIMIT 1",
        [contentHash]
      );
      if (existing) continue;

      windsurfResult.messagesNew++;
      const eventId = "scrape-windsurf-" + uuidv4().slice(0, 8);
      const candidates = await extractMemory(msg.content, eventId);
      if (candidates.length > 0) {
        const result = await reconcileMemory(candidates, eventId);
        windsurfResult.memoryExtracted += result.added.length;
      }
    }
  } catch (err: any) {
    windsurfResult.errors.push(err.message || "Unknown error");
  }

  results.push(windsurfResult);

  // Save state
  state.lastScrapeTime["claude-code"] = new Date().toISOString();
  state.lastScrapeTime["cursor"] = new Date().toISOString();
  state.lastScrapeTime["chatgpt"] = new Date().toISOString();
  state.lastScrapeTime["windsurf"] = new Date().toISOString();
  saveState(state);

  return results;
}

/**
 * Returns info about available log sources and their status.
 */
export function getSources(): Array<{ name: string; available: boolean; path: string | null; lastScraped: string | null }> {
  const state = loadState();

  const ccTranscripts = findClaudeCodeTranscripts();
  const cursorDb = findCursorDb();
  const chatgptExport = findChatGPTExport();
  const windsurfDb = findWindsurfDb();

  return [
    {
      name: "claude-code",
      available: ccTranscripts.length > 0,
      path: ccTranscripts.length > 0
        ? path.join(getHomePath(), ".claude", "projects")
        : null,
      lastScraped: state.lastScrapeTime["claude-code"] || null,
    },
    {
      name: "cursor",
      available: cursorDb !== null,
      path: cursorDb,
      lastScraped: state.lastScrapeTime["cursor"] || null,
    },
    {
      name: "chatgpt",
      available: chatgptExport !== null,
      path: chatgptExport,
      lastScraped: state.lastScrapeTime["chatgpt"] || null,
    },
    {
      name: "windsurf",
      available: windsurfDb !== null,
      path: windsurfDb,
      lastScraped: state.lastScrapeTime["windsurf"] || null,
    },
  ];
}
