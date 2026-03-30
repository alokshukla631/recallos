# Mnemo

**AI models are the brain. Mnemo is the memory layer. The brain can be swapped. The memory stays with you.**

## What is Mnemo?

Mnemo is a free, open-source, local-first context engine. It collects your memory (preferences, facts, history) across every AI tool you use, but it doesn't dump all of that into the next conversation. It picks only the pieces that matter for what you're doing right now and sends just that to the model.

It runs quietly in the background on your computer. When you talk to Claude, ChatGPT, VS Code, Cursor, or any other AI tool that supports MCP, Mnemo gives that tool the right slice of your personal context. Not your whole history, just what's relevant to this specific request.

You keep using the AI tools you already like. Mnemo just makes them all smarter about you.

**AI providers do the thinking. You keep the memory.**

## The problem

- **AI memory is fragmented across tools.** You tell one tool you prefer Python. Then you open another and have to say it again. Every tool maintains its own silo, and none of them talk to each other.
- **Provider memory is provider-specific and not portable.** Any memory a tool stores about you is locked inside that tool. Switch providers, and you start from zero.
- **Users cannot easily inspect or edit how memory is applied.** Most tools give you no way to see what the model "remembers," correct mistakes, or control what gets surfaced in a given conversation.
- **Transcript-based history does not equal reliable context.** Scrolling back through old conversations is not the same as having clean, structured, relevant context delivered at the right moment.

## How it works

Mnemo has three parts:

1. **The Engine (Rust)** runs in the background. It watches your local chat logs, pulls out useful facts (like "prefers window seats" or "works in Rust"), and keeps them organized. Written in Rust so it stays fast and light, using almost no memory while running 24/7.

2. **The MCP Server (TypeScript)** is how AI tools talk to Mnemo. When Claude or ChatGPT needs to know something about you, it asks Mnemo through MCP. Mnemo picks the right pieces and sends them over. It uses the official MCP SDK so it works with everything.

3. **The Dashboard** is a simple web page on your computer where you can see everything Mnemo knows about you. You can search it, fix mistakes, or delete things. It's where you inspect and manage your memory, not a chat app.

## How Mnemo learns what you said

This is the golden question. MCP is sandboxed, so Mnemo can't "overhear" your chats. So how does it know what you discussed?

A hybrid approach:

| Method | What happens | Role |
|:---|:---|:---|
| **Log scraper** (primary) | Mnemo watches the local files that Claude Desktop, Cursor, and VS Code already save on your computer, and reads new chats from there. Zero friction: it just indexes data that's already on your disk. | The main way Mnemo learns |
| **Self-reporting tool** (secondary) | The AI tool calls a `record_interaction` function after each chat to tell Mnemo what was discussed. Catches things the log scraper might miss. | Fills in the gaps |

**Why this matters:** This is what gives Mnemo cross-tool continuity. Talk to Claude in the morning, open ChatGPT in the afternoon. ChatGPT asks Mnemo what you discussed earlier. Seamless continuity across tools that don't know about each other.

## Why Mnemo is not just search or memory storage

Raw history is not the same as usable context. A pile of old transcripts does not help a model understand what matters right now.

Mnemo goes further:

- **Structured memory extraction.** Mnemo doesn't just store conversations. It extracts structured memory items from them: preferences, facts, decisions, project details.
- **Rich metadata on every item.** Every memory item tracks its source, recency, scope, and confidence. This metadata is what makes retrieval intelligent rather than naive.
- **Conflict resolution, not blind retrieval.** If you said "I like Python" last year but "use TypeScript for this project" yesterday, Mnemo knows which one applies right now. It resolves contradictions instead of dumping both into the prompt and hoping the model figures it out.
- **Task-specific context compilation.** For each request, Mnemo compiles a context packet tailored to the current task, fitting it within the model's token budget. The model sees exactly what it needs, nothing more.

## What makes Mnemo different

- **Built for end users first. Extensible for developers. Useful for AI products and agents later.** Mem0 is made for programmers to add to their apps. Letta is made for AI agents. Mnemo is made for the person using AI every day, and it gives developers an SDK to build on top of that same foundation. You own your memory.
- **Works across all your AI tools.** Use GPT in the morning, Claude in the afternoon. Mnemo gives both the same memory. I call this the "Memory Passport."
- **Your data stays on your machine.** Your full history never leaves your computer. The AI only sees the small piece Mnemo picks for that specific question, even if you have hundreds of gigabytes saved locally.
- **Gets smarter in the background.** A small AI model runs on your computer to turn messy chat logs into clean, organized facts. It does this while your computer is idle, so it costs you nothing.
- **Handles contradictions.** If you said "I like Python" last year but "use TypeScript for this project" yesterday, Mnemo knows which one matters right now.
- **You can see everything.** No black box. You can always check what memory was used, why it was picked, and fix it if it's wrong.

## Roadmap

| Step | Goal | What gets built |
|:---|:---|:---|
| **M1** | Prove the local context engine works for one narrow use case (travel planning) | Rust engine, MCP server, log scraper, self-reporting tool, memory extraction, conflict handling, context selection, dashboard |
| **M2** | SDK and runtime for builders. Sharpen the architecture, strengthen the open-source story | SDKs for Node.js/Python/REST, tools for AI agents, plugin system, debugging tools |
| **M3** | Generalized context runtime for broader domains and long-running agents | Flexible memory types, cross-topic context, more log scrapers, large-scale local search, MCP client connections |

## Tech

- **Engine:** Rust. Fast, light, runs 24/7 without eating resources.
- **MCP layer:** TypeScript. Uses the official MCP SDK, talks to the Rust engine via local socket.
- **Storage:** LanceDB (for searching by meaning) + SQLite (for organized data)
- **Local AI:** Small models like Llama 4 Scout, Gemma 3, or Phi-4 to process your chats in the background

## How it all fits together

```
+---------------------------------------------------+
|  Your AI Tools (Claude, ChatGPT, VS Code, Cursor) |
|  talk to Mnemo through MCP                        |
+---------------------------------------------------+
|  Mnemo MCP Server (TypeScript)                     |
|  Shares your data, search tools, and templates     |
|  Self-reporting tool catches extra interactions     |
+---------------------------------------------------+
|  Mnemo Engine (Rust, runs in the background)       |
|  Log scraper watches local chat files              |
|  Extracts facts > Stores memory > Handles conflicts|
|  Picks the right context for each request          |
+---------------------------------------------------+
|  Dashboard (web page on your computer)             |
|  Browse, Search, Edit, See what was shared          |
+---------------------------------------------------+
```

## Docs

- [`docs/00-vision.md`](docs/00-vision.md): The big picture
- [`docs/01-project-proposal.md`](docs/01-project-proposal.md): Full project proposal
- [`docs/02-prfaq.md`](docs/02-prfaq.md): Questions and answers
- [`docs/03-milestones.md`](docs/03-milestones.md): Detailed build plan

## Status

Early stage. Working on Milestone 1.

## License

Open source. License TBD.
