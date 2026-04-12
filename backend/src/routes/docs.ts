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
