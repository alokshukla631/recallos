import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { queryAll, queryOne, runSql } from "../db/index.js";
import { storeEvent, getRecentTurns } from "../modules/event-store.js";
import { extractMemory } from "../modules/memory-extractor.js";
import { reconcileMemory } from "../modules/memory-reconciler.js";
import { compileContext } from "../modules/context-compiler.js";
import { getAdapter, type ChatMessage } from "../modules/provider-adapter.js";
import { saveSnapshot } from "../modules/context-snapshot.js";
import {
  ensureConversation,
  listConversations,
  getConversation,
  updateConversationTitle,
  deleteConversation,
} from "../modules/conversations.js";
import { PerfTimer } from "../modules/perf.js";

const router = Router();

const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant with access to the user's stored preferences and context. Use the provided user context to give consistent, personalized responses. If the context includes preferences or constraints, respect them. If context conflicts with the user's latest message, follow the latest message and ask for clarification.`;

function getSystemPrompt(): string {
  const row = queryOne("SELECT value FROM app_settings WHERE key = 'system_prompt'") as any;
  return row?.value || DEFAULT_SYSTEM_PROMPT;
}

// POST / - the full chat pipeline
router.post("/", async (req: Request, res: Response) => {
  try {
    const { message, provider, conversation_id, trip_id } = req.body;

    if (!message || !provider) {
      res.status(400).json({ error: "message and provider are required" });
      return;
    }

    const timer = new PerfTimer();
    const convId = conversation_id || uuidv4();

    // Step 0: Ensure the conversation row exists (creates on first message)
    ensureConversation(convId, message, trip_id);

    // Step 1: Get API key for the provider
    const providerRow = queryOne(
      "SELECT api_key FROM provider_settings WHERE provider = ?",
      [provider]
    ) as { api_key: string } | undefined;

    if (!providerRow) {
      res.status(400).json({
        error: `No API key configured for provider "${provider}". Add one in Settings.`,
      });
      return;
    }

    // Step 2: Store user event
    timer.begin("store_event");
    const userEvent = await storeEvent(convId, "user", message, provider, trip_id);

    // Step 3: Extract memory candidates from the user message
    timer.begin("extraction");
    const candidates = await extractMemory(message, userEvent.id, trip_id);

    // Step 4: Reconcile memory (conflict detection, supersession)
    timer.begin("reconciliation");
    const reconcileResult = await reconcileMemory(candidates, userEvent.id);

    // Step 5: Compile context packet
    timer.begin("context_compilation");
    const compiled = await compileContext(convId, message, trip_id);

    // Step 6: Build message history for the provider
    timer.begin("history_fetch");
    const recentTurns = await getRecentTurns(convId, 20);
    const chatMessages: ChatMessage[] = recentTurns
      .filter((e) => e.role === "user" || e.role === "assistant")
      .map((e) => ({ role: e.role as "user" | "assistant", content: e.content }));

    // Step 7: Call the provider API
    timer.begin("provider_call");
    const adapter = getAdapter(provider);
    const providerResponse = await adapter.chat(
      providerRow.api_key,
      getSystemPrompt(),
      chatMessages,
      compiled.contextText
    );

    // Step 8: Store assistant response
    timer.begin("store_response");
    const assistantEvent = await storeEvent(
      convId,
      "assistant",
      providerResponse.content,
      provider,
      trip_id
    );

    // Step 9: Save context snapshot (include traces in rationale)
    timer.begin("save_snapshot");
    const snapshot = await saveSnapshot(
      userEvent.id,
      provider,
      compiled.contextPacket,
      compiled.includedIds,
      compiled.omittedIds,
      { rationale: compiled.rationale, trace: compiled.trace },
      compiled.contextText
    );

    const timing = timer.finish();

    // Step 10: Return response
    res.json({
      conversation_id: convId,
      assistant_message: {
        id: assistantEvent.id,
        role: "assistant",
        content: providerResponse.content,
      },
      memory_extracted: candidates.length,
      memory_reconciled: {
        added: reconcileResult.added.length,
        updated: reconcileResult.updated.length,
        conflicts: reconcileResult.conflicts.length,
        duplicates: reconcileResult.duplicates.length,
      },
      context: {
        snapshot_id: snapshot.id,
        included_count: compiled.includedIds.length,
        omitted_count: compiled.omittedIds.length,
        context_text: compiled.contextText,
        token_estimate: compiled.tokenEstimate,
      },
      usage: providerResponse.usage,
      timing,
    });
  } catch (err) {
    console.error("POST /api/chat error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ error: message });
  }
});

// POST /stream - streaming version of the chat pipeline (SSE)
router.post("/stream", async (req: Request, res: Response) => {
  const { message, provider, conversation_id, trip_id } = req.body;

  if (!message || !provider) {
    res.status(400).json({ error: "message and provider are required" });
    return;
  }

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const timer = new PerfTimer();
    const convId = conversation_id || uuidv4();

    ensureConversation(convId, message, trip_id);

    const providerRow = queryOne(
      "SELECT api_key FROM provider_settings WHERE provider = ?",
      [provider]
    ) as { api_key: string } | undefined;

    if (!providerRow) {
      send("error", {
        error: `No API key configured for provider "${provider}". Add one in Settings.`,
      });
      res.end();
      return;
    }

    send("conversation", { conversation_id: convId });

    timer.begin("store_event");
    const userEvent = await storeEvent(convId, "user", message, provider, trip_id);

    timer.begin("extraction");
    const candidates = await extractMemory(message, userEvent.id, trip_id);

    timer.begin("reconciliation");
    const reconcileResult = await reconcileMemory(candidates, userEvent.id);

    send("memory", {
      extracted: candidates.length,
      added: reconcileResult.added.length,
      updated: reconcileResult.updated.length,
      conflicts: reconcileResult.conflicts.length,
      duplicates: reconcileResult.duplicates.length,
    });

    timer.begin("context_compilation");
    const compiled = await compileContext(convId, message, trip_id);

    send("context", {
      included_count: compiled.includedIds.length,
      omitted_count: compiled.omittedIds.length,
      context_text: compiled.contextText,
      token_estimate: compiled.tokenEstimate,
    });

    timer.begin("history_fetch");
    const recentTurns = await getRecentTurns(convId, 20);
    const chatMessages: ChatMessage[] = recentTurns
      .filter((e) => e.role === "user" || e.role === "assistant")
      .map((e) => ({ role: e.role as "user" | "assistant", content: e.content }));

    timer.begin("provider_call");
    const adapter = getAdapter(provider);
    const stream = adapter.chatStream(
      providerRow.api_key,
      getSystemPrompt(),
      chatMessages,
      compiled.contextText
    );

    let fullContent = "";
    let finalResult: { content: string; usage?: unknown } | undefined;

    while (true) {
      const next = await stream.next();
      if (next.done) {
        finalResult = next.value as { content: string; usage?: unknown };
        break;
      }
      const delta = next.value;
      fullContent += delta;
      send("delta", { text: delta });
    }

    timer.begin("store_response");
    const assistantContent = finalResult?.content ?? fullContent;
    const assistantEvent = await storeEvent(
      convId,
      "assistant",
      assistantContent,
      provider,
      trip_id
    );

    timer.begin("save_snapshot");
    const snapshot = await saveSnapshot(
      userEvent.id,
      provider,
      compiled.contextPacket,
      compiled.includedIds,
      compiled.omittedIds,
      { rationale: compiled.rationale, trace: compiled.trace },
      compiled.contextText
    );

    const timing = timer.finish();

    send("done", {
      assistant_message: {
        id: assistantEvent.id,
        role: "assistant",
        content: assistantContent,
      },
      snapshot_id: snapshot.id,
      usage: finalResult?.usage,
      timing,
    });

    res.end();
  } catch (err) {
    console.error("POST /api/chat/stream error:", err);
    const errMessage = err instanceof Error ? err.message : "Internal server error";
    try {
      send("error", { error: errMessage });
      res.end();
    } catch {
      // ignore
    }
  }
});

// GET /conversations - list conversations with titles
router.get("/conversations", (_req: Request, res: Response) => {
  try {
    res.json(listConversations());
  } catch (err) {
    console.error("GET /api/chat/conversations error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /conversations/search - search across conversation content
router.get("/conversations/search", (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string || "").trim();
    if (!q) {
      res.json([]);
      return;
    }

    // Search events for matching content, group by conversation
    const matches = queryAll(
      `SELECT e.conversation_id, e.content, e.role, e.created_at,
              c.title as conv_title
       FROM events e
       LEFT JOIN conversations c ON c.id = e.conversation_id
       WHERE e.content LIKE ? AND e.role IN ('user', 'assistant')
       ORDER BY e.created_at DESC
       LIMIT 50`,
      [`%${q}%`]
    ) as any[];

    // Group by conversation, return snippets
    const seen = new Set<string>();
    const results: any[] = [];
    for (const m of matches) {
      if (seen.has(m.conversation_id)) continue;
      seen.add(m.conversation_id);

      // Extract a snippet around the match
      const idx = m.content.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, idx - 40);
      const end = Math.min(m.content.length, idx + q.length + 60);
      const snippet = (start > 0 ? "..." : "") + m.content.slice(start, end) + (end < m.content.length ? "..." : "");

      results.push({
        conversation_id: m.conversation_id,
        title: m.conv_title || "Untitled",
        snippet,
        role: m.role,
        created_at: m.created_at,
      });
    }

    res.json(results);
  } catch (err) {
    console.error("GET /api/chat/conversations/search error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /conversations/:id - rename a conversation
router.patch("/conversations/:id", (req: Request, res: Response) => {
  try {
    const { title } = req.body;
    const id = req.params.id as string;
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const conv = getConversation(id);
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    updateConversationTitle(id, title);
    res.json(getConversation(id));
  } catch (err) {
    console.error("PATCH /api/chat/conversations/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /conversations/:id - remove a conversation and its events
router.delete("/conversations/:id", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const conv = getConversation(id);
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    deleteConversation(id);
    res.json({ message: "Conversation deleted" });
  } catch (err) {
    console.error("DELETE /api/chat/conversations/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /conversations/:id - get messages for a conversation
router.get("/conversations/:id", (req: Request, res: Response) => {
  try {
    const rows = queryAll(
      `SELECT id, conversation_id, trip_id, role, content, provider, created_at
       FROM events
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
      [req.params.id]
    );

    if (!rows.length) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    res.json(rows);
  } catch (err) {
    console.error("GET /api/chat/conversations/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /conversations/:id/export - export a conversation as JSON or text
router.get("/conversations/:id/export", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const format = (req.query.format as string) || "json";

    const conv = getConversation(id);
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const events = queryAll(
      `SELECT role, content, provider, created_at
       FROM events
       WHERE conversation_id = ? AND role IN ('user', 'assistant')
       ORDER BY created_at ASC`,
      [id]
    ) as any[];

    if (format === "text") {
      const lines: string[] = [];
      lines.push(`# ${conv.title || "Untitled Conversation"}`);
      lines.push(`Exported: ${new Date().toISOString().slice(0, 10)}`);
      lines.push("");
      for (const e of events) {
        const role = e.role === "user" ? "You" : "Assistant";
        lines.push(`**${role}** (${e.created_at}):`);
        lines.push(e.content);
        lines.push("");
      }
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="conversation-${id.slice(0, 8)}.txt"`);
      res.send(lines.join("\n"));
    } else {
      const exportData = {
        id: conv.id,
        title: conv.title,
        trip_id: conv.trip_id,
        created_at: conv.created_at,
        messages: events.map((e) => ({
          role: e.role,
          content: e.content,
          provider: e.provider,
          created_at: e.created_at,
        })),
      };
      res.setHeader("Content-Disposition", `attachment; filename="conversation-${id.slice(0, 8)}.json"`);
      res.json(exportData);
    }
  } catch (err) {
    console.error("GET /api/chat/conversations/:id/export error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
