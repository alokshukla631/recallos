import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import "./CommandPalette.css";

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
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands: CommandItem[] = [
    // Navigation
    { id: "nav-dashboard", label: "Go to Dashboard", shortcut: "Ctrl+1", category: "Navigation", action: () => navigate("/") },
    { id: "nav-chat", label: "Go to Chat", shortcut: "Ctrl+2", category: "Navigation", action: () => navigate("/chat") },
    { id: "nav-memory", label: "Go to Memory", shortcut: "Ctrl+3", category: "Navigation", action: () => navigate("/memory") },
    { id: "nav-trips", label: "Go to Trips", category: "Navigation", action: () => navigate("/trips") },
    { id: "nav-timeline", label: "Go to Timeline", shortcut: "Ctrl+4", category: "Navigation", action: () => navigate("/timeline") },
    { id: "nav-graph", label: "Go to Graph", category: "Navigation", action: () => navigate("/graph") },
    { id: "nav-links", label: "Go to Links", category: "Navigation", action: () => navigate("/links") },
    { id: "nav-health", label: "Go to Health", category: "Navigation", action: () => navigate("/health") },
    { id: "nav-debug", label: "Go to Context Debug", category: "Navigation", action: () => navigate("/debug") },
    { id: "nav-settings", label: "Go to Settings", shortcut: "Ctrl+5", category: "Navigation", action: () => navigate("/settings") },
    { id: "nav-scraper", label: "Go to Scraper", category: "Navigation", action: () => navigate("/scraper") },

    // Actions
    { id: "act-search", label: "Search memory", category: "Actions", action: () => { navigate("/memory"); onClose(); } },
    { id: "act-export-json", label: "Export memory (JSON)", category: "Actions", action: () => { window.open("/api/passport/export", "_blank"); } },
    { id: "act-export-csv", label: "Export memory (CSV)", category: "Actions", action: () => { window.open("/api/passport/export/csv", "_blank"); } },
    { id: "act-health-check", label: "Run health check", category: "Actions", action: () => navigate("/health") },
    { id: "act-docs", label: "View API docs", category: "Actions", action: () => { window.open("/api/docs", "_blank"); } },

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
        <div className="palette-footer">
          <span><kbd>Enter</kbd> to run</span>
          <span><kbd>Esc</kbd> to close</span>
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
