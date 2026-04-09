# RecallOS Milestone 2: SDK and Developer Tools

## Goal

Make RecallOS usable as developer infrastructure, not just a standalone app. Developers and agents should be able to interact with RecallOS memory programmatically through a REST API, CLI, and portable data format.

## What was built

### 1. Memory Passport (export/import)

The core differentiator: swap your AI model, keep your memory.

- `GET /api/passport/export` exports all active memory, trips, and conflicts as a portable JSON file (format: `recallos-passport-v1`)
- `POST /api/passport/import` imports a passport into the local database
- Duplicate detection on import: trips matched by name, memory matched by key+type+scope
- Available in the Settings page UI and via CLI

### 2. Memory audit log

Every memory operation is tracked with a timestamp and explanation.

- Actions: `created`, `superseded`, `reconfirmed`, `marked_stale`, `imported`, `deleted`
- `GET /api/memory/audit/recent` returns recent entries
- `GET /api/memory/audit/:id` returns the history of a specific memory item
- Integrated into the reconciler: every create, supersede, and reconfirm logs an entry

### 3. Context compilation traces

The Context Debug page now shows a detailed table for each snapshot:

- Every memory item scored with its BM25 score
- Decision (included/omitted) with the reason
- Sorted by included first, then omitted
- Traces stored in the rationale_json field of context_snapshots

### 4. Full-text memory search

BM25 search across all active memory items.

- `GET /api/memory/search?q=hotel+preference` returns scored results
- Searches across key, value, and type fields
- Available in the Memory page search bar and via CLI

### 5. User-defined tags

Tags let users categorize memory items freely beyond the built-in type/scope.

- `POST /api/memory/:id/tags` to add a tag
- `DELETE /api/memory/:id/tags/:tag` to remove
- `GET /api/memory/tags` lists all tags with counts
- Tags are normalized to lowercase with hyphens

### 6. CLI tool

Terminal interface for power users and scripting.

Commands:
- `recallos health` - check backend status
- `recallos memory list` - list memory items (with filters)
- `recallos memory search <query>` - BM25 search
- `recallos memory audit` - view audit log
- `recallos memory tags` - list tags
- `recallos trips list` - list trips
- `recallos trips create <name>` - create a trip
- `recallos passport export [file]` - export memory
- `recallos passport import <file>` - import memory
- `recallos providers list` - list configured providers
- `recallos chat <message>` - send a message and print the response

### 7. REST API docs

- OpenAPI 3.0 spec served at `GET /api/docs/openapi.json`
- Swagger UI at `GET /api/docs/` for interactive exploration
- Covers all endpoints: chat, memory, trips, passport, context, settings, agents

### 8. Agent state API

Lets AI agents store multi-step plans, track progress, record failures, and checkpoint state.

Endpoints:
- `POST /api/agents/plans` - create a plan with steps
- `GET /api/agents/plans` - list plans
- `GET /api/agents/plans/:id` - get plan with steps
- `PATCH /api/agents/plans/:id` - update plan status
- `PATCH /api/agents/steps/:id` - update step (status, result, error)
- `POST /api/agents/checkpoints` - save a checkpoint
- `GET /api/agents/checkpoints` - list checkpoints
- `GET /api/agents/checkpoints/latest` - get the most recent checkpoint

Plans auto-complete or auto-fail when all steps finish.

### 9. Docker setup

- Multi-stage Dockerfile (deps, build-frontend, build-backend, production)
- Single container serves both API and built frontend
- `docker-compose.yml` with persistent volume for the database
- `.dockerignore` for clean builds

## Project structure (updated)

```
recallos/
  backend/         # TypeScript Express API
  frontend/        # React + Vite UI
  cli/             # CLI tool (commander)
  docs/            # Project docs and specs
  Dockerfile       # Multi-stage Docker build
  docker-compose.yml
  start.bat        # Windows launcher
  start.sh         # Mac/Linux launcher
```

## API summary

| Area | Endpoints |
|:---|:---|
| Chat | POST /api/chat, POST /api/chat/stream, GET /api/chat/conversations |
| Memory | GET/PUT/DELETE /api/memory/:id, GET /search, GET /tags, POST /:id/tags, GET /audit |
| Trips | GET/POST /api/trips, GET/PATCH/DELETE /api/trips/:id |
| Passport | GET /api/passport/export, POST /api/passport/import |
| Context | GET /api/context/snapshots, GET /api/context/snapshots/:id |
| Agents | POST/GET /api/agents/plans, PATCH /api/agents/steps/:id, POST/GET /api/agents/checkpoints |
| Settings | GET/PUT/DELETE /api/settings/providers |
| Docs | GET /api/docs/, GET /api/docs/openapi.json |
