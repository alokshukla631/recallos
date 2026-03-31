# RecallOS: Vision

## The one-sentence version

**AI models are the brain. RecallOS is the soul. The brain can be swapped. The soul stays with you.**

## What I believe

AI is getting cheaper, faster, and more commodity by the month. The models themselves are converging: GPT, Claude, Gemini, Llama, and whatever comes next will all be good enough for most tasks. The lasting value won't be in which model you use. It will be in the context that model has about you.

Right now, that context is locked inside each provider. If you spend three months teaching one model your coding style, your project architecture, your writing voice, and your personal preferences, all of that disappears the moment you switch providers. Your relationship with AI starts over every time you change tools.

That's the wrong architecture. The memory should belong to you, not to the model provider.

## What I'm building

RecallOS is a local-first context engine, the user-owned state layer for AI. It's not an app. It's infrastructure.

It collects your memory over time: every preference, fact, and interaction across every AI tool you use. But it doesn't dump all of that into the next conversation. Memory is everything RecallOS knows about you. Context is the small, relevant slice it picks for right now. That distinction is the whole point.

It runs as a background service on your machine, a local context daemon. When you open any MCP-compatible tool, that tool can query RecallOS: "What should I know about this user right now?" RecallOS searches your local memory, picks the pieces that matter for this specific request, and sends back just that, not your full history.

You keep using whatever AI tools you already like. RecallOS works behind the scenes, making all of them smarter about you. The model provider never sees your full history. They only see the small slice of relevant context that RecallOS chooses to send for this specific prompt, even if you have gigabytes of indexed personal data sitting on your local drive.

## Why it matters

**You own your memory.** Not OpenAI. Not Anthropic. Not Google. You. You can inspect it, edit it, delete it, export it, or move it to a new machine.

**Models become interchangeable.** You can swap the brain while keeping continuity. Use one model for one task, another for something else, a local model for something private. Same memory, same context, same experience.

**Privacy becomes real.** Because your memory never leaves your machine, you can index things you'd never put into a cloud AI: local codebases, personal emails, financial records, private keys. A local model handles the indexing, so no cloud provider ever sees the raw data.

**AI gets better over time.** Instead of starting every conversation from scratch, your AI actually knows you: your preferences, your constraints, your history, your evolving goals. Not because a cloud provider is building a dossier on you, but because you're building your own.

## The long-term picture

Today, every AI product bundles two things together: the model (reasoning) and the memory (context). I think those should be separate.

Here's the future I'm building toward:

- **Users** have a context daemon running in the background on their machine. They talk to one model in the morning and another in the afternoon, and both know them equally well, because both are connected to the same local memory. The AI providers only see what the engine chooses to share for each specific request.

- **Developers** use the RecallOS SDK to give their apps persistent, portable user memory without building it from scratch or locking into a single provider.

- **Agents** use RecallOS to maintain state across sessions, remembering what they've tried, what worked, what failed, and what the user's goals are. They can be interrupted and resume without losing their place.

- **The memory format is open.** Just like you can move your files between computers, you can move your AI memory between tools. No lock-in. No walled gardens. Think of it as a Memory Passport: your context travels with you.

The way I see it, context is the new data layer of the AI stack. Databases became standard infrastructure for web applications. Context engines will become standard infrastructure for AI applications.

I'm not building a destination. I'm building the infrastructure layer that every AI platform rents context from.

## How I get there

**Milestone 1:** Prove the engine works for one domain. Show that local memory with proper context compilation beats raw chat history.

**Milestone 2:** Ship the SDK. Let developers and agents use RecallOS as infrastructure.

**Milestone 3:** Generalize to a full context runtime for any domain and long-running agents. Make the model a true commodity: same engine, any task, any provider.

## The bet

The AI industry will commoditize reasoning. The scarce resource will be context: accurate, personal, portable, user-owned context.

I'm building the open-source infrastructure for that world.
