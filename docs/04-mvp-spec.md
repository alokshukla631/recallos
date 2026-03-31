# RecallOS MVP Specification

## Goal

Build a local-first chat app that lets a user talk to multiple AI models through one UI, while the backend stores conversation and extracted memory locally, identifies durable preferences and temporary overrides, compiles only relevant context for each new message, injects that context into the model request, and shows the user what memory was used.

This proves the core thesis: the model does reasoning, RecallOS provides the memory/context layer.

## Success criteria

1. The user can choose between at least 2 providers (OpenAI and Anthropic).
2. The user can chat through one unified UI.
3. The app stores conversation history and extracted memory locally.
4. The backend can distinguish between durable memory, temporary task-specific memory, and stale or overridden memory.
5. Before every model call, the backend compiles a small relevant context packet.
6. The app can show which memory items were injected and why.
7. In repeated travel-related prompts, the model behaves more consistently than without the memory layer.

## Scope

### In scope

- Browser UI (Chat, Memory, Context Debug, Settings)
- Local TypeScript backend
- SQLite database
- Provider selection (OpenAI, Anthropic)
- User-provided API keys
- Travel domain only
- Local memory extraction
- Context compilation with precedence rules
- Debug view showing memory used per response

### Out of scope

- Desktop daemon, file scraping, MCP server
- Coding workflow support
- Local model inference
- Browser extension
- Full encryption/keychain integration
- Multi-user sync
- Autonomous agents
- Rust backend (deferred to post-MVP)

## System design

### Frontend

Browser-based chat app built with React + Vite.

Pages:
- **Chat**: message thread, provider dropdown, send box, "show context used" toggle
- **Memory**: global travel preferences, active trip constraints, stale items, conflicts, edit/delete actions
- **Context Debug**: compiled context per response, included/omitted memory items, inclusion reasons
- **Settings**: provider API key entry, default provider, local data path, clear data

### Backend

Local Node.js/Express service with TypeScript.

Core modules:
- **Event store**: persists every raw turn
- **Memory extractor**: converts text into structured memory candidates (rule-based + model-assisted)
- **Memory reconciler**: applies precedence rules to resolve conflicts
- **Context compiler**: selects relevant memory for each turn, builds context packet
- **Provider adapter**: one adapter per provider (OpenAI, Anthropic)
- **Context snapshot logger**: stores exactly what was sent to the model

### Database

SQLite with these tables:

**events**: id, conversation_id, trip_id, role, content, provider, created_at

**memory_items**: id, key, type (preference/constraint/fact/goal/override), value, scope (global/trip), source_event_id, confidence, authority, status (active/stale/superseded), valid_from, valid_to, last_confirmed_at

**conflicts**: id, key, memory_item_a_id, memory_item_b_id, resolution_status, explanation

**context_snapshots**: id, event_id, provider, compiled_context_json, rationale_json, created_at

**provider_settings**: id, provider, api_key_encrypted, created_at

## Request flow

1. User types message in UI
2. Frontend sends request to backend (message, provider, conversation_id, trip_id)
3. Backend stores raw event
4. Backend extracts candidate memory from the message
5. Backend reconciles memory (conflict detection, supersession)
6. Backend compiles working context (goal, constraints, preferences, overrides, ambiguities)
7. Backend renders final provider prompt (system instruction + context block + recent turns + current message)
8. Backend sends request to chosen provider API
9. Backend stores response, context snapshot, included/omitted memory ids
10. Frontend shows response with optional "view memory used"

## Memory precedence rules

1. Explicit trip-specific override (highest)
2. Explicit trip-specific preference
3. Explicit global preference
4. Inferred preference
5. Stale historical memory (lowest)

## Prompt structure

Each provider request is built from:
1. System instruction
2. Compiled context block
3. Recent conversation turns
4. Current user message

## Build order

1. Schema, context compiler rules, benchmark scenarios, API contracts
2. Backend skeleton, SQLite, event storage, basic chat endpoint
3. Memory extraction, memory CRUD, basic reconciliation
4. Context compiler, context snapshot logging
5. Provider integrations (OpenAI, Anthropic), prompt assembly
6. Chat UI, settings page, provider selector
7. Memory page, context debug page, benchmark scenarios
8. Refinement, UX polish, docs, MVP demo

## Evaluation

Test with fixed travel scenarios:
1. User prefers aisle seats globally
2. For one trip, user prioritizes cheapest option
3. Later, user says comfort matters more than budget for this trip
4. User normally avoids overnight layovers
5. User says overnight layover is acceptable if savings exceed $500

Compare provider alone vs provider with raw history vs provider with compiled RecallOS context. Track whether correct preferences were applied, overrides were respected, stale memory was ignored, and answers stayed consistent across providers.
