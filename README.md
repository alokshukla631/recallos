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

1. **Extract** - Rule-based extraction pulls structured memory from your message (preferences, constraints, goals, facts, overrides). Entity extraction catches dates, destinations, amounts, and durations.
2. **Reconcile** - New memory is compared against existing memory. Duplicates are re-confirmed. Conflicts are resolved using a 5-level precedence system. Superseded items are marked stale.
3. **Compile** - BM25 ranking scores every active memory item against your current message. Only relevant items are included in the context packet. Constraints and overrides are always included.
4. **Deliver** - The compiled context is injected into the system prompt alongside your conversation history, then sent to whichever AI provider you selected.
5. **Store** - The full exchange is stored locally with a context snapshot for debugging.

## What's built

This is the working MVP, focused on travel planning as a proof-of-concept domain.

### Pages

- **Chat** - Unified chat UI with conversation sidebar, streaming responses (SSE), provider selector, and trip selector. Memory badges show what was extracted and reconciled per message. Context panel shows what memory was injected.
- **Trips** - Create and manage trips. Each trip scopes its own conversations and memory items.
- **Memory** - Browse, search, and filter all stored memory items. See type, scope, confidence, and status.
- **Context Debug** - Inspect context snapshots: which memories were included, which were omitted, and why.
- **Settings** - Add/remove API keys for OpenAI and Anthropic. Set a default provider.

### Backend pipeline

- **Memory extraction** - Regex-based rules pull preferences, constraints, goals, facts, and overrides from each sentence
- **Entity extraction** - Extracts dates (ISO, relative, month-day), destinations (300+ cities/countries), amounts (multi-currency), and durations
- **Memory reconciliation** - 5-level precedence (explicit trip override > explicit trip > explicit global > inferred > stale), duplicate detection with re-confirmation, conflict logging
- **BM25 ranking** - Full BM25 with IDF, term frequency saturation, length normalization, and lightweight stemming
- **Context compilation** - Scores all active memory against the current message, includes relevant items plus all constraints/overrides, detects ambiguities. Full trace logged per snapshot.
- **Streaming** - SSE endpoint streams tokens as they arrive from the provider
- **Provider adapters** - OpenAI (gpt-4o) and Anthropic (Claude Sonnet) with both batch and streaming support
- **Memory Passport** - Export/import your entire memory as a portable JSON file. Swap the AI, keep the memory.
- **Audit log** - Every memory create, supersede, reconfirm, and delete is tracked with a timestamp and explanation
- **Full-text search** - BM25-powered search across all memory items
- **Tags** - User-defined tags for free-form categorization beyond type/scope
- **Agent state API** - Plans with steps, progress tracking, failure recording, and checkpoints for resumable agents

### Developer tools

- **REST API** - Full CRUD for memory, trips, chat, passport, context, agents, and settings
- **OpenAPI spec** - Served at `/api/docs/openapi.json` with interactive Swagger UI at `/api/docs/`
- **CLI** - `recallos` command-line tool for memory, trips, passport, chat, and providers
- **Docker** - Multi-stage Dockerfile and docker-compose.yml for one-command deployment

### Tech stack

- **Backend:** TypeScript, Express, sql.js (pure-JS SQLite, no native deps)
- **Frontend:** React, Vite, TypeScript
- **CLI:** TypeScript, Commander
- **Database:** SQLite stored as a single file (`recallos.db`)
- **No cloud dependencies.** Everything runs locally.

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
      db/           # SQLite schema and helpers
      modules/      # Core pipeline (extraction, reconciliation, ranking, context, passport, audit, tags)
      routes/       # REST API endpoints (chat, memory, trips, passport, agents, docs, settings)
      bench/        # Benchmark scenario runner
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

Milestone 1 proved the core thesis: the model does reasoning, RecallOS provides the memory/context layer. Milestone 2 made it developer-friendly with an API, CLI, Docker, and agent support.

Future milestones include:
- Rust engine for background processing
- MCP server so any AI tool can query your memory
- Log scraper for cross-tool continuity
- Multi-domain generalization beyond travel
- Local embedding search (vector DB)

See the [docs](docs/) folder for the full vision and roadmap.

## Docs

- [`docs/00-vision.md`](docs/00-vision.md) - The big picture
- [`docs/01-project-proposal.md`](docs/01-project-proposal.md) - Full project proposal
- [`docs/02-prfaq.md`](docs/02-prfaq.md) - Questions and answers
- [`docs/03-milestones.md`](docs/03-milestones.md) - Detailed build plan
- [`docs/04-mvp-spec.md`](docs/04-mvp-spec.md) - MVP specification
- [`docs/05-m2-sdk-spec.md`](docs/05-m2-sdk-spec.md) - Milestone 2: SDK and developer tools

## License

Open source. License TBD.
