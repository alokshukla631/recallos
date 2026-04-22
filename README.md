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
npm run bench          # 5 structured memory scenarios
npm run bench:verbatim # 60 verbatim retrieval assertions
npm run bench:eval     # LongMemEval-compatible eval (40 cases, 6 categories)
npm run bench:all      # all three suites in sequence
```

No API keys needed. The eval suite measures Recall@5/10, NDCG, and MRR across
single_session_preference, assistant_recall, temporal_history, episodic_search,
and noisy_haystack categories.

## How it works

RecallOS sits between you and the AI model. When you send a message:

1. **Extract** - Multi-domain extraction pulls structured memory from your message (preferences, constraints, goals, facts, overrides) across 8 domains: travel, coding, work, health, finance, learning, writing, and communication. Entity extraction catches dates, destinations, amounts, durations, technologies, and programming languages.
2. **Reconcile** - New memory is compared against existing memory. Duplicates are re-confirmed (boosting confidence). Conflicts are resolved using a scope-aware precedence system (session > project > domain > global). Superseded items are marked stale.
3. **Compile** - Two parallel lanes are merged into a single context block:
   - **Structured lane (authority)** — BM25 + recency decay + domain boost + cross-link boost scores every active memory item. Constraints and overrides are always included.
   - **Verbatim lane (evidence)** — the raw event log is searched with a five-signal scoring pipeline (see below) and the top-N past conversation snippets are appended as `[PAST CONVERSATION EVIDENCE]`.
4. **Deliver** - The compiled context is injected into the system prompt alongside your conversation history, then sent to whichever AI provider you selected.
5. **Store** - The full exchange is stored locally with a context snapshot for debugging.

### Hybrid retrieval — five scoring signals

Every raw conversation event is scored against the current query by summing five additive signals:

| Signal | Max weight | Notes |
|---|---|---|
| **BM25** (lexical) | 1.00 | Normalised across candidate set; question words removed from stoplist |
| **Temporal proximity** | 0.40 | Gaussian decay centred on time anchor ("last week", "yesterday", etc.) |
| **Preference evidence** | 0.25 | Boost for "I usually / I prefer / I tend to…" phrasing |
| **Role boost** | 0.30 | Assistant turns boosted on assistant-recall queries |
| **Semantic cosine** | 0.35 | OpenAI `text-embedding-3-small` cosine, cached in `event_embeddings`; gracefully absent when no key is configured |

Query type is classified automatically (assistant_recall, temporal_history, preference_profile, episodic_search, planning, balanced) and the snippet budget (2–5) and `isAssistantQuery` flag are set accordingly.

**LongMemEval-s results** (500 questions, 6 categories, local MiniLM-L6 embeddings, no API key):
```
Category                    N    R@5    R@10   NDCG@5  MRR
knowledge-update            78  1.000  1.000  0.991   0.987
multi-session              133  0.977  0.992  0.931   0.918
single-session-assistant    56  1.000  1.000  0.987   0.982
single-session-preference   30  1.000  1.000  0.948   0.931
single-session-user         70  0.986  1.000  0.967   0.962
temporal-reasoning         133  0.947  0.962  0.906   0.894
Overall                    500  0.978  0.988  0.946   0.936
```

Reference points on the same LongMemEval-s 500-question split:
- MemPalace (Oct 2025 paper, strongest published tool-augmented baseline): 0.966 R@5
- RecallOS hybrid retriever: **0.978 R@5** (+1.2 pt over MemPalace)
- LongMemEval paper's embedding-only baseline: ~0.40 R@5

**Cross-benchmark generalization check — LoCoMo** (10 multi-session conversations, 1982 QA pairs, zero retriever tuning on this dataset):
```
                         Turn-level   Session-level
Overall          R@5         0.518          0.777
                 R@10        0.586          0.824
                 MRR         0.399          0.672
```
LoCoMo's native scoring is turn-level (find the exact dia_id) which is
strictly harder than LongMemEval's session-level scoring.  The session-
level row above is the apples-to-apples comparison — 0.777 on a
benchmark the retriever was never tuned on.  The ~20pt gap vs
LongMemEval is the honest measure of how much of our tuning is
domain-specific.

**End-to-end QA accuracy** (50-question single-session-user slice, Anthropic
Claude Sonnet as judge and answerer, retrieval → top-5 snippets → LLM):
```
Category                      N    R@5    QA-Acc
single-session-user          50  1.000   0.900
```
All 5 QA failures had R@5 = 1.000 (the retriever surfaced the right session
at rank 1), so the error is on the generation side — the LLM either refused
("I don't know") or gave a partial answer.  The retriever is not the
bottleneck at this scale.

## What's built

### Pages

- **Dashboard** - Overview stats grid with active memories, conversations, projects, links, and 7-day activity. System status bar with version, uptime, and DB size. GitHub-style activity heatmap (12-week contribution grid). 30-day activity trend chart. Charts for memory type, domain, scope, and confidence distribution. Retention chart. Activity sparkline. Insights panel with duplicate groups and suggestions. Quick actions. Notification bell in sidebar with alerts for conflicts, decay candidates, and duplicates.
- **Chat** - Unified chat UI with conversation sidebar, streaming responses (SSE), provider selector, and project selector. Memory badges show what was extracted and reconciled per message. Pipeline timing breakdown per response. Context panel shows what memory was injected.
- **Projects** - Create and manage projects. Each project scopes its own conversations and memory items.
- **Memory** - Browse, search, and filter all stored memory items. Type, scope, domain, and status filter dropdowns. Domain filter for all 9 detected domains. Tag-based filtering with clickable chips. Session stats panel with cleanup. Inline edit and soft-delete. Multi-select with shift-click range selection, batch operations (pin, unpin, reconfirm, tag, export, delete). Client-side sorting and pagination. Search history dropdown. Conflict detection panel. Markdown export button. Import JSON.
- **Links** - Explore relationships between memory items. Search filter to find items by key, value, or type. Click an item to see all incoming/outgoing links. Linked items highlighted in sidebar. Create new links with typed relations. Navigate between linked items.
- **Graph** - Canvas-based force-directed graph visualization. Nodes colored by type or domain. Search to find and highlight nodes. Filter by type, toggle same-key implicit links. Drag, pan, zoom, and click to inspect. Info panel shows connections.
- **Timeline** - Chronological audit history with 12-week activity heatmap. Filter by action type with clickable chips. Search entries by key or details.
- **Scraper** - View available log sources (Claude Code, Cursor, GitHub Copilot, ChatGPT, Windsurf) with status indicators, descriptions, and paths. Stats bar with source counts. Trigger scrapes to extract memory from external AI tool conversations. Per-source extraction badges and session scrape history.
- **Context Debug** - Inspect context snapshots with full trace: BM25 score, recency boost, final score, and inclusion decision for every memory item. Live Evidence Lane search panel: type any query and see verbatim snippets scored by all five retrieval signals.
- **Analytics** - Advanced memory analytics page with quality score (A-F grade ring), issue detection, prioritized recommendations with one-click fix buttons (reconfirm, cleanup stale, confirm old), weekly growth bar chart, status breakdown donut, average confidence by type with progress bars, most confirmed keys, most linked items, pinned by domain, memory age span, and context snapshot count.
- **Health** - Memory health score with breakdown. Duplicate detection with one-click merge. Stale candidate detection with bulk cleanup. Importance distribution (top and bottom items). Conflict count warning. Memory age distribution bar chart. Refresh button with last-checked timestamp.
- **Trash** - View recently deleted memory items and restore them individually or all at once. Search filter, sort by deleted time/key/type, and filtered item count.
- **Settings** - Add/remove API keys for OpenAI, Anthropic, Gemini, and Ollama. Set a default provider. Customizable system prompt with reset to default. Export/import memory via Memory Passport. JSON and Markdown export buttons. MCP server config display with one-click install for Claude Desktop. Webhook management with delivery log viewer. Memory decay preview and apply. Database statistics grid showing row counts per table. Background tasks panel showing session cleanup, confidence decay, and scraper schedules with last-run times. Clear All Data with typed confirmation dialog (keeps provider keys).

### Core engine

- **Multi-domain extraction** - Regex-based rules for 8 domains. Each extracted item is tagged with its detected domain.
- **Entity extraction** - Dates (ISO, relative, month-day), destinations (300+ cities/countries), amounts (multi-currency), durations, 60+ technologies, programming languages
- **Hierarchical scoping** - 4 scope levels: global, domain, project, session. Narrower scopes override broader ones.
- **Memory reconciliation** - Scope-aware precedence, duplicate detection with re-confirmation, conflict detection and resolution (keep new, keep old, or merge), audit trail
- **Merge** - Combine two memory items: source gets superseded, tags are copied to target, confidence takes the max. Accessible from the detail modal or API
- **Version diff** - Word-level comparison between version history entries. Added words highlighted green, removed words shown in red with strikethrough
- **Trash and restore** - Soft-deleted items can be listed and restored back to active status from the Trash page, CLI, or API
- **Hybrid retrieval** — Two-lane pipeline: structured memory (authority) + verbatim event search (evidence). Five scoring signals: BM25, temporal proximity, preference-evidence boost, role boost, and semantic cosine similarity (OpenAI `text-embedding-3-small` or local Xenova/all-MiniLM-L6-v2, cached). Query classifier routes between lanes and sets snippet budget. LongMemEval-s: 0.978 R@5, beats MemPalace (0.966) by 1.2 pt on the same 500-question split.
- **BM25 + recency + domain + link boost** - Full BM25 with IDF, term frequency saturation, length normalization, lightweight stemming. Recency decay (7-day half-life). Domain-aware scoring: same-domain items get a boost, cross-domain items have recency dampened so they only appear with strong keyword overlap. Cross-domain link boosting for related items.
- **Memory relationships** - Link items with typed relations (related_to, depends_on, conflicts_with, refines, derived_from) with configurable strength
- **Confidence decay** - Items not reconfirmed gradually lose confidence (30-day half-life). Items below threshold are auto-staled.
- **Session expiration** - Session-scoped memory items expire after configurable TTL (default 24h). Cleanup runs hourly.
- **Scheduled background tasks** - Session cleanup (hourly), confidence decay (hourly), and log scraper (4h, configurable). Task schedule and last-run times visible in Settings and via API.
- **Context compilation** - Multi-domain detection, ambiguity flagging, full trace per snapshot
- **Activity trends** - Daily activity counts over time via /api/memory/stats/trends, with trend chart on Dashboard
- **Performance timing** - Per-stage timing for the full pipeline (extraction, reconciliation, context compilation, provider call, snapshot save)
- **Streaming** - SSE endpoint streams tokens as they arrive from the provider
- **Provider adapters** - OpenAI (gpt-4o) and Anthropic (Claude Sonnet) with both batch and streaming support
- **Memory Passport** - Export/import your entire memory as a portable JSON file
- **Bulk import** - Seed memory from a list of natural-language statements via API, CLI, or Python SDK
- **Domain auto-detection** - Keyword-based domain inference from memory key and value text (travel, coding, work, health, finance, learning, writing, personal, communication)
- **Audit log** - Every memory operation is tracked (created, superseded, reconfirmed, pinned, unpinned, deleted, restored, imported)
- **Tags** - User-defined tags for free-form categorization with batch tagging
- **Keyboard shortcuts** - ? for help, Ctrl+K for command palette, Ctrl+1-5 for page navigation, Ctrl+T for theme toggle, Escape to clear selection
- **Command palette** - Fuzzy-searchable command list (Ctrl+K) with navigation, global search across memory/conversations/projects, bulk actions (scrape all sources, preview decay, session cleanup, download JSON/Markdown exports), quick add memory, and theme toggle. Quick Add Memory mode extracts memory from natural language statements. Status feedback for bulk operations
- **Agent state API** - Plans with steps, checkpoints for resumable agents

### Cross-tool continuity

- **Log scraper** - Scrapes chat logs from local AI tools and extracts memory from conversations that happened outside RecallOS
  - **Claude Code** - Reads JSONL transcripts from `~/.claude/projects/`
  - **Cursor** - Reads SQLite state.vscdb composer data
  - **GitHub Copilot** - Reads Copilot Chat conversations from VS Code globalStorage
  - **ChatGPT** - Reads `conversations.json` exports (from Settings > Export data)
  - **Windsurf** - Reads SQLite conversation data from Windsurf state
- **MCP server** - Connect any MCP-compatible AI tool (Claude Desktop, Cursor, VS Code) to your memory. 10 tools (including `search_verbatim` for evidence-lane access), 6 resources, 3 prompts.
- **MCP auto-config** - Generate and auto-install config for Claude Desktop. Supports Windows, macOS, and Linux.

### Developer tools

- **REST API** - Full CRUD for memory, projects, chat, passport, context, agents, scraper, and settings
- **Python SDK** - Sync and async clients (`RecallOS`, `AsyncRecallOS`) using httpx. Covers all API endpoints. Install with `pip install -e sdk-python/`
- **TypeScript SDK** - Zero-dependency client for Node 18+, Deno, Bun, and browsers. Covers all API endpoints including memory, projects, chat, context, tags, links, conflicts, decay, merge, restore, and import.
- **CLI** - `recallos` command-line tool with global search, memory, projects, passport, chat, providers (add/remove/default), scraper, session management, MCP config, trash, restore, settings (stats, analytics, quality, clear-data, prompt management)
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

The MCP server exposes your memory as tools (search, add, compile context, search verbatim past conversations), resources (preferences, constraints, projects), and prompts (with_my_context, project_planning, memory_summary).

**Available MCP tools:** `search_memory`, `get_context`, `get_context_packet`, `record_memory`, `add_memory`, `list_memory`, `list_projects`, `search_verbatim`, `delete_memory` (10 total)

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
      pages/        # Dashboard, Chat, Projects, Memory, Timeline, Links, Graph,
                    #   Analytics, Health, Trash, Scraper, ContextDebug, Settings
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

Milestone 1 proved the core thesis: the model does reasoning, RecallOS provides the memory/context layer. Milestone 2 made it developer-friendly with an API, CLI, Docker, and agent support. Milestone 3 generalized the engine beyond travel: multi-domain extraction, hierarchical scoping, MCP server for any AI tool, memory relationships, and recency-aware ranking. Post-M3 added cross-tool continuity (log scraping from Claude Code, Cursor, ChatGPT, Windsurf), confidence decay, session expiration, pipeline timing, a Python SDK, bulk import, and a full set of frontend pages.

### Recent changes

- Renamed trips to projects across entire codebase (database migration, API, frontend, CLI, SDKs, MCP server). Scope hierarchy simplified to session > project > domain > global
- Added domain-aware context scoring: message domain detection before scoring, same-domain boost (+0.1), cross-domain recency damping (x0.3)
- Added global search across memory, conversations, and projects (`GET /api/search`, CLI, SDKs, command palette)
- Added Analytics page with quality score (A-F grade), one-click fix buttons for recommendations, issues, weekly growth chart, status donut, confidence by type, most confirmed/linked rankings
- Added memory quality score API endpoint (`GET /api/memory/stats/quality`) with grade, breakdown, and recommendations
- Added memory analytics API endpoint (`GET /api/memory/stats/analytics`)
- Added analytics to CLI (`recallos settings analytics`), TypeScript SDK, and Python SDK
- Added bulk actions to command palette (scrape, decay preview, session cleanup, exports)
- Added GitHub Copilot scraper for VS Code Copilot Chat conversations
- Added Clear All Data endpoint with typed confirmation (keeps provider keys)
- Added database statistics grid to Settings page
- Enhanced command palette with Quick Add Memory mode, new actions, and navigation
- Improved Scraper page with stats bar, source descriptions, per-source badges, and session history
- Added JSON and Markdown export buttons to Settings
- Added Copilot to log scraper list
- Added Windsurf scraper support
- Fixed backend startup crash caused by router modules calling the database before initialization
- Fixed route shadowing where GET /:id intercepted static routes, causing 404 errors
- Fixed context snapshot compare route being shadowed by the parametric snapshots/:id route
- Fixed audit log CHECK constraint that rejected 'pinned', 'unpinned', and 'restored' actions
- Fixed amount extraction regex where $2000 was incorrectly parsed as $200
- Fixed C++ and C# not being extracted as coding-language entities (regex word boundary issue)
- Fixed failed chat requests leaving orphan conversation rows in the database
- Fixed Projects page showing dates one day early due to UTC midnight timezone conversion
- Fixed Dashboard health bar not loading in Vite dev mode (wrong fetch path)
- Fixed Health page misreading API response shapes (zero conflicts and active items)
- Fixed Trash page showing negative relative deletion times
- Fixed notification bell items not being clickable even when they include links
- Fixed command palette "Start new conversation" not actually resetting the chat view
- Fixed decay preview returning zero candidates when called without explicit query params
- Fixed OpenAPI docs listing only OpenAI and Anthropic (added Gemini and Ollama)
- Fixed Settings stats and clear-data using legacy conflict table instead of memory_conflicts/memory_versions
- Fixed MCP config generator pointing at nonexistent .ts file in production builds
- Fixed TypeScript SDK response types being out of sync with the live API
- Fixed MCP-created memories storing dangling source_event_id values
- Fixed MCP delete_memory hard-deleting items instead of using soft-delete/trash semantics
- Fixed Settings decay preview always showing "memory is healthy" (caused by the decay defaults bug)
- Reduced scraper noise with confidence discounting and minimum message length filter
- Added domain-aware scoring to context compiler so cross-domain items do not ride into context on recency alone

What's next:
- Memory sharing and collaboration (multi-user support)
- MCP client connections (pull context from calendars, documents, code repos)
- Background refiner with a local model for smarter extraction
- Embedding fine-tuning on personal conversation history for improved recall

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
