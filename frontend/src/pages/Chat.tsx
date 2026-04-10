import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import "./Chat.css";

interface Provider {
  provider: string;
  is_default: boolean;
}

interface ContextInfo {
  context_text: string;
  included_count: number;
  omitted_count: number;
}

interface StageTiming {
  stage: string;
  duration_ms: number;
}

interface PipelineTiming {
  total_ms: number;
  stages: StageTiming[];
}

interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  provider?: string;
  timestamp: string;
  context?: ContextInfo;
  memory_extracted?: number;
  memory_reconciled?: { added: number; updated: number; conflicts: number; duplicates?: number };
  timing?: PipelineTiming;
}

interface Conversation {
  id: string;
  title: string | null;
  trip_id: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface Trip {
  id: string;
  name: string;
  destination: string | null;
  status: string;
}

interface EventRow {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  provider: string | null;
  created_at: string;
}

function Chat() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selectedTripId, setSelectedTripId] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [expandedContexts, setExpandedContexts] = useState<Set<number>>(new Set());
  const [providersLoading, setProvidersLoading] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetchProviders();
    fetchConversations();
    fetchTrips();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function fetchProviders() {
    setProvidersLoading(true);
    try {
      const res = await fetch("/api/settings/providers");
      if (!res.ok) throw new Error("Failed to fetch providers");
      const data: Provider[] = await res.json();
      setProviders(data);
      const defaultProvider = data.find((p) => p.is_default);
      if (defaultProvider) {
        setSelectedProvider(defaultProvider.provider);
      } else if (data.length > 0) {
        setSelectedProvider(data[0].provider);
      }
    } catch {
      setProviders([]);
    } finally {
      setProvidersLoading(false);
    }
  }

  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/conversations");
      if (!res.ok) return;
      const data: Conversation[] = await res.json();
      setConversations(data);
    } catch {
      // ignore
    }
  }, []);

  async function fetchTrips() {
    try {
      const res = await fetch("/api/trips");
      if (!res.ok) return;
      const data: Trip[] = await res.json();
      setTrips(data);
    } catch {
      setTrips([]);
    }
  }

  async function openConversation(id: string) {
    try {
      const res = await fetch(`/api/chat/conversations/${id}`);
      if (!res.ok) return;
      const events: EventRow[] = await res.json();
      const msgs: Message[] = events
        .filter((e) => e.role === "user" || e.role === "assistant")
        .map((e) => ({
          id: e.id,
          role: e.role as "user" | "assistant",
          content: e.content,
          provider: e.provider ?? undefined,
          timestamp: e.created_at,
        }));
      setMessages(msgs);
      setConversationId(id);
      setExpandedContexts(new Set());
      // Sync the trip selector to the conversation's trip
      const conv = conversations.find((c) => c.id === id);
      if (conv) {
        setSelectedTripId(conv.trip_id ?? "");
      }
    } catch {
      // ignore
    }
  }

  function startNewConversation() {
    setMessages([]);
    setConversationId(null);
    setExpandedContexts(new Set());
    setInput("");
    setSelectedTripId("");
    textareaRef.current?.focus();
  }

  async function deleteConversation(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    try {
      await fetch(`/api/chat/conversations/${id}`, { method: "DELETE" });
      if (conversationId === id) {
        startNewConversation();
      }
      fetchConversations();
    } catch {
      // ignore
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading || !selectedProvider) return;

    const userMessage: Message = {
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };

    const assistantPlaceholder: Message = {
      role: "assistant",
      content: "",
      provider: selectedProvider,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage, assistantPlaceholder]);
    setInput("");
    setLoading(true);

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    // Track partial assistant state that the stream updates as it arrives
    let buffer = "";
    const state: {
      content: string;
      id?: string;
      context?: ContextInfo;
      memory_extracted?: number;
      memory_reconciled?: {
        added: number;
        updated: number;
        conflicts: number;
        duplicates?: number;
      };
      timing?: PipelineTiming;
    } = { content: "" };

    const updateAssistant = () => {
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = {
            ...last,
            id: state.id ?? last.id,
            content: state.content,
            context: state.context ?? last.context,
            memory_extracted: state.memory_extracted ?? last.memory_extracted,
            memory_reconciled: state.memory_reconciled ?? last.memory_reconciled,
            timing: state.timing ?? last.timing,
          };
        }
        return next;
      });
    };

    const handleEvent = (event: string, data: any) => {
      if (event === "conversation") {
        if (data.conversation_id) setConversationId(data.conversation_id);
      } else if (event === "memory") {
        state.memory_extracted = data.extracted;
        state.memory_reconciled = {
          added: data.added,
          updated: data.updated,
          conflicts: data.conflicts,
          duplicates: data.duplicates,
        };
        updateAssistant();
      } else if (event === "context") {
        state.context = {
          context_text: data.context_text,
          included_count: data.included_count,
          omitted_count: data.omitted_count,
        };
        updateAssistant();
      } else if (event === "delta") {
        state.content += data.text;
        updateAssistant();
      } else if (event === "done") {
        if (data.assistant_message) {
          state.id = data.assistant_message.id;
          if (data.assistant_message.content) {
            state.content = data.assistant_message.content;
          }
        }
        if (data.timing) {
          state.timing = data.timing;
        }
        updateAssistant();
      } else if (event === "error") {
        state.content = `Error: ${data.error}`;
        updateAssistant();
      }
    };

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          provider: selectedProvider,
          conversation_id: conversationId || undefined,
          trip_id: selectedTripId || undefined,
        }),
      });

      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Request failed with status ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by \n\n
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const lines = part.split("\n");
          let eventName = "message";
          let dataLine = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventName = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              dataLine += line.slice(6);
            }
          }
          if (dataLine) {
            try {
              const parsed = JSON.parse(dataLine);
              handleEvent(eventName, parsed);
            } catch {
              // ignore malformed event
            }
          }
        }
      }

      fetchConversations();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Something went wrong";
      state.content = `Error: ${errorMsg}`;
      updateAssistant();
    } finally {
      setLoading(false);
    }
  }

  function toggleContext(index: number) {
    setExpandedContexts((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function handleTextareaInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }

  function formatTime(iso: string) {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function formatRelative(iso: string) {
    try {
      const date = new Date(iso.replace(" ", "T") + "Z");
      const diff = Date.now() - date.getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      const days = Math.floor(hrs / 24);
      if (days < 7) return `${days}d ago`;
      return date.toLocaleDateString();
    } catch {
      return "";
    }
  }

  if (providersLoading) {
    return (
      <div className="chat-page">
        <div className="chat-header">
          <h2>Chat</h2>
        </div>
        <div className="chat-messages-empty">Loading...</div>
      </div>
    );
  }

  const hasProviders = providers.length > 0;

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        <button className="new-chat-btn" onClick={startNewConversation}>
          + New chat
        </button>
        <div className="conversation-list">
          {conversations.length === 0 && (
            <div className="conversation-empty">No conversations yet.</div>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`conversation-item ${conversationId === c.id ? "active" : ""}`}
              onClick={() => openConversation(c.id)}
            >
              <div className="conversation-title">{c.title || "Untitled"}</div>
              <div className="conversation-meta">
                <span>{formatRelative(c.updated_at)}</span>
                <span>{c.message_count} msgs</span>
              </div>
              <button
                className="conversation-delete"
                onClick={(e) => deleteConversation(c.id, e)}
                title="Delete conversation"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="chat-page">
        <div className="chat-header">
          <h2>Chat</h2>
          {hasProviders && (
            <div className="chat-header-controls">
              {trips.length > 0 && (
                <div className="provider-select">
                  <label>Trip</label>
                  <select
                    value={selectedTripId}
                    onChange={(e) => setSelectedTripId(e.target.value)}
                    disabled={loading || (messages.length > 0 && !!conversationId)}
                    title={
                      messages.length > 0 && conversationId
                        ? "Trip is locked after the conversation starts"
                        : "Scope this chat to a trip"
                    }
                  >
                    <option value="">No trip (global)</option>
                    {trips.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="provider-select">
                <label>Provider</label>
                <select
                  value={selectedProvider}
                  onChange={(e) => setSelectedProvider(e.target.value)}
                  disabled={loading}
                >
                  {providers.map((p) => (
                    <option key={p.provider} value={p.provider}>
                      {p.provider}
                      {p.is_default ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        {!hasProviders && (
          <div className="no-providers-banner">
            <p>No providers configured. Add an API key to start chatting.</p>
            <Link to="/settings">Go to Settings</Link>
          </div>
        )}

        {hasProviders && (
          <>
            <div className="chat-messages">
              {messages.length === 0 && !loading && (
                <div className="chat-messages-empty">
                  Send a message to start a conversation.
                </div>
              )}

              {messages.map((msg, i) => (
                <div key={i} className={`message ${msg.role}`}>
                  <div className="message-bubble">{msg.content}</div>
                  <div className="message-meta">
                    <span>{formatTime(msg.timestamp)}</span>
                    {msg.provider && <span className="provider-badge">{msg.provider}</span>}
                    {msg.role === "assistant" && msg.context && (
                      <button
                        className="context-toggle-btn"
                        onClick={() => toggleContext(i)}
                      >
                        {expandedContexts.has(i) ? "Hide context" : "View context"}
                      </button>
                    )}
                  </div>
                  {msg.role === "assistant" &&
                    (msg.memory_extracted != null || msg.memory_reconciled) && (
                      <div className="memory-badges">
                        {msg.memory_extracted != null && msg.memory_extracted > 0 && (
                          <span className="memory-badge">
                            {msg.memory_extracted} memory extracted
                          </span>
                        )}
                        {msg.memory_reconciled && msg.memory_reconciled.added > 0 && (
                          <span className="memory-badge">
                            {msg.memory_reconciled.added} added
                          </span>
                        )}
                        {msg.memory_reconciled && msg.memory_reconciled.updated > 0 && (
                          <span className="memory-badge">
                            {msg.memory_reconciled.updated} updated
                          </span>
                        )}
                        {msg.memory_reconciled &&
                          msg.memory_reconciled.duplicates != null &&
                          msg.memory_reconciled.duplicates > 0 && (
                            <span className="memory-badge">
                              {msg.memory_reconciled.duplicates} re-confirmed
                            </span>
                          )}
                      </div>
                    )}
                  {msg.role === "assistant" && msg.timing && (
                      <div className="timing-bar">
                        {msg.timing.stages.map((s) => (
                          <span
                            key={s.stage}
                            className="timing-stage"
                            title={`${s.stage}: ${s.duration_ms}ms`}
                          >
                            {s.stage.replace(/_/g, " ")} {s.duration_ms}ms
                          </span>
                        ))}
                        <span className="timing-total">
                          Total: {msg.timing.total_ms}ms
                        </span>
                      </div>
                    )}
                  {expandedContexts.has(i) && msg.context && (
                    <div className="context-panel">
                      <div className="context-stats">
                        {msg.context.included_count} memories included
                        {msg.context.omitted_count > 0 &&
                          `, ${msg.context.omitted_count} omitted`}
                      </div>
                      {msg.context.context_text || "(no context)"}
                    </div>
                  )}
                </div>
              ))}

              {loading && (
                <div className="loading-indicator">
                  <div className="loading-dot" />
                  <div className="loading-dot" />
                  <div className="loading-dot" />
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            <div className="chat-input-area">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleTextareaInput}
                onKeyDown={handleKeyDown}
                placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
                rows={1}
                disabled={loading}
              />
              <button
                className="chat-send-btn"
                onClick={sendMessage}
                disabled={loading || !input.trim()}
              >
                {loading ? "Sending..." : "Send"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default Chat;
