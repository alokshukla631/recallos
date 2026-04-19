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
import { extractMemory, type MemoryCandidate } from "./memory-extractor.js";
import { reconcileMemory } from "./memory-reconciler.js";
import { logAudit } from "./audit.js";
import { queryOne, runSql } from "../db/index.js";
// uuid import removed — scraper no longer generates synthetic event IDs

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
// GitHub Copilot scraper
// ---------------------------------------------------------------------------

function findCopilotDb(): string | null {
  // Copilot Chat stores conversations in VS Code's globalStorage
  const vscodeDir = path.join(getAppDataPath(), "Code", "User", "globalStorage");
  if (!fs.existsSync(vscodeDir)) return null;

  // Look for the Copilot Chat extension storage
  const candidates = [
    path.join(vscodeDir, "github.copilot-chat", "chat.db"),
    path.join(vscodeDir, "github.copilot-chat", "state.vscdb"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Also check for conversation JSON files in the extension directory
  const copilotDir = path.join(vscodeDir, "github.copilot-chat");
  if (fs.existsSync(copilotDir)) {
    // Some versions store conversations as JSON in the extension folder
    try {
      const entries = fs.readdirSync(copilotDir);
      for (const entry of entries) {
        if (entry.endsWith(".json") && entry.includes("conversation")) {
          return path.join(copilotDir, entry);
        }
      }
    } catch {
      // Permission errors
    }
    // Return the directory itself if it exists (we'll scan it)
    return copilotDir;
  }

  return null;
}

async function parseCopilotData(): Promise<ScrapedMessage[]> {
  const copilotPath = findCopilotDb();
  if (!copilotPath) return [];

  const messages: ScrapedMessage[] = [];

  try {
    const stat = fs.statSync(copilotPath);

    if (stat.isFile() && copilotPath.endsWith(".json")) {
      // Parse JSON conversation file
      const content = fs.readFileSync(copilotPath, "utf-8");
      const data = JSON.parse(content);
      const conversations = Array.isArray(data) ? data : data.conversations || [data];

      for (const conv of conversations) {
        const msgs = conv.messages || conv.turns || conv.conversation || [];
        if (!Array.isArray(msgs)) continue;

        for (const msg of msgs) {
          const role = msg.role || msg.author || (msg.isUser ? "user" : "assistant");
          const content = msg.content || msg.text || msg.message || "";
          if (!content || content.length < 10) continue;
          if (role !== "user" && role !== "assistant" && role !== "human") continue;

          messages.push({
            role: role === "human" ? "user" : role as "user" | "assistant",
            content: String(content).slice(0, 2000),
            source: "copilot",
          });
        }
      }
    } else if (stat.isFile() && (copilotPath.endsWith(".db") || copilotPath.endsWith(".vscdb"))) {
      // Parse SQLite database
      const initSqlJs = (await import("sql.js")).default;
      const SQL = await initSqlJs();
      const buffer = fs.readFileSync(copilotPath);
      const db = new SQL.Database(buffer);

      // Try different table structures Copilot might use
      const tables = ["conversations", "messages", "cursorDiskKV"];
      for (const table of tables) {
        try {
          if (table === "cursorDiskKV") {
            // VS Code-style key-value store
            const stmt = db.prepare(
              `SELECT key, value FROM ${table} WHERE key LIKE '%copilot%' OR key LIKE '%chat%' ORDER BY key`
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
                const conversation = data.conversation || data.messages || data.turns || [];
                if (!Array.isArray(conversation)) continue;

                for (const msg of conversation) {
                  const role = msg.role || msg.author || (msg.isUser ? "user" : "assistant");
                  const content = msg.content || msg.text || msg.message || "";
                  if (!content || content.length < 10) continue;
                  if (role !== "user" && role !== "assistant" && role !== "human") continue;

                  messages.push({
                    role: role === "human" ? "user" : role as "user" | "assistant",
                    content: String(content).slice(0, 2000),
                    source: "copilot",
                  });
                }
              } catch {
                // Skip unparseable entries
              }
            }
            stmt.free();
          } else {
            // Direct messages table
            const stmt = db.prepare(
              `SELECT * FROM ${table} ORDER BY rowid`
            );
            while (stmt.step()) {
              try {
                const row = stmt.getAsObject() as Record<string, any>;
                const role = row.role || row.author || "unknown";
                const content = row.content || row.text || row.message || "";
                if (!content || String(content).length < 10) continue;
                if (role !== "user" && role !== "assistant") continue;

                messages.push({
                  role: role as "user" | "assistant",
                  content: String(content).slice(0, 2000),
                  source: "copilot",
                });
              } catch {
                // Skip
              }
            }
            stmt.free();
          }
        } catch {
          // Table doesn't exist, try next
        }
      }
      db.close();
    } else if (stat.isDirectory()) {
      // Scan directory for JSON conversation files
      const entries = fs.readdirSync(copilotPath);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const content = fs.readFileSync(path.join(copilotPath, entry), "utf-8");
          const data = JSON.parse(content);
          const conversations = Array.isArray(data) ? data : [data];

          for (const conv of conversations) {
            const msgs = conv.messages || conv.turns || conv.conversation || [];
            if (!Array.isArray(msgs)) continue;

            for (const msg of msgs) {
              const role = msg.role || msg.author || "unknown";
              const msgContent = msg.content || msg.text || msg.message || "";
              if (!msgContent || msgContent.length < 10) continue;
              if (role !== "user" && role !== "assistant" && role !== "human") continue;

              messages.push({
                role: role === "human" ? "user" : role as "user" | "assistant",
                content: String(msgContent).slice(0, 2000),
                source: "copilot",
              });
            }
          }
        } catch {
          // Skip unparseable files
        }
      }
    }
  } catch {
    // Read errors
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

// Minimum message length to extract memory from. Short messages like
// "yes", "fix it", "continue" rarely contain real preferences.
const MIN_SCRAPE_MSG_LENGTH = 40;

// Confidence discount for scraped content. Scraped user messages are
// less reliable than direct chat because the user may be describing
// what they are building rather than expressing personal preferences.
const SCRAPE_CONFIDENCE_FACTOR = 0.6;

function discountScrapedCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  return candidates.map((c) => ({
    ...c,
    confidence: Math.round(c.confidence * SCRAPE_CONFIDENCE_FACTOR * 100) / 100,
  }));
}

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

        if (msg.content.length < MIN_SCRAPE_MSG_LENGTH) continue;
        ccResult.messagesNew++;
        // Pass null as source_event_id — scraped messages have no event row
        // in the RecallOS DB, so a synthetic ID would violate the FK constraint.
        const candidates = discountScrapedCandidates(await extractMemory(msg.content, ""));
        if (candidates.length > 0) {
          const result = await reconcileMemory(candidates, null);
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

      if (msg.content.length < MIN_SCRAPE_MSG_LENGTH) continue;
      cursorResult.messagesNew++;
      const candidates = discountScrapedCandidates(await extractMemory(msg.content, ""));
      if (candidates.length > 0) {
        const result = await reconcileMemory(candidates, null);
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

        if (msg.content.length < MIN_SCRAPE_MSG_LENGTH) continue;
        chatgptResult.messagesNew++;
        const candidates = discountScrapedCandidates(await extractMemory(msg.content, ""));
        if (candidates.length > 0) {
          const result = await reconcileMemory(candidates, null);
          chatgptResult.memoryExtracted += result.added.length;
        }
      }
    }
  } catch (err: any) {
    chatgptResult.errors.push(err.message || "Unknown error");
  }

  results.push(chatgptResult);

  // --- GitHub Copilot ---
  const copilotResult: ScrapeResult = {
    source: "copilot",
    messagesFound: 0,
    messagesNew: 0,
    memoryExtracted: 0,
    errors: [],
  };

  try {
    const messages = await parseCopilotData();
    copilotResult.messagesFound = messages.length;

    const userMessages = messages.filter((m) => m.role === "user");
    for (const msg of userMessages) {
      const contentHash = simpleHash(msg.content);
      const existing = queryOne(
        "SELECT id FROM events WHERE content = ? AND role = 'user' LIMIT 1",
        [contentHash]
      );
      if (existing) continue;

      if (msg.content.length < MIN_SCRAPE_MSG_LENGTH) continue;
      copilotResult.messagesNew++;
      const candidates = discountScrapedCandidates(await extractMemory(msg.content, ""));
      if (candidates.length > 0) {
        const result = await reconcileMemory(candidates, null);
        copilotResult.memoryExtracted += result.added.length;
      }
    }
  } catch (err: any) {
    copilotResult.errors.push(err.message || "Unknown error");
  }

  results.push(copilotResult);

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

      if (msg.content.length < MIN_SCRAPE_MSG_LENGTH) continue;
      windsurfResult.messagesNew++;
      const candidates = discountScrapedCandidates(await extractMemory(msg.content, ""));
      if (candidates.length > 0) {
        const result = await reconcileMemory(candidates, null);
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
  state.lastScrapeTime["copilot"] = new Date().toISOString();
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
  const copilotDb = findCopilotDb();
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
      name: "copilot",
      available: copilotDb !== null,
      path: copilotDb,
      lastScraped: state.lastScrapeTime["copilot"] || null,
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
