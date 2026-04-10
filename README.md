# RecallOS

**AI models are the brain. RecallOS is the memory layer. The brain can be swapped. The memory stays with you.**

## What is RecallOS?

RecallOS is a free, open-source, local-first context engine. It collects your memory (preferences, facts, history) across every AI tool you use, but it doesn't dump all of that into the next conversation. It picks only the pieces that matter for what you're doing right now and sends just that to the model.

Everything runs on your computer. Your data never leaves your machine.

## Quick start

**Requirements:** Node.js 18+ (download from https://nodejs.org)

```bash
# Clone the repo
git clone https://github.com/alokshukla631/recallos.git
cd recallos

# Windows: double-click start.bat, or run:
start.bat

# Mac / Linux:
chmod +x start.sh
./start.sh
```

This installs dependencies and starts both servers:
- **Frontend** at http://localhost:5173
- **Backend** at http://localhost:3001

Open http://localhost:5173 in your browser. Go to **Settings** and add an API key for OpenAI or Anthropic. Then start chatting.

### Manual start (if you prefer)

```bash
# Install everything
npm run install:all

# Start both servers
npm run dev

# Or start them separately:
npm run dev:backend   # http://localhost:3001
npm run dev:frontend  # http://localhost:5173
```

### Run the benchmark suite

```bash
npm run bench
```

This runs 5 end-to-end scenarios that test memory extraction, duplicate detection, entity extraction, context compilation, and precedence rules. No API keys needed.

## How it works

RecallOS sits between you and the AI model. When you send a message:

1. **Extract** - Multi-domain extraction pulls structured memory from your message (preferences, constraints, goals, facts, overrides) across 8 domains: travel, coding, work, health, finance, learning, writing, and communication. Entity extraction catches dates, destinations, amounts, durations, technologies, and programming languages.
2. **Reconcile** - New memory is compared against existing memory. Duplicates are re-confirmed. Conflicts are resolved using a scope-aware precedence system (session > project > trip > domain > global). Superseded items are marked stale.
3. **Compile** - BM25 ranking plus recency decay scores every active memory item. Items linked to high-scoring anchors get a boost. Only relevant items are included. Constraints and overrides are always included.
4. **Deliver** - The compiled context is injected into the system prompt alongside your conversation history, then sent to whichever AI provider you selected.
5. **Store** - The full exchange is stored locally with a context snapshot for debugging.

## What's built

### Pages

- **Chat** - Unified chat UI with conversation sidebar, streaming responses (SSE), provider selector, and trip selector. Memory badges show what was extracted and reconciled per message. Context panel shows what memory was injected.
- **Trips** - Create and manage trips. Each trip scopes its own conversations and memory items.
- **Memory** - Browse, search, and filter all stored memory items. Domain and scope columns with color-coded badges. Type, scope, domain, and status filters.
- **Context Debug** - Inspect context snapshots with full trace: BM25 score, recency boost, final score, and inclusion decision for every memory item.
- **Settings** - Add/remove API keys for OpenAI and Anthropic. Set a default provider. Export/import memory via Memory Passport.

### Core engine

- **Multi-domain extraction** - Regex-based rules for 8 domains. Each extracted item is tagged with its detected domain.
- **Entity extraction** - Dates (ISO, relative, month-day), destinations (300+ cities/countries), amounts (multi-currency), durations, 60+ technologies, programming languages
- **Hierarchical scoping** - 5 scope levels: global, domain, trip, project, session. Narrower scopes override broader ones.
- **Memory reconciliation** - Scope-aware precedence, duplicate detection with re-confirmation, conflict logging, audit trail
- **BM25 + recency + link boost** - Full BM25 with IDF, term frequency saturation, length normalization, lightweight stemming. Recency decay (7-day half-life). Cross-domain link boosting for related items.
- **Memory relationships** - Link items with typed relations (related_to, depends_on, conflicts_with, refines, derived_from) with configurable strength
- **Context compilation** - Multi-domain detection, ambiguity flagging, full trace per snapshot
- **Streaming** - SSE endpoint streams tokens as they arrive from the provider
- **Provider adapters** - OpenAI (gpt-4o) and Anthropic (Claude Sonnet) with both batch and streaming support
- **Memory Passport** - Export/import your entire memory as a portable JSON file
- **Audit log** - Every memory operation is tracked
- **Tags** - User-defined tags for free-form categorization
- **Agent state API** - Plans with steps, checkpoints for resumable agents

### Developer tools

- **MCP server** - Connect any MCP-compatible AI tool (Claude Desktop, Cursor, VS Code) to your memory. 9 tools, 6 resources, 3 prompts.
- **REST API** - Full CRUD for memory, trips, chat, passport, context, agents, and settings
- **OpenAPI spec** - Served at `/api/docs/openapi.json` with interactive Swagger UI at `/api/docs/`
- **CLI** - `recallos` command-line tool for memory, trips, passport, chat, and providers
- **Docker** - Multi-stage Dockerfile and docker-compose.yml for one-command deployment

### Tech stack

- **Backend:** TypeScript, Express, sql.js (pure-JS SQLite, no native deps)
- **Frontend:** React, Vite, TypeScript
- **CLI:** TypeScript, Commander
- **MCP Server:** @modelcontextprotocol/sdk (stdio transport)
- **Database:** SQLite stored as a single file (`recallos.db`)
- **No cloud dependencies.** Everything runs locally.

## MCP server

Connect any MCP-compatible tool to RecallOS:

```json
{
  "mcpServers": {
    "recallos": {
      "command": "npx",
      "args": ["tsx", "backend/src/mcp-server.ts"],
      "cwd": "/path/to/recallos"
    }
  }
}
```

The MCP server exposes your memory as tools (search, add, compile context), resources (preferences, constraints, trips), and prompts (with_my_context, trip_planning, memory_summary).

## Docker

```bash
docker compose up --build
```

This builds and starts RecallOS on port 3001 with the database persisted in a Docker volume.

## CLI

```bash
cd cli && npm install && npx tsx src/index.ts --help
```

Or after building: `recallos memory list`, `recallos chat "Plan a trip to Tokyo"`, etc.

## API docs

Start the backend and visit http://localhost:3001/api/docs/ for the interactive Swagger UI.

## Project structure

```
recallos/
  backend/
    src/
      db/           # SQLite schema, migrations, and helpers
      modules/      # Core pipeline (extraction, reconciliation, ranking, context, passport, audit, tags, links)
      routes/       # REST API endpoints (chat, memory, trips, passport, agents, docs, settings)
      bench/        # Benchmark scenario runner
      mcp-server.ts # MCP server entry point
  frontend/
    src/
      pages/        # Chat, Trips, Memory, ContextDebug, Settings
      components/   # Shared layout
  cli/              # CLI tool
  docs/             # Vision, proposal, milestones, specs
  Dockerfile        # Multi-stage Docker build
  docker-compose.yml
  start.bat         # Windows one-click launcher
  start.sh          # Mac/Linux one-click launcher
```

## The bigger picture

Milestone 1 proved the core thesis: the model does reasoning, RecallOS provides the memory/context layer. Milestone 2 made it developer-friendly with an API, CLI, Docker, and agent support. Milestone 3 generalized the engine beyond travel: multi-domain extraction, hierarchical scoping, MCP server for any AI tool, memory relationships, and recency-aware ranking.

What's next:
- Local embedding search (vector similarity alongside BM25)
- Log scraper for cross-tool continuity (watch Claude Desktop, Cursor, etc. chat logs)
- MCP client connections (pull context from calendars, documents, code repos)
- Background refiner with a local model for smarter extraction

See the [docs](docs/) folder for the full vision and roadmap.

## Docs

- [`docs/00-vision.md`](docs/00-vision.md) - The big picture
- [`docs/01-project-proposal.md`](docs/01-project-proposal.md) - Full project proposal
- [`docs/02-prfaq.md`](docs/02-prfaq.md) - Questions and answers
- [`docs/03-milestones.md`](docs/03-milestones.md) - Detailed build plan
- [`docs/04-mvp-spec.md`](docs/04-mvp-spec.md) - MVP specification
- [`docs/05-m2-sdk-spec.md`](docs/05-m2-sdk-spec.md) - Milestone 2: SDK and developer tools
- [`docs/06-m3-generalization-spec.md`](docs/06-m3-generalization-spec.md) - Milestone 3: Generalization to a full context runtime

## License

Open source. License TBD.
