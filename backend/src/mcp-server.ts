/**
 * RecallOS MCP Server
 *
 * Exposes RecallOS memory as an MCP server that any compatible AI tool
 * (Claude Desktop, Cursor, VS Code, etc.) can connect to.
 *
 * Run with: npx tsx src/mcp-server.ts
 * Transport: stdio (JSON-RPC over stdin/stdout)
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "path";

import { initDatabase, queryAll, queryOne, runSql, getDb, saveToFile } from "./db/index.js";
import { extractMemory } from "./modules/memory-extractor.js";
import { reconcileMemory } from "./modules/memory-reconciler.js";
import { compileContext } from "./modules/context-compiler.js";
import { bm25Rank } from "./modules/ranking.js";
import { logAudit } from "./modules/audit.js";
import { classifyQuery } from "./modules/query-classifier.js";
import { searchVerbatim } from "./modules/verbatim-retriever.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeItem(item: any) {
  return {
    key: item.key,
    type: item.type,
    value: item.value,
    scope: item.scope,
    confidence: item.confidence,
  };
}

// ---------------------------------------------------------------------------
// Main (wraps top-level await for CommonJS compat)
// ---------------------------------------------------------------------------

async function main() {
  // Database initialization
  const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "recallos.db");
  await initDatabase(DB_PATH);

  // Create the MCP server
  const server = new McpServer(
    {
      name: "recallos",
      version: "0.3.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {},
      },
      instructions: [
        "RecallOS is the user's personal memory layer.",
        "Use the tools below to read the user's preferences, constraints, facts, goals, and overrides.",
        "Before answering a question, call get_context with the user's message to retrieve relevant memory.",
        "If the user states a new preference or fact, call record_memory to store it.",
        "Always respect constraints and overrides - they take priority over general preferences.",
      ].join(" "),
    }
  );

  // -------------------------------------------------------------------------
  // RESOURCES - structured data the model can read
  // -------------------------------------------------------------------------

  // All active memory items
  server.resource(
    "all-memory",
    "memory://items",
    { description: "All active memory items stored in RecallOS" },
    async () => {
      const items = queryAll(
        "SELECT id, key, type, value, scope, project_id, confidence, authority, status FROM memory_items WHERE status = 'active' ORDER BY created_at DESC"
      );
      return {
        contents: [
          {
            uri: "memory://items",
            mimeType: "application/json",
            text: JSON.stringify(items, null, 2),
          },
        ],
      };
    }
  );

  // Preferences only
  server.resource(
    "preferences",
    "memory://preferences",
    { description: "User preferences stored in RecallOS" },
    async () => {
      const items = queryAll(
        "SELECT id, key, value, scope, confidence FROM memory_items WHERE status = 'active' AND type = 'preference' ORDER BY confidence DESC"
      );
      return {
        contents: [
          {
            uri: "memory://preferences",
            mimeType: "application/json",
            text: JSON.stringify(items, null, 2),
          },
        ],
      };
    }
  );

  // Constraints only
  server.resource(
    "constraints",
    "memory://constraints",
    { description: "User constraints (hard limits, budgets, restrictions)" },
    async () => {
      const items = queryAll(
        "SELECT id, key, value, scope, confidence FROM memory_items WHERE status = 'active' AND type = 'constraint' ORDER BY created_at DESC"
      );
      return {
        contents: [
          {
            uri: "memory://constraints",
            mimeType: "application/json",
            text: JSON.stringify(items, null, 2),
          },
        ],
      };
    }
  );

  // Active overrides
  server.resource(
    "overrides",
    "memory://overrides",
    { description: "Active temporary overrides that take priority over preferences" },
    async () => {
      const items = queryAll(
        "SELECT id, key, value, scope, project_id, confidence FROM memory_items WHERE status = 'active' AND type = 'override' ORDER BY created_at DESC"
      );
      return {
        contents: [
          {
            uri: "memory://overrides",
            mimeType: "application/json",
            text: JSON.stringify(items, null, 2),
          },
        ],
      };
    }
  );

  // All projects
  server.resource(
    "projects",
    "memory://projects",
    { description: "All projects the user has created" },
    async () => {
      const projects = queryAll(
        "SELECT id, name, description, start_date, end_date, status FROM projects ORDER BY created_at DESC"
      );
      return {
        contents: [
          {
            uri: "memory://projects",
            mimeType: "application/json",
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    }
  );

  // Single project with its memory (template resource)
  server.resource(
    "project-detail",
    new ResourceTemplate("memory://projects/{projectId}", { list: undefined }),
    { description: "A specific project with its scoped memory items" },
    async (uri, params) => {
      const projectId = params.projectId as string;
      const project = queryOne("SELECT * FROM projects WHERE id = ?", [projectId]);
      if (!project) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "Project not found" }),
            },
          ],
        };
      }

      const memory = queryAll(
        "SELECT id, key, type, value, scope, confidence FROM memory_items WHERE status = 'active' AND project_id = ? ORDER BY type, created_at DESC",
        [projectId]
      );

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ project, memory }, null, 2),
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // TOOLS - functions the model can call
  // -------------------------------------------------------------------------

  // Search memory using BM25
  server.tool(
    "search_memory",
    "Search the user's memory using BM25 text ranking. Returns the most relevant memory items for a query.",
    { query: z.string().describe("Search query to find relevant memory items") },
    async ({ query }) => {
      const items = queryAll(
        "SELECT id, key, type, value, scope, project_id, confidence FROM memory_items WHERE status = 'active'"
      );

      const docs = (items as any[]).map((item) => ({
        id: item.id as string,
        text: `${item.key} ${item.value} ${item.type}`,
      }));

      const ranked = bm25Rank(query, docs);
      const results = ranked.slice(0, 10).map((r) => {
        const item = items.find((i: any) => i.id === r.id) as any;
        return {
          id: item.id,
          key: item.key,
          type: item.type,
          value: item.value,
          scope: item.scope,
          project_id: item.project_id,
          confidence: item.confidence,
          relevance_score: parseFloat(r.score.toFixed(4)),
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }
  );

  // Get compiled context for a message
  server.tool(
    "get_context",
    "Compile relevant context for a given message. Returns the user's relevant preferences, constraints, goals, facts, and overrides scored by relevance to the message.",
    {
      message: z.string().describe("The user's current message to compile context for"),
      project_id: z.string().optional().describe("Optional project ID to scope context"),
    },
    async ({ message, project_id }) => {
      const compiled = await compileContext("mcp", message, project_id);
      return {
        content: [
          {
            type: "text" as const,
            text: compiled.contextText,
          },
        ],
      };
    }
  );

  // Get full context packet (structured JSON)
  server.tool(
    "get_context_packet",
    "Get the full structured context packet for a message. Returns categorized memory items with BM25 scores and inclusion decisions.",
    {
      message: z.string().describe("The user's current message"),
      project_id: z.string().optional().describe("Optional project ID to scope context"),
    },
    async ({ message, project_id }) => {
      const compiled = await compileContext("mcp", message, project_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                domain: compiled.contextPacket.domain,
                goals: compiled.contextPacket.goals.map(summarizeItem),
                constraints: compiled.contextPacket.constraints.map(summarizeItem),
                preferences: compiled.contextPacket.preferences.map(summarizeItem),
                overrides: compiled.contextPacket.overrides.map(summarizeItem),
                facts: compiled.contextPacket.facts.map(summarizeItem),
                ambiguities: compiled.contextPacket.ambiguities,
                included_count: compiled.includedIds.length,
                omitted_count: compiled.omittedIds.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Record a new memory item from a conversation
  server.tool(
    "record_memory",
    "Extract and store memory from text. Use this when the user states a preference, constraint, fact, goal, or override. The extraction pipeline will parse the text and store structured memory items.",
    {
      text: z.string().describe("The text to extract memory from (e.g. a user message)"),
      project_id: z.string().optional().describe("Optional project ID to scope the memory to"),
    },
    async ({ text, project_id }) => {
      // Create a real event row so source_event_id is not dangling
      const mcpEventId = "mcp-" + Date.now().toString(36);
      runSql(
        "INSERT INTO events (id, conversation_id, role, content, provider, created_at) VALUES (?, ?, 'user', ?, 'mcp', datetime('now'))",
        [mcpEventId, "mcp-session", text]
      );
      const candidates = await extractMemory(text, mcpEventId, project_id);
      if (candidates.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No memory items extracted from this text.",
            },
          ],
        };
      }

      const result = await reconcileMemory(candidates, mcpEventId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                extracted: candidates.length,
                added: result.added.length,
                updated: result.updated.length,
                duplicates: result.duplicates.length,
                conflicts: result.conflicts.length,
                items: result.added.map((item: any) => ({
                  key: item.key,
                  type: item.type,
                  value: item.value,
                  scope: item.scope,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Add a specific memory item directly
  server.tool(
    "add_memory",
    "Add a specific memory item directly. Use this when you know exactly what to store (e.g. from a clear user statement).",
    {
      key: z.string().describe("Short snake_case key (e.g. 'seat_preference', 'budget_limit')"),
      type: z.enum(["preference", "constraint", "fact", "goal", "override"]).describe("Memory type"),
      value: z.string().describe("The value to store"),
      scope: z.enum(["global", "domain", "project", "session"]).default("global").describe("Whether this applies globally or to a specific project"),
      project_id: z.string().optional().describe("Project ID if scope is 'project'"),
    },
    async ({ key, type, value, scope, project_id }) => {
      const candidate = {
        key,
        type: type as any,
        value,
        scope: scope as any,
        projectId: project_id,
        confidence: 0.9,
        authority: "explicit" as const,
      };

      // Create a real event row so source_event_id is not dangling
      const mcpEventId = "mcp-" + Date.now().toString(36);
      runSql(
        "INSERT INTO events (id, conversation_id, role, content, provider, created_at) VALUES (?, ?, 'user', ?, 'mcp', datetime('now'))",
        [mcpEventId, "mcp-session", `${key}: ${value}`]
      );
      const result = await reconcileMemory([candidate], mcpEventId);
      const item = result.added[0] || result.updated[0];

      return {
        content: [
          {
            type: "text" as const,
            text: item
              ? `Stored: ${item.key} = "${item.value}" (${item.type}, ${item.scope})`
              : `Memory reconciled: ${result.duplicates.length} duplicate(s), ${result.conflicts.length} conflict(s)`,
          },
        ],
      };
    }
  );

  // List all active memory items (filtered)
  server.tool(
    "list_memory",
    "List all active memory items, optionally filtered by type or scope.",
    {
      type: z.enum(["preference", "constraint", "fact", "goal", "override"]).optional().describe("Filter by memory type"),
      scope: z.enum(["global", "domain", "project", "session"]).optional().describe("Filter by scope"),
      project_id: z.string().optional().describe("Filter by project ID"),
    },
    async ({ type, scope, project_id }) => {
      let sql = "SELECT id, key, type, value, scope, project_id, confidence, created_at FROM memory_items WHERE status = 'active'";
      const params: unknown[] = [];

      if (type) {
        sql += " AND type = ?";
        params.push(type);
      }
      if (scope) {
        sql += " AND scope = ?";
        params.push(scope);
      }
      if (project_id) {
        sql += " AND project_id = ?";
        params.push(project_id);
      }

      sql += " ORDER BY type, created_at DESC";

      const items = queryAll(sql, params);
      return {
        content: [
          {
            type: "text" as const,
            text: items.length > 0
              ? JSON.stringify(items, null, 2)
              : "No memory items found matching the filter.",
          },
        ],
      };
    }
  );

  // List projects
  server.tool(
    "list_projects",
    "List all projects the user has created.",
    {},
    async () => {
      const projects = queryAll(
        "SELECT id, name, description, start_date, end_date, status FROM projects ORDER BY created_at DESC"
      );
      return {
        content: [
          {
            type: "text" as const,
            text: projects.length > 0
              ? JSON.stringify(projects, null, 2)
              : "No projects found.",
          },
        ],
      };
    }
  );

  // Search raw conversation history for verbatim evidence
  server.tool(
    "search_verbatim",
    [
      "Search the user's raw conversation history for verbatim evidence relevant to a query.",
      "Returns scored conversation snippets from past turns, each with ±1 surrounding context.",
      "Best for: recalling what was said in a prior session, finding prior assistant recommendations,",
      "uncovering subtle preferences expressed in conversation but not yet extracted to structured memory,",
      "and temporal recall ('what did we discuss last week about X?').",
      "Complements get_context (structured memory) — use both for comprehensive retrieval.",
    ].join(" "),
    {
      query: z.string().describe(
        "The query to search past conversations for (e.g. 'laptop recommendation', 'vegetarian restaurants Tokyo')"
      ),
      max_results: z.number().optional().describe(
        "Maximum number of snippets to return (default 5, max 20)"
      ),
      project_id: z.string().optional().describe(
        "Restrict search to events in a specific project"
      ),
      exclude_conversation_id: z.string().optional().describe(
        "Exclude a specific conversation from results (e.g. the current in-flight conversation)"
      ),
      max_event_age_days: z.number().optional().describe(
        "Only search events newer than N days. 0 (default) means no age limit."
      ),
    },
    async ({ query, max_results, project_id, exclude_conversation_id, max_event_age_days }) => {
      const classification = classifyQuery(query);
      const snippets = await searchVerbatim(query, {
        maxResults:            Math.min(Number(max_results) || 5, 20),
        excludeConversationId: exclude_conversation_id,
        projectId:             project_id,
        temporalAnchor:        classification.temporalAnchor,
        isAssistantQuery:      classification.type === "assistant_recall",
        maxEventAgeDays:       Number(max_event_age_days) || 0,
      });

      if (snippets.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No relevant conversation history found for: "${query}"`,
          }],
        };
      }

      // Format as readable text with score traces
      const lines: string[] = [
        `Found ${snippets.length} snippet(s) for query: "${query}"`,
        `Query type: ${classification.type}`,
        "",
      ];

      for (let i = 0; i < snippets.length; i++) {
        const s = snippets[i];
        const d = new Date(s.created_at);
        const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        lines.push(`--- Snippet ${i + 1} [${dateStr}, ${s.role}] (score: ${s.final_score.toFixed(3)}) ---`);
        lines.push(s.context_window);
        lines.push(`Scoring: ${s.score_reason}`);
        lines.push("");
      }

      return {
        content: [{
          type: "text" as const,
          text: lines.join("\n"),
        }],
      };
    }
  );

  // Delete a memory item
  server.tool(
    "delete_memory",
    "Delete a memory item by ID. Use this if the user says something is no longer true or wants to remove stored information.",
    {
      memory_id: z.string().describe("The ID of the memory item to delete"),
      reason: z.string().optional().describe("Why this memory is being deleted"),
    },
    async ({ memory_id, reason }) => {
      const item = queryOne("SELECT * FROM memory_items WHERE id = ?", [memory_id]);
      if (!item) {
        return {
          content: [{ type: "text" as const, text: `Memory item ${memory_id} not found.` }],
        };
      }

      logAudit(memory_id, "deleted", reason || "Deleted via MCP");
      // Soft-delete to match REST/UI behavior. Hard-delete would bypass
      // trash/restore semantics and permanently destroy the item.
      runSql(
        "UPDATE memory_items SET status = 'deleted', deleted_at = datetime('now') WHERE id = ?",
        [memory_id]
      );
      saveToFile();

      return {
        content: [
          {
            type: "text" as const,
            text: `Deleted memory: ${item.key} = "${item.value}" (${item.type})`,
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // PROMPTS - pre-built prompt templates
  // -------------------------------------------------------------------------

  server.prompt(
    "with_my_context",
    "Include the user's relevant personal context when answering a question",
    {
      message: z.string().describe("The user's question or request"),
      project_id: z.string().optional().describe("Optional project ID for project-specific context"),
    },
    async ({ message, project_id }) => {
      const compiled = await compileContext("mcp", message, project_id);
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Here is the user's personal context from RecallOS:",
                "",
                compiled.contextText,
                "",
                "Now answer this question using the context above:",
                "",
                message,
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.prompt(
    "project_planning",
    "Plan a project using the user's stored preferences and constraints",
    {
      name: z.string().optional().describe("Project name or topic"),
      details: z.string().optional().describe("Additional project details or questions"),
    },
    async ({ name, details }) => {
      const message = name
        ? `Plan a project: ${name}. ${details || ""}`
        : details || "Help me plan a project";

      const compiled = await compileContext("mcp", message);
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Here is the user's personal context from RecallOS:",
                "",
                compiled.contextText,
                "",
                `Help me plan${name ? " the project: " + name : " a project"}.`,
                details ? `Additional details: ${details}` : "",
                "",
                "Use all of my stored preferences and constraints. Ask clarifying questions if anything is ambiguous.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.prompt(
    "memory_summary",
    "Get a summary of everything RecallOS knows about the user",
    {},
    async () => {
      const items = queryAll(
        "SELECT type, COUNT(*) as count FROM memory_items WHERE status = 'active' GROUP BY type"
      );
      const allItems = queryAll(
        "SELECT key, type, value, scope FROM memory_items WHERE status = 'active' ORDER BY type, created_at DESC"
      );
      const projects = queryAll("SELECT name, description, status FROM projects ORDER BY created_at DESC");

      const sections: string[] = ["Here is everything RecallOS knows about the user:", ""];

      // Summary counts
      const counts = Object.fromEntries((items as any[]).map((i) => [i.type, i.count]));
      sections.push(`Memory summary: ${(allItems as any[]).length} active items`);
      for (const [type, count] of Object.entries(counts)) {
        sections.push(`  - ${type}: ${count}`);
      }
      sections.push("");

      // All items by type
      const byType = new Map<string, any[]>();
      for (const item of allItems as any[]) {
        const list = byType.get(item.type) || [];
        list.push(item);
        byType.set(item.type, list);
      }

      for (const [type, typeItems] of byType) {
        sections.push(`${type.charAt(0).toUpperCase() + type.slice(1)}s:`);
        for (const item of typeItems) {
          sections.push(`  - ${item.key}: ${item.value} (${item.scope})`);
        }
        sections.push("");
      }

      // Projects
      if ((projects as any[]).length > 0) {
        sections.push("Projects:");
        for (const project of projects as any[]) {
          sections.push(`  - ${project.name}${project.description ? ": " + project.description : ""} (${project.status})`);
        }
      }

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: sections.join("\n"),
            },
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Start the server
  // -------------------------------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP JSON-RPC)
  console.error("RecallOS MCP server started");
  console.error(`Database: ${DB_PATH}`);
}

main().catch((err) => {
  console.error("Failed to start RecallOS MCP server:", err);
  process.exit(1);
});
