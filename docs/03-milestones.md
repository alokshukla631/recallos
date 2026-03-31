# RecallOS: Milestones

## Overview

I'm building RecallOS in three milestones. Each one proves something specific and builds on the last.

- **Milestone 1:** Prove the engine works for one specific domain
- **Milestone 2:** Ship the SDK so developers and agents can use it
- **Milestone 3:** Generalize to a full context runtime for any domain and long-running agents

This order matters. Starting too broad is the fastest way to build something that works for nothing. Start narrow, prove the hard parts, sharpen the architecture with an SDK, then generalize.

---

## Milestone 1: Prove It for One Domain

### What I'm proving

That local, user-owned memory can be stored, compiled into the right context, and meaningfully improve AI responses compared to raw chat history, for one specific type of task.

### Why this matters

This is where I prove the core thesis. If I can't show clear improvement in one domain, the whole project doesn't work. Everything else builds on this.

### Picking the domain

I need a domain where:

- Users have durable preferences ("I always prefer window seats," "I'm vegetarian")
- Temporary overrides are common ("For this trip, I need aisle seats because of my knee")
- The same person comes back repeatedly with similar but not identical requests
- It's easy to tell when the AI got it right or wrong

**Travel planning** is the strongest candidate. It hits all four criteria cleanly. You have preferences (airlines, seat types, hotel chains, dietary needs, budget ranges), overrides (this trip is for business so the budget is different), repeated interactions (people plan multiple trips), and clear correctness checks (did it recommend a restaurant you can actually eat at?).

Other good candidates: job search, research assistant, personal health tracking. I'll pick one and commit.

### What I need to build

**1. Local event store**

A way to store raw interactions locally. Every conversation, every request, every response gets logged as an event. This is the raw material that memory is extracted from.

- High-performance local storage (LanceDB or DuckDB for vector search, SQLite for structured metadata)
- Append-only event log
- Each event has a timestamp, source, and type
- Must handle potentially large volumes, potentially months or years of interaction history

**2. Memory store**

Structured storage for extracted facts and preferences. Not raw text, but actual structured items like:

```
{
  "type": "preference",
  "category": "travel",
  "key": "seat_type",
  "value": "window",
  "scope": "global",
  "source": "user_stated",
  "created": "2026-01-15",
  "last_confirmed": "2026-03-20",
  "confidence": "high"
}
```

Each memory item has metadata: when it was created, when it was last confirmed, where it came from, what scope it applies to, and how confident the system is.

**3. Background refiner (memory extraction)**

Raw chat logs are noisy. If I just store every conversation as-is, the injected context will be cluttered and waste tokens. I need a local "background refiner," a small, efficient model that runs on the user's machine to process raw interactions into clean, structured memory.

When a user says "I'm vegetarian," the refiner should create a structured preference, not just store the raw sentence. The refiner runs during idle time on the user's local GPU or CPU, so it costs nothing to operate.

Good candidates for the local refiner model: Llama 4 Scout, Qwen 2.5 Coder 7B, Gemma 3, or Phi-4. The model needs to be small enough to run locally but smart enough to reliably extract facts, preferences, and traits from conversational text.

**4. Conflict resolution**

Rules for handling contradictions. The key rules:

- Newer information beats older information (unless the older one was explicitly marked as permanent)
- Specific scope beats general scope ("for this project" beats "in general")
- User-stated beats system-inferred
- Temporary overrides expire; permanent preferences persist
- When genuinely ambiguous, ask the user

**5. Context compiler**

The core algorithm. Given a new user request, the compiler:

1. Figures out what the request is about (domain, task type)
2. Pulls potentially relevant memory items
3. Scores them by relevance, freshness, scope match, and confidence
4. Fits them into the token budget
5. Assembles a clean context package

This is the hardest technical problem in the project. Getting it right is the difference between a useful product and a glorified search engine.

**6. MCP server**

This is the primary interface. RecallOS runs as an MCP server from day one. When a user opens Claude Desktop, ChatGPT, VS Code, Cursor, or any MCP-compatible tool, the model can query RecallOS for context.

The MCP server exposes three types of capabilities:

- **Resources:** Structured data streams the model can read, such as `personal://travel-preferences` or `personal://current-trip`. The model reads these like local files.
- **Tools:** Search functions the model can call, such as `search_memory(query="hotel preferences")` or `get_active_overrides()`. The engine runs the local search and returns results.
- **Prompts:** Pre-set context templates, such as "Plan a trip using my travel preferences" or "Review this code using my coding style guide."

I don't need to build provider adapters for each AI model. If it speaks MCP, it works. This is the key architectural advantage: I piggyback on the billions of dollars that Anthropic and OpenAI spend on their UI/UX, and focus entirely on the memory and context logic.

**7. Ingestion layer (hybrid approach)**

RecallOS needs to learn what you said to your AI tools. Two strategies working together:

- **Primary: Log scraper.** A background watcher monitors local chat logs from Claude Desktop, Cursor, VS Code, Windsurf, etc. These tools already save chats to the user's disk (SQLite, JSON) for session restore. RecallOS watches those folders, parses new entries, and indexes them automatically. Zero friction, truly invisible, and fulfills the local-first promise, since it is just indexing data that's already on the user's machine.
- **Secondary: Self-reporting tool.** RecallOS exposes a `record_interaction` MCP tool. The connected model is told (via MCP instructions) to call this tool with a summary after every exchange. Clean, protocol-native, and catches things the log scraper might miss.

This hybrid gives RecallOS full cross-tool continuity. Talk to Claude in the morning, open ChatGPT in the afternoon, and ChatGPT can ask RecallOS: *"What did the user discuss earlier today?"* RecallOS returns the Claude conversation context. Seamless continuity across tools that don't know about each other.

**8. Memory dashboard**

A simple local web UI. It's not a chat app, but an admin panel for your memory:

- Browse all stored memory items
- Search and filter
- Edit or delete specific items
- See the history of a memory item (when created, when last used, when modified)
- See which AI models have accessed which data
- Review what the background refiner has extracted

### What I'm not building

- **A chat UI.** Users keep using Claude Desktop, ChatGPT, VS Code, Cursor, etc. I connect to those tools via MCP. Building a chat wrapper would mean competing with billion-dollar interfaces for no good reason.
- Multi-domain support (that's Milestone 3)
- Agent-specific features (that's Milestone 2)
- Cross-device sync
- Mobile apps

### How I know it works

Exit criteria for Milestone 1:

- [ ] RecallOS runs as a background daemon and MCP server
- [ ] User can connect Claude Desktop (or another MCP client) to the engine and get context-enriched responses
- [ ] Memory is stored locally and persists between sessions
- [ ] Context compiler selects relevant memory for each request
- [ ] MCP Resources, Tools, and Prompts all work correctly
- [ ] Memory dashboard shows the user exactly which memory items exist, which were used, and which models accessed them
- [ ] In a head-to-head comparison, responses with RecallOS context are more consistent and accurate than responses with raw chat history
- [ ] A user can talk to Claude in the morning and ChatGPT in the afternoon, and both get the same personal context from the engine
- [ ] User can inspect, edit, and delete memory items through the dashboard

### Estimated scope

This is a serious engineering effort. The core components (memory extraction, conflict resolution, and context compilation) each require careful design and testing. A rough breakdown:

- Event and memory storage: foundational, build first
- Memory extraction (background refiner): depends on storage, needs iteration
- Conflict resolution: can be built alongside extraction
- Context compiler: the critical path, needs the most attention
- MCP server: the primary interface, build early and iterate
- Memory dashboard: simple but important for trust. It's an admin panel, not a chat app

---

## Milestone 2: SDK for Developers and Agents

### What I'm proving

That RecallOS can be used as embeddable infrastructure, not just as a standalone MCP server, but as a library that developers embed in their own apps and that AI agents use to maintain persistent memory across sessions.

### Why this matters

Shipping the SDK as Milestone 2 (rather than generalizing first) sharpens the architecture early. Building a clean API forces good separation of concerns, makes the internals more modular, and strengthens the open-source story. It also puts RecallOS in the hands of developers and agent builders sooner, which drives real-world feedback before I try to generalize to every domain.

### What I need to build

**1. Developer SDK**

A clean, well-documented SDK that lets developers:

- Initialize a RecallOS instance
- Store and retrieve memory programmatically
- Trigger context compilation for a given request
- Get compiled context as a structured object they can use however they want
- Register custom memory types and conflict rules
- Plug in custom storage backends

The SDK should work in:
- Node.js/TypeScript (primary)
- Python (secondary, for the ML/AI community)
- REST API (for any language)

**2. Agent-facing APIs**

Agents have different needs than human users. They need:

- **Plan memory:** Store and retrieve multi-step plans, track progress, update as steps complete or fail
- **Task state:** Checkpoint what they've done so they can resume after interruption
- **Failure memory:** Record what they tried that didn't work so they don't repeat mistakes
- **Session handoff:** Pass state cleanly from one agent session to another
- **Tool result storage:** Normalize and store results from tool calls so they're available as context later

These aren't just "memory items." They're specialized patterns that agents need to work effectively over long periods.

**3. Plugin system**

Make it easy to extend RecallOS:

- Custom storage backends (different databases, cloud storage, encrypted storage)
- Custom memory extractors (domain-specific extraction logic)
- Custom conflict resolvers (application-specific precedence rules)
- Custom context compilers (specialized compilation strategies)
- Provider adapters (new AI models and services)

**4. Observability and debugging**

When things go wrong (and they will), developers need tools to understand why:

- Context compilation traces (why was this item included? why was that one excluded?)
- Memory audit logs (when was this created? when was it last modified? by what?)
- Performance metrics (compilation time, memory size, cache hit rates)
- Test harness for evaluating context quality

**5. Documentation and examples**

- SDK reference documentation
- Getting started guides
- Example integrations (coding assistant with memory, research agent, personal knowledge base)
- Architecture documentation for contributors
- Best practices for memory schema design

**6. CLI and deployment**

- CLI for developers to interact with RecallOS from the terminal
- Docker image for easy deployment
- Improved daemon management (install, start, stop, status, logs)

### How I know it works

Exit criteria for Milestone 2:

- [ ] A third-party developer can build an app with RecallOS memory in under a day using only the SDK docs
- [ ] An agent can resume meaningful work after interruption using checkpointed state
- [ ] An agent doesn't repeat previously failed approaches (failure memory works)
- [ ] SDK supports at least 2 languages plus REST API
- [ ] Plugin system allows custom storage, extractors, resolvers, and compilers
- [ ] At least 3 community-contributed provider adapters or plugins
- [ ] Context remains inspectable and user-owned even when accessed through the SDK
- [ ] Documentation is complete enough that contributors can add new modules without hand-holding

### What I'm not building yet

- Multi-domain generalization (that's Milestone 3)
- Multi-user support
- Cross-device sync

---

## Milestone 3: Generalize to a Full Context Runtime

### What I'm proving

That the engine works for any type of task, not just the one domain I picked in Milestone 1, and that it can serve as the persistent context layer for long-running agents and complex multi-step workflows.

### Why this matters

Milestone 1 proves the architecture. Milestone 2 puts it in developers' hands. Milestone 3 proves it's truly general-purpose. If RecallOS only works for travel planning, it's a travel app, not a context engine. I need to show that the same core (storage, extraction, conflict resolution, compilation) handles coding, writing, research, health, finance, and anything else a user throws at it. Combined with the SDK from Milestone 2, this is also where long-running agent context becomes real, because generalization plus a clean API together enable agents that maintain state across diverse tasks over extended periods.

### What changes from earlier milestones

**1. Flexible memory schema**

The memory schema needs to handle arbitrary domains without domain-specific hardcoding. Instead of a travel-specific schema, I need a general schema that can represent preferences, facts, constraints, goals, and relationships across any domain.

This means:

- Domain-agnostic memory types (preference, fact, constraint, goal, relationship, override)
- User-defined categories and tags
- Hierarchical scoping (global > domain > project > session)
- Dynamic schema extension without breaking existing data

**2. Smarter context compilation with local intelligence**

The compiler needs to work without domain-specific heuristics. In Milestone 1, I can hardcode rules like "travel preferences are relevant to travel requests." In Milestone 3, the compiler needs to figure out relevance on its own.

This likely means:

- Better relevance scoring using local embeddings (Gemma 3, Phi-4, or similar models for indexing)
- Cross-domain context awareness (your work schedule is relevant to travel planning)
- Adaptive token budgeting based on task complexity
- Learning from user feedback (if the user ignores or corrects context, adjust scoring)

A key advantage here: because RecallOS is local, I can run heavy background processes during idle time on the user's GPU or CPU. Things like Graph RAG (linking memories into knowledge graphs), temporal indexing (tracking how preferences evolve), and memory consolidation (merging redundant facts). This kind of deep processing would be prohibitively expensive at scale for a cloud provider, but it's free on the user's own hardware.

**3. Better memory extraction**

The extraction system needs to handle a wider variety of conversational patterns. People talk about preferences differently in different domains. The extractor needs to be robust.

**4. MCP client connections**

Connect to external MCP servers to pull in context from calendars, documents, code repositories, and other tools, not just from conversation history. RecallOS becomes both an MCP server (providing context to AI models) and an MCP client (pulling context from external data sources).

**5. Better dashboard**

The memory dashboard needs to handle the complexity of multi-domain memory without becoming overwhelming. Filtering by domain, seeing cross-domain connections, and managing a growing memory store. This is a real UX challenge.

**6. The 100GB problem**

This is where RecallOS beats the big providers. OpenAI cannot afford to let every user store 100GB of searchable vector data on their servers for $20/month. But on a user's NVMe drive, I can use high-intensity indexing (like GraphRAG) that finds deep connections between a chat from 2024 and a file from 2026. When a model queries RecallOS for context, the engine performs a high-speed local search and returns just the 10-20 most relevant paragraphs.

### How I know it works

Exit criteria for Milestone 3:

- [ ] System handles at least 5 different domains without domain-specific code
- [ ] Context compilation works across domains (e.g., pulls work schedule when planning travel)
- [ ] Memory schema handles arbitrary user-defined categories
- [ ] MCP client connections working for at least 2 external data sources
- [ ] Local graph/vector index handles 50GB+ of user data without degrading search performance
- [ ] Users can manage multi-domain memory through the dashboard without being overwhelmed
- [ ] Performance is acceptable: context compilation adds less than 2 seconds to request time
- [ ] Long-running agents can maintain coherent state across diverse tasks over multiple sessions

---

## Cross-Milestone Principles

These stay true in every milestone:

**Infrastructure, not app.** RecallOS is not a chat UI or a destination. It's a background daemon and MCP server that makes every existing AI tool better. Users keep their favorite interfaces. The project focuses on memory and context logic.

**Local-first.** User memory lives on the user's machine unless they explicitly choose otherwise.

**Model-agnostic.** The memory layer must work across providers. No single-vendor dependency. Any tool that speaks MCP connects to RecallOS.

**Inspectable.** Users and developers can always see what memory exists, what context was used, and why, whether through the dashboard, CLI, or SDK.

**Truth-preserving.** Every memory item has provenance: source, timestamp, scope, confidence. The system knows the difference between a hard fact and a guess.

**Open source.** The code, the schema, and the protocols are open. Anyone can audit, contribute, or fork.

**Privacy by default.** No telemetry without consent. No data leaves the machine unless the user sends it to a model provider. AI providers only see the small slice of context the engine chooses to share, never the full history.

---

## What's Not On the Roadmap (Yet)

Some things people will ask about that I'm intentionally deferring:

- **Cross-device sync.** Important eventually. "Local only" breaks down when you use more than one machine. The plan is encrypted peer-to-peer sync (Tailscale or Syncthing integration), not cloud storage. But this comes after the core is solid.
- **Mobile apps.** Desktop and CLI first. Mobile comes after the core is solid.
- **Enterprise features.** Team memory, access control, compliance. Real needs, but not the first priority.
- **Fine-tuning integration.** Using memory to fine-tune personal models. Interesting but premature.
- **Marketplace.** A place to share memory modules, adapters, or context strategies. Too early.

These aren't bad ideas. They're just not Milestone 1, 2, or 3 problems.
