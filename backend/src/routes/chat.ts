import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { queryAll, queryOne, runSql } from "../db/index.js";
import { storeEvent, getRecentTurns } from "../modules/event-store.js";
import { extractMemory } from "../modules/memory-extractor.js";
import { reconcileMemory } from "../modules/memory-reconciler.js";
import { compileContext } from "../modules/context-compiler.js";
import { getAdapter, type ChatMessage } from "../modules/provider-adapter.js";
import { saveSnapshot } from "../modules/context-snapshot.js";

const router = Router();

const SYSTEM_PROMPT = `You are a helpful travel planning assistant. Use the provided user context to give consistent, personalized responses. If the context includes preferences or constraints, respect them. If context conflicts with the user's latest message, follow the latest message and ask for clarification.`;

// POST / - the full chat pipeline
router.post("/", async (req: Request, res: Response) => {
  try {
    const { message, provider, conversation_id, trip_id } = req.body;

    if (!message || !provider) {
      res.status(400).json({ error: "message and provider are required" });
      return;
    }

    const convId = conversation_id || uuidv4();

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
    const userEvent = await storeEvent(convId, "user", message, provider, trip_id);

    // Step 3: Extract memory candidates from the user message
    const candidates = await extractMemory(message, userEvent.id, trip_id);

    // Step 4: Reconcile memory (conflict detection, supersession)
    const reconcileResult = await reconcileMemory(candidates, userEvent.id);

    // Step 5: Compile context packet
    const compiled = await compileContext(convId, message, trip_id);

    // Step 6: Build message history for the provider
    const recentTurns = await getRecentTurns(convId, 20);
    const chatMessages: ChatMessage[] = recentTurns
      .filter((e) => e.role === "user" || e.role === "assistant")
      .map((e) => ({ role: e.role as "user" | "assistant", content: e.content }));

    // Step 7: Call the provider API
    const adapter = getAdapter(provider);
    const providerResponse = await adapter.chat(
      providerRow.api_key,
      SYSTEM_PROMPT,
      chatMessages,
      compiled.contextText
    );

    // Step 8: Store assistant response
    const assistantEvent = await storeEvent(
      convId,
      "assistant",
      providerResponse.content,
      provider,
      trip_id
    );

    // Step 9: Save context snapshot
    const snapshot = await saveSnapshot(
      userEvent.id,
      provider,
      compiled.contextPacket,
      compiled.includedIds,
      compiled.omittedIds,
      compiled.rationale,
      compiled.contextText
    );

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
      },
      context: {
        snapshot_id: snapshot.id,
        included_count: compiled.includedIds.length,
        omitted_count: compiled.omittedIds.length,
        context_text: compiled.contextText,
      },
      usage: providerResponse.usage,
    });
  } catch (err) {
    console.error("POST /api/chat error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ error: message });
  }
});

// GET /conversations - list conversations
router.get("/conversations", (_req: Request, res: Response) => {
  try {
    const rows = queryAll(
      `SELECT conversation_id, trip_id,
              MIN(created_at) AS started_at,
              MAX(created_at) AS last_message_at,
              COUNT(*) AS message_count
       FROM events
       GROUP BY conversation_id
       ORDER BY last_message_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/chat/conversations error:", err);
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

export default router;
