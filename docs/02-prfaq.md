# RecallOS: PRFAQ

---

## Press Release

### RecallOS: Open-Source Local Memory Infrastructure for AI

**Today, the RecallOS project announced the release of an open-source, local-first context daemon that gives users portable, persistent memory across every AI tool they use.**

Every major AI assistant (ChatGPT, Claude, Gemini) manages user memory in its own silo. When you build up preferences and history with one tool, none of that carries over to another. Switch providers and you start from scratch. Even within a single provider, memory is often unreliable: preferences get forgotten, old information sticks around, temporary instructions become permanent, and users can't easily see or fix what the system "knows" about them.

RecallOS fixes this by separating memory from reasoning. It's not another chat app. It's a context engine: a background service that runs on your machine and connects to the AI tools you already use. It collects your memory across all your tools, but it doesn't send the whole thing to the model. When you open Claude Desktop, ChatGPT, VS Code, or any MCP-compatible tool, RecallOS picks only the pieces relevant to this specific request and sends just that. The model gets the right context, not your entire history.

Your memory stays local. You can inspect it, edit it, delete it, or export it. The AI providers only see the small slice of relevant context that RecallOS chooses to share, even if you have hundreds of gigabytes of indexed personal data on your machine.

"I'm not building a destination," said Alok, the project's creator. "I'm building the infrastructure layer that AI platforms rent context from. Users keep their favorite tools. RecallOS makes all of them smarter."

At launch, RecallOS is:

- **A background daemon** that runs locally, starts with your machine, no interaction needed
- **An MCP server** that connects to Claude Desktop, ChatGPT, VS Code, Cursor, and any MCP-compatible tool
- **A memory dashboard**, a local web UI where you can see, edit, and manage what the engine knows about you
- **Open source**, fully open, auditable, and community-driven

RecallOS is built for anyone who uses AI regularly and wants their memory to actually work: across tools, across sessions, and under their control.

The project is open source and available now at [repo URL].

---

## Frequently Asked Questions

### Customer Questions

**Q: What exactly is RecallOS?**

A: It's a background service that runs on your computer and manages your AI memory. Think of it as a personal memory daemon that connects to whatever AI tools you already use (Claude Desktop, ChatGPT, VS Code, Cursor). It remembers your preferences, facts about you, and history, and when any of those tools ask, it sends them the right pieces. You don't switch to a new app. You keep using what you already use, and everything just knows you better.

**Q: Why do I need this? My AI already has memory.**

A: It does, but that memory is locked inside one provider. If you use ChatGPT and Claude, you have two separate, incomplete memories that don't talk to each other. And even within one provider, memory is often unreliable: it forgets things, misapplies old information, or keeps stale facts. RecallOS gives you one reliable memory that works everywhere.

**Q: Does this replace ChatGPT or Claude?**

A: No. That's the whole point. You keep using Claude Desktop, ChatGPT, VS Code, Cursor, whatever you like. RecallOS runs in the background and makes all of them better by giving them your personal context. RecallOS isn't competing with those tools. It's making them smarter.

**Q: Where is my data stored?**

A: On your machine. Locally. RecallOS doesn't send your memory to any server. The only time your data leaves your machine is when compiled context is sent to the AI model you choose to use, and even then, the model only sees the relevant pieces, not your full history. This also means you can safely index sensitive things (local database schemas, SSH keys, personal notes) that you'd never paste into a cloud AI interface.

**Q: Can I see what it remembers about me?**

A: Yes. Everything. RecallOS comes with a local memory dashboard, a web UI that runs on your machine where you can browse your memory, search it, edit it, delete specific items, see which AI models have accessed which data, and export the whole thing. One of the main points of RecallOS is that memory should be transparent, not a black box.

**Q: What happens when my memory has contradictions?**

A: RecallOS has rules for this. It tracks when each piece of memory was created, whether it's temporary or permanent, and what the source was. If you said "I prefer Python" six months ago and "use TypeScript for this project" yesterday, the system knows the second one is a temporary, project-specific override and the first one is a general preference. It picks the right one based on what you're doing.

**Q: Is this free?**

A: Yes. It's open source. You can use it, modify it, and contribute to it.

**Q: What AI tools does it work with?**

A: Any tool that supports MCP (Model Context Protocol). Right now that includes Claude Desktop, ChatGPT, VS Code, Cursor, Gemini, and Microsoft Copilot, plus thousands of other MCP-compatible tools. Since MCP is an open standard adopted by all major providers, the list keeps growing. There's no need to build custom integrations for each tool. If it speaks MCP, it works with RecallOS.

**Q: I'm a developer. Can I use this in my own app?**

A: Yes. RecallOS is an MCP server, so any MCP-compatible app can connect to it out of the box. For deeper integration, the project will also ship an SDK that lets you embed the memory and context layer directly into your application. You get persistent, portable user memory without having to build it yourself.

**Q: How is this different from just saving chat logs?**

A: Chat logs are raw transcripts, a dump of everything that was said. RecallOS extracts structured facts and preferences from those conversations, tracks their freshness and relevance, resolves contradictions, and compiles just the right pieces for each new request. It's the difference between a filing cabinet full of papers and a well-organized brief prepared for a specific meeting.

**Q: How is this different from Mem0 or Letta (MemGPT)?**

A: The biggest difference is who owns the state. Mem0 is a database developers call from their code to remember things about users, so it's developer-centric. Letta is a runtime where the AI agent is the memory, so it's agent-centric. RecallOS is user-centric. You own the state layer. You control what gets remembered, what gets shared with which model, and what gets deleted. Beyond that, RecallOS focuses on the full pipeline: local-first storage, structured conflict resolution, truth-preserving context compilation, and full inspectability. It sits between you and the model API, intercepting requests, injecting context, and saving responses, without the model provider ever seeing the full scope of your history.

**Q: What if I stop using it? Can I get my data out?**

A: Yes. Your memory is stored in open formats on your machine. You can export it anytime. There's no lock-in.

---

### Technical Questions

**Q: What's the architecture?**

A: Three components. First, the Engine: a background daemon that stores interactions, extracts structured facts via a local refiner model, resolves conflicts, and compiles context. Second, the MCP Server: the bridge that exposes the engine's capabilities to any MCP-compatible AI tool. It provides Resources (data streams like `personal://coding-preferences`), Tools (search functions like `search_memory(query="...")`), and Prompts (context templates the user can trigger). Third, a Memory Dashboard: a local web UI for inspecting and managing memory. No chat interface. The conversation happens in whatever tool the user already prefers.

**Q: What database does it use for local storage?**

A: A high-performance local vector database like LanceDB or DuckDB for semantic search, plus SQLite for structured metadata. The storage layer is pluggable, so other backends can be added. Performance matters here, as it needs to search potentially large memory stores and compile context without adding noticeable latency.

**Q: How does context compilation work?**

A: When a user makes a request, the compiler scores each memory item based on relevance to the current task, freshness, scope (global vs. project-specific vs. temporary), source reliability, and token budget. It then assembles the highest-scoring items into a context package that fits within the model's context window.

**Q: How does it handle the context window limit?**

A: The compiler is budget-aware. It knows how many tokens each provider allows and how many are needed for the user's actual request. It fills the remaining space with the most relevant context, prioritizing by the scoring system. If the budget is tight, it summarizes or drops lower-priority items.

**Q: Does it work with MCP?**

A: MCP is central to the architecture. RecallOS is primarily an MCP server. That's how AI models connect to it. When a model needs context about the user, it queries RecallOS through MCP. RecallOS can also act as an MCP client, connecting to other MCP servers to pull in context from calendars, code repos, documents, and other tools. Building on MCP means RecallOS works with the existing ecosystem rather than requiring custom integrations for each provider.

**Q: How does RecallOS know what I said to Claude or ChatGPT? MCP is sandboxed.**

A: A hybrid of two strategies. The primary method is the log scraper. Tools like Claude Desktop, Cursor, and VS Code already save chat logs to your local disk (SQLite databases, JSON files) for session restore. RecallOS runs a background watcher that monitors those folders, parses new entries, and indexes them automatically. It's invisible, just indexing data that's already on your machine. The secondary method is the self-reporting tool. RecallOS tells the connected model (via MCP instructions) to call `record_interaction` with a summary after each exchange, catching anything the log scraper might miss. Together, these give RecallOS full cross-tool continuity. Talk to Claude in the morning, open ChatGPT in the afternoon, and ChatGPT can ask RecallOS what you discussed earlier. Seamless continuity across tools that don't know about each other.

**Q: What about the "extraction problem"? Don't raw chat logs make terrible memory?**

A: Yes, and that's why RecallOS doesn't store raw logs as memory. RecallOS runs a "background refiner," a small, efficient local model (like Llama 4 Scout or Qwen 2.5 Coder 7B) that processes raw interactions and extracts structured Facts and Traits before they're stored. Instead of saving "The user said they're vegetarian in message 47 of conversation 12," it saves a clean structured fact: "User is vegetarian, stated directly, high confidence, last confirmed March 2026." This runs locally during idle time, so it costs nothing to operate.

**Q: How do you prevent stale memory from poisoning responses?**

A: Every memory item has metadata: creation date, last confirmed date, source, scope, and confidence. The context compiler penalizes items that haven't been confirmed recently or that come from less reliable sources. Users can also set explicit expiration on temporary items.

**Q: Can multiple users share a RecallOS instance?**

A: The initial version is designed for single-user, single-machine use. Multi-user and sync capabilities are possible future extensions, but local-first single-user is the priority.

**Q: What about cross-device sync? I use a laptop and a desktop.**

A: This is a real problem with local-first architecture. I plan to support encrypted peer-to-peer sync through tools like Tailscale or Syncthing. Your memory stays encrypted and syncs directly between your devices without going through any central server. This isn't a launch feature, but it's on the roadmap because "local only" breaks down quickly if you use more than one machine.

**Q: What language is it written in?**

A: Hybrid. Rust for the core engine and TypeScript for the MCP interface. The engine (the background daemon that handles file watching, log scraping, vector search, and heavy text processing) is written in Rust for performance and low memory usage, as it needs to run 24/7 in the background without eating up resources. The MCP server (the part that talks to Claude, ChatGPT, etc.) is a TypeScript wrapper that uses the official MCP SDK and communicates with the Rust engine via a local socket. This gives the best of both: Rust's speed and efficiency for the hard work, and TypeScript's ecosystem compatibility for the communication layer.

**Q: Why not just use Mem0 or Supermemory?**

A: Different focus. Mem0 is a developer tool, a database you call from your code. Supermemory is optimized for benchmarks and retrieval quality. RecallOS is a user-owned state layer that sits between you and any AI model. It handles not just storage and retrieval, but conflict resolution, precedence rules, truth maintenance, background extraction via local models, and a full context compilation pipeline. More importantly, RecallOS is user-centric: the user owns and controls the memory, rather than a developer or agent framework managing it on their behalf.

**Q: How do I contribute?**

A: The project is on GitHub and accepts contributions for memory modules, context compilation improvements, dashboard work, and documentation. See the contributing guide in the repo.
