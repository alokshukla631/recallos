import { useState, useEffect, useCallback } from "react";
import "./Memory.css";

interface MemoryItem {
  id: number;
  key: string;
  type: string;
  value: string;
  scope: string;
  confidence: number;
  status: string;
  created_at: string;
}

const TYPE_COLORS: Record<string, string> = {
  preference: "#3b82f6",
  constraint: "#ef4444",
  fact: "#22c55e",
  goal: "#a855f7",
  override: "#f97316",
};

function Memory() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);

  // Filters
  const [statusFilter, setStatusFilter] = useState("active");
  const [typeFilter, setTypeFilter] = useState("all");
  const [scopeFilter, setScopeFilter] = useState("all");

  // Edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");

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

  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q) {
      fetchMemories();
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`/api/memory/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
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
      fetchMemories();
    } catch (err: any) {
      setError(err.message || "Failed to update memory");
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const res = await fetch(`/api/memory/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fetchMemories();
    } catch (err: any) {
      setError(err.message || "Failed to delete memory");
    }
  };

  // Stats
  const totalActive = items.filter((i) => i.status === "active").length;
  const byType: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  for (const item of items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
    byScope[item.scope] = (byScope[item.scope] || 0) + 1;
  }

  return (
    <div className="page memory-page">
      <h2>Memory</h2>
      <p>Browse and manage stored memory items.</p>

      {/* Stats summary */}
      <div className="memory-stats">
        <div className="stat-card">
          <span className="stat-value">{items.length}</span>
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
        {Object.entries(byScope).map(([scope, count]) => (
          <div className="stat-card" key={scope}>
            <span className="stat-value">{count}</span>
            <span className="stat-label">{scope}</span>
          </div>
        ))}
      </div>

      {/* Search bar */}
      <div className="memory-search">
        <input
          type="text"
          placeholder="Search memory (e.g. 'hotel preference', 'Tokyo')..."
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            if (!e.target.value.trim()) fetchMemories();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSearch();
          }}
        />
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
            <option value="trip">Trip</option>
          </select>
        </label>
      </div>

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
                <th>Key</th>
                <th>Type</th>
                <th>Value</th>
                <th>Scope</th>
                <th>Confidence</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="memory-key">{item.key}</td>
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
                    <span className="scope-badge">{item.scope}</span>
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
                          className="btn-action btn-edit"
                          onClick={() => handleEdit(item)}
                        >
                          Edit
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default Memory;
