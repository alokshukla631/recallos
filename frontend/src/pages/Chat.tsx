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

interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  provider?: string;
  timestamp: string;
  context?: ContextInfo;
  memory_extracted?: number;
  memory_reconciled?: { added: number; updated: number; conflicts: number };
}

interface Conversation {
  id: string;
  title: string | null;
  trip_id: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
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
    } catch {
      // ignore
    }
  }

  function startNewConversation() {
    setMessages([]);
    setConversationId(null);
    setExpandedContexts(new Set());
    setInput("");
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

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          provider: selectedProvider,
          conversation_id: conversationId || undefined,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Request failed with status ${res.status}`);
      }

      const data = await res.json();

      if (data.conversation_id) {
        setConversationId(data.conversation_id);
      }

      const assistantMessage: Message = {
        id: data.assistant_message?.id,
        role: "assistant",
        content: data.assistant_message?.content || "",
        provider: selectedProvider,
        timestamp: new Date().toISOString(),
        context: data.context,
        memory_extracted: data.memory_extracted,
        memory_reconciled: data.memory_reconciled,
      };

      setMessages((prev) => [...prev, assistantMessage]);
      fetchConversations();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Something went wrong";
      const errorMessage: Message = {
        role: "assistant",
        content: `Error: ${errorMsg}`,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
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
