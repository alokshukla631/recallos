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
2. **Reconcile** - New memory is compared against existing memory. Duplicates are re-confirmed (boosting confidence). Conflicts are resolved using a scope-aware precedence system (session > project > trip > domain > global). Superseded items are marked stale.
3. **Compile** - BM25 ranking plus recency decay scores every active memory item. Items linked to high-scoring anchors get a cross-domain boost. Only relevant items are included. Constraints and overrides are always included.
4. **Deliver** - The compiled context is injected into the system prompt alongside your conversation history, then sent to whichever AI provider you selected.
5. **Store** - The full exchange is stored locally with a context snapshot for debugging.

## What's built

### Pages

- **Dashboard** - Overview stats grid with active memories, conversations, trips, links, and 7-day activity. System status bar with version, uptime, and DB size. GitHub-style activity heatmap (12-week contribution grid). Charts for memory type, domain, scope, and confidence distribution. Retention chart. Activity sparkline. Insights panel with duplicate groups and suggestions. Quick actions. Notification bell in sidebar with alerts for conflicts, decay candidates, and duplicates.
- **Chat** - Unified chat UI with conversation sidebar, streaming responses (SSE), provider selector, and trip selector. Memory badges show what was extracted and reconciled per message. Pipeline timing breakdown per response. Context panel shows what memory was injected.
- **Trips** - Create and manage trips. Each trip scopes its own conversations and memory items.
- **Memory** - Browse, search, and filter all stored memory items. Type, scope, domain, and status filter dropdowns. Domain filter for all 9 detected domains. Tag-based filtering with clickable chips. Session stats panel with cleanup. Inline edit and soft-delete. Multi-select with shift-click range selection, batch operations (pin, unpin, reconfirm, tag, export, delete). Client-side sorting and pagination. Search history dropdown. Conflict detection panel. Markdown export button. Import JSON.
- **Links** - Explore relationships between memory items. Click an item to see all incoming/outgoing links. Create new links with typed relations. Navigate between linked items.
- **Scraper** - View available log sources (Claude Code, Cursor, ChatGPT) with status indicators. Trigger scrapes to extract memory from external AI tool conversations.
- **Context Debug** - Inspect context snapshots with full trace: BM25 score, recency boost, final score, and inclusion decision for every memory item.
- **Health** - Memory health score with breakdown. Duplicate detection with one-click merge. Stale candidate detection with bulk cleanup. Importance distribution (top and bottom items). Conflict count warning. Memory age distribution bar chart.
- **Trash** - View recently deleted memory items and restore them individually or all at once.
- **Settings** - Add/remove API keys for OpenAI and Anthropic. Set a default provider. Export/import memory via Memory Passport. MCP server config display with one-click install for Claude Desktop. Webhook delivery log viewer.

### Core engine

- **Multi-domain extraction** - Regex-based rules for 8 domains. Each extracted item is tagged with its detected domain.
- **Entity extraction** - Dates (ISO, relative, month-day), destinations (300+ cities/countries), amounts (multi-currency), durations, 60+ technologies, programming languages
- **Hierarchical scoping** - 5 scope levels: global, domain, trip, project, session. Narrower scopes override broader ones.
- **Memory reconciliation** - Scope-aware precedence, duplicate detection with re-confirmation, conflict detection and resolution (keep new, keep old, or merge), audit trail
- **Merge** - Combine two memory items: source gets superseded, tags are copied to target, confidence takes the max. Accessible from the detail modal or API
- **Version diff** - Word-level comparison between version history entries. Added words highlighted green, removed words shown in red with strikethrough
- **Trash and restore** - Soft-deleted items can be listed and restored back to active status from the Trash page, CLI, or API
- **BM25 + recency + link boost** - Full BM25 with IDF, term frequency saturation, length normalization, lightweight stemming. Recency decay (7-day half-life). Cross-domain link boosting for related items.
- **Memory relationships** - Link items with typed relations (related_to, depends_on, conflicts_with, refines, derived_from) with configurable strength
- **Confidence decay** - Items not reconfirmed gradually lose confidence (30-day half-life). Items below threshold are auto-staled.
- **Session expiration** - Session-scoped memory items expire after configurable TTL (default 24h). Cleanup runs hourly.
- **Context compilation** - Multi-domain detection, ambiguity flagging, full trace per snapshot
- **Performance timing** - Per-stage timing for the full pipeline (extraction, reconciliation, context compilation, provider call, snapshot save)
- **Streaming** - SSE endpoint streams tokens as they arrive from the provider
- **Provider adapters** - OpenAI (gpt-4o) and Anthropic (Claude Sonnet) with both batch and streaming support
- **Memory Passport** - Export/import your entire memory as a portable JSON file
- **Bulk import** - Seed memory from a list of natural-language statements via API, CLI, or Python SDK
- **Domain auto-detection** - Keyword-based domain inference from memory key and value text (travel, coding, work, health, finance, learning, writing, personal, communication)
- **Audit log** - Every memory operation is tracked (created, superseded, reconfirmed, pinned, unpinned, deleted, restored, imported)
- **Tags** - User-defined tags for free-form categorization with batch tagging
- **Keyboard shortcuts** - ? for help, Ctrl+K for command palette, Ctrl+1-5 for page navigation, Ctrl+T for theme toggle, Escape to clear selection
- **Agent state API** - Plans with steps, checkpoints for resumable agents

### Cross-tool continuity

- **Log scraper** - Scrapes chat logs from local AI tools and extracts memory from conversations that happened outside RecallOS
  - **Claude Code** - Reads JSONL transcripts from `~/.claude/projects/`
  - **Cursor** - Reads SQLite state.vscdb composer data
  - **ChatGPT** - Reads `conversations.json` exports (from Settings > Export data)
- **MCP server** - Connect any MCP-compatible AI tool (Claude Desktop, Cursor, VS Code) to your memory. 9 tools, 6 resources, 3 prompts.
- **MCP auto-config** - Generate and auto-install config for Claude Desktop. Supports Windows, macOS, and Linux.

### Developer tools

- **REST API** - Full CRUD for memory, trips, chat, passport, context, agents, scraper, and settings
- **Python SDK** - Sync and async clients (`RecallOS`, `AsyncRecallOS`) using httpx. Covers all API endpoints. Install with `pip install -e sdk-python/`
- **TypeScript SDK** - Zero-dependency client for Node 18+, Deno, Bun, and browsers. Covers all API endpoints including memory, trips, chat, context, tags, links, conflicts, decay, merge, restore, and import.
- **CLI** - `recallos` command-line tool for memory, trips, passport, chat, providers, scraper, session management, MCP config, trash, and restore
- **OpenAPI spec** - Served at `/api/docs/openapi.json` with interactive Swagger UI at `/api/docs/`
- **Docker** - Multi-stage Dockerfile and docker-compose.yml for one-command deployment
- **Benchmark endpoint** - `POST /api/context/benchmark` runs the pipeline without calling a provider, returns timing data

### Tech stack

- **Backend:** TypeScript, Express, sql.js (pure-JS SQLite, no native deps)
- **Frontend:** React, Vite, TypeScript
- **CLI:** TypeScript, Commander
- **Python SDK:** httpx
- **MCP Server:** @modelcontextprotocol/sdk (stdio transport)
- **Database:** SQLite stored as a single file (`recallos.db`)
- **No cloud dependencies.** Everything runs locally.

## MCP server

Connect any MCP-compatible tool to RecallOS:

```bash
# Auto-install to Claude Desktop:
recallos mcp install

# Or show the config to paste manually:
recallos mcp config
```

Or add this to your Claude Desktop config:

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

## Python SDK

```bash
pip install -e sdk-python/
```

```python
from recallos import RecallOS

client = RecallOS()
client.health()

# Search memory
results = client.search_memory("window seat")

# Seed memory from statements
client.bulk_import([
    "I prefer window seats on flights",
    "My budget is under $2000",
    "I code in TypeScript and Python",
])

# Get compiled context
ctx = client.get_context("Book me a flight to Tokyo")
```

See [sdk-python/README.md](sdk-python/README.md) for full API coverage.

## Log scraper

Extract memory from conversations in other AI tools:

```bash
# Check what sources are available
recallos scraper sources

# Scrape all available sources
recallos scraper run
```

Supported sources:
- **Claude Code** - JSONL transcripts in `~/.claude/projects/`
- **Cursor** - Composer data in SQLite state database
- **ChatGPT** - Export your data from ChatGPT settings, place `conversations.json` in Downloads

## Docker

```bash
docker compose up --build
```

This builds and starts RecallOS on port 3001 with the database persisted in a Docker volume.

## CLI

```bash
cd cli && npm install && npx tsx src/index.ts --help
```

Or after building: `recallos memory list`, `recallos chat "Plan a trip to Tokyo"`, `recallos memory bulk seeds.txt`, etc.

## API docs

Start the backend and visit http://localhost:3001/api/docs/ for the interactive Swagger UI.

## Project structure

```
recallos/
  backend/
    src/
      db/           # SQLite schema, migrations, and helpers
      modules/      # Core pipeline (extraction, reconciliation, ranking, context,
                    #   passport, audit, tags, links, scraper, session cleanup,
                    #   confidence decay, perf timing, MCP config)
      routes/       # REST API endpoints
      bench/        # Benchmark scenario runner
      mcp-server.ts # MCP server entry point
  frontend/
    src/
      pages/        # Dashboard, Chat, Trips, Memory, Timeline, Links, Graph,
                    #   Health, Trash, Scraper, ContextDebug, Settings
  cli/              # CLI tool
  sdk-ts/           # TypeScript SDK (zero-dependency)
  sdk-python/       # Python SDK (sync + async)
  docs/             # Vision, proposal, milestones, specs
  Dockerfile        # Multi-stage Docker build
  docker-compose.yml
  start.bat         # Windows one-click launcher
  start.sh          # Mac/Linux one-click launcher
```

## The bigger picture

Milestone 1 proved the core thesis: the model does reasoning, RecallOS provides the memory/context layer. Milestone 2 made it developer-friendly with an API, CLI, Docker, and agent support. Milestone 3 generalized the engine beyond travel: multi-domain extraction, hierarchical scoping, MCP server for any AI tool, memory relationships, and recency-aware ranking. Post-M3 added cross-tool continuity (log scraping from Claude Code, Cursor, ChatGPT), confidence decay, session expiration, pipeline timing, a Python SDK, bulk import, and a full set of frontend pages.

What's next:
- Local embedding search (vector similarity alongside BM25)
- Memory sharing and collaboration (multi-user support)
- MCP client connections (pull context from calendars, documents, code repos)
- Background refiner with a local model for smarter extraction
- Windsurf and Copilot scraper support
- Scheduled health checks and automated decay runs

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
