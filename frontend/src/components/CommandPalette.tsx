import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import "./CommandPalette.css";

const TYPE_COLORS: Record<string, string> = {
  preference: "#3b82f6",
  constraint: "#ef4444",
  fact: "#22c55e",
  goal: "#a855f7",
  override: "#f97316",
};

interface CommandItem {
  id: string;
  label: string;
  shortcut?: string;
  category: string;
  action: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

function CommandPalette({ open, onClose }: Props) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<"commands" | "add-memory" | "search">("commands");
  const [memoryText, setMemoryText] = useState("");
  const [addingMemory, setAddingMemory] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<string | null>(null);
  const [bulkStatus, setBulkStatus] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ memory: any[]; conversations: any[]; projects: any[] }>({ memory: [], conversations: [], projects: [] });
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const memoryInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  async function quickAddMemory() {
    const text = memoryText.trim();
    if (!text || addingMemory) return;
    setAddingMemory(true);
    setMemoryStatus(null);
    try {
      const res = await fetch("/api/memory/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statements: [text] }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const count = data.added || data.extracted || 0;
      setMemoryStatus(count > 0 ? `Extracted ${count} memory item(s)` : "Processed (may be duplicate)");
      setMemoryText("");
      setTimeout(() => {
        setMode("commands");
        setMemoryStatus(null);
        onClose();
      }, 1200);
    } catch {
      setMemoryStatus("Failed to add memory");
    } finally {
      setAddingMemory(false);
    }
  }

  function handleSearchInput(value: string) {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (value.trim().length < 2) {
      setSearchResults({ memory: [], conversations: [], projects: [] });
      return;
    }
    setSearchLoading(true);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(value.trim())}`);
        if (res.ok) setSearchResults(await res.json());
      } catch { /* ignore */ }
      setSearchLoading(false);
    }, 300);
  }

  async function runBulkAction(action: string, label: string) {
    setBulkStatus(`Running ${label}...`);
    try {
      if (action === "scrape") {
        const res = await fetch("/api/scraper/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        if (!res.ok) throw new Error("Failed");
        const data = await res.json();
        const total = data.results?.reduce((s: number, r: any) => s + (r.memoryExtracted || 0), 0) || 0;
        setBulkStatus(`Scraper done: ${total} memories extracted`);
      } else if (action === "decay-preview") {
        const res = await fetch("/api/memory/decay");
        if (!res.ok) throw new Error("Failed");
        const data = await res.json();
        setBulkStatus(`${data.count} item(s) would be marked stale`);
      } else if (action === "session-cleanup") {
        const res = await fetch("/api/memory/session/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ttl_hours: 24 }) });
        if (!res.ok) throw new Error("Failed");
        const data = await res.json();
        setBulkStatus(`Expired ${data.expired_count} session items`);
      } else if (action === "export-json") {
        const res = await fetch("/api/passport/export");
        if (!res.ok) throw new Error("Failed");
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `recallos-export-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        setBulkStatus("Memory exported to JSON");
      } else if (action === "export-md") {
        const res = await fetch("/api/passport/export/markdown");
        if (!res.ok) throw new Error("Failed");
        const text = await res.text();
        const blob = new Blob([text], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `recallos-memory-${new Date().toISOString().slice(0, 10)}.md`;
        a.click();
        URL.revokeObjectURL(url);
        setBulkStatus("Memory exported to Markdown");
      }
      setTimeout(() => { setBulkStatus(null); onClose(); }, 1500);
    } catch {
      setBulkStatus(`${label} failed`);
      setTimeout(() => setBulkStatus(null), 2000);
    }
  }

  const commands: CommandItem[] = [
    // Navigation
    { id: "nav-dashboard", label: "Go to Dashboard", shortcut: "Ctrl+1", category: "Navigation", action: () => navigate("/") },
    { id: "nav-chat", label: "Go to Chat", shortcut: "Ctrl+2", category: "Navigation", action: () => navigate("/chat") },
    { id: "nav-memory", label: "Go to Memory", shortcut: "Ctrl+3", category: "Navigation", action: () => navigate("/memory") },
    { id: "nav-projects", label: "Go to Projects", category: "Navigation", action: () => navigate("/projects") },
    { id: "nav-timeline", label: "Go to Timeline", shortcut: "Ctrl+4", category: "Navigation", action: () => navigate("/timeline") },
    { id: "nav-graph", label: "Go to Graph", category: "Navigation", action: () => navigate("/graph") },
    { id: "nav-links", label: "Go to Links", category: "Navigation", action: () => navigate("/links") },
    { id: "nav-analytics", label: "Go to Analytics", category: "Navigation", action: () => navigate("/analytics") },
    { id: "nav-health", label: "Go to Health", category: "Navigation", action: () => navigate("/health") },
    { id: "nav-trash", label: "Go to Trash", category: "Navigation", action: () => navigate("/trash") },
    { id: "nav-debug", label: "Go to Context Debug", category: "Navigation", action: () => navigate("/debug") },
    { id: "nav-settings", label: "Go to Settings", shortcut: "Ctrl+5", category: "Navigation", action: () => navigate("/settings") },
    { id: "nav-scraper", label: "Go to Scraper", category: "Navigation", action: () => navigate("/scraper") },

    // Actions
    { id: "act-add-memory", label: "Quick add memory", category: "Actions", action: () => {
      setMode("add-memory");
      setTimeout(() => memoryInputRef.current?.focus(), 50);
    }},
    { id: "act-new-chat", label: "Start new conversation", category: "Actions", action: () => {
      navigate("/chat?new=1");
      onClose();
    }},
    { id: "act-search", label: "Search memory", category: "Actions", action: () => { navigate("/memory"); onClose(); } },
    { id: "act-global-search", label: "Search everything", category: "Actions", action: () => {
      setMode("search");
      setSearchQuery("");
      setSearchResults({ memory: [], conversations: [], projects: [] });
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }},
    { id: "act-export-json", label: "Export memory (JSON)", category: "Actions", action: () => { window.open("/api/passport/export", "_blank"); } },
    { id: "act-export-md", label: "Export memory (Markdown)", category: "Actions", action: () => { window.open("/api/passport/export/markdown", "_blank"); } },
    { id: "act-health-check", label: "Run health check", category: "Actions", action: () => navigate("/health") },
    { id: "act-scrape", label: "Run log scraper", category: "Actions", action: () => navigate("/scraper") },
    { id: "act-docs", label: "View API docs", category: "Actions", action: () => { window.open("/api/docs", "_blank"); } },
    { id: "act-shortcuts", label: "Show keyboard shortcuts", shortcut: "?", category: "Actions", action: () => {
      onClose();
      window.dispatchEvent(new CustomEvent("recallos:show-shortcuts"));
    }},

    // Bulk actions
    { id: "bulk-scrape", label: "Scrape all log sources now", category: "Bulk Actions", action: () => runBulkAction("scrape", "scraper") },
    { id: "bulk-decay", label: "Preview decay candidates", category: "Bulk Actions", action: () => runBulkAction("decay-preview", "decay preview") },
    { id: "bulk-session", label: "Clean up expired sessions", category: "Bulk Actions", action: () => runBulkAction("session-cleanup", "session cleanup") },
    { id: "bulk-export-json", label: "Download memory as JSON", category: "Bulk Actions", action: () => runBulkAction("export-json", "export") },
    { id: "bulk-export-md", label: "Download memory as Markdown", category: "Bulk Actions", action: () => runBulkAction("export-md", "export") },

    // Theme
    { id: "theme-toggle", label: "Toggle dark/light theme", shortcut: "Ctrl+T", category: "Theme", action: () => {
      const current = document.documentElement.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("recallos-theme", next);
    }},
  ];

  const filtered = query.trim()
    ? commands.filter((c) =>
        c.label.toLowerCase().includes(query.toLowerCase()) ||
        c.category.toLowerCase().includes(query.toLowerCase())
      )
    : commands;

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setMode("commands");
      setMemoryText("");
      setMemoryStatus(null);
      setSearchQuery("");
      setSearchResults({ memory: [], conversations: [], projects: [] });
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement;
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const runCommand = useCallback((cmd: CommandItem) => {
    cmd.action();
    onClose();
  }, [onClose]);

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[selectedIndex]) runCommand(filtered[selectedIndex]);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  }

  if (!open) return null;

  if (mode === "add-memory") {
    return (
      <div className="palette-overlay" onClick={onClose}>
        <div className="palette-container" onClick={(e) => e.stopPropagation()}>
          <div className="palette-add-memory-header">
            <button className="palette-back" onClick={() => setMode("commands")}>Back</button>
            <span className="palette-add-memory-title">Quick Add Memory</span>
          </div>
          <input
            ref={memoryInputRef}
            className="palette-input"
            type="text"
            placeholder="e.g. I prefer window seats on flights"
            value={memoryText}
            onChange={(e) => setMemoryText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") quickAddMemory();
              if (e.key === "Escape") onClose();
            }}
          />
          <div className="palette-add-memory-body">
            <p className="palette-add-memory-hint">
              Type a natural language statement. RecallOS will extract the memory type,
              scope, and domain automatically.
            </p>
            {memoryStatus && (
              <p className={`palette-add-memory-status ${memoryStatus.startsWith("Failed") ? "error" : "success"}`}>
                {memoryStatus}
              </p>
            )}
            <button
              className="palette-add-memory-btn"
              onClick={quickAddMemory}
              disabled={!memoryText.trim() || addingMemory}
            >
              {addingMemory ? "Adding..." : "Add Memory"}
            </button>
          </div>
          <div className="palette-footer">
            <span><kbd>Enter</kbd> to add</span>
            <span><kbd>Esc</kbd> to close</span>
          </div>
        </div>
      </div>
    );
  }

  if (mode === "search") {
    const hasResults = searchResults.memory.length > 0 || searchResults.conversations.length > 0 || searchResults.projects.length > 0;
    return (
      <div className="palette-overlay" onClick={onClose}>
        <div className="palette-container palette-search-container" onClick={(e) => e.stopPropagation()}>
          <div className="palette-add-memory-header">
            <button className="palette-back" onClick={() => setMode("commands")}>Back</button>
            <span className="palette-add-memory-title">Search Everything</span>
          </div>
          <input
            ref={searchInputRef}
            className="palette-input"
            type="text"
            placeholder="Search memory, conversations, projects..."
            value={searchQuery}
            onChange={(e) => handleSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
          />
          <div className="palette-list">
            {searchLoading && <div className="palette-empty">Searching...</div>}
            {!searchLoading && searchQuery.length >= 2 && !hasResults && (
              <div className="palette-empty">No results found</div>
            )}
            {!searchLoading && searchQuery.length < 2 && (
              <div className="palette-empty">Type at least 2 characters to search</div>
            )}

            {searchResults.memory.length > 0 && (
              <>
                <div className="palette-category">Memory ({searchResults.memory.length})</div>
                {searchResults.memory.map((item: any) => (
                  <div
                    key={item.id}
                    className="palette-item"
                    onClick={() => { navigate("/memory"); onClose(); }}
                  >
                    <span className="palette-item-label">
                      <span className="search-type-badge" style={{ background: TYPE_COLORS[item.type] || "#6b7280" }}>{item.type}</span>
                      {" "}{item.key}: {item.value.slice(0, 60)}
                    </span>
                    <span className="palette-item-shortcut">{Math.round(item.confidence * 100)}%</span>
                  </div>
                ))}
              </>
            )}

            {searchResults.conversations.length > 0 && (
              <>
                <div className="palette-category">Conversations ({searchResults.conversations.length})</div>
                {searchResults.conversations.map((conv: any) => (
                  <div
                    key={conv.id}
                    className="palette-item"
                    onClick={() => { navigate("/chat"); onClose(); }}
                  >
                    <span className="palette-item-label">
                      {conv.provider} - {conv.message_count} messages
                    </span>
                    <span className="palette-item-shortcut">{new Date(conv.created_at).toLocaleDateString()}</span>
                  </div>
                ))}
              </>
            )}

            {searchResults.projects.length > 0 && (
              <>
                <div className="palette-category">Projects ({searchResults.projects.length})</div>
                {searchResults.projects.map((project: any) => (
                  <div
                    key={project.id}
                    className="palette-item"
                    onClick={() => { navigate("/projects"); onClose(); }}
                  >
                    <span className="palette-item-label">
                      {project.name}{project.description ? ` - ${project.description}` : ""}
                    </span>
                    <span className="palette-item-shortcut">[{project.status}]</span>
                  </div>
                ))}
              </>
            )}
          </div>
          <div className="palette-footer">
            <span><kbd>Esc</kbd> to close</span>
          </div>
        </div>
      </div>
    );
  }

  // Group by category
  const categories = new Map<string, CommandItem[]>();
  for (const cmd of filtered) {
    const list = categories.get(cmd.category) || [];
    list.push(cmd);
    categories.set(cmd.category, list);
  }

  let flatIndex = 0;

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette-container" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          placeholder="Type a command..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && (
            <div className="palette-empty">No matching commands</div>
          )}
          {[...categories.entries()].map(([category, items]) => (
            <div key={category}>
              <div className="palette-category">{category}</div>
              {items.map((cmd) => {
                const idx = flatIndex++;
                return (
                  <div
                    key={cmd.id}
                    className={`palette-item${idx === selectedIndex ? " selected" : ""}`}
                    onClick={() => runCommand(cmd)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <span className="palette-item-label">{cmd.label}</span>
                    {cmd.shortcut && <span className="palette-item-shortcut">{cmd.shortcut}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {bulkStatus && (
          <div className="palette-bulk-status">{bulkStatus}</div>
        )}
        <div className="palette-footer">
          <span><kbd>Enter</kbd> to run</span>
          <span><kbd>Esc</kbd> to close</span>
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
