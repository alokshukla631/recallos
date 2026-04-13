import React, { useState, useEffect, useCallback, useRef } from "react";
import MemoryDetailModal from "../components/MemoryDetailModal";
import BatchBar from "../components/BatchBar";
import ConflictPanel from "../components/ConflictPanel";
import { useToast } from "../components/Toast";
import "./Memory.css";

interface MemoryItem {
  id: number;
  key: string;
  type: string;
  value: string;
  scope: string;
  domain: string | null;
  confidence: number;
  status: string;
  pinned: number;
  created_at: string;
}

const TYPE_COLORS: Record<string, string> = {
  preference: "#3b82f6",
  constraint: "#ef4444",
  fact: "#22c55e",
  goal: "#a855f7",
  override: "#f97316",
};

const SCOPE_COLORS: Record<string, string> = {
  global: "#6b7280",
  domain: "#8b5cf6",
  trip: "#06b6d4",
  project: "#f59e0b",
  session: "#ec4899",
};

const DOMAIN_COLORS: Record<string, string> = {
  travel: "#06b6d4",
  coding: "#10b981",
  work: "#f59e0b",
  health: "#ef4444",
  finance: "#8b5cf6",
  learning: "#3b82f6",
  writing: "#ec4899",
  personal: "#6b7280",
  communication: "#14b8a6",
};

interface TagInfo {
  tag: string;
  count: number;
}

interface SessionStats {
  active: number;
  stale: number;
  oldest_active: string | null;
}

function Memory() {
  const { toast } = useToast();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("recallos-search-history");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [showHistory, setShowHistory] = useState(false);

  // Filters
  const [statusFilter, setStatusFilter] = useState("active");
  const [typeFilter, setTypeFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [tagFilteredIds, setTagFilteredIds] = useState<Set<number> | null>(null);
  const [scopeFilter, setScopeFilter] = useState("all");

  // Edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");

  // Tags
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const [itemTags, setItemTags] = useState<Record<string, string[]>>({});
  const [tagInput, setTagInput] = useState<Record<string, string>>({});
  const [expandedTags, setExpandedTags] = useState<Set<number>>(new Set());

  // Importance
  const [topMemories, setTopMemories] = useState<Array<{ id: string; key: string; value: string; importance: number }>>([]);

  // Detail modal
  const [detailId, setDetailId] = useState<number | null>(null);

  // Batch selection
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Sorting
  const [sortField, setSortField] = useState<string>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Pagination
  const [page, setPage] = useState(1);
  const pageSize = 25;

  // Import
  const importRef = useRef<HTMLInputElement>(null);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newType, setNewType] = useState("fact");
  const [newScope, setNewScope] = useState("global");
  const [newDomain, setNewDomain] = useState("");
  const [creating, setCreating] = useState(false);

  // Session stats
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);

  const fetchMemories = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter !== "all") params.set("type", typeFilter);
      if (scopeFilter !== "all") params.set("scope", scopeFilter);

      const res = await fetch(`/api/memory?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
      setPage(1);
    } catch (err: any) {
      setError(err.message || "Failed to fetch memories");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter, scopeFilter]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      fetchMemories();
    }
  }, [fetchMemories, searchQuery]);

  useEffect(() => {
    fetchSessionStats();
    fetchAllTags();
    fetchTopMemories();
  }, []);

  async function fetchSessionStats() {
    try {
      const res = await fetch("/api/memory/session/stats");
      if (!res.ok) return;
      setSessionStats(await res.json());
    } catch {
      // ignore
    }
  }

  async function fetchTopMemories() {
    try {
      const res = await fetch("/api/memory/importance?limit=5");
      if (!res.ok) return;
      setTopMemories(await res.json());
    } catch {
      // ignore
    }
  }

  async function fetchAllTags() {
    try {
      const res = await fetch("/api/memory/tags");
      if (!res.ok) return;
      setAllTags(await res.json());
    } catch {
      // ignore
    }
  }

  async function fetchTagsForItem(id: number) {
    try {
      const res = await fetch(`/api/memory/${id}/tags`);
      if (!res.ok) return;
      const tags: Array<{ tag: string }> = await res.json();
      setItemTags((prev) => ({ ...prev, [id]: tags.map((t) => t.tag) }));
    } catch {
      // ignore
    }
  }

  async function addTagToItem(id: number) {
    const tag = (tagInput[id] || "").trim().toLowerCase();
    if (!tag) return;
    try {
      await fetch(`/api/memory/${id}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag }),
      });
      setTagInput((prev) => ({ ...prev, [id]: "" }));
      fetchTagsForItem(id);
      fetchAllTags();
    } catch {
      // ignore
    }
  }

  async function removeTagFromItem(id: number, tag: string) {
    try {
      await fetch(`/api/memory/${id}/tags/${encodeURIComponent(tag)}`, { method: "DELETE" });
      fetchTagsForItem(id);
      fetchAllTags();
    } catch {
      // ignore
    }
  }

  function toggleTagsPanel(id: number) {
    setExpandedTags((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        if (!itemTags[id]) fetchTagsForItem(id);
      }
      return next;
    });
  }

  async function handleCleanup() {
    setCleaningUp(true);
    setCleanupResult(null);
    try {
      const res = await fetch("/api/memory/session/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttl_hours: 24 }),
      });
      if (!res.ok) throw new Error("Cleanup failed");
      const data = await res.json();
      setCleanupResult(`Expired ${data.expired_count} session items`);
      fetchSessionStats();
      fetchMemories();
    } catch {
      setCleanupResult("Cleanup failed");
    } finally {
      setCleaningUp(false);
    }
  }

  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q) {
      fetchMemories();
      return;
    }
    setSearching(true);
    setError(null);
    setShowHistory(false);
    try {
      const res = await fetch(`/api/memory/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
      // Save to search history (max 10, no duplicates)
      setSearchHistory((prev) => {
        const next = [q, ...prev.filter((h) => h !== q)].slice(0, 10);
        localStorage.setItem("recallos-search-history", JSON.stringify(next));
        return next;
      });
    } catch (err: any) {
      setError(err.message || "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const handleEdit = (item: MemoryItem) => {
    setEditingId(item.id);
    setEditValue(item.value);
  };

  const handleSaveEdit = async (id: number) => {
    try {
      const res = await fetch(`/api/memory/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: editValue }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditingId(null);
      toast("Memory updated", "success");
      fetchMemories();
    } catch (err: any) {
      toast(err.message || "Failed to update", "error");
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const res = await fetch(`/api/memory/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast("Memory deleted", "success");
      fetchMemories();
    } catch (err: any) {
      toast(err.message || "Failed to delete", "error");
    }
  };

  const handleReconfirm = async (id: number) => {
    try {
      const res = await fetch(`/api/memory/${id}/reconfirm`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast("Memory reconfirmed", "success");
      fetchMemories();
    } catch (err: any) {
      toast(err.message || "Failed to reconfirm", "error");
    }
  };

  const handleCreate = async () => {
    if (!newKey.trim() || !newValue.trim()) {
      toast("Key and value are required", "warning");
      return;
    }
    setCreating(true);
    try {
      const body: Record<string, string> = {
        key: newKey.trim(),
        value: newValue.trim(),
        type: newType,
        scope: newScope,
      };
      if (newDomain.trim()) body.domain = newDomain.trim();
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      toast(`Created "${newKey.trim()}"`, "success");
      setNewKey("");
      setNewValue("");
      setNewType("fact");
      setNewScope("global");
      setNewDomain("");
      setShowCreate(false);
      fetchMemories();
    } catch (err: any) {
      toast(err.message || "Failed to create", "error");
    } finally {
      setCreating(false);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const items = Array.isArray(data) ? data : data.items || [data];
      const res = await fetch("/api/memory/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const result = await res.json();
      toast(`Imported ${result.imported} items (${result.skipped} skipped)`, "success");
      fetchMemories();
    } catch (err: any) {
      toast(err.message || "Import failed", "error");
    }
    // Reset input so the same file can be re-imported
    if (importRef.current) importRef.current.value = "";
  };

  const handleTogglePin = async (id: number, currentlyPinned: boolean) => {
    try {
      const endpoint = currentlyPinned ? "unpin" : "pin";
      const res = await fetch(`/api/memory/${id}/${endpoint}`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast(currentlyPinned ? "Memory unpinned" : "Memory pinned", "success");
      fetchMemories();
    } catch (err: any) {
      toast(err.message || "Failed to toggle pin", "error");
    }
  };

  // Batch selection handlers
  const lastClickedIndex = useRef<number | null>(null);

  const toggleSelect = (id: string, index: number, shiftKey: boolean) => {
    if (shiftKey && lastClickedIndex.current !== null) {
      // Range select: select everything between last clicked and current
      const start = Math.min(lastClickedIndex.current, index);
      const end = Math.max(lastClickedIndex.current, index);
      const rangeIds = items.slice(start, end + 1).map((i) => String(i.id));
      setSelectedIds((prev) => {
        const set = new Set(prev);
        for (const rid of rangeIds) set.add(rid);
        return Array.from(set);
      });
    } else {
      setSelectedIds((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      );
    }
    lastClickedIndex.current = index;
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === items.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(items.map((i) => String(i.id)));
    }
  };

  // Tag filter: fetch items with the selected tag
  useEffect(() => {
    if (tagFilter === "all") {
      setTagFilteredIds(null);
      return;
    }
    async function fetchTaggedItems() {
      try {
        // Get all items, check each for the tag
        // A simpler approach: scan the current items and fetch their tags
        const ids = new Set<number>();
        for (const item of items) {
          const res = await fetch(`/api/memory/${item.id}/tags`);
          if (!res.ok) continue;
          const tags: Array<{ tag: string }> = await res.json();
          if (tags.some((t) => t.tag === tagFilter)) ids.add(item.id);
        }
        setTagFilteredIds(ids);
      } catch {
        setTagFilteredIds(null);
      }
    }
    fetchTaggedItems();
  }, [tagFilter, items]);

  // Escape key clears selection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedIds.length > 0 && !detailId) {
        setSelectedIds([]);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIds.length, detailId]);

  // Sort handler
  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  // Apply tag filter
  const filteredItems = tagFilteredIds
    ? items.filter((i) => tagFilteredIds.has(i.id))
    : items;

  // Sort items
  const sortedItems = [...filteredItems].sort((a, b) => {
    let aVal: any = (a as any)[sortField];
    let bVal: any = (b as any)[sortField];
    if (sortField === "confidence") {
      aVal = aVal ?? 0;
      bVal = bVal ?? 0;
    }
    if (typeof aVal === "string") aVal = aVal.toLowerCase();
    if (typeof bVal === "string") bVal = bVal.toLowerCase();
    if (aVal < bVal) return sortDir === "asc" ? -1 : 1;
    if (aVal > bVal) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sortedItems.length / pageSize));
  const pagedItems = sortedItems.slice((page - 1) * pageSize, page * pageSize);

  // Stats
  const totalActive = filteredItems.filter((i) => i.status === "active").length;
  const byType: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  const byDomain: Record<string, number> = {};
  for (const item of filteredItems) {
    byType[item.type] = (byType[item.type] || 0) + 1;
    byScope[item.scope] = (byScope[item.scope] || 0) + 1;
    if (item.domain) {
      byDomain[item.domain] = (byDomain[item.domain] || 0) + 1;
    }
  }

  return (
    <div className="page memory-page">
      <h2>Memory</h2>
      <p>Browse and manage stored memory items across all domains.</p>

      {/* Stats summary */}
      <div className="memory-stats">
        <div className="stat-card">
          <span className="stat-value">{filteredItems.length}</span>
          <span className="stat-label">Total shown</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{totalActive}</span>
          <span className="stat-label">Active</span>
        </div>
        {Object.entries(byType).map(([type, count]) => (
          <div className="stat-card" key={type}>
            <span
              className="stat-value"
              style={{ color: TYPE_COLORS[type] || "var(--color-text)" }}
            >
              {count}
            </span>
            <span className="stat-label">{type}</span>
          </div>
        ))}
      </div>

      {/* Domain breakdown */}
      {Object.keys(byDomain).length > 0 && (
        <div className="memory-stats domain-stats">
          {Object.entries(byDomain)
            .sort((a, b) => b[1] - a[1])
            .map(([domain, count]) => (
              <div className="stat-card" key={domain}>
                <span
                  className="stat-value"
                  style={{ color: DOMAIN_COLORS[domain] || "var(--color-text)" }}
                >
                  {count}
                </span>
                <span className="stat-label">{domain}</span>
              </div>
            ))}
        </div>
      )}

      {/* Create button + form */}
      <div className="create-section">
        <button className="btn btn-primary create-toggle" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? "Cancel" : "+ New Memory"}
        </button>
        <button className="btn btn-secondary create-toggle" onClick={() => importRef.current?.click()}>
          Import JSON
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".json"
          style={{ display: "none" }}
          onChange={handleImport}
        />
        {showCreate && (
          <div className="create-form">
            <div className="create-form-row">
              <label>
                Key
                <input
                  type="text"
                  placeholder="e.g. hotel_preference"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                />
              </label>
              <label>
                Type
                <select value={newType} onChange={(e) => setNewType(e.target.value)}>
                  <option value="fact">Fact</option>
                  <option value="preference">Preference</option>
                  <option value="constraint">Constraint</option>
                  <option value="goal">Goal</option>
                  <option value="override">Override</option>
                </select>
              </label>
              <label>
                Scope
                <select value={newScope} onChange={(e) => setNewScope(e.target.value)}>
                  <option value="global">Global</option>
                  <option value="domain">Domain</option>
                  <option value="project">Project</option>
                  <option value="trip">Trip</option>
                  <option value="session">Session</option>
                </select>
              </label>
              <label>
                Domain
                <input
                  type="text"
                  placeholder="optional"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                />
              </label>
            </div>
            <div className="create-form-value">
              <textarea
                placeholder="What should be remembered?"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                rows={2}
              />
            </div>
            <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>
              {creating ? "Creating..." : "Create Memory"}
            </button>
          </div>
        )}
      </div>

      {/* Conflict panel */}
      <ConflictPanel onResolved={() => fetchMemories()} />

      {/* Top memories by importance */}
      {topMemories.length > 0 && (
        <div className="top-memories">
          <span className="top-memories-label">Most important:</span>
          {topMemories.map((m) => (
            <span key={m.id} className="top-memory-chip" title={m.value}>
              {m.key} <span className="importance-score">{m.importance}</span>
            </span>
          ))}
        </div>
      )}

      {/* Search bar */}
      <div className="memory-search">
        <div className="search-input-wrapper">
          <input
            type="text"
            placeholder="Search memory (e.g. 'hotel preference', 'React framework')..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (!e.target.value.trim()) fetchMemories();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch();
            }}
            onFocus={() => { if (searchHistory.length > 0 && !searchQuery.trim()) setShowHistory(true); }}
            onBlur={() => { setTimeout(() => setShowHistory(false), 150); }}
          />
          {showHistory && searchHistory.length > 0 && (
            <div className="search-history">
              {searchHistory.map((h, i) => (
                <button
                  key={i}
                  className="search-history-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setSearchQuery(h);
                    setShowHistory(false);
                    setTimeout(() => handleSearch(), 0);
                  }}
                >
                  {h}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          className="btn btn-primary"
          onClick={handleSearch}
          disabled={searching || !searchQuery.trim()}
        >
          {searching ? "Searching..." : "Search"}
        </button>
        {searchQuery.trim() && (
          <button
            className="btn btn-secondary"
            onClick={() => {
              setSearchQuery("");
              fetchMemories();
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div className="memory-filters">
        <label>
          Status
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="active">Active</option>
            <option value="stale">Stale</option>
            <option value="superseded">Superseded</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          Type
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="preference">Preference</option>
            <option value="constraint">Constraint</option>
            <option value="fact">Fact</option>
            <option value="goal">Goal</option>
            <option value="override">Override</option>
          </select>
        </label>
        <label>
          Scope
          <select
            value={scopeFilter}
            onChange={(e) => setScopeFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="global">Global</option>
            <option value="domain">Domain</option>
            <option value="trip">Trip</option>
            <option value="project">Project</option>
            <option value="session">Session</option>
          </select>
        </label>
        {allTags.length > 0 && (
          <label>
            Tag
            <select
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
            >
              <option value="all">All</option>
              {allTags.map((t) => (
                <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Tags cloud */}
      {allTags.length > 0 && (
        <div className="tags-cloud">
          <span className="tags-label">Tags:</span>
          {allTags.map((t) => (
            <span
              key={t.tag}
              className={`tag-chip ${tagFilter === t.tag ? "tag-active" : ""}`}
              style={{ cursor: "pointer" }}
              onClick={() => setTagFilter(tagFilter === t.tag ? "all" : t.tag)}
            >
              {t.tag} ({t.count})
            </span>
          ))}
        </div>
      )}

      {/* Error */}
      {error && <div className="memory-error">{error}</div>}

      {/* Loading */}
      {loading && <div className="memory-loading">Loading...</div>}

      {/* Items table */}
      {!loading && items.length === 0 && (
        <div className="memory-empty">No memory items found.</div>
      )}

      {!loading && items.length > 0 && (
        <div className="memory-table-wrapper">
          <table className="memory-table">
            <thead>
              <tr>
                <th className="th-checkbox">
                  <input
                    type="checkbox"
                    className="memory-checkbox"
                    checked={items.length > 0 && selectedIds.length === items.length}
                    onChange={toggleSelectAll}
                    title="Select all"
                  />
                </th>
                <th className="sortable" onClick={() => handleSort("key")}>Key {sortField === "key" ? (sortDir === "asc" ? "\u2191" : "\u2193") : ""}</th>
                <th className="sortable" onClick={() => handleSort("type")}>Type {sortField === "type" ? (sortDir === "asc" ? "\u2191" : "\u2193") : ""}</th>
                <th>Value</th>
                <th className="sortable" onClick={() => handleSort("scope")}>Scope {sortField === "scope" ? (sortDir === "asc" ? "\u2191" : "\u2193") : ""}</th>
                <th className="sortable" onClick={() => handleSort("domain")}>Domain {sortField === "domain" ? (sortDir === "asc" ? "\u2191" : "\u2193") : ""}</th>
                <th className="sortable" onClick={() => handleSort("confidence")}>Confidence {sortField === "confidence" ? (sortDir === "asc" ? "\u2191" : "\u2193") : ""}</th>
                <th className="sortable" onClick={() => handleSort("status")}>Status {sortField === "status" ? (sortDir === "asc" ? "\u2191" : "\u2193") : ""}</th>
                <th className="sortable" onClick={() => handleSort("created_at")}>Created {sortField === "created_at" ? (sortDir === "asc" ? "\u2191" : "\u2193") : ""}</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pagedItems.map((item, idx) => (
                <React.Fragment key={item.id}>
                <tr className={selectedIds.includes(String(item.id)) ? "row-selected" : ""}>
                  <td className="td-checkbox">
                    <input
                      type="checkbox"
                      className="memory-checkbox"
                      checked={selectedIds.includes(String(item.id))}
                      onChange={(e) => toggleSelect(String(item.id), idx, e.nativeEvent instanceof MouseEvent && (e.nativeEvent as MouseEvent).shiftKey)}
                    />
                  </td>
                  <td className="memory-key clickable" onClick={() => setDetailId(item.id)}>{item.pinned ? <span className="pin-indicator" title="Pinned">&#128204;</span> : null}{item.key}</td>
                  <td>
                    <span
                      className="type-badge"
                      style={{
                        backgroundColor:
                          TYPE_COLORS[item.type] || "var(--color-text-muted)",
                      }}
                    >
                      {item.type}
                    </span>
                  </td>
                  <td className="memory-value-cell">
                    {editingId === item.id ? (
                      <div className="inline-edit">
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleSaveEdit(item.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          autoFocus
                        />
                        <button
                          className="btn-save"
                          onClick={() => handleSaveEdit(item.id)}
                        >
                          Save
                        </button>
                        <button
                          className="btn-cancel"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <span className="memory-value">{item.value}</span>
                    )}
                  </td>
                  <td>
                    <span
                      className="scope-badge"
                      style={{
                        backgroundColor: SCOPE_COLORS[item.scope] || "#6b7280",
                      }}
                    >
                      {item.scope}
                    </span>
                  </td>
                  <td>
                    {item.domain ? (
                      <span
                        className="domain-badge"
                        style={{
                          color: DOMAIN_COLORS[item.domain] || "var(--color-text-muted)",
                          borderColor: DOMAIN_COLORS[item.domain] || "var(--color-text-muted)",
                        }}
                      >
                        {item.domain}
                      </span>
                    ) : (
                      <span className="domain-badge domain-none">-</span>
                    )}
                  </td>
                  <td>{Math.round((item.confidence ?? 0) * 100)}%</td>
                  <td>
                    <span className={`status-badge status-${item.status}`}>
                      {item.status}
                    </span>
                  </td>
                  <td className="memory-date">
                    {new Date(item.created_at).toLocaleDateString()}
                  </td>
                  <td className="memory-actions">
                    {editingId !== item.id && (
                      <>
                        <button
                          className={`btn-action ${item.pinned ? "btn-pinned" : "btn-pin"}`}
                          onClick={() => handleTogglePin(item.id, !!item.pinned)}
                          title={item.pinned ? "Unpin from context" : "Pin to always include in context"}
                        >
                          {item.pinned ? "Unpin" : "Pin"}
                        </button>
                        <button
                          className="btn-action btn-edit"
                          onClick={() => handleEdit(item)}
                        >
                          Edit
                        </button>
                        <button
                          className="btn-action btn-tag"
                          onClick={() => toggleTagsPanel(item.id)}
                        >
                          Tags
                        </button>
                        <button
                          className="btn-action btn-confirm"
                          onClick={() => handleReconfirm(item.id)}
                          title="Mark as still valid"
                        >
                          Confirm
                        </button>
                        <button
                          className="btn-action btn-delete"
                          onClick={() => handleDelete(item.id)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
                {expandedTags.has(item.id) && (
                  <tr className="tags-row">
                    <td colSpan={10}>
                      <div className="tags-panel">
                        {(itemTags[item.id] || []).map((tag) => (
                          <span key={tag} className="tag-chip tag-removable">
                            {tag}
                            <button onClick={() => removeTagFromItem(item.id, tag)}>x</button>
                          </span>
                        ))}
                        <div className="tag-add">
                          <input
                            type="text"
                            placeholder="Add tag..."
                            value={tagInput[item.id] || ""}
                            onChange={(e) => setTagInput((prev) => ({ ...prev, [item.id]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") addTagToItem(item.id); }}
                          />
                          <button onClick={() => addTagToItem(item.id)}>+</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          {/* Pagination */}
          {totalPages > 1 && (
            <div className="pagination">
              <button
                className="btn btn-secondary btn-sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Prev
              </button>
              <span className="pagination-info">
                Page {page} of {totalPages} ({sortedItems.length} items)
              </span>
              <button
                className="btn btn-secondary btn-sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* Session memory panel */}
      {sessionStats && (
        <div className="session-panel">
          <h3>Session Memory</h3>
          <div className="session-stats-row">
            <div className="stat-card">
              <span className="stat-value" style={{ color: "#ec4899" }}>{sessionStats.active}</span>
              <span className="stat-label">Active</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{sessionStats.stale}</span>
              <span className="stat-label">Expired</span>
            </div>
            {sessionStats.oldest_active && (
              <div className="stat-card">
                <span className="stat-value" style={{ fontSize: "0.85rem" }}>
                  {new Date(sessionStats.oldest_active).toLocaleString()}
                </span>
                <span className="stat-label">Oldest active</span>
              </div>
            )}
          </div>
          <div className="session-actions">
            <button
              className="btn btn-secondary"
              onClick={handleCleanup}
              disabled={cleaningUp}
            >
              {cleaningUp ? "Cleaning up..." : "Expire old sessions (24h TTL)"}
            </button>
            {cleanupResult && (
              <span className="cleanup-result">{cleanupResult}</span>
            )}
          </div>
        </div>
      )}

      {/* Batch action bar */}
      <BatchBar
        selectedIds={selectedIds}
        onClear={() => setSelectedIds([])}
        onDone={() => { fetchMemories(); setSelectedIds([]); }}
      />

      {/* Detail modal */}
      {detailId !== null && (
        <MemoryDetailModal
          itemId={detailId}
          onClose={() => setDetailId(null)}
          onAction={() => fetchMemories()}
        />
      )}
    </div>
  );
}

export default Memory;
