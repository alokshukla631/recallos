import { Router, Request, Response } from "express";

const router = Router();

const API_SPEC = {
  openapi: "3.0.3",
  info: {
    title: "RecallOS API",
    version: "0.1.0",
    description:
      "REST API for RecallOS - a local-first AI memory and context layer. All endpoints are served at http://localhost:3001 by default.",
  },
  servers: [{ url: "http://localhost:3001", description: "Local server" }],
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        tags: ["System"],
        responses: { "200": { description: "Backend is running" } },
      },
    },
    "/api/chat": {
      post: {
        summary: "Send a chat message (non-streaming)",
        tags: ["Chat"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["message", "provider"],
                properties: {
                  message: { type: "string" },
                  provider: { type: "string", enum: ["openai", "anthropic"] },
                  conversation_id: { type: "string" },
                  trip_id: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Chat response with memory metadata" } },
      },
    },
    "/api/chat/stream": {
      post: {
        summary: "Send a chat message (SSE streaming)",
        tags: ["Chat"],
        description:
          "Same body as POST /api/chat. Returns Server-Sent Events: conversation, memory, context, delta, done, error.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["message", "provider"],
                properties: {
                  message: { type: "string" },
                  provider: { type: "string" },
                  conversation_id: { type: "string" },
                  trip_id: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "SSE event stream" } },
      },
    },
    "/api/chat/conversations": {
      get: {
        summary: "List conversations",
        tags: ["Chat"],
        responses: { "200": { description: "Array of conversations with message counts" } },
      },
    },
    "/api/memory": {
      get: {
        summary: "List memory items",
        tags: ["Memory"],
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["active", "stale", "superseded", "all"] } },
          { name: "type", in: "query", schema: { type: "string", enum: ["preference", "constraint", "fact", "goal", "override", "all"] } },
          { name: "scope", in: "query", schema: { type: "string", enum: ["global", "trip", "all"] } },
          { name: "trip_id", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Array of memory items" } },
      },
    },
    "/api/memory/search": {
      get: {
        summary: "Full-text BM25 search across memory items",
        tags: ["Memory"],
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Array of memory items with search_score" } },
      },
    },
    "/api/memory/{id}": {
      get: {
        summary: "Get a single memory item",
        tags: ["Memory"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Memory item" } },
      },
      put: {
        summary: "Update a memory item",
        tags: ["Memory"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  value: { type: "string" },
                  status: { type: "string" },
                  scope: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Updated memory item" } },
      },
      delete: {
        summary: "Soft-delete a memory item (mark as stale)",
        tags: ["Memory"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Confirmation" } },
      },
    },
    "/api/memory/tags": {
      get: {
        summary: "List all tags with counts",
        tags: ["Memory"],
        responses: { "200": { description: "Array of { tag, count }" } },
      },
    },
    "/api/memory/{id}/tags": {
      get: {
        summary: "Get tags for a memory item",
        tags: ["Memory"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Array of tag strings" } },
      },
      post: {
        summary: "Add a tag to a memory item",
        tags: ["Memory"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { tag: { type: "string" } } } } },
        },
        responses: { "200": { description: "Updated tags array" } },
      },
    },
    "/api/memory/audit/recent": {
      get: {
        summary: "Get recent memory audit log entries",
        tags: ["Memory"],
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 50 } }],
        responses: { "200": { description: "Array of audit entries" } },
      },
    },
    "/api/trips": {
      get: {
        summary: "List all trips",
        tags: ["Trips"],
        responses: { "200": { description: "Array of trips with conversation/memory counts" } },
      },
      post: {
        summary: "Create a trip",
        tags: ["Trips"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  destination: { type: "string" },
                  start_date: { type: "string" },
                  end_date: { type: "string" },
                  status: { type: "string", enum: ["planning", "active", "completed", "cancelled"] },
                  notes: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "201": { description: "Created trip" } },
      },
    },
    "/api/trips/{id}": {
      get: { summary: "Get a trip", tags: ["Trips"], responses: { "200": { description: "Trip object" } } },
      patch: { summary: "Update a trip", tags: ["Trips"], responses: { "200": { description: "Updated trip" } } },
      delete: { summary: "Delete a trip", tags: ["Trips"], responses: { "200": { description: "Confirmation" } } },
    },
    "/api/passport/export": {
      get: {
        summary: "Export memory as a portable JSON passport",
        tags: ["Passport"],
        responses: { "200": { description: "Passport JSON" } },
      },
    },
    "/api/passport/import": {
      post: {
        summary: "Import a passport JSON",
        tags: ["Passport"],
        responses: { "200": { description: "Import results" } },
      },
    },
    "/api/memory/stats": {
      get: {
        summary: "Get memory statistics (totals, by type/scope/domain, confidence)",
        tags: ["Memory"],
        responses: { "200": { description: "Stats object" } },
      },
    },
    "/api/memory/stats/retention": {
      get: {
        summary: "Get memory retention analytics (weekly survival rates)",
        tags: ["Memory"],
        responses: { "200": { description: "Retention data with overall and weekly breakdown" } },
      },
    },
    "/api/memory/session/stats": {
      get: {
        summary: "Get session-scoped memory stats",
        tags: ["Memory"],
        responses: { "200": { description: "{ active, stale, oldest_active }" } },
      },
    },
    "/api/memory/session/cleanup": {
      post: {
        summary: "Expire session memory items older than TTL",
        tags: ["Memory"],
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { ttl_hours: { type: "integer", default: 24 } } } } },
        },
        responses: { "200": { description: "{ expired_count, ttl_hours }" } },
      },
    },
    "/api/memory/bulk": {
      post: {
        summary: "Bulk import memory from natural-language statements",
        tags: ["Memory"],
        requestBody: {
          content: { "application/json": { schema: { type: "object", required: ["statements"], properties: { statements: { type: "array", items: { type: "string" } }, trip_id: { type: "string" } } } } },
        },
        responses: { "200": { description: "Import results" } },
      },
    },
    "/api/passport/export/markdown": {
      get: {
        summary: "Export memory as human-readable Markdown",
        tags: ["Passport"],
        responses: { "200": { description: "Markdown text" } },
      },
    },
    "/api/scraper/sources": {
      get: {
        summary: "List available log sources and their status",
        tags: ["Scraper"],
        responses: { "200": { description: "Array of source objects" } },
      },
    },
    "/api/scraper/run": {
      post: {
        summary: "Scrape all available sources for new conversations",
        tags: ["Scraper"],
        responses: { "200": { description: "Scrape results per source" } },
      },
    },
    "/api/settings/webhooks": {
      get: {
        summary: "List all configured webhooks",
        tags: ["Settings"],
        responses: { "200": { description: "Array of webhook configs" } },
      },
      post: {
        summary: "Register a new webhook",
        tags: ["Settings"],
        requestBody: {
          content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string" }, events: { type: "array", items: { type: "string" } } } } } },
        },
        responses: { "201": { description: "Created webhook" } },
      },
    },
    "/api/settings/webhooks/{id}": {
      put: {
        summary: "Toggle webhook active/inactive",
        tags: ["Settings"],
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { active: { type: "boolean" } } } } },
        },
        responses: { "200": { description: "Confirmation" } },
      },
      delete: {
        summary: "Delete a webhook",
        tags: ["Settings"],
        responses: { "200": { description: "Confirmation" } },
      },
    },
    "/api/settings/mcp/config": {
      get: {
        summary: "Get MCP server config entry for Claude Desktop",
        tags: ["Settings"],
        responses: { "200": { description: "Config object with install instructions" } },
      },
    },
    "/api/settings/mcp/install": {
      post: {
        summary: "Auto-install MCP config into Claude Desktop",
        tags: ["Settings"],
        responses: { "200": { description: "Install result" } },
      },
    },
    "/api/context/snapshots": {
      get: {
        summary: "List context compilation snapshots",
        tags: ["Context"],
        responses: { "200": { description: "Array of snapshots" } },
      },
    },
    "/api/context/snapshots/{id}": {
      get: {
        summary: "Get a specific snapshot with parsed JSON fields and trace",
        tags: ["Context"],
        responses: { "200": { description: "Snapshot detail" } },
      },
    },
    "/api/context/snapshots/compare": {
      get: {
        summary: "Compare two context snapshots side-by-side",
        tags: ["Context"],
        parameters: [
          { name: "a", in: "query", required: true, schema: { type: "string" }, description: "First snapshot ID" },
          { name: "b", in: "query", required: true, schema: { type: "string" }, description: "Second snapshot ID" },
        ],
        responses: { "200": { description: "Diff showing added, removed, and kept memory items" } },
      },
    },
    "/api/memory/decay": {
      get: {
        summary: "Preview which items would be marked stale by decay rules",
        tags: ["Memory"],
        parameters: [
          { name: "max_age_days", in: "query", schema: { type: "integer" }, description: "Max age in days for unconfirmed items (default 90)" },
          { name: "max_stale_days", in: "query", schema: { type: "integer" }, description: "Max days since last confirmation (default 60)" },
          { name: "min_importance", in: "query", schema: { type: "integer" }, description: "Minimum importance score to keep (default 15)" },
        ],
        responses: { "200": { description: "List of decay candidates" } },
      },
      post: {
        summary: "Apply decay rules and mark stale items",
        tags: ["Memory"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  max_age_days: { type: "integer" },
                  max_stale_days: { type: "integer" },
                  min_importance: { type: "integer" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Count of marked items and their details" } },
      },
    },
    "/api/memory/{id}/reconfirm": {
      post: {
        summary: "Manually reconfirm a memory item as still valid",
        tags: ["Memory"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Confirmation with updated timestamp" },
          "404": { description: "Item not found" },
        },
      },
    },
    "/api/memory/importance": {
      get: {
        summary: "Rank memory items by computed importance score",
        tags: ["Memory"],
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
        ],
        responses: { "200": { description: "Array of items with importance scores" } },
      },
    },
    "/api/memory/{id}/importance": {
      get: {
        summary: "Get importance score breakdown for a single item",
        tags: ["Memory"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Factor breakdown (confidence, recency, links, tags, age)" } },
      },
    },
    "/api/memory/{id}/detail": {
      get: {
        summary: "Get comprehensive detail for a memory item",
        description: "Returns the full item with importance breakdown, tags, links, audit history, supersession info, and context appearance count.",
        tags: ["Memory"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Full detail object with importance, tags, links, audit, supersession" },
          "404": { description: "Item not found" },
        },
      },
    },
    "/api/memory/graph": {
      get: {
        summary: "Get graph data for memory visualization",
        description: "Returns nodes (active memory items with importance) and edges (links + implicit same-key connections) for rendering a force-directed graph.",
        tags: ["Memory"],
        responses: {
          "200": { description: "Object with nodes array, edges array, and stats" },
        },
      },
    },
    "/api/memory/batch": {
      post: {
        summary: "Batch operations on multiple memory items",
        tags: ["Memory"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ids", "action"],
                properties: {
                  ids: { type: "array", items: { type: "string" }, description: "Array of memory item IDs" },
                  action: { type: "string", enum: ["pin", "unpin", "delete", "reconfirm"] },
                },
              },
            },
          },
        },
        responses: { "200": { description: "{ action, affected, total_requested }" } },
      },
    },
    "/api/memory/import": {
      post: {
        summary: "Bulk import memory items from structured JSON",
        tags: ["Memory"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["items"],
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["key", "value"],
                      properties: {
                        key: { type: "string" },
                        value: { type: "string" },
                        type: { type: "string", enum: ["preference", "constraint", "fact", "goal", "override"] },
                        scope: { type: "string", enum: ["global", "domain", "trip", "project", "session"] },
                        domain: { type: "string" },
                        confidence: { type: "number", minimum: 0, maximum: 1 },
                      },
                    },
                    maxItems: 200,
                  },
                },
              },
            },
          },
        },
        responses: { "200": { description: "{ imported, skipped, errors }" } },
      },
    },
    "/api/memory/duplicates": {
      get: {
        summary: "Find potential duplicate memory items",
        tags: ["Memory"],
        parameters: [
          { name: "threshold", in: "query", schema: { type: "number", default: 0.6 }, description: "Similarity threshold (0-1)" },
        ],
        responses: { "200": { description: "{ count, groups }" } },
      },
    },
    "/api/memory/suggestions": {
      get: {
        summary: "Get smart suggestions for improving memory quality",
        tags: ["Memory"],
        responses: { "200": { description: "Array of suggestion objects" } },
      },
    },
    "/api/memory/{id}/versions": {
      get: {
        summary: "Get version history for a memory item",
        tags: ["Memory"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Array of version snapshots" } },
      },
    },
    "/api/memory/{id}/revert/{versionId}": {
      post: {
        summary: "Revert a memory item to a previous version",
        tags: ["Memory"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "versionId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Reverted item" } },
      },
    },
    "/api/memory/audit/heatmap": {
      get: {
        summary: "Get daily activity counts for a contribution heatmap",
        tags: ["Memory"],
        parameters: [
          { name: "weeks", in: "query", schema: { type: "integer", default: 12 }, description: "Number of weeks to return" },
        ],
        responses: { "200": { description: "{ days: [{ date, total }], max }" } },
      },
    },
    "/api/memory/conflicts": {
      get: {
        summary: "List memory conflicts",
        tags: ["Memory"],
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["pending", "resolved_keep_new", "resolved_keep_old", "resolved_merged", "all"], default: "pending" } },
        ],
        responses: { "200": { description: "{ pending_count, conflicts }" } },
      },
    },
    "/api/memory/conflicts/{id}/resolve": {
      post: {
        summary: "Resolve a memory conflict",
        tags: ["Memory"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["resolution"],
                properties: {
                  resolution: { type: "string", enum: ["keep_new", "keep_old", "merged"] },
                  merged_value: { type: "string", description: "Required when resolution is 'merged'" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Conflict resolved" },
          "404": { description: "Conflict not found" },
        },
      },
    },
    "/api/memory/stats/trends": {
      get: {
        summary: "Get daily activity counts over time",
        tags: ["Memory"],
        parameters: [
          { name: "days", in: "query", schema: { type: "integer", default: 30 }, description: "Number of days to look back" },
        ],
        responses: { "200": { description: "Array of { day, total, created, deleted, ... } objects" } },
      },
    },
    "/api/memory/{id}/restore": {
      post: {
        summary: "Restore a deleted or superseded item back to active",
        tags: ["Memory"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Item restored to active status" },
          "404": { description: "Item not found" },
        },
      },
    },
    "/api/memory/recently-deleted": {
      get: {
        summary: "List recently deleted memory items",
        tags: ["Memory"],
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
        ],
        responses: { "200": { description: "Array of deleted items with deleted_at timestamp" } },
      },
    },
    "/api/settings/webhooks/log": {
      get: {
        summary: "Get recent webhook delivery log",
        tags: ["Settings"],
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
        ],
        responses: { "200": { description: "Array of delivery log entries" } },
      },
    },
    "/api/settings/providers": {
      get: {
        summary: "List configured providers",
        tags: ["Settings"],
        responses: { "200": { description: "Array of { provider, is_default }" } },
      },
    },
    "/api/settings/providers/{provider}": {
      put: {
        summary: "Save an API key for a provider",
        tags: ["Settings"],
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { api_key: { type: "string" } } } } },
        },
        responses: { "200": { description: "Confirmation" } },
      },
      delete: {
        summary: "Remove a provider",
        tags: ["Settings"],
        responses: { "200": { description: "Confirmation" } },
      },
    },
    "/api/settings/providers/default": {
      get: {
        summary: "Get the default provider",
        tags: ["Settings"],
        responses: { "200": { description: "Default provider object or { provider: null }" } },
      },
      put: {
        summary: "Set the default provider",
        tags: ["Settings"],
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { provider: { type: "string" } } } } },
        },
        responses: { "200": { description: "Confirmation" } },
      },
    },
    "/api/settings/stats": {
      get: {
        summary: "Database row counts per table",
        tags: ["Settings"],
        responses: { "200": { description: "Object with table names as keys and counts as values" } },
      },
    },
    "/api/settings/clear-data": {
      post: {
        summary: "Delete all user data (keeps provider API keys)",
        tags: ["Settings"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["confirm"],
                properties: { confirm: { type: "string", enum: ["DELETE_ALL_DATA"] } },
              },
            },
          },
        },
        responses: {
          "200": { description: "Data cleared" },
          "400": { description: "Missing or incorrect confirmation string" },
        },
      },
    },
    "/api/settings/system-prompt": {
      get: {
        summary: "Get the current system prompt",
        tags: ["Settings"],
        responses: { "200": { description: "{ prompt, is_custom }" } },
      },
      put: {
        summary: "Update the system prompt",
        tags: ["Settings"],
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { prompt: { type: "string" } } } } },
        },
        responses: { "200": { description: "Confirmation" } },
      },
      delete: {
        summary: "Reset system prompt to default",
        tags: ["Settings"],
        responses: { "200": { description: "Confirmation" } },
      },
    },
  },
};

// GET /openapi.json - raw OpenAPI spec
router.get("/openapi.json", (_req: Request, res: Response) => {
  res.json(API_SPEC);
});

// GET / - human-readable HTML docs page (uses Swagger UI CDN)
router.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>RecallOS API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>body{margin:0} .swagger-ui .topbar{display:none}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUI({ url: "/api/docs/openapi.json", dom_id: "#swagger-ui" });
  </script>
</body>
</html>`);
});

export default router;
