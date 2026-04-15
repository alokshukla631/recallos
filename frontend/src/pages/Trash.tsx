import { useState, useEffect } from "react";
import { useToast } from "../components/Toast";
import "./Trash.css";

interface DeletedItem {
  id: string;
  key: string;
  value: string;
  type: string;
  scope: string;
  domain: string | null;
  confidence: number;
  status: string;
  created_at: string;
  deleted_at: string;
}

function Trash() {
  const { toast } = useToast();
  const [items, setItems] = useState<DeletedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"deleted_at" | "key" | "type">("deleted_at");

  useEffect(() => {
    fetchDeleted();
  }, []);

  async function fetchDeleted() {
    setLoading(true);
    try {
      const res = await fetch("/api/memory/recently-deleted?limit=50");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setItems(await res.json());
    } catch {
      toast("Failed to load deleted items", "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleRestore(id: string) {
    setRestoring((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/memory/${id}/restore`, { method: "POST" });
      if (!res.ok) throw new Error("Restore failed");
      toast("Item restored", "success");
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch {
      toast("Failed to restore item", "error");
    } finally {
      setRestoring((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function handleRestoreAll() {
    for (const item of items) {
      await handleRestore(item.id);
    }
  }

  function timeAgo(d: string) {
    // Backend timestamps are UTC but may lack a trailing Z. Force UTC
    // interpretation so the diff is never negative in local timezones.
    const normalized = d.includes("Z") || d.includes("+") ? d : d.replace(" ", "T") + "Z";
    const diff = Date.now() - new Date(normalized).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  const filteredItems = searchQuery.trim()
    ? items.filter(
        (i) =>
          i.key.toLowerCase().includes(searchQuery.toLowerCase()) ||
          i.value.toLowerCase().includes(searchQuery.toLowerCase()) ||
          i.type.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : items;

  const sortedItems = [...filteredItems].sort((a, b) => {
    if (sortBy === "key") return a.key.localeCompare(b.key);
    if (sortBy === "type") return a.type.localeCompare(b.type);
    return new Date(b.deleted_at).getTime() - new Date(a.deleted_at).getTime();
  });

  return (
    <div className="page trash-page">
      <div className="trash-header">
        <div>
          <h2>Trash</h2>
          <p className="trash-subtitle">
            Recently deleted memory items. Restore them before they are permanently lost.
          </p>
        </div>
        {items.length > 0 && (
          <div className="trash-header-actions">
            <button className="btn btn-restore-all" onClick={handleRestoreAll}>
              Restore All ({items.length})
            </button>
          </div>
        )}
      </div>

      {loading && <p className="muted">Loading...</p>}

      {!loading && items.length === 0 && (
        <div className="trash-empty">
          <div className="trash-empty-icon">&#128465;</div>
          <p>Trash is empty</p>
          <span className="muted">No recently deleted items found.</span>
        </div>
      )}

      {!loading && items.length > 0 && (
        <>
          <div className="trash-controls">
            <input
              type="text"
              className="trash-search"
              placeholder="Search deleted items..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <select
              className="trash-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            >
              <option value="deleted_at">Sort by deleted time</option>
              <option value="key">Sort by key</option>
              <option value="type">Sort by type</option>
            </select>
            <span className="trash-count">
              {filteredItems.length} of {items.length} items
            </span>
          </div>
          <div className="trash-list">
          {sortedItems.map((item) => (
            <div key={item.id} className="trash-card">
              <div className="trash-card-top">
                <span className="trash-card-key">{item.key}</span>
                <div className="trash-card-badges">
                  <span className="trash-card-type" data-type={item.type}>{item.type}</span>
                  <span className="trash-card-scope">{item.scope}</span>
                  {item.domain && <span className="trash-card-domain">{item.domain}</span>}
                </div>
              </div>
              <div className="trash-card-value">{item.value}</div>
              <div className="trash-card-bottom">
                <span className="trash-card-meta">
                  Status: {item.status} | Confidence: {Math.round(item.confidence * 100)}%
                </span>
                <span className="trash-card-time" title={new Date(item.deleted_at).toLocaleString()}>
                  Deleted {timeAgo(item.deleted_at)}
                </span>
                <button
                  className="btn-restore"
                  onClick={() => handleRestore(item.id)}
                  disabled={restoring.has(item.id)}
                >
                  {restoring.has(item.id) ? "Restoring..." : "Restore"}
                </button>
              </div>
            </div>
          ))}
          </div>
        </>
      )}
    </div>
  );
}

export default Trash;
