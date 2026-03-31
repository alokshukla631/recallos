# RecallOS: Project Proposal

## What is this?

RecallOS is an open-source, local-first context engine. It collects your memory (preferences, facts, history) across every AI tool you use, but it doesn't send all of that to the model. It picks only the relevant pieces for each specific request and delivers just that as context. Memory is everything RecallOS knows about you. Context is the small, useful slice it chooses to share right now.

It works with any AI model provider, including ChatGPT, Claude, Gemini, and local models, instead of replacing them.

The idea is simple: **AI providers should supply the reasoning. Users should own their memory. RecallOS bridges the two by turning memory into the right context at the right time.**

## The Problem

Right now, every AI product manages memory in its own way, and most of them do it badly.

### How AI memory works today

When you use ChatGPT, it stores some memory about you inside OpenAI's systems. When you use Claude, it has its own separate memory. When you use Gemini, same thing. None of these talk to each other.

This means:

- **You repeat yourself constantly.** You tell ChatGPT you prefer Python. Then you open Claude and have to say it again. Then Gemini. Every new tool starts from zero.

- **Preferences get lost or misapplied.** You tell the system "use formal tone for work emails" and suddenly it uses formal tone for everything, including casual messages to friends.

- **Temporary instructions stick around.** You say "for this project, use TypeScript" and weeks later it still defaults to TypeScript even when you're working on something else entirely.

- **Old information leaks in.** You told the system you work at Company A six months ago. You switched to Company B. The system still thinks you're at Company A because nobody told it things changed.

- **You can't see what it remembers.** Most AI memory is a black box. You can't easily inspect it, correct it, or delete specific things.

- **Switching providers means starting over.** All that context you built up? Gone the moment you try a different model.

### Why this keeps happening

The root cause is that memory and reasoning are bundled together inside each provider. OpenAI owns your ChatGPT memory. Anthropic owns your Claude memory. Google owns your Gemini memory. There is no portable layer.

This is like if every website had its own username and password system with no way to use a single identity across them. The industry solved that problem with identity providers. Now it needs to solve the same problem for AI memory.

### This isn't a theoretical problem

Provider memory systems have already suffered data loss, silent corruption, and extended outages. Users have reported memories vanishing without warning or recovery options, and the slow accumulation of stale preferences quietly degrading every response over time. The community has started calling this "context rot."

Memory storage caps are small, often under a few thousand words total. Once full, nothing new gets saved unless you manually delete old entries. Security researchers have demonstrated multiple attack vectors for extracting private information from provider memory systems.

Most critically, users have no meaningful way to audit, correct, or control how their memory is applied. You can't inspect what the system actually remembers, verify its accuracy, or influence which memories get surfaced in a given conversation.

The core issue is the same everywhere: **provider-managed memory is unreliable, opaque, and non-portable.**

### The cost of bad context

Bad context doesn't just cause minor annoyances. It causes real failures:

- An AI assistant that forgets your dietary restrictions and recommends restaurants you can't eat at.
- A coding assistant that uses the wrong framework because it forgot which project you're working on.
- A writing assistant that ignores your style preferences and produces output you have to heavily edit.
- An agent that repeats the same failed approach because it doesn't remember what it already tried.

Every time the AI gets context wrong, the user pays the price in wasted time and lost trust.

## The Core Insight

There is an important difference between memory and context that most AI products ignore.

**Memory** is everything the system knows about you over time. Your preferences, your history, your constraints, facts about your life and work.

**Context** is the small, relevant subset of that memory that matters for what you're doing right now.

A good AI system needs both. It needs to accumulate memory over time, and it needs to select the right context for each task. Today's AI products are weak at both. They either remember too little or dump too much irrelevant history into the conversation.

The job of RecallOS is to do this well: **store durable memory locally, then compile the right working context for each request.**

## The Solution

RecallOS is not an app. It's infrastructure. It runs as a background service on your machine, a local context daemon that any AI tool can connect to.

### Why not build an app?

In 2026, users are already deeply embedded in their preferred interfaces (Claude Desktop, ChatGPT web, VS Code, Cursor). Building yet another chat wrapper means competing with billions of dollars of UI/UX investment from Anthropic and OpenAI. That's a losing game.

Instead, I'm building the infrastructure layer that those platforms rent context from. I'm focused entirely on the hard problem: memory, indexing, and retrieval, piggybacking on the world-class interfaces that already exist.

### How it works

1. **RecallOS runs in the background on your machine.** It starts when your computer starts. You don't interact with it directly for most tasks.

2. **It stores your memory locally.** Preferences, facts, history, and overrides, all on your machine, under your control.

3. **Your AI tools connect to it via MCP.** When you open Claude Desktop, ChatGPT, VS Code, or any MCP-compatible tool, the model sees that a local RecallOS is available. When you ask a question, the model queries your engine: "Give me what you know about this user's current project." RecallOS searches your local memory, compiles the relevant pieces, and sends them back.

4. **The model answers with full context.** It has exactly the background it needs to give you a good answer, without you having to repeat yourself.

5. **RecallOS watches and learns.** After the interaction, the engine records the exchange and updates memory. New facts, changed preferences, and completed tasks all get extracted and stored for future use.

### How RecallOS learns what you said (The Golden Question)

By design, MCP is sandboxed. An MCP server can't "overhear" your conversation with Claude or ChatGPT unless it's explicitly invited. So if I build RecallOS strictly as an MCP server, it doesn't automatically "know" what you just said. This is the golden question of the architecture.

The answer is a hybrid approach using two ingestion strategies:

**Primary: The "Log Scraper" (Zero Friction)**

Many AI tools (Cursor, Windsurf, Claude Desktop) save their own internal chat logs to the user's local computer in SQLite databases or JSON files for "Session Restore" purposes. RecallOS doesn't just wait for MCP calls. It runs a background watcher service that monitors these folders (like `~/Library/Application Support/Claude/` or `C:\Users\...\Cursor\`).

The workflow:
1. You chat with Claude.
2. Claude Desktop writes that chat to its local cache.
3. RecallOS sees the file change, parses the new lines, and indexes them into your local memory.

This is the primary ingestion method because it fulfills the local-first promise: it's just indexing data that is *already on the user's disk*. It works with any model without the model needing to "call" a tool. It's truly invisible to the user. The downside is that I have to write specific scrapers for each app (one for Claude Desktop, one for VS Code, one for Cursor, etc.).

**Secondary: The "Self-Reporting" Tool (MCP Read Head)**

RecallOS also gives the connected AI a tool called `record_interaction` or `save_to_memory`. In RecallOS's MCP instructions, the model is told: *"You are connected to a persistent memory engine. After every response you give to the user, call the `record_interaction` tool with a summary of this exchange."*

The workflow:
1. User: "I'm starting a new project in Rust."
2. Claude (to itself): "I need to save this."
3. Claude calls `record_interaction(text="User started Rust project")`.
4. RecallOS receives the call and saves it to the local store.

This is clean and officially supported by the protocol. It costs a few tokens per interaction and relies on the model being obedient, but it catches things the log scraper might miss.

**Why this hybrid is a massive competitive advantage:**

By scraping logs from every AI tool on the user's machine, RecallOS becomes the glue between competing AI companies. If I talk to Claude about my HVAC project, then open ChatGPT, ChatGPT can ask RecallOS: *"What did the user talk about earlier today?"* RecallOS returns the Claude conversation context. The user gets seamless continuity across tools that don't know about each other.

### What the "product" actually is

RecallOS is three things:

1. **The Engine.** A background daemon that watches for interaction logs, indexes them, extracts structured memory, and keeps your personal knowledge graph up to date.

2. **The MCP Server.** The bridge that lets Claude, ChatGPT, Gemini, VS Code, Cursor, and any other MCP-compatible tool talk to that engine. When the model needs context, it asks the engine through MCP. The engine responds with exactly the right pieces.

3. **A Simple Dashboard.** A local web UI where you can see your memory, delete things, review what's been extracted, and see which AI models have accessed which data. This is not a chat app. It's an admin panel for your memory.

That's it. No chat UI. No markdown renderer. No file upload handling. The entire focus is on memory and context logic, and the existing AI platforms handle the conversation experience.

### Where it sits in the ecosystem

This is fundamentally different from existing tools in the space:

- **Mem0** is a database you call from your code to remember things about a user. It's developer-centric.
- **Letta** is a runtime where the agent is the memory. It's agent-centric.
- **RecallOS** is user-centric. The user owns the state layer. The user controls what gets remembered, what gets shared with which model, and what gets deleted.

That ownership of the state layer is the primary differentiator.

### What makes this different

**User-owned state.** You own your memory. Not the model provider, not the app developer. You. This is the "Memory Passport" idea: if you spend three months teaching ChatGPT your coding style and project architecture, you should be able to move that learned context to Claude or Gemini without starting over. RecallOS makes the model a commodity. You can swap the brain while keeping the soul on your local machine.

**The privacy advantage.** Because the raw history never leaves your local disk, you can index sensitive data (SSH keys, local database schemas, personal emails, financial records) that you would never paste into a web UI. Cloud providers face legal and cost barriers to storing 100GB of a single user's interaction history. You don't have that problem on your own machine. The pitch to users becomes: "RecallOS has indexed 200GB of your life. The AI providers only see the 2KB of relevant text the engine chooses to send them for this specific prompt."

**Local intelligence.** By using local models (like Gemma 3 or Phi-4) for indexing and extraction, RecallOS can build a rich semantic map of your life that cloud providers can't see. And because it runs locally, it can do heavy background work (graph-based memory linking, temporal indexing, memory consolidation) during idle time on your GPU or CPU. That kind of deep processing would be prohibitively expensive at scale for a cloud provider, but it's free on your own hardware.

**Unlimited long-term horizon.** Standard search-based memory (RAG) often fails because it's sparse. It finds specific chunks but misses the overall picture and evolving preferences. Because RecallOS is local, it can maintain a continuously updated understanding of who you are over months and years, not just retrieve isolated snippets.

**Truth-preserving.** RecallOS doesn't just store raw text. It tracks where each piece of memory came from, when it was last confirmed, whether it's temporary or permanent, and what takes precedence when things conflict.

**Inspectable.** You can always see what memory was used for a given request and why. No black box.

**Open source.** The code is open. The memory format is open. Anyone can contribute, audit, or build on top of it.

### Why RecallOS is not just search or memory storage

The hard problem in AI memory is not storing text. It's turning raw conversation history into usable context.

Raw conversation logs are noisy, redundant, and full of contradictions. If you just search old conversations and paste the results into a prompt, you get cluttered, stale, and often wrong context. That's what most memory tools do today, and it's why they feel unreliable.

RecallOS takes a fundamentally different approach. Instead of storing raw text and searching it later, the engine extracts structured facts and preferences from every conversation: "the user prefers Python," "the user is working on Project X," "the user has a nut allergy." Every extracted memory item tracks its source, recency, scope, and confidence level.

When memories conflict, RecallOS resolves them using explicit precedence rules. Newer information beats older. A preference stated for a specific project beats a general default. Something the user explicitly said beats something the system inferred. Temporary overrides (like "use TypeScript for this project") expire when the context changes.

For each incoming request, RecallOS compiles a task-specific context packet that fits within the model's token budget. It scores every candidate memory item by relevance to the current task, freshness, and scope, then assembles the highest-value subset.

This is the difference between a search engine that finds old text and a context engine that prepares exactly what the model needs right now. Search retrieves. RecallOS reasons about what to include, what to exclude, and what takes priority.

### Architecture

RecallOS is built as an MCP server. MCP (Model Context Protocol) is a standard that lets AI models plug into local data sources. When a user opens Claude Desktop, a Gemini CLI, or any MCP-compatible tool, the model can ask RecallOS: "What should I know about this user's current project?" RecallOS performs the local search, compiles the relevant context, and feeds the answer back.

This is the right architecture for 2026 because MCP is already widely adopted, with over 10,000 public servers supported by all major providers. Building as an MCP server means RecallOS works with the ecosystem instead of against it.

As an MCP server, RecallOS exposes three types of capabilities to connected AI models:

| MCP Capability | What It Does |
| :--- | :--- |
| **Resources** | Exposes structured data streams the model can read, like `personal://coding-preferences`, `personal://work-history`, or `personal://current-project`. The model reads these like local files. |
| **Tools** | Gives the model search capabilities, like `search_memory(query="HVAC project notes")` or `get_active_overrides()`. The engine runs the local vector/graph search and returns the top results. |
| **Prompts** | Provides pre-set context templates the user can trigger, like "Act as my technical lead based on my project history" or "Summarize what I've been working on this week." |

### Language choice: Rust + TypeScript

The engine is built as a hybrid: Rust for the core, TypeScript for the MCP layer.

**The Engine (Rust):** This is the background daemon. It handles file watching (log scraping), the vector database, heavy text processing, and memory management. Rust is the right choice here because the engine needs to run 24/7 in the background without eating up resources. It uses almost zero idle memory, can't crash from memory leaks, and handles local vector search (via LanceDB) significantly faster than a Node.js process could. Rust is becoming the standard for high-performance local-first software (Zed editor, Tauri, etc.).

**The MCP Server (TypeScript):** A thin Node.js/Deno wrapper that talks to the Rust engine via a local socket. This layer uses the official MCP SDK, making it easy to expose Resources, Tools, and Prompts to any connected AI tool. TypeScript also makes it easier for other developers to build plugins for RecallOS.

This separation keeps the heavy lifting in Rust and the communication in TypeScript, the best of both worlds.

The internal layers:

```
Layer 1: Core Runtime [Rust] (The Engine)
  - Log scraper (watches local chat logs from Claude Desktop, Cursor, VS Code, etc.)
  - Event store (stores raw interactions)
  - Memory store (stores structured facts and preferences)
  - Background refiner (local model that extracts Facts and Traits from raw logs)
  - Conflict resolver (handles contradictions and precedence)
  - Context compiler (assembles the right context for each request)
  - Local vector/graph index (LanceDB for high-speed semantic search)

Layer 2: MCP Interface [TypeScript] (The Bridge)
  - MCP server (Resources, Tools, and Prompts for any connected AI)
  - Self-reporting tool (record_interaction for secondary ingestion)
  - MCP client connections (for pulling context from external tools and data)

Layer 3: Surfaces
  - Memory dashboard (local web UI for inspecting and managing memory)
  - CLI (for developers and power users)
  - Developer SDK (for embedding in other apps)
```

The core runtime is the heart of the project. It handles the hard problems: what to remember, what to forget, what's still true, and what context to use right now.

The MCP interface is how AI models connect. The surfaces are how users and developers manage their memory.

## Why Now?

Three things changed that make this the right time.

### 1. Open standards for AI tooling arrived

Anthropic created the Model Context Protocol (MCP) as an open standard for connecting AI systems to external data and tools. As of early 2026, there are over 10,000 active public MCP servers and 97 million monthly SDK downloads. MCP has been adopted by ChatGPT, Cursor, Gemini, and Microsoft Copilot. Anthropic donated MCP to the Linux Foundation's Agentic AI Foundation in December 2025, co-founded by Anthropic, Block, and OpenAI, signaling that this infrastructure should be open and vendor-neutral. This makes building a context layer that plugs into multiple providers far more realistic than it was even a year ago.

### 2. The industry agrees memory should live outside the model

OpenAI's own engineering guidance now describes a local-first memory store pattern with structured state, consolidation, and precedence rules. Anthropic's context engineering guidance emphasizes finding "the smallest possible set of high-signal tokens" rather than stuffing everything into the prompt. Both major providers are pointing toward the same conclusion: memory management is a separate concern from model reasoning. The industry has started calling this discipline "context engineering," with four strategic categories: write, select, compress, and isolate. The bottleneck in production AI systems is rarely the model itself. It's what you feed it.

### 3. AI usage is becoming long-term and multi-provider

People don't just use one AI tool anymore. They use ChatGPT for some things, Claude for others, Gemini for another set. In early 2026, over 2.5 million users joined the "QuitGPT" movement after concerns about OpenAI's direction, many switching to Claude or other providers. As AI becomes part of daily workflows, the cost of fragmented memory goes up. And as agents become more common, the need for persistent, reliable context becomes critical.

### 4. Existing solutions prove demand but leave gaps

Several open-source projects have already shown that portable AI memory is a real need:

- **Mem0** is widely adopted and used by Netflix, Lemonade, and Rocket Money. It uses passive extraction, where the system decides what to store automatically.
- **Letta** (formerly MemGPT, from UC Berkeley) takes a different approach where the AI model self-edits its own memory through tool calls, like an operating system managing RAM and disk.
- **Supermemory** ranks first on major memory benchmarks and ships with a browser extension and MCP server.

These projects prove the demand is real. But they all make different tradeoffs. Mem0's passive extraction is predictable but misses nuance. Letta's self-editing is adaptive but costs tokens and depends on model quality. None of them emphasize the full pipeline I care about: local-first storage, structured conflict resolution, truth-preserving context compilation, and full user inspectability. That's the gap RecallOS fills.

## Who Is This For?

### Primary users

- **People who use multiple AI tools.** They switch between ChatGPT, Claude, and others. They're tired of repeating themselves.

- **Developers building AI apps.** They need persistent memory for their applications but don't want to build it from scratch or lock into one provider.

- **Agent builders.** They need reliable context that persists across sessions and tasks.

### Secondary users

- **Privacy-conscious users.** They want their AI memory on their own machine, not in someone else's cloud.

- **Open-source contributors.** They want to help build the memory infrastructure for the AI era.

- **Teams avoiding vendor lock-in.** They want portable memory that doesn't depend on any single provider.

## How I'll Build It

I'm building this in three milestones. Each one proves something new and builds on the last.

**Milestone 1: Prove it works for one use case.** Pick a specific domain (like travel planning), build the daemon, MCP server, and context pipeline end-to-end. Show that a user connected to RecallOS through Claude Desktop or another MCP client gets materially better responses than raw chat history.

**Milestone 2: Ship the SDK.** Turn RecallOS into embeddable infrastructure for developers and agents. Publish the SDK, document the APIs, build the plugin system, and make it easy for anyone to integrate RecallOS into their own apps or agent workflows.

**Milestone 3: Generalize to a full context runtime.** Expand the engine so it handles any domain, not just the one I started with. Make the memory schema flexible, the context compiler adaptable, and the system robust enough to serve as the persistent context layer for long-running agents and complex multi-step workflows.

## What Success Looks Like

When RecallOS works, a user should be able to say:

> "I talked to Claude this morning about my project and switched to ChatGPT this afternoon. ChatGPT already knew everything, my preferences, my project context, what I discussed with Claude, because they're both connected to the same local engine. I didn't have to repeat anything. I can see exactly what each model was told about me. And I can correct it when it's wrong."

That's the behavior change I'm building toward.

## Risks and Honest Challenges

**Competition.** The AI memory space already has strong existing projects with large communities and significant traction. I'm not entering an empty market. My bet is that none of them are user-centric. They're built for developers or agents, not for end users who want to own their state layer. RecallOS's differentiation is in the full pipeline: local-first storage, structured conflict resolution, truth-preserving context compilation, and full inspectability. But I have to prove that matters, not just assert it.

**Adoption.** Open-source infrastructure projects need a community. Building one takes time and good developer experience.

**Context injection latency.** If RecallOS needs to search a large memory store and compile context before sending the prompt to the model, the user might experience a 1-3 second delay. I'll need a high-performance local store (something like LanceDB or DuckDB) to keep this fast.

**The extraction problem.** Raw chat logs are noisy. If I just store every conversation as-is, the injected context will be cluttered and waste tokens. I need a local "background refiner," a small, efficient model (like Llama 4 Scout or Qwen 2.5 Coder 7B) that runs locally to extract structured Facts and Traits from raw interactions before they're stored. Getting this extraction right is critical.

**Cross-device sync.** If a user has a laptop and a desktop, "local only" becomes a pain point. I'll need encrypted peer-to-peer sync (something like Tailscale or Syncthing integration) to keep memory consistent across devices. This isn't a launch requirement, but it's a real problem I can't ignore for long.

**Context quality.** Getting context compilation right is genuinely hard. Too much context wastes tokens and confuses models. Too little context loses important information. Anthropic's own research notes that despite growing context windows, performance degrades as token count grows because of how attention works. The compiler needs to be smart about what to include.

**MCP adoption gaps.** While MCP is widely adopted, not every AI tool supports it yet. I'm betting that MCP becomes the standard, but if a major provider doesn't adopt it, I'll need workarounds.

**Dashboard UX.** Memory management UIs are historically bad. ChatGPT's memory is basically invisible. Making the dashboard intuitive enough that users actually inspect and control their memory, without overwhelming them, is a real design challenge.

I'm not pretending these are easy problems. But they're the right problems to solve, and solving them creates real value.

## The Bet

The bet is simple: **the AI industry is going to need a standard memory and context layer, and it should be open source and user-owned.**

If that's true, whoever builds it well and gets adoption wins. RecallOS is my attempt to be that project.
