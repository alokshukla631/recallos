import { useState, useEffect, useRef } from "react";
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
  memory_extracted?: boolean;
  memory_reconciled?: boolean;
}

function Chat() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [expandedContexts, setExpandedContexts] = useState<Set<number>>(
    new Set()
  );
  const [providersLoading, setProvidersLoading] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetchProviders();
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

    // Reset textarea height
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
        throw new Error(
          errData.error || `Request failed with status ${res.status}`
        );
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
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error ? err.message : "Something went wrong";
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
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
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
    // Auto-resize
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }

  function formatTime(iso: string) {
    try {
      return new Date(iso).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
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
                  {msg.provider && (
                    <span className="provider-badge">{msg.provider}</span>
                  )}
                  {msg.role === "assistant" && msg.context && (
                    <button
                      className="context-toggle-btn"
                      onClick={() => toggleContext(i)}
                    >
                      {expandedContexts.has(i)
                        ? "Hide context"
                        : "View context"}
                    </button>
                  )}
                </div>
                {msg.role === "assistant" &&
                  (msg.memory_extracted || msg.memory_reconciled) && (
                    <div className="memory-badges">
                      {msg.memory_extracted && (
                        <span className="memory-badge">Memory extracted</span>
                      )}
                      {msg.memory_reconciled && (
                        <span className="memory-badge">Memory reconciled</span>
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
  );
}

export default Chat;
